'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Direction, Tick } from '@/lib/types';
import type { Band } from '@/lib/montecarlo';
import { CYCLE_SEC, ENTRY_MARGIN_SEC } from '@/lib/config';

/** One chart. Hand-drawn SVG — no library, nothing to load. The whole point of the screen. */

const UP = '#35e08a';
const DOWN = '#ff5d7a';
const BAND = '#4fd6ff';

interface PositionMark {
  direction: Direction;
  openedAt: number;
  openPrice: number;
  closedAt: number | null;
  closePrice: number | null;
}

/** Tracks a box's actual rendered pixel size, so the chart can draw at that
 *  exact size instead of stretching a fixed-ratio viewBox to fit it. */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ w: Math.round(box.width), h: Math.round(box.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, size] as const;
}

/** The live price against the simulated probability cone for this cycle — full bleed, no chrome. */
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
  const [boxRef, { w, h }] = useElementSize<HTMLDivElement>();

  // Draw at the box's real pixel size — the viewBox matches the rendered
  // size exactly, so there's no aspect-ratio mismatch to stretch away.
  const W = w || 1;
  const H = h || 1;
  const pad = { t: 18, r: 10, b: 14, l: 10 };

  const pts = useMemo(() => (cycleStart != null ? ticks.filter((k) => k.t >= cycleStart) : []), [ticks, cycleStart]);

  const ready = band && cycleStart !== null && cycleStartPrice !== null && pts.length >= 2 && w > 0 && h > 0;

  if (!ready) {
    return (
      <div ref={boxRef} className="h-full w-full">
        <Placeholder>Fills in once a cycle starts</Placeholder>
      </div>
    );
  }

  const lo = Math.min(cycleStartPrice, ...band.map((b) => b.lo), ...pts.map((p) => p.p));
  const hi = Math.max(cycleStartPrice, ...band.map((b) => b.hi), ...pts.map((p) => p.p));
  const span = Math.max(hi - lo, cycleStartPrice * 0.0006);
  const mid = (hi + lo) / 2;
  const y = (v: number) => pad.t + ((mid + span * 0.6 - v) / (span * 1.2)) * (H - pad.t - pad.b);
  const x = (t: number) => pad.l + Math.min(1, (t - cycleStart) / (CYCLE_SEC * 1000)) * (W - pad.l - pad.r);
  const xSec = (s: number) => pad.l + (s / CYCLE_SEC) * (W - pad.l - pad.r);

  const bandTop = band.map((b, i) => `${i ? 'L' : 'M'} ${xSec(b.sec).toFixed(1)} ${y(b.hi).toFixed(1)}`).join(' ');
  const bandBottomPts = [...band].reverse();
  const bandBottom = bandBottomPts.map((b) => `L ${xSec(b.sec).toFixed(1)} ${y(b.lo).toFixed(1)}`).join(' ');
  const bandFillPath = `${bandTop} ${bandBottom} Z`;
  const bandHiPath = band.map((b, i) => `${i ? 'L' : 'M'} ${xSec(b.sec).toFixed(1)} ${y(b.hi).toFixed(1)}`).join(' ');
  const bandLoPath = band.map((b, i) => `${i ? 'L' : 'M'} ${xSec(b.sec).toFixed(1)} ${y(b.lo).toFixed(1)}`).join(' ');

  const line = pts.map((p, i) => `${i ? 'L' : 'M'} ${x(p.t).toFixed(1)} ${y(p.p).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const above = last.p > cycleStartPrice;
  const tone = above ? UP : DOWN;
  const entryX = xSec(ENTRY_MARGIN_SEC);
  const closeX = xSec(closeAtSecond);

  return (
    <div ref={boxRef} className="h-full w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-full w-full"
        role="img"
        aria-label="Live price against the simulated probability cone for this cycle."
      >
        <defs>
          <linearGradient id="cone" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={BAND} stopOpacity="0.32" />
            <stop offset="45%" stopColor={BAND} stopOpacity="0.05" />
            <stop offset="55%" stopColor={BAND} stopOpacity="0.05" />
            <stop offset="100%" stopColor={BAND} stopOpacity="0.32" />
          </linearGradient>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* faint terminal-style horizontal grid */}
        {[0.2, 0.4, 0.6, 0.8].map((f) => (
          <line
            key={f}
            x1={pad.l}
            x2={W - pad.r}
            y1={pad.t + f * (H - pad.t - pad.b)}
            y2={pad.t + f * (H - pad.t - pad.b)}
            stroke="currentColor"
            strokeOpacity="0.05"
          />
        ))}

        <path d={bandFillPath} fill="url(#cone)" />
        <path d={bandHiPath} fill="none" stroke={BAND} strokeOpacity="0.55" strokeWidth="1.5" filter="url(#glow)" />
        <path d={bandLoPath} fill="none" stroke={BAND} strokeOpacity="0.55" strokeWidth="1.5" filter="url(#glow)" />

        <line
          x1={pad.l}
          x2={W - pad.r}
          y1={y(cycleStartPrice)}
          y2={y(cycleStartPrice)}
          stroke="currentColor"
          strokeOpacity="0.3"
          strokeDasharray="6 5"
        />
        <line
          x1={entryX}
          x2={entryX}
          y1={pad.t}
          y2={H - pad.b}
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeDasharray="3 4"
        />
        <line
          x1={closeX}
          x2={closeX}
          y1={pad.t}
          y2={H - pad.b}
          stroke="currentColor"
          strokeOpacity="0.18"
          strokeDasharray="3 4"
        />

        <path d={line} fill="none" stroke={tone} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" filter="url(#glow)" />

        {position ? (
          <>
            <circle
              cx={x(position.openedAt)}
              cy={y(position.openPrice)}
              r="9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            />
            {position.closedAt !== null && position.closePrice !== null ? (
              <circle cx={x(position.closedAt)} cy={y(position.closePrice)} r="7" fill="currentColor" />
            ) : null}
          </>
        ) : null}

        {/* the live marker — a soft pulsing halo behind a solid dot */}
        <circle cx={x(last.t)} cy={y(last.p)} r="20" fill={tone} opacity="0.25" className="animate-pulse" />
        <circle cx={x(last.t)} cy={y(last.p)} r="8" fill={tone} filter="url(#glow)" />
      </svg>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-[var(--muted)]">{children}</div>
  );
}
