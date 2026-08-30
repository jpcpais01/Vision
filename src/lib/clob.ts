import 'server-only';
import type { Book } from './types';
import { fetchJson } from './http';
import { parseBook } from './book';

/** Public CLOB reads. No authentication required for any of these. */

export async function fetchBook(clobUrl: string, tokenId: string): Promise<Book> {
  const raw = await fetchJson<unknown>(
    `${clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`,
    { timeoutMs: 5000, retries: 1 }
  );
  return parseBook(raw, tokenId);
}

export async function fetchBooks(
  clobUrl: string,
  tokenIds: string[]
): Promise<Record<string, Book>> {
  const books = await Promise.all(tokenIds.map((id) => fetchBook(clobUrl, id)));
  const out: Record<string, Book> = {};
  for (const b of books) out[b.tokenId] = b;
  return out;
}
