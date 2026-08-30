import { capabilities, env } from '@/lib/env';
import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { liveTradingBlockers } from '@/lib/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = getStore();
  const probe = await store.ping();
  return ok({
    ok: true,
    capabilities: capabilities(),
    liveBlockers: liveTradingBlockers(),
    storage: store.kind,
    storageOk: probe.ok,
    storageError: probe.error ?? null,
    model: env.openrouterModel(),
  });
});
