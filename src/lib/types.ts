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

/** A BAR_SEC-second close. Only the close matters for what we do with it. */
export interface Bar {
  t: number; // bucket start, epoch ms, aligned to BAR_SEC
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

// ── The simulation ──────────────────────────────────────────────────────────

/**
 * The only model. A driftless Monte Carlo: no view is taken on direction, only
 * on how far realised volatility could plausibly carry the price in the time
 * left. Ignoring drift, there is no `pUpNeutral` control to compare against —
 * this run *is* the neutral one.
 */
export interface Simulation {
  /** Share of simulated paths finishing above the barrier. */
  pUp: number;
  /** Per-second volatility used, from the realised tape. */
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

/**
 * Where a captured price came from, most trustworthy (closest to what
 * Polymarket itself settles on) first. Always a genuine read — never
 * approximated. The first two are Polymarket's own settlement source
 * (Chainlink), consulted only for the barrier and the settlement close —
 * never for the continuous display tape, which is `binance`/`coingecko`.
 */
export type BarrierSource = 'chainlink-live' | 'chainlink-onchain' | 'binance' | 'coingecko';

/** One completed 5-minute window, traded or not. */
export interface WindowRecord {
  id: string;
  marketId: string;
  slug: string;
  startMs: number;
  endMs: number;
  barrier: number;
  barrierSource: BarrierSource;
  close: number | null;
  closeSource: BarrierSource | null;
  outcome: Side | null;
  /** The simulation's final read of P(UP), for calibration tracking. */
  finalPUp: number | null;
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
 * The whole configuration. Everything here is a thing an operator would
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
  /** Brier score of the simulation's final P(UP) across observed windows. */
  brier: number | null;
  scored: number;
}
