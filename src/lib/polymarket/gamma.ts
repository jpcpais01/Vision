import 'server-only';
import type { BtcMarket, MarketToken, Side } from '../types';
import { WINDOW_SECONDS } from '../config';
import { fetchJson } from '../http';

/**
 * Discovery of the live Bitcoin 5-minute UP/DOWN market via Polymarket's Gamma
 * API.
 *
 * Polymarket does not expose a stable "give me the current BTC 5-minute market"
 * endpoint, and the slug format for these series has changed more than once. So
 * discovery is written as a filter over open markets rather than a hard-coded
 * slug: match the asset and the up/down framing in the question, then keep only
 * markets whose open→close span is actually five minutes. That survives a
 * renaming; a hard-coded slug would not.
 */

interface GammaMarket {
  id?: string | number;
  slug?: string;
  question?: string;
  conditionId?: string;
  startDate?: string;
  startDateIso?: string;
  gameStartTime?: string;
  endDate?: string;
  endDateIso?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  orderPriceMinTickSize?: number | string;
  orderMinSize?: number | string;
  negRisk?: boolean;
  liquidityNum?: number;
  volumeNum?: number;
}

const ASSET_RE = /\b(bitcoin|btc)\b/i;
const UPDOWN_RE = /(up\s*or\s*down|up-or-down|higher\s*or\s*lower|go\s*up)/i;

/** Tolerance around the nominal 300s window, to absorb schedule jitter. */
const MIN_WINDOW_MS = 210_000;
const MAX_WINDOW_MS = 400_000;

export interface DiscoveryOptions {
  gammaUrl: string;
  /** Exact slug to use instead of searching. */
  slug?: string;
  /** Consider markets ending this far in the future, ms. */
  lookaheadMs?: number;
  nowMs?: number;
}

export interface DiscoveryResult {
  current: BtcMarket | null;
  upcoming: BtcMarket[];
  /** Every 5-minute BTC market seen, for diagnostics in the UI. */
  candidates: number;
  scanned: number;
  fetchMs: number;
}

export async function discoverBtcMarkets(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const started = Date.now();
  const now = opts.nowMs ?? Date.now();
  const lookahead = opts.lookaheadMs ?? 45 * 60_000;

  if (opts.slug) {
    const rows = await fetchJson<GammaMarket[]>(
      `${opts.gammaUrl}/markets?slug=${encodeURIComponent(opts.slug)}`,
      { timeoutMs: 8000, retries: 1 }
    );
    const parsed = rows.map((r) => parseMarket(r)).filter(isMarket);
    return {
      current: parsed[0] ?? null,
      upcoming: parsed.slice(1),
      candidates: parsed.length,
      scanned: rows.length,
      fetchMs: Date.now() - started,
    };
  }

  // Ask Gamma for open markets closing soonest. `end_date_min` keeps expired
  // rows out of the page budget, which matters because these series produce
  // 288 markets a day and the default ordering would bury the live one.
  const params = new URLSearchParams({
    closed: 'false',
    archived: 'false',
    active: 'true',
    limit: '500',
    order: 'endDate',
    ascending: 'true',
    end_date_min: new Date(now - WINDOW_SECONDS * 1000).toISOString(),
    end_date_max: new Date(now + lookahead).toISOString(),
  });

  const rows = await fetchJson<GammaMarket[]>(
    `${opts.gammaUrl}/markets?${params.toString()}`,
    { timeoutMs: 9000, retries: 1 }
  );

  const matches = rows
    .filter((r) => {
      const text = `${r.question ?? ''} ${r.slug ?? ''}`;
      return ASSET_RE.test(text) && UPDOWN_RE.test(text);
    })
    .map((r) => parseMarket(r))
    .filter(isMarket)
    .filter((m) => {
      const span = m.endMs - m.startMs;
      return span >= MIN_WINDOW_MS && span <= MAX_WINDOW_MS;
    })
    .sort((a, b) => a.endMs - b.endMs);

  // "Current" is the market whose window contains now, or failing that the next
  // one to open. A window that has already closed is never returned as current.
  const live = matches.find((m) => m.startMs <= now && m.endMs > now) ?? null;
  const next = matches.find((m) => m.startMs > now) ?? null;

  return {
    current: live ?? next,
    upcoming: matches.filter((m) => m !== (live ?? next)).slice(0, 6),
    candidates: matches.length,
    scanned: rows.length,
    fetchMs: Date.now() - started,
  };
}

function isMarket(m: BtcMarket | null): m is BtcMarket {
  return m !== null;
}

function parseMarket(row: GammaMarket): BtcMarket | null {
  const endIso = row.endDate ?? row.endDateIso;
  if (!endIso) return null;
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(endMs)) return null;

  const startIso = row.startDate ?? row.startDateIso ?? row.gameStartTime;
  const parsedStart = startIso ? Date.parse(startIso) : NaN;
  // Some rows carry a series-level start date rather than the window's; if the
  // span is nowhere near five minutes, derive the open from the close instead.
  const derivedStart = endMs - WINDOW_SECONDS * 1000;
  const startMs =
    Number.isFinite(parsedStart) &&
    endMs - parsedStart >= MIN_WINDOW_MS &&
    endMs - parsedStart <= MAX_WINDOW_MS
      ? parsedStart
      : derivedStart;

  const outcomes = asArray(row.outcomes);
  const tokenIds = asArray(row.clobTokenIds);
  if (outcomes.length !== tokenIds.length || tokenIds.length < 2) return null;

  const tokens: MarketToken[] = [];
  for (let i = 0; i < tokenIds.length; i++) {
    const side = normaliseSide(outcomes[i]);
    if (!side) return null;
    tokens.push({ tokenId: String(tokenIds[i]), outcome: String(outcomes[i]), side });
  }
  if (!tokens.some((t) => t.side === 'UP') || !tokens.some((t) => t.side === 'DOWN')) {
    return null;
  }

  return {
    id: String(row.id ?? row.slug ?? row.conditionId ?? endMs),
    slug: row.slug ?? '',
    question: row.question ?? '',
    conditionId: row.conditionId ?? '',
    startMs,
    endMs,
    tokens,
    minTickSize: Number(row.orderPriceMinTickSize ?? 0.001) || 0.001,
    minOrderSize: Number(row.orderMinSize ?? 5) || 5,
    negRisk: Boolean(row.negRisk),
    acceptingOrders: row.acceptingOrders !== false && row.enableOrderBook !== false,
    closed: Boolean(row.closed),
  };
}

/**
 * Map Polymarket's outcome labels onto our UP/DOWN axis. These series have used
 * "Up"/"Down", "Yes"/"No" and "Higher"/"Lower" at different times, so all three
 * vocabularies are accepted; anything else is rejected rather than guessed at,
 * because getting this backwards would invert every trade the system makes.
 */
function normaliseSide(outcome: unknown): Side | null {
  const s = String(outcome ?? '').trim().toLowerCase();
  if (['up', 'yes', 'higher', 'above', 'true'].includes(s)) return 'UP';
  if (['down', 'no', 'lower', 'below', 'false'].includes(s)) return 'DOWN';
  return null;
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function tokenFor(market: BtcMarket, side: Side): MarketToken | null {
  return market.tokens.find((t) => t.side === side) ?? null;
}
