'use client';

import { useState } from 'react';
import type { TradingConfig } from '@/lib/types';
import { NumberField, SelectField, Toggle } from '@/components/ui/Primitives';
import { cx } from '@/lib/format';

type Section = 'edge' | 'risk' | 'model' | 'feed';

/**
 * Runtime configuration.
 *
 * Every field here is also clamped server-side on write, so this panel is a
 * convenience rather than the enforcement point — nothing typed in the browser
 * can widen a limit past what the server allows.
 */
export function ControlsPanel({
  config,
  onChange,
  disabled,
  liveBlockers,
}: {
  config: TradingConfig;
  onChange: (patch: Partial<TradingConfig>) => void;
  disabled?: boolean;
  liveBlockers: string[];
}) {
  const [section, setSection] = useState<Section>('edge');
  const liveAvailable = liveBlockers.length === 0;

  const set =
    <K extends keyof TradingConfig>(key: K) =>
    (value: TradingConfig[K]) =>
      onChange({ [key]: value } as Partial<TradingConfig>);

  return (
    <div className="space-y-3">
      {/* Mode */}
      <div className="rounded-lg border border-base-700 bg-base-950/50 p-2.5">
        <div className="label mb-1.5">Execution mode</div>
        <div className="grid grid-cols-2 gap-1.5">
          <ModeButton
            active={config.mode === 'PAPER'}
            onClick={() => onChange({ mode: 'PAPER' })}
            title="PAPER"
            subtitle="Real data, simulated fills"
            tone="accent"
          />
          <ModeButton
            active={config.mode === 'LIVE'}
            onClick={() => liveAvailable && onChange({ mode: 'LIVE' })}
            disabled={!liveAvailable}
            title="LIVE"
            subtitle={liveAvailable ? 'Real money' : 'Not configured'}
            tone="down"
          />
        </div>
        {!liveAvailable ? (
          <ul className="mt-2 space-y-0.5 text-2xs text-slate-500">
            {liveBlockers.map((b) => (
              <li key={b}>• {b}</li>
            ))}
          </ul>
        ) : config.mode === 'LIVE' ? (
          <p className="mt-2 rounded border border-down/30 bg-down/10 px-2 py-1 text-2xs text-down">
            LIVE mode submits real orders with real funds. Orders are still
            re-validated server-side against every limit below.
          </p>
        ) : null}
      </div>

      {/* Section tabs */}
      <div className="flex gap-1">
        {(['edge', 'risk', 'model', 'feed'] as Section[]).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSection(s)}
            className={cx(
              'flex-1 rounded-md border px-2 py-1 text-2xs capitalize transition-colors',
              section === s
                ? 'border-accent/50 bg-accent/15 text-accent'
                : 'border-base-700 text-slate-500 hover:text-slate-300'
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {section === 'edge' ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Min edge"
            suffix="prob"
            value={config.minEdge}
            step={0.005}
            onChange={set('minEdge')}
            disabled={disabled}
            hint="Model probability minus the ask, in probability units. 0.04 = 4 cents on a $1 contract."
          />
          <NumberField
            label="Min edge ratio"
            suffix="× ask"
            value={config.minEdgeRatio}
            step={0.01}
            onChange={set('minEdgeRatio')}
            disabled={disabled}
            hint="Edge as a fraction of the price paid — return on capital, not absolute cents."
          />
          <NumberField
            label="Max spread"
            suffix="prob"
            value={config.maxSpread}
            step={0.005}
            onChange={set('maxSpread')}
            disabled={disabled}
          />
          <NumberField
            label="Min top-of-book"
            suffix="shares"
            value={config.minTopOfBookShares}
            step={5}
            onChange={set('minTopOfBookShares')}
            disabled={disabled}
          />
          <NumberField
            label="Min depth"
            suffix="USD"
            value={config.minDepthUsd}
            step={10}
            onChange={set('minDepthUsd')}
            disabled={disabled}
            hint="Notional resting within 2 cents of the touch."
          />
          <NumberField
            label="Min LLM confidence"
            value={config.minLlmConfidence}
            step={0.05}
            onChange={set('minLlmConfidence')}
            disabled={disabled}
          />
          <NumberField
            label="Min price"
            value={config.minPrice}
            step={0.01}
            onChange={set('minPrice')}
            disabled={disabled}
          />
          <NumberField
            label="Max price"
            value={config.maxPrice}
            step={0.01}
            onChange={set('maxPrice')}
            disabled={disabled}
          />
          <NumberField
            label="Min seconds left"
            suffix="s"
            value={config.minSecondsLeft}
            step={5}
            onChange={set('minSecondsLeft')}
            disabled={disabled}
            hint="Do not enter with less than this on the clock — no time for the edge to realise."
          />
          <NumberField
            label="Max seconds left"
            suffix="s"
            value={config.maxSecondsLeft}
            step={5}
            onChange={set('maxSecondsLeft')}
            disabled={disabled}
            hint="Do not enter this early — too little realised path to condition on."
          />
          <NumberField
            label="Max data age"
            suffix="ms"
            value={config.maxDataAgeMs}
            step={250}
            onChange={set('maxDataAgeMs')}
            disabled={disabled}
          />
          <NumberField
            label="Max forecast latency"
            suffix="ms"
            value={config.maxDecisionLatencyMs}
            step={500}
            onChange={set('maxDecisionLatencyMs')}
            disabled={disabled}
            hint="Reject a forecast that took longer than this to arrive — it was reading a stale tape by the time it answered. This bounds the model's round trip, not the age of the forecast."
          />
          <NumberField
            label="LLM timeout"
            suffix="ms"
            value={config.llmTimeoutMs}
            step={1000}
            onChange={set('llmTimeoutMs')}
            disabled={disabled}
            hint="Total budget for the forecast across all retry attempts. Lower it to fail fast on a slow model; the window is only 300s."
          />
        </div>
      ) : null}

      {section === 'risk' ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Bankroll"
            suffix="USD"
            value={config.bankroll}
            step={50}
            onChange={set('bankroll')}
            disabled={disabled}
          />
          <NumberField
            label="Kelly fraction"
            value={config.kellyFraction}
            step={0.05}
            onChange={set('kellyFraction')}
            disabled={disabled}
            hint="Fraction of full Kelly. Full Kelly assumes the probability is exactly right; it never is."
          />
          <NumberField
            label="Max position"
            suffix="USD"
            value={config.maxPositionUsd}
            step={5}
            onChange={set('maxPositionUsd')}
            disabled={disabled}
          />
          <NumberField
            label="Max position"
            suffix="% bankroll"
            value={config.maxPositionPctBankroll}
            step={0.005}
            onChange={set('maxPositionPctBankroll')}
            disabled={disabled}
          />
          <NumberField
            label="Max concurrent"
            suffix="positions"
            value={config.maxConcurrentPositions}
            step={1}
            onChange={set('maxConcurrentPositions')}
            disabled={disabled}
          />
          <NumberField
            label="Max trades/hour"
            value={config.maxTradesPerHour}
            step={1}
            onChange={set('maxTradesPerHour')}
            disabled={disabled}
          />
          <NumberField
            label="Max daily loss"
            suffix="USD"
            value={config.maxDailyLossUsd}
            step={10}
            onChange={set('maxDailyLossUsd')}
            disabled={disabled}
          />
          <NumberField
            label="Max daily trades"
            value={config.maxDailyTrades}
            step={1}
            onChange={set('maxDailyTrades')}
            disabled={disabled}
          />
          <NumberField
            label="Stop after losses"
            suffix="consecutive"
            value={config.stopAfterConsecutiveLosses}
            step={1}
            onChange={set('stopAfterConsecutiveLosses')}
            disabled={disabled}
          />
        </div>
      ) : null}

      {section === 'model' ? (
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="MC paths"
            value={config.mcPaths}
            step={1000}
            onChange={set('mcPaths')}
            disabled={disabled}
            hint="More paths reduce simulation error but cost main-thread time. 20k gives ~0.35pp standard error."
          />
          <SelectField
            label="Simulation engine"
            value={config.mcEngine}
            onChange={set('mcEngine')}
            disabled={disabled}
            options={[
              { value: 'blend', label: 'Blend (GBM + bootstrap)' },
              { value: 'gbm', label: 'Parametric only' },
              { value: 'bootstrap', label: 'Block bootstrap only' },
            ]}
            hint="Bootstrap resamples real recent 10s returns; GBM uses Student-t innovations."
          />
          <NumberField
            label="Student-t df"
            value={config.studentT}
            step={1}
            onChange={set('studentT')}
            disabled={disabled}
            hint="Degrees of freedom for the parametric engine. Lower = fatter tails. 0 disables (Gaussian)."
          />
          <NumberField
            label="Prior weight"
            value={config.priorWeight}
            step={0.05}
            onChange={set('priorWeight')}
            disabled={disabled}
            hint="How much of the LLM-implied drift to apply. 0 = ignore the LLM's direction entirely."
          />
          <NumberField
            label="Probability shrink"
            value={config.probabilityShrink}
            step={0.05}
            onChange={set('probabilityShrink')}
            disabled={disabled}
            hint="Pull the final probability toward 0.50 by this fraction, to offset accumulated model error."
          />
          <NumberField
            label="EWMA lambda"
            value={config.ewmaLambda}
            step={0.005}
            onChange={set('ewmaLambda')}
            disabled={disabled}
            hint="Volatility decay over 10s bars. 0.97 gives roughly a 5.5-minute half-life."
          />
          <NumberField
            label="History window"
            suffix="minutes"
            value={config.historyMinutes}
            step={5}
            onChange={set('historyMinutes')}
            disabled={disabled}
          />
        </div>
      ) : null}

      {section === 'feed' ? (
        <div className="space-y-2">
          <SelectField
            label="Price source"
            value={config.priceSource === 'chainlink' ? 'binance' : config.priceSource}
            onChange={set('priceSource')}
            disabled={disabled}
            options={[
              { value: 'binance', label: 'Binance (native 10s)' },
              { value: 'coinbase', label: 'Coinbase (60s, interpolated)' },
              { value: 'kraken', label: 'Kraken (60s, interpolated)' },
            ]}
            hint="Only Binance publishes 1-second klines, so only it can reconstruct true 10-second history."
          />
          <div className="rounded-md border border-base-700 bg-base-950/50 px-2.5 py-2">
            <Toggle
              checked={config.useChainlinkReference}
              onChange={set('useChainlinkReference')}
              label="Track Chainlink BTC/USD reference"
              disabled={disabled}
            />
            <p className="mt-1.5 text-2xs leading-relaxed text-slate-500">
              Polymarket settles these markets against an oracle. Tracking the
              on-chain answer alongside the exchange feed surfaces the basis —
              the gap that decides a close call at the boundary.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  title,
  subtitle,
  tone,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  tone: 'accent' | 'down';
  disabled?: boolean;
}) {
  const activeCls =
    tone === 'down'
      ? 'border-down/60 bg-down/15 text-down'
      : 'border-accent/60 bg-accent/15 text-accent';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        'rounded-md border px-2 py-1.5 text-left transition-colors',
        active ? activeCls : 'border-base-700 text-slate-400 hover:border-base-600',
        disabled && 'cursor-not-allowed opacity-40'
      )}
    >
      <div className="text-xs font-semibold">{title}</div>
      <div className="text-[10px] opacity-70">{subtitle}</div>
    </button>
  );
}
