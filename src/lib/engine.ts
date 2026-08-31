import type { Config, CycleRecord, Direction, LogLine, Position, Stats, StrategyId, Tick } from './types';
import { CYCLE_SEC, DEFAULT_CONFIG, ENTRY_MARGIN_SEC, FUTURES_REST, MAX_VOL_WINDOW_SEC, PATHS, SYMBOL } from './config';
import { STRATEGIES, directionFor } from './strategies';
import { volatility } from './series';
import { bandFromDistribution, simulateCycle, tailProbability, type Band, type CycleDistribution } from './montecarlo';
import { fetchBook, fillQty, fillUsd, symbolFilters } from './binanceBook';
import { BinanceFeed } from './binanceFeed';

/**
 * ── The loop ─────────────────────────────────────────────────────────────────
 *
 * One instance runs the whole session, for every strategy at once. There is
 * one shared price source — Binance's live trade stream — and one shared
 * model: a driftless Monte Carlo re-run every `CYCLE_SEC` seconds, simulating
 * the full path distribution forward from whatever the price is at that
 * instant. That much is identical for every strategy; duplicating it per bot
 * would just be the same simulation run twice for no reason.
 *
 * What each strategy actually owns is its own config, its own position and
 * P&L, and one decision: which way to bet once the live price gets more
 * unlikely (versus the shared simulation) than its own threshold. That
 * decision — `directionFor()` in strategies.ts — is the entire difference
 * between them.
 *
 *   1. Every `CYCLE_SEC`-second slot of the wall clock (:00, :01:00, :02:00…),
 *      take the price right now as the cycle's reference. Each bot then
 *      simulates its own `PATHS` random walks forward, one second at a time,
 *      using the realised volatility of its own configured lookback window
 *      (`Config.volatilityWindowSec`) — the reference price is shared, but a
 *      shorter or longer window gives each bot its own distribution and so
 *      its own tail probability from the same tape.
 *   2. From `ENTRY_MARGIN_SEC` seconds in — never before, so there's a real
 *      tape to react to — each bot independently checks the live price
 *      against what the simulation says is plausible at that exact second.
 *      When it's less likely than that bot's own threshold, that's its
 *      signal.
 *   3. Force-close whatever's open at each bot's own configured second,
 *      never later than `ENTRY_MARGIN_SEC` seconds before the cycle ends —
 *      no bot is ever mid-decision right as the next cycle is about to
 *      begin. At most one position open at a time, per bot.
 *
 * Every fill — open and close — is priced by walking Binance's real resting
 * depth, so paper trading reports the same slippage a live order would see.
 */

export type Busy = 'opening' | 'closing' | null;

/** What every strategy shares: the market itself, not any one bot's decisions. */
export interface MarketSnapshot {
  running: boolean;
  connected: boolean;
  feedError: string | null;
  price: number | null;
  priceAt: number;
  ticks: Tick[];
  cycleStart: number | null;
  cycleEnd: number | null;
  cycleStartPrice: number | null;
  elapsedSec: number | null;
}

export interface BotSnapshot extends MarketSnapshot {
  strategyId: StrategyId;
  config: Config;
  /** This bot's own volatility read, from its own configured window — differs
   *  between bots whenever their windows do, even against the same tape. */
  volPct: number | null;
  /** This bot's own tail probability, from its own distribution. */
  tailProb: number | null;
  band: Band[] | null;
  /** The fixed 10%-tail band, regardless of this bot's own configured
   *  threshold — the fixed yardstick the win-animation overlays measure a
   *  favorable move against, so it doesn't shift if `unlikeliness` does. */
  band10: Band[] | null;
  skipReason: string | null;
  busy: Busy;
  position: Position | null;
  positions: Position[];
  cycles: CycleRecord[];
  logs: LogLine[];
  stats: Stats;
}

const CYCLE_MS = CYCLE_SEC * 1000;
const MAX_TICKS = 2400;
const MAX_SECONDS = MAX_VOL_WINDOW_SEC;
const MAX_LOGS = 200;
const STRATEGY_IDS = STRATEGIES.map((s) => s.id);

interface Bot {
  config: Config;
  vol: { sigma: number; volPct: number };
  dist: CycleDistribution | null;
  tailProb: number | null;
  skipReason: string | null;
  busy: Busy;
  position: Position | null;
  positions: Position[];
  cycles: CycleRecord[];
  logs: LogLine[];
  pendingPositions: Map<string, Position>;
  pendingCycles: Map<string, CycleRecord>;
}

function freshBot(): Bot {
  return {
    config: { ...DEFAULT_CONFIG },
    vol: { sigma: 0, volPct: 0 },
    dist: null,
    tailProb: null,
    skipReason: null,
    busy: null,
    position: null,
    positions: [],
    cycles: [],
    logs: [],
    pendingPositions: new Map(),
    pendingCycles: new Map(),
  };
}

export class Engine {
  private running = false;

  private ticks: Tick[] = [];
  private seconds: Tick[] = [];
  private price: number | null = null;
  private priceAt = 0;
  private connected = false;
  private restPolling = false;
  private feedError: string | null = null;

  private cycleStart: number | null = null;
  private cycleStartPrice: number | null = null;
  /** Which cycle's first-tick delay has already been logged, so it's reported exactly once per cycle. */
  private firstTickLoggedForCycle: number | null = null;
  /** Market-level events — feed status, cycle rolls — shared into every bot's Activity log. */
  private marketLogs: LogLine[] = [];

  private bots: Record<StrategyId, Bot>;

  private readonly feed: BinanceFeed;
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private snapshots = new Map<StrategyId, BotSnapshot>();
  private queued = false;
  private seed = 1;

  constructor(private headers: () => Record<string, string>) {
    this.bots = Object.fromEntries(STRATEGY_IDS.map((id) => [id, freshBot()])) as Record<StrategyId, Bot>;
    this.feed = new BinanceFeed({
      onTick: (tick) => {
        this.ingestTick(tick);
        this.emit();
      },
      onStatus: (connected) => {
        this.connected = connected;
        if (connected) this.log('info', 'Connected to Binance');
        this.emit();
      },
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.ticks = [];
    this.seconds = [];
    this.cycleStart = null;
    this.cycleStartPrice = null;
    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      bot.vol = { sigma: 0, volPct: 0 };
      bot.dist = null;
      bot.tailProb = null;
    }
    this.log(
      'info',
      `Started. Simulating ${PATHS.toLocaleString()} paths every ${CYCLE_SEC}s per bot, from each bot's own configured volatility window.`
    );

    this.feed.start();
    await this.pollRestPrice(); // get a genuine price on the board immediately, don't wait on the WS to connect

    this.timers.push(setInterval(() => this.emit(), 1000)); // ticks the countdown; prices also arrive via ingestTick
    this.timers.push(setInterval(() => this.step(), 250));
    this.timers.push(setInterval(() => void this.pollRestPrice(), 1000));
    this.timers.push(setInterval(() => void this.flush(), 5000));
    this.emit();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.feed.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      if (bot.position && bot.busy !== 'closing') void this.closePosition(id, 'stopped');
    }
    void this.flush();
    this.log('info', 'Stopped');
    this.emit();
  }

  setConfig(strategyId: StrategyId, config: Config): void {
    const bot = this.bots[strategyId];
    const justKilled = config.killSwitch && !bot.config.killSwitch;
    bot.config = { ...config };
    // Engaging this one bot's kill switch closes only its own position —
    // every other bot, and the shared feed, keeps running regardless.
    if (justKilled && bot.position && bot.busy !== 'closing') void this.closePosition(strategyId, 'kill switch');
    this.emit();
  }

  hydrate(strategyId: StrategyId, r: { positions?: Position[]; cycles?: CycleRecord[] }): void {
    const bot = this.bots[strategyId];
    if (r.positions?.length) {
      const m = new Map(bot.positions.map((p) => [p.id, p]));
      for (const p of r.positions) if (!m.has(p.id)) m.set(p.id, p);
      bot.positions = [...m.values()].sort((a, b) => a.openedAt - b.openedAt);
    }
    if (r.cycles?.length) {
      const m = new Map(bot.cycles.map((c) => [c.id, c]));
      for (const c of r.cycles) if (!m.has(c.id)) m.set(c.id, c);
      bot.cycles = [...m.values()].sort((a, b) => a.startMs - b.startMs);
    }
    this.emit();
  }

  // ── React binding ─────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (strategyId: StrategyId): BotSnapshot => {
    let snap = this.snapshots.get(strategyId);
    if (!snap) {
      snap = this.build(strategyId);
      this.snapshots.set(strategyId, snap);
    }
    return snap;
  };

  private emit(now = false): void {
    this.snapshots.clear();
    if (now) {
      for (const l of this.listeners) l();
      return;
    }
    if (this.queued) return;
    this.queued = true;
    setTimeout(() => {
      this.queued = false;
      this.snapshots.clear();
      for (const l of this.listeners) l();
    }, 150);
  }

  private build(strategyId: StrategyId): BotSnapshot {
    const now = Date.now();
    const bot = this.bots[strategyId];
    return {
      strategyId,
      running: this.running,
      config: bot.config,
      connected: this.connected || (this.price !== null && now - this.priceAt < 10_000),
      feedError: this.feedError,
      price: this.price,
      priceAt: this.priceAt,
      ticks: this.ticks.slice(-600),
      volPct: bot.vol.volPct || null,
      cycleStart: this.cycleStart,
      cycleEnd: this.cycleStart !== null ? this.cycleStart + CYCLE_MS : null,
      cycleStartPrice: this.cycleStartPrice,
      elapsedSec: this.cycleStart !== null ? (now - this.cycleStart) / 1000 : null,
      band: bot.dist ? bandFromDistribution(bot.dist, bot.config.unlikeliness) : null,
      band10: bot.dist ? bandFromDistribution(bot.dist, 0.1) : null,
      tailProb: bot.tailProb,
      skipReason: bot.skipReason,
      busy: bot.busy,
      position: bot.position,
      positions: bot.positions,
      cycles: bot.cycles,
      logs: mergeLogs(this.marketLogs, bot.logs),
      stats: this.stats(strategyId),
    };
  }

  // ── Price ─────────────────────────────────────────────────────────────────

  /** Fold one genuine Binance trade into the tape — ticks and the 1s-resampled series.
   *  Volatility is only ever read off this tape at the start of a cycle (see
   *  rollCycle), each bot against its own configured window — there's no
   *  reason to recompute it on every tick when nothing reads it in between. */
  private ingestTick(tick: Tick): void {
    if (!(tick.p > 0)) return;
    this.price = tick.p;
    this.priceAt = tick.t;
    this.feedError = null;
    this.ticks.push(tick);
    if (this.ticks.length > MAX_TICKS) this.ticks = this.ticks.slice(-MAX_TICKS);

    const sec = Math.floor(tick.t / 1000) * 1000;
    const last = this.seconds[this.seconds.length - 1];
    if (last && last.t === sec) last.p = tick.p;
    else if (!last || sec > last.t) this.seconds.push({ t: sec, p: tick.p });
    if (this.seconds.length > MAX_SECONDS) this.seconds = this.seconds.slice(-MAX_SECONDS);

    // Diagnostic: exactly how long after a cycle boundary the first tick that
    // actually qualifies for it (tick.t >= cycleStart) shows up — logged once
    // per cycle, so a real gap here (versus render/compute cost) is visible
    // directly instead of guessed at.
    if (this.cycleStart !== null && tick.t >= this.cycleStart && this.firstTickLoggedForCycle !== this.cycleStart) {
      this.firstTickLoggedForCycle = this.cycleStart;
      const delay = tick.t - this.cycleStart;
      if (delay > 200) this.log('warn', `First in-cycle tick arrived ${delay}ms after the cycle boundary`);
    }

    // React to every real tick immediately, not on the next 250ms poll — the
    // only delay between a signal appearing and a fill starting should be
    // fetchBook()'s own real round-trip, nothing self-imposed on top of it.
    if (this.running) this.evaluate(tick.t);
  }

  /**
   * REST fallback, skipped entirely while the WebSocket has a tick from the
   * last 5s. Fetched directly from the browser — Binance's REST API 451s
   * requests from US-based server IPs, so this cannot go through our own
   * /api routes the way most fetches in this app do.
   */
  private async pollRestPrice(): Promise<void> {
    if (!this.running || this.restPolling) return;
    if (this.feed.latest()) return;
    this.restPolling = true;
    try {
      const res = await fetch(`${FUTURES_REST}/fapi/v1/ticker/price?symbol=${SYMBOL}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`price ${res.status}`);
      const d = (await res.json()) as { price?: string };
      const price = Number(d.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error('no price');
      this.ingestTick({ t: Date.now(), p: price });
      this.emit();
    } catch (err) {
      if (this.price === null) this.feedError = msg(err);
      this.emit();
    } finally {
      this.restPolling = false;
    }
  }

  // ── The cycle ─────────────────────────────────────────────────────────────

  private step(): void {
    if (!this.running) return;
    const now = Date.now();
    const boundary = Math.floor(now / CYCLE_MS) * CYCLE_MS;

    if (this.cycleStart === null || boundary > this.cycleStart) this.rollCycle(boundary);
    if (this.cycleStart === null) return;

    // A time-based fallback for whatever a price tick alone can't cover —
    // forcing a close at each bot's own configured second, and re-evaluating
    // during a quiet stretch with no fresh ticks. The tick-driven path in
    // ingestTick is what actually keeps this current the rest of the time.
    this.evaluate(now);

    const elapsedSec = (now - this.cycleStart) / 1000;
    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      if (bot.position && elapsedSec >= bot.config.closeAtSecond && bot.busy !== 'closing') {
        void this.closePosition(id, 'cycle close');
      }
    }
  }

  /** Refresh every bot's tail probability against the price right now, and
   *  let each one act on it — called on every real tick (no polling lag) and
   *  by step() as a time-based fallback. */
  private evaluate(now: number): void {
    if (this.cycleStart === null || this.cycleStartPrice === null || this.price === null) return;
    const elapsedSec = (now - this.cycleStart) / 1000;
    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      if (bot.dist) bot.tailProb = tailProbability(bot.dist, elapsedSec, this.cycleStartPrice, this.price);
      this.considerTrade(id, elapsedSec);
    }
  }

  /** Finalise the cycle just ended (if any), for every bot, then simulate each
   *  bot's own new one from the price right now — same reference price, own
   *  volatility window, own distribution. */
  private rollCycle(boundary: number): void {
    if (this.cycleStart !== null && this.cycleStartPrice !== null) {
      const cycleId = String(this.cycleStart);
      for (const id of STRATEGY_IDS) {
        const bot = this.bots[id];
        const done = bot.positions.filter((p) => p.cycleId === cycleId);
        const record: CycleRecord = {
          id: cycleId,
          strategyId: id,
          startMs: this.cycleStart,
          endMs: this.cycleStart + CYCLE_MS,
          startPrice: this.cycleStartPrice,
          sigma: bot.vol.sigma,
          volPct: bot.vol.volPct,
          traded: done.length > 0,
          pnl: done.length > 0 ? done.reduce((s, p) => s + (p.pnl ?? 0), 0) : null,
        };
        if (!bot.cycles.some((c) => c.id === record.id)) {
          bot.cycles = [...bot.cycles, record].slice(-500);
          bot.pendingCycles.set(record.id, record);
        }
      }
    }

    this.cycleStart = boundary;
    this.cycleStartPrice = this.price;
    this.firstTickLoggedForCycle = null;
    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      bot.tailProb = null;
      bot.skipReason = null;
    }

    if (this.cycleStartPrice === null) {
      for (const id of STRATEGY_IDS) this.bots[id].dist = null;
      this.log('warn', 'New cycle — no price yet, sitting this one out');
      return;
    }

    // Diagnostic: how late this actually ran versus the ideal boundary — the
    // step() timer only polls every 250ms, so a few ms of slack here is
    // normal; anything much larger points at the main thread being busy.
    const rollLagMs = Date.now() - boundary;
    const startPrice = this.cycleStartPrice;

    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      bot.vol = volatility(this.seconds.slice(-bot.config.volatilityWindowSec));
      bot.dist = simulateCycle({
        startPrice,
        sigma: bot.vol.sigma,
        cycleSec: CYCLE_SEC,
        paths: PATHS,
        seed: this.seed++,
      });
    }

    this.log('info', `Cycle started at $${startPrice.toFixed(2)} (rolled ${rollLagMs}ms after boundary)`);
    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      this.botLog(
        id,
        'info',
        `${bot.vol.volPct.toFixed(0)}% volatility over the last ${bot.config.volatilityWindowSec}s, simulated in ${bot.dist!.computeMs}ms`
      );
    }
  }

  /**
   * Each bot's whole trading rule. When the live price is further from the
   * cycle's start than this bot's own threshold gives much chance of, take
   * this bot's own side of that — see strategies.ts's `directionFor`.
   */
  private considerTrade(strategyId: StrategyId, elapsedSec: number): void {
    const bot = this.bots[strategyId];
    if (bot.position || bot.busy) return;
    if (bot.config.killSwitch) {
      bot.skipReason = 'kill switch on';
      return;
    }
    if (!bot.config.autoTrade) {
      bot.skipReason = 'auto-trade off';
      return;
    }
    if (elapsedSec < ENTRY_MARGIN_SEC) {
      bot.skipReason = 'too early in this cycle';
      return;
    }
    if (elapsedSec >= bot.config.closeAtSecond) {
      bot.skipReason = 'too late in this cycle';
      return;
    }
    if (bot.tailProb === null || this.cycleStartPrice === null || this.price === null) return;
    if (bot.tailProb >= bot.config.unlikeliness) {
      bot.skipReason = `${(bot.tailProb * 100).toFixed(1)}% still plausible`;
      return;
    }
    bot.skipReason = null;
    const direction = directionFor(strategyId, this.price > this.cycleStartPrice);
    void this.openPosition(strategyId, direction, bot.tailProb, this.price);
  }

  private async openPosition(
    strategyId: StrategyId,
    direction: Direction,
    triggerProb: number,
    intendedPrice: number
  ): Promise<void> {
    const bot = this.bots[strategyId];
    if (bot.busy || this.cycleStart === null) return;
    bot.busy = 'opening';
    this.emit(true);
    try {
      const [book, filters] = await Promise.all([fetchBook(), symbolFilters()]);
      // Leverage multiplies notional exposure, not the margin risked — margin
      // itself is never modelled as a constraint (no liquidation), so this
      // only ever scales how big a move in either direction is worth.
      const notionalUsd = bot.config.stakeUsd * bot.config.leverage;
      const f = fillUsd(book, direction === 'LONG' ? 'BUY' : 'SELL', notionalUsd, filters?.stepSize);
      if (f.qty <= 0) {
        this.botLog(strategyId, 'warn', 'No liquidity for a simulated fill');
        return;
      }
      // Slippage protection, the same way a real limit-protected market
      // order works: only an ADVERSE move counts against the limit — paying
      // less (or selling for more) than the price that triggered the trade
      // is never a reason to reject it, only paying more (or selling for
      // less) is. Between the decision and this fill actually landing, the
      // price the trade reacted to can have moved on.
      const adverse = direction === 'LONG' ? f.price - intendedPrice : intendedPrice - f.price;
      if (adverse > bot.config.maxSlippageUsd) {
        this.botLog(
          strategyId,
          'warn',
          `Rejected — price moved $${adverse.toFixed(2)} against the trade while filling ` +
            `(limit $${bot.config.maxSlippageUsd}), would have opened at $${f.price.toFixed(2)} vs $${intendedPrice.toFixed(2)}`
        );
        return;
      }
      const position: Position = {
        id: `pos-${strategyId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        strategyId,
        cycleId: String(this.cycleStart),
        direction,
        qty: f.qty,
        openedAt: Date.now(),
        openPrice: f.price,
        leverage: bot.config.leverage,
        triggerProb,
        closesAt: this.cycleStart + bot.config.closeAtSecond * 1000,
        status: 'OPEN',
        closedAt: null,
        closePrice: null,
        pnl: null,
      };
      bot.position = position;
      bot.positions = [...bot.positions, position];
      bot.pendingPositions.set(position.id, position);
      this.botLog(
        strategyId,
        'trade',
        `Opened ${direction} ${f.qty.toFixed(5)} BTC at $${f.price.toFixed(2)}` +
          `${bot.config.leverage > 1 ? ` (${bot.config.leverage}x)` : ''} — that move had only a ${(triggerProb * 100).toFixed(1)}% chance`
      );
    } catch (err) {
      this.botLog(strategyId, 'error', `Open failed: ${msg(err)}`);
    } finally {
      bot.busy = null;
      this.emit(true);
    }
  }

  private async closePosition(strategyId: StrategyId, reason: string): Promise<void> {
    const bot = this.bots[strategyId];
    const open = bot.position;
    if (!open || bot.busy) return;
    bot.busy = 'closing';
    this.emit(true);
    try {
      const [book, filters] = await Promise.all([fetchBook(), symbolFilters()]);
      const f = fillQty(book, open.direction === 'LONG' ? 'SELL' : 'BUY', open.qty, filters?.stepSize);
      const closePrice = f.qty > 0 ? f.price : (this.price ?? open.openPrice);
      const closedQty = f.qty > 0 ? f.qty : open.qty;
      const pnl =
        open.direction === 'LONG'
          ? (closePrice - open.openPrice) * closedQty
          : (open.openPrice - closePrice) * closedQty;
      const closed: Position = { ...open, status: 'CLOSED', closedAt: Date.now(), closePrice, pnl };
      bot.positions = bot.positions.map((p) => (p.id === closed.id ? closed : p));
      bot.pendingPositions.set(closed.id, closed);
      bot.position = null;
      this.botLog(
        strategyId,
        'trade',
        `${pnl >= 0 ? 'WON' : 'LOST'} — closed ${open.direction} at $${closePrice.toFixed(2)} (${reason}). ` +
          `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`
      );
    } catch (err) {
      this.botLog(strategyId, 'error', `Close failed: ${msg(err)}`);
    } finally {
      bot.busy = null;
      this.emit(true);
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  private todayPnl(strategyId: StrategyId): number {
    const dayStart = new Date().setHours(0, 0, 0, 0);
    return this.bots[strategyId].positions
      .filter((p) => p.openedAt >= dayStart && p.pnl !== null)
      .reduce((s, p) => s + (p.pnl ?? 0), 0);
  }

  private stats(strategyId: StrategyId): Stats {
    const bot = this.bots[strategyId];
    const done = bot.positions.filter((p) => p.status === 'CLOSED');
    const wins = done.filter((p) => (p.pnl ?? 0) > 0).length;
    return {
      positions: bot.positions.length,
      wins,
      losses: done.length - wins,
      open: bot.position ? 1 : 0,
      winRate: done.length > 0 ? wins / done.length : 0,
      pnl: done.reduce((s, p) => s + (p.pnl ?? 0), 0),
      today: this.todayPnl(strategyId),
      cycles: bot.cycles.length,
    };
  }

  // ── Persistence / logging ─────────────────────────────────────────────────

  private async flush(): Promise<void> {
    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      if (bot.pendingPositions.size === 0 && bot.pendingCycles.size === 0) continue;
      const body = {
        positions: [...bot.pendingPositions.values()],
        cycles: [...bot.pendingCycles.values()],
      };
      bot.pendingPositions.clear();
      bot.pendingCycles.clear();
      try {
        await fetch(`/api/state/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.headers() },
          body: JSON.stringify(body),
        });
      } catch {
        /* the record is an audit trail, not a dependency */
      }
    }
  }

  /** Market-level: feed status, cycle rolls. Shared into every bot's Activity log. */
  log(level: LogLine['level'], message: string): void {
    this.marketLogs = [...this.marketLogs, newLine(level, message)].slice(-MAX_LOGS);
    this.emit();
  }

  /** This bot's own decisions: opens, closes, and anything that stopped one from happening. */
  private botLog(strategyId: StrategyId, level: LogLine['level'], message: string): void {
    const bot = this.bots[strategyId];
    bot.logs = [...bot.logs, newLine(level, message)].slice(-MAX_LOGS);
    this.emit();
  }
}

/** A placeholder snapshot for before the engine exists (server render) or before this bot has hydrated. */
// One cached instance per strategy — useSyncExternalStore requires
// getServerSnapshot to return a referentially stable value, and a fresh
// object literal on every call breaks that (React warns of a possible
// infinite loop otherwise).
const EMPTY_SNAPSHOTS = new Map<StrategyId, BotSnapshot>();

export function emptySnapshot(strategyId: StrategyId): BotSnapshot {
  let snap = EMPTY_SNAPSHOTS.get(strategyId);
  if (!snap) {
    snap = {
      strategyId,
      running: false,
      config: { ...DEFAULT_CONFIG },
      connected: false,
      feedError: null,
      price: null,
      priceAt: 0,
      ticks: [],
      volPct: null,
      cycleStart: null,
      cycleEnd: null,
      cycleStartPrice: null,
      elapsedSec: null,
      band: null,
      band10: null,
      tailProb: null,
      skipReason: null,
      busy: null,
      position: null,
      positions: [],
      cycles: [],
      logs: [],
      stats: { positions: 0, wins: 0, losses: 0, open: 0, winRate: 0, pnl: 0, today: 0, cycles: 0 },
    };
    EMPTY_SNAPSHOTS.set(strategyId, snap);
  }
  return snap;
}

function newLine(level: LogLine['level'], message: string): LogLine {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, t: Date.now(), level, message };
}

function mergeLogs(market: LogLine[], bot: LogLine[]): LogLine[] {
  return [...market, ...bot].sort((a, b) => a.t - b.t).slice(-MAX_LOGS);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
