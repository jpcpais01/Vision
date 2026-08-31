import type { Config, CycleRecord, Direction, LogLine, Position, Stats, StrategyId, Tick } from './types';
import { CYCLE_SEC, DEFAULT_CONFIG, FUTURES_REST, HISTORY_SEC, PATHS, SYMBOL } from './config';
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
 *   1. Every 20-second slot of the wall clock (:00, :20, :40…), take the
 *      price right now as the cycle's reference and simulate `PATHS` random
 *      walks forward, one second at a time, using the realised volatility of
 *      the last `HISTORY_SEC` one-second price points.
 *   2. For the rest of the cycle, each bot independently checks the live
 *      price against what the simulation says is plausible at that exact
 *      second. When it's less likely than that bot's own threshold, that's
 *      its signal.
 *   3. Force-close whatever's open at each bot's own configured second,
 *      before the next cycle begins. At most one position open at a time,
 *      per bot.
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
  volPct: number | null;
  cycleStart: number | null;
  cycleEnd: number | null;
  cycleStartPrice: number | null;
  elapsedSec: number | null;
  tailProb: number | null;
}

export interface BotSnapshot extends MarketSnapshot {
  strategyId: StrategyId;
  config: Config;
  band: Band[] | null;
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
const MAX_SECONDS = HISTORY_SEC * 3;
const MAX_LOGS = 200;
const STRATEGY_IDS = STRATEGIES.map((s) => s.id);

interface Bot {
  config: Config;
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
  private vol = { sigma: 0, volPct: 0 };

  private cycleStart: number | null = null;
  private cycleStartPrice: number | null = null;
  private dist: CycleDistribution | null = null;
  private tailProb: number | null = null;
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
    this.vol = { sigma: 0, volPct: 0 };
    this.cycleStart = null;
    this.cycleStartPrice = null;
    this.dist = null;
    this.tailProb = null;
    this.log(
      'info',
      `Started. Simulating ${PATHS.toLocaleString()} paths every ${CYCLE_SEC}s from the realised volatility of the last ${HISTORY_SEC} one-second prices.`
    );

    this.feed.start();
    await this.pollRestPrice(); // get a genuine price on the board immediately, don't wait on the WS to connect

    this.timers.push(setInterval(() => this.emit(), 1000)); // ticks the countdown; prices also arrive via ingestTick
    this.timers.push(setInterval(() => this.step(), 250));
    this.timers.push(setInterval(() => void this.pollRestPrice(), 3000));
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
      volPct: this.vol.volPct || null,
      cycleStart: this.cycleStart,
      cycleEnd: this.cycleStart !== null ? this.cycleStart + CYCLE_MS : null,
      cycleStartPrice: this.cycleStartPrice,
      elapsedSec: this.cycleStart !== null ? (now - this.cycleStart) / 1000 : null,
      band: this.dist ? bandFromDistribution(this.dist, bot.config.unlikeliness) : null,
      tailProb: this.tailProb,
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

  /** Fold one genuine Binance trade into the tape — ticks, the 1s-resampled series, and volatility. */
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

    this.vol = volatility(this.seconds.slice(-HISTORY_SEC));
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

    const elapsedSec = (now - this.cycleStart) / 1000;

    if (this.dist && this.cycleStartPrice !== null && this.price !== null) {
      this.tailProb = tailProbability(this.dist, elapsedSec, this.cycleStartPrice, this.price);
      for (const id of STRATEGY_IDS) this.considerTrade(id, elapsedSec);
    }

    for (const id of STRATEGY_IDS) {
      const bot = this.bots[id];
      if (bot.position && elapsedSec >= bot.config.closeAtSecond && bot.busy !== 'closing') {
        void this.closePosition(id, 'cycle close');
      }
    }
  }

  /** Finalise the cycle just ended (if any), for every bot, then simulate the new one from the price right now. */
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
          sigma: this.vol.sigma,
          volPct: this.vol.volPct,
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
    this.tailProb = null;
    for (const id of STRATEGY_IDS) this.bots[id].skipReason = null;

    if (this.cycleStartPrice === null) {
      this.dist = null;
      this.log('warn', 'New cycle — no price yet, sitting this one out');
      return;
    }

    this.dist = simulateCycle({
      startPrice: this.cycleStartPrice,
      sigma: this.vol.sigma,
      cycleSec: CYCLE_SEC,
      paths: PATHS,
      seed: this.seed++,
    });
    this.log(
      'info',
      `Cycle started at $${this.cycleStartPrice.toFixed(2)} — ${this.vol.volPct.toFixed(0)}% volatility`
    );
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
    if (elapsedSec >= bot.config.closeAtSecond) {
      bot.skipReason = 'too late in this cycle';
      return;
    }
    if (this.tailProb === null || this.cycleStartPrice === null || this.price === null) return;
    if (this.tailProb >= bot.config.unlikeliness) {
      bot.skipReason = `${(this.tailProb * 100).toFixed(1)}% still plausible`;
      return;
    }
    bot.skipReason = null;
    const direction = directionFor(strategyId, this.price > this.cycleStartPrice);
    void this.openPosition(strategyId, direction, this.tailProb);
  }

  private async openPosition(strategyId: StrategyId, direction: Direction, triggerProb: number): Promise<void> {
    const bot = this.bots[strategyId];
    if (bot.busy || this.cycleStart === null) return;
    bot.busy = 'opening';
    this.emit(true);
    try {
      const [book, filters] = await Promise.all([fetchBook(), symbolFilters()]);
      const f = fillUsd(book, direction === 'LONG' ? 'BUY' : 'SELL', bot.config.stakeUsd, filters?.stepSize);
      if (f.qty <= 0) {
        this.botLog(strategyId, 'warn', 'No liquidity for a simulated fill');
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
        `Opened ${direction} ${f.qty.toFixed(5)} BTC at $${f.price.toFixed(2)} — that move had only a ${(triggerProb * 100).toFixed(1)}% chance`
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
