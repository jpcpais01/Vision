'use client';

import type { EngineSnapshot } from '@/lib/engine/engine';
import type { TradingConfig } from '@/lib/types';
import { Badge, Dot, Toggle } from '@/components/ui/Primitives';
import { ago, clock, cx, usd } from '@/lib/format';

/**
 * The always-visible control strip: what mode we are in, whether the feeds are
 * healthy, how long is left in the window, and the two switches that matter —
 * auto-trade and the kill switch.
 */
export function StatusBar({
  snapshot,
  config,
  llmAvailable,
  onToggleAuto,
  onStart,
  onStop,
  onKill,
}: {
  snapshot: EngineSnapshot;
  config: TradingConfig;
  llmAvailable: boolean;
  onToggleAuto: (v: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onKill: (engaged: boolean) => void;
}) {
  const { running, priceStatus, bookStatus, btc, btcAt, secondsLeft, market, chainlink } =
    snapshot;
  const killed = config.killSwitch;
  const basis = btc !== null && chainlink ? btc - chainlink.price : null;
  const live = config.mode === 'LIVE';

  return (
    <div
      className={cx(
        'panel sticky top-0 z-30 flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5',
        killed && 'border-down/50',
        live && !killed && 'border-down/30'
      )}
    >
      {/* Identity + mode */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/15 text-[11px] font-bold text-accent">
          V
        </div>
        <div className="leading-tight">
          <div className="text-xs font-semibold text-slate-100">Vision</div>
          <div className="text-[10px] text-slate-500">BTC 5-minute UP/DOWN</div>
        </div>
        <span
          className={cx(
            'ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
            live ? 'bg-down/20 text-down' : 'bg-accent/15 text-accent'
          )}
        >
          {config.mode}
        </span>
      </div>

      {/* BTC */}
      <div className="flex items-baseline gap-2">
        <span className="label">BTC</span>
        <span className="tnum text-lg font-semibold text-slate-100">
          {btc !== null ? usd(btc) : '—'}
        </span>
        {btcAt > 0 ? (
          <span className="tnum text-2xs text-slate-600">{ago(btcAt, snapshot.now)}</span>
        ) : null}
        {basis !== null ? (
          <span
            className="tnum text-2xs text-slate-500"
            title="Exchange feed minus the Chainlink oracle answer — the basis that decides a close call at the boundary"
          >
            oracle {basis >= 0 ? '+' : ''}
            {basis.toFixed(1)}
          </span>
        ) : null}
      </div>

      {/* Window clock */}
      <div className="flex items-baseline gap-2">
        <span className="label">Window</span>
        <span
          className={cx(
            'tnum text-lg font-semibold',
            secondsLeft !== null && secondsLeft < 45 ? 'text-warn' : 'text-slate-100'
          )}
        >
          {clock(secondsLeft)}
        </span>
        {market ? (
          <span className="max-w-[180px] truncate text-2xs text-slate-600" title={market.question}>
            {market.slug || market.id}
          </span>
        ) : (
          <span className="text-2xs text-slate-600">no open market</span>
        )}
      </div>

      {/* Feeds */}
      <div className="flex items-center gap-3">
        <FeedChip
          label="price"
          mode={priceStatus.mode}
          detail={`${priceStatus.source}${priceStatus.error ? ` · ${priceStatus.error}` : ''}`}
        />
        <FeedChip
          label="book"
          mode={bookStatus.mode}
          detail={`CLOB${bookStatus.error ? ` · ${bookStatus.error}` : ''}`}
        />
        {!llmAvailable ? (
          <Badge tone="warn" title="Set OPENROUTER_API_KEY in the server environment">
            no LLM key
          </Badge>
        ) : null}
        {snapshot.interpolatedFeed ? (
          <Badge tone="warn" title="History was upsampled from 60-second candles; fine structure is synthetic">
            interpolated
          </Badge>
        ) : null}
      </div>

      {/* Controls */}
      <div className="ml-auto flex items-center gap-3">
        <Toggle
          checked={config.autoTrade}
          onChange={onToggleAuto}
          label="Auto-trade"
          tone={live ? 'down' : 'accent'}
          disabled={killed || !running}
          title={
            killed
              ? 'Kill switch engaged'
              : !running
                ? 'Start the engine first'
                : 'Submit orders automatically when every gate passes'
          }
        />
        {running ? (
          <button type="button" className="btn btn-default" onClick={onStop}>
            Stop engine
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onStart}
            disabled={killed}
          >
            Start engine
          </button>
        )}
        <button
          type="button"
          onClick={() => onKill(!killed)}
          className={cx(
            'btn',
            killed
              ? 'border-warn/50 bg-warn/15 text-warn hover:bg-warn/25'
              : 'btn-danger'
          )}
          title={
            killed
              ? 'Clear the kill switch'
              : 'Halt all trading, cancel resting orders, and stop the engine'
          }
        >
          {killed ? 'Clear kill switch' : 'Kill switch'}
        </button>
      </div>
    </div>
  );
}

function FeedChip({
  label,
  mode,
  detail,
}: {
  label: string;
  mode: 'websocket' | 'polling' | 'disconnected';
  detail: string;
}) {
  const tone = mode === 'websocket' ? 'up' : mode === 'polling' ? 'warn' : 'muted';
  const text = mode === 'websocket' ? 'ws' : mode === 'polling' ? 'poll' : 'off';
  return (
    <span className="flex items-center gap-1.5 text-2xs text-slate-500" title={detail}>
      <Dot tone={tone} />
      <span>{label}</span>
      <span className="text-slate-600">{text}</span>
    </span>
  );
}
