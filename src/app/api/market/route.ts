import { env } from '@/lib/env';
import { clientKey, fail, handler, ok, rateLimit } from '@/lib/api';
import { discoverBtcMarkets } from '@/lib/polymarket/gamma';
import { fetchBooks } from '@/lib/polymarket/rest';
import { bookCoherence, quoteFromBook } from '@/lib/polymarket/clob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The live BTC 5-minute market plus both order books in one round trip.
 *
 * Bundled deliberately: the decision needs the market's window boundaries and
 * both sides of the book to be consistent with each other, and two separate
 * calls can straddle a window rollover and produce a book from one market with
 * the timing of another.
 */
export const GET = handler(async (req) => {
  if (!rateLimit(clientKey(req, 'market'), 240, 60_000)) {
    return fail('rate limited', 429);
  }

  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? undefined;
  const withBooks = url.searchParams.get('books') !== 'false';

  const discovery = await discoverBtcMarkets({ gammaUrl: env.gammaUrl(), slug });
  const market = discovery.current;

  if (!market) {
    return ok({
      market: null,
      upcoming: discovery.upcoming,
      books: {},
      quotes: {},
      diagnostics: {
        scanned: discovery.scanned,
        candidates: discovery.candidates,
        fetchMs: discovery.fetchMs,
      },
      serverTime: Date.now(),
    });
  }

  const tokenIds = market.tokens.map((t) => t.tokenId);
  const books = withBooks ? await fetchBooks(env.clobUrl(), tokenIds) : {};

  const quotes: Record<string, ReturnType<typeof quoteFromBook>> = {};
  for (const id of tokenIds) quotes[id] = quoteFromBook(books[id] ?? null);

  const upToken = market.tokens.find((t) => t.side === 'UP');
  const downToken = market.tokens.find((t) => t.side === 'DOWN');
  const coherence =
    upToken && downToken
      ? bookCoherence(quotes[upToken.tokenId], quotes[downToken.tokenId])
      : null;

  return ok({
    market,
    upcoming: discovery.upcoming,
    books,
    quotes,
    coherence,
    diagnostics: {
      scanned: discovery.scanned,
      candidates: discovery.candidates,
      fetchMs: discovery.fetchMs,
    },
    serverTime: Date.now(),
  });
});
