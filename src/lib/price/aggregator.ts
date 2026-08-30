import type { Bar, PricePoint } from '../types';
import { BAR_SECONDS } from '../config';

const BAR_MS = BAR_SECONDS * 1000;

/** Floor a timestamp onto the 10-second grid the whole system is aligned to. */
export function bucketStart(t: number): number {
  return Math.floor(t / BAR_MS) * BAR_MS;
}

/** Fold raw ticks into 10-second OHLC bars, ascending by time. */
export function ticksToBars(ticks: PricePoint[]): Bar[] {
  if (ticks.length === 0) return [];
  const sorted = [...ticks].sort((a, b) => a.t - b.t);
  const bars: Bar[] = [];
  let cur: Bar | null = null;

  for (const tick of sorted) {
    if (!Number.isFinite(tick.p) || tick.p <= 0) continue;
    const start = bucketStart(tick.t);
    if (!cur || cur.t !== start) {
      if (cur) bars.push(cur);
      cur = { t: start, o: tick.p, h: tick.p, l: tick.p, c: tick.p, v: 0 };
    } else {
      cur.c = tick.p;
      if (tick.p > cur.h) cur.h = tick.p;
      if (tick.p < cur.l) cur.l = tick.p;
    }
  }
  if (cur) bars.push(cur);
  return bars;
}

/**
 * Fill gaps with flat bars so the series is evenly spaced.
 *
 * An evenly spaced series matters twice over: the volatility estimator assumes
 * each return spans the same interval, and the LLM prompt is far easier for a
 * model to read when every row is exactly 10 seconds after the previous one.
 * Synthetic bars are flat (o=h=l=c), contributing a zero return, which is the
 * right behaviour for a brief feed dropout on a market that never stops.
 */
export function fillBarGaps(bars: Bar[], maxGapBars = 30): Bar[] {
  if (bars.length < 2) return bars;
  const out: Bar[] = [bars[0]];
  for (let i = 1; i < bars.length; i++) {
    const prev = out[out.length - 1];
    const gap = (bars[i].t - prev.t) / BAR_MS;
    if (gap > 1 && gap <= maxGapBars) {
      for (let g = 1; g < gap; g++) {
        out.push({
          t: prev.t + g * BAR_MS,
          o: prev.c,
          h: prev.c,
          l: prev.c,
          c: prev.c,
          v: 0,
        });
      }
    }
    out.push(bars[i]);
  }
  return out;
}

/** Merge two bar series, preferring `b` on collisions, and keep it sorted. */
export function mergeBars(a: Bar[], b: Bar[]): Bar[] {
  const map = new Map<number, Bar>();
  for (const bar of a) map.set(bar.t, bar);
  for (const bar of b) map.set(bar.t, bar);
  return Array.from(map.values()).sort((x, y) => x.t - y.t);
}

/** Trim to a trailing window, in minutes. */
export function trimBars(bars: Bar[], minutes: number, nowMs = Date.now()): Bar[] {
  const cutoff = nowMs - minutes * 60_000;
  return bars.filter((b) => b.t >= cutoff);
}

/**
 * Upsample coarse candles (e.g. Coinbase's 60s minimum) onto the 10s grid by
 * geometric interpolation between closes. This is a degraded path — the result
 * has the right level and the right drift but understates realised volatility,
 * so callers flag it and the vol estimator is given a widening adjustment.
 */
export function upsampleToTenSeconds(coarse: Bar[], coarseSeconds: number): Bar[] {
  if (coarse.length === 0) return [];
  const factor = Math.max(1, Math.round(coarseSeconds / BAR_SECONDS));
  if (factor === 1) return coarse;
  const out: Bar[] = [];
  for (let i = 0; i < coarse.length; i++) {
    const bar = coarse[i];
    const nextClose = i + 1 < coarse.length ? coarse[i + 1].c : bar.c;
    for (let k = 0; k < factor; k++) {
      const w = k / factor;
      // Interpolate in log space so the synthetic path is multiplicative.
      // k === 0 is passed through exactly — a round trip through exp(log(x))
      // perturbs the observed close, and this series anchors the barrier.
      const p = k === 0 ? bar.c : Math.exp(Math.log(bar.c) * (1 - w) + Math.log(nextClose) * w);
      out.push({
        t: bar.t + k * BAR_MS,
        o: p,
        h: p,
        l: p,
        c: p,
        v: bar.v / factor,
      });
    }
  }
  return out;
}

/** Latest close, or null on an empty series. */
export function lastPrice(bars: Bar[]): number | null {
  return bars.length > 0 ? bars[bars.length - 1].c : null;
}
