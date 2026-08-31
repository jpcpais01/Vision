import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Emergency stop. Sets a server-side flag the client engine polls via
 * /api/config — so a browser tab left open elsewhere still halts.
 */
export const POST = handler(async (req) => {
  const store = getStore();
  const { engaged = true } = (await req.json().catch(() => ({}))) as { engaged?: boolean };

  await store.setKillSwitch(engaged);
  if (engaged) {
    await store.setConfig({ ...(await store.getConfig()), autoTrade: false });
  }
  return ok({ killSwitch: engaged });
});
