import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Clear the durable record. Scoped so logs can be cleared without losing P&L. */
export const POST = handler(async (req) => {
  const body = (await req.json().catch(() => ({}))) as { scope?: string };
  const scope =
    body.scope === 'trades' || body.scope === 'cycles' || body.scope === 'logs'
      ? body.scope
      : 'all';
  await getStore().reset(scope);
  return ok({ reset: scope });
});
