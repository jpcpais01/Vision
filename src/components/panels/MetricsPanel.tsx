'use client';

import type { CycleRecord, Metrics, Trade } from '@/lib/types';
import { calibrationBins, forecastBrier } from '@/lib/quant/calibration';
import { wilsonInterval } from '@/lib/math/stats';
import { CalibrationChart } from '@/components/charts/CalibrationChart';
import { EquityChart } from '@/components/charts/EquityChart';
import { Stat } from '@/components/ui/Primitives';
import { cx, num, pct, signedUsd, usd } from '@/lib/format';

/**
 * Performance and forecast quality together.
 *
 * The Brier panel deserves more attention than the P&L panel early on: over a
 * few dozen 5-minute binaries the P&L is almost pure noise, while Brier skill
 * and calibration converge fast enough to tell you whether the model knows
 * anything at all. The UI says so rather than leaving the operator to infer it.
 */
export function MetricsPanel({
  metrics,
  trades,
  cycles,
}: {
  metrics: Metrics;
  trades: Trade[];
  cycles: CycleRecord[];
}) {
  const bins = calibrationBins(cycles);
  const quality = forecastBrier(cycles);
  const ci = wilsonInterval(metrics.wins, metrics.resolved);
  const thin = metrics.resolved < 20;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Cumulative P&L"
          value={signedUsd(metrics.pnl)}
          tone={metrics.pnl > 0 ? 'up' : metrics.pnl < 0 ? 'down' : 'neutral'}
          size="lg"
          sub={`${usd(metrics.turnover, 0)} turnover · ${pct(metrics.roi, 1)} ROI`}
        />
        <Stat
          label="Win rate"
          value={metrics.resolved > 0 ? pct(metrics.winRate, 1) : '—'}
          sub={
            metrics.resolved > 0
              ? `${metrics.wins}W / ${metrics.losses}L · 95% CI ${pct(ci.lo, 0)}–${pct(ci.hi, 0)}`
              : 'no resolved trades'
          }
          size="lg"
        />
        <Stat
          label="Brier score"
          value={metrics.resolved > 0 ? num(metrics.brier, 4) : '—'}
          tone={metrics.brier > 0 && metrics.brier < 0.25 ? 'up' : 'neutral'}
          sub={`skill ${metrics.resolved > 0 ? pct(metrics.brierSkill, 1) : '—'} vs coin flip`}
          size="lg"
          title="Mean squared error of the probability assigned to the side we took. Lower is better; 0.25 is a coin flip."
        />
        <Stat
          label="Max drawdown"
          value={usd(metrics.maxDrawdown)}
          tone={metrics.maxDrawdown > 0 ? 'down' : 'neutral'}
          sub={`streak ${metrics.currentStreak >= 0 ? '+' : ''}${metrics.currentStreak}`}
          size="lg"
        />
      </div>

      {thin && metrics.resolved > 0 ? (
        <p className="rounded-md border border-warn/25 bg-warn/5 px-2.5 py-1.5 text-2xs leading-relaxed text-warn/90">
          Only {metrics.resolved} resolved trade{metrics.resolved === 1 ? '' : 's'}. P&amp;L,
          win rate and Sharpe are dominated by noise at this sample size — read the
          Brier score and the reliability diagram instead, which use every observed
          window rather than only the traded ones.
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
        <div className="min-w-0">
          <div className="label mb-1">Cumulative P&amp;L by resolved trade</div>
          <EquityChart trades={trades} />

          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs sm:grid-cols-3">
            <Row label="Trades" value={String(metrics.trades)} />
            <Row label="Resolved" value={String(metrics.resolved)} />
            <Row label="Avg edge at entry" value={`${(metrics.avgEdge * 100).toFixed(2)}¢`} />
            <Row label="Log loss" value={metrics.resolved > 0 ? num(metrics.logLoss, 4) : '—'} />
            <Row
              label="Calibration error"
              value={
                metrics.resolved > 0
                  ? `${metrics.calibrationError >= 0 ? '+' : ''}${(metrics.calibrationError * 100).toFixed(1)}pp`
                  : '—'
              }
              title="Mean forecast minus realised frequency. Positive means over-confident."
            />
            <Row
              label="Sharpe (ann.)"
              value={metrics.resolved >= 20 ? num(metrics.sharpe, 2) : 'n/a <20'}
            />
            <Row label="Best trade" value={signedUsd(metrics.bestTrade)} />
            <Row label="Worst trade" value={signedUsd(metrics.worstTrade)} />
            <Row
              label="Forecast Brier"
              value={
                quality.n > 0
                  ? `MC ${num(quality.mc, 3)} · LLM ${num(quality.llm, 3)}`
                  : '—'
              }
              title="Brier of the raw forecasts over every observed window, traded or not — the unbiased measure."
            />
          </dl>
        </div>

        <div className="min-w-0">
          <div className="label mb-1">Reliability — Monte Carlo forecasts</div>
          <CalibrationChart bins={bins} />
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <dt className="truncate text-slate-500">{label}</dt>
      <dd className={cx('tnum shrink-0 text-slate-300')}>{value}</dd>
    </div>
  );
}
