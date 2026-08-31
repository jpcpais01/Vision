import { fail, handler, ok } from '@/lib/api';
import { fetchJson } from '@/lib/http';
import { SYMBOL } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const URL = `https://api.binance.com/api/v3/ticker/price?symbol=${SYMBOL}`;

/** REST fallback for whenever the WebSocket trade stream has nothing fresh. */
export const GET = handler(async () => {
  const raw = await fetchJson<{ price?: string }>(URL, { timeoutMs: 5000, retries: 1 });
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price <= 0) return fail('no price', 502);
  return ok({ price });
});
