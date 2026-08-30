import { env } from '@/lib/env';
import { errorMessage, handler, ok } from '@/lib/api';
import { chainlink } from '@/lib/pyth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The free on-chain Chainlink aggregator, for cross-checking only. It is a
 * different and much slower feed than the Data Stream Polymarket settles on,
 * so it never drives a decision — it just makes a divergence visible.
 */
export const GET = handler(async () => {
  try {
    return ok(await chainlink(env.chainlinkRpc(), env.chainlinkFeed()));
  } catch (err) {
    return ok({ price: null, error: errorMessage(err) });
  }
});
