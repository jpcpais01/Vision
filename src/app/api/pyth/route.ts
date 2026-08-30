import { env } from '@/lib/env';
import { errorMessage, handler, ok } from '@/lib/api';
import { pythLatest } from '@/lib/pyth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Pyth's Hermes REST endpoint — the engine's fallback price source (both for
 * the barrier and the live tape) whenever the live SSE stream has nothing
 * fresh.
 */
export const GET = handler(async () => {
  try {
    return ok(await pythLatest(env.pythHermesUrl()));
  } catch (err) {
    return ok({ price: null, error: errorMessage(err) });
  }
});
