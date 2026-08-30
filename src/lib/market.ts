import 'server-only';
import type { Market, MarketToken, Side } from './types';
import { WINDOW_SEC } from './config';
import { fetchJson } from './http';

/**
 * Finding the live BTC 5-minute market.
 *
 * Matched by content rather than by slug — the slug format for this series has
 * changed more than once, and a hard-coded one silently stops finding markets.
 */

interface GammaRow {
  id?: string | number;
  slug?: string;
  question?: string;
  startDate?: string;
  endDate?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  closed?: boolean;
  orderPriceMinTickSize?: number | string;
  orderMinSize?: number | string;
  negRisk?: boolean;
}

const ASSET = /\b(bitcoin|btc)\b/i;
const UPDOWN = /(up\s*or\s*down|up-or-down|higher\s*or\s*lower)/i;
const MIN_SPAN = 210_000;
const MAX_SPAN = 400_000;

export interface Discovery {
  /** The window currently open, if any. */
  live: Market | null;
  /** The next one to open. */
  next: Market | null;
}

export async function discover(gammaUrl: string, now = Date.now()): Promise<Discovery> {
  const params = new URLSearchParams({
    closed: 'false',
    archived: 'false',
    active: 'true',
    limit: '400',
    order: 'endDate',
    ascending: 'true',
    end_date_min: new Date(now - WINDOW_SEC * 1000).toISOString(),
    end_date_max: new Date(now + 40 * 60_000).toISOString(),
  });

  const rows = await fetchJson<GammaRow[]>(`${gammaUrl}/markets?${params}`, {
    timeoutMs: 9000,
    retries: 1,
  });

  const markets = rows
    .filter((r) => {
      const text = `${r.question ?? ''} ${r.slug ?? ''}`;
      return ASSET.test(text) && UPDOWN.test(text);
    })
    .map(parse)
    .filter((m): m is Market => m !== null)
    .filter((m) => {
      const span = m.endMs - m.startMs;
      return span >= MIN_SPAN && span <= MAX_SPAN;
    })
    .sort((a, b) => a.startMs - b.startMs);

  return {
    live: markets.find((m) => m.startMs <= now && m.endMs > now) ?? null,
    next: markets.find((m) => m.startMs > now) ?? null,
  };
}

function parse(row: GammaRow): Market | null {
  if (row.closed) return null;
  const endMs = row.endDate ? Date.parse(row.endDate) : NaN;
  if (!Number.isFinite(endMs)) return null;

  const parsedStart = row.startDate ? Date.parse(row.startDate) : NaN;
  const span = endMs - parsedStart;
  const startMs =
    Number.isFinite(parsedStart) && span >= MIN_SPAN && span <= MAX_SPAN
      ? parsedStart
      : endMs - WINDOW_SEC * 1000;

  const outcomes = asArray(row.outcomes);
  const ids = asArray(row.clobTokenIds);
  if (outcomes.length < 2 || outcomes.length !== ids.length) return null;

  const tokens: MarketToken[] = [];
  for (let i = 0; i < ids.length; i++) {
    const side = toSide(outcomes[i]);
    // Reject rather than guess: getting this mapping backwards would invert
    // every trade the system makes.
    if (!side) return null;
    tokens.push({ tokenId: String(ids[i]), side });
  }
  if (!tokens.some((t) => t.side === 'UP') || !tokens.some((t) => t.side === 'DOWN')) return null;

  return {
    id: String(row.id ?? row.slug ?? endMs),
    slug: row.slug ?? '',
    question: row.question ?? '',
    startMs,
    endMs,
    tokens,
    minTickSize: Number(row.orderPriceMinTickSize ?? 0.001) || 0.001,
    minOrderSize: Number(row.orderMinSize ?? 5) || 5,
    negRisk: Boolean(row.negRisk),
    acceptingOrders: row.acceptingOrders !== false && row.enableOrderBook !== false,
  };
}

function toSide(v: unknown): Side | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (['up', 'yes', 'higher', 'above'].includes(s)) return 'UP';
  if (['down', 'no', 'lower', 'below'].includes(s)) return 'DOWN';
  return null;
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
