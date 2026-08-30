import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { cancelAllOrders, liveTradingBlockers } from '@/lib/polymarket/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Emergency stop.
 *
 * Engaging the kill switch does two things: it sets a server-side flag that the
 * order route checks on every request (so a stale browser tab cannot trade
 * through it), and — when LIVE credentials are present — it cancels every
 * resting order on the account. Disengaging only clears the flag.
 */
export const POST = handler(async (req) => {
  const store = getStore();
  const body = (await req.json().catch(() => ({}))) as { engaged?: boolean };
  const engaged = body.engaged !== false;

  await store.setKillSwitch(engaged);
  if (engaged) {
    const config = await store.getConfig();
    await store.setConfig({ ...config, autoTrade: false });
  }

  let cancelled: { ok: boolean; error?: string } | null = null;
  if (engaged && liveTradingBlockers().length === 0) {
    cancelled = await cancelAllOrders();
  }

  return ok({ killSwitch: engaged, cancelledResting: cancelled });
});

export const GET = handler(async () => {
  const store = getStore();
  return ok({ killSwitch: await store.getKillSwitch() });
});
