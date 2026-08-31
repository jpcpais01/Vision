'use client';

import { useEffect, useRef, useState } from 'react';
import type { Direction, Tick } from '@/lib/types';
import type { Band } from '@/lib/montecarlo';
import { CYCLE_SEC, ENTRY_MARGIN_SEC } from '@/lib/config';
import { usd } from '@/lib/format';

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

  // A continuously-growing trail for this cycle: seeded from real ticks the
  // instant they exist, then sampled every 100ms at the last known price —
  // so the line is always an actual, growing curve. A single trailing point
  // recomputed fresh each tick could collapse to a near-zero-length segment
  // (dot visible, line effectively invisible) right after a cycle rolls or
  // in a quiet market; an accumulating buffer can't degenerate that way.
  const [trail, setTrail] = useState<{ t: number; p: number }[]>([]);
  const latest = useRef({ ticks, cycleStart });
  latest.current = { ticks, cycleStart };

  useEffect(() => {
    setTrail([]);
  }, [cycleStart]);

  useEffect(() => {
    const id = setInterval(() => {
      const { ticks: t, cycleStart: cs } = latest.current;
      if (cs == null) return;
      const real = t.filter((k) => k.t >= cs);
      setTrail((prev) => {
        const base = prev.length ? prev : real;
        const price = real[real.length - 1]?.p ?? base[base.length - 1]?.p;
        if (price === undefined) return prev;
        const now = Date.now();
        const next = base[base.length - 1]?.t === now ? base : [...base, { t: now, p: price }];
        return next.length > 700 ? next.slice(-700) : next;
      });
    }, 100);
    return () => clearInterval(id);
  }, []);

  const pts = trail;

  const ready = band && cycleStart !== null && cycleStartPrice !== null && pts.length >= 2 && w > 0 && h > 0;

  if (!ready) {
    return (
      <div ref={boxRef} className="h-full w-full">
        <Placeholder>Fills in once a cycle starts</Placeholder>
      </div>
    );
  }

  // The y-axis is centered on the start price, with the visible half-range
  // held to at least 3x the probability cone's own peak deviation from it —
  // so the cone (and the price line inside it) sits with generous headroom
  // instead of filling the chart edge to edge. A real price move that
  // outruns the cone still forces the axis wider, so it's never clipped.
  const bandDev = band.reduce((m, b) => Math.max(m, Math.abs(b.hi - cycleStartPrice), Math.abs(b.lo - cycleStartPrice)), 0);
  const priceDev = pts.reduce((m, p) => Math.max(m, Math.abs(p.p - cycleStartPrice)), 0);
  const halfSpan = Math.max(bandDev * 3, priceDev, cycleStartPrice * 0.0006);
  const mid = cycleStartPrice;
  const y = (v: number) => pad.t + ((mid + halfSpan - v) / (halfSpan * 2)) * (H - pad.t - pad.b);
  const x = (t: number) => pad.l + Math.min(1, (t - cycleStart) / (CYCLE_SEC * 1000)) * (W - pad.l - pad.r);
  const xSec = (s: number) => pad.l + (s / CYCLE_SEC) * (W - pad.l - pad.r);

  const bandTop = band.map((b, i) => `${i ? 'L' : 'M'} ${xSec(b.sec).toFixed(1)} ${y(b.hi).toFixed(1)}`).join(' ');
  const bandBottomPts = [...band].reverse();
  const bandBottom = bandBottomPts.map((b) => `L ${xSec(b.sec).toFixed(1)} ${y(b.lo).toFixed(1)}`).join(' ');
  const bandFillPath = `${bandTop} ${bandBottom} Z`;
  const bandHiPath = band.map((b, i) => `${i ? 'L' : 'M'} ${xSec(b.sec).toFixed(1)} ${y(b.hi).toFixed(1)}`).join(' ');
  const bandLoPath = band.map((b, i) => `${i ? 'L' : 'M'} ${xSec(b.sec).toFixed(1)} ${y(b.lo).toFixed(1)}`).join(' ');

  const line = smoothPath(pts.map((p) => ({ x: x(p.t), y: y(p.p) })));
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

        {/* faint terminal-style horizontal grid, each line labelled with its price */}
        {[0.2, 0.4, 0.6, 0.8].map((f) => {
          const gy = pad.t + f * (H - pad.t - pad.b);
          const price = mid + halfSpan * (1 - 2 * f);
          return (
            <g key={f}>
              <line x1={pad.l} x2={W - pad.r} y1={gy} y2={gy} stroke="currentColor" strokeOpacity="0.05" />
              <text
                x={pad.l + 4}
                y={gy - 3}
                fontSize="9"
                fontFamily="'IBM Plex Mono', ui-monospace, monospace"
                fill="currentColor"
                fillOpacity="0.45"
              >
                {usd(price, 0)}
              </text>
            </g>
          );
        })}

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

        <path d={line} fill="none" stroke={tone} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" filter="url(#glow)" />

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

        {/* the live marker — a soft pulsing halo behind a small solid dot */}
        <circle cx={x(last.t)} cy={y(last.p)} r="12" fill={tone} opacity="0.25" className="animate-pulse" />
        <circle cx={x(last.t)} cy={y(last.p)} r="4" fill={tone} filter="url(#glow)" />
      </svg>
    </div>
  );
}

/** Quadratic-through-midpoints smoothing — cheap, no library, and enough to
 *  turn a jagged tick-by-tick polyline into one continuous curve. */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const midX = (pts[i].x + pts[i + 1].x) / 2;
    const midY = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-xs text-[var(--muted)]">{children}</div>
  );
}
