import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { sanitizeConfig } from '@/lib/config';

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
  const current = await store.getConfig();
  // Every write goes through the same clamping used at startup, so a hand-rolled
  // POST cannot install a 100% Kelly fraction or a negative edge threshold.
  const next = sanitizeConfig(body, current);
  await store.setConfig(next);
  if (typeof (body as { killSwitch?: unknown })?.killSwitch === 'boolean') {
    await store.setKillSwitch((body as { killSwitch: boolean }).killSwitch);
  }
  const kill = await store.getKillSwitch();
  return ok({ config: { ...next, killSwitch: kill } });
});
