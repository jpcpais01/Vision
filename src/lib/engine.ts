import type {
  Bar,
  Book,
  Config,
  Forecast,
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
import { DEFAULT_CONFIG, HISTORY_MIN, WINDOW_SEC } from './config';
import { bucket, fillGaps, merge, shiftBars, shiftTicks, toBars, trim, volatility } from './bars';
import { quote } from './book';
import { simulate } from './montecarlo';

/**
 * ── The loop ─────────────────────────────────────────────────────────────────
 *
 * One instance runs the whole session. Per five-minute window:
 *
 *   1. Wait for a window that has not started yet, and join it at its open.
 *      Never mid-window — the barrier is the price at the open, and joining
 *      late means guessing it.
 *   2. At the open, record the barrier and ask the model: higher or lower in
 *      five minutes, and how likely?
 *   3. Keep polling the price every second while it thinks.
 *   4. When the answer lands, re-simulate every second from the price now, so
 *      the probability tracks what actually happened rather than what the
 *      model expected.
 *   5. Buy the model's side when our probability beats the market's ask by
 *      more than the configured edge.
 *   6. At the close, settle and record the window — traded or not.
 */

export type Phase =
  | 'stopped'
  | 'waiting-for-window' // deliberately sitting out a window already in progress
  | 'forecasting'
  | 'tracking'
  | 'in-position'
  | 'settling';

export interface Cycle {
  market: Market | null;
  phase: Phase;
  barrier: number | null;
  forecast: Forecast | null;
  forecastError: string | null;
  sim: Simulation | null;
  /** Our probability for the side the model called. */
  ourProb: number | null;
  /** What the market charges for that side. */
  marketProb: number | null;
  edge: number | null;
  tradeId: string | null;
  skipReason: string | null;
  /** Probability track for the chart. */
  track: { t: number; ours: number; market: number | null; price: number }[];
}

export interface Snapshot {
  running: boolean;
  config: Config;
  connected: boolean;
  feedError: string | null;
  price: number | null;
  priceAt: number;
  chainlinkGap: number | null;
  bars: Bar[];
  ticks: Tick[];
  volPct: number | null;
  cycle: Cycle;
  secondsLeft: number | null;
  /** Seconds until the next window opens, when we are waiting for one. */
  secondsToOpen: number | null;
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

  private ticks: Tick[] = [];
  private bars: Bar[] = [];
  private price: number | null = null;
  /** Last raw Binance read, before the Chainlink anchor offset is applied. */
  private rawPrice: number | null = null;
  /** Added to every Binance price. Recomputed at the open of each window. */
  private offset = 0;
  private priceAt = 0;
  private chainlinkGap: number | null = null;
  private feedError: string | null = null;
  private vol = { sigma: 0, volPct: 0 };

  private market: Market | null = null;
  private books: Record<string, Book> = {};
  private cycle: Cycle = idleCycle();

  private trades: Trade[] = [];
  private windows: WindowRecord[] = [];
  private logs: LogLine[] = [];

  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: Snapshot | null = null;
  private queued = false;
  private lastSimAt = 0;
  private seed = 1;
  private pending = { trades: new Map<string, Trade>(), windows: new Map<string, WindowRecord>() };

  constructor(private headers: () => Record<string, string>) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(config: Config): Promise<void> {
    if (this.running) {
      this.config = { ...config };
      return;
    }
    this.config = { ...config };
    this.running = true;
    this.log('info', `Started in ${config.mode} mode`);

    await this.loadHistory();
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
    // underway. Falling back to it only when there is no active cycle lets the
    // book preview the upcoming market while waiting, without ever letting it
    // drift from the window actually on screen once one has opened.
    const forQuotes = this.cycle.market ?? this.market;
    const up = forQuotes?.tokens.find((t) => t.side === 'UP');
    const down = forQuotes?.tokens.find((t) => t.side === 'DOWN');
    const m = this.cycle.market;

    return {
      running: this.running,
      config: this.config,
      connected: this.price !== null && now - this.priceAt < 8000,
      feedError: this.feedError,
      price: this.price,
      priceAt: this.priceAt,
      chainlinkGap: this.chainlinkGap,
      bars: this.bars,
      ticks: this.ticks.slice(-400),
      volPct: this.vol.volPct || null,
      cycle: this.cycle,
      secondsLeft: m ? (m.endMs - now) / 1000 : null,
      secondsToOpen: !m && this.market ? (this.market.startMs - now) / 1000 : null,
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

  private async loadHistory(): Promise<void> {
    try {
      const res = await fetch(`/api/history?minutes=${HISTORY_MIN}`, {
        headers: this.headers(),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`history ${res.status}`);
      const data = (await res.json()) as { bars: Bar[] };
      this.bars = merge(data.bars ?? [], this.bars);
      this.vol = volatility(this.bars);
      this.log('info', `Loaded ${data.bars?.length ?? 0} bars of price history`);
    } catch (err) {
      this.log('warn', `History unavailable: ${msg(err)} — volatility will warm up from live ticks`);
    }
    this.emit();
  }

  /** One price read per second, as the whole system is specified to use. */
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

      if (this.bars.length % 6 === 0) this.vol = volatility(this.bars);
      this.emit();
    } catch (err) {
      this.feedError = msg(err);
      this.emit();
    }
  }

  /**
   * Runs every 30 seconds, market open or not. Every fetch also feeds the
   * anchor (`applyChainlinkAnchor`) — so the Binance-derived price is
   * re-levelled to Chainlink for as long as the window is open, not only at
   * its first instant. Most of these polls are a no-op: the on-chain answer
   * itself only moves on a 0.5% deviation or an hourly heartbeat, so there is
   * usually nothing new to apply. When it does move, this is what catches it.
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

      const now = Date.now();

      // Hold whatever we already have until it genuinely expires. A transient
      // discovery failure used to null this out and take the forecast and the
      // probabilities off the screen with it.
      if (this.market && this.market.endMs > now) {
        const fresh = [d.live, d.next].find((m) => m?.id === this.market!.id);
        if (fresh) this.market = { ...this.market, ...fresh };
      } else {
        // Only ever adopt a window we can join from its open. One already in
        // progress is watched, not traded — its barrier is unknowable to us.
        this.market = d.next ?? (d.live && d.live.startMs >= now - 2000 ? d.live : null);
        if (this.market && this.cycle.market?.id !== this.market.id) {
          this.cycle = { ...idleCycle(), phase: 'waiting-for-window' };
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
    if (!this.running || !this.market) return;
    const now = Date.now();
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
    if (this.price === null) {
      this.log('warn', 'Window opened with no price — sitting this one out');
      return;
    }
    // Claim the slot synchronously: step() runs every 250ms and this.cycle
    // .market must stop being null right away, or the Chainlink fetch below
    // would let a second tick re-enter and start the window twice.
    this.cycle = { ...idleCycle(), market: m, phase: 'forecasting' };
    this.emit(true);
    void this.openWindow(m);
  }

  private async openWindow(m: Market): Promise<void> {
    await this.computeOffset();
    if (this.cycle.market?.id !== m.id || this.price === null) return;

    const barrier = this.price;
    this.cycle = { ...this.cycle, barrier };
    this.log('info', `Window open. Barrier $${barrier.toFixed(2)}`);
    this.emit(true);
    void this.askModel(m, barrier);
  }

  /**
   * Anchor Binance to the settlement oracle before capturing a barrier.
   *
   * A guaranteed-fresh read: the barrier must not be captured on a stale
   * anchor, so this fetches Chainlink directly rather than waiting for the
   * next `pollChainlink` tick (which can be up to 30s away).
   */
  private async computeOffset(): Promise<void> {
    if (this.rawPrice === null) return;
    try {
      const res = await fetch('/api/chainlink', { headers: this.headers(), cache: 'no-store' });
      if (!res.ok) return;
      const d = (await res.json()) as { price?: number | null };
      if (d.price) this.applyChainlinkAnchor(d.price);
    } catch {
      // Best-effort. Trade on raw Binance if Chainlink is unreachable.
    }
  }

  /**
   * Re-level Binance to a Chainlink read.
   *
   * Binance is one exchange's tape; Chainlink's on-chain answer, though far too
   * slow to trade from on its own, is a genuine independent read of the same
   * asset. Whenever a fresh one arrives — at a window's open, and every 30s
   * afterward via `pollChainlink` — the difference against the current raw
   * Binance price is added to every Binance number: past (the bars and ticks
   * already on the tape) and future (every price from here on, via `offset`).
   * The level we trade on stays close to what Polymarket actually settles
   * against for as long as the window runs; the second-to-second movement is
   * still Binance's real tape, which is the only part of this that updates
   * fast enough to be worth polling every second.
   */
  private applyChainlinkAnchor(chainlinkPrice: number): void {
    if (this.rawPrice === null) return;
    const nextOffset = chainlinkPrice - this.rawPrice;
    const delta = nextOffset - this.offset;
    if (Math.abs(delta) < 0.005) return; // the on-chain answer has not moved

    this.offset = nextOffset;
    if (this.price !== null) this.price += delta;
    this.bars = shiftBars(this.bars, delta);
    this.ticks = shiftTicks(this.ticks, delta);
    this.log(
      'info',
      `Anchored to Chainlink: ${delta >= 0 ? '+' : '-'}$${Math.abs(delta).toFixed(2)} ` +
        `(Chainlink $${chainlinkPrice.toFixed(2)} vs Binance $${this.rawPrice.toFixed(2)})`
    );
  }

  /** Ask once, at the open. Nothing waits on it. */
  private async askModel(m: Market, barrier: number): Promise<void> {
    try {
      const res = await fetch('/api/forecast', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers() },
        body: JSON.stringify({ bars: this.bars.slice(-190), current: barrier }),
      });
      const data = (await res.json()) as { forecast?: Forecast; error?: string };

      // The window may have rolled while we waited — do not apply a stale call.
      if (this.cycle.market?.id !== m.id) return;

      if (!res.ok || !data.forecast) {
        this.cycle = {
          ...this.cycle,
          phase: 'tracking',
          forecastError: data.error ?? `forecast failed (${res.status})`,
          skipReason: 'no forecast',
        };
        this.log('error', this.cycle.forecastError!);
        this.emit(true);
        return;
      }

      const f = data.forecast;
      const moved = (this.price ?? barrier) - barrier;
      this.cycle = { ...this.cycle, forecast: f, forecastError: null, phase: 'tracking' };
      this.log(
        'info',
        `Model says ${f.side} at ${(f.probability * 100).toFixed(0)}% (${f.latencyMs}ms). ` +
          `BTC moved $${moved.toFixed(2)} while it thought.`
      );
      this.update();
    } catch (err) {
      if (this.cycle.market?.id !== m.id) return;
      this.cycle = {
        ...this.cycle,
        phase: 'tracking',
        forecastError: msg(err),
        skipReason: 'no forecast',
      };
      this.log('error', `Forecast failed: ${msg(err)}`);
      this.emit(true);
    }
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
      llmPUp: c.forecast?.pUp ?? 0.5,
      llmWeight: c.forecast ? this.config.llmWeight : 0,
      sigma: this.vol.sigma,
      paths: this.config.paths,
      seed: this.seed++,
    });

    // Without a call from the model there is no side to take, so we track the
    // probability for the display and trade nothing.
    const side = c.forecast?.side ?? null;
    const ourProb = side ? (side === 'UP' ? sim.pUp : 1 - sim.pUp) : null;
    const q = side ? this.quoteFor(m, side) : null;
    const marketProb = q?.ask ?? null;
    const edge = ourProb !== null && marketProb !== null ? ourProb - marketProb : null;

    const track = [
      ...c.track,
      { t: now, ours: ourProb ?? sim.pUp, market: marketProb, price: this.price },
    ].slice(-320);

    this.cycle = { ...c, sim, ourProb, marketProb, edge, track };
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
   * Buy the side the model called, when our probability beats what the market
   * charges for it by more than the configured edge. Everything else here is a
   * safety stop, not a signal.
   */
  private considerTrade(m: Market, remaining: number): void {
    const c = this.cycle;
    if (c.tradeId || !c.forecast || c.ourProb === null || c.edge === null) return;

    const stop = this.blockingReason(m, remaining);
    if (stop) {
      if (c.skipReason !== stop) this.cycle = { ...this.cycle, skipReason: stop };
      return;
    }

    if (c.edge <= this.config.minEdge) {
      const need = `edge ${(c.edge * 100).toFixed(1)}% < ${(this.config.minEdge * 100).toFixed(0)}%`;
      if (c.skipReason !== need) this.cycle = { ...this.cycle, skipReason: need };
      return;
    }

    this.cycle = { ...this.cycle, skipReason: null };
    void this.buy(m, c.forecast.side);
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

    const q = this.quoteFor(m, this.cycle.forecast!.side);
    if (q.ask === null) return 'no offers to buy';
    if (q.ask < 0.02 || q.ask > 0.98) return 'price too extreme';
    if (this.price === null) return 'no price';
    return null;
  }

  private async buy(m: Market, side: Side): Promise<void> {
    const c = this.cycle;
    const token = m.tokens.find((t) => t.side === side);
    if (!token || c.marketProb === null) return;

    this.cycle = { ...this.cycle, tradeId: 'pending', phase: 'in-position' };
    const shares = Math.floor(this.config.stakeUsd / c.marketProb);

    this.log(
      'trade',
      `Buying ${side} — ours ${((c.ourProb ?? 0) * 100).toFixed(0)}% vs market ${(c.marketProb * 100).toFixed(0)}%`
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
          maxPrice: Math.min(0.98, c.marketProb + 0.01),
          tickSize: m.minTickSize,
          minOrderSize: m.minOrderSize,
          negRisk: m.negRisk,
          ourProb: c.ourProb ?? 0.5,
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
      close,
      outcome,
      llmSide: c.forecast?.side ?? null,
      llmProb: c.forecast?.probability ?? null,
      llmLatencyMs: c.forecast?.latencyMs ?? null,
      finalPUp: c.sim?.pUp ?? null,
      finalPUpNeutral: c.sim?.pUpNeutral ?? null,
      traded: Boolean(traded),
      pnl: traded?.pnl ?? null,
      skipReason: traded ? null : c.skipReason,
    };

    if (!this.windows.some((w) => w.id === record.id)) {
      this.windows = [...this.windows, record].slice(-300);
      this.pending.windows.set(record.id, record);
    }

    this.cycle = idleCycle();
    this.market = null; // force a fresh look for the next window
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

    // Score the forecast over every window observed, not only the traded ones —
    // scoring only trades samples exactly the windows where we disagreed with
    // the market, which is the most biased subset available.
    const scored = this.windows.filter(
      (w) => w.outcome !== null && w.finalPUp !== null && w.finalPUpNeutral !== null
    );
    const brier = (pick: (w: WindowRecord) => number) =>
      scored.length === 0
        ? null
        : scored.reduce((s, w) => s + (pick(w) - (w.outcome === 'UP' ? 1 : 0)) ** 2, 0) /
          scored.length;

    const called = this.windows.filter((w) => w.llmSide !== null && w.outcome !== null);
    const right = called.filter((w) => w.llmSide === w.outcome).length;

    return {
      trades: this.trades.length,
      wins,
      losses: done.length - wins,
      open: this.trades.filter((t) => t.status === 'OPEN').length,
      winRate: done.length > 0 ? wins / done.length : 0,
      pnl: done.reduce((s, t) => s + (t.pnl ?? 0), 0),
      today: this.todayPnl(),
      windows: this.windows.length,
      brierWithLlm: brier((w) => w.finalPUp!),
      brierNeutral: brier((w) => w.finalPUpNeutral!),
      llmAccuracy: called.length > 0 ? right / called.length : null,
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

function idleCycle(): Cycle {
  return {
    market: null,
    phase: 'waiting-for-window',
    barrier: null,
    forecast: null,
    forecastError: null,
    sim: null,
    ourProb: null,
    marketProb: null,
    edge: null,
    tradeId: null,
    skipReason: null,
    track: [],
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export { WINDOW_SEC, toBars, fillGaps, trim };
