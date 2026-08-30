import { env } from '@/lib/env';
import { errorMessage, handler, ok } from '@/lib/api';
import { coingeckoLatest } from '@/lib/coingecko';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The engine's only price source — polled on an interval, never pushed. */
export const GET = handler(async () => {
  try {
    return ok(await coingeckoLatest(env.coingeckoApiKey()));
  } catch (err) {
    return ok({ price: null, error: errorMessage(err) });
  }
});
