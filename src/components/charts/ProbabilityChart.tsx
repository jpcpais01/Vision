'use client';

import { useMemo, useState } from 'react';
import type { ProbabilityPoint } from '@/lib/engine/engine';
import { WINDOW_SECONDS } from '@/lib/config';
import { clock, pct } from '@/lib/format';
import {
  CHART_COLORS,
  linePath,
  linearScale,
  nearestIndex,
} from './chartUtils';

/**
 * The three probabilities, on one axis, over the life of the window.
 *
 * This is the chart that shows whether the system is doing anything useful: the
 * Monte Carlo line should move as BTC moves while the LLM line stays flat
 * (it was a single call), and the gap between the Monte Carlo line and the
 * market line is the edge being traded.
 */
const SERIES = [
  { key: 'mc' as const, label: 'Monte Carlo', color: CHART_COLORS.mc },
  { key: 'llm' as const, label: 'LLM prior', color: CHART_COLORS.llm },
  { key: 'marketUp' as const, label: 'Market mid', color: CHART_COLORS.mkt },
];

export function ProbabilityChart({
  history,
  height = 170,
}: {
  history: ProbabilityPoint[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 900;
  const pad = { top: 10, right: 46, bottom: 20, left: 8 };

  const xs = useMemo(() => history.map((h) => h.elapsed), [history]);

  if (history.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-2xs text-slate-600"
        style={{ height }}
      >
        Probability history builds once the window opens.
      </div>
    );
  }

  const x = linearScale([0, WINDOW_SECONDS], [pad.left, width - pad.right]);
  const y = linearScale([0, 1], [height - pad.bottom, pad.top]);
  const px = history.map((h) => x(h.elapsed));
  const hoveredPoint = hover !== null ? history[hover] : null;

  return (
    <div className="relative">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {SERIES.map((s) => {
          const latest = [...history].reverse().find((h) => h[s.key] !== null);
          const v = latest?.[s.key] ?? null;
          return (
            <span key={s.key} className="flex items-center gap-1.5 text-2xs">
              <span
                className="inline-block h-0.5 w-3 rounded-full"
                style={{ background: s.color }}
              />
              <span className="text-slate-400">{s.label}</span>
              <span className="tnum font-medium text-slate-200">
                {v === null ? '—' : pct(v, 1)}
              </span>
            </span>
          );
        })}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full touch-none"
        style={{ height }}
        role="img"
        aria-label="Monte Carlo, LLM and market-implied probability of UP over the window."
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const cursor = ((e.clientX - rect.left) / rect.width) * width;
          const i = nearestIndex(px, cursor);
          if (i >= 0) setHover(i);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(v)}
              y2={y(v)}
              stroke={CHART_COLORS.grid}
              strokeWidth={1}
              strokeDasharray={v === 0.5 ? '4 4' : undefined}
            />
            <text
              x={width - pad.right + 6}
              y={y(v) + 3}
              fill={CHART_COLORS.ink}
              fontSize="10"
              opacity="0.75"
            >
              {(v * 100).toFixed(0)}%
            </text>
          </g>
        ))}

        {/* Time gridlines every minute. */}
        {[60, 120, 180, 240].map((s) => (
          <line
            key={s}
            x1={x(s)}
            x2={x(s)}
            y1={pad.top}
            y2={height - pad.bottom}
            stroke={CHART_COLORS.grid}
            strokeWidth={1}
          />
        ))}
        {[0, 60, 120, 180, 240, 300].map((s) => (
          <text
            key={`l${s}`}
            x={x(s)}
            y={height - 6}
            fill={CHART_COLORS.ink}
            fontSize="9.5"
            opacity="0.6"
            textAnchor="middle"
          >
            {clock(s)}
          </text>
        ))}

        {SERIES.map((s) => {
          const pts = history
            .map((h) => ({ v: h[s.key], x: x(h.elapsed) }))
            .filter((p): p is { v: number; x: number } => p.v !== null)
            .map((p) => ({ x: p.x, y: y(p.v) }));
          if (pts.length < 2) return null;
          return (
            <path
              key={s.key}
              d={linePath(pts)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        {hoveredPoint ? (
          <g>
            <line
              x1={x(hoveredPoint.elapsed)}
              x2={x(hoveredPoint.elapsed)}
              y1={pad.top}
              y2={height - pad.bottom}
              stroke={CHART_COLORS.axis}
              strokeWidth={1}
            />
            {SERIES.map((s) => {
              const v = hoveredPoint[s.key];
              if (v === null) return null;
              return (
                <circle
                  key={s.key}
                  cx={x(hoveredPoint.elapsed)}
                  cy={y(v)}
                  r={4}
                  fill={s.color}
                  stroke={CHART_COLORS.surface}
                  strokeWidth={2}
                />
              );
            })}
          </g>
        ) : null}
      </svg>

      {hoveredPoint ? (
        <div
          className="pointer-events-none absolute top-6 rounded-md border border-base-600 bg-base-950/95 px-2 py-1 text-2xs shadow-lg"
          style={{
            left: `${Math.min(76, Math.max(2, (x(hoveredPoint.elapsed) / width) * 100))}%`,
          }}
        >
          <div className="mb-0.5 tnum text-slate-500">
            T+{clock(hoveredPoint.elapsed)} · ${hoveredPoint.btc.toFixed(0)}
          </div>
          {SERIES.map((s) => {
            const v = hoveredPoint[s.key];
            return (
              <div key={s.key} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-0.5 w-2.5 rounded-full"
                  style={{ background: s.color }}
                />
                <span className="text-slate-400">{s.label}</span>
                <span className="tnum ml-auto pl-2 font-medium text-slate-100">
                  {v === null ? '—' : pct(v, 1)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
