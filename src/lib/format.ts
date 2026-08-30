export const cx = (...p: (string | false | null | undefined)[]) => p.filter(Boolean).join(' ');

export function usd(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  })}`;
}

export function signed(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(dp)}`;
}

export function pct(v: number | null | undefined, dp = 0): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(dp)}%`;
}

export function pts(v: number | null | undefined, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(dp)}%`;
}

export function clock(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—:—';
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function time(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleTimeString('en-GB', { hour12: false }) : '—';
}
