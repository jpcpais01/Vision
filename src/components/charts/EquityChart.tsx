'use client';

import { useState } from 'react';
import type { Trade } from '@/lib/types';
import { dateTime, signedUsd } from '@/lib/format';
import {
  CHART_COLORS,
  areaPath,
  extent,
  linePath,
  linearScale,
  nearestIndex,
  padDomain,
} from './chartUtils';

/** Cumulative realised P&L across resolved trades. */
export function EquityChart({
  trades,
  height = 130,
}: {
  trades: Trade[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 760;
  const pad = { top: 10, right: 52, bottom: 8, left: 8 };

  const resolved = trades
    .filter((t) => t.status === 'WON' || t.status === 'LOST')
    .sort((a, b) => (a.resolvedAt ?? a.t) - (b.resolvedAt ?? b.t));

  if (resolved.length < 1) {
    return (
      <div
        className="flex items-center justify-center text-2xs text-slate-600"
        style={{ height }}
      >
        Cumulative P&amp;L appears after the first resolved trade.
      </div>
    );
  }

  let cum = 0;
  const points = [
    { i: 0, pnl: 0, t: resolved[0].t, trade: null as Trade | null },
    ...resolved.map((t, i) => {
      cum += t.pnl ?? 0;
      return { i: i + 1, pnl: cum, t: t.resolvedAt ?? t.t, trade: t };
    }),
  ];

  const x = linearScale([0, Math.max(1, points.length - 1)], [pad.left, width - pad.right]);
  const yDomain = padDomain(extent(points.map((p) => p.pnl)), 0.18, 0);
  const y = linearScale(yDomain, [height - pad.bottom, pad.top]);
  const pts = points.map((p) => ({ x: x(p.i), y: y(p.pnl) }));
  const zeroY = y(0);
  const final = points[points.length - 1].pnl;
  const positive = final >= 0;
  const hovered = hover !== null ? points[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full touch-none"
        style={{ height }}
        role="img"
        aria-label={`Cumulative profit and loss over ${resolved.length} resolved trades, currently ${signedUsd(final)}.`}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const cursor = ((e.clientX - rect.left) / rect.width) * width;
          const i = nearestIndex(
            points.map((p) => x(p.i)),
            cursor
          );
          if (i >= 0) setHover(i);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={positive ? CHART_COLORS.up : CHART_COLORS.down}
              stopOpacity="0.24"
            />
            <stop
              offset="100%"
              stopColor={positive ? CHART_COLORS.up : CHART_COLORS.down}
              stopOpacity="0.01"
            />
          </linearGradient>
        </defs>

        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={zeroY}
          y2={zeroY}
          stroke={CHART_COLORS.grid}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        <text
          x={width - pad.right + 6}
          y={zeroY + 3}
          fill={CHART_COLORS.ink}
          fontSize="10"
          opacity="0.7"
        >
          $0
        </text>

        <path d={areaPath(pts, zeroY)} fill="url(#eqFill)" />
        <path
          d={linePath(pts)}
          fill="none"
          stroke={positive ? CHART_COLORS.up : CHART_COLORS.down}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={pts[pts.length - 1].x}
          cy={pts[pts.length - 1].y}
          r={4}
          fill={positive ? CHART_COLORS.up : CHART_COLORS.down}
          stroke={CHART_COLORS.surface}
          strokeWidth={2}
        />
        <text
          x={width - pad.right + 6}
          y={pts[pts.length - 1].y + 3}
          fill={positive ? CHART_COLORS.up : CHART_COLORS.down}
          fontSize="10.5"
          fontWeight="600"
        >
          {signedUsd(final)}
        </text>

        {hovered ? (
          <line
            x1={x(hovered.i)}
            x2={x(hovered.i)}
            y1={pad.top}
            y2={height - pad.bottom}
            stroke={CHART_COLORS.axis}
            strokeWidth={1}
          />
        ) : null}
      </svg>

      {hovered?.trade ? (
        <div
          className="pointer-events-none absolute top-1 rounded-md border border-base-600 bg-base-950/95 px-2 py-1 text-2xs shadow-lg"
          style={{ left: `${Math.min(72, Math.max(2, (x(hovered.i) / width) * 100))}%` }}
        >
          <div className="font-medium text-slate-100">
            {hovered.trade.side} · {hovered.trade.status}
          </div>
          <div className="tnum text-slate-400">
            trade {signedUsd(hovered.trade.pnl)} · cum {signedUsd(hovered.pnl)}
          </div>
          <div className="tnum text-slate-500">{dateTime(hovered.t)}</div>
        </div>
      ) : null}
    </div>
  );
}
