import { handler, ok } from '@/lib/api';
import { fetchTick } from '@/lib/price/sources';
import type { PriceSourceName } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Single spot price. This is the polling fallback used when the browser cannot
 * hold a direct exchange WebSocket (corporate proxy, regional block). It is
 * slower than the socket by design — the UI labels the feed accordingly.
 */
export const GET = handler(async (req) => {
  const url = new URL(req.url);
  const source = (url.searchParams.get('source') ?? 'binance') as PriceSourceName;
  const tick = await fetchTick(source);
  return ok({ ...tick, serverTime: Date.now() });
});
