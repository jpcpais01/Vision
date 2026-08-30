import type {
  BookQuote,
  BtcMarket,
  Decision,
  EdgeAssessment,
  OrderBook,
  RejectReason,
  Side,
  TradingConfig,
} from '../types';
import { quoteFromBook, simulateBuy } from '../polymarket/clob';
import { clamp } from '../math/stats';

/**
 * Risk and edge evaluation.
 *
 * Deliberately pure and synchronous: the same function decides a paper trade, a
 * live trade and a replay of historical data, so there is exactly one place
 * where "should we trade this?" is answered. Every rejection is recorded with a
 * reason, because the interesting question after a session is usually not what
 * the system traded but what it declined and why.
 */

export interface PortfolioState {
  openPositions: number;
  /** Market ids we already hold, to avoid doubling up on one window. */
  openMarketIds: string[];
  tradesLastHour: number;
  tradesToday: number;
  realisedPnlToday: number;
  consecutiveLosses: number;
  bankroll: number;
}

export interface DecisionInput {
  config: TradingConfig;
  market: BtcMarket;
  books: Record<string, OrderBook | null>;
  /** Final model probability that the market resolves UP. */
  pUp: number;
  /** Standard error of pUp from the simulation, used to haircut the edge. */
  pUpStdErr: number;
  llmConfidence: number;
  nowMs: number;
  /** Age of the oldest input feeding this decision, ms. */
  dataAgeMs: number;
  /** Wall-clock ms spent producing the forecast. */
  decisionLatencyMs: number;
  portfolio: PortfolioState;
}

export function evaluate(input: DecisionInput): Decision {
  const { config, market, books, nowMs, portfolio } = input;
  const secondsLeft = (market.endMs - nowMs) / 1000;
  const reasons = new Set<RejectReason>();

  const assessments: EdgeAssessment[] = [];
  for (const token of market.tokens) {
    const book = books[token.tokenId] ?? null;
    const quote = quoteFromBook(book);
    const assessment = assess(token.side, token.tokenId, quote, input);
    if (assessment) assessments.push(assessment);
  }

  assessments.sort((a, b) => b.edge - a.edge);
  const best = assessments[0] ?? null;

  // ── Gates that apply regardless of which side looks good ────────────────
  if (config.killSwitch) reasons.add('kill-switch');
  if (!config.autoTrade) reasons.add('mode-disabled');
  if (!market.acceptingOrders || market.closed) reasons.add('no-market');
  if (assessments.length === 0) reasons.add('no-book');
  if (secondsLeft < config.minSecondsLeft) reasons.add('too-late');
  if (secondsLeft > config.maxSecondsLeft) reasons.add('too-early');
  if (input.dataAgeMs > config.maxDataAgeMs) reasons.add('stale-data');
  if (input.decisionLatencyMs > config.maxDecisionLatencyMs) reasons.add('latency-budget');
  if (input.llmConfidence < config.minLlmConfidence) reasons.add('low-confidence');

  // ── Portfolio-level limits ──────────────────────────────────────────────
  if (portfolio.openPositions >= config.maxConcurrentPositions) {
    reasons.add('max-open-positions');
  }
  if (portfolio.openMarketIds.includes(market.id)) reasons.add('already-in-market');
  if (portfolio.tradesLastHour >= config.maxTradesPerHour) reasons.add('trade-rate-limit');
  if (portfolio.tradesToday >= config.maxDailyTrades) reasons.add('trade-rate-limit');
  if (portfolio.realisedPnlToday <= -Math.abs(config.maxDailyLossUsd)) {
    reasons.add('daily-loss-limit');
  }
  if (portfolio.consecutiveLosses >= config.stopAfterConsecutiveLosses) {
    reasons.add('daily-loss-limit');
  }
  if (portfolio.bankroll < 1) reasons.add('bankroll-too-small');

  // ── Gates that depend on the chosen side ────────────────────────────────
  let size = 0;
  let notional = 0;

  if (best) {
    if (best.edge < config.minEdge) reasons.add('insufficient-edge');
    if (best.edgeRatio < config.minEdgeRatio) reasons.add('insufficient-edge');
    if (best.spread === null || best.spread > config.maxSpread) reasons.add('spread-too-wide');
    if (best.askSize < config.minTopOfBookShares) reasons.add('insufficient-liquidity');
    if (best.ask < config.minPrice || best.ask > config.maxPrice) {
      reasons.add('price-out-of-bounds');
    }

    const book = books[best.tokenId] ?? null;
    const quote = quoteFromBook(book);
    if (quote.askDepthUsd < config.minDepthUsd) reasons.add('insufficient-liquidity');

    // Size from fractional Kelly, then hard-capped. Kelly on a binary bought at
    // `ask` with win probability `pWin` is (pWin - ask) / (1 - ask); the
    // configured fraction is applied on top because Kelly assumes the
    // probability is exactly right, and ours is an estimate with real error.
    const kellyUsd = portfolio.bankroll * best.kellyFraction * config.kellyFraction;
    const capUsd = Math.min(
      config.maxPositionUsd,
      portfolio.bankroll * config.maxPositionPctBankroll,
      portfolio.bankroll
    );
    notional = Math.max(0, Math.min(kellyUsd, capUsd));
    size = best.ask > 0 ? Math.floor(notional / best.ask) : 0;

    // Do not consume more than a third of the resting depth at the touch —
    // beyond that the fill price is no longer the price we assessed.
    size = Math.min(size, Math.floor(best.askSize));
    notional = size * best.ask;

    if (size < market.minOrderSize || notional < 1) reasons.add('size-below-minimum');
  }

  const rejectReasons = Array.from(reasons);

  return {
    t: nowMs,
    marketId: market.id,
    best,
    alternatives: assessments.slice(1),
    trade: rejectReasons.length === 0 && best !== null && size > 0,
    rejectReasons,
    size,
    notional,
    secondsLeft,
    dataAgeMs: input.dataAgeMs,
  };
}

function assess(
  side: Side,
  tokenId: string,
  quote: BookQuote,
  input: DecisionInput
): EdgeAssessment | null {
  if (quote.ask === null) return null;

  const pUpRaw = clamp(input.pUp, 0, 1);
  const pWinRaw = side === 'UP' ? pUpRaw : 1 - pUpRaw;

  // Haircut the probability by one standard error *against* us. Monte Carlo
  // noise should never manufacture an edge, so the estimate is always pushed
  // toward the side that makes the trade look worse.
  const pWin = clamp(pWinRaw - input.pUpStdErr, 0, 1);

  const ask = quote.ask;
  const edge = pWin - ask;

  // Kelly fraction of bankroll for a $1-payout binary bought at `ask`.
  const kellyFraction = ask < 1 ? Math.max(0, (pWin - ask) / (1 - ask)) : 0;

  return {
    side,
    tokenId,
    pWin,
    ask,
    bid: quote.bid,
    spread: quote.spread,
    edge,
    edgeRatio: ask > 0 ? edge / ask : 0,
    askSize: quote.askSize,
    kellyFraction,
  };
}

/**
 * Shrink a raw model probability toward 0.5 before it is used for sizing.
 *
 * Every stage of this pipeline — the LLM, the vol estimate, the simulation —
 * adds error that biases probabilities away from the centre. Shrinking is the
 * cheapest available correction and it costs almost nothing when the model is
 * right, because it only removes edge from the trades that were marginal.
 */
export function shrinkProbability(p: number, shrink: number): number {
  const s = clamp(shrink, 0, 0.9);
  return 0.5 + (clamp(p, 0, 1) - 0.5) * (1 - s);
}

/** Human-readable rejection text for the dashboard. */
export const REJECT_LABELS: Record<RejectReason, string> = {
  'no-market': 'No open market',
  'no-book': 'No order book',
  'kill-switch': 'Kill switch engaged',
  'mode-disabled': 'Auto-trading off',
  'insufficient-edge': 'Edge below threshold',
  'spread-too-wide': 'Spread too wide',
  'insufficient-liquidity': 'Not enough liquidity',
  'price-out-of-bounds': 'Price outside bounds',
  'too-early': 'Too early in window',
  'too-late': 'Too late in window',
  'stale-data': 'Data too stale',
  'latency-budget': 'Latency budget exceeded',
  'max-open-positions': 'Max open positions',
  'already-in-market': 'Already positioned here',
  'daily-loss-limit': 'Daily loss limit hit',
  'trade-rate-limit': 'Trade rate limit',
  'bankroll-too-small': 'Bankroll too small',
  'size-below-minimum': 'Size below minimum',
  'low-confidence': 'LLM confidence too low',
};

/** Price a paper fill against the live book. Re-exported for the engine. */
export { simulateBuy };
