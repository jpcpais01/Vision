'use client';

import { useMemo } from 'react';
import type { Direction, Tick } from '@/lib/types';
import type { Band } from '@/lib/montecarlo';
import { CYCLE_SEC, ENTRY_MARGIN_SEC } from '@/lib/config';

/** One chart. Hand-drawn SVG — no library, nothing to load. */

const UP = '#12805B';
const DOWN = '#C0453F';
const BAND = '#2F6FE4';

interface PositionMark {
  direction: Direction;
  openedAt: number;
  openPrice: number;
  closedAt: number | null;
  closePrice: number | null;
}

/** The live price against the simulated [threshold, 1-threshold] band for this cycle. */
export function CycleChart({
  ticks,
  cycleStart,
  cycleStartPrice,
  band,
  closeAtSecond,
  position,
}: {
  ticks: Tick[];
  cycleStart: number | null;
  cycleStartPrice: number | null;
  band: Band[] | null;
  closeAtSecond: number;
  position: PositionMark | null;
}) {
  const W = 800;
  const H = 340;
  const pad = { t: 12, r: 8, b: 10, l: 8 };

  const pts = useMemo(() => (cycleStart != null ? ticks.filter((k) => k.t >= cycleStart) : []), [ticks, cycleStart]);

  if (!band || cycleStart === null || cycleStartPrice === null || pts.length < 2) {
    return <Placeholder height={H}>Fills in once a cycle starts</Placeholder>;
  }

  const lo = Math.min(cycleStartPrice, ...band.map((b) => b.lo), ...pts.map((p) => p.p));
  const hi = Math.max(cycleStartPrice, ...band.map((b) => b.hi), ...pts.map((p) => p.p));
  const span = Math.max(hi - lo, cycleStartPrice * 0.0006);
  const mid = (hi + lo) / 2;
  const y = (v: number) => pad.t + ((mid + span * 0.6 - v) / (span * 1.2)) * (H - pad.t - pad.b);
  const x = (t: number) => pad.l + Math.min(1, (t - cycleStart) / (CYCLE_SEC * 1000)) * (W - pad.l - pad.r);
  const xSec = (s: number) => pad.l + (s / CYCLE_SEC) * (W - pad.l - pad.r);

  const bandTop = band.map((b, i) => `${i ? 'L' : 'M'} ${xSec(b.sec).toFixed(1)} ${y(b.hi).toFixed(1)}`).join(' ');
  const bandBottom = [...band].reverse().map((b) => `L ${xSec(b.sec).toFixed(1)} ${y(b.lo).toFixed(1)}`).join(' ');
  const bandPath = `${bandTop} ${bandBottom} Z`;

  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p.p).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const above = last.p > cycleStartPrice;
  const entryX = xSec(ENTRY_MARGIN_SEC);
  const closeX = xSec(closeAtSecond);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: H }}
      role="img"
      aria-label="Live price against the simulated probability band for this cycle."
    >
      <path d={bandPath} fill={BAND} opacity="0.1" />
      <line
        x1={pad.l}
        x2={W - pad.r}
        y1={y(cycleStartPrice)}
        y2={y(cycleStartPrice)}
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeDasharray="5 4"
      />
      <line
        x1={entryX}
        x2={entryX}
        y1={pad.t}
        y2={H - pad.b}
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeDasharray="3 3"
      />
      <line
        x1={closeX}
        x2={closeX}
        y1={pad.t}
        y2={H - pad.b}
        stroke="currentColor"
        strokeOpacity="0.22"
        strokeDasharray="3 3"
      />
      <path d={line} fill="none" stroke={above ? UP : DOWN} strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx={x(last.t)} cy={y(last.p)} r="4.5" fill={above ? UP : DOWN} />
      {position ? (
        <>
          <circle
            cx={x(position.openedAt)}
            cy={y(position.openPrice)}
            r="4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
          />
          {position.closedAt !== null && position.closePrice !== null ? (
            <circle cx={x(position.closedAt)} cy={y(position.closePrice)} r="4" fill="currentColor" />
          ) : null}
        </>
      ) : null}
    </svg>
  );
}

function Placeholder({ children, height }: { children: React.ReactNode; height: number }) {
  return (
    <div className="flex items-center justify-center text-xs text-[var(--muted)]" style={{ height }}>
      {children}
    </div>
  );
}
