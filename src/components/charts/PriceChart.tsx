'use client';

import { useMemo, useRef, useState } from 'react';
import type { Bar, PricePoint } from '@/lib/types';
import { cx, timeMs, usd } from '@/lib/format';
import {
  CHART_COLORS,
  areaPath,
  extent,
  linePath,
  linearScale,
  nearestIndex,
  padDomain,
  ticks,
} from './chartUtils';

/**
 * BTC path for the current window, drawn against the settlement barrier.
 *
 * The barrier is the only thing the market resolves on, so it is the chart's
 * baseline: the area between price and barrier is filled with the polarity
 * colour, and the y-axis is labelled in dollars *from the barrier* rather than
 * in absolute price. A trader reading this needs one number — how far above or
 * below the line are we, and how much time is left to close that gap.
 */
export function PriceChart({
  bars,
  ticksLive,
  barrier,
  windowStartMs,
  windowEndMs,
  llmDispatchedAt,
  llmRespondedAt,
  tradeAt,
  height = 200,
}: {
  bars: Bar[];
  ticksLive: PricePoint[];
  barrier: number | null;
  windowStartMs: number | null;
  windowEndMs: number | null;
  llmDispatchedAt?: number | null;
  llmRespondedAt?: number | null;
  tradeAt?: number | null;
  height?: number;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);

  const pad = { top: 10, right: 54, bottom: 18, left: 8 };
  const width = 900; // viewBox width; the SVG scales to its container.

  const series = useMemo(() => {
    // Prefer raw ticks inside the window — the fine structure near the barrier
    // is the whole story on a 5-minute market — and fall back to bars.
    if (windowStartMs !== null) {
      const inWindow = ticksLive.filter((t) => t.t >= windowStartMs - 30_000);
      if (inWindow.length > 8) return inWindow;
    }
    const from = windowStartMs !== null ? windowStartMs - 60_000 : 0;
    return bars.filter((b) => b.t >= from).map((b) => ({ t: b.t, p: b.c }));
  }, [bars, ticksLive, windowStartMs]);

  if (series.length < 2 || windowStartMs === null || windowEndMs === null) {
    return (
      <div
        className="flex items-center justify-center text-2xs text-slate-600"
        style={{ height }}
      >
        Waiting for price data…
      </div>
    );
  }

  const t0 = windowStartMs;
  const t1 = windowEndMs;
  const x = linearScale([t0, t1], [pad.left, width - pad.right]);

  const prices = series.map((s) => s.p);
  const yDomain = padDomain(extent(prices), 0.22, barrier ?? undefined);
  const y = linearScale(yDomain, [height - pad.bottom, pad.top]);

  const pts = series.map((s) => ({ x: x(s.t), y: y(s.p) }));
  const baselineY = barrier !== null ? y(barrier) : height - pad.bottom;
  const last = series[series.length - 1];
  const above = barrier !== null && last.p > barrier;

  const hovered = hover ? series[hover.i] : null;
  const yTicks = barrier !== null ? ticks(yDomain, 3) : ticks(yDomain, 3);

  type Marker = { t: number; label: string; color: string; dash: string };
  const markers: Marker[] = (
    [
      { t: llmDispatchedAt, label: 'LLM sent', color: CHART_COLORS.llm as string, dash: '3 3' },
      { t: llmRespondedAt, label: 'Forecast', color: CHART_COLORS.llm as string, dash: '' },
      { t: tradeAt, label: 'Entry', color: CHART_COLORS.mc as string, dash: '' },
    ] as { t: number | null | undefined; label: string; color: string; dash: string }[]
  )
    .filter((m) => typeof m.t === 'number' && m.t >= t0 && m.t <= t1)
    .map((m) => ({ ...m, t: m.t as number }));

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        className="w-full touch-none"
        style={{ height }}
        role="img"
        aria-label={`Bitcoin price this window. Barrier ${barrier ? usd(barrier) : 'not captured'}. Current ${usd(last.p)}, ${above ? 'above' : 'below'} the barrier.`}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          const i = nearestIndex(
            series.map((s) => x(s.t)),
            px
          );
          if (i >= 0) setHover({ x: px, i });
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="pcUp" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLORS.up} stopOpacity="0.28" />
            <stop offset="100%" stopColor={CHART_COLORS.up} stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="pcDown" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor={CHART_COLORS.down} stopOpacity="0.28" />
            <stop offset="100%" stopColor={CHART_COLORS.down} stopOpacity="0.02" />
          </linearGradient>
          <clipPath id="pcAbove">
            <rect x="0" y="0" width={width} height={Math.max(0, baselineY)} />
          </clipPath>
          <clipPath id="pcBelow">
            <rect x="0" y={baselineY} width={width} height={Math.max(0, height - baselineY)} />
          </clipPath>
        </defs>

        {/* Recessive grid */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(v)}
              y2={y(v)}
              stroke={CHART_COLORS.grid}
              strokeWidth={1}
            />
            <text
              x={width - pad.right + 6}
              y={y(v) + 3}
              fill={CHART_COLORS.ink}
              fontSize="10"
              opacity="0.75"
            >
              {barrier !== null
                ? `${v - barrier >= 0 ? '+' : ''}${(v - barrier).toFixed(0)}`
                : v.toFixed(0)}
            </text>
          </g>
        ))}

        {/* Area split at the barrier: green above, red below. */}
        {barrier !== null ? (
          <>
            <path
              d={areaPath(pts, baselineY)}
              fill="url(#pcUp)"
              clipPath="url(#pcAbove)"
            />
            <path
              d={areaPath(pts, baselineY)}
              fill="url(#pcDown)"
              clipPath="url(#pcBelow)"
            />
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={baselineY}
              y2={baselineY}
              stroke={CHART_COLORS.ink}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              opacity="0.85"
            />
          </>
        ) : null}

        {/* Event markers, each directly labelled — never colour alone. */}
        {markers.map((m, i) => (
          <g key={`${m.label}-${i}`}>
            <line
              x1={x(m.t)}
              x2={x(m.t)}
              y1={pad.top}
              y2={height - pad.bottom}
              stroke={m.color}
              strokeWidth={1}
              strokeDasharray={m.dash}
              opacity="0.55"
            />
            <text
              x={x(m.t) + 3}
              y={pad.top + 9 + i * 11}
              fill={m.color}
              fontSize="9"
              opacity="0.95"
            >
              {m.label}
            </text>
          </g>
        ))}

        <path
          d={linePath(pts)}
          fill="none"
          stroke={CHART_COLORS.mc}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* The barrier caption is painted last so its plate occludes the price
            path rather than being crossed by it. */}
        {barrier !== null ? (
          <g>
            <rect
              x={pad.left + 1}
              y={baselineY - 14}
              width={110}
              height={12}
              rx={2}
              fill={CHART_COLORS.surface}
              opacity="0.92"
            />
            <text
              x={pad.left + 5}
              y={baselineY - 4.5}
              fill={CHART_COLORS.ink}
              fontSize="9.5"
              letterSpacing="0.06em"
            >
              BARRIER {barrier.toFixed(2)}
            </text>
          </g>
        ) : null}

        {/* Current price dot with a surface ring so it reads over the area. */}
        <circle
          cx={pts[pts.length - 1].x}
          cy={pts[pts.length - 1].y}
          r={4}
          fill={above ? CHART_COLORS.up : CHART_COLORS.down}
          stroke={CHART_COLORS.surface}
          strokeWidth={2}
        />

        {hovered ? (
          <g>
            <line
              x1={x(hovered.t)}
              x2={x(hovered.t)}
              y1={pad.top}
              y2={height - pad.bottom}
              stroke={CHART_COLORS.axis}
              strokeWidth={1}
            />
            <circle
              cx={x(hovered.t)}
              cy={y(hovered.p)}
              r={4}
              fill={CHART_COLORS.mc}
              stroke={CHART_COLORS.surface}
              strokeWidth={2}
            />
          </g>
        ) : null}
      </svg>

      {hovered ? (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-base-600 bg-base-950/95 px-2 py-1 text-2xs shadow-lg"
          style={{
            left: `${Math.min(78, Math.max(2, (x(hovered.t) / width) * 100))}%`,
          }}
        >
          <div className="tnum font-semibold text-slate-100">{usd(hovered.p)}</div>
          {barrier !== null ? (
            <div
              className={cx(
                'tnum',
                hovered.p > barrier ? 'text-up' : 'text-down'
              )}
            >
              {hovered.p > barrier ? '+' : ''}
              {(hovered.p - barrier).toFixed(2)} vs barrier
            </div>
          ) : null}
          <div className="tnum text-slate-500">{timeMs(hovered.t)}</div>
        </div>
      ) : null}
    </div>
  );
}
