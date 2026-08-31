import { handler, ok } from '@/lib/api';
import { fetchJson } from '@/lib/http';
import { parseBinanceDepth } from '@/lib/binanceBook';
import { SYMBOL } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const URL = `https://api.binance.com/api/v3/depth?symbol=${SYMBOL}&limit=100`;

/** Real resting depth for the paper fill model — fetched fresh on every trade decision. */
export const GET = handler(async () => {
  const raw = await fetchJson<unknown>(URL, { timeoutMs: 5000, retries: 1 });
  return ok({ book: parseBinanceDepth(raw) });
});
