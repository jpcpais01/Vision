/**
 * Deterministic PRNG + normal sampler.
 *
 * Determinism matters here: two runs of the Monte Carlo with the same seed must
 * produce identical probabilities, so a backtest can be replayed exactly and a
 * live decision can be audited after the fact.
 */

/** xoshiro128** — fast, small state, good statistical quality for simulation. */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // splitmix32 to expand the seed into four well-mixed words.
    let x = seed >>> 0 || 0x9e3779b9;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  /** Uniform in [0,1). */
  next(): number {
    const r = Math.imul(this.s1, 5) >>> 0;
    const rotated = ((r << 7) | (r >>> 25)) >>> 0;
    const result = Math.imul(rotated, 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;

    return result / 4294967296;
  }

  /** Uniform in (0,1) — excludes both endpoints, safe for log/inverse-CDF. */
  nextOpen(): number {
    return (this.next() * 4294967294 + 1) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n) % n;
  }
}

/**
 * Marsaglia polar method. Returns pairs, so the caller buffers the spare value.
 * Cheaper than inverse-CDF sampling and has no tail truncation.
 */
export class NormalSampler {
  private spare: number | null = null;

  constructor(private rng: Rng) {}

  next(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u: number, v: number, s: number;
    do {
      u = this.rng.next() * 2 - 1;
      v = this.rng.next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * mul;
    return u * mul;
  }

  /**
   * Standardised Student-t with `df` degrees of freedom: unit variance, but
   * excess kurtosis. Crypto 10-second returns are visibly fat-tailed, and using
   * a Gaussian there systematically underprices the chance of a late reversal.
   */
  nextStudentT(df: number): number {
    if (df <= 2) return this.next();
    const z = this.next();
    // Chi-square(df) via a sum of squared normals is slow for large df; use the
    // Wilson–Hilferty transform of a gamma approximation instead.
    const chi = this.chiSquare(df);
    return (z / Math.sqrt(chi / df)) / Math.sqrt(df / (df - 2));
  }

  private chiSquare(df: number): number {
    // Wilson–Hilferty: chi2_df ≈ df * (1 - 2/(9df) + Z*sqrt(2/(9df)))^3
    const a = 2 / (9 * df);
    const z = this.next();
    const base = 1 - a + z * Math.sqrt(a);
    const cubed = base > 0 ? base * base * base : 1e-9;
    return df * cubed;
  }
}
