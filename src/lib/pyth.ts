import { fetchJson } from './http';

/**
 * ── Pyth Network — Hermes ────────────────────────────────────────────────────
 *
 * A free, public, no-key price oracle that aggregates BTC/USD from many
 * exchanges and market makers (not a single exchange's tape). This is the
 * fallback read behind the live SSE stream (see `pythFeed.ts`): a genuine,
 * fresh pull of the same aggregate, just polled rather than pushed.
 *
 * Confirmed against Pyth's own `pyth-crosschain` source on GitHub
 * (apps/hermes/server/src/api/rest/v2/latest_price_updates.rs and
 * apps/hermes/client/js/README.md): the endpoint, the BTC/USD price feed id,
 * and the response shape below are taken directly from it. `price` and `conf`
 * are serialized as strings there specifically to avoid precision loss
 * crossing the JS number boundary.
 */

export const BTC_USD_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

interface HermesLatest {
  parsed?: { price?: { price?: string; expo?: number; publish_time?: number } }[];
}

export interface PythRead {
  price: number;
  publishedAt: number; // epoch ms
}

export async function pythLatest(hermesUrl: string): Promise<PythRead> {
  const url = `${hermesUrl}/v2/updates/price/latest?ids[]=${BTC_USD_ID}&parsed=true`;
  const res = await fetchJson<HermesLatest>(url, { timeoutMs: 6000, retries: 1 });

  const p = res.parsed?.[0]?.price;
  if (!p || typeof p.price !== 'string' || typeof p.expo !== 'number') {
    throw new Error('pyth: bad response shape');
  }
  const price = Number(p.price) * 10 ** p.expo;
  if (!Number.isFinite(price) || price <= 0) throw new Error('pyth: bad price');

  const publishedAt = typeof p.publish_time === 'number' ? p.publish_time * 1000 : Date.now();
  return { price, publishedAt };
}
