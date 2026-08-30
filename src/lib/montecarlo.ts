import type { Simulation } from './types';
import { NormalSampler, Rng } from './math/rng';

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/**
 * ── The only model ───────────────────────────────────────────────────────────
 *
 * A driftless Monte Carlo. No view is taken on direction — nothing feeds one
 * in. The question answered is purely: given how much Bitcoin has actually
 * moved around in the last half hour, how far could it plausibly go in the
 * time that's left, and what share of that range still clears the barrier?
 *
 * Mechanically: `paths` random walks are simulated forward from the *current*
 * price (not the barrier — the part of the window that has already happened
 * is the starting point, not something to re-simulate) for the `remainingSec`
 * left in the window, using the realised volatility of the last 30 minutes of
 * real ticks. `pUp` is the share that finish above the barrier.
 *
 * Recomputed roughly once a second for as long as a window is open, so it
 * tracks the actual path rather than a single stale read.
 */

export interface SimInput {
  /** Price when the window opened — what the market settles against. */
  barrier: number;
  /** Price now. */
  current: number;
  /** Seconds left in the window. */
  remainingSec: number;
  /** Per-second volatility of log returns, from the realised tape. */
  sigma: number;
  paths: number;
  seed: number;
}

export function simulate(input: SimInput): Simulation {
  const t0 = Date.now();
  const { barrier, current, remainingSec, sigma, seed } = input;

  // Even path count: every draw is simulated mirrored as well (antithetic
  // sampling), which halves the noise for free.
  const paths = Math.max(2, Math.floor(input.paths / 2) * 2);
  const volPct = Math.max(sigma, 0) * Math.sqrt(SECONDS_PER_YEAR) * 100;

  if (remainingSec <= 0 || !(barrier > 0) || !(current > 0)) {
    const settled = current > barrier ? 1 : 0;
    return { pUp: settled, sigma, volPct, paths: 0, computeMs: Date.now() - t0 };
  }

  const s = Math.max(sigma, 1e-12);
  const sd = s * Math.sqrt(remainingSec);

  // Distance from here to the barrier, in log terms. Positive means the
  // current price is below the barrier and needs a rally; negative means it
  // is already above it.
  const gap = Math.log(barrier / current);

  const sampler = new NormalSampler(new Rng(seed));
  let wins = 0;

  for (let i = 0; i < paths; i += 2) {
    const shock = sd * sampler.next();
    if (shock > gap) wins++;
    if (-shock > gap) wins++;
  }

  return { pUp: wins / paths, sigma: s, volPct, paths, computeMs: Date.now() - t0 };
}
