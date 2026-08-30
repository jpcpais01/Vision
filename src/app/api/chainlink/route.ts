import { env } from '@/lib/env';
import { errorMessage, handler, ok } from '@/lib/api';
import { chainlink } from '@/lib/chainlink';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The on-chain Chainlink fallback — consulted only when a barrier or close
 * needs capturing and Polymarket's own live relay has nothing fresh.
 */
export const GET = handler(async () => {
  try {
    return ok(await chainlink(env.chainlinkRpc(), env.chainlinkFeed()));
  } catch (err) {
    return ok({ price: null, error: errorMessage(err) });
  }
});
