import { capabilities } from '@/lib/env';
import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = getStore();
  const probe = await store.ping();
  return ok({
    ok: true,
    capabilities: capabilities(),
    storage: store.kind,
    storageOk: probe.ok,
    storageError: probe.error ?? null,
  });
});
