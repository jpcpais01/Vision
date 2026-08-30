import 'server-only';
import type { OrderBook } from '../types';
import { fetchJson } from '../http';
import { parseBook } from './clob';

/** Server-side reads against the public CLOB REST API. No auth required. */

export async function fetchBook(clobUrl: string, tokenId: string): Promise<OrderBook> {
  const raw = await fetchJson<Record<string, unknown>>(
    `${clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`,
    { timeoutMs: 5000, retries: 1 }
  );
  return parseBook(raw as never, tokenId);
}

/** Batch book fetch — one round trip for both sides of the market. */
export async function fetchBooks(
  clobUrl: string,
  tokenIds: string[]
): Promise<Record<string, OrderBook>> {
  if (tokenIds.length === 0) return {};
  try {
    const raw = await fetchJson<Record<string, unknown>[]>(`${clobUrl}/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
      timeoutMs: 6000,
      retries: 1,
    });
    const out: Record<string, OrderBook> = {};
    raw.forEach((row, i) => {
      const book = parseBook(row as never, tokenIds[i]);
      out[book.tokenId] = book;
    });
    // The batch endpoint can silently drop a token; fill any gap individually.
    const missing = tokenIds.filter((id) => !out[id]);
    if (missing.length > 0) {
      const filled = await Promise.all(missing.map((id) => fetchBook(clobUrl, id)));
      for (const b of filled) out[b.tokenId] = b;
    }
    return out;
  } catch {
    const books = await Promise.all(tokenIds.map((id) => fetchBook(clobUrl, id)));
    const out: Record<string, OrderBook> = {};
    for (const b of books) out[b.tokenId] = b;
    return out;
  }
}

export async function fetchMidpoint(
  clobUrl: string,
  tokenId: string
): Promise<number | null> {
  try {
    const r = await fetchJson<{ mid: string }>(
      `${clobUrl}/midpoint?token_id=${encodeURIComponent(tokenId)}`,
      { timeoutMs: 4000, retries: 0 }
    );
    const v = Number(r.mid);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Server clock offset, so latency budgets are not fooled by a skewed client. */
export async function fetchServerTime(clobUrl: string): Promise<number | null> {
  try {
    const res = await fetch(`${clobUrl}/time`, { cache: 'no-store' });
    const text = await res.text();
    const v = Number(text.trim());
    return Number.isFinite(v) ? v * 1000 : null;
  } catch {
    return null;
  }
}
