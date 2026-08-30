import type { Book, Quote } from './types';

/** Order-book helpers. Pure, so the same maths prices a paper and a live fill. */

export function parseBook(raw: unknown, tokenId: string): Book {
  const r = (raw ?? {}) as {
    asset_id?: string;
    bids?: { price: string; size: string }[];
    asks?: { price: string; size: string }[];
  };
  const level = (l: { price: string; size: string }) => ({
    price: Number(l.price),
    size: Number(l.size),
  });
  const valid = (l: { price: number; size: number }) =>
    Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0;

  return {
    tokenId: r.asset_id ?? tokenId,
    bids: (r.bids ?? []).map(level).filter(valid).sort((a, b) => b.price - a.price),
    asks: (r.asks ?? []).map(level).filter(valid).sort((a, b) => a.price - b.price),
    t: Date.now(),
  };
}

export function quote(book: Book | null | undefined): Quote {
  if (!book) return { bid: null, ask: null, askSize: 0 };
  return {
    bid: book.bids[0]?.price ?? null,
    ask: book.asks[0]?.price ?? null,
    askSize: book.asks[0]?.size ?? 0,
  };
}

/**
 * Price a marketable buy against real resting depth.
 *
 * Used for paper fills, and deliberately pessimistic: it consumes real levels
 * one at a time, charges a tick more than shown to stand in for the race
 * against other takers, and reports a short fill when the book runs out rather
 * than inventing liquidity that was not there.
 */
export function fill(
  book: Book | null,
  shares: number,
  tickSize = 0.001
): { shares: number; price: number } {
  if (!book || book.asks.length === 0 || shares <= 0) return { shares: 0, price: 0 };

  let left = shares;
  let cost = 0;
  let got = 0;

  for (const level of book.asks) {
    if (left <= 1e-9) break;
    const price = Math.min(0.999, level.price + tickSize);
    const take = Math.min(left, level.size);
    cost += take * price;
    got += take;
    left -= take;
  }

  return got > 0 ? { shares: got, price: cost / got } : { shares: 0, price: 0 };
}
