import type {
  Bar,
  BarrierSource,
  Book,
  Config,
  LogLine,
  Market,
  Quote,
  Side,
  Simulation,
  Stats,
  Tick,
  Trade,
  WindowRecord,
} from './types';
import { CALIBRATION_MIN_SEC, DEFAULT_CONFIG, HISTORY_MIN, WINDOW_SEC } from './config';
import { bucket, shiftBars, shiftTicks, trim, volatility } from './bars';
import { quote } from './book';
import { simulate } from './montecarlo';
import { ChainlinkFeed } from './chainlinkFeed';

/**
 * ── The loop ─────────────────────────────────────────────────────────────────
 *
 * One instance runs the whole session. There is one model: a driftless Monte
 * Carlo over realised volatility (see montecarlo.ts). No forecast, no prior,
 * no external opinion feeds it.
 *
 *   1. On start, gather live ticks for at least `CALIBRATION_MIN_SEC` before
 *      doing anything else. There is no seeded history — the tape is built
 *      entirely from what has actually been observed since this instant — so
 *      the volatility estimate needs real time behind it before it means
 *      anything.
 *   2. Once calibrated, wait for a window that has not started yet, and join
 *      it at its open. Never mid-window — the barrier is the price at the
 *      open, and joining late means guessing it.
 *   3. At the open, capture the barrier from the most direct source available
 *      — see `captureBarrier`. It is never derived or guessed.
 *   4. Re-simulate roughly once a second for as long as the window is open,
 *      from the price right now.
 *   5. Buy whichever side — UP or DOWN — the simulation says is worth more
 *      than the market is charging for it, by more than the configured edge.
 *   6. At the close, settle and record the window — traded or not.
 */

export type Phase =
  | 'stopped'
  | 'calibrating'
  | 'waiting-for-window' // deliberately sitting out a window already in progress
  | 'tracking'
  | 'in-position'
  | 'settling';

export interface Cycle {
  market: Market | null;
  phase: Phase;
  barrier: number | null;
  barrierSource: BarrierSource | null;
  sim: Simulation | null;
  askUp: number | null;
  askDown: number | null;
  /** sim.pUp minus askUp, when askUp is at a sane price. */
  edgeUp: number | null;
  /** (1 - sim.pUp) minus askDown, when askDown is at a sane price. */
  edgeDown: number | null;
  tradeId: string | null;
  skipReason: string | null;
  /** Probability track for the chart. */
  track: { t: number; pUp: number; askUp: number | null; askDown: number | null }[];
}

export interface Snapshot {
  running: boolean;
  config: Config;
  connected: boolean;
  feedError: string | null;
  price: number | null;
  priceAt: number;
  chainlinkGap: number | null;
  /** Whether Polymarket's own live Chainlink relay is currently connected. */
  chainlinkLive: boolean;
  ticks: Tick[];
  volPct: number | null;
  cycle: Cycle;
  secondsLeft: number | null;
  /** Seconds until the next window opens, when we are waiting for one. */
  secondsToOpen: number | null;
  /** Seconds left in the mandatory warm-up before the first window can trade. */
  calibratingSecondsLeft: number | null;
  quotes: { up: Quote; down: Quote };
  trades: Trade[];
  windows: WindowRecord[];
  logs: LogLine[];
  stats: Stats;
}

const MAX_TICKS = 2400;
const MAX_LOGS = 200;

export class Engine {
  private config: Config = { ...DEFAULT_CONFIG };
  private running = false;
  private startedAt: number | null = null;

  private ticks: Tick[] = [];
  private bars: Bar[] = [];
  private price: number | null = null;
  /** Last raw Binance read, before the Chainlink anchor offset is applied. */
  private rawPrice: number | null = null;
  /** Added to every Binance price. Re-levelled whenever a fresh Chainlink read arrives. */
  private offset = 0;
  /** When the offset was last re-levelled against a genuine Chainlink read. */
  private lastAnchorAt = 0;
  private priceAt = 0;
  private chainlinkGap: number | null = null;
  private chainlinkLive = false;
  private feedError: string | null = null;
  private vol = { sigma: 0, volPct: 0 };

  private market: Market | null = null;
  /** Whatever window comes after `market`, refreshed on every poll — held ready for an instant handoff at settle. */
  private nextMarket: Market | null = null;
  private books: Record<string, Book> = {};
  private cycle: Cycle = idleCycle('stopped');

  private trades: Trade[] = [];
  private windows: WindowRecord[] = [];
  private logs: LogLine[] = [];

  private readonly chainlinkFeed: ChainlinkFeed;
  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: Snapshot | null = null;
  private queued = false;
  private lastSimAt = 0;
  private seed = 1;
  private pending = { trades: new Map<string, Trade>(), windows: new Map<string, WindowRecord>() };

  constructor(private headers: () => Record<string, string>) {
    this.chainlinkFeed = new ChainlinkFeed({
      onTick: (tick) => {
        this.applyChainlinkAnchor(tick.p);
        this.emit();
      },
      onStatus: (connected) => {
        this.chainlinkLive = connected;
        if (connected) this.log('info', 'Connected to Polymarket’s live Chainlink relay');
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
    this.startedAt = Date.now();
    // A fresh tape for a fresh calibration — data from a previous session
    // would otherwise leave a stale gap in the middle of the new one.
    this.ticks = [];
    this.bars = [];
    this.vol = { sigma: 0, volPct: 0 };
    this.cycle = idleCycle('calibrating');
    this.log(
      'info',
      `Started in ${config.mode} mode. Calibrating for ${CALIBRATION_MIN_SEC / 60} minutes before the first trade.`
    );

    this.chainlinkFeed.start();
    await this.poll();

    this.timers.push(setInterval(() => void this.poll(), 1000));
    this.timers.push(setInterval(() => void this.pollMarket(), 3000));
    this.timers.push(setInterval(() => this.step(), 250));
    this.timers.push(setInterval(() => void this.pollChainlink(), 30_000));
    this.timers.push(setInterval(() => void this.flush(), 5000));
    this.emit();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.chainlinkFeed.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.cycle = { ...this.cycle, phase: 'stopped' };
    void this.flush();
    this.log('info', 'Stopped');
    this.emit();
  }

  setConfig(config: Config): void {
    this.config = { ...config };
    this.emit();
  }

  hydrate(r: { trades?: Trade[]; windows?: WindowRecord[] }): void {
    if (r.trades?.length) {
      const m = new Map(this.trades.map((t) => [t.id, t]));
      for (const t of r.trades) if (!m.has(t.id)) m.set(t.id, t);
      this.trades = [...m.values()].sort((a, b) => a.t - b.t);
    }
    if (r.windows?.length) {
      const m = new Map(this.windows.map((w) => [w.id, w]));
      for (const w of r.windows) if (!m.has(w.id)) m.set(w.id, w);
      this.windows = [...m.values()].sort((a, b) => a.startMs - b.startMs);
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
    // While a window is active, its own market object is authoritative for
    // which tokens the order book belongs to — never the loosely-synced
    // `this.market` pointer, which exists to track the *next* window while
    // waiting and can legitimately point elsewhere by the time a window is
    // underway.
    const forQuotes = this.cycle.market ?? this.market;
    const up = forQuotes?.tokens.find((t) => t.side === 'UP');
    const down = forQuotes?.tokens.find((t) => t.side === 'DOWN');
    const m = this.cycle.market;

    const calibrating =
      this.startedAt !== null ? CALIBRATION_MIN_SEC - (now - this.startedAt) / 1000 : null;

    return {
      running: this.running,
      config: this.config,
      connected: this.price !== null && now - this.priceAt < 8000,
      feedError: this.feedError,
      price: this.price,
      priceAt: this.priceAt,
      chainlinkGap: this.chainlinkGap,
      chainlinkLive: this.chainlinkLive,
      ticks: this.ticks.slice(-400),
      volPct: this.vol.volPct || null,
      cycle: this.cycle,
      secondsLeft: m ? (m.endMs - now) / 1000 : null,
      secondsToOpen: !m && this.market ? (this.market.startMs - now) / 1000 : null,
      calibratingSecondsLeft: calibrating !== null && calibrating > 0 ? calibrating : null,
      quotes: {
        up: quote(up ? this.books[up.tokenId] : null),
        down: quote(down ? this.books[down.tokenId] : null),
      },
      trades: this.trades,
      windows: this.windows,
      logs: this.logs,
      stats: this.stats(),
    };
  }

  // ── Price ─────────────────────────────────────────────────────────────────

  /** One price read per second. Bars and the rolling 30-minute tape are built from this alone. */
  private async poll(): Promise<void> {
    if (!this.running) return;
    try {
      const res = await fetch('/api/price', { headers: this.headers(), cache: 'no-store' });
      if (!res.ok) throw new Error(`price ${res.status}`);
      const tick = (await res.json()) as Tick;
      if (!(tick.p > 0)) throw new Error('bad price');

      this.rawPrice = tick.p;
      const p = tick.p + this.offset;
      this.price = p;
      this.priceAt = Date.now();
      this.feedError = null;
      this.ticks.push({ t: this.priceAt, p });
      if (this.ticks.length > MAX_TICKS) this.ticks = this.ticks.slice(-MAX_TICKS);

      // Fold into the current 10-second bar.
      const b = bucket(this.priceAt);
      const last = this.bars[this.bars.length - 1];
      if (last && last.t === b) last.c = p;
      else if (!last || b > last.t) this.bars.push({ t: b, c: p });

      // Keep only the trailing window — the tape is built purely from what has
      // actually been observed, so it grows toward this width rather than
      // starting there.
      this.bars = trim(this.bars, HISTORY_MIN, this.priceAt);
      if (this.bars.length % 6 === 0) this.vol = volatility(this.bars);
      this.emit();
    } catch (err) {
      this.feedError = msg(err);
      this.emit();
    }
  }

  /**
   * Runs every 30 seconds, market open or not — the free on-chain Chainlink
   * aggregator, purely as a backup anchor and a display cross-check for
   * `Engine.chainlinkFeed`, which updates far more often. Most of these polls
   * are a no-op: the on-chain answer itself only moves on a 0.5% deviation or
   * an hourly heartbeat.
   */
  private async pollChainlink(): Promise<void> {
    if (!this.running) return;
    try {
      const res = await fetch('/api/chainlink', { headers: this.headers(), cache: 'no-store' });
      if (!res.ok) return;
      const d = (await res.json()) as { price?: number | null };
      this.chainlinkGap = d.price && this.price ? this.price - d.price : null;
      if (d.price) this.applyChainlinkAnchor(d.price);
      this.emit();
    } catch {
      /* advisory only */
    }
  }

  /**
   * Re-level Binance to a Chainlink read, from whichever source produced it —
   * Polymarket's live relay (most of the time) or the on-chain fallback.
   * Binance is one exchange's tape; Chainlink's answer is a genuine
   * independent read of the same asset. The difference against the current
   * raw Binance price is added to every Binance number: past (the bars and
   * ticks already on the tape) and future (every price from here on, via
   * `offset`). The second-to-second movement is still Binance's real tape,
   * which is the only source here that updates fast enough to be worth
   * polling every second.
   */
  private applyChainlinkAnchor(chainlinkPrice: number): void {
    this.lastAnchorAt = Date.now();
    if (this.rawPrice === null) return;
    const nextOffset = chainlinkPrice - this.rawPrice;
    const delta = nextOffset - this.offset;
    if (Math.abs(delta) < 0.005) return; // no meaningful change to apply

    this.offset = nextOffset;
    if (this.price !== null) this.price += delta;
    this.bars = shiftBars(this.bars, delta);
    this.ticks = shiftTicks(this.ticks, delta);
  }

  // ── Market ────────────────────────────────────────────────────────────────

  private async pollMarket(): Promise<void> {
    if (!this.running) return;
    try {
      const res = await fetch('/api/market', { headers: this.headers(), cache: 'no-store' });
      if (!res.ok) throw new Error(`market ${res.status}`);
      const d = (await res.json()) as {
        live: Market | null;
        next: Market | null;
        books: Record<string, Book>;
      };

      if (d.books) this.books = { ...this.books, ...d.books };
      this.nextMarket = d.next;

      const now = Date.now();

      // Hold whatever we already have until it genuinely expires. A transient
      // discovery failure must not take the live cycle off the screen with it.
      if (this.market && this.market.endMs > now) {
        const fresh = [d.live, d.next].find((m) => m?.id === this.market!.id);
        if (fresh) this.market = { ...this.market, ...fresh };
      } else {
        // Only ever adopt a window we can join from its open. One already in
        // progress is watched, not traded — its barrier is unknowable to us.
        this.market = d.next ?? (d.live && d.live.startMs >= now - 2000 ? d.live : null);
        if (this.market && this.cycle.market?.id !== this.market.id && this.cycle.phase !== 'calibrating') {
          this.cycle = idleCycle('waiting-for-window');
          const wait = Math.max(0, (this.market.startMs - now) / 1000);
          this.log(
            'info',
            `Next window opens in ${wait.toFixed(0)}s — waiting for it to start ` +
              `(${this.market.slug || this.market.question || this.market.id})`
          );
        }
      }
      this.emit();
    } catch (err) {
      // Keep the market we have; say so, and move on.
      this.log('warn', `Market lookup failed: ${msg(err)}`);
    }
  }

  // ── The cycle ─────────────────────────────────────────────────────────────

  private step(): void {
    if (!this.running) return;
    const now = Date.now();

    const calibrating =
      this.startedAt !== null && now - this.startedAt < CALIBRATION_MIN_SEC * 1000;

    if (calibrating) {
      if (this.cycle.phase !== 'calibrating') {
        this.cycle = idleCycle('calibrating');
        this.emit();
      }
      return; // deliberately sit out any window while calibrating
    }
    if (this.cycle.phase === 'calibrating') {
      this.cycle = idleCycle('waiting-for-window');
      this.log('info', 'Calibration complete — waiting for the next fresh window.');
      this.emit();
    }

    if (!this.market) return;
    const m = this.market;

    // The window we were waiting for has opened — begin at its open.
    if (this.cycle.market === null && now >= m.startMs && now < m.endMs) {
      this.begin(m);
      return;
    }

    const open = this.cycle.market;
    if (!open) return;

    if (now >= open.endMs) {
      if (this.cycle.phase !== 'settling') {
        this.cycle = { ...this.cycle, phase: 'settling' };
        this.settle(open);
      }
      return;
    }

    if (now - this.lastSimAt >= 950) this.update();
  }

  private begin(m: Market): void {
    // Claim the slot and capture the barrier synchronously, right at the
    // open — no awaiting, so there is no window during which the cycle sits
    // blank while a fetch is in flight.
    const captured = this.captureBarrier();
    this.cycle = {
      ...idleCycle('tracking'),
      market: m,
      barrier: captured?.price ?? null,
      barrierSource: captured?.source ?? null,
    };
    this.log(
      captured ? 'info' : 'warn',
      captured
        ? `Window open. Barrier $${captured.price.toFixed(2)} (${barrierSourceLabel(captured.source)})`
        : 'Window opened with no price available anywhere — sitting this one out'
    );
    this.emit(true);
  }

  /**
   * The price to beat, read synchronously off whatever we already have —
   * never fetched fresh at the open, since that is exactly the delay that
   * left the cycle blank right when a window starts. `this.price` is
   * continuously re-anchored to Chainlink already (via `applyChainlinkAnchor`,
   * fired by both the live relay and the on-chain fallback poll), so it is
   * already the right number most of the time — this just picks the most
   * direct source currently on hand and labels it honestly:
   *
   *   1. Polymarket's own live relay of the Chainlink stream, if a tick has
   *      landed in the last 5s — as direct as it gets without commercial
   *      Data Streams credentials.
   *   2. `this.price`, labelled by how recently it was last anchored to a
   *      genuine Chainlink read (the relay or the 30s on-chain poll) versus
   *      running pure Binance since.
   */
  private captureBarrier(): { price: number; source: BarrierSource } | null {
    const live = this.chainlinkFeed.latest();
    if (live) return { price: live.p, source: 'polymarket-live' };
    if (this.price === null) return null;
    const anchored = Date.now() - this.lastAnchorAt < 45_000;
    return { price: this.price, source: anchored ? 'polymarket-onchain' : 'binance' };
  }

  /** Re-simulate from the price now, once a second, until the window closes. */
  private update(): void {
    const c = this.cycle;
    const m = c.market;
    if (!m || c.barrier === null || this.price === null) return;

    const now = Date.now();
    this.lastSimAt = now;
    const remaining = Math.max(0, (m.endMs - now) / 1000);

    if (this.bars.length >= 12) this.vol = volatility(this.bars);

    const sim = simulate({
      barrier: c.barrier,
      current: this.price,
      remainingSec: remaining,
      sigma: this.vol.sigma,
      paths: this.config.paths,
      seed: this.seed++,
    });

    const upQ = this.quoteFor(m, 'UP');
    const downQ = this.quoteFor(m, 'DOWN');
    const sane = (p: number | null) => p !== null && p >= 0.02 && p <= 0.98;
    const edgeUp = sane(upQ.ask) ? sim.pUp - upQ.ask! : null;
    const edgeDown = sane(downQ.ask) ? 1 - sim.pUp - downQ.ask! : null;

    const track = [
      ...c.track,
      { t: now, pUp: sim.pUp, askUp: upQ.ask, askDown: downQ.ask },
    ].slice(-320);

    this.cycle = { ...c, sim, askUp: upQ.ask, askDown: downQ.ask, edgeUp, edgeDown, track };
    this.considerTrade(m, remaining);
    this.emit();
  }

  private quoteFor(m: Market, side: Side): Quote {
    const token = m.tokens.find((t) => t.side === side);
    return quote(token ? this.books[token.tokenId] : null);
  }

  /**
   * The whole trading rule.
   *
   * Buy whichever side the simulation says is worth more than the market is
   * charging for it, by more than the configured edge. There is no pinned
   * direction to defer to — both sides are evaluated on equal footing every
   * time. Everything else here is a safety stop, not a signal.
   */
  private considerTrade(m: Market, remaining: number): void {
    const c = this.cycle;
    if (c.tradeId) return;

    const stop = this.blockingReason(m, remaining);
    if (stop) {
      if (c.skipReason !== stop) this.cycle = { ...this.cycle, skipReason: stop };
      return;
    }

    const up = c.edgeUp ?? -Infinity;
    const down = c.edgeDown ?? -Infinity;
    const bestEdge = Math.max(up, down);

    if (!(bestEdge > this.config.minEdge)) {
      const need =
        bestEdge === -Infinity
          ? 'no tradeable offers'
          : `edge ${(bestEdge * 100).toFixed(1)}% < ${(this.config.minEdge * 100).toFixed(0)}%`;
      if (c.skipReason !== need) this.cycle = { ...this.cycle, skipReason: need };
      return;
    }

    this.cycle = { ...this.cycle, skipReason: null };
    void this.buy(m, up >= down ? 'UP' : 'DOWN');
  }

  /** Hard stops, in the order an operator would want to hear about them. */
  private blockingReason(m: Market, remaining: number): string | null {
    if (this.config.killSwitch) return 'kill switch on';
    if (!this.config.autoTrade) return 'auto-trade off';
    if (!m.acceptingOrders) return 'market closed to orders';
    if (remaining < this.config.minSecondsLeft) return 'too close to the close';
    if (this.trades.some((t) => t.marketId === m.id)) return 'already traded this window';
    if (this.trades.some((t) => t.status === 'OPEN')) return 'a position is still open';
    if (this.todayPnl() <= -Math.abs(this.config.maxDailyLossUsd)) return 'daily loss limit hit';
    if (this.price === null) return 'no price';
    return null;
  }

  private async buy(m: Market, side: Side): Promise<void> {
    const c = this.cycle;
    const token = m.tokens.find((t) => t.side === side);
    const ask = side === 'UP' ? c.askUp : c.askDown;
    if (!token || ask === null || !c.sim) return;
    const ourProb = side === 'UP' ? c.sim.pUp : 1 - c.sim.pUp;

    this.cycle = { ...this.cycle, tradeId: 'pending', phase: 'in-position' };
    const shares = Math.floor(this.config.stakeUsd / ask);

    this.log(
      'trade',
      `Buying ${side} — ours ${(ourProb * 100).toFixed(0)}% vs market ${(ask * 100).toFixed(0)}%`
    );

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify({
          mode: this.config.mode,
          marketId: m.id,
          marketSlug: m.slug,
          tokenId: token.tokenId,
          side,
          shares,
          maxPrice: Math.min(0.98, ask + 0.01),
          tickSize: m.minTickSize,
          minOrderSize: m.minOrderSize,
          negRisk: m.negRisk,
          ourProb,
          barrier: c.barrier ?? 0,
        }),
      });
      const data = (await res.json()) as { trade?: Trade; error?: string };

      if (!res.ok || !data.trade) {
        this.cycle = { ...this.cycle, tradeId: null, phase: 'tracking', skipReason: data.error ?? 'order rejected' };
        this.log('warn', `Not filled: ${data.error ?? res.status}`);
        this.emit(true);
        return;
      }

      this.trades = [...this.trades, data.trade];
      this.pending.trades.set(data.trade.id, data.trade);
      this.cycle = { ...this.cycle, tradeId: data.trade.id };
      this.log(
        'trade',
        `Filled ${data.trade.shares} ${side} at ${data.trade.price.toFixed(3)} ($${data.trade.cost.toFixed(2)})`
      );
      this.emit(true);
    } catch (err) {
      this.cycle = { ...this.cycle, tradeId: null, phase: 'tracking' };
      this.log('error', `Order error: ${msg(err)}`);
      this.emit(true);
    }
  }

  // ── Settlement ────────────────────────────────────────────────────────────

  private settle(m: Market): void {
    const c = this.cycle;
    const close = this.price;
    if (c.barrier === null || close === null) {
      this.cycle = { ...this.cycle, phase: 'settling' };
      return;
    }

    // Polymarket resolves UP on a tie (close >= open), not strictly greater —
    // see the market's own rules.
    const outcome: Side = close >= c.barrier ? 'UP' : 'DOWN';
    const move = close - c.barrier;

    for (const t of this.trades) {
      if (t.marketId !== m.id || t.status !== 'OPEN') continue;
      const won = t.side === outcome;
      const pnl = won ? t.shares * (1 - t.price) : -t.cost;
      const settled: Trade = { ...t, status: won ? 'WON' : 'LOST', pnl, settlePrice: close, outcome };
      this.trades = this.trades.map((x) => (x.id === t.id ? settled : x));
      this.pending.trades.set(settled.id, settled);
      this.log(
        'trade',
        `${won ? 'WON' : 'LOST'} — BTC ${move >= 0 ? '+' : ''}$${move.toFixed(2)} → ${outcome}. ` +
          `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`
      );
    }

    const traded = this.trades.find((t) => t.marketId === m.id) ?? null;
    if (!traded) {
      this.log(
        'info',
        `Window closed ${outcome} (${move >= 0 ? '+' : ''}$${move.toFixed(2)}) — no trade${c.skipReason ? `: ${c.skipReason}` : ''}`
      );
    }

    const record: WindowRecord = {
      id: `${m.id}-${m.startMs}`,
      marketId: m.id,
      slug: m.slug,
      startMs: m.startMs,
      endMs: m.endMs,
      barrier: c.barrier,
      barrierSource: c.barrierSource ?? 'binance',
      close,
      outcome,
      finalPUp: c.sim?.pUp ?? null,
      traded: Boolean(traded),
      pnl: traded?.pnl ?? null,
      skipReason: traded ? null : c.skipReason,
    };

    if (!this.windows.some((w) => w.id === record.id)) {
      this.windows = [...this.windows, record].slice(-300);
      this.pending.windows.set(record.id, record);
    }

    this.cycle = idleCycle('waiting-for-window');
    // Hand off directly to the window already pre-fetched by pollMarket —
    // windows are back-to-back, so this is normally ready to open right now,
    // with no rediscovery gap. Only falls back to null (a fresh poll within
    // 3s) if discovery genuinely hasn't caught up.
    this.market = this.nextMarket;
    this.nextMarket = null;
    if (this.market) {
      const wait = Math.max(0, (this.market.startMs - Date.now()) / 1000);
      this.log(
        'info',
        `Next window opens in ${wait.toFixed(0)}s — waiting for it to start ` +
          `(${this.market.slug || this.market.question || this.market.id})`
      );
    }
    this.emit(true);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  private todayPnl(): number {
    const dayStart = new Date().setHours(0, 0, 0, 0);
    return this.trades
      .filter((t) => t.t >= dayStart && t.pnl !== null)
      .reduce((s, t) => s + (t.pnl ?? 0), 0);
  }

  private stats(): Stats {
    const done = this.trades.filter((t) => t.status === 'WON' || t.status === 'LOST');
    const wins = done.filter((t) => t.status === 'WON').length;

    // Scored over every window observed, not only the traded ones — scoring
    // only trades samples exactly the windows where the simulation disagreed
    // with the market, which is the most biased subset available.
    const scored = this.windows.filter((w) => w.outcome !== null && w.finalPUp !== null);
    const brier =
      scored.length === 0
        ? null
        : scored.reduce((s, w) => s + (w.finalPUp! - (w.outcome === 'UP' ? 1 : 0)) ** 2, 0) /
          scored.length;

    return {
      trades: this.trades.length,
      wins,
      losses: done.length - wins,
      open: this.trades.filter((t) => t.status === 'OPEN').length,
      winRate: done.length > 0 ? wins / done.length : 0,
      pnl: done.reduce((s, t) => s + (t.pnl ?? 0), 0),
      today: this.todayPnl(),
      windows: this.windows.length,
      brier,
      scored: scored.length,
    };
  }

  // ── Persistence / logging ─────────────────────────────────────────────────

  private async flush(): Promise<void> {
    if (this.pending.trades.size === 0 && this.pending.windows.size === 0) return;
    const body = {
      trades: [...this.pending.trades.values()],
      windows: [...this.pending.windows.values()],
    };
    this.pending.trades.clear();
    this.pending.windows.clear();
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

function idleCycle(phase: Phase): Cycle {
  return {
    market: null,
    phase,
    barrier: null,
    barrierSource: null,
    sim: null,
    askUp: null,
    askDown: null,
    edgeUp: null,
    edgeDown: null,
    tradeId: null,
    skipReason: null,
    track: [],
  };
}

function barrierSourceLabel(s: BarrierSource): string {
  if (s === 'polymarket-live') return "Polymarket's live Chainlink relay";
  if (s === 'polymarket-onchain') return 'on-chain Chainlink, fallback';
  return 'Binance, fallback — Chainlink unavailable';
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { WINDOW_SEC };
