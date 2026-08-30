'use client';

import type { MonteCarloResult } from '@/lib/types';
import { CHART_COLORS } from './chartUtils';
import { pct, usd } from '@/lib/format';

/**
 * Terminal price distribution from the simulation, split at the barrier.
 *
 * Reading it: the shaded area to the right of the dashed line *is* the model's
 * P(UP). Showing the whole distribution rather than the scalar makes it obvious
 * when a probability near 50% comes from a tight distribution straddling the
 * barrier (genuinely uncertain) versus a wide one (high vol, low information).
 */
export function DistributionChart({
  mc,
  barrier,
  currentPrice,
  height = 120,
}: {
  mc: MonteCarloResult | null;
  barrier: number | null;
  currentPrice: number | null;
  height?: number;
}) {
  const width = 460;
  const pad = { top: 8, right: 8, bottom: 16, left: 8 };

  if (!mc || barrier === null || mc.histogram.counts.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-2xs text-slate-600"
        style={{ height }}
      >
        No simulation yet.
      </div>
    );
  }

  const { edges, counts } = mc.histogram;
  const maxCount = Math.max(...counts, 1);
  const lo = edges[0];
  const hi = edges[edges.length - 1];
  const span = hi - lo || 1;
  const toX = (p: number) =>
    pad.left + ((p - lo) / span) * (width - pad.left - pad.right);
  const barW = (width - pad.left - pad.right) / counts.length;
  const barrierX = toX(barrier);

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        style={{ height }}
        role="img"
        aria-label={`Simulated terminal price distribution. ${pct(mc.pUp)} of ${mc.paths.toLocaleString()} paths finish above the barrier.`}
      >
        {counts.map((c, i) => {
          const centre = (edges[i] + edges[i + 1]) / 2;
          const h = (c / maxCount) * (height - pad.top - pad.bottom);
          const isUp = centre > barrier;
          return (
            <rect
              key={i}
              x={toX(edges[i]) + 0.75}
              // 2px surface gap between adjacent fills, 1px rounded data-end.
              width={Math.max(0.5, barW - 1.5)}
              y={height - pad.bottom - h}
              height={h}
              rx={1}
              fill={isUp ? CHART_COLORS.up : CHART_COLORS.down}
              opacity={0.72}
            />
          );
        })}

        {/* Barrier */}
        <line
          x1={barrierX}
          x2={barrierX}
          y1={pad.top - 4}
          y2={height - pad.bottom}
          stroke="#e2e8f0"
          strokeWidth={1.5}
          strokeDasharray="4 3"
        />
        <text x={barrierX + 4} y={pad.top + 3} fill="#e2e8f0" fontSize="9">
          barrier
        </text>

        {currentPrice !== null && currentPrice >= lo && currentPrice <= hi ? (
          <>
            <line
              x1={toX(currentPrice)}
              x2={toX(currentPrice)}
              y1={pad.top - 4}
              y2={height - pad.bottom}
              stroke={CHART_COLORS.mc}
              strokeWidth={1.5}
            />
            <text
              x={toX(currentPrice) + 4}
              y={height - pad.bottom - 4}
              fill={CHART_COLORS.mc}
              fontSize="9"
            >
              now
            </text>
          </>
        ) : null}

        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={height - pad.bottom}
          y2={height - pad.bottom}
          stroke={CHART_COLORS.grid}
          strokeWidth={1}
        />
        <text x={pad.left} y={height - 4} fill={CHART_COLORS.ink} fontSize="9" opacity="0.7">
          {usd(lo, 0)}
        </text>
        <text
          x={width - pad.right}
          y={height - 4}
          fill={CHART_COLORS.ink}
          fontSize="9"
          opacity="0.7"
          textAnchor="end"
        >
          {usd(hi, 0)}
        </text>
      </svg>

      <div className="mt-1 flex items-center justify-between text-2xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: CHART_COLORS.up }}
          />
          resolves UP
        </span>
        <span className="tnum">
          5–95%: {usd(mc.quantiles.q05, 0)} → {usd(mc.quantiles.q95, 0)}
        </span>
        <span className="flex items-center gap-1.5">
          resolves DOWN
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: CHART_COLORS.down }}
          />
        </span>
      </div>
    </div>
  );
}
