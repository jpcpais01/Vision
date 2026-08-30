'use client';

import { useEffect, useState } from 'react';
import { useEngine } from '@/hooks/useEngine';
import { WINDOW_SEC } from '@/lib/config';
import { PriceChart, ProbChart } from '@/components/Charts';
import { Settings } from '@/components/Settings';
import { clock, cx, pct, pts, signed, time, usd } from '@/lib/format';

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
      {health && !health.capabilities.llm ? (
        <Banner tone="warn">
          No <code>OPENROUTER_API_KEY</code> set — the model can’t be asked, so nothing will trade.
        </Banner>
      ) : null}
      {config.killSwitch ? <Banner tone="down">Stopped. Nothing will trade until you reset.</Banner> : null}

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
            Press <strong className="text-[var(--text)]">Start</strong> and it waits for the next
            5-minute window to open — it never joins one already running. At the open it asks the
            model which way Bitcoin goes, then re-checks that answer against the live price every
            second, and buys only when it is far enough ahead of the market price.
          </p>
        )}
      </section>

      {/* ── The call ────────────────────────────────────────── */}
      {s.running ? (
      <section className="card p-5">
        {!c.forecast && !c.forecastError ? (
          <div className="py-6 text-center text-sm text-[var(--muted)]">
            {c.phase === 'forecasting'
              ? 'Asking the model…'
              : 'The model is asked once, the moment a new window opens.'}
          </div>
        ) : c.forecastError ? (
          <div className="text-sm text-[var(--down)]">
            Model didn’t answer: {c.forecastError}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="label">Model called</span>
              <span
                className={cx(
                  'num text-lg font-bold',
                  c.forecast!.side === 'UP' ? 'text-[var(--up)]' : 'text-[var(--down)]'
                )}
              >
                {c.forecast!.side}
              </span>
              <span className="num text-sm text-[var(--muted)]">
                at {pct(c.forecast!.probability)} · {(c.forecast!.latencyMs / 1000).toFixed(1)}s
              </span>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-3">
              <Figure
                label="Our probability"
                value={pct(c.ourProb, 1)}
                hint="updated every second"
                strong
              />
              <Figure
                label="Market charges"
                value={pct(c.marketProb, 1)}
                hint={c.marketProb ? `${c.marketProb.toFixed(3)} per share` : 'no offers'}
              />
              <Figure
                label="Edge"
                value={pts(c.edge)}
                hint={`need +${(config.minEdge * 100).toFixed(0)}%`}
                tone={c.edge !== null && c.edge > config.minEdge ? 'up' : 'muted'}
              />
            </div>

            <div className="mt-4">
              <ProbChart track={c.track} startMs={c.market?.startMs ?? null} />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              {c.tradeId && c.tradeId !== 'pending' ? (
                <Chip tone="up">In position</Chip>
              ) : c.edge !== null && c.edge > config.minEdge ? (
                <Chip tone="up">Edge found — buying {c.forecast!.side}</Chip>
              ) : (
                <Chip tone="muted">{c.skipReason ?? 'Watching'}</Chip>
              )}
              {s.volPct ? (
                <span className="num text-[var(--muted)]">volatility {s.volPct.toFixed(0)}%</span>
              ) : null}
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
        <Figure label="Windows seen" value={String(s.stats.windows)} hint="traded or not" />
      </section>

      {/* ── Does the model help? ────────────────────────────── */}
      {s.stats.scored >= 5 ? <ModelCheck stats={s.stats} /> : null}

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
                  {w.llmSide ? (
                    <>
                      called {w.llmSide} {w.llmProb ? pct(w.llmProb) : ''}
                      {w.outcome ? (w.llmSide === w.outcome ? ' ✓' : ' ✗') : ''}
                    </>
                  ) : (
                    (w.skipReason ?? 'no call')
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
        Prices from Binance, anchored to Chainlink's on-chain oracle at the open of each
        window. Paper mode simulates fills against the real order book. Not financial advice.
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

/** Is the model actually adding anything? Answered with the record, not opinion. */
function ModelCheck({ stats }: { stats: { brierWithLlm: number | null; brierNeutral: number | null; llmAccuracy: number | null; scored: number } }) {
  const withLlm = stats.brierWithLlm;
  const neutral = stats.brierNeutral;
  if (withLlm == null || neutral == null) return null;

  const better = neutral - withLlm; // positive means the model helped
  const thin = stats.scored < 30;

  return (
    <section className="card p-5">
      <div className="label">Is the model helping?</div>
      <p className="mt-2 text-sm">
        {thin ? (
          <>
            Too early to say — {stats.scored} windows scored. Come back after 30 or so.
          </>
        ) : better > 0.005 ? (
          <>
            <strong className="text-[var(--up)]">Yes, a little.</strong> Its calls score better
            than the same simulation run without them.
          </>
        ) : better < -0.005 ? (
          <>
            <strong className="text-[var(--down)]">No.</strong> The simulation scores better
            ignoring the model. Consider dropping the model’s weight to 0 in Settings.
          </>
        ) : (
          <>
            <strong>No difference.</strong> The model’s calls score the same as ignoring them —
            the edge, if any, is coming from the volatility maths.
          </>
        )}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3">
        <Figure label="With model" value={withLlm.toFixed(3)} hint="lower is better" />
        <Figure label="Ignoring it" value={neutral.toFixed(3)} hint="same windows" />
        <Figure
          label="Direction right"
          value={stats.llmAccuracy != null ? pct(stats.llmAccuracy) : '—'}
          hint="coin flip is 50%"
        />
      </div>
    </section>
  );
}

function phaseLabel(s: ReturnType<typeof useEngine>['snapshot']): string {
  if (!s.running) return 'stopped';
  switch (s.cycle.phase) {
    case 'waiting-for-window':
      return s.secondsToOpen != null ? 'waiting for a fresh window' : 'looking for the next window';
    case 'forecasting':
      return 'asking the model';
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
