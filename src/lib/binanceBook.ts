import type { Book } from './types';
import { SYMBOL } from './config';

/** Order-book helpers. Pure, so the same maths prices every paper fill. */

const DEPTH_URL = `https://api.binance.com/api/v3/depth?symbol=${SYMBOL}&limit=100`;

/**
 * Fetched directly from the browser, same as the live tick stream —
 * Binance's REST API returns 451 for requests from US-based server IPs,
 * which is where a Vercel serverless function runs by default, while a
 * real browser's own connection is unaffected.
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

/**
 * Open a position sized in USD: walks real resting depth, consuming levels
 * one at a time, and reports a short fill when the book runs out rather than
 * inventing liquidity that was not there. Buying (LONG) walks the asks;
 * selling (SHORT) walks the bids.
 */
export function fillUsd(book: Book | null, side: 'BUY' | 'SELL', usd: number): { qty: number; price: number } {
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
  return qty > 0 ? { qty, price: cost / qty } : { qty: 0, price: 0 };
}

/**
 * Close a position sized in BTC: same pessimistic walk, but by quantity
 * rather than USD, since a close must exit the exact size that was opened.
 */
export function fillQty(book: Book | null, side: 'BUY' | 'SELL', qty: number): { qty: number; price: number } {
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
  return got > 0 ? { qty: got, price: cost / got } : { qty: 0, price: 0 };
}
