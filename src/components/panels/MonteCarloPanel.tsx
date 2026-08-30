'use client';

import type { CycleState } from '@/lib/engine/engine';
import { DistributionChart } from '@/components/charts/DistributionChart';
import { Badge, Empty, ProbBar } from '@/components/ui/Primitives';
import { cx, ms, num, pct, usd } from '@/lib/format';

/**
 * The conditional update, shown as a chain: LLM prior → simulation → shrink →
 * the number actually traded. Each arrow is a place the probability can move,
 * and seeing all four side by side is what makes the system auditable rather
 * than a black box that emits a percentage.
 */
export function MonteCarloPanel({
  cycle,
  btc,
  shrink,
}: {
  cycle: CycleState;
  btc: number | null;
  shrink: number;
}) {
  const { mc, vol, finalPUp, startPrice, llm } = cycle;

  if (!mc) return <Empty>Simulation starts when the window opens.</Empty>;

  const leansUp = (finalPUp ?? mc.pUp) >= 0.5;
  const priorShift = llm ? mc.pUp - llm.pUp : null;

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="label">Updated P(UP)</div>
          <div
            className={cx(
              'tnum text-3xl font-semibold leading-none',
              leansUp ? 'text-up' : 'text-down'
            )}
          >
            {pct(finalPUp ?? mc.pUp, 1)}
          </div>
          <div className="tnum mt-1 text-2xs text-slate-500">
            ±{(mc.standardError * 100).toFixed(2)}pp simulation error
          </div>
        </div>
        <div className="space-y-1 text-right">
          <Badge tone="accent">{mc.paths.toLocaleString()} paths</Badge>
          <div className="tnum text-2xs text-slate-600">{ms(mc.computeMs)}</div>
          <div className="text-2xs text-slate-600">{mc.engine}</div>
        </div>
      </div>

      <ProbBar
        value={finalPUp ?? mc.pUp}
        tone={leansUp ? 'up' : 'down'}
        marker={llm?.pUp ?? null}
        markerLabel="LLM prior"
      />

      {/* The update chain. */}
      <div className="grid grid-cols-4 gap-1.5">
        <ChainStep label="LLM prior" value={llm ? pct(llm.pUp, 1) : 'n/a'} muted={!llm} />
        <ChainStep
          label="Simulated"
          value={pct(mc.pUp, 1)}
          delta={priorShift}
          highlight
          title="Conditional Monte Carlo: the prior re-expressed as drift and applied only to the seconds remaining, starting from the price now"
        />
        <ChainStep
          label={`Shrunk ${(shrink * 100).toFixed(0)}%`}
          value={pct(finalPUp ?? mc.pUp, 1)}
          title="The probability actually used for sizing, pulled toward 0.50 to offset accumulated model error"
        />
        <ChainStep
          label="Barrier σ"
          value={
            Number.isFinite(mc.moneynessSigma) ? mc.moneynessSigma.toFixed(2) : '—'
          }
        />
      </div>

      <DistributionChart mc={mc} barrier={startPrice} currentPrice={btc} />

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
        <Row label="Realised vol (ann.)" value={vol ? `${vol.annualisedPct.toFixed(1)}%` : '—'} />
        <Row
          label="σ per 10s bar"
          value={vol ? `${(vol.sigma10s * 10_000).toFixed(2)} bps` : '—'}
        />
        <Row
          label="Prior drift"
          value={`${(mc.driftPerSec * 1e6).toFixed(2)} ppm/s`}
          title="Per-second log drift implied by the LLM prior under the estimated volatility"
        />
        <Row
          label="Excess kurtosis"
          value={vol ? num(vol.excessKurtosis, 2) : '—'}
          title="Fat-tailedness of recent 10s returns; drives the Student-t innovations"
        />
        <Row label="Median terminal" value={usd(mc.quantiles.q50, 0)} />
        <Row
          label="Vol samples"
          value={vol ? `${vol.samples} bars` : '—'}
        />
      </dl>
    </div>
  );
}

function ChainStep({
  label,
  value,
  delta,
  highlight,
  muted,
  title,
}: {
  label: string;
  value: string;
  delta?: number | null;
  highlight?: boolean;
  muted?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      className={cx(
        'rounded-md border px-1.5 py-1.5',
        highlight
          ? 'border-accent/40 bg-accent/10'
          : 'border-base-700 bg-base-950/50',
        muted && 'opacity-50'
      )}
    >
      <div className="truncate text-[10px] leading-tight text-slate-500">{label}</div>
      <div className="tnum mt-0.5 text-xs font-semibold text-slate-100">{value}</div>
      {delta !== null && delta !== undefined ? (
        <div
          className={cx(
            'tnum text-[10px] leading-tight',
            Math.abs(delta) < 0.005 ? 'text-slate-600' : delta > 0 ? 'text-up' : 'text-down'
          )}
        >
          {delta >= 0 ? '+' : ''}
          {(delta * 100).toFixed(1)}pp
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <dt className="truncate text-slate-500">{label}</dt>
      <dd className="tnum shrink-0 text-slate-300">{value}</dd>
    </div>
  );
}
