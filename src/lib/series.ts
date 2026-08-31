import type { Tick } from './types';

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** Fold ticks into one price point per whole second — the last tick in each second wins. */
export function toSeconds(ticks: Tick[]): Tick[] {
  const out: Tick[] = [];
  for (const tick of [...ticks].sort((a, b) => a.t - b.t)) {
    if (!(tick.p > 0)) continue;
    const t = Math.floor(tick.t / 1000) * 1000;
    const last = out[out.length - 1];
    if (last && last.t === t) last.p = tick.p;
    else out.push({ t, p: tick.p });
  }
  return out;
}

/**
 * Per-second volatility as a plain stdev of log returns over the trailing
 * one-second points — no EWMA, no long warm-up. This is exactly the number
 * the Monte Carlo cycle simulation runs on.
 */
export function volatility(points: Tick[]): { sigma: number; volPct: number; samples: number } {
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].p;
    const b = points[i].p;
    if (a > 0 && b > 0) returns.push(Math.log(b / a));
  }
  if (returns.length < 2) {
    // Not enough tape yet. A typical BTC level beats pretending vol is zero,
    // which would make every tail probability look artificially extreme.
    const sigma = 0.45 / Math.sqrt(SECONDS_PER_YEAR);
    return { sigma, volPct: 45, samples: returns.length };
  }
  const avgSq = returns.reduce((s, x) => s + x * x, 0) / returns.length;
  const sigma = Math.sqrt(Math.max(avgSq, 1e-16));
  return { sigma, volPct: sigma * Math.sqrt(SECONDS_PER_YEAR) * 100, samples: returns.length };
}
