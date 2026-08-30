import type { Bar, Tick } from './types';
import { BAR_SEC } from './config';

const BAR_MS = BAR_SEC * 1000;

/** Shift every close by `delta`. Used to re-level the tape when the Chainlink
 *  anchor offset changes, so history and live ticks stay on one basis. */
export function shiftBars(bars: Bar[], delta: number): Bar[] {
  if (delta === 0) return bars;
  return bars.map((b) => ({ ...b, c: b.c + delta }));
}

export function shiftTicks(ticks: Tick[], delta: number): Tick[] {
  if (delta === 0) return ticks;
  return ticks.map((t) => ({ ...t, p: t.p + delta }));
}

export function bucket(t: number): number {
  return Math.floor(t / BAR_MS) * BAR_MS;
}

/** Fold ticks into 10-second closes. */
export function toBars(ticks: Tick[]): Bar[] {
  const out: Bar[] = [];
  for (const tick of [...ticks].sort((a, b) => a.t - b.t)) {
    if (!(tick.p > 0)) continue;
    const t = bucket(tick.t);
    const last = out[out.length - 1];
    if (last && last.t === t) last.c = tick.p;
    else out.push({ t, c: tick.p });
  }
  return out;
}

/**
 * Fill gaps with flat bars so the series is evenly spaced.
 * The volatility estimate assumes every return spans the same interval, and a
 * brief feed gap should contribute a zero return rather than a fake jump.
 */
export function fillGaps(bars: Bar[], maxRun = 60): Bar[] {
  if (bars.length < 2) return bars;
  const out: Bar[] = [bars[0]];
  for (let i = 1; i < bars.length; i++) {
    const prev = out[out.length - 1];
    const gap = (bars[i].t - prev.t) / BAR_MS;
    if (gap > 1 && gap <= maxRun) {
      for (let g = 1; g < gap; g++) out.push({ t: prev.t + g * BAR_MS, c: prev.c });
    }
    out.push(bars[i]);
  }
  return out;
}

export function merge(a: Bar[], b: Bar[]): Bar[] {
  const m = new Map<number, Bar>();
  for (const bar of a) m.set(bar.t, bar);
  for (const bar of b) m.set(bar.t, bar);
  return [...m.values()].sort((x, y) => x.t - y.t);
}

export function trim(bars: Bar[], minutes: number, now = Date.now()): Bar[] {
  const cutoff = now - minutes * 60_000;
  return bars.filter((b) => b.t >= cutoff);
}

/** Log returns of consecutive closes. */
export function returns(bars: Bar[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const a = bars[i - 1].c;
    const b = bars[i].c;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

const SECONDS_PER_YEAR = 365 * 24 * 3600;

/**
 * Per-second volatility from 10-second returns.
 *
 * EWMA weighted toward the recent (λ=0.97 over 10s bars is roughly a 5-minute
 * half-life), because volatility five minutes ago tells you much more about the
 * next five minutes than volatility half an hour ago does.
 */
export function volatility(bars: Bar[]): { sigma: number; volPct: number; samples: number } {
  const r = returns(bars);
  if (r.length < 10) {
    // Not enough tape yet. A typical BTC level beats pretending vol is zero,
    // which would make every edge look enormous.
    const sigma = 0.45 / Math.sqrt(SECONDS_PER_YEAR);
    return { sigma, volPct: 45, samples: r.length };
  }

  const seed = Math.min(r.length, 30);
  let v = 0;
  for (let i = 0; i < seed; i++) v += r[i] * r[i];
  v /= seed;
  for (let i = seed; i < r.length; i++) v = 0.97 * v + 0.03 * r[i] * r[i];

  const sigma = Math.sqrt(Math.max(v, 1e-16) / BAR_SEC);
  return {
    sigma,
    volPct: sigma * Math.sqrt(SECONDS_PER_YEAR) * 100,
    samples: r.length,
  };
}
