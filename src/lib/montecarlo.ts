import { NormalSampler, Rng } from './math/rng';
import { quantileSorted } from './math/stats';

/**
 * ── The only model ───────────────────────────────────────────────────────────
 *
 * A driftless Monte Carlo, run fresh at the start of every cycle: no
 * view is taken on direction. `paths` random walks are simulated forward from
 * the price right now, one step per second, using the realised volatility of
 * the last `HISTORY_SEC` one-second price points. Unlike a single-horizon
 * simulation, this keeps every path's price at *every* second of the cycle —
 * the question isn't just "where might it end up" but "how far should it
 * plausibly have gotten by second N", checked continuously as the cycle plays
 * out.
 *
 * When the live price strays further from the cycle's start than the model
 * thinks is likely at that second, that's the signal: bet on reversion.
 */

export interface CycleSimInput {
  /** Price when the cycle began. */
  startPrice: number;
  /** Per-second volatility of log returns, from the realised tape. */
  sigma: number;
  /** Cycle length, in seconds. */
  cycleSec: number;
  paths: number;
  seed: number;
}

export interface CycleDistribution {
  cycleSec: number;
  /** stepPrices[i] = every path's simulated price at second (i+1), ascending-sorted. */
  stepPrices: Float64Array[];
  computeMs: number;
}

export function simulateCycle(input: CycleSimInput): CycleDistribution {
  const t0 = Date.now();
  const { startPrice, cycleSec } = input;

  // Even path count: every draw is simulated mirrored as well (antithetic
  // sampling), which halves the noise for free.
  const paths = Math.max(2, Math.floor(input.paths / 2) * 2);
  const sigma = Math.max(input.sigma, 1e-12);

  const stepPrices: Float64Array[] = Array.from({ length: cycleSec }, () => new Float64Array(paths));
  const sampler = new NormalSampler(new Rng(input.seed));

  for (let i = 0; i < paths; i += 2) {
    let logUp = 0;
    let logDown = 0;
    for (let sec = 0; sec < cycleSec; sec++) {
      const shock = sigma * sampler.next();
      logUp += shock;
      logDown -= shock;
      stepPrices[sec][i] = startPrice * Math.exp(logUp);
      stepPrices[sec][i + 1] = startPrice * Math.exp(logDown);
    }
  }
  for (const arr of stepPrices) arr.sort();

  return { cycleSec, stepPrices, computeMs: Date.now() - t0 };
}

/**
 * One-sided tail probability: the share of simulated paths that reached at
 * least as far from the start price, in the same direction, as the live
 * price has — at the given elapsed second. Falls as the move gets more
 * extreme; a low value means the current price is a rare draw from the
 * model's own distribution at this point in the cycle.
 */
export function tailProbability(
  dist: CycleDistribution,
  elapsedSec: number,
  startPrice: number,
  livePrice: number
): number {
  const idx = Math.min(dist.cycleSec, Math.max(1, Math.round(elapsedSec))) - 1;
  const sorted = dist.stepPrices[idx];
  const n = sorted.length;
  if (n === 0) return 1;
  return livePrice >= startPrice
    ? (n - lowerBound(sorted, livePrice)) / n
    : upperBound(sorted, livePrice) / n;
}

/** First index whose value is >= v. */
function lowerBound(sorted: Float64Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > v. */
function upperBound(sorted: Float64Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface Band {
  sec: number;
  lo: number;
  hi: number;
}

/** The [q, 1-q] price band at every second of the cycle — what the chart shades. */
export function bandFromDistribution(dist: CycleDistribution, q: number): Band[] {
  return dist.stepPrices.map((sorted, i) => ({
    sec: i + 1,
    lo: quantileSorted(sorted, q),
    hi: quantileSorted(sorted, 1 - q),
  }));
}
