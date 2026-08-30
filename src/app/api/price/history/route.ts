import { clientKey, fail, handler, ok, rateLimit } from '@/lib/api';
import { fetchHistory } from '@/lib/price/sources';
import { trimBars } from '@/lib/price/aggregator';
import { estimateVolatility } from '@/lib/quant/volatility';
import type { PriceSourceName } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ~1 hour of 10-second BTC bars, plus the volatility estimate derived from
 * them. Fetched server-side so the exchange endpoints are hit from one place
 * with one retry policy, and so a browser that cannot reach Binance directly
 * still gets true 10-second resolution.
 */
export const GET = handler(async (req) => {
  if (!rateLimit(clientKey(req, 'history'), 30, 60_000)) {
    return fail('rate limited', 429);
  }

  const url = new URL(req.url);
  const minutes = clampInt(Number(url.searchParams.get('minutes') ?? 60), 5, 180);
  const source = (url.searchParams.get('source') ?? 'binance') as PriceSourceName;
  const lambda = Number(url.searchParams.get('lambda') ?? 0.97);

  const result = await fetchHistory(minutes, source);
  const bars = trimBars(result.bars, minutes);
  const vol = estimateVolatility(bars, Number.isFinite(lambda) ? lambda : 0.97);

  return ok({
    bars,
    vol,
    source: result.source,
    endpoint: result.endpoint,
    interpolated: result.interpolated,
    nativeSeconds: result.nativeSeconds,
    fetchMs: result.fetchMs,
    serverTime: Date.now(),
  });
});

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
