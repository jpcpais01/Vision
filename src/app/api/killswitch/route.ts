import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { cancelAllOrders, liveTradingBlockers } from '@/lib/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Emergency stop. Sets a server-side flag the order route reads on every
 * request — so a browser tab left open elsewhere cannot trade through it — and
 * cancels any resting orders when live credentials are present.
 */
export const POST = handler(async (req) => {
  const store = getStore();
  const { engaged = true } = (await req.json().catch(() => ({}))) as { engaged?: boolean };

  await store.setKillSwitch(engaged);
  if (engaged) {
    await store.setConfig({ ...(await store.getConfig()), autoTrade: false });
  }
  const cancelled = engaged && liveTradingBlockers().length === 0 ? await cancelAllOrders() : null;
  return ok({ killSwitch: engaged, cancelled });
});
