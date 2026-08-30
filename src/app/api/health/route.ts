import { capabilities, env } from '@/lib/env';
import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { liveTradingBlockers } from '@/lib/polymarket/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = getStore();
  // Probe rather than infer: configured is not the same as reachable, and a
  // store that reports "upstash" while every write throws is worse than one
  // that admits it is in memory.
  const storageProbe = await store.ping();
  return ok({
    status: 'ok',
    time: Date.now(),
    capabilities: capabilities(),
    liveBlockers: liveTradingBlockers(),
    storage: store.kind,
    storageOk: storageProbe.ok,
    storageLatencyMs: storageProbe.latencyMs,
    storageError: storageProbe.error ?? null,
    endpoints: {
      clob: env.clobUrl(),
      gamma: env.gammaUrl(),
      chainlinkFeed: env.chainlinkFeed(),
      chainId: env.chainId(),
    },
  });
});
