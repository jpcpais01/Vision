import { env } from '@/lib/env';
import { fail, handler, ok } from '@/lib/api';
import { fetchBooks } from '@/lib/polymarket/rest';
import { quoteFromBook } from '@/lib/polymarket/clob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Order books for explicit token ids — the polling fallback for the UI's socket. */
export const GET = handler(async (req) => {
  const url = new URL(req.url);
  const raw = url.searchParams.get('tokenIds') ?? '';
  const tokenIds = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
  if (tokenIds.length === 0) return fail('tokenIds required', 400);

  const books = await fetchBooks(env.clobUrl(), tokenIds);
  const quotes: Record<string, ReturnType<typeof quoteFromBook>> = {};
  for (const id of tokenIds) quotes[id] = quoteFromBook(books[id] ?? null);

  return ok({ books, quotes, serverTime: Date.now() });
});
