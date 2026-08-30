import type { Bar, VolEstimate } from '../types';
import { BAR_SECONDS } from '../config';
import { ewmaVariance, excessKurtosis, stdev, variance } from '../math/stats';

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/** Log returns of consecutive bar closes. */
export function logReturns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    const cur = bars[i].c;
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Realised volatility of BTC from 10-second bars.
 *
 * Three things matter for a 5-minute binary:
 *  1. Recency — vol at 14:00 tells you little about vol at 14:05, so the
 *     estimate is EWMA-weighted with a short half-life.
 *  2. Robustness — a single bad tick can double a naive estimate, so short
 *     windows are blended with longer ones rather than used alone.
 *  3. Tail shape — the kurtosis of the same returns is carried through so the
 *     simulator can switch to Student-t innovations when the tape is jumpy.
 */
export function estimateVolatility(bars: Bar[], lambda = 0.97): VolEstimate {
  const rets = logReturns(bars);
  const n = rets.length;

  if (n < 5) {
    // Not enough tape yet. Fall back to a typical BTC level (~45% annualised)
    // rather than pretending vol is zero, which would make every edge look huge.
    const fallbackAnnual = 0.45;
    const sigmaPerSec = fallbackAnnual / Math.sqrt(SECONDS_PER_YEAR);
    return {
      sigmaPerSec,
      annualisedPct: fallbackAnnual * 100,
      sigma10s: sigmaPerSec * Math.sqrt(BAR_SECONDS),
      excessKurtosis: 0,
      samples: n,
      windows: [],
      method: 'ewma-blend',
    };
  }

  // Per-window realised vol, newest bars last.
  const windowSpecs: { label: string; bars: number; weight: number }[] = [
    { label: '5m', bars: 30, weight: 0.45 },
    { label: '15m', bars: 90, weight: 0.3 },
    { label: '60m', bars: 360, weight: 0.25 },
  ];

  const windows: VolEstimate['windows'] = [];
  let weighted = 0;
  let weightSum = 0;

  for (const spec of windowSpecs) {
    const slice = rets.slice(Math.max(0, n - spec.bars));
    if (slice.length < 5) continue;
    const sd = stdev(slice, 1);
    const perSec = sd / Math.sqrt(BAR_SECONDS);
    windows.push({ label: spec.label, sigmaPerSec: perSec, samples: slice.length });
    // Blend in variance space — volatility is not additive, variance is.
    weighted += spec.weight * perSec * perSec;
    weightSum += spec.weight;
  }

  const blendVar = weightSum > 0 ? weighted / weightSum : variance(rets, 1) / BAR_SECONDS;

  // EWMA over the whole series captures the very latest regime shift.
  const ewmaVar10s = ewmaVariance(rets, lambda);
  const ewmaVarPerSec = ewmaVar10s / BAR_SECONDS;

  // 60/40 toward the EWMA: responsive, but not hostage to one 10s bar.
  const combinedVar = 0.6 * ewmaVarPerSec + 0.4 * blendVar;
  const sigmaPerSec = Math.sqrt(Math.max(combinedVar, 1e-14));

  return {
    sigmaPerSec,
    annualisedPct: sigmaPerSec * Math.sqrt(SECONDS_PER_YEAR) * 100,
    sigma10s: sigmaPerSec * Math.sqrt(BAR_SECONDS),
    excessKurtosis: excessKurtosis(rets.slice(Math.max(0, n - 360))),
    samples: n,
    windows,
    method: 'ewma-blend',
  };
}

/** Annualise a per-second sigma for display. */
export function annualise(sigmaPerSec: number): number {
  return sigmaPerSec * Math.sqrt(SECONDS_PER_YEAR);
}
