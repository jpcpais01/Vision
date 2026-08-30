import type {
  Bar,
  BookQuote,
  BtcMarket,
  ChainlinkSnapshot,
  CycleRecord,
  Decision,
  LlmResult,
  LogEntry,
  LogLevel,
  Metrics,
  MonteCarloResult,
  OrderBook,
  PricePoint,
  Trade,
  TradingConfig,
  VolEstimate,
} from '../types';
import { BAR_SECONDS, DEFAULT_CONFIG, WINDOW_SECONDS } from '../config';
import { bucketStart, fillBarGaps, mergeBars, ticksToBars, trimBars } from '../price/aggregator';
import { estimateVolatility, logReturns } from '../quant/volatility';
import { runMonteCarlo } from '../quant/montecarlo';
import { computeMetrics } from '../quant/calibration';
import { quoteFromBook } from '../polymarket/clob';
import { evaluate, shrinkProbability, type PortfolioState } from './risk';
import { BookFeed, PriceFeed, type FeedStatus } from './feeds';

/**
 * ── The trading engine ───────────────────────────────────────────────────────
 *
 * One instance owns the entire loop for a session. It runs in the browser,
 * which is what makes the timing work: the 5-minute window is short, the LLM
 * round trip is a meaningful fraction of it, and every hop through a serverless
 * function is latency spent on a clock that does not stop. The server keeps the
 * secrets, re-validates every order and stores the record; the engine keeps the
 * tape and the clock.
 *
 * Per window the sequence is:
 *
 *   1. Detect the new market and capture the exact BTC price at its open —
 *      the barrier the bet settles against.
 *   2. Immediately dispatch the last hour of 10-second history to the LLM and
 *      ask for a calibrated P(UP).
 *   3. **Keep recording BTC while the model thinks.** This is the point of the
 *      design: those seconds are not dead time, they are new information.
 *   4. When the forecast lands, run the conditional Monte Carlo — the LLM
 *      probability seeds the drift, the simulation starts from the price *now*,
 *      and only the remaining seconds are simulated.
 *   5. Compare the updated probability against the real executable ask and
 *      trade only if every edge, liquidity, spread, timing and risk gate passes.
 *   6. Re-run the simulation continuously until the window closes, then settle.
 */

export type CyclePhase =
  | 'idle'
  | 'awaiting-market'
  | 'capturing-open'
  | 'llm-pending'
  | 'monitoring'
  | 'positioned'
  | 'settling'
  | 'settled';

export interface ProbabilityPoint {
  t: number;
  /** Seconds elapsed in the window. */
  elapsed: number;
  mc: number;
  llm: number | null;
  marketUp: number | null;
  btc: number;
}

export interface CycleState {
  market: BtcMarket | null;
  phase: CyclePhase;
  startPrice: number | null;
  startPriceSource: 'observed' | 'estimated' | null;
  startPriceCapturedAt: number | null;
  llm: LlmResult | null;
  llmError: string | null;
  llmDispatchedAt: number | null;
  llmPriceAtDispatch: number | null;
  /** BTC path recorded while the model was thinking. */
  pathDuringLlm: PricePoint[];
  mc: MonteCarloResult | null;
  /** Post-shrink probability actually used for trading. */
  finalPUp: number | null;
  vol: VolEstimate | null;
  decision: Decision | null;
  tradeId: string | null;
  history: ProbabilityPoint[];
  decisionLatencyMs: number | null;
}

export interface EngineSnapshot {
  running: boolean;
  config: TradingConfig;
  now: number;

  // Feeds
  priceStatus: FeedStatus;
  bookStatus: FeedStatus;
  btc: number | null;
  btcAt: number;
  chainlink: ChainlinkSnapshot | null;
  bars: Bar[];
  recentTicks: PricePoint[];
  vol: VolEstimate | null;
  historyReady: boolean;
  interpolatedFeed: boolean;

  // Market
  market: BtcMarket | null;
  upcoming: BtcMarket[];
  books: Record<string, OrderBook>;
  quotes: Record<string, BookQuote>;
  upTokenId: string | null;
  downTokenId: string | null;

  // Cycle
  cycle: CycleState;
  secondsLeft: number | null;
  elapsedSec: number | null;

  // Records
  trades: Trade[];
  cycles: CycleRecord[];
  logs: LogEntry[];
  metrics: Metrics;

  errors: string[];
}

export interface EngineOptions {
  getHeaders: () => Record<string, string>;
  onPersist?: (payload: {
    trades?: Trade[];
    cycles?: CycleRecord[];
    logs?: LogEntry[];
  }) => void;
}

/**
 * Retained tick history. Binance can stream fifty BTC trades a second, so the
 * stored series is throttled to ~5/s: at that rate this buffer holds about
 * twenty minutes, which comfortably spans the 5-minute window whose open price
 * every probability in the system is measured against. Untruncated, a busy tape
 * would flush the buffer in under two minutes and take the barrier with it.
 */
const MAX_TICKS = 6000;
const TICK_STORE_INTERVAL_MS = 200;
const MAX_PROB_POINTS = 400;
const MAX_LOGS = 400;

export class TradingEngine {
  private config: TradingConfig = { ...DEFAULT_CONFIG };
  private running = false;

  private ticks: PricePoint[] = [];
  /** Newest tick, retained even when throttled out of the stored history. */
  private latestTick: PricePoint | null = null;
  private bars: Bar[] = [];
  private vol: VolEstimate | null = null;
  private historyReady = false;
  private interpolatedFeed = false;

  private market: BtcMarket | null = null;
  private upcoming: BtcMarket[] = [];
  private books: Record<string, OrderBook> = {};
  private chainlink: ChainlinkSnapshot | null = null;

  private trades: Trade[] = [];
  private cycles: CycleRecord[] = [];
  private logs: LogEntry[] = [];
  private errors: string[] = [];

  private cycle: CycleState = emptyCycle();

  private priceFeed: PriceFeed;
  private bookFeed: BookFeed;
  private priceStatus: FeedStatus = idleStatus('price');
  private bookStatus: FeedStatus = idleStatus('polymarket-clob');

  private timers: ReturnType<typeof setInterval>[] = [];
  private listeners = new Set<() => void>();
  private snapshot: EngineSnapshot | null = null;
  private notifyScheduled = false;
  private lastMcAt = 0;
  private seedCounter = 1;
  private pendingPersistTrades = new Map<string, Trade>();
  private pendingPersistCycles = new Map<string, CycleRecord>();
  private pendingPersistLogs: LogEntry[] = [];

  constructor(private opts: EngineOptions) {
    this.priceFeed = new PriceFeed({
      source: this.config.priceSource,
      headers: opts.getHeaders,
      onTick: (tick) => this.onTick(tick),
      onStatus: (s) => {
        this.priceStatus = s;
        this.notify();
      },
    });
    this.bookFeed = new BookFeed({
      headers: opts.getHeaders,
      onBook: (book) => this.onBook(book),
      onStatus: (s) => {
        this.bookStatus = s;
        this.notify();
      },
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(config: TradingConfig): Promise<void> {
    if (this.running) {
      this.setConfig(config);
      return;
    }
    const sourceChanged = this.config.priceSource !== config.priceSource;
    this.config = { ...config };
    this.running = true;
    this.log('info', 'engine', `Engine started in ${config.mode} mode`);

    // The feed is built in the constructor from the default source; if the
    // operator picked a different venue before pressing start, rebuild it now.
    if (sourceChanged) this.rebuildPriceFeed();

    await this.loadHistory();

    this.priceFeed.start();
    this.bookFeed.start();

    void this.pollMarket();
    void this.pollChainlink();

    this.timers.push(setInterval(() => void this.pollMarket(), 3000));
    this.timers.push(setInterval(() => void this.pollChainlink(), 20_000));
    this.timers.push(setInterval(() => this.tickLoop(), 250));
    this.timers.push(setInterval(() => this.rebuildBars(), 5000));
    this.timers.push(setInterval(() => void this.flushPersist(), 5000));

    this.notify();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.priceFeed.stop();
    this.bookFeed.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    void this.flushPersist();
    this.log('info', 'engine', 'Engine stopped');
    this.notify();
  }

  setConfig(config: TradingConfig): void {
    const prev = this.config;
    this.config = { ...config };
    if (prev.priceSource !== config.priceSource && this.running) {
      // Restart the feed against the new venue and re-pull history, since the
      // vol estimate must not mix tapes from two exchanges.
      this.rebuildPriceFeed();
      void this.loadHistory();
    }
    this.notify();
  }

  private rebuildPriceFeed(): void {
    this.priceFeed.stop();
    this.priceFeed = new PriceFeed({
      source: this.config.priceSource,
      headers: this.opts.getHeaders,
      onTick: (tick) => this.onTick(tick),
      onStatus: (s) => {
        this.priceStatus = s;
        this.notify();
      },
    });
    if (this.running) this.priceFeed.start();
  }

  /** Seed the engine with the durable record from the server. */
  hydrate(records: { trades?: Trade[]; cycles?: CycleRecord[]; logs?: LogEntry[] }): void {
    if (records.trades?.length) {
      const byId = new Map(this.trades.map((t) => [t.id, t]));
      for (const t of records.trades) if (!byId.has(t.id)) byId.set(t.id, t);
      this.trades = Array.from(byId.values()).sort((a, b) => a.t - b.t);
    }
    if (records.cycles?.length) {
      const byId = new Map(this.cycles.map((c) => [c.id, c]));
      for (const c of records.cycles) if (!byId.has(c.id)) byId.set(c.id, c);
      this.cycles = Array.from(byId.values()).sort((a, b) => a.startMs - b.startMs);
    }
    if (records.logs?.length) {
      this.logs = [...records.logs, ...this.logs].slice(-MAX_LOGS);
    }
    this.notify();
  }

  // ── React integration ─────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EngineSnapshot => {
    if (!this.snapshot) this.snapshot = this.buildSnapshot();
    return this.snapshot;
  };

  private notify(immediate = false): void {
    this.snapshot = null;
    if (immediate) {
      for (const l of this.listeners) l();
      return;
    }
    // Coalesce: the trade feed can produce dozens of updates per second and
    // React does not need to see any of them at more than ~7 Hz.
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    setTimeout(() => {
      this.notifyScheduled = false;
      this.snapshot = null;
      for (const l of this.listeners) l();
    }, 140);
  }

  private buildSnapshot(): EngineSnapshot {
    const now = Date.now();
    const last = this.latestTick ?? this.ticks[this.ticks.length - 1] ?? null;
    const quotes: Record<string, BookQuote> = {};
    for (const [id, book] of Object.entries(this.books)) quotes[id] = quoteFromBook(book);

    const upToken = this.market?.tokens.find((t) => t.side === 'UP')?.tokenId ?? null;
    const downToken = this.market?.tokens.find((t) => t.side === 'DOWN')?.tokenId ?? null;

    return {
      running: this.running,
      config: this.config,
      now,
      priceStatus: this.priceStatus,
      bookStatus: this.bookStatus,
      btc: last?.p ?? null,
      btcAt: last?.t ?? 0,
      chainlink: this.chainlink,
      bars: this.bars,
      recentTicks: this.ticks.slice(-600),
      vol: this.vol,
      historyReady: this.historyReady,
      interpolatedFeed: this.interpolatedFeed,
      market: this.market,
      upcoming: this.upcoming,
      books: this.books,
      quotes,
      upTokenId: upToken,
      downTokenId: downToken,
      cycle: this.cycle,
      secondsLeft: this.market ? (this.market.endMs - now) / 1000 : null,
      elapsedSec: this.market ? (now - this.market.startMs) / 1000 : null,
      trades: this.trades,
      cycles: this.cycles,
      logs: this.logs,
      metrics: computeMetrics(this.trades),
      errors: this.errors,
    };
  }

  // ── Data ingestion ────────────────────────────────────────────────────────

  private onTick(tick: PricePoint): void {
    if (!Number.isFinite(tick.p) || tick.p <= 0) return;
    this.latestTick = tick;

    // Throttle what is retained, not what is observed: the newest price is
    // always current, while the stored series stays long enough to reach back
    // past the window open.
    const lastStored = this.ticks[this.ticks.length - 1];
    if (!lastStored || tick.t - lastStored.t >= TICK_STORE_INTERVAL_MS) {
      this.ticks.push(tick);
      if (this.ticks.length > MAX_TICKS) this.ticks = this.ticks.slice(-MAX_TICKS);
    }

    // Fold straight into the current 10s bar so the series is always live.
    const start = bucketStart(tick.t);
    const lastBar = this.bars[this.bars.length - 1];
    if (lastBar && lastBar.t === start) {
      lastBar.c = tick.p;
      if (tick.p > lastBar.h) lastBar.h = tick.p;
      if (tick.p < lastBar.l) lastBar.l = tick.p;
    } else if (!lastBar || start > lastBar.t) {
      this.bars.push({ t: start, o: tick.p, h: tick.p, l: tick.p, c: tick.p, v: 0 });
    }

    // While the LLM is thinking, keep the path it will be judged against.
    if (this.cycle.phase === 'llm-pending') {
      this.cycle.pathDuringLlm.push(tick);
    }

    this.captureStartPriceIfDue();
    this.notify();
  }

  private onBook(book: OrderBook): void {
    this.books = { ...this.books, [book.tokenId]: book };
    this.notify();
  }

  private async loadHistory(): Promise<void> {
    try {
      const res = await fetch(
        `/api/price/history?minutes=${this.config.historyMinutes}&source=${this.config.priceSource}&lambda=${this.config.ewmaLambda}`,
        { headers: this.opts.getHeaders(), cache: 'no-store' }
      );
      if (!res.ok) throw new Error(`history ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = (await res.json()) as {
        bars: Bar[];
        vol: VolEstimate;
        interpolated: boolean;
        source: string;
        fetchMs: number;
      };

      this.bars = mergeBars(data.bars, this.bars);
      this.vol = data.vol;
      this.interpolatedFeed = data.interpolated;
      this.historyReady = data.bars.length >= 30;
      this.clearError('history');
      this.log(
        'info',
        'history',
        `Loaded ${data.bars.length} × ${BAR_SECONDS}s bars from ${data.source} in ${data.fetchMs}ms` +
          (data.interpolated ? ' (interpolated from 60s candles)' : '')
      );
    } catch (err) {
      this.historyReady = false;
      this.pushError('history', `Price history unavailable: ${message(err)}`);
      this.log('error', 'history', `History fetch failed: ${message(err)}`);
    }
    this.notify();
  }

  /** Recompute bars and volatility from the accumulated tape. */
  private rebuildBars(): void {
    if (this.ticks.length > 0) {
      const fromTicks = fillBarGaps(ticksToBars(this.ticks));
      this.bars = trimBars(mergeBars(this.bars, fromTicks), this.config.historyMinutes);
    }
    if (this.bars.length >= 6) {
      this.vol = estimateVolatility(this.bars, this.config.ewmaLambda);
    }
    this.notify();
  }

  private async pollMarket(): Promise<void> {
    if (!this.running) return;
    try {
      const res = await fetch('/api/market?books=false', {
        headers: this.opts.getHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`market ${res.status}`);
      const data = (await res.json()) as { market: BtcMarket | null; upcoming: BtcMarket[] };

      this.upcoming = data.upcoming ?? [];
      const next = data.market;
      const changed = next?.id !== this.market?.id;

      if (changed) {
        if (this.market) this.finaliseCycle(this.market);
        this.market = next;
        if (next) {
          this.books = {};
          this.bookFeed.setTokens(next.tokens.map((t) => t.tokenId));
          this.beginCycle(next);
        } else {
          this.cycle = { ...emptyCycle(), phase: 'awaiting-market' };
        }
      } else if (next) {
        // Refresh mutable fields (acceptingOrders can flip mid-window). The
        // cycle holds its own reference, so it has to be updated too or the
        // decision gate keeps reading the snapshot taken at the open.
        const merged = { ...this.market!, ...next };
        this.market = merged;
        if (this.cycle.market?.id === merged.id) this.cycle.market = merged;
      }
      this.clearError('market');
    } catch (err) {
      this.pushError('market', `Market discovery failed: ${message(err)}`);
    }
    this.notify();
  }

  private async pollChainlink(): Promise<void> {
    if (!this.running || !this.config.useChainlinkReference) return;
    try {
      const res = await fetch('/api/price/chainlink', {
        headers: this.opts.getHeaders(),
        cache: 'no-store',
      });
      if (!res.ok) return;
      const data = (await res.json()) as { chainlink: ChainlinkSnapshot | null };
      this.chainlink = data.chainlink;
      this.notify();
    } catch {
      /* the oracle read is advisory; never fail the loop on it */
    }
  }

  // ── Cycle state machine ───────────────────────────────────────────────────

  private beginCycle(market: BtcMarket): void {
    this.cycle = {
      ...emptyCycle(),
      market,
      phase: 'capturing-open',
    };
    this.log(
      'info',
      'cycle',
      `New window ${market.slug || market.id} — opens ${fmtTime(market.startMs)}, closes ${fmtTime(market.endMs)}`
    );
    this.captureStartPriceIfDue();
    this.notify(true);
  }

  /**
   * Capture the barrier: BTC's price at the instant the window opened.
   *
   * Accuracy here matters more than anywhere else in the system — every
   * probability produced downstream is a statement about this number. When the
   * window opened while we were already streaming, the tick nearest the open is
   * used and marked `observed`. When we joined mid-window, the closest bar
   * close is used and marked `estimated`, and the UI says so, because an
   * estimated barrier can be a dollar or two out and that is a real edge error.
   */
  private captureStartPriceIfDue(): void {
    const c = this.cycle;
    const market = c.market;
    if (!market || c.startPrice !== null) return;
    const now = Date.now();
    if (now < market.startMs) return; // Window has not opened yet.

    const observed = this.priceAt(market.startMs, 3000);
    if (observed !== null) {
      c.startPrice = observed;
      c.startPriceSource = 'observed';
    } else {
      const fallback = this.priceAt(market.startMs, 60_000) ?? this.lastPrice();
      if (fallback === null) return;
      c.startPrice = fallback;
      c.startPriceSource = 'estimated';
    }
    c.startPriceCapturedAt = now;

    this.log(
      'info',
      'cycle',
      `Barrier captured at $${c.startPrice.toFixed(2)} (${c.startPriceSource})`
    );

    void this.requestForecast();
  }

  /** Latest price at or before `t`, within `toleranceMs`. */
  private priceAt(t: number, toleranceMs: number): number | null {
    let best: PricePoint | null = null;
    if (this.latestTick && this.latestTick.t <= t) best = this.latestTick;
    for (let i = this.ticks.length - 1; i >= 0; i--) {
      const tick = this.ticks[i];
      if (tick.t <= t) {
        if (!best || tick.t > best.t) best = tick;
        break;
      }
    }
    if (best && t - best.t <= toleranceMs) return best.p;

    // Fall back to the bar covering that instant.
    const start = bucketStart(t);
    const bar = this.bars.find((b) => b.t === start);
    if (bar) return bar.c;
    return null;
  }

  private lastPrice(): number | null {
    return (
      this.latestTick?.p ?? this.ticks[this.ticks.length - 1]?.p ?? this.bars[this.bars.length - 1]?.c ?? null
    );
  }

  /**
   * Dispatch the forecast request and return immediately.
   *
   * Nothing awaits this on the hot path. The tick loop keeps running, the BTC
   * path keeps accumulating, and the response is folded in whenever it lands —
   * which is exactly the behaviour that makes the conditional update worth
   * doing rather than a re-statement of what the model already said.
   */
  private async requestForecast(): Promise<void> {
    const c = this.cycle;
    const market = c.market;
    if (!market || c.startPrice === null || c.llmDispatchedAt !== null) return;

    const current = this.lastPrice();
    if (current === null) return;

    c.phase = 'llm-pending';
    c.llmDispatchedAt = Date.now();
    c.llmPriceAtDispatch = current;
    c.pathDuringLlm = [];
    this.log('info', 'llm', `Requesting calibrated P(UP) — ${this.bars.length} bars sent`);
    this.notify(true);

    try {
      const res = await fetch('/api/llm/forecast', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.getHeaders() },
        body: JSON.stringify({
          startPrice: c.startPrice,
          currentPrice: current,
          windowStartMs: market.startMs,
          windowEndMs: market.endMs,
          bars: this.bars.slice(-380),
          historyMinutes: this.config.historyMinutes,
          source: this.config.priceSource,
          ewmaLambda: this.config.ewmaLambda,
        }),
      });

      const data = (await res.json()) as {
        forecast?: LlmResult;
        vol?: VolEstimate;
        error?: string;
      };

      // The market may have rolled over while we waited — discard a stale answer
      // rather than trading this window on the previous window's forecast.
      if (this.cycle.market?.id !== market.id) {
        this.log('warn', 'llm', 'Forecast arrived after window rollover — discarded');
        return;
      }

      if (!res.ok || !data.forecast) {
        this.cycle.llmError = data.error ?? `LLM request failed (${res.status})`;
        this.cycle.phase = 'monitoring';
        this.log('error', 'llm', this.cycle.llmError);
        this.pushError('llm', this.cycle.llmError);
        this.notify(true);
        return;
      }

      this.cycle.llm = data.forecast;
      this.cycle.llmError = null;
      if (data.vol) this.cycle.vol = data.vol;
      this.cycle.phase = 'monitoring';
      this.clearError('llm');

      const moved = current !== null ? (this.lastPrice() ?? current) - current : 0;
      this.log(
        'info',
        'llm',
        `P(UP) = ${(data.forecast.pUp * 100).toFixed(1)}% · confidence ${(data.forecast.confidence * 100).toFixed(0)}% · ${data.forecast.latencyMs}ms · BTC moved $${moved.toFixed(2)} while waiting`,
        { regime: data.forecast.regime, rationale: data.forecast.rationale }
      );

      // The conditional update runs the instant the forecast lands.
      this.runUpdate(true);
    } catch (err) {
      if (this.cycle.market?.id !== market.id) return;
      this.cycle.llmError = message(err);
      this.cycle.phase = 'monitoring';
      this.log('error', 'llm', `Forecast failed: ${message(err)}`);
      this.notify(true);
    }
  }

  /** Fires every 250ms: advance the clock, re-simulate, settle. */
  private tickLoop(): void {
    if (!this.running) return;
    const now = Date.now();
    const market = this.cycle.market;

    if (!market) {
      if (this.cycle.phase !== 'awaiting-market') {
        this.cycle = { ...emptyCycle(), phase: 'awaiting-market' };
        this.notify();
      }
      return;
    }

    this.captureStartPriceIfDue();

    if (now >= market.endMs) {
      if (this.cycle.phase !== 'settled') {
        this.cycle.phase = 'settling';
        this.settleWindow(market);
      }
      return;
    }

    // Re-simulate about once a second — enough to track a moving barrier
    // distance without burning the main thread on 20k paths at 4 Hz.
    if (now - this.lastMcAt >= 900) {
      this.runUpdate(false);
    }
  }

  /**
   * The conditional probability update.
   *
   * Runs continuously from the moment the window opens — before the LLM answers
   * it runs with a neutral 0.50 prior, so the dashboard always shows a live
   * volatility-based probability, and the LLM's contribution is visible as the
   * difference the moment it lands.
   */
  private runUpdate(force: boolean): void {
    const c = this.cycle;
    const market = c.market;
    const now = Date.now();
    if (!market || c.startPrice === null) return;

    const current = this.lastPrice();
    if (current === null) return;
    if (!force && now - this.lastMcAt < 900) return;
    this.lastMcAt = now;

    const elapsedSec = Math.max(0, (now - market.startMs) / 1000);
    const remainingSec = Math.max(0, (market.endMs - now) / 1000);
    const vol = this.vol ?? estimateVolatility(this.bars, this.config.ewmaLambda);
    this.cycle.vol = vol;

    const prior = c.llm?.pUp ?? 0.5;
    // With no forecast yet the drift is meaningless, so the prior gets no weight
    // and the simulation is a pure driftless random walk from here.
    const priorWeight = c.llm ? this.config.priorWeight * (0.5 + 0.5 * c.llm.confidence) : 0;

    const mc = runMonteCarlo({
      startPrice: c.startPrice,
      currentPrice: current,
      elapsedSec,
      remainingSec,
      priorPUp: prior,
      priorWeight,
      vol,
      recentReturns: logReturns(this.bars.slice(-200)),
      paths: this.config.mcPaths,
      engine: this.config.mcEngine,
      studentT: this.config.studentT,
      // Seed advances every run so successive updates are independent draws,
      // but is fully reproducible from (window, counter) for an audit.
      seed: hashSeed(market.id) + this.seedCounter++,
    });

    c.mc = mc;
    c.finalPUp = shrinkProbability(mc.pUp, this.config.probabilityShrink);

    const upToken = market.tokens.find((t) => t.side === 'UP');
    const upQuote = upToken ? quoteFromBook(this.books[upToken.tokenId] ?? null) : null;

    c.history.push({
      t: now,
      elapsed: elapsedSec,
      mc: mc.pUp,
      llm: c.llm?.pUp ?? null,
      marketUp: upQuote?.mid ?? null,
      btc: current,
    });
    if (c.history.length > MAX_PROB_POINTS) c.history = c.history.slice(-MAX_PROB_POINTS);

    this.considerTrade(market, current, now);
    this.notify();
  }

  /** Evaluate every gate and, if all pass, submit the order. */
  private considerTrade(market: BtcMarket, btc: number, now: number): void {
    const c = this.cycle;
    if (c.finalPUp === null) return;
    // Never trade a window on volatility alone — the LLM prior is a required
    // input, not an optional enrichment.
    if (!c.llm) return;
    if (c.tradeId) return;

    // Age of the *stalest* input, not the freshest: a live price feed must not
    // mask a frozen order book, which is exactly what taking the newest book
    // timestamp would do.
    const bookTimes = Object.values(this.books).map((b) => b.t);
    const tickAge = now - (this.latestTick?.t ?? 0);
    const bookAge = bookTimes.length > 0 ? now - Math.min(...bookTimes) : Number.POSITIVE_INFINITY;
    const dataAge = Math.max(tickAge, bookAge);

    const decisionLatency =
      c.llmDispatchedAt !== null ? now - c.llmDispatchedAt : 0;

    const decision = evaluate({
      config: this.config,
      market,
      books: this.books,
      pUp: c.finalPUp,
      pUpStdErr: c.mc?.standardError ?? 0,
      llmConfidence: c.llm.confidence,
      nowMs: now,
      dataAgeMs: Math.max(0, dataAge),
      decisionLatencyMs: decisionLatency,
      portfolio: this.portfolioState(),
    });

    c.decision = decision;
    c.decisionLatencyMs = decisionLatency;

    if (decision.trade && decision.best) {
      void this.execute(market, decision, btc);
    }
  }

  private portfolioState(): PortfolioState {
    const now = Date.now();
    const open = this.trades.filter((t) => t.status === 'OPEN' || t.status === 'PENDING');
    const dayStart = new Date(now).setHours(0, 0, 0, 0);
    const today = this.trades.filter((t) => t.t >= dayStart);
    const resolvedToday = today.filter((t) => t.status === 'WON' || t.status === 'LOST');

    let consecutive = 0;
    const resolved = this.trades.filter((t) => t.status === 'WON' || t.status === 'LOST');
    for (let i = resolved.length - 1; i >= 0; i--) {
      if (resolved[i].status === 'LOST') consecutive++;
      else break;
    }

    const realisedPnl = resolvedToday.reduce((s, t) => s + (t.pnl ?? 0), 0);

    return {
      openPositions: open.length,
      openMarketIds: open.map((t) => t.marketId),
      tradesLastHour: this.trades.filter((t) => now - t.t < 3_600_000).length,
      tradesToday: today.length,
      realisedPnlToday: realisedPnl,
      consecutiveLosses: consecutive,
      // Compound: risk limits should scale with the account, not with the
      // number the operator typed in at the start of the session.
      bankroll: Math.max(0, this.config.bankroll + realisedPnl),
    };
  }

  private async execute(market: BtcMarket, decision: Decision, btc: number): Promise<void> {
    const best = decision.best;
    const c = this.cycle;
    if (!best || c.tradeId) return;

    // Claim the slot synchronously so a second tick cannot double-submit while
    // the request is in flight.
    c.tradeId = 'pending';
    c.phase = 'positioned';

    this.log(
      'trade',
      'execution',
      `${this.config.mode}: buying ${decision.size} ${best.side} @ ${best.ask.toFixed(3)} — model ${(best.pWin * 100).toFixed(1)}%, edge ${(best.edge * 100).toFixed(1)}c`,
      { marketId: market.id, notional: decision.notional }
    );

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.getHeaders() },
        body: JSON.stringify({
          mode: this.config.mode,
          marketId: market.id,
          marketSlug: market.slug,
          tokenId: best.tokenId,
          side: best.side,
          size: decision.size,
          // Never pay more than the point where the edge is gone.
          limitPrice: Math.min(0.99, Math.max(best.ask, best.pWin - this.config.minEdge / 2)),
          tickSize: market.minTickSize,
          minOrderSize: market.minOrderSize,
          negRisk: market.negRisk,
          modelP: best.pWin,
          llmP: c.llm?.pUp ?? 0.5,
          marketP: best.ask,
          edge: best.edge,
          btcStart: c.startPrice ?? btc,
          btcEntry: btc,
          secondsLeftAtEntry: decision.secondsLeft,
        }),
      });

      const data = (await res.json()) as { trade?: Trade; error?: string };

      if (!res.ok || !data.trade) {
        c.tradeId = null;
        c.phase = 'monitoring';
        const msg = data.error ?? `order rejected (${res.status})`;
        this.log('warn', 'execution', `Order not filled: ${msg}`);
        this.notify(true);
        return;
      }

      this.trades = [...this.trades, data.trade];
      c.tradeId = data.trade.id;
      this.queuePersistTrade(data.trade);

      if (data.trade.status === 'FAILED') {
        this.log('error', 'execution', `Order failed: ${data.trade.error ?? 'unknown'}`);
        c.phase = 'monitoring';
      } else {
        this.log(
          'trade',
          'execution',
          `Filled ${data.trade.size} ${data.trade.side} @ ${data.trade.entryPrice.toFixed(4)} ($${data.trade.notional.toFixed(2)}) — slippage ${(data.trade.fill.slippage * 100).toFixed(2)}c`
        );
      }
      this.notify(true);
    } catch (err) {
      c.tradeId = null;
      c.phase = 'monitoring';
      this.log('error', 'execution', `Order error: ${message(err)}`);
      this.notify(true);
    }
  }

  /**
   * Settle the window against the observed BTC price at close.
   *
   * In PAPER mode this is the P&L. In LIVE mode it is our record of what should
   * happen; the on-chain resolution is authoritative and can differ if the
   * oracle print at the boundary differs from our feed, which is precisely why
   * the Chainlink basis is tracked and shown throughout the window.
   */
  private settleWindow(market: BtcMarket): void {
    const c = this.cycle;
    const settlePrice = this.priceAt(market.endMs, 15_000) ?? this.lastPrice();
    if (settlePrice === null || c.startPrice === null) {
      c.phase = 'settled';
      this.notify();
      return;
    }

    const outcome = settlePrice > c.startPrice ? 'UP' : 'DOWN';
    const move = settlePrice - c.startPrice;

    const updated: Trade[] = [];
    this.trades = this.trades.map((t) => {
      if (t.marketId !== market.id || (t.status !== 'OPEN' && t.status !== 'PENDING')) return t;
      const won = t.side === outcome;
      // A $1 contract bought at `entryPrice`: win pays $1, lose pays $0.
      const pnl = won ? t.size * (1 - t.entryPrice) : -t.size * t.entryPrice;
      const settled: Trade = {
        ...t,
        status: won ? 'WON' : 'LOST',
        pnl,
        btcSettle: settlePrice,
        resolvedAt: Date.now(),
        outcome,
      };
      updated.push(settled);
      return settled;
    });

    for (const t of updated) {
      this.queuePersistTrade(t);
      this.log(
        'trade',
        'settlement',
        `${t.status}: ${t.side} — BTC ${move >= 0 ? '+' : ''}$${move.toFixed(2)} → ${outcome}. P&L ${pnl(t)}`
      );
    }

    if (updated.length === 0) {
      this.log(
        'info',
        'settlement',
        `Window closed ${outcome} (BTC ${move >= 0 ? '+' : ''}$${move.toFixed(2)}) — no position taken`
      );
    }

    c.phase = 'settled';
    this.finaliseCycle(market, settlePrice, outcome);
    this.notify(true);
  }

  /** Freeze the cycle into the historical record. */
  private finaliseCycle(
    market: BtcMarket,
    settlePrice?: number,
    outcome?: 'UP' | 'DOWN'
  ): void {
    const c = this.cycle;
    if (!c.market || c.market.id !== market.id || c.startPrice === null) return;
    if (this.cycles.some((r) => r.marketId === market.id)) return;

    const btcEnd = settlePrice ?? this.priceAt(market.endMs, 30_000);
    const resolved =
      outcome ?? (btcEnd !== null ? (btcEnd > c.startPrice ? 'UP' : 'DOWN') : null);

    const upToken = market.tokens.find((t) => t.side === 'UP');
    const downToken = market.tokens.find((t) => t.side === 'DOWN');
    const upQuote = upToken ? quoteFromBook(this.books[upToken.tokenId] ?? null) : null;
    const downQuote = downToken ? quoteFromBook(this.books[downToken.tokenId] ?? null) : null;

    const trade = this.trades.find((t) => t.marketId === market.id) ?? null;

    const record: CycleRecord = {
      id: `${market.id}-${market.startMs}`,
      mode: this.config.mode,
      marketId: market.id,
      marketSlug: market.slug,
      question: market.question,
      startMs: market.startMs,
      endMs: market.endMs,
      btcStart: c.startPrice,
      btcEnd: btcEnd ?? null,
      outcome: resolved,
      llm: c.llm
        ? {
            pUp: c.llm.pUp,
            latencyMs: c.llm.latencyMs,
            confidence: c.llm.confidence,
            regime: c.llm.regime,
          }
        : null,
      mc: c.mc
        ? {
            pUp: c.mc.pUp,
            standardError: c.mc.standardError,
            computeMs: c.mc.computeMs,
            paths: c.mc.paths,
          }
        : null,
      vol: c.vol ? { sigmaPerSec: c.vol.sigmaPerSec, annualisedPct: c.vol.annualisedPct } : null,
      book: {
        bidUp: upQuote?.bid ?? null,
        askUp: upQuote?.ask ?? null,
        bidDown: downQuote?.bid ?? null,
        askDown: downQuote?.ask ?? null,
      },
      decision: c.decision
        ? {
            trade: c.decision.trade,
            side: c.decision.best?.side ?? null,
            edge: c.decision.best?.edge ?? null,
            reasons: c.decision.rejectReasons,
          }
        : null,
      tradeId: trade?.id ?? null,
      pnl: trade?.pnl ?? null,
      decisionLatencyMs: c.decisionLatencyMs,
    };

    this.cycles = [...this.cycles, record].slice(-500);
    this.pendingPersistCycles.set(record.id, record);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private queuePersistTrade(trade: Trade): void {
    this.pendingPersistTrades.set(trade.id, trade);
  }

  private async flushPersist(): Promise<void> {
    if (
      this.pendingPersistTrades.size === 0 &&
      this.pendingPersistCycles.size === 0 &&
      this.pendingPersistLogs.length === 0
    ) {
      return;
    }

    const payload = {
      trades: Array.from(this.pendingPersistTrades.values()),
      cycles: Array.from(this.pendingPersistCycles.values()),
      logs: this.pendingPersistLogs.slice(0, 200),
    };
    this.pendingPersistTrades.clear();
    this.pendingPersistCycles.clear();
    this.pendingPersistLogs = [];

    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.opts.getHeaders() },
        body: JSON.stringify(payload),
      });
      this.opts.onPersist?.(payload);
    } catch {
      // Persistence is an audit trail, not a dependency — the session keeps
      // trading if the write fails, and the next flush retries the new records.
    }
  }

  // ── Logging / errors ──────────────────────────────────────────────────────

  log(level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      t: Date.now(),
      level,
      scope,
      message: msg,
      data,
    };
    this.logs = [...this.logs, entry].slice(-MAX_LOGS);
    if (level === 'trade' || level === 'error' || level === 'warn') {
      this.pendingPersistLogs.push(entry);
    }
    this.notify();
  }

  private pushError(scope: string, msg: string): void {
    const tagged = `${scope}: ${msg}`;
    if (!this.errors.includes(tagged)) {
      this.errors = [...this.errors.filter((e) => !e.startsWith(`${scope}: `)), tagged];
    }
  }

  private clearError(scope: string): void {
    const next = this.errors.filter((e) => !e.startsWith(`${scope}: `));
    if (next.length !== this.errors.length) this.errors = next;
  }

  /** Manual override used by the dashboard's "force forecast" control. */
  forceForecast(): void {
    if (this.cycle.market && this.cycle.startPrice !== null) {
      this.cycle.llmDispatchedAt = null;
      void this.requestForecast();
    }
  }

  /** Recompute immediately, e.g. after a config change. */
  forceUpdate(): void {
    this.runUpdate(true);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function emptyCycle(): CycleState {
  return {
    market: null,
    phase: 'idle',
    startPrice: null,
    startPriceSource: null,
    startPriceCapturedAt: null,
    llm: null,
    llmError: null,
    llmDispatchedAt: null,
    llmPriceAtDispatch: null,
    pathDuringLlm: [],
    mc: null,
    finalPUp: null,
    vol: null,
    decision: null,
    tradeId: null,
    history: [],
    decisionLatencyMs: null,
  };
}

function idleStatus(source: string): FeedStatus {
  return { mode: 'disconnected', source, lastMessageAt: 0, reconnects: 0, error: null };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pnl(t: Trade): string {
  const v = t.pnl ?? 0;
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
}

/** Stable 32-bit hash so a window's simulations replay identically. */
function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export { WINDOW_SECONDS };
