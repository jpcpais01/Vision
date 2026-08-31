export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function variance(xs: number[], ddof = 1): number {
  if (xs.length <= ddof) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return s / (xs.length - ddof);
}

export function stdev(xs: number[], ddof = 1): number {
  return Math.sqrt(variance(xs, ddof));
}

/** Excess kurtosis (0 for a Gaussian). */
export function excessKurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const m = mean(xs);
  let m2 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - m;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  if (m2 === 0) return 0;
  return m4 / (m2 * m2) - 3;
}

/** Linear-interpolated quantile of an already-sorted ascending array. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Exponentially weighted variance of a zero-mean series, most recent last.
 * `lambda` is the decay: 0.97 over 10s bars gives a ~5.5 minute half-life.
 */
export function ewmaVariance(returns: number[], lambda: number): number {
  if (returns.length === 0) return 0;
  // Seed with the sample variance of the first chunk so the estimate is usable
  // immediately instead of ramping up from zero.
  const seedN = Math.min(returns.length, 30);
  let v = variance(returns.slice(0, seedN), 0);
  for (let i = seedN; i < returns.length; i++) {
    const r = returns[i];
    v = lambda * v + (1 - lambda) * r * r;
  }
  return v;
}

/**
 * Wilson score interval — used for win-rate and calibration-bin error bars,
 * where the normal approximation breaks down on small samples.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.96
): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (centre - margin) / denom), hi: Math.min(1, (centre + margin) / denom) };
}
