import { capabilities, env } from '@/lib/env';
import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { liveTradingBlockers } from '@/lib/polymarket/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = getStore();
  return ok({
    status: 'ok',
    time: Date.now(),
    capabilities: capabilities(),
    liveBlockers: liveTradingBlockers(),
    storage: store.kind,
    endpoints: {
      clob: env.clobUrl(),
      gamma: env.gammaUrl(),
      chainlinkFeed: env.chainlinkFeed(),
      chainId: env.chainId(),
    },
  });
});
