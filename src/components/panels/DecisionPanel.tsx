'use client';

import type { CycleState } from '@/lib/engine/engine';
import type { TradingConfig } from '@/lib/types';
import { REJECT_LABELS } from '@/lib/engine/risk';
import { Badge, Empty } from '@/components/ui/Primitives';
import { cents, cx, ms, price, usd } from '@/lib/format';

/**
 * Why the system is or is not trading, right now.
 *
 * Every gate is listed with its live value against its threshold, because the
 * single most common question when watching an automated strategy sit still is
 * "what is stopping it?" — and "insufficient edge" alone does not answer that.
 */
export function DecisionPanel({
  cycle,
  config,
  secondsLeft,
}: {
  cycle: CycleState;
  config: TradingConfig;
  secondsLeft: number | null;
}) {
  const decision = cycle.decision;
  const best = decision?.best ?? null;

  if (!decision) {
    return (
      <Empty>
        {cycle.llm
          ? 'Evaluating…'
          : 'The decision engine runs once the forecast lands.'}
      </Empty>
    );
  }

  const gates: { label: string; ok: boolean; detail: string }[] = best
    ? [
        {
          label: 'Edge',
          ok: best.edge >= config.minEdge,
          detail: `${cents(best.edge)} vs ${cents(config.minEdge)} min`,
        },
        {
          label: 'Edge ratio',
          ok: best.edgeRatio >= config.minEdgeRatio,
          detail: `${(best.edgeRatio * 100).toFixed(1)}% vs ${(config.minEdgeRatio * 100).toFixed(0)}%`,
        },
        {
          label: 'Spread',
          ok: best.spread !== null && best.spread <= config.maxSpread,
          detail: `${best.spread !== null ? (best.spread * 100).toFixed(1) : '—'}¢ vs ${(config.maxSpread * 100).toFixed(1)}¢ max`,
        },
        {
          label: 'Top-of-book',
          ok: best.askSize >= config.minTopOfBookShares,
          detail: `${best.askSize.toFixed(0)} vs ${config.minTopOfBookShares} shares`,
        },
        {
          label: 'Price bounds',
          ok: best.ask >= config.minPrice && best.ask <= config.maxPrice,
          detail: `${price(best.ask)} in [${config.minPrice}, ${config.maxPrice}]`,
        },
        {
          label: 'Time window',
          ok:
            secondsLeft !== null &&
            secondsLeft >= config.minSecondsLeft &&
            secondsLeft <= config.maxSecondsLeft,
          detail: `${secondsLeft?.toFixed(0) ?? '—'}s in [${config.minSecondsLeft}, ${config.maxSecondsLeft}]`,
        },
        {
          label: 'Data freshness',
          ok: decision.dataAgeMs <= config.maxDataAgeMs,
          detail: `${ms(decision.dataAgeMs)} vs ${ms(config.maxDataAgeMs)} max`,
        },
        {
          label: 'Decision latency',
          ok:
            cycle.decisionLatencyMs === null ||
            cycle.decisionLatencyMs <= config.maxDecisionLatencyMs,
          detail: `${ms(cycle.decisionLatencyMs)} vs ${ms(config.maxDecisionLatencyMs)} budget`,
        },
      ]
    : [];

  const blocking = decision.rejectReasons;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        {decision.trade ? (
          <Badge tone="up">✓ trade approved</Badge>
        ) : (
          <Badge tone={blocking.includes('mode-disabled') ? 'muted' : 'warn'}>
            {blocking.length === 0 ? 'evaluating' : 'standing down'}
          </Badge>
        )}
        {best ? (
          <span className="text-2xs text-slate-500">
            best side{' '}
            <span className={cx('font-semibold', best.side === 'UP' ? 'text-up' : 'text-down')}>
              {best.side}
            </span>
          </span>
        ) : null}
      </div>

      {best ? (
        <div className="grid grid-cols-4 gap-2 rounded-lg border border-base-700 bg-base-950/50 p-2.5">
          <Cell label="Model" value={`${(best.pWin * 100).toFixed(1)}%`} />
          <Cell label="Ask" value={price(best.ask)} />
          <Cell
            label="Edge"
            value={cents(best.edge)}
            tone={best.edge >= config.minEdge ? 'up' : 'muted'}
          />
          <Cell
            label="Size"
            value={decision.size > 0 ? `${decision.size} @ ${usd(decision.notional, 0)}` : '—'}
          />
        </div>
      ) : null}

      {gates.length > 0 ? (
        <ul className="space-y-1">
          {gates.map((g) => (
            <li
              key={g.label}
              className="flex items-center justify-between gap-2 text-2xs"
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={cx(
                    'inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full text-[8px] font-bold',
                    g.ok ? 'bg-up/20 text-up' : 'bg-warn/20 text-warn'
                  )}
                  aria-hidden
                >
                  {g.ok ? '✓' : '!'}
                </span>
                <span className={g.ok ? 'text-slate-400' : 'text-slate-200'}>{g.label}</span>
              </span>
              <span className={cx('tnum', g.ok ? 'text-slate-600' : 'text-warn')}>
                {g.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {blocking.length > 0 ? (
        <div className="flex flex-wrap gap-1 border-t border-base-700/60 pt-2">
          {blocking.map((r) => (
            <span
              key={r}
              className="rounded border border-warn/30 bg-warn/10 px-1.5 py-0.5 text-2xs text-warn"
            >
              {REJECT_LABELS[r]}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Cell({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'up' | 'muted';
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] text-slate-500">{label}</div>
      <div
        className={cx(
          'tnum truncate text-xs font-semibold',
          tone === 'up' ? 'text-up' : tone === 'muted' ? 'text-slate-400' : 'text-slate-100'
        )}
      >
        {value}
      </div>
    </div>
  );
}
