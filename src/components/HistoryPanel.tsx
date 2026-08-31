'use client';

import { useEffect, useState } from 'react';
import { cx, pct, signed, time } from '@/lib/format';
import type { LogLine, Position } from '@/lib/types';

/** Positions and the activity log, tucked behind one button — the main screen belongs to the chart. */
export function HistoryPanel({
  positions,
  logs,
  onClose,
}: {
  positions: Position[];
  logs: LogLine[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'positions' | 'log'>('positions');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-b-none sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--line)] bg-[var(--card)] px-5 py-3.5">
          <div className="flex items-center gap-1 rounded-lg bg-[var(--chip)] p-0.5">
            <button
              className={cx(
                'rounded-md px-2.5 py-1 text-xs font-semibold uppercase tracking-wide transition-colors',
                tab === 'positions' ? 'bg-[var(--card)] text-[var(--text)] shadow-sm' : 'text-[var(--muted)]'
              )}
              onClick={() => setTab('positions')}
            >
              Positions
            </button>
            <button
              className={cx(
                'rounded-md px-2.5 py-1 text-xs font-semibold uppercase tracking-wide transition-colors',
                tab === 'log' ? 'bg-[var(--card)] text-[var(--text)] shadow-sm' : 'text-[var(--muted)]'
              )}
              onClick={() => setTab('log')}
            >
              Activity
            </button>
          </div>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="overflow-y-auto">
          {tab === 'positions' ? (
            positions.length === 0 ? (
              <p className="p-5 text-xs text-[var(--muted)]">Nothing yet.</p>
            ) : (
              [...positions].reverse().map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-2.5 text-sm last:border-0"
                >
                  <span className="num w-16 shrink-0 text-xs text-[var(--muted)]">{time(p.openedAt)}</span>
                  <span
                    className={cx(
                      'w-16 shrink-0 text-xs font-semibold',
                      p.direction === 'LONG' ? 'text-[var(--up)]' : 'text-[var(--down)]'
                    )}
                  >
                    {p.direction}
                    {p.leverage > 1 ? ` ${p.leverage}x` : ''}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">
                    triggered at {pct(p.triggerProb, 1)}
                    {p.status === 'OPEN' ? ' · still open' : ''}
                  </span>
                  <span
                    className={cx(
                      'num shrink-0 text-sm font-semibold',
                      p.pnl == null ? 'text-[var(--muted)]' : p.pnl >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]'
                    )}
                  >
                    {p.pnl == null ? '—' : signed(p.pnl)}
                  </span>
                </div>
              ))
            )
          ) : logs.length === 0 ? (
            <p className="p-5 text-xs text-[var(--muted)]">Nothing yet.</p>
          ) : (
            <div className="px-5 py-3">
              {[...logs].reverse().map((l) => (
                <div key={l.id} className="flex gap-3 py-0.5 text-xs">
                  <span className="num shrink-0 text-[var(--muted)]">{time(l.t)}</span>
                  <span
                    className={cx(
                      l.level === 'error' && 'text-[var(--down)]',
                      l.level === 'warn' && 'text-[var(--warn)]',
                      l.level === 'trade' && 'text-[var(--accent)]',
                      l.level === 'info' && 'text-[var(--muted)]'
                    )}
                  >
                    {l.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
