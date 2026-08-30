import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { sanitize } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = getStore();
  const [config, kill] = await Promise.all([store.getConfig(), store.getKillSwitch()]);
  return ok({ config: { ...config, killSwitch: kill } });
});

export const POST = handler(async (req) => {
  const store = getStore();
  const body = (await req.json()) as unknown;
  // Every write is clamped here too, so a hand-rolled POST cannot widen a limit.
  const next = sanitize(body, await store.getConfig());
  await store.setConfig(next);
  if (typeof (body as { killSwitch?: unknown })?.killSwitch === 'boolean') {
    await store.setKillSwitch((body as { killSwitch: boolean }).killSwitch);
  }
  return ok({ config: { ...next, killSwitch: await store.getKillSwitch() } });
});
