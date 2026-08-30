// ─────────────────────────────────────────────────────────────────────────────
// Shared domain types. This file is imported from both server routes and client
// components, so it must stay free of any Node-only or DOM-only references.
// ─────────────────────────────────────────────────────────────────────────────

export type Mode = 'PAPER' | 'LIVE';

export type Side = 'UP' | 'DOWN';

/** A single spot observation of BTC. */
export interface PricePoint {
  /** Unix epoch milliseconds of the observation. */
  t: number;
  /** Price in USD. */
  p: number;
}

/** A 10-second OHLC bucket built from raw ticks or 1s klines. */
export interface Bar {
  /** Bucket start, epoch ms, aligned to a 10s boundary. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Base-asset volume when the source provides it, else 0. */
  v: number;
}

export type PriceSourceName = 'binance' | 'coinbase' | 'kraken' | 'chainlink';

export interface PriceSnapshot {
  price: number;
  t: number;
  source: PriceSourceName;
  /** Round-trip latency of the fetch that produced this snapshot, ms. */
  latencyMs: number;
}

export interface ChainlinkSnapshot {
  price: number;
  /** Chainlink round id, as a decimal string (uint80 does not fit in a number). */
  roundId: string;
  /** On-chain updatedAt, epoch ms. */
  updatedAt: number;
  /** Age of the on-chain answer at fetch time, ms. */
  ageMs: number;
  decimals: number;
  feed: string;
  chain: string;
}

// ── Polymarket ──────────────────────────────────────────────────────────────

export interface MarketToken {
  tokenId: string;
  outcome: string;
  /** Normalised mapping of the raw outcome string onto our UP/DOWN axis. */
  side: Side;
}

export interface BtcMarket {
  /** Gamma market id. */
  id: string;
  slug: string;
  question: string;
  conditionId: string;
  /** Window open, epoch ms. */
  startMs: number;
  /** Window close / resolution, epoch ms. */
  endMs: number;
  tokens: MarketToken[];
  minTickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  acceptingOrders: boolean;
  closed: boolean;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  /** Descending by price. */
  bids: BookLevel[];
  /** Ascending by price. */
  asks: BookLevel[];
  /** Epoch ms the book was captured client-side. */
  t: number;
  /** Exchange-reported hash, when available. */
  hash?: string;
}

export interface BookQuote {
  bid: number | null;
  ask: number | null;
  bidSize: number;
  askSize: number;
  mid: number | null;
  spread: number | null;
  /** Notional available inside `depthCents` of the touch, in USD. */
  bidDepthUsd: number;
  askDepthUsd: number;
}

// ── LLM ─────────────────────────────────────────────────────────────────────

export interface LlmForecast {
  /** Calibrated P(UP) in [0,1] as returned by the model. */
  pUp: number;
  /** Model's own 0-1 confidence in its estimate; drives prior weight. */
  confidence: number;
  /** Model's expected absolute move over the remaining window, in USD. */
  expectedMoveUsd: number | null;
  /** Short free-text justification. */
  rationale: string;
  /** Structured drivers the model says it keyed on. */
  keyFactors: string[];
  /** Model's read of the near-term regime. */
  regime: 'trending-up' | 'trending-down' | 'mean-reverting' | 'choppy' | 'unknown';
}

export interface LlmResult extends LlmForecast {
  model: string;
  /** Wall-clock time from request start to parsed response, ms. */
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  /** BTC price and time at the moment the request was dispatched. */
  requestedAt: number;
  requestPrice: number;
  raw: string;
}

// ── Monte Carlo ─────────────────────────────────────────────────────────────

export interface VolEstimate {
  /** Per-second volatility of log returns. */
  sigmaPerSec: number;
  /** Same estimate annualised (365d), for human display. */
  annualisedPct: number;
  /** Standard deviation of a single 10s log return. */
  sigma10s: number;
  /** Excess kurtosis of the sampled 10s returns. */
  excessKurtosis: number;
  /** Number of returns behind the estimate. */
  samples: number;
  /** Per-window realised vols (per-second) used in the blend. */
  windows: { label: string; sigmaPerSec: number; samples: number }[];
  method: 'ewma-blend';
}

export interface MonteCarloInput {
  /** Price the market settles against — captured at window open. */
  startPrice: number;
  /** Latest observed price. */
  currentPrice: number;
  /** Seconds already elapsed in the 5-minute window. */
  elapsedSec: number;
  /** Seconds left until resolution. */
  remainingSec: number;
  /** Prior P(UP) from the LLM. */
  priorPUp: number;
  /** Weight applied to the prior drift, 0 = driftless, 1 = full prior. */
  priorWeight: number;
  vol: VolEstimate;
  /** Realised 10s log returns used by the bootstrap engine. */
  recentReturns: number[];
  paths: number;
  engine: 'gbm' | 'bootstrap' | 'blend';
  /** Student-t degrees of freedom for the GBM engine; <= 0 disables fat tails. */
  studentT: number;
  seed: number;
}

export interface MonteCarloResult {
  /** Share of simulated paths finishing strictly above `startPrice`. */
  pUp: number;
  /** ±1 standard error of `pUp` from the simulation itself. */
  standardError: number;
  /** Terminal price quantiles. */
  quantiles: { q05: number; q25: number; q50: number; q75: number; q95: number };
  /** Distance to the barrier in units of remaining-horizon sigma. */
  moneynessSigma: number;
  paths: number;
  engine: string;
  computeMs: number;
  /** Prior that seeded the drift, echoed for the UI. */
  priorPUp: number;
  /** Drift per second implied by the prior. */
  driftPerSec: number;
  /** Histogram of terminal prices for the UI, 41 buckets. */
  histogram: { edges: number[]; counts: number[] };
}

// ── Decision / execution ────────────────────────────────────────────────────

export type RejectReason =
  | 'no-market'
  | 'no-book'
  | 'kill-switch'
  | 'mode-disabled'
  | 'insufficient-edge'
  | 'spread-too-wide'
  | 'insufficient-liquidity'
  | 'price-out-of-bounds'
  | 'too-early'
  | 'too-late'
  | 'stale-data'
  | 'latency-budget'
  | 'max-open-positions'
  | 'already-in-market'
  | 'daily-loss-limit'
  | 'trade-rate-limit'
  | 'bankroll-too-small'
  | 'size-below-minimum'
  | 'low-confidence';

export interface EdgeAssessment {
  side: Side;
  tokenId: string;
  /** Model probability that this side wins. */
  pWin: number;
  /** Executable ask for this side. */
  ask: number;
  bid: number | null;
  spread: number | null;
  /** pWin - ask, in probability units (== $ per share). */
  edge: number;
  /** edge / ask — return on capital if it resolves in our favour. */
  edgeRatio: number;
  /** Size available at the touch, in shares. */
  askSize: number;
  /** Kelly-optimal fraction of bankroll, before caps. */
  kellyFraction: number;
}

export interface Decision {
  t: number;
  marketId: string;
  /** Best side by edge, even when we do not trade it. */
  best: EdgeAssessment | null;
  alternatives: EdgeAssessment[];
  trade: boolean;
  rejectReasons: RejectReason[];
  /** Shares we intend to buy. */
  size: number;
  /** Total USD at risk. */
  notional: number;
  secondsLeft: number;
  /** Age of the freshest input that fed this decision, ms. */
  dataAgeMs: number;
}

export type TradeStatus = 'PENDING' | 'OPEN' | 'WON' | 'LOST' | 'CANCELLED' | 'FAILED';

export interface Trade {
  id: string;
  mode: Mode;
  marketId: string;
  marketSlug: string;
  tokenId: string;
  side: Side;
  /** Epoch ms the order was submitted. */
  t: number;
  /** Price we paid per share. */
  entryPrice: number;
  size: number;
  notional: number;
  /** Our probability at entry. */
  modelP: number;
  /** LLM's raw probability at entry. */
  llmP: number;
  /** Market-implied probability (the ask we lifted). */
  marketP: number;
  edge: number;
  status: TradeStatus;
  /** Realised P&L in USD once resolved. */
  pnl: number | null;
  /** BTC price when the window opened. */
  btcStart: number;
  /** BTC price at entry. */
  btcEntry: number;
  /** BTC price at resolution. */
  btcSettle: number | null;
  resolvedAt: number | null;
  /** Outcome of the market, independent of which side we took. */
  outcome: Side | null;
  secondsLeftAtEntry: number;
  /** Order id returned by the CLOB in LIVE mode. */
  orderId: string | null;
  /** Fill detail from the exchange, or the simulated fill model in PAPER. */
  fill: FillReport;
  error?: string;
}

export interface FillReport {
  simulated: boolean;
  requestedSize: number;
  filledSize: number;
  /** Size-weighted average price actually paid. */
  avgPrice: number;
  /** avgPrice - touch, in probability units. */
  slippage: number;
  /** Levels consumed, for the paper walk-the-book model. */
  levels: BookLevel[];
  latencyMs: number;
}

// ── Session / metrics ───────────────────────────────────────────────────────

export interface Metrics {
  trades: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number;
  pnl: number;
  /** Sum of notional deployed across resolved trades. */
  turnover: number;
  roi: number;
  avgEdge: number;
  /** Mean (p - outcome)^2 over resolved trades. */
  brier: number;
  /** Brier of a constant 0.5 forecaster on the same set. */
  brierBaseline: number;
  /** 1 - brier/brierBaseline. */
  brierSkill: number;
  /** Mean forecast minus realised frequency. */
  calibrationError: number;
  logLoss: number;
  maxDrawdown: number;
  sharpe: number;
  bestTrade: number;
  worstTrade: number;
  currentStreak: number;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  n: number;
  meanForecast: number;
  observedFreq: number;
}

/** One completed 5-minute market as observed by the engine, traded or not. */
export interface CycleRecord {
  id: string;
  mode: Mode;
  marketId: string;
  marketSlug: string;
  question: string;
  startMs: number;
  endMs: number;
  btcStart: number;
  btcEnd: number | null;
  outcome: Side | null;
  llm: { pUp: number; latencyMs: number; confidence: number; regime: string } | null;
  mc: { pUp: number; standardError: number; computeMs: number; paths: number } | null;
  vol: { sigmaPerSec: number; annualisedPct: number } | null;
  book: { bidUp: number | null; askUp: number | null; bidDown: number | null; askDown: number | null } | null;
  decision: { trade: boolean; side: Side | null; edge: number | null; reasons: RejectReason[] } | null;
  tradeId: string | null;
  pnl: number | null;
  /** Wall-clock ms from window open to a completed decision. */
  decisionLatencyMs: number | null;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'trade';

export interface LogEntry {
  id: string;
  t: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface TradingConfig {
  mode: Mode;
  /** Master on/off for automated order submission. */
  autoTrade: boolean;
  /** Hard stop. When true nothing is submitted in either mode. */
  killSwitch: boolean;

  // Edge / quality gates
  minEdge: number;
  minEdgeRatio: number;
  maxSpread: number;
  minTopOfBookShares: number;
  minDepthUsd: number;
  minPrice: number;
  maxPrice: number;
  minLlmConfidence: number;

  // Timing gates
  minSecondsLeft: number;
  maxSecondsLeft: number;
  maxDataAgeMs: number;
  maxDecisionLatencyMs: number;
  /** Total budget for the LLM call, across all retry attempts. */
  llmTimeoutMs: number;

  // Sizing / risk
  bankroll: number;
  kellyFraction: number;
  maxPositionUsd: number;
  maxPositionPctBankroll: number;
  maxConcurrentPositions: number;
  maxTradesPerHour: number;
  maxDailyLossUsd: number;
  maxDailyTrades: number;
  stopAfterConsecutiveLosses: number;

  // Model knobs
  mcPaths: number;
  mcEngine: 'gbm' | 'bootstrap' | 'blend';
  studentT: number;
  priorWeight: number;
  /** Shrink the final probability toward 0.5 by this fraction. */
  probabilityShrink: number;
  ewmaLambda: number;
  historyMinutes: number;

  // Feed
  priceSource: PriceSourceName;
  useChainlinkReference: boolean;
}
