import { env } from '@/lib/env';
import { errorMessage, handler, ok } from '@/lib/api';
import { chainlink } from '@/lib/chainlink';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The free on-chain Chainlink aggregator — the engine's fallback price source
 * (both for the barrier and the live tape) whenever Polymarket's own live
 * relay has nothing fresh.
 */
export const GET = handler(async () => {
  try {
    return ok(await chainlink(env.chainlinkRpc(), env.chainlinkFeed()));
  } catch (err) {
    return ok({ price: null, error: errorMessage(err) });
  }
});
