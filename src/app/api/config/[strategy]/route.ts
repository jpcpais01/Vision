import { fail, handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { sanitize } from '@/lib/config';
import { isStrategyId } from '@/lib/strategies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { strategy: string } };

export const GET = handler<[Ctx]>(async (_req, { params }) => {
  if (!isStrategyId(params.strategy)) return fail('unknown strategy', 404);
  const store = getStore();
  const config = await store.getConfig(params.strategy);
  return ok({ config });
});

export const POST = handler<[Ctx]>(async (req, { params }) => {
  if (!isStrategyId(params.strategy)) return fail('unknown strategy', 404);
  const store = getStore();
  const body = (await req.json()) as unknown;
  // Every write is clamped here too, so a hand-rolled POST cannot widen a limit.
  const next = sanitize(body, await store.getConfig(params.strategy));
  await store.setConfig(params.strategy, next);
  return ok({ config: next });
});
