'use client';

import { useEffect, useState } from 'react';
import { useBot } from '@/hooks/useBot';
import { useEngineContext } from '@/components/EngineProvider';
import { CYCLE_SEC, HISTORY_SEC, PATHS } from '@/lib/config';
import { strategyDef } from '@/lib/strategies';
import { CycleChart } from '@/components/Charts';
import { Settings } from '@/components/Settings';
import { HistoryPanel } from '@/components/HistoryPanel';
import { clock, cx, pct, signed, usd } from '@/lib/format';
import type { Busy } from '@/lib/engine';
import type { Position, StrategyId } from '@/lib/types';

/**
 * The chart is the whole point of the screen — everything else is either a
 * thin strip above/below it or a HUD overlay drawn on top, game-style. No
 * section here scrolls the page; the two panels that need room (Settings,
 * History) are modals instead.
 */
export function StrategyDashboard({ strategyId }: { strategyId: StrategyId }) {
  const s = useBot(strategyId);
  const v = useEngineContext();
  const def = strategyDef(strategyId);
  const config = s.config;
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

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
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* ── Top strip ───────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-[13px] font-bold uppercase tracking-wide">{def.name}</h1>
          <p className="truncate text-[11px] text-[var(--muted)]">{def.tagline}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button className="btn" onClick={() => setShowHistory(true)}>
            History
          </button>
          <button className="btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </div>

      {v.error ? <Banner tone="down">Can’t reach the server: {v.error}</Banner> : null}
      {s.feedError ? <Banner tone="warn">Price feed: {s.feedError}</Banner> : null}
      {config.killSwitch ? <Banner tone="down">Stopped. Nothing will trade until you reset.</Banner> : null}

      {/* ── The chart — the star, full bleed, its own always-dark screen ── */}
      <div
        className="relative min-h-0 flex-1 overflow-hidden rounded-2xl"
        style={{ background: '#05070a', color: '#9fb0c9' }}
      >
        {s.running ? (
          <>
            <CycleChart
              ticks={s.ticks}
              cycleStart={s.cycleStart}
              cycleStartPrice={s.cycleStartPrice}
              band={s.band}
              closeAtSecond={config.closeAtSecond}
              position={s.position}
            />

            {/* HUD overlays — game-style corner readouts on the screen itself */}
            <div className="pointer-events-none absolute left-3 top-2.5 flex flex-col items-start gap-2">
              <div>
                <div className="text-[9px] font-semibold uppercase tracking-wider text-[#7c8aa0]">Bitcoin</div>
                <div className="num text-base font-bold text-[#eaf1fb] sm:text-lg">{s.price ? usd(s.price) : '—'}</div>
                {distance !== null ? (
                  <div className={cx('num text-[11px] font-semibold', distance >= 0 ? 'text-[#35e08a]' : 'text-[#ff5d7a]')}>
                    {distance >= 0 ? '+' : '−'}${Math.abs(distance).toFixed(2)}
                  </div>
                ) : null}
              </div>

              {s.position ? <PositionHud position={s.position} price={s.price} busy={s.busy} /> : null}
            </div>

            <div className="pointer-events-none absolute right-3 top-2.5 text-right">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-[#7c8aa0]">Next cycle</div>
              <div className="num text-xl font-bold text-[#eaf1fb] sm:text-2xl">{clock(secondsToRoll)}</div>
              <div className="text-[10px] text-[#7c8aa0]">{phaseLabel(s)}</div>
            </div>

            <div className="pointer-events-none absolute bottom-2.5 left-3">
              <div className="text-[9px] font-semibold uppercase tracking-wider text-[#7c8aa0]">Probability</div>
              <div className={cx('num text-lg font-bold', signalNow ? 'text-[#ff5d7a]' : 'text-[#eaf1fb]')}>
                {s.tailProb !== null ? pct(s.tailProb, 1) : '—'}
              </div>
              <div className="text-[10px] text-[#7c8aa0]">
                {s.busy
                  ? s.busy === 'opening'
                    ? 'opening…'
                    : 'closing…'
                  : signalNow
                    ? 'signal!'
                    : (s.skipReason ?? 'watching')}
              </div>
            </div>
          </>
        ) : (
          <StartPrompt strategyBlurb={def.blurb} />
        )}
      </div>

      {/* ── Stat strip ──────────────────────────────────────── */}
      <div className="grid shrink-0 grid-cols-4 gap-1.5">
        <HudStat
          label="Today"
          value={signed(s.stats.today)}
          tone={s.stats.today > 0 ? 'up' : s.stats.today < 0 ? 'down' : 'muted'}
        />
        <HudStat label="All time" value={signed(s.stats.pnl)} hint={`${s.stats.positions}`} />
        <HudStat label="Win rate" value={s.stats.wins + s.stats.losses > 0 ? pct(s.stats.winRate) : '—'} />
        <HudStat label="Cycles" value={String(s.stats.cycles)} />
      </div>

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

      {showHistory ? (
        <HistoryPanel positions={s.positions} logs={s.logs} onClose={() => setShowHistory(false)} />
      ) : null}
    </div>
  );
}

/** The single most important readout while a position is open: live profit or loss, glowing, on the screen itself. */
function PositionHud({ position, price, busy }: { position: Position; price: number | null; busy: Busy }) {
  const unrealized =
    price !== null
      ? position.direction === 'LONG'
        ? (price - position.openPrice) * position.qty
        : (position.openPrice - price) * position.qty
      : null;
  const openSeconds = Math.max(0, Math.round((Date.now() - position.openedAt) / 1000));
  const winning = unrealized !== null && unrealized >= 0;
  const tone = unrealized === null ? '#9fb0c9' : winning ? '#35e08a' : '#ff5d7a';

  return (
    <div
      className="rounded-xl border-2 px-3 py-2 backdrop-blur-sm"
      style={{
        borderColor: tone,
        background: 'rgba(5, 7, 10, 0.7)',
        boxShadow: `0 0 20px ${tone}66`,
      }}
    >
      <span className="text-[9px] font-semibold uppercase tracking-wider text-[#7c8aa0]">
        {position.direction}
        {position.leverage > 1 ? ` ${position.leverage}x` : ''}
      </span>
      <div className="num text-2xl font-bold leading-none sm:text-[28px]" style={{ color: tone }}>
        {unrealized !== null ? signed(unrealized) : '—'}
      </div>
      <div className="mt-1 text-[10px] text-[#7c8aa0]">
        open {clock(openSeconds)}
        {busy === 'closing' ? ' · closing…' : ''}
      </div>
    </div>
  );
}

function StartPrompt({ strategyBlurb }: { strategyBlurb: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="text-2xl font-bold uppercase tracking-widest text-[#eaf1fb]">Press start</div>
      <p className="max-w-sm text-xs leading-relaxed text-[#7c8aa0]">
        Every {CYCLE_SEC}s it takes the live Binance price as a fresh reference, simulates {PATHS.toLocaleString()}{' '}
        random paths using the realised volatility of the last {HISTORY_SEC}s, and watches whether the price strays
        further than the simulation thinks is likely. {strategyBlurb}
      </p>
    </div>
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

function HudStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'up' | 'down' | 'muted';
}) {
  return (
    <div
      className={cx(
        'hud-tile',
        tone === 'up' && 'hud-tile-up',
        tone === 'down' && 'hud-tile-down'
      )}
    >
      <div className="label truncate">{label}</div>
      <div
        className={cx(
          'num truncate text-base font-bold sm:text-lg',
          tone === 'up' && 'text-[var(--up)]',
          tone === 'down' && 'text-[var(--down)]',
          !tone && 'text-[var(--text)]'
        )}
      >
        {value}
        {hint ? <span className="ml-1 text-[10px] font-normal text-[var(--muted)]">{hint}</span> : null}
      </div>
    </div>
  );
}

function Banner({ children, tone }: { children: React.ReactNode; tone: 'warn' | 'down' }) {
  return (
    <div
      className={cx(
        'shrink-0 rounded-lg px-3 py-1.5 text-xs',
        tone === 'down' ? 'bg-[var(--down-bg)] text-[var(--down)]' : 'bg-[var(--warn-bg)] text-[var(--warn)]'
      )}
    >
      {children}
    </div>
  );
}
