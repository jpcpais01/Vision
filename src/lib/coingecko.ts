import { fetchJson } from './http';

/**
 * ── CoinGecko ─────────────────────────────────────────────────────────────────
 *
 * A free, well-known price aggregator across many exchanges — not one
 * exchange's own tape, and not the Chainlink Data Streams feed Polymarket
 * itself settles on (that needs paid credentials), but a genuine, reputable
 * cross-exchange index. Used after Polymarket's own live Chainlink relay and
 * then Pyth Network's free oracle both turned out not to be reachable in
 * practice from this app's deployment.
 *
 * Confirmed against CoinGecko's own `coingecko-typescript` client source on
 * GitHub (src/client.ts, src/resources/simple/price.ts): the base URL, the
 * `/simple/price` endpoint, its query params, the `x-cg-demo-api-key` header
 * name, and the response shape below are taken directly from it.
 *
 * Works without a key at a low, unauthenticated rate limit; `COINGECKO_API_KEY`
 * (a free Demo key from coingecko.com, no payment) raises that headroom.
 */

export const BASE_URL = 'https://api.coingecko.com/api/v3';

interface SimplePriceResponse {
  bitcoin?: { usd?: number; last_updated_at?: number };
}

export interface CoinGeckoRead {
  price: number;
  publishedAt: number; // epoch ms
}

export async function coingeckoLatest(apiKey: string, baseUrl: string = BASE_URL): Promise<CoinGeckoRead> {
  const params = new URLSearchParams({
    ids: 'bitcoin',
    vs_currencies: 'usd',
    include_last_updated_at: 'true',
  });
  const url = `${baseUrl}/simple/price?${params.toString()}`;

  const res = await fetchJson<SimplePriceResponse>(url, {
    timeoutMs: 6000,
    retries: 1,
    headers: apiKey ? { 'x-cg-demo-api-key': apiKey } : {},
  });

  const btc = res.bitcoin;
  if (!btc || typeof btc.usd !== 'number' || !(btc.usd > 0)) {
    throw new Error('coingecko: bad response shape');
  }

  const publishedAt = typeof btc.last_updated_at === 'number' ? btc.last_updated_at * 1000 : Date.now();
  return { price: btc.usd, publishedAt };
}
