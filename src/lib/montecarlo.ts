import type { Simulation } from './types';
import { normInv } from './math/normal';
import { NormalSampler, Rng } from './math/rng';

/**
 * ── The updater ──────────────────────────────────────────────────────────────
 *
 * The model answered a question about the whole five minutes, at second zero.
 * By the time its answer arrived, Bitcoin had already moved — and it keeps
 * moving for the rest of the window. This turns that stale opinion into a live
 * probability, once a second.
 *
 * How: the model's probability is converted into a *drift* — the steady push
 * that would produce that probability at the measured volatility — and applied
 * only to the seconds that are left. The simulation then starts from the price
 * **now**, not from the barrier, so the part of the window that already
 * happened is the starting point rather than something to re-simulate.
 *
 * The consequence is the whole point of the design: a call of "UP, 70%" on a
 * window where Bitcoin has since dropped well below the barrier with a minute
 * left comes out low, because the move needed to recover in the time remaining
 * is not plausible at the current volatility.
 *
 * Every run also produces `pUpNeutral` — the identical simulation with a 50/50
 * prior. That is the control: if the model knows nothing, the two probabilities
 * score the same, and the dashboard says so.
 */

export interface SimInput {
  /** Price when the window opened — what the market settles against. */
  barrier: number;
  /** Price now. */
  current: number;
  /** Seconds left in the window. */
  remainingSec: number;
  /** Model's probability that the market resolves UP, 0..1. */
  llmPUp: number;
  /** 0 = ignore the model entirely, 1 = take it at its word. */
  llmWeight: number;
  /** Per-second volatility of log returns. */
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

  if (remainingSec <= 0 || !(barrier > 0) || !(current > 0)) {
    const settled = current > barrier ? 1 : 0;
    return {
      pUp: settled,
      pUpNeutral: settled,
      sigma,
      volPct: sigma * Math.sqrt(365 * 24 * 3600) * 100,
      paths: 0,
      computeMs: Date.now() - t0,
    };
  }

  const s = Math.max(sigma, 1e-12);
  const tau = remainingSec;
  const sd = s * Math.sqrt(tau);

  // How far we are from the barrier, in log terms. Positive means we need a
  // rally; negative means we are already in the money.
  const gap = Math.log(barrier / current);

  // Prior → drift. Solve  Phi(m * T / (sigma * sqrt(T))) = p  for m over the
  // full 300-second window, then apply it only to the seconds remaining.
  const p = clamp(input.llmPUp, 0.02, 0.98);
  const drift =
    ((s * normInv(p)) / Math.sqrt(300)) * clamp(input.llmWeight, 0, 1) * tau;

  const rng = new Rng(seed);
  const sampler = new NormalSampler(rng);

  let wins = 0;
  let winsNeutral = 0;

  for (let i = 0; i < paths; i += 2) {
    // Gaussian shocks, deliberately. Fat-tailed innovations are a better fit
    // for 10-second crypto returns, but the drift above is solved from the
    // normal quantile — mixing the two makes the simulation return something
    // other than the prior it was given, which quietly breaks the one property
    // that makes this auditable. One consistent distribution beats two
    // half-matched ones.
    const z = sampler.next();
    const shock = sd * z;

    // Both priors run on the same shocks, so the comparison between them is a
    // clean read on the model rather than a difference in random draws.
    if (drift + shock > gap) wins++;
    if (drift - shock > gap) wins++;
    if (shock > gap) winsNeutral++;
    if (-shock > gap) winsNeutral++;
  }

  return {
    pUp: wins / paths,
    pUpNeutral: winsNeutral / paths,
    sigma: s,
    volPct: s * Math.sqrt(365 * 24 * 3600) * 100,
    paths,
    computeMs: Date.now() - t0,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
