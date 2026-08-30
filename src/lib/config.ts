import type { Config } from './types';

/** The 5-minute window, in seconds. */
export const WINDOW_SEC = 300;
/** History bar size, in seconds. */
export const BAR_SEC = 10;
/** Rolling width of the price history the engine keeps, in minutes. */
export const HISTORY_MIN = 30;
/**
 * Minimum time the engine must spend gathering live ticks before it will
 * trade its first window. There is no seeded history — the tape is built
 * entirely from what has actually been observed since start() — so this is
 * the time it takes for the volatility estimate to be real rather than a
 * generic fallback number.
 */
export const CALIBRATION_MIN_SEC = 300;

export const DEFAULT_CONFIG: Config = {
  mode: 'PAPER',
  autoTrade: false,
  killSwitch: false,
  minEdge: 0.05, // 5 percentage points over the market price
  stakeUsd: 20,
  maxDailyLossUsd: 100,
  minSecondsLeft: 20,
  paths: 10_000,
};

const BOUNDS = {
  minEdge: [0.01, 0.5],
  stakeUsd: [1, 10_000],
  maxDailyLossUsd: [1, 100_000],
  minSecondsLeft: [5, 240],
  paths: [1000, 50_000],
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
  if (p.mode === 'PAPER' || p.mode === 'LIVE') out.mode = p.mode;
  return out;
}
