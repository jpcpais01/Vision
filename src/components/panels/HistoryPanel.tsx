'use client';

import { useMemo, useState } from 'react';
import type { CycleRecord } from '@/lib/types';
import { REJECT_LABELS } from '@/lib/engine/risk';
import { Badge, Empty } from '@/components/ui/Primitives';
import { cx, dateTime, ms, num, pct, price, signedUsd } from '@/lib/format';

type Filter = 'all' | 'traded' | 'skipped' | 'errors';

/**
 * Every observed window, traded or not.
 *
 * The skipped windows are the more informative half of this table: they show
 * what the model thought, what the market was offering, and which gate stopped
 * the trade — which is how you tell "the thresholds are too tight" apart from
 * "there was genuinely no edge".
 */
export function HistoryPanel({ cycles }: { cycles: CycleRecord[] }) {
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo(() => {
    const sorted = [...cycles].sort((a, b) => b.startMs - a.startMs);
    switch (filter) {
      case 'traded':
        return sorted.filter((c) => c.tradeId !== null);
      case 'skipped':
        return sorted.filter((c) => c.tradeId === null);
      case 'errors':
        return sorted.filter((c) => c.llm === null || c.mc === null);
      default:
        return sorted;
    }
  }, [cycles, filter]);

  const summary = useMemo(() => {
    const resolved = cycles.filter((c) => c.outcome !== null);
    const traded = cycles.filter((c) => c.tradeId !== null);
    const upCount = resolved.filter((c) => c.outcome === 'UP').length;
    const hits = resolved.filter(
      (c) => c.mc && (c.mc.pUp >= 0.5 ? 'UP' : 'DOWN') === c.outcome
    ).length;
    const meanLatency =
      cycles.filter((c) => c.llm).reduce((s, c) => s + (c.llm?.latencyMs ?? 0), 0) /
      Math.max(1, cycles.filter((c) => c.llm).length);
    return {
      observed: cycles.length,
      resolved: resolved.length,
      traded: traded.length,
      upRate: resolved.length > 0 ? upCount / resolved.length : 0,
      directionalHit: resolved.length > 0 ? hits / resolved.length : 0,
      meanLatency,
    };
  }, [cycles]);

  if (cycles.length === 0) {
    return (
      <Empty>
        Completed 5-minute windows are recorded here — including the ones the
        engine declined to trade, and why.
      </Empty>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1">
          {(['all', 'traded', 'skipped', 'errors'] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cx(
                'rounded-md border px-2 py-0.5 text-2xs capitalize transition-colors',
                filter === f
                  ? 'border-accent/50 bg-accent/15 text-accent'
                  : 'border-base-700 text-slate-500 hover:text-slate-300'
              )}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="tnum flex flex-wrap gap-x-3 text-2xs text-slate-500">
          <span>{summary.observed} observed</span>
          <span>{summary.traded} traded</span>
          <span title="Share of resolved windows that finished UP">
            {pct(summary.upRate, 0)} up
          </span>
          <span title="Share of resolved windows where the model's majority side was correct">
            {pct(summary.directionalHit, 0)} directional hit
          </span>
          <span>{ms(summary.meanLatency)} mean LLM</span>
        </div>
      </div>

      <div className="scroll-thin max-h-[360px] overflow-y-auto">
        <table className="w-full text-2xs">
          <thead className="sticky top-0 z-10 bg-base-900/95 backdrop-blur">
            <tr className="text-left text-slate-500">
              <Th>Window</Th>
              <Th right>Barrier</Th>
              <Th right>Close</Th>
              <Th>Result</Th>
              <Th right>LLM</Th>
              <Th right>MC</Th>
              <Th right>Ask UP</Th>
              <Th right>Vol</Th>
              <Th>Action</Th>
              <Th right>P&amp;L</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const mcSide = c.mc ? (c.mc.pUp >= 0.5 ? 'UP' : 'DOWN') : null;
              const correct = mcSide !== null && c.outcome !== null && mcSide === c.outcome;
              return (
                <tr key={c.id} className="border-t border-base-800/70 hover:bg-base-800/40">
                  <Td className="tnum text-slate-400">{dateTime(c.startMs)}</Td>
                  <Td right className="tnum text-slate-300">
                    {c.btcStart.toFixed(1)}
                  </Td>
                  <Td right className="tnum text-slate-300">
                    {c.btcEnd !== null ? c.btcEnd.toFixed(1) : '—'}
                  </Td>
                  <Td>
                    {c.outcome ? (
                      <span
                        className={cx(
                          'font-semibold',
                          c.outcome === 'UP' ? 'text-up' : 'text-down'
                        )}
                      >
                        {c.outcome}
                      </span>
                    ) : (
                      <span className="text-slate-600">—</span>
                    )}
                  </Td>
                  <Td right className="tnum text-slate-400">
                    {c.llm ? pct(c.llm.pUp, 0) : '—'}
                  </Td>
                  <Td
                    right
                    className={cx(
                      'tnum font-medium',
                      c.outcome === null
                        ? 'text-slate-400'
                        : correct
                          ? 'text-up'
                          : 'text-down'
                    )}
                    title={
                      c.outcome === null
                        ? undefined
                        : correct
                          ? 'Model called this window correctly'
                          : 'Model called this window incorrectly'
                    }
                  >
                    {c.mc ? pct(c.mc.pUp, 0) : '—'}
                    {c.outcome !== null && c.mc ? (correct ? ' ✓' : ' ✗') : ''}
                  </Td>
                  <Td right className="tnum text-slate-400">
                    {c.book?.askUp != null ? price(c.book.askUp) : '—'}
                  </Td>
                  <Td right className="tnum text-slate-500">
                    {c.vol ? `${num(c.vol.annualisedPct, 0)}%` : '—'}
                  </Td>
                  <Td>
                    {c.tradeId ? (
                      <Badge tone="accent">
                        {c.decision?.side ?? 'traded'}
                      </Badge>
                    ) : (
                      <span
                        className="text-slate-600"
                        title={c.decision?.reasons.map((r) => REJECT_LABELS[r]).join(', ')}
                      >
                        {c.decision?.reasons.length
                          ? REJECT_LABELS[c.decision.reasons[0]]
                          : 'no action'}
                      </span>
                    )}
                  </Td>
                  <Td
                    right
                    className={cx(
                      'tnum font-semibold',
                      c.pnl === null
                        ? 'text-slate-600'
                        : c.pnl >= 0
                          ? 'text-up'
                          : 'text-down'
                    )}
                  >
                    {c.pnl === null ? '—' : signedUsd(c.pnl)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cx('px-2 py-1.5 font-medium uppercase tracking-wider', right && 'text-right')}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  className,
  title,
}: {
  children: React.ReactNode;
  right?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <td className={cx('px-2 py-1.5', right && 'text-right', className)} title={title}>
      {children}
    </td>
  );
}
