// ─────────────────────────────────────────────────────────────────────────────
// Shared types. Deliberately small — if a field is not read by the UI or the
// trading decision, it does not belong here.
// ─────────────────────────────────────────────────────────────────────────────

export type Mode = 'PAPER' | 'LIVE';
export type Side = 'UP' | 'DOWN';

/** One price observation. */
export interface Tick {
  t: number; // epoch ms
  p: number; // USD
}

/** A 10-second close. Only the close matters for what we do with it. */
export interface Bar {
  t: number; // bucket start, epoch ms, aligned to 10s
  c: number;
}

// ── Market ──────────────────────────────────────────────────────────────────

export interface MarketToken {
  tokenId: string;
  side: Side;
}

export interface Market {
  id: string;
  slug: string;
  question: string;
  startMs: number;
  endMs: number;
  tokens: MarketToken[];
  minTickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  acceptingOrders: boolean;
}

export interface Quote {
  bid: number | null;
  ask: number | null;
  askSize: number;
}

export interface Book {
  tokenId: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  t: number;
}

// ── The forecast ────────────────────────────────────────────────────────────

/**
 * What we ask the model for, and all we ask it for: a direction, and how
 * likely it thinks that direction is.
 */
export interface Forecast {
  side: Side;
  /** Probability that `side` wins, 0..1. Always >= 0.5 by construction. */
  probability: number;
  /** Probability that the market resolves UP, derived from the two above. */
  pUp: number;
  latencyMs: number;
  model: string;
  /** Price at the moment the request was sent. */
  priceAtRequest: number;
  raw: string;
}

// ── The simulation ──────────────────────────────────────────────────────────

export interface Simulation {
  /** Probability the market resolves UP, given everything realised so far. */
  pUp: number;
  /** The same run with a neutral 50/50 prior — the "does the LLM help?" control. */
  pUpNeutral: number;
  /** Per-second volatility used. */
  sigma: number;
  /** Annualised, for display. */
  volPct: number;
  paths: number;
  computeMs: number;
}

// ── Trading ─────────────────────────────────────────────────────────────────

export type TradeStatus = 'OPEN' | 'WON' | 'LOST' | 'FAILED';

export interface Trade {
  id: string;
  mode: Mode;
  marketId: string;
  marketSlug: string;
  tokenId: string;
  side: Side;
  t: number;
  price: number;
  shares: number;
  cost: number;
  /** Our probability at entry. */
  ourProb: number;
  /** What the market was charging at entry. */
  marketProb: number;
  edge: number;
  status: TradeStatus;
  pnl: number | null;
  barrier: number;
  settlePrice: number | null;
  outcome: Side | null;
  error?: string;
}

/** One completed 5-minute window, traded or not. */
export interface WindowRecord {
  id: string;
  marketId: string;
  slug: string;
  startMs: number;
  endMs: number;
  barrier: number;
  close: number | null;
  outcome: Side | null;
  /** What the model called at the open. */
  llmSide: Side | null;
  llmProb: number | null;
  llmLatencyMs: number | null;
  /** Final simulated probability of UP, and the neutral-prior control. */
  finalPUp: number | null;
  finalPUpNeutral: number | null;
  traded: boolean;
  pnl: number | null;
  /** Why we did not trade, in one phrase. */
  skipReason: string | null;
}

export interface LogLine {
  id: string;
  t: number;
  level: 'info' | 'warn' | 'error' | 'trade';
  message: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * The whole configuration. Nine settings, all of them things an operator would
 * actually want to change.
 */
export interface Config {
  mode: Mode;
  autoTrade: boolean;
  killSwitch: boolean;
  /** Trade when our probability beats the ask by more than this. */
  minEdge: number;
  /** Fixed USD per trade. */
  stakeUsd: number;
  /** Stop trading for the day after losing this much. */
  maxDailyLossUsd: number;
  /** Do not enter with less than this on the clock. */
  minSecondsLeft: number;
  /** Monte Carlo paths per run. */
  paths: number;
  /** How much of the model's opinion to apply, 0..1. */
  llmWeight: number;
}

export interface Stats {
  trades: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  pnl: number;
  today: number;
  /** Windows observed. */
  windows: number;
  /** Brier of the simulation with the LLM prior, and without it. */
  brierWithLlm: number | null;
  brierNeutral: number | null;
  /** How often the model's direction call was right. */
  llmAccuracy: number | null;
  scored: number;
}
