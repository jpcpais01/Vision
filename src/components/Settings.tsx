'use client';

import { useEffect } from 'react';
import type { Config } from '@/lib/types';
import type { Health } from '@/components/EngineProvider';
import { CYCLE_SEC, ENTRY_MARGIN_SEC, MAX_LEVERAGE, MAX_VOL_WINDOW_SEC, MIN_VOL_WINDOW_SEC } from '@/lib/config';
import { cx } from '@/lib/format';

/** Seven things. If a knob has no clear reason to be turned, it is not here. */
export function Settings({
  strategyName,
  config,
  health,
  onChange,
  onReset,
  onClose,
}: {
  strategyName: string;
  config: Config;
  health: Health | null;
  onChange: (patch: Partial<Config>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
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
        className="card max-h-[88vh] w-full max-w-md overflow-y-auto rounded-b-none sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-[var(--line)] bg-[var(--card)] px-5 py-3.5">
          <h2 className="text-sm font-semibold">{strategyName} settings</h2>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="space-y-5 p-5">
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Trade automatically</span>
              <span className="block text-[11px] text-[var(--muted)]">
                Off means this bot watches and logs, but never buys.
              </span>
            </span>
            <button
              role="switch"
              aria-checked={config.autoTrade}
              disabled={config.killSwitch}
              onClick={() => onChange({ autoTrade: !config.autoTrade })}
              className={cx(
                'relative h-6 w-11 shrink-0 overflow-hidden rounded-full transition-colors',
                config.autoTrade ? 'bg-[var(--up)]' : 'bg-[var(--line)]',
                config.killSwitch && 'opacity-40'
              )}
            >
              <span
                className={cx(
                  'absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform',
                  config.autoTrade ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
          </label>

          <p className="text-[11px] leading-relaxed text-[var(--muted)]">
            Trades can only open between second {ENTRY_MARGIN_SEC} and second {CYCLE_SEC - ENTRY_MARGIN_SEC} of each{' '}
            {CYCLE_SEC}s cycle — never in the first or last {ENTRY_MARGIN_SEC}s.
          </p>

          <Slider
            label="Flag when probability drops below"
            hint="How unlikely the current move has to be, versus the simulation, before it's a signal."
            value={Math.round(config.unlikeliness * 100)}
            min={1}
            max={40}
            step={1}
            suffix="%"
            onChange={(v) => onChange({ unlikeliness: v / 100 })}
          />

          <Slider
            label="Close trades at second"
            hint={`Force-close whatever's open this many seconds into the ${CYCLE_SEC}s cycle — capped at ${CYCLE_SEC - ENTRY_MARGIN_SEC}, the start of the no-entry margin.`}
            value={config.closeAtSecond}
            min={ENTRY_MARGIN_SEC + 1}
            max={CYCLE_SEC - ENTRY_MARGIN_SEC}
            step={1}
            suffix="s"
            onChange={(v) => onChange({ closeAtSecond: v })}
          />

          <Slider
            label="Stake per trade"
            hint="Fixed USD margin per position — the actual exposure is this times leverage."
            value={config.stakeUsd}
            min={10}
            max={10_000}
            step={10}
            prefix="$"
            onChange={(v) => onChange({ stakeUsd: v })}
          />

          <Slider
            label="Leverage"
            hint="Multiplies position size, so P&L moves proportionally faster in both directions. Margin itself is never modelled as a limit — no liquidation, ever."
            value={config.leverage}
            min={1}
            max={MAX_LEVERAGE}
            step={1}
            suffix="x"
            onChange={(v) => onChange({ leverage: v })}
          />

          <Slider
            label="Max slippage"
            hint="Reject a new entry if the price moves against it by more than this while the fill is landing — the same protection a real limit-priced order gets. Never blocks closing a position, only opening one."
            value={config.maxSlippageUsd}
            min={1}
            max={500}
            step={1}
            prefix="$"
            onChange={(v) => onChange({ maxSlippageUsd: v })}
          />

          <Slider
            label="Volatility window"
            hint="How much trailing price history feeds this bot's own volatility estimate — and so its own simulation. Shorter reacts faster to a recent regime change; longer smooths out noise."
            value={config.volatilityWindowSec}
            min={MIN_VOL_WINDOW_SEC}
            max={MAX_VOL_WINDOW_SEC}
            step={30}
            suffix="s"
            onChange={(v) => onChange({ volatilityWindowSec: v })}
          />

          <div className="border-t border-[var(--line)] pt-4">
            <button
              className="btn btn-danger w-full justify-center py-2"
              onClick={() => {
                if (confirm(`Delete all of ${strategyName}'s positions and history? This cannot be undone.`)) onReset();
              }}
            >
              Clear {strategyName}'s history
            </button>
            {health ? (
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
                Storage: {health.storage}
                {health.storage === 'upstash' && !health.storageOk ? ' (unreachable)' : ''}
                {health.storage === 'memory' ? ' — history is lost when the server restarts' : ''}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  prefix,
  suffix,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  prefix?: string;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium">{label}</span>
        <span className="num text-sm font-semibold">
          {prefix}
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        className="range mt-2"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--muted)]">{hint}</p>
    </div>
  );
}
