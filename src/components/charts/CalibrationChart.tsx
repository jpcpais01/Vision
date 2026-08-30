'use client';

import type { CalibrationBin } from '@/lib/types';
import { wilsonInterval } from '@/lib/math/stats';
import { CHART_COLORS } from './chartUtils';

/**
 * Reliability diagram: forecast probability against observed frequency.
 *
 * A well-calibrated model sits on the diagonal. Bins carry Wilson intervals
 * because with a handful of 5-minute windows per bin the point estimate is
 * almost meaningless on its own, and a reliability diagram without error bars
 * invites exactly the wrong conclusion from twenty trades.
 */
export function CalibrationChart({
  bins,
  height = 210,
}: {
  bins: CalibrationBin[];
  height?: number;
}) {
  const size = 210;
  const pad = { top: 8, right: 8, bottom: 22, left: 26 };
  const plot = size - pad.left - pad.right;
  const toX = (v: number) => pad.left + v * plot;
  const toY = (v: number) => size - pad.bottom - v * (size - pad.top - pad.bottom);

  const populated = bins.filter((b) => b.n > 0);
  const total = populated.reduce((s, b) => s + b.n, 0);
  const maxN = Math.max(1, ...populated.map((b) => b.n));

  return (
    <div className="flex flex-col items-center">
      <svg
        viewBox={`0 0 ${size} ${height}`}
        className="w-full max-w-[260px]"
        role="img"
        aria-label={`Reliability diagram over ${total} resolved windows.`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line
              x1={toX(0)}
              x2={toX(1)}
              y1={toY(v)}
              y2={toY(v)}
              stroke={CHART_COLORS.grid}
              strokeWidth={1}
            />
            <text
              x={pad.left - 5}
              y={toY(v) + 3}
              fill={CHART_COLORS.ink}
              fontSize="8.5"
              textAnchor="end"
              opacity="0.7"
            >
              {(v * 100).toFixed(0)}
            </text>
            <text
              x={toX(v)}
              y={size - pad.bottom + 11}
              fill={CHART_COLORS.ink}
              fontSize="8.5"
              textAnchor="middle"
              opacity="0.7"
            >
              {(v * 100).toFixed(0)}
            </text>
          </g>
        ))}

        {/* Perfect calibration */}
        <line
          x1={toX(0)}
          y1={toY(0)}
          x2={toX(1)}
          y2={toY(1)}
          stroke={CHART_COLORS.ink}
          strokeWidth={1.5}
          strokeDasharray="4 4"
          opacity="0.55"
        />

        {populated.map((b, i) => {
          const ci = wilsonInterval(Math.round(b.observedFreq * b.n), b.n);
          const cx = toX(b.meanForecast);
          return (
            <g key={i}>
              <line
                x1={cx}
                x2={cx}
                y1={toY(ci.lo)}
                y2={toY(ci.hi)}
                stroke={CHART_COLORS.mc}
                strokeWidth={1.5}
                opacity="0.45"
              />
              <circle
                cx={cx}
                cy={toY(b.observedFreq)}
                r={Math.max(4, Math.min(8, 3 + (b.n / maxN) * 5))}
                fill={CHART_COLORS.mc}
                stroke={CHART_COLORS.surface}
                strokeWidth={2}
              />
            </g>
          );
        })}

        <text
          x={toX(0.5)}
          y={size - 3}
          fill={CHART_COLORS.ink}
          fontSize="8.5"
          textAnchor="middle"
          opacity="0.8"
        >
          forecast P(UP) %
        </text>
      </svg>

      <p className="mt-1 text-center text-2xs text-slate-500">
        {total === 0
          ? 'No resolved windows yet.'
          : `${total} resolved window${total === 1 ? '' : 's'} · dot size = sample count · bars = 95% Wilson interval`}
      </p>
    </div>
  );
}
