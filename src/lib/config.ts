import type { Config } from './types';

/** The whole strategy runs on fixed 20-second slots of the wall clock — :00, :20, :40. */
export const CYCLE_SEC = 20;
/** How many trailing one-second price points feed the volatility estimate. */
export const HISTORY_SEC = 60;
/** Monte Carlo paths per cycle. Fixed, not a setting. */
export const PATHS = 1_000;

export const SYMBOL = 'BTCUSDT';

/**
 * Binance USD-M futures, not spot. Spot cannot sell short without borrowed
 * margin — a real SHORT position, symmetric with LONG, needs a market that
 * actually supports both, so every fetch below is against the futures book,
 * not spot's.
 */
export const FUTURES_WS = 'wss://fstream.binance.com';
export const FUTURES_REST = 'https://fapi.binance.com';

export const DEFAULT_CONFIG: Config = {
  autoTrade: false,
  killSwitch: false,
  closeAtSecond: 19,
  unlikeliness: 0.1, // trade when the model gives the current move less than a 10% chance
  stakeUsd: 20,
};

const BOUNDS = {
  closeAtSecond: [1, CYCLE_SEC - 1],
  unlikeliness: [0.01, 0.4],
  stakeUsd: [1, 10_000],
} as const;

/** Clamp an untrusted patch into range. Applied on every write, server-side too. */
export function sanitize(patch: unknown, base: Config = DEFAULT_CONFIG): Config {
  const out = { ...base };
  if (!patch || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;

  for (const [key, [lo, hi]] of Object.entries(BOUNDS)) {
    const v = p[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      (out as unknown as Record<string, number>)[key] = Math.min(hi, Math.max(lo, v));
    }
  }
  for (const key of ['autoTrade', 'killSwitch'] as const) {
    if (typeof p[key] === 'boolean') out[key] = p[key] as boolean;
  }
  return out;
}
