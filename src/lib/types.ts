// ─────────────────────────────────────────────────────────────────────────────
// Shared types. Deliberately small — if a field is not read by the UI or the
// trading decision, it does not belong here.
// ─────────────────────────────────────────────────────────────────────────────

/** One price observation. */
export interface Tick {
  t: number; // epoch ms
  p: number; // USD
}

export interface Book {
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  t: number;
}

// ── Strategies ───────────────────────────────────────────────────────────────

/** Each strategy runs as its own independent bot: own config, own positions, own P&L. */
export type StrategyId = 'reversion' | 'momentum';

// ── The simulation ──────────────────────────────────────────────────────────

/** LONG expects price to climb, SHORT expects it to fall. */
export type Direction = 'LONG' | 'SHORT';

export type PositionStatus = 'OPEN' | 'CLOSED';

export interface Position {
  id: string;
  strategyId: StrategyId;
  cycleId: string;
  direction: Direction;
  qty: number; // BTC
  openedAt: number;
  openPrice: number;
  /** Notional exposure is stakeUsd * leverage — captured at entry, so a later
   *  change to the bot's own leverage setting can't retroactively relabel an
   *  already-open position. */
  leverage: number;
  /** The tail probability that triggered this entry. */
  triggerProb: number;
  /** When this cycle forces the position closed, regardless of price. */
  closesAt: number;
  status: PositionStatus;
  closedAt: number | null;
  closePrice: number | null;
  pnl: number | null;
}

/** One completed cycle, traded or not. */
export interface CycleRecord {
  id: string;
  strategyId: StrategyId;
  startMs: number;
  endMs: number;
  startPrice: number;
  sigma: number;
  volPct: number;
  traded: boolean;
  pnl: number | null;
}

export interface LogLine {
  id: string;
  t: number;
  level: 'info' | 'warn' | 'error' | 'trade';
  message: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface Config {
  autoTrade: boolean;
  killSwitch: boolean;
  /** Force-close any open position at this many seconds into the cycle. */
  closeAtSecond: number;
  /** Flag a trade when the live price's tail probability drops below this. */
  unlikeliness: number;
  /** Fixed USD margin per position — the notional exposure is this times leverage. */
  stakeUsd: number;
  /** Multiplies the position's notional exposure. Margin is never modelled as a
   *  constraint (no liquidation), so a higher multiplier only ever scales P&L,
   *  in both directions, never gets a position force-closed early. */
  leverage: number;
}

export interface Stats {
  positions: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  pnl: number;
  today: number;
  cycles: number;
}
