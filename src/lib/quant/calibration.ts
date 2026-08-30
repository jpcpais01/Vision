import type { CalibrationBin, CycleRecord, Metrics, Trade } from '../types';
import { clamp } from '../math/stats';

const EMPTY_METRICS: Metrics = {
  trades: 0,
  resolved: 0,
  wins: 0,
  losses: 0,
  winRate: 0,
  pnl: 0,
  turnover: 0,
  roi: 0,
  avgEdge: 0,
  brier: 0,
  brierBaseline: 0.25,
  brierSkill: 0,
  calibrationError: 0,
  logLoss: 0,
  maxDrawdown: 0,
  sharpe: 0,
  bestTrade: 0,
  worstTrade: 0,
  currentStreak: 0,
};

/**
 * Trading performance and forecast quality, computed together.
 *
 * P&L alone cannot tell you whether the model is any good over a few dozen
 * 5-minute binaries — the variance swamps the signal. Brier score and
 * calibration error converge much faster, so they are the metrics to watch
 * early; P&L is the one that has to be true in the end.
 */
export function computeMetrics(trades: Trade[]): Metrics {
  const resolved = trades.filter((t) => t.status === 'WON' || t.status === 'LOST');
  if (trades.length === 0) return { ...EMPTY_METRICS };

  const wins = resolved.filter((t) => t.status === 'WON').length;
  const losses = resolved.length - wins;

  let pnl = 0;
  let turnover = 0;
  let brierSum = 0;
  let logLossSum = 0;
  let edgeSum = 0;
  let best = 0;
  let worst = 0;

  // Equity curve for drawdown / Sharpe.
  const equity: number[] = [0];
  const returns: number[] = [];

  for (const t of trades) edgeSum += t.edge;

  for (const t of resolved) {
    const realised = t.pnl ?? 0;
    pnl += realised;
    turnover += t.notional;
    equity.push(pnl);
    if (t.notional > 0) returns.push(realised / t.notional);
    if (realised > best) best = realised;
    if (realised < worst) worst = realised;

    // Score the probability we assigned to the side we actually took.
    const p = clamp(t.modelP, 1e-6, 1 - 1e-6);
    const outcome = t.status === 'WON' ? 1 : 0;
    brierSum += (p - outcome) ** 2;
    logLossSum += -(outcome * Math.log(p) + (1 - outcome) * Math.log(1 - p));
  }

  const n = resolved.length;
  const brier = n > 0 ? brierSum / n : 0;

  // Baseline is the Brier of a forecaster who always says 50/50 on the same
  // set — the honest benchmark for a binary with no structural bias.
  const brierBaseline = 0.25;

  const meanForecast = n > 0 ? resolved.reduce((s, t) => s + t.modelP, 0) / n : 0;
  const observedFreq = n > 0 ? wins / n : 0;

  return {
    trades: trades.length,
    resolved: n,
    wins,
    losses,
    winRate: n > 0 ? wins / n : 0,
    pnl,
    turnover,
    roi: turnover > 0 ? pnl / turnover : 0,
    avgEdge: trades.length > 0 ? edgeSum / trades.length : 0,
    brier,
    brierBaseline,
    brierSkill: brierBaseline > 0 ? 1 - brier / brierBaseline : 0,
    calibrationError: meanForecast - observedFreq,
    logLoss: n > 0 ? logLossSum / n : 0,
    maxDrawdown: maxDrawdown(equity),
    sharpe: sharpe(returns),
    bestTrade: best,
    worstTrade: worst,
    currentStreak: streak(resolved),
  };
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0] ?? 0;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

/**
 * Per-trade Sharpe scaled to a nominal 288 trades (one full day of 5-minute
 * windows). Below ~20 resolved trades it is noise, and the UI says so.
 */
function sharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const m = returns.reduce((a, b) => a + b, 0) / returns.length;
  const v =
    returns.reduce((a, b) => a + (b - m) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(v);
  if (!(sd > 0)) return 0;
  return (m / sd) * Math.sqrt(288);
}

/** Positive = consecutive wins, negative = consecutive losses. */
function streak(resolved: Trade[]): number {
  let s = 0;
  for (let i = resolved.length - 1; i >= 0; i--) {
    const won = resolved[i].status === 'WON';
    if (i === resolved.length - 1) {
      s = won ? 1 : -1;
      continue;
    }
    if (won && s > 0) s++;
    else if (!won && s < 0) s--;
    else break;
  }
  return s;
}

/**
 * Reliability diagram data. Bins forecasts by decile and compares the mean
 * forecast in each bin with the frequency actually observed — a well-calibrated
 * model sits on the diagonal.
 *
 * Scored over every observed cycle, not just the traded ones: restricting to
 * trades would only sample the windows where the model disagreed with the
 * market, which is precisely the biased subset.
 */
export function calibrationBins(cycles: CycleRecord[], binCount = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({
      lo: i / binCount,
      hi: (i + 1) / binCount,
      n: 0,
      meanForecast: 0,
      observedFreq: 0,
    });
  }

  for (const c of cycles) {
    if (!c.mc || c.outcome === null) continue;
    const p = clamp(c.mc.pUp, 0, 0.999999);
    const idx = Math.min(binCount - 1, Math.floor(p * binCount));
    const bin = bins[idx];
    bin.n += 1;
    bin.meanForecast += p;
    bin.observedFreq += c.outcome === 'UP' ? 1 : 0;
  }

  for (const b of bins) {
    if (b.n > 0) {
      b.meanForecast /= b.n;
      b.observedFreq /= b.n;
    }
  }
  return bins;
}

/** Brier score of the Monte Carlo forecast over every resolved cycle. */
export function forecastBrier(cycles: CycleRecord[]): {
  mc: number;
  llm: number;
  n: number;
} {
  let mcSum = 0;
  let llmSum = 0;
  let mcN = 0;
  let llmN = 0;
  for (const c of cycles) {
    if (c.outcome === null) continue;
    const y = c.outcome === 'UP' ? 1 : 0;
    if (c.mc) {
      mcSum += (c.mc.pUp - y) ** 2;
      mcN++;
    }
    if (c.llm) {
      llmSum += (c.llm.pUp - y) ** 2;
      llmN++;
    }
  }
  return {
    mc: mcN > 0 ? mcSum / mcN : 0,
    llm: llmN > 0 ? llmSum / llmN : 0,
    n: Math.max(mcN, llmN),
  };
}
