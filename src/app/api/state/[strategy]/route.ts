import { fail, handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { isStrategyId } from '@/lib/strategies';
import type { CycleRecord, Position } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { strategy: string } };

export const GET = handler<[Ctx]>(async (_req, { params }) => {
  if (!isStrategyId(params.strategy)) return fail('unknown strategy', 404);
  const store = getStore();
  const [positions, cycles] = await Promise.all([
    store.listPositions(params.strategy),
    store.listCycles(params.strategy),
  ]);
  return ok({ positions, cycles });
});

/** Upsert by id, so a retry after a dropped connection cannot double-count. */
export const POST = handler<[Ctx]>(async (req, { params }) => {
  if (!isStrategyId(params.strategy)) return fail('unknown strategy', 404);
  const store = getStore();
  const body = (await req.json()) as { positions?: Position[]; cycles?: CycleRecord[]; reset?: boolean };

  if (body.reset) {
    await store.reset(params.strategy);
    return ok({ reset: true });
  }
  for (const p of (body.positions ?? []).slice(0, 200)) {
    if (p?.id) await store.upsertPosition(params.strategy, p);
  }
  for (const c of (body.cycles ?? []).slice(0, 200)) {
    if (c?.id) await store.upsertCycle(params.strategy, c);
  }
  return ok({ ok: true });
});
