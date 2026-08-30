import type { TradingConfig } from './types';

/**
 * Defaults are deliberately conservative: PAPER mode, auto-trading off, and
 * edge/liquidity gates tight enough that the engine sits on its hands most of
 * the time. Everything here is overridable from the dashboard at runtime.
 */
export const DEFAULT_CONFIG: TradingConfig = {
  mode: 'PAPER',
  autoTrade: false,
  killSwitch: false,

  // A 5-minute coin flip is close to 50/50, so realistic edges are small.
  // 4 cents of edge on a ~50c contract is an 8% return on capital.
  minEdge: 0.04,
  minEdgeRatio: 0.06,
  maxSpread: 0.04,
  minTopOfBookShares: 25,
  minDepthUsd: 50,
  minPrice: 0.06,
  maxPrice: 0.94,
  minLlmConfidence: 0.25,

  // Trade in the middle of the window: early enough that the outcome is still
  // uncertain, late enough that we have realised path information.
  minSecondsLeft: 45,
  maxSecondsLeft: 260,
  maxDataAgeMs: 4000,
  // Maximum acceptable *round trip* for the forecast. A model that took longer
  // than this was reading a stale tape by the time it answered, so the window
  // is observed but not traded. Sits below llmTimeoutMs on purpose: the request
  // is allowed to complete, and is then judged on how long it took.
  maxDecisionLatencyMs: 15_000,
  llmTimeoutMs: 20_000,

  bankroll: 1000,
  kellyFraction: 0.25,
  maxPositionUsd: 50,
  maxPositionPctBankroll: 0.05,
  maxConcurrentPositions: 1,
  maxTradesPerHour: 8,
  maxDailyLossUsd: 150,
  maxDailyTrades: 40,
  stopAfterConsecutiveLosses: 5,

  mcPaths: 20000,
  mcEngine: 'blend',
  studentT: 4,
  priorWeight: 0.8,
  probabilityShrink: 0.1,
  ewmaLambda: 0.97,
  historyMinutes: 60,

  priceSource: 'binance',
  useChainlinkReference: true,
};

/** Bounds enforced on every config write, server- and client-side. */
export const CONFIG_BOUNDS: Record<string, { min: number; max: number }> = {
  minEdge: { min: 0.005, max: 0.5 },
  minEdgeRatio: { min: 0, max: 2 },
  maxSpread: { min: 0.001, max: 0.5 },
  minTopOfBookShares: { min: 1, max: 100000 },
  minDepthUsd: { min: 1, max: 1000000 },
  minPrice: { min: 0.01, max: 0.5 },
  maxPrice: { min: 0.5, max: 0.99 },
  minLlmConfidence: { min: 0, max: 1 },
  minSecondsLeft: { min: 5, max: 290 },
  maxSecondsLeft: { min: 10, max: 300 },
  maxDataAgeMs: { min: 500, max: 60000 },
  maxDecisionLatencyMs: { min: 1000, max: 120000 },
  llmTimeoutMs: { min: 5000, max: 55_000 },
  bankroll: { min: 1, max: 10000000 },
  kellyFraction: { min: 0.01, max: 1 },
  maxPositionUsd: { min: 1, max: 100000 },
  maxPositionPctBankroll: { min: 0.001, max: 1 },
  maxConcurrentPositions: { min: 1, max: 20 },
  maxTradesPerHour: { min: 1, max: 200 },
  maxDailyLossUsd: { min: 1, max: 1000000 },
  maxDailyTrades: { min: 1, max: 1000 },
  stopAfterConsecutiveLosses: { min: 1, max: 100 },
  mcPaths: { min: 1000, max: 200000 },
  studentT: { min: 0, max: 100 },
  priorWeight: { min: 0, max: 1 },
  probabilityShrink: { min: 0, max: 0.9 },
  ewmaLambda: { min: 0.8, max: 0.999 },
  historyMinutes: { min: 5, max: 180 },
};

const NUMERIC_KEYS = Object.keys(CONFIG_BOUNDS);
const BOOLEAN_KEYS = ['autoTrade', 'killSwitch', 'useChainlinkReference'];

/**
 * Merge an untrusted partial config over a base, clamping numbers into their
 * documented bounds and dropping anything unrecognised.
 */
export function sanitizeConfig(
  patch: unknown,
  base: TradingConfig = DEFAULT_CONFIG
): TradingConfig {
  const out: TradingConfig = { ...base };
  if (!patch || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;

  for (const key of NUMERIC_KEYS) {
    const raw = p[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const b = CONFIG_BOUNDS[key];
    (out as unknown as Record<string, number>)[key] = Math.min(b.max, Math.max(b.min, raw));
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof p[key] === 'boolean') {
      (out as unknown as Record<string, boolean>)[key] = p[key] as boolean;
    }
  }
  if (p.mode === 'PAPER' || p.mode === 'LIVE') out.mode = p.mode;
  if (p.mcEngine === 'gbm' || p.mcEngine === 'bootstrap' || p.mcEngine === 'blend') {
    out.mcEngine = p.mcEngine;
  }
  if (
    p.priceSource === 'binance' ||
    p.priceSource === 'coinbase' ||
    p.priceSource === 'kraken'
  ) {
    out.priceSource = p.priceSource;
  }

  // Cross-field invariants.
  if (out.maxPrice <= out.minPrice) out.maxPrice = Math.min(0.99, out.minPrice + 0.1);
  if (out.maxSecondsLeft <= out.minSecondsLeft) {
    out.maxSecondsLeft = Math.min(300, out.minSecondsLeft + 30);
  }
  out.maxPositionUsd = Math.min(out.maxPositionUsd, out.bankroll);

  return out;
}

/** Length of a Polymarket BTC up/down window, in seconds. */
export const WINDOW_SECONDS = 300;
/** Bucket size for the price history sent to the LLM, in seconds. */
export const BAR_SECONDS = 10;
