import { env } from '@/lib/env';
import { handler, ok } from '@/lib/api';
import { discover } from '@/lib/market';
import { fetchBooks } from '@/lib/clob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The current and next BTC 5-minute markets, with both order books in the same
 * response — a book fetched separately can straddle a window rollover and end
 * up describing a different market than the timing does.
 */
export const GET = handler(async () => {
  const { live, next } = await discover(env.gammaUrl());
  const tokens = [...(live?.tokens ?? []), ...(next?.tokens ?? [])].map((t) => t.tokenId);
  const books = tokens.length > 0 ? await fetchBooks(env.clobUrl(), [...new Set(tokens)]) : {};
  return ok({ live, next, books });
});
