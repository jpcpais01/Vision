'use client';

import { useEffect } from 'react';
import type { Config } from '@/lib/types';
import type { Health } from '@/hooks/useEngine';
import { cx } from '@/lib/format';

/** Six settings. If a knob has no clear reason to be turned, it is not here. */
export function Settings({
  config,
  health,
  onChange,
  onReset,
  onClose,
}: {
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

  const liveReady = (health?.liveBlockers.length ?? 1) === 0;

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
          <h2 className="text-sm font-semibold">Settings</h2>
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div>
            <div className="label mb-2">Mode</div>
            <div className="grid grid-cols-2 gap-2">
              <button
                className={cx('mode', config.mode === 'PAPER' && 'mode-on')}
                onClick={() => onChange({ mode: 'PAPER' })}
              >
                <span className="font-semibold">Paper</span>
                <span className="text-[11px] opacity-70">Real prices, fake money</span>
              </button>
              <button
                className={cx('mode', config.mode === 'LIVE' && 'mode-on-live')}
                disabled={!liveReady}
                onClick={() => liveReady && onChange({ mode: 'LIVE' })}
              >
                <span className="font-semibold">Live</span>
                <span className="text-[11px] opacity-70">
                  {liveReady ? 'Real money' : 'Not set up'}
                </span>
              </button>
            </div>
            {!liveReady && health?.liveBlockers.length ? (
              <ul className="mt-2 space-y-0.5 text-[11px] text-[var(--muted)]">
                {health.liveBlockers.map((b) => (
                  <li key={b}>· {b}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Trade automatically</span>
              <span className="block text-[11px] text-[var(--muted)]">
                Off means it watches and tells you, but never buys.
              </span>
            </span>
            <button
              role="switch"
              aria-checked={config.autoTrade}
              disabled={config.killSwitch}
              onClick={() => onChange({ autoTrade: !config.autoTrade })}
              className={cx(
                'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                config.autoTrade ? 'bg-[var(--up)]' : 'bg-[var(--line)]',
                config.killSwitch && 'opacity-40'
              )}
            >
              <span
                className={cx(
                  'absolute top-1 h-4 w-4 rounded-full bg-white transition-transform',
                  config.autoTrade ? 'translate-x-6' : 'translate-x-1'
                )}
              />
            </button>
          </label>

          <Slider
            label="Minimum edge"
            hint="How far ahead of the market price we need to be before buying."
            value={config.minEdge * 100}
            min={1}
            max={25}
            step={1}
            suffix="%"
            onChange={(v) => onChange({ minEdge: v / 100 })}
          />

          <Slider
            label="Stake per trade"
            hint="Fixed amount risked on each position."
            value={config.stakeUsd}
            min={1}
            max={500}
            step={1}
            prefix="$"
            onChange={(v) => onChange({ stakeUsd: v })}
          />

          <Slider
            label="Stop after losing"
            hint="No more trades today once the day is down this much."
            value={config.maxDailyLossUsd}
            min={10}
            max={2000}
            step={10}
            prefix="$"
            onChange={(v) => onChange({ maxDailyLossUsd: v })}
          />

          <Slider
            label="How much to trust the model"
            hint="0 ignores its call and trades on volatility alone. 1 takes it at its word."
            value={config.llmWeight * 100}
            min={0}
            max={100}
            step={10}
            suffix="%"
            onChange={(v) => onChange({ llmWeight: v / 100 })}
          />

          <Slider
            label="Don’t enter with less than"
            hint="Seconds left on the clock."
            value={config.minSecondsLeft}
            min={5}
            max={120}
            step={5}
            suffix="s"
            onChange={(v) => onChange({ minSecondsLeft: v })}
          />

          <div className="border-t border-[var(--line)] pt-4">
            <button
              className="btn btn-danger w-full justify-center py-2"
              onClick={() => {
                if (confirm('Delete all trades and history? This cannot be undone.')) onReset();
              }}
            >
              Clear all history
            </button>
            {health ? (
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--muted)]">
                Model: {health.model}
                <br />
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
