import type { Book } from './types';
import { FUTURES_REST, SYMBOL } from './config';

/** Order-book helpers. Pure, so the same maths prices every paper fill. */

const DEPTH_URL = `${FUTURES_REST}/fapi/v1/depth?symbol=${SYMBOL}&limit=100`;
const EXCHANGE_INFO_URL = `${FUTURES_REST}/fapi/v1/exchangeInfo`;

/**
 * Fetched directly from the browser, same as the live tick stream —
 * Binance's REST API returns 451 for requests from US-based server IPs,
 * which is where a Vercel serverless function runs by default, while a
 * real browser's own connection is unaffected.
 *
 * This fetch's own real round-trip time already is the delay between the
 * trading decision and the book a real order would land against — an
 * earlier version of this also added an artificial delay on top, which
 * just double-counted latency and made every fill stale by however long
 * both waits happened to add up to.
 */
export async function fetchBook(): Promise<Book | null> {
  try {
    const res = await fetch(DEPTH_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return parseBinanceDepth(await res.json());
  } catch {
    return null;
  }
}

export function parseBinanceDepth(raw: unknown): Book {
  const r = (raw ?? {}) as { bids?: [string, string][]; asks?: [string, string][] };
  const level = (l: [string, string]) => ({ price: Number(l[0]), size: Number(l[1]) });
  const valid = (l: { price: number; size: number }) =>
    Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0;

  return {
    bids: (r.bids ?? []).map(level).filter(valid).sort((a, b) => b.price - a.price),
    asks: (r.asks ?? []).map(level).filter(valid).sort((a, b) => a.price - b.price),
    t: Date.now(),
  };
}

export function quote(book: Book | null | undefined): { bid: number | null; ask: number | null } {
  if (!book) return { bid: null, ask: null };
  return { bid: book.bids[0]?.price ?? null, ask: book.asks[0]?.price ?? null };
}

// ── Exchange precision ──────────────────────────────────────────────────────

export interface SymbolFilters {
  tickSize: number;
  stepSize: number;
}

let filtersCache: SymbolFilters | null = null;
let filtersPromise: Promise<SymbolFilters | null> | null = null;

/**
 * The exact quantity/price increments a real order must land on. Fetched
 * once and cached — these do not change during a session, and every fill
 * afterward rounds its quantity down to a lot Binance would actually accept.
 */
export async function symbolFilters(): Promise<SymbolFilters | null> {
  if (filtersCache) return filtersCache;
  if (!filtersPromise) {
    filtersPromise = (async () => {
      try {
        const res = await fetch(`${EXCHANGE_INFO_URL}?symbol=${SYMBOL}`, { cache: 'no-store' });
        if (!res.ok) return null;
        const data = (await res.json()) as {
          symbols?: { filters?: { filterType?: string; tickSize?: string; stepSize?: string }[] }[];
        };
        const filters = data.symbols?.[0]?.filters ?? [];
        const tickSize = Number(filters.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize);
        const stepSize = Number(filters.find((f) => f.filterType === 'LOT_SIZE')?.stepSize);
        if (!(tickSize > 0) || !(stepSize > 0)) return null;
        filtersCache = { tickSize, stepSize };
        return filtersCache;
      } catch {
        return null;
      } finally {
        filtersPromise = null;
      }
    })();
  }
  return filtersPromise;
}

function roundDownToStep(qty: number, step?: number): number {
  if (!step || !(step > 0)) return qty;
  return Math.floor(qty / step) * step;
}

/**
 * Open a position sized in USD: walks real resting depth, consuming levels
 * one at a time, and reports a short fill when the book runs out rather than
 * inventing liquidity that was not there. Buying (LONG) walks the asks;
 * selling (SHORT) walks the bids. The filled quantity is rounded down to a
 * real lot size when one is supplied, since a live order could not land on
 * anything finer.
 */
export function fillUsd(
  book: Book | null,
  side: 'BUY' | 'SELL',
  usd: number,
  stepSize?: number
): { qty: number; price: number } {
  const levels = book ? (side === 'BUY' ? book.asks : book.bids) : [];
  if (levels.length === 0 || usd <= 0) return { qty: 0, price: 0 };

  let leftUsd = usd;
  let qty = 0;
  let cost = 0;
  for (const level of levels) {
    if (leftUsd <= 1e-9) break;
    const levelUsd = level.price * level.size;
    const takeUsd = Math.min(leftUsd, levelUsd);
    qty += takeUsd / level.price;
    cost += takeUsd;
    leftUsd -= takeUsd;
  }
  if (qty <= 0) return { qty: 0, price: 0 };
  const price = cost / qty;
  const rounded = roundDownToStep(qty, stepSize);
  return rounded > 0 ? { qty: rounded, price } : { qty: 0, price: 0 };
}

/**
 * Close a position sized in BTC: same pessimistic walk, but by quantity
 * rather than USD, since a close must exit the exact size that was opened.
 */
export function fillQty(
  book: Book | null,
  side: 'BUY' | 'SELL',
  qty: number,
  stepSize?: number
): { qty: number; price: number } {
  const levels = book ? (side === 'BUY' ? book.asks : book.bids) : [];
  if (levels.length === 0 || qty <= 0) return { qty: 0, price: 0 };

  let left = qty;
  let got = 0;
  let cost = 0;
  for (const level of levels) {
    if (left <= 1e-9) break;
    const take = Math.min(left, level.size);
    cost += take * level.price;
    got += take;
    left -= take;
  }
  if (got <= 0) return { qty: 0, price: 0 };
  const price = cost / got;
  const rounded = roundDownToStep(got, stepSize);
  return rounded > 0 ? { qty: rounded, price } : { qty: 0, price: 0 };
}
