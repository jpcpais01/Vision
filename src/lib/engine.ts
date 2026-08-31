import type { Config, CycleRecord, Direction, LogLine, Position, Stats, Tick } from './types';
import { CYCLE_SEC, DEFAULT_CONFIG, HISTORY_SEC, PATHS, SYMBOL } from './config';
import { volatility } from './series';
import { bandFromDistribution, simulateCycle, tailProbability, type Band, type CycleDistribution } from './montecarlo';
import { fetchBook, fillQty, fillUsd } from './binanceBook';
import { BinanceFeed } from './binanceFeed';

/**
 * ── The loop ─────────────────────────────────────────────────────────────────
 *
 * One instance runs the whole session. There is one price source — Binance's
 * live trade stream — and one model: a driftless Monte Carlo re-run every
 * `CYCLE_SEC` seconds, simulating the full path distribution forward from
 * whatever the price is at that instant.
 *
 *   1. Every 20-second slot of the wall clock (:00, :20, :40…), take the
 *      price right now as the cycle's reference and simulate `PATHS` random
 *      walks forward, one second at a time, using the realised volatility of
 *      the last `HISTORY_SEC` one-second price points.
 *   2. For the rest of the cycle, check the live price against what the
 *      simulation says is plausible at that exact second. When it's less
 *      likely than the configured threshold, that's the signal: the price
 *      has strayed further than the model expects, so bet on it reverting —
 *      buy if it dipped unusually low, sell if it spiked unusually high.
 *   3. Force-close whatever's open at the configured second, before the next
 *      cycle begins. At most one position open at a time.
 *
 * Every fill — open and close — is priced by walking Binance's real resting
 * depth, so paper trading reports the same slippage a live order would see.
 */

export type Busy = 'opening' | 'closing' | null;

export interface Snapshot {
  running: boolean;
  config: Config;
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
  band: Band[] | null;
  tailProb: number | null;
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

export class Engine {
  private config: Config = { ...DEFAULT_CONFIG };
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
  private band: Band[] | null = null;
  private tailProb: number | null = null;
  private skipReason: string | null = null;

  private position: Position | null = null;
  private busy: Busy = null;

  private positions: Position[] = [];
  private cycles: CycleRecord[] = [];
  private logs: LogLine[] = [];

  private readonly feed: BinanceFeed;
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: Snapshot | null = null;
  private queued = false;
  private seed = 1;
  private pending = { positions: new Map<string, Position>(), cycles: new Map<string, CycleRecord>() };

  constructor(private headers: () => Record<string, string>) {
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

  async start(config: Config): Promise<void> {
    if (this.running) {
      this.config = { ...config };
      return;
    }
    this.config = { ...config };
    this.running = true;
    this.ticks = [];
    this.seconds = [];
    this.vol = { sigma: 0, volPct: 0 };
    this.cycleStart = null;
    this.cycleStartPrice = null;
    this.dist = null;
    this.band = null;
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
    if (this.position && this.busy !== 'closing') void this.closePosition('stopped');
    void this.flush();
    this.log('info', 'Stopped');
    this.emit();
  }

  setConfig(config: Config): void {
    this.config = { ...config };
    this.emit();
  }

  hydrate(r: { positions?: Position[]; cycles?: CycleRecord[] }): void {
    if (r.positions?.length) {
      const m = new Map(this.positions.map((p) => [p.id, p]));
      for (const p of r.positions) if (!m.has(p.id)) m.set(p.id, p);
      this.positions = [...m.values()].sort((a, b) => a.openedAt - b.openedAt);
    }
    if (r.cycles?.length) {
      const m = new Map(this.cycles.map((c) => [c.id, c]));
      for (const c of r.cycles) if (!m.has(c.id)) m.set(c.id, c);
      this.cycles = [...m.values()].sort((a, b) => a.startMs - b.startMs);
    }
    this.emit();
  }

  // ── React binding ─────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => {
    if (!this.snapshot) this.snapshot = this.build();
    return this.snapshot;
  };

  private emit(now = false): void {
    this.snapshot = null;
    if (now) {
      for (const l of this.listeners) l();
      return;
    }
    if (this.queued) return;
    this.queued = true;
    setTimeout(() => {
      this.queued = false;
      this.snapshot = null;
      for (const l of this.listeners) l();
    }, 150);
  }

  private build(): Snapshot {
    const now = Date.now();
    return {
      running: this.running,
      config: this.config,
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
      band: this.band,
      tailProb: this.tailProb,
      skipReason: this.skipReason,
      busy: this.busy,
      position: this.position,
      positions: this.positions,
      cycles: this.cycles,
      logs: this.logs,
      stats: this.stats(),
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
      const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`, { cache: 'no-store' });
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
      this.considerTrade(elapsedSec);
    }

    if (this.position && elapsedSec >= this.config.closeAtSecond && this.busy !== 'closing') {
      void this.closePosition('cycle close');
    }
  }

  /** Finalise the cycle just ended (if any), then simulate the new one from the price right now. */
  private rollCycle(boundary: number): void {
    if (this.cycleStart !== null && this.cycleStartPrice !== null) {
      const cycleId = String(this.cycleStart);
      const done = this.positions.filter((p) => p.cycleId === cycleId);
      const record: CycleRecord = {
        id: cycleId,
        startMs: this.cycleStart,
        endMs: this.cycleStart + CYCLE_MS,
        startPrice: this.cycleStartPrice,
        sigma: this.vol.sigma,
        volPct: this.vol.volPct,
        traded: done.length > 0,
        pnl: done.length > 0 ? done.reduce((s, p) => s + (p.pnl ?? 0), 0) : null,
      };
      if (!this.cycles.some((c) => c.id === record.id)) {
        this.cycles = [...this.cycles, record].slice(-500);
        this.pending.cycles.set(record.id, record);
      }
    }

    this.cycleStart = boundary;
    this.cycleStartPrice = this.price;
    this.tailProb = null;
    this.skipReason = null;

    if (this.cycleStartPrice === null) {
      this.dist = null;
      this.band = null;
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
    this.band = bandFromDistribution(this.dist, this.config.unlikeliness);
    this.log(
      'info',
      `Cycle started at $${this.cycleStartPrice.toFixed(2)} — ${this.vol.volPct.toFixed(0)}% volatility`
    );
  }

  /**
   * The whole trading rule. When the live price is further from the cycle's
   * start than the model gives more than `unlikeliness` chance of, bet on
   * reversion: buy if it dipped low, sell if it spiked high.
   */
  private considerTrade(elapsedSec: number): void {
    if (this.position || this.busy) return;
    if (this.config.killSwitch) {
      this.skipReason = 'kill switch on';
      return;
    }
    if (!this.config.autoTrade) {
      this.skipReason = 'auto-trade off';
      return;
    }
    if (elapsedSec >= this.config.closeAtSecond) {
      this.skipReason = 'too late in this cycle';
      return;
    }
    if (this.tailProb === null || this.cycleStartPrice === null || this.price === null) return;
    if (this.tailProb >= this.config.unlikeliness) {
      this.skipReason = `${(this.tailProb * 100).toFixed(1)}% still plausible`;
      return;
    }
    this.skipReason = null;
    const direction: Direction = this.price > this.cycleStartPrice ? 'SHORT' : 'LONG';
    void this.openPosition(direction, this.tailProb);
  }

  private async openPosition(direction: Direction, triggerProb: number): Promise<void> {
    if (this.busy || this.cycleStart === null) return;
    this.busy = 'opening';
    this.emit(true);
    try {
      const book = await fetchBook();
      const f = fillUsd(book, direction === 'LONG' ? 'BUY' : 'SELL', this.config.stakeUsd);
      if (f.qty <= 0) {
        this.log('warn', 'No liquidity for a simulated fill');
        return;
      }
      const position: Position = {
        id: `pos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        cycleId: String(this.cycleStart),
        direction,
        qty: f.qty,
        openedAt: Date.now(),
        openPrice: f.price,
        triggerProb,
        closesAt: this.cycleStart + this.config.closeAtSecond * 1000,
        status: 'OPEN',
        closedAt: null,
        closePrice: null,
        pnl: null,
      };
      this.position = position;
      this.positions = [...this.positions, position];
      this.pending.positions.set(position.id, position);
      this.log(
        'trade',
        `Opened ${direction} ${f.qty.toFixed(5)} BTC at $${f.price.toFixed(2)} — that move had only a ${(triggerProb * 100).toFixed(1)}% chance`
      );
    } catch (err) {
      this.log('error', `Open failed: ${msg(err)}`);
    } finally {
      this.busy = null;
      this.emit(true);
    }
  }

  private async closePosition(reason: string): Promise<void> {
    const open = this.position;
    if (!open || this.busy) return;
    this.busy = 'closing';
    this.emit(true);
    try {
      const book = await fetchBook();
      const f = fillQty(book, open.direction === 'LONG' ? 'SELL' : 'BUY', open.qty);
      const closePrice = f.qty > 0 ? f.price : (this.price ?? open.openPrice);
      const closedQty = f.qty > 0 ? f.qty : open.qty;
      const pnl =
        open.direction === 'LONG'
          ? (closePrice - open.openPrice) * closedQty
          : (open.openPrice - closePrice) * closedQty;
      const closed: Position = { ...open, status: 'CLOSED', closedAt: Date.now(), closePrice, pnl };
      this.positions = this.positions.map((p) => (p.id === closed.id ? closed : p));
      this.pending.positions.set(closed.id, closed);
      this.position = null;
      this.log(
        'trade',
        `${pnl >= 0 ? 'WON' : 'LOST'} — closed ${open.direction} at $${closePrice.toFixed(2)} (${reason}). ` +
          `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`
      );
    } catch (err) {
      this.log('error', `Close failed: ${msg(err)}`);
    } finally {
      this.busy = null;
      this.emit(true);
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  private todayPnl(): number {
    const dayStart = new Date().setHours(0, 0, 0, 0);
    return this.positions
      .filter((p) => p.openedAt >= dayStart && p.pnl !== null)
      .reduce((s, p) => s + (p.pnl ?? 0), 0);
  }

  private stats(): Stats {
    const done = this.positions.filter((p) => p.status === 'CLOSED');
    const wins = done.filter((p) => (p.pnl ?? 0) > 0).length;
    return {
      positions: this.positions.length,
      wins,
      losses: done.length - wins,
      open: this.position ? 1 : 0,
      winRate: done.length > 0 ? wins / done.length : 0,
      pnl: done.reduce((s, p) => s + (p.pnl ?? 0), 0),
      today: this.todayPnl(),
      cycles: this.cycles.length,
    };
  }

  // ── Persistence / logging ─────────────────────────────────────────────────

  private async flush(): Promise<void> {
    if (this.pending.positions.size === 0 && this.pending.cycles.size === 0) return;
    const body = {
      positions: [...this.pending.positions.values()],
      cycles: [...this.pending.cycles.values()],
    };
    this.pending.positions.clear();
    this.pending.cycles.clear();
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify(body),
      });
    } catch {
      /* the record is an audit trail, not a dependency */
    }
  }

  log(level: LogLine['level'], message: string): void {
    this.logs = [
      ...this.logs,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, t: Date.now(), level, message },
    ].slice(-MAX_LOGS);
    this.emit();
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
