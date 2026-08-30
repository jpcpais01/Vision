import type { Market, MarketToken, Side } from './types';
import { WINDOW_SEC } from './config';
import { fetchJson } from './http';

/**
 * Finding the live BTC 5-minute market.
 *
 * Polymarket's BTC 5-minute up/down markets sit on a fixed grid: each one
 * opens on a UTC timestamp divisible by 300 and is slugged
 * `btc-updown-5m-<window-start-in-unix-seconds>`. That means the current and
 * next window can be computed from the clock rather than found by searching —
 * which matters, because the previous approach (list open markets, keep the
 * ones whose question text mentions Bitcoin and "up or down", keep the ones
 * whose span looks like five minutes) had two ways to land on the wrong
 * market: Polymarket runs "Up or Down" BTC series at other durations too
 * (hourly, daily) that match the same text, and `active=true` is documented to
 * filter these particular recurring markets out via an internal
 * "Hide From New" tag — so a plain listing search can silently return neither
 * the right market nor a clean failure, just a wrong one.
 *
 * The listing search is kept as a fallback for if Polymarket ever changes the
 * slug scheme, but the slug is now the primary path.
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
  const nowSec = Math.floor(now / 1000);
  const currentStart = Math.floor(nowSec / WINDOW_SEC) * WINDOW_SEC;

  const [current, next] = await Promise.all([
    bySlug(gammaUrl, currentStart),
    bySlug(gammaUrl, currentStart + WINDOW_SEC),
  ]);

  if (current || next) {
    return {
      live: current && current.startMs <= now && current.endMs > now ? current : null,
      next: next ?? (current && current.startMs > now ? current : null),
    };
  }

  // The grid produced nothing — either a genuine gap, or the slug scheme has
  // moved. Fall back to searching rather than reporting no market at all.
  return discoverByListing(gammaUrl, now);
}

/**
 * Fetch one window by its deterministic slug. `startSec` is authoritative —
 * it is not re-derived from the row's own `startDate`/`endDate`, which removes
 * an entire class of bug where a market with a missing or oddly formatted date
 * field gets assigned the wrong window boundaries.
 */
async function bySlug(gammaUrl: string, startSec: number): Promise<Market | null> {
  const slug = `btc-updown-5m-${startSec}`;
  try {
    const rows = await fetchJson<GammaRow[]>(
      `${gammaUrl}/markets?slug=${encodeURIComponent(slug)}`,
      { timeoutMs: 6000, retries: 1 }
    );
    const row = rows[0];
    if (!row || row.closed) return null;
    return parseTokens(row, startSec * 1000, (startSec + WINDOW_SEC) * 1000);
  } catch {
    return null;
  }
}

async function discoverByListing(gammaUrl: string, now: number): Promise<Discovery> {
  const params = new URLSearchParams({
    closed: 'false',
    archived: 'false',
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
    .map(parseFromDates)
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

/** Parse a row whose window boundaries came from Gamma's own date fields. */
function parseFromDates(row: GammaRow): Market | null {
  if (row.closed) return null;
  const endMs = row.endDate ? Date.parse(row.endDate) : NaN;
  if (!Number.isFinite(endMs)) return null;

  const parsedStart = row.startDate ? Date.parse(row.startDate) : NaN;
  const span = endMs - parsedStart;
  // Reject rather than guess a window: a market whose real span is not
  // five minutes (an hourly or daily "Up or Down" series, say) must not be
  // silently reshaped into looking like one.
  if (!Number.isFinite(parsedStart) || span < MIN_SPAN || span > MAX_SPAN) return null;

  return parseTokens(row, parsedStart, endMs);
}

function parseTokens(row: GammaRow, startMs: number, endMs: number): Market | null {
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
