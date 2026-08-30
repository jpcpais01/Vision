'use client';

import type { CycleState } from '@/lib/engine/engine';
import { Badge, Empty, ProbBar } from '@/components/ui/Primitives';
import { cx, ms, pct, usd } from '@/lib/format';

/**
 * What the model said, when it said it, and — the part that matters — how much
 * BTC moved while it was thinking. That drift is the reason the raw LLM
 * probability is never traded directly.
 */
export function LlmPanel({ cycle, btc }: { cycle: CycleState; btc: number | null }) {
  const { llm, llmError, llmDispatchedAt, llmPriceAtDispatch, phase } = cycle;

  if (phase === 'llm-pending' && !llm) {
    const waited = llmDispatchedAt ? Date.now() - llmDispatchedAt : 0;
    const drift =
      btc !== null && llmPriceAtDispatch !== null ? btc - llmPriceAtDispatch : null;
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          <span className="text-xs text-slate-300">Awaiting forecast…</span>
          <span className="tnum ml-auto text-2xs text-slate-500">{ms(waited)}</span>
        </div>
        <p className="text-2xs leading-relaxed text-slate-500">
          The BTC path is still being recorded while the model thinks. Whatever it
          returns is treated as a prior over the whole window, then re-conditioned
          on everything that happened in the meantime.
        </p>
        {drift !== null ? (
          <div className="rounded-md border border-base-700 bg-base-950/60 px-2.5 py-1.5">
            <div className="text-2xs text-slate-500">BTC since dispatch</div>
            <div
              className={cx(
                'tnum text-sm font-semibold',
                drift >= 0 ? 'text-up' : 'text-down'
              )}
            >
              {drift >= 0 ? '+' : ''}
              {drift.toFixed(2)}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (llmError && !llm) {
    return (
      <div className="space-y-2">
        <Badge tone="down">forecast failed</Badge>
        <p className="text-2xs leading-relaxed text-slate-400">{llmError}</p>
        <p className="text-2xs text-slate-600">
          No trade is taken without a forecast — the simulation still runs on
          volatility alone, for the readout only.
        </p>
      </div>
    );
  }

  if (!llm) return <Empty>No forecast for this window yet.</Empty>;

  const drift =
    btc !== null && llm.requestPrice ? btc - llm.requestPrice : null;
  const leansUp = llm.pUp >= 0.5;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="label">P(UP) from model</div>
            <div className="flex items-baseline gap-1.5">
              <span
                className={cx(
                  'tnum text-2xl font-semibold leading-tight',
                  leansUp ? 'text-up' : 'text-down'
                )}
              >
                {pct(llm.pUp, 1)}
              </span>
              <span className="whitespace-nowrap text-xs font-medium text-slate-500">
                {leansUp ? 'UP' : 'DOWN'} lean
              </span>
            </div>
          </div>
          <Badge tone={llm.latencyMs > 12000 ? 'warn' : 'muted'}>{ms(llm.latencyMs)}</Badge>
        </div>
        <div className="mt-1 truncate text-2xs text-slate-600" title={llm.model}>
          served by {llm.model}
        </div>
      </div>

      <ProbBar value={llm.pUp} tone={leansUp ? 'up' : 'down'} marker={0.5} markerLabel="50%" />

      <div className="grid grid-cols-3 gap-2">
        <Metric label="Confidence" value={pct(llm.confidence, 0)} />
        <Metric label="Regime" value={llm.regime.replace('-', ' ')} />
        <Metric
          label="Exp. move"
          value={llm.expectedMoveUsd !== null ? usd(Math.abs(llm.expectedMoveUsd), 0) : '—'}
        />
      </div>

      {drift !== null ? (
        <div className="flex items-center justify-between rounded-md border border-base-700 bg-base-950/50 px-2.5 py-1.5">
          <span className="text-2xs text-slate-500">BTC moved since forecast</span>
          <span
            className={cx('tnum text-xs font-semibold', drift >= 0 ? 'text-up' : 'text-down')}
          >
            {drift >= 0 ? '+' : ''}
            {drift.toFixed(2)}
          </span>
        </div>
      ) : null}

      {llm.keyFactors.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {llm.keyFactors.map((f, i) => (
            <span
              key={i}
              className="rounded border border-base-700 bg-base-850/60 px-1.5 py-0.5 text-2xs text-slate-400"
            >
              {f}
            </span>
          ))}
        </div>
      ) : null}

      {llm.rationale ? (
        <p className="border-l-2 border-base-600 pl-2.5 text-2xs italic leading-relaxed text-slate-400">
          {llm.rationale}
        </p>
      ) : null}

      {llm.promptTokens !== null ? (
        <div className="tnum text-2xs text-slate-600">
          {llm.promptTokens.toLocaleString()} prompt · {(llm.completionTokens ?? 0).toLocaleString()} completion tokens
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-base-700 bg-base-950/50 px-2 py-1.5">
      <div className="text-2xs text-slate-500">{label}</div>
      <div className="mt-0.5 truncate text-xs font-medium capitalize text-slate-200">{value}</div>
    </div>
  );
}
