import { env } from '@/lib/env';
import { errorMessage, handler, ok } from '@/lib/api';
import { chainlink } from '@/lib/chainlink';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The free on-chain Chainlink aggregator. Used two ways: the engine reads this
 * once per window to anchor Binance's price to it, and polls it separately in
 * the background purely to display the live gap between the two.
 */
export const GET = handler(async () => {
  try {
    return ok(await chainlink(env.chainlinkRpc(), env.chainlinkFeed()));
  } catch (err) {
    return ok({ price: null, error: errorMessage(err) });
  }
});
