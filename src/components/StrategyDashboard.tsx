'use client';

import { useEffect, useState } from 'react';
import { useBot } from '@/hooks/useBot';
import { useEngineContext } from '@/components/EngineProvider';
import { CYCLE_SEC, HISTORY_SEC, TAKER_FEE_RATE } from '@/lib/config';
import { strategyDef } from '@/lib/strategies';
import { CycleChart } from '@/components/Charts';
import { Settings } from '@/components/Settings';
import { clock, cx, pct, signed, time, usd } from '@/lib/format';
import type { Position, StrategyId } from '@/lib/types';

export function StrategyDashboard({ strategyId }: { strategyId: StrategyId }) {
  const s = useBot(strategyId);
  const v = useEngineContext();
  const def = strategyDef(strategyId);
  const config = s.config;
  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // Tick twice a second so the countdown and elapsed-time reads stay honest
  // between engine updates.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  const distance = s.price !== null && s.cycleStartPrice !== null ? s.price - s.cycleStartPrice : null;
  const secondsToRoll = s.elapsedSec !== null ? Math.max(0, CYCLE_SEC - s.elapsedSec) : null;
  const signalNow = s.tailProb !== null && s.tailProb < config.unlikeliness;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold">{def.name}</h1>
          <p className="text-xs text-[var(--muted)]">{def.blurb}</p>
        </div>
        <button className="btn shrink-0" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </div>

      {v.error ? <Banner tone="down">Can’t reach the server: {v.error}</Banner> : null}
      {s.feedError ? <Banner tone="warn">Price feed: {s.feedError}</Banner> : null}
      {config.killSwitch ? <Banner tone="down">Stopped. Nothing will trade until you reset.</Banner> : null}

      {/* ── The cycle ───────────────────────────────────────── */}
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="label">Bitcoin</div>
            <div className="mt-0.5 flex items-baseline gap-3">
              <span className="num text-[34px] font-semibold leading-none">{s.price ? usd(s.price) : '—'}</span>
              {distance !== null ? (
                <span
                  className={cx('num text-base font-semibold', distance >= 0 ? 'text-[var(--up)]' : 'text-[var(--down)]')}
                >
                  {distance >= 0 ? '+' : '−'}${Math.abs(distance).toFixed(2)}
                </span>
              ) : null}
            </div>
            {s.cycleStartPrice !== null ? (
              <div className="num mt-1 text-xs text-[var(--muted)]">from {usd(s.cycleStartPrice)} this cycle</div>
            ) : null}
            {s.price ? (
              <div className="num mt-1 text-xs text-[var(--muted)]">
                Binance, updated {Math.max(0, Math.round((Date.now() - s.priceAt) / 1000))}s ago
              </div>
            ) : null}
          </div>

          <div className="text-right">
            <div className="label">Next cycle in</div>
            <div className="num mt-0.5 text-[34px] font-semibold leading-none">{clock(secondsToRoll)}</div>
            <div className="mt-1 text-xs text-[var(--muted)]">{phaseLabel(s)}</div>
          </div>
        </div>

        {secondsToRoll !== null ? (
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
              style={{ width: `${Math.min(100, Math.max(0, ((CYCLE_SEC - secondsToRoll) / CYCLE_SEC) * 100))}%` }}
            />
          </div>
        ) : null}

        {s.running ? (
          <div className="mt-4">
            <CycleChart
              ticks={s.ticks}
              cycleStart={s.cycleStart}
              cycleStartPrice={s.cycleStartPrice}
              band={s.band}
              closeAtSecond={config.closeAtSecond}
              position={s.position}
            />
          </div>
        ) : (
          <p className="mt-4 border-t border-[var(--line)] pt-4 text-sm leading-relaxed text-[var(--muted)]">
            Press <strong className="text-[var(--text)]">Start</strong> and every {CYCLE_SEC} seconds it takes the
            live Binance price as a fresh reference, simulates 10,000 random paths forward from it using the
            realised volatility of the last {HISTORY_SEC} one-second prices, and watches whether the actual price
            strays further than the simulation thinks is likely. {def.blurb}
          </p>
        )}
      </section>

      {/* ── The read ────────────────────────────────────────── */}
      {s.running ? (
        <section className="card p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="label">Live read</span>
            <span className="num text-sm text-[var(--muted)]">
              {s.volPct ? `${s.volPct.toFixed(0)}% volatility — realised, last ${HISTORY_SEC}s` : ''}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-[var(--line)] p-3">
              <div className="label">Current probability</div>
              <div
                className={cx(
                  'num mt-1 text-2xl font-bold',
                  signalNow ? 'text-[var(--down)]' : 'text-[var(--text)]'
                )}
              >
                {s.tailProb !== null ? pct(s.tailProb, 1) : '—'}
              </div>
              <div className="mt-0.5 text-xs text-[var(--muted)]">
                triggers a trade below {pct(config.unlikeliness, 0)}
              </div>
            </div>
            <div className="rounded-lg border border-[var(--line)] p-3">
              <div className="label">{s.position ? 'Open position' : 'Position'}</div>
              {s.position ? (
                <PositionRead position={s.position} price={s.price} />
              ) : (
                <div className="num mt-1 text-2xl font-bold text-[var(--muted)]">none</div>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            {s.busy ? (
              <Chip tone="muted">{s.busy === 'opening' ? 'Opening…' : 'Closing…'}</Chip>
            ) : s.position ? (
              <Chip tone="up">In position — {s.position.direction}</Chip>
            ) : signalNow ? (
              <Chip tone="up">
                Signal found — {s.price !== null && s.cycleStartPrice !== null && s.price > s.cycleStartPrice ? 'selling (SHORT)' : 'buying (LONG)'}
              </Chip>
            ) : (
              <Chip tone="muted">{s.skipReason ?? 'Watching'}</Chip>
            )}
          </div>
        </section>
      ) : null}

      {/* ── Today ───────────────────────────────────────────── */}
      <section className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
        <Figure
          label="Today"
          value={signed(s.stats.today)}
          tone={s.stats.today > 0 ? 'up' : s.stats.today < 0 ? 'down' : 'muted'}
          strong
        />
        <Figure label="All time" value={signed(s.stats.pnl)} hint={`${s.stats.positions} positions`} />
        <Figure
          label="Win rate"
          value={s.stats.wins + s.stats.losses > 0 ? pct(s.stats.winRate) : '—'}
          hint={`${s.stats.wins}W ${s.stats.losses}L`}
        />
        <Figure label="Cycles" value={String(s.stats.cycles)} hint={`${CYCLE_SEC}s each`} />
      </section>

      {/* ── History ─────────────────────────────────────────── */}
      {s.positions.length > 0 ? (
        <section className="card overflow-hidden">
          <div className="border-b border-[var(--line)] px-5 py-3">
            <span className="label">Recent positions</span>
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {[...s.positions].reverse().slice(0, 40).map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-2.5 text-sm last:border-0"
                title={
                  p.closePrice !== null ? `${usd(p.openPrice)} → ${usd(p.closePrice)}` : `opened at ${usd(p.openPrice)}`
                }
              >
                <span className="num w-16 shrink-0 text-xs text-[var(--muted)]">{time(p.openedAt)}</span>
                <span
                  className={cx(
                    'w-14 shrink-0 text-xs font-semibold',
                    p.direction === 'LONG' ? 'text-[var(--up)]' : 'text-[var(--down)]'
                  )}
                >
                  {p.direction}
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
            ))}
          </div>
        </section>
      ) : null}

      {/* ── Log ─────────────────────────────────────────────── */}
      <section className="card overflow-hidden">
        <button
          className="flex w-full items-center justify-between px-5 py-3 text-left"
          onClick={() => setShowLog((x) => !x)}
        >
          <span className="label">Activity</span>
          <span className="text-xs text-[var(--muted)]">{showLog ? 'hide' : 'show'}</span>
        </button>
        {showLog ? (
          <div className="max-h-[260px] overflow-y-auto border-t border-[var(--line)] px-5 py-3">
            {s.logs.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">Nothing yet.</p>
            ) : (
              [...s.logs].reverse().map((l) => (
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
              ))
            )}
          </div>
        ) : null}
      </section>

      <p className="px-1 text-center text-xs leading-relaxed text-[var(--muted)]">
        Every {CYCLE_SEC} seconds, a fresh driftless Monte Carlo simulates 10,000 paths from the live Binance price,
        shared by every bot. {def.blurb} Paper trading only, fills walked against Binance's real order book. Not
        financial advice.
      </p>

      {showSettings ? (
        <Settings
          strategyName={def.name}
          config={config}
          health={v.health}
          onChange={(patch) => v.update(strategyId, patch)}
          onReset={() => v.reset(strategyId)}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
    </>
  );
}

function PositionRead({ position, price }: { position: Position; price: number | null }) {
  const unrealized =
    price !== null
      ? (position.direction === 'LONG'
          ? (price - position.openPrice) * position.qty
          : (position.openPrice - price) * position.qty) -
        (position.openPrice + price) * position.qty * TAKER_FEE_RATE
      : null;
  return (
    <>
      <div
        className={cx(
          'num mt-1 text-2xl font-bold',
          position.direction === 'LONG' ? 'text-[var(--up)]' : 'text-[var(--down)]'
        )}
      >
        {position.direction}
      </div>
      <div className="mt-0.5 text-xs text-[var(--muted)]">
        {position.qty.toFixed(5)} BTC at {usd(position.openPrice)}
        {unrealized !== null ? ` · ${signed(unrealized)} unrealised, after fees` : ''}
      </div>
    </>
  );
}

function phaseLabel(s: ReturnType<typeof useBot>): string {
  if (!s.running) return 'stopped';
  if (s.cycleStartPrice === null) return 'waiting for a price';
  if (s.busy === 'opening') return 'opening a position';
  if (s.busy === 'closing') return 'closing a position';
  if (s.position) return 'holding a position';
  return 'watching';
}

function Figure({
  label,
  value,
  hint,
  tone,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'up' | 'down' | 'muted';
  strong?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="label">{label}</div>
      <div
        className={cx(
          'num mt-0.5 font-semibold leading-tight',
          strong ? 'text-[26px]' : 'text-[22px]',
          tone === 'up' && 'text-[var(--up)]',
          tone === 'down' && 'text-[var(--down)]',
          tone === 'muted' && 'text-[var(--muted)]'
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-0.5 truncate text-[11px] text-[var(--muted)]">{hint}</div> : null}
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone: 'up' | 'muted' }) {
  return (
    <span
      className={cx(
        'rounded-md px-2 py-1 text-xs font-medium',
        tone === 'up' ? 'bg-[var(--up-bg)] text-[var(--up)]' : 'bg-[var(--chip)] text-[var(--muted)]'
      )}
    >
      {children}
    </span>
  );
}

function Banner({ children, tone }: { children: React.ReactNode; tone: 'warn' | 'down' }) {
  return (
    <div
      className={cx(
        'rounded-lg px-4 py-2.5 text-sm',
        tone === 'down' ? 'bg-[var(--down-bg)] text-[var(--down)]' : 'bg-[var(--warn-bg)] text-[var(--warn)]'
      )}
    >
      {children}
    </div>
  );
}
