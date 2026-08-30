'use client';

import { useMemo } from 'react';
import type { Tick } from '@/lib/types';
import { WINDOW_SEC } from '@/lib/config';

/** Two small charts. Hand-drawn SVG — no library, nothing to load. */

const UP = '#12805B';
const DOWN = '#C0453F';
const OURS = '#2F6FE4';
const MARKET = '#8A93A3';

/** BTC this window, against the barrier it settles on. */
export function PriceChart({
  ticks,
  barrier,
  startMs,
  endMs,
}: {
  ticks: Tick[];
  barrier: number | null;
  startMs: number | null;
  endMs: number | null;
}) {
  const W = 800;
  const H = 150;
  const pad = { t: 12, r: 8, b: 12, l: 8 };

  const pts = useMemo(
    () => (startMs ? ticks.filter((k) => k.t >= startMs) : []),
    [ticks, startMs]
  );

  if (!barrier || !startMs || !endMs || pts.length < 2) {
    return <Placeholder height={H}>Price appears when the window opens</Placeholder>;
  }

  const lo = Math.min(barrier, ...pts.map((p) => p.p));
  const hi = Math.max(barrier, ...pts.map((p) => p.p));
  const span = Math.max(hi - lo, barrier * 0.0004);
  const mid = (hi + lo) / 2;
  const y = (v: number) =>
    pad.t + ((mid + span * 0.75 - v) / (span * 1.5)) * (H - pad.t - pad.b);
  const x = (t: number) => pad.l + ((t - startMs) / (endMs - startMs)) * (W - pad.l - pad.r);

  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p.p).toFixed(1)}`).join(' ');
  const base = y(barrier);
  const last = pts[pts.length - 1];
  const above = last.p > barrier;
  const area = `${line} L ${x(last.t).toFixed(1)} ${base.toFixed(1)} L ${x(pts[0].t).toFixed(1)} ${base.toFixed(1)} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: H }}
      role="img"
      aria-label={`Bitcoin is ${above ? 'above' : 'below'} the barrier of ${barrier.toFixed(0)} dollars.`}
    >
      <path d={area} fill={above ? UP : DOWN} opacity="0.14" />
      <line
        x1={pad.l}
        x2={W - pad.r}
        y1={base}
        y2={base}
        stroke="currentColor"
        strokeOpacity="0.45"
        strokeDasharray="5 4"
      />
      <path d={line} fill="none" stroke={above ? UP : DOWN} strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx={x(last.t)} cy={y(last.p)} r="4.5" fill={above ? UP : DOWN} />
    </svg>
  );
}

/** The simulation's P(UP) against what the market charges for UP, over the window. */
export function ProbChart({
  track,
  startMs,
}: {
  track: { t: number; pUp: number; askUp: number | null; askDown: number | null }[];
  startMs: number | null;
}) {
  const W = 800;
  const H = 110;
  const pad = { t: 10, r: 8, b: 14, l: 8 };

  if (!startMs || track.length < 2) {
    return <Placeholder height={H}>Fills in once the window opens</Placeholder>;
  }

  const x = (t: number) =>
    pad.l + Math.min(1, (t - startMs) / (WINDOW_SEC * 1000)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b);

  const path = (pick: (p: (typeof track)[number]) => number | null) => {
    const seg = track.map((p) => ({ v: pick(p), t: p.t })).filter((p) => p.v !== null);
    return seg.map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p.v!).toFixed(1)}`).join(' ');
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: H }}
      role="img"
      aria-label="The simulation's probability of UP against the market's UP price over this window."
    >
      {[0.25, 0.5, 0.75].map((v) => (
        <line
          key={v}
          x1={pad.l}
          x2={W - pad.r}
          y1={y(v)}
          y2={y(v)}
          stroke="currentColor"
          strokeOpacity={v === 0.5 ? 0.22 : 0.1}
          strokeDasharray={v === 0.5 ? '4 4' : undefined}
        />
      ))}
      <path d={path((p) => p.askUp)} fill="none" stroke={MARKET} strokeWidth="2" />
      <path d={path((p) => p.pUp)} fill="none" stroke={OURS} strokeWidth="2.5" />
    </svg>
  );
}

function Placeholder({ children, height }: { children: React.ReactNode; height: number }) {
  return (
    <div
      className="flex items-center justify-center text-xs text-[var(--muted)]"
      style={{ height }}
    >
      {children}
    </div>
  );
}
