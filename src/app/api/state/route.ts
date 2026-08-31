import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import type { CycleRecord, Position } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = getStore();
  const [positions, cycles] = await Promise.all([store.listPositions(), store.listCycles()]);
  return ok({ positions, cycles });
});

/** Upsert by id, so a retry after a dropped connection cannot double-count. */
export const POST = handler(async (req) => {
  const store = getStore();
  const body = (await req.json()) as { positions?: Position[]; cycles?: CycleRecord[]; reset?: boolean };

  if (body.reset) {
    await store.reset();
    return ok({ reset: true });
  }
  for (const p of (body.positions ?? []).slice(0, 200)) {
    if (p?.id) await store.upsertPosition(p);
  }
  for (const c of (body.cycles ?? []).slice(0, 200)) {
    if (c?.id) await store.upsertCycle(c);
  }
  return ok({ ok: true });
});
