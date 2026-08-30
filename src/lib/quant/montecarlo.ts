import type { MonteCarloInput, MonteCarloResult } from '../types';
import { BAR_SECONDS } from '../config';
import { normCdf, normInv } from '../math/normal';
import { NormalSampler, Rng } from '../math/rng';
import { clamp, quantileSorted, stdev } from '../math/stats';

/**
 * ── Conditional Monte Carlo probability updater ──────────────────────────────
 *
 * The market asks a single question: is BTC higher at the close of the
 * 5-minute window than it was at the open? The open price is a fixed barrier
 * `S0`. Once the window is under way we are no longer forecasting from the
 * barrier — we are forecasting from wherever price actually is now, `St`, with
 * only `τ` seconds left. That already-realised move is the single most
 * informative input we have, and it is exactly what the LLM (which answered a
 * question about the window as a whole, seconds ago) cannot have priced in.
 *
 * So the updater is conditional by construction:
 *
 *   1. `σ` comes from realised 10-second returns, not from an implied surface.
 *   2. The LLM's P(UP) is turned into a *drift*, not blended as a number. If a
 *      forecaster says P(UP) = 0.62 for the full window, the drift consistent
 *      with that under the estimated vol is  m = σ·Φ⁻¹(0.62)/√T. That drift is
 *      then applied to the remaining τ seconds only.
 *   3. Simulation starts from `St`, so the realised portion of the window is
 *      carried in the initial condition rather than re-simulated.
 *   4. P(UP) is the share of terminal prices strictly above `S0`.
 *
 * The consequence is the behaviour you want: a bullish LLM call that BTC has
 * already run 40 bps against with 60 seconds left comes out of the updater as a
 * low probability, because the drift needed to recover the barrier in the time
 * remaining is implausible under the realised vol.
 */

/** Antithetic sampling is used throughout, so path counts round to even. */
export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const t0 = now();
  const {
    startPrice,
    currentPrice,
    remainingSec,
    priorPUp,
    priorWeight,
    vol,
    paths: requestedPaths,
    engine,
    studentT,
    seed,
  } = input;

  const paths = Math.max(2, Math.floor(requestedPaths / 2) * 2);
  const sigma = Math.max(vol.sigmaPerSec, 1e-12);

  // Log-distance from here to the barrier. Positive means we are below the
  // open and need a rally; negative means we are already in the money.
  const barrier = Math.log(startPrice / currentPrice);

  // The window is over (or the clock has run out): the answer is deterministic.
  if (remainingSec <= 0 || !Number.isFinite(barrier)) {
    const settled = currentPrice > startPrice ? 1 : 0;
    return {
      pUp: settled,
      standardError: 0,
      quantiles: {
        q05: currentPrice,
        q25: currentPrice,
        q50: currentPrice,
        q75: currentPrice,
        q95: currentPrice,
      },
      moneynessSigma: settled ? Infinity : -Infinity,
      paths: 0,
      engine: 'settled',
      computeMs: now() - t0,
      priorPUp,
      driftPerSec: 0,
      histogram: { edges: [currentPrice], counts: [1] },
    };
  }

  const tau = remainingSec;
  const sqrtTau = Math.sqrt(tau);
  const totalHorizon = input.elapsedSec + tau;

  // ── Prior → drift ─────────────────────────────────────────────────────────
  // Solve  Φ( m·T / (σ·√T) ) = priorPUp  for the per-second drift m, then damp
  // it by `priorWeight`. priorWeight = 0 makes the simulation a driftless
  // martingale (pure vol), priorWeight = 1 takes the LLM entirely at its word.
  const safePrior = clamp(priorPUp, 0.005, 0.995);
  const sqrtT = Math.sqrt(Math.max(totalHorizon, 1));
  const rawDrift = (sigma * normInv(safePrior)) / sqrtT;
  const driftPerSec = rawDrift * clamp(priorWeight, 0, 1);

  const mu = driftPerSec * tau;
  const sd = sigma * sqrtTau;

  const rng = new Rng(seed);
  const sampler = new NormalSampler(rng);
  const terminals = new Float64Array(paths);

  const useBootstrap = engine === 'bootstrap' || engine === 'blend';
  const useGaussian = engine === 'gbm' || engine === 'blend';
  const bootstrapPaths = engine === 'blend' ? paths / 2 : useBootstrap ? paths : 0;
  const gaussianPaths = paths - bootstrapPaths;

  let idx = 0;

  // ── Engine A: parametric, with optional Student-t innovations ─────────────
  if (useGaussian && gaussianPaths > 0) {
    const df = studentT;
    const fatTails = df >= 3;
    for (let i = 0; i < gaussianPaths; i += 2) {
      const z = fatTails ? sampler.nextStudentT(df) : sampler.next();
      // Antithetic pair: the mirrored shock halves the variance of the estimate
      // for free, which matters because we re-run this every few seconds.
      terminals[idx++] = currentPrice * Math.exp(mu + sd * z);
      terminals[idx++] = currentPrice * Math.exp(mu - sd * z);
    }
  }

  // ── Engine B: block bootstrap of the actual recent tape ──────────────────
  // Resampling real 10-second returns preserves the empirical tail shape and
  // short-horizon autocorrelation that no parametric form gets right.
  if (useBootstrap && bootstrapPaths > 0) {
    const pool = prepareBootstrapPool(input.recentReturns, sigma);
    if (pool.length >= 12) {
      const steps = Math.max(1, Math.ceil(tau / BAR_SECONDS));
      // The final step is usually a partial bar; scale its shock by √fraction.
      const lastFraction = (tau - (steps - 1) * BAR_SECONDS) / BAR_SECONDS;
      const lastScale = Math.sqrt(Math.max(lastFraction, 0));
      const driftPerBar = driftPerSec * BAR_SECONDS;
      const blockLen = Math.min(6, Math.max(2, Math.floor(steps / 3)));

      for (let i = 0; i < bootstrapPaths; i += 2) {
        let sum = 0;
        let mirror = 0;
        let step = 0;
        while (step < steps) {
          const start = rng.int(pool.length);
          const run = Math.min(blockLen, steps - step);
          for (let k = 0; k < run; k++) {
            const shock = pool[(start + k) % pool.length];
            const scale = step + k === steps - 1 ? lastScale : 1;
            sum += shock * scale;
            mirror -= shock * scale;
          }
          step += run;
        }
        const drift = driftPerBar * (steps - 1 + lastFraction);
        terminals[idx++] = currentPrice * Math.exp(drift + sum);
        terminals[idx++] = currentPrice * Math.exp(drift + mirror);
      }
    }
    // If the pool was too thin the shortfall is topped up parametrically below.
  }

  // Any shortfall — odd rounding, or a bootstrap pool too thin to use — is
  // topped up with parametric draws so the path count is always honoured.
  while (idx < paths) {
    const z = sampler.next();
    terminals[idx++] = currentPrice * Math.exp(mu + sd * z);
  }

  // ── Aggregate ────────────────────────────────────────────────────────────
  let wins = 0;
  for (let i = 0; i < paths; i++) {
    if (terminals[i] > startPrice) wins++;
  }
  const pUp = wins / paths;

  // Standard error via batch means. Antithetic and block-bootstrap draws are not
  // independent, so the textbook √(p(1-p)/n) understates the true error.
  const standardError = batchMeanStandardError(terminals, startPrice, paths);

  const sorted = Array.from(terminals).sort((a, b) => a - b);
  const quantiles = {
    q05: quantileSorted(sorted, 0.05),
    q25: quantileSorted(sorted, 0.25),
    q50: quantileSorted(sorted, 0.5),
    q75: quantileSorted(sorted, 0.75),
    q95: quantileSorted(sorted, 0.95),
  };

  return {
    pUp,
    standardError,
    quantiles,
    moneynessSigma: -barrier / sd,
    paths,
    engine: engine === 'blend' ? `blend(gbm+bootstrap)` : engine,
    computeMs: now() - t0,
    priorPUp,
    driftPerSec,
    histogram: buildHistogram(sorted, 41),
  };
}

/**
 * Standardise the sampled returns so their dispersion matches the current vol
 * estimate while keeping their empirical shape (skew, kurtosis, ordering).
 * Without this step the bootstrap silently re-uses whatever vol prevailed an
 * hour ago.
 */
function prepareBootstrapPool(returns: number[], targetSigmaPerSec: number): number[] {
  if (returns.length < 12) return [];
  // Use at most the last 30 minutes of 10s bars — older tape is a different
  // regime and its only effect would be to blur the tails.
  const pool = returns.slice(Math.max(0, returns.length - 180));
  const sd = stdev(pool, 1);
  if (!(sd > 0)) return [];
  const targetSd = targetSigmaPerSec * Math.sqrt(BAR_SECONDS);
  const scale = targetSd / sd;
  let m = 0;
  for (const r of pool) m += r;
  m /= pool.length;
  // De-mean before scaling: the drift is supplied by the prior, not by whatever
  // trend happened to sit in the sample window.
  return pool.map((r) => (r - m) * scale);
}

/**
 * Split the sample into 25 batches and take the SE of the batch proportions.
 *
 * Batch means rather than sqrt(p(1-p)/n) because neither antithetic pairs nor
 * block-bootstrap draws are independent, so the textbook formula is wrong in
 * both directions: it overstates the error for antithetic draws and understates
 * it for correlated blocks.
 *
 * Antithetic pairing can drive the true simulation error to exactly zero — at
 * the money with no drift, every mirrored pair contributes precisely one win —
 * so the result is floored at the estimator's own discretisation, 1/n. That
 * keeps a downstream consumer from reading "zero uncertainty" off a number that
 * only means "this particular symmetry happens to be exact".
 */
function batchMeanStandardError(
  terminals: Float64Array,
  barrier: number,
  n: number
): number {
  const batches = 25;
  const size = Math.floor(n / batches);
  if (size < 8) return Math.sqrt(0.25 / Math.max(n, 1));
  const props: number[] = [];
  for (let b = 0; b < batches; b++) {
    let w = 0;
    const from = b * size;
    for (let i = from; i < from + size; i++) if (terminals[i] > barrier) w++;
    props.push(w / size);
  }
  return Math.max(stdev(props, 1) / Math.sqrt(batches), 1 / n);
}

function buildHistogram(sorted: number[], buckets: number) {
  const lo = quantileSorted(sorted, 0.005);
  const hi = quantileSorted(sorted, 0.995);
  const edges: number[] = [];
  const counts = new Array<number>(buckets).fill(0);
  if (!(hi > lo)) return { edges: [lo], counts: [sorted.length] };
  const width = (hi - lo) / buckets;
  for (let i = 0; i <= buckets; i++) edges.push(lo + i * width);
  for (const v of sorted) {
    const b = Math.floor((v - lo) / width);
    if (b >= 0 && b < buckets) counts[b]++;
  }
  return { edges, counts };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Closed-form P(UP) under the same assumptions the simulator uses. Cheap enough
 * to call on every tick for the live "analytic vs simulated" readout, and the
 * reference the simulation is tested against.
 */
export function analyticPUp(args: {
  startPrice: number;
  currentPrice: number;
  remainingSec: number;
  elapsedSec: number;
  sigmaPerSec: number;
  priorPUp: number;
  priorWeight: number;
}): number {
  const { startPrice, currentPrice, remainingSec, elapsedSec, sigmaPerSec } = args;
  if (remainingSec <= 0) return currentPrice > startPrice ? 1 : 0;
  const sigma = Math.max(sigmaPerSec, 1e-12);
  const barrier = Math.log(startPrice / currentPrice);
  const total = Math.max(elapsedSec + remainingSec, 1);
  const drift =
    ((sigma * normInv(clamp(args.priorPUp, 0.005, 0.995))) / Math.sqrt(total)) *
    clamp(args.priorWeight, 0, 1);
  const sd = sigma * Math.sqrt(remainingSec);
  return normCdf((drift * remainingSec - barrier) / sd);
}
