import { env } from '@/lib/env';
import { errorMessage, handler, ok } from '@/lib/api';
import { fetchChainlink } from '@/lib/price/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Chainlink BTC/USD aggregator answer.
 *
 * Polymarket's crypto up/down markets settle against an oracle, so this is the
 * number that ultimately decides the bet. It moves on deviation/heartbeat
 * rather than tick by tick, which is exactly why it is reported alongside the
 * exchange feed instead of replacing it: the gap between the two is a real risk
 * the dashboard should show, not hide.
 */
export const GET = handler(async () => {
  try {
    const snapshot = await fetchChainlink(env.chainlinkRpc(), env.chainlinkFeed());
    return ok({ chainlink: snapshot, serverTime: Date.now() });
  } catch (err) {
    // A missing oracle read must not take the dashboard down — it degrades the
    // basis readout and nothing else.
    return ok({ chainlink: null, error: errorMessage(err), serverTime: Date.now() });
  }
});
