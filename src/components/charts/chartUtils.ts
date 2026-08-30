/** Shared scale + path helpers for the hand-rolled SVG charts. */

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
  invert(px: number): number;
}

export function linearScale(
  domain: [number, number],
  range: [number, number]
): Scale {
  let [d0, d1] = domain;
  if (d0 === d1) {
    // A flat series still needs a visible band rather than a divide-by-zero.
    const pad = Math.abs(d0) * 0.001 || 1;
    d0 -= pad;
    d1 += pad;
  }
  const [r0, r1] = range;
  const fn = ((v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0)) as Scale;
  fn.domain = [d0, d1];
  fn.range = range;
  fn.invert = (px: number) => d0 + ((px - r0) / (r1 - r0)) * (d1 - d0);
  return fn;
}

export function extent(values: number[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (lo === Infinity) return [0, 1];
  return [lo, hi];
}

/** Pad a domain by a fraction of its span, and optionally include a value. */
export function padDomain(
  domain: [number, number],
  fraction = 0.08,
  include?: number
): [number, number] {
  let [lo, hi] = domain;
  if (include !== undefined && Number.isFinite(include)) {
    lo = Math.min(lo, include);
    hi = Math.max(hi, include);
  }
  const span = hi - lo || Math.abs(hi) * 0.002 || 1;
  return [lo - span * fraction, hi + span * fraction];
}

export function linePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`;
  }
  return d;
}

export function areaPath(
  points: { x: number; y: number }[],
  baselineY: number
): string {
  if (points.length === 0) return '';
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L ${last.x.toFixed(2)} ${baselineY.toFixed(2)} L ${first.x.toFixed(2)} ${baselineY.toFixed(2)} Z`;
}

/** Nice round tick values inside a domain. */
export function ticks(domain: [number, number], count = 4): number[] {
  const [lo, hi] = domain;
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const rawStep = span / count;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    out.push(Number(v.toFixed(10)));
  }
  return out;
}

/** Index of the point whose x is nearest `px`, for crosshair hit-testing. */
export function nearestIndex(xs: number[], px: number): number {
  if (xs.length === 0) return -1;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < xs.length; i++) {
    const d = Math.abs(xs[i] - px);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export const CHART_COLORS = {
  mc: '#3987e5',
  llm: '#d55181',
  mkt: '#c98500',
  up: '#199e70',
  down: '#e66767',
  grid: 'rgba(148, 163, 184, 0.11)',
  axis: 'rgba(148, 163, 184, 0.45)',
  ink: '#94a3b8',
  surface: '#0f141e',
} as const;
