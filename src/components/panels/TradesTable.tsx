'use client';

import { useState } from 'react';
import type { Trade } from '@/lib/types';
import { Badge, Empty } from '@/components/ui/Primitives';
import { cents, cx, price, signedUsd, time, usd } from '@/lib/format';

/** Trade blotter. Every row is one position with the model's view at entry. */
export function TradesTable({ trades }: { trades: Trade[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = [...trades].sort((a, b) => b.t - a.t);

  if (rows.length === 0) {
    return <Empty>No trades yet. Positions appear here the moment one is filled.</Empty>;
  }

  return (
    <div className="scroll-thin max-h-[320px] overflow-y-auto">
      <table className="w-full text-2xs">
        <thead className="sticky top-0 z-10 bg-base-900/95 backdrop-blur">
          <tr className="text-left text-slate-500">
            <Th>Time</Th>
            <Th>Mode</Th>
            <Th>Side</Th>
            <Th right>Size</Th>
            <Th right>Entry</Th>
            <Th right>Model</Th>
            <Th right>Edge</Th>
            <Th right>BTC Δ</Th>
            <Th right>P&amp;L</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const btcMove =
              t.btcSettle !== null ? t.btcSettle - t.btcStart : t.btcEntry - t.btcStart;
            const isOpen = t.status === 'OPEN' || t.status === 'PENDING';
            return (
              <>
                <tr
                  key={t.id}
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                  className="cursor-pointer border-t border-base-800/70 hover:bg-base-800/40"
                >
                  <Td className="tnum text-slate-400">{time(t.t)}</Td>
                  <Td>
                    <span
                      className={cx(
                        'rounded px-1 py-px text-[9px] font-semibold uppercase',
                        t.mode === 'LIVE'
                          ? 'bg-down/15 text-down'
                          : 'bg-base-700 text-slate-400'
                      )}
                    >
                      {t.mode}
                    </span>
                  </Td>
                  <Td>
                    <span
                      className={cx(
                        'font-semibold',
                        t.side === 'UP' ? 'text-up' : 'text-down'
                      )}
                    >
                      {t.side}
                    </span>
                  </Td>
                  <Td right className="tnum text-slate-300">
                    {t.size.toFixed(0)}
                  </Td>
                  <Td right className="tnum text-slate-300">
                    {price(t.entryPrice)}
                  </Td>
                  <Td right className="tnum text-slate-400">
                    {(t.modelP * 100).toFixed(1)}%
                  </Td>
                  <Td right className="tnum text-slate-400">
                    {cents(t.edge)}
                  </Td>
                  <Td
                    right
                    className={cx('tnum', btcMove >= 0 ? 'text-up' : 'text-down')}
                  >
                    {btcMove >= 0 ? '+' : ''}
                    {btcMove.toFixed(1)}
                  </Td>
                  <Td
                    right
                    className={cx(
                      'tnum font-semibold',
                      t.pnl === null
                        ? 'text-slate-500'
                        : t.pnl >= 0
                          ? 'text-up'
                          : 'text-down'
                    )}
                  >
                    {t.pnl === null ? '—' : signedUsd(t.pnl)}
                  </Td>
                  <Td>
                    <StatusBadge status={t.status} open={isOpen} />
                  </Td>
                </tr>
                {expanded === t.id ? (
                  <tr key={`${t.id}-detail`} className="bg-base-950/60">
                    <td colSpan={10} className="px-3 py-2">
                      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
                        <D label="Market" value={t.marketSlug || t.marketId} />
                        <D label="Notional" value={usd(t.notional)} />
                        <D label="LLM P(UP)" value={`${(t.llmP * 100).toFixed(1)}%`} />
                        <D label="Market ask" value={price(t.marketP)} />
                        <D label="BTC at open" value={usd(t.btcStart)} />
                        <D label="BTC at entry" value={usd(t.btcEntry)} />
                        <D
                          label="BTC at close"
                          value={t.btcSettle !== null ? usd(t.btcSettle) : '—'}
                        />
                        <D label="Seconds left" value={`${t.secondsLeftAtEntry.toFixed(0)}s`} />
                        <D
                          label="Fill"
                          value={`${t.fill.filledSize.toFixed(0)}/${t.fill.requestedSize.toFixed(0)} @ ${price(t.fill.avgPrice, 4)}`}
                        />
                        <D label="Slippage" value={cents(t.fill.slippage, 2)} />
                        <D label="Fill latency" value={`${t.fill.latencyMs}ms`} />
                        <D label="Order id" value={t.orderId ?? (t.fill.simulated ? 'simulated' : '—')} />
                        {t.error ? <D label="Error" value={t.error} wide /> : null}
                      </dl>
                    </td>
                  </tr>
                ) : null}
              </>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status, open }: { status: Trade['status']; open: boolean }) {
  if (open) return <Badge tone="accent">open</Badge>;
  if (status === 'WON') return <Badge tone="up">won</Badge>;
  if (status === 'LOST') return <Badge tone="down">lost</Badge>;
  if (status === 'FAILED') return <Badge tone="warn">failed</Badge>;
  return <Badge tone="muted">{status.toLowerCase()}</Badge>;
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={cx(
        'px-2 py-1.5 font-medium uppercase tracking-wider',
        right && 'text-right'
      )}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  className,
}: {
  children: React.ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={cx('px-2 py-1.5', right && 'text-right', className)}>{children}</td>
  );
}

function D({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cx('min-w-0', wide && 'col-span-full')}>
      <dt className="text-[10px] text-slate-500">{label}</dt>
      <dd className="tnum truncate text-2xs text-slate-300" title={value}>
        {value}
      </dd>
    </div>
  );
}
