'use client';

import { useEffect, useState } from 'react';
import { useEngine } from '@/hooks/useEngine';
import { WINDOW_SEC, CALIBRATION_MIN_SEC } from '@/lib/config';
import { PriceChart, ProbChart } from '@/components/Charts';
import { Settings } from '@/components/Settings';
import { clock, cx, pct, pts, signed, time, usd } from '@/lib/format';
import type { BarrierSource, Quote, Side } from '@/lib/types';

export default function App() {
  const v = useEngine();
  const { snapshot: s, config, health } = v;
  const [showSettings, setShowSettings] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // Tick once a second so the countdown stays honest between engine updates.
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(id);
  }, []);

  if (v.needsToken) return <TokenGate onSubmit={v.setToken} />;

  const c = s.cycle;
  const live = config.mode === 'LIVE';
  const calibrating = c.phase === 'calibrating';

  return (
    <main className="mx-auto flex min-h-screen max-w-[880px] flex-col gap-4 px-4 pb-16 pt-5">
      {/* ── Bar ─────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent)] text-[13px] font-bold text-white">
            V
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Vision</span>
          <span
            className={cx(
              'rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
              live ? 'bg-[var(--down-bg)] text-[var(--down)]' : 'bg-[var(--accent-bg)] text-[var(--accent)]'
            )}
          >
            {config.mode}
          </span>
        </div>

        <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <span
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              s.connected ? 'bg-[var(--up)]' : s.running ? 'bg-[var(--warn)]' : 'bg-[var(--line)]'
            )}
          />
          {s.connected ? 'live' : s.running ? 'connecting' : 'offline'}
        </span>

        <span
          className="flex items-center gap-1.5 text-xs text-[var(--muted)]"
          title="Polymarket's own live Chainlink relay — the exact source it settles on, and the only price source anywhere in this app"
        >
          <span className={cx('h-1.5 w-1.5 rounded-full', s.chainlinkLive ? 'bg-[var(--up)]' : 'bg-[var(--line)]')} />
          Chainlink {s.chainlinkLive ? 'live' : 'offline'}
        </span>

        <div className="ml-auto flex items-center gap-2">
          <button className="btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          {s.running ? (
            <button className="btn" onClick={v.stop}>
              Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={v.start} disabled={config.killSwitch}>
              Start
            </button>
          )}
          <button
            className={cx('btn', config.killSwitch ? 'btn-warn' : 'btn-danger')}
            onClick={() => void v.kill(!config.killSwitch)}
          >
            {config.killSwitch ? 'Reset stop' : 'Stop all'}
          </button>
        </div>
      </header>

      {v.error ? <Banner tone="down">Can’t reach the server: {v.error}</Banner> : null}
      {s.feedError ? <Banner tone="warn">Price feed: {s.feedError}</Banner> : null}
      {config.killSwitch ? <Banner tone="down">Stopped. Nothing will trade until you reset.</Banner> : null}

      {calibrating ? (
        <section className="card p-5">
          <div className="label">Calibrating</div>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="num text-[34px] font-semibold leading-none">
              {clock(s.calibratingSecondsLeft)}
            </span>
            <span className="text-sm text-[var(--muted)]">left</span>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
            There is no seeded history — the price tape is built entirely from what has actually
            been observed since you pressed Start. It won’t trade its first window until it has
            gathered {CALIBRATION_MIN_SEC / 60} minute{CALIBRATION_MIN_SEC === 60 ? '' : 's'} of real ticks, so the volatility estimate
            behind every probability is real rather than a generic placeholder.
          </p>
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-1000"
              style={{
                width: `${Math.min(100, Math.max(0, (1 - (s.calibratingSecondsLeft ?? CALIBRATION_MIN_SEC) / CALIBRATION_MIN_SEC) * 100))}%`,
              }}
            />
          </div>
        </section>
      ) : null}

      {/* ── The window ──────────────────────────────────────── */}
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="label">Bitcoin</div>
            <div className="mt-0.5 flex items-baseline gap-3">
              <span className="num text-[34px] font-semibold leading-none">
                {s.price ? usd(s.price) : '—'}
              </span>
              {c.barrier && s.price ? (
                <span
                  className={cx(
                    'num text-base font-semibold',
                    s.price > c.barrier ? 'text-[var(--up)]' : 'text-[var(--down)]'
                  )}
                >
                  {s.price > c.barrier ? '+' : '−'}${Math.abs(s.price - c.barrier).toFixed(2)}
                </span>
              ) : null}
            </div>
            {c.barrier ? (
              <div className="num mt-1 text-xs text-[var(--muted)]">
                needs to beat {usd(c.barrier)}
                {c.barrierSource ? ` · ${barrierSourceLabel(c.barrierSource)}` : ''}
              </div>
            ) : null}
            {s.price ? (
              <div className="num mt-1 text-xs text-[var(--muted)]">
                {s.priceSource ? barrierSourceLabel(s.priceSource) : ''}, updated{' '}
                {Math.max(0, Math.round((Date.now() - s.priceAt) / 1000))}s ago
              </div>
            ) : null}
          </div>

          <div className="text-right">
            <div className="label">{c.market ? 'Closes in' : 'Next window'}</div>
            <div className="num mt-0.5 text-[34px] font-semibold leading-none">
              {c.market ? clock(s.secondsLeft) : clock(s.secondsToOpen)}
            </div>
            <div className="mt-1 text-xs text-[var(--muted)]">{phaseLabel(s)}</div>
          </div>
        </div>

        {c.market ? (
          <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-[var(--line)]">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-500"
              style={{
                width: `${Math.min(100, Math.max(0, ((WINDOW_SEC - (s.secondsLeft ?? 0)) / WINDOW_SEC) * 100))}%`,
              }}
            />
          </div>
        ) : null}

        {s.running && !calibrating ? (
          <div className="mt-4 flex items-center gap-6 border-t border-[var(--line)] pt-4">
            <OrderBookSide side="UP" quote={s.quotes.up} />
            <OrderBookSide side="DOWN" quote={s.quotes.down} />
          </div>
        ) : null}

        {s.running ? (
          <div className="mt-4">
            <PriceChart
              ticks={s.ticks}
              barrier={c.barrier}
              startMs={c.market?.startMs ?? null}
              endMs={c.market?.endMs ?? null}
            />
          </div>
        ) : (
          <p className="mt-4 border-t border-[var(--line)] pt-4 text-sm leading-relaxed text-[var(--muted)]">
            Press <strong className="text-[var(--text)]">Start</strong> and it spends
            {' '}{CALIBRATION_MIN_SEC / 60} minute{CALIBRATION_MIN_SEC === 60 ? '' : 's'} gathering real price data, then waits for the
            next 5-minute window to open — it never joins one already running. The barrier is
            read from Polymarket’s own settlement source, never guessed, and a driftless
            Monte Carlo simulation re-checks the odds against the live price every second. It
            buys only when that beats the market’s own price by enough to be worth it.
          </p>
        )}
      </section>

      {/* ── The read ────────────────────────────────────────── */}
      {s.running && !calibrating ? (
        <section className="card p-5">
          {!c.sim ? (
            <div className="py-6 text-center text-sm text-[var(--muted)]">
              The simulation starts the moment a window opens.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="label">Monte Carlo read</span>
                <span className="num text-sm text-[var(--muted)]">
                  {s.volPct ? `${s.volPct.toFixed(0)}% volatility — avg of the last 10×15s candles` : ''}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3">
                <SideRead side="UP" prob={c.sim.pUp} ask={c.askUp} edge={c.edgeUp} minEdge={config.minEdge} />
                <SideRead
                  side="DOWN"
                  prob={1 - c.sim.pUp}
                  ask={c.askDown}
                  edge={c.edgeDown}
                  minEdge={config.minEdge}
                />
              </div>

              <div className="mt-4">
                <ProbChart track={c.track} startMs={c.market?.startMs ?? null} />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                {c.tradeId && c.tradeId !== 'pending' ? (
                  <Chip tone="up">In position</Chip>
                ) : (c.edgeUp !== null && c.edgeUp > config.minEdge) ||
                  (c.edgeDown !== null && c.edgeDown > config.minEdge) ? (
                  <Chip tone="up">
                    Edge found — buying {c.edgeUp !== null && c.edgeUp >= (c.edgeDown ?? -Infinity) ? 'UP' : 'DOWN'}
                  </Chip>
                ) : (
                  <Chip tone="muted">{c.skipReason ?? 'Watching'}</Chip>
                )}
              </div>
            </>
          )}
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
        <Figure label="All time" value={signed(s.stats.pnl)} hint={`${s.stats.trades} trades`} />
        <Figure
          label="Win rate"
          value={s.stats.wins + s.stats.losses > 0 ? pct(s.stats.winRate) : '—'}
          hint={`${s.stats.wins}W ${s.stats.losses}L`}
        />
        <Figure
          label="Calibration"
          value={s.stats.scored >= 5 ? s.stats.brier!.toFixed(3) : '—'}
          hint={s.stats.scored >= 5 ? `Brier · ${s.stats.scored} windows` : 'needs 5+ windows'}
        />
      </section>

      {/* ── History ─────────────────────────────────────────── */}
      {s.windows.length > 0 ? (
        <section className="card overflow-hidden">
          <div className="border-b border-[var(--line)] px-5 py-3">
            <span className="label">Recent windows</span>
          </div>
          <div className="max-h-[300px] overflow-y-auto">
            {[...s.windows].reverse().slice(0, 40).map((w) => (
              <div
                key={w.id}
                className="flex items-center gap-3 border-b border-[var(--line)] px-5 py-2.5 text-sm last:border-0"
                title={
                  w.close !== null
                    ? `${usd(w.barrier)} (${barrierSourceLabel(w.barrierSource)}) → ${usd(w.close)}` +
                      (w.closeSource ? ` (${barrierSourceLabel(w.closeSource)})` : '')
                    : undefined
                }
              >
                <span className="num w-16 shrink-0 text-xs text-[var(--muted)]">
                  {time(w.startMs)}
                </span>
                <span
                  className={cx(
                    'w-12 shrink-0 text-xs font-semibold',
                    w.outcome === 'UP' ? 'text-[var(--up)]' : 'text-[var(--down)]'
                  )}
                >
                  {w.outcome ?? '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted)]">
                  {w.finalPUp != null ? (
                    <>
                      simulated {pct(w.finalPUp)} UP
                      {w.outcome ? ((w.finalPUp >= 0.5) === (w.outcome === 'UP') ? ' ✓' : ' ✗') : ''}
                    </>
                  ) : (
                    (w.skipReason ?? 'no read')
                  )}
                </span>
                <span
                  className={cx(
                    'num shrink-0 text-sm font-semibold',
                    w.pnl == null
                      ? 'text-[var(--muted)]'
                      : w.pnl >= 0
                        ? 'text-[var(--up)]'
                        : 'text-[var(--down)]'
                  )}
                >
                  {w.pnl == null ? '—' : signed(w.pnl)}
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
        Every price on this screen — the barrier, the running display, the volatility estimate,
        the close — comes from the same tape: Polymarket’s own live Chainlink relay, the exact
        source these markets settle on, falling back to the on-chain Chainlink read only when the
        relay has nothing fresh. No other exchange’s data is ever blended in anywhere. There is no
        forecasting model — only a driftless Monte Carlo over realised volatility. Paper mode
        simulates fills against the real order book. Not financial advice.
      </p>

      {showSettings ? (
        <Settings
          config={config}
          health={health}
          onChange={v.update}
          onReset={v.reset}
          onClose={() => setShowSettings(false)}
        />
      ) : null}
    </main>
  );
}

function SideRead({
  side,
  prob,
  ask,
  edge,
  minEdge,
}: {
  side: Side;
  prob: number;
  ask: number | null;
  edge: number | null;
  minEdge: number;
}) {
  const tone = side === 'UP' ? 'text-[var(--up)]' : 'text-[var(--down)]';
  return (
    <div className="rounded-lg border border-[var(--line)] p-3">
      <div className="flex items-baseline justify-between">
        <span className={cx('text-xs font-semibold', tone)}>{side}</span>
        <span className="num text-lg font-bold">{pct(prob, 1)}</span>
      </div>
      <div className="mt-1 flex items-baseline justify-between text-xs text-[var(--muted)]">
        <span>market {ask != null ? pct(ask, 0) : '—'}</span>
        <span className={edge !== null && edge > minEdge ? 'font-semibold text-[var(--up)]' : ''}>
          edge {pts(edge)}
        </span>
      </div>
    </div>
  );
}

function barrierSourceLabel(s: BarrierSource): string {
  return s === 'chainlink-live' ? "Polymarket's live relay" : 'on-chain Chainlink';
}

function phaseLabel(s: ReturnType<typeof useEngine>['snapshot']): string {
  if (!s.running) return 'stopped';
  switch (s.cycle.phase) {
    case 'calibrating':
      return 'calibrating';
    case 'waiting-for-window':
      return s.secondsToOpen != null ? 'waiting for a fresh window' : 'looking for the next window';
    case 'tracking':
      return 'tracking';
    case 'in-position':
      return 'holding a position';
    case 'settling':
      return 'settling';
    default:
      return '';
  }
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
        tone === 'down'
          ? 'bg-[var(--down-bg)] text-[var(--down)]'
          : 'bg-[var(--warn-bg)] text-[var(--warn)]'
      )}
    >
      {children}
    </div>
  );
}

/** The current buy price for one side of the market — what a share costs right now. */
function OrderBookSide({ side, quote }: { side: Side; quote: Quote }) {
  const up = side === 'UP';
  const color = up ? 'text-[var(--up)]' : 'text-[var(--down)]';
  return (
    <div className="flex items-baseline gap-2">
      <span className={cx('text-xs font-semibold', color)}>{side}</span>
      {quote.ask !== null ? (
        <>
          <span className="num text-lg font-semibold leading-none">
            {(quote.ask * 100).toFixed(0)}¢
          </span>
          <span className="text-[11px] text-[var(--muted)]">
            to buy
            {quote.bid !== null ? ` · ${(quote.bid * 100).toFixed(0)}¢ bid` : ''}
          </span>
        </>
      ) : (
        <span className="text-xs text-[var(--muted)]">no offers</span>
      )}
    </div>
  );
}

function TokenGate({ onSubmit }: { onSubmit: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <main className="grid min-h-screen place-items-center px-6">
      <form
        className="card w-full max-w-sm space-y-3 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value.trim());
        }}
      >
        <h1 className="text-base font-semibold">Enter access token</h1>
        <p className="text-xs text-[var(--muted)]">
          This deployment is protected. The token stays in this tab and is sent as a header.
        </p>
        <input
          type="password"
          className="input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn btn-primary w-full justify-center py-2">
          Unlock
        </button>
      </form>
    </main>
  );
}
