import { handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import type { Trade, WindowRecord } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const store = getStore();
  const [trades, windows] = await Promise.all([store.listTrades(), store.listWindows()]);
  return ok({ trades, windows });
});

/** Upsert by id, so a retry after a dropped connection cannot double-count. */
export const POST = handler(async (req) => {
  const store = getStore();
  const body = (await req.json()) as { trades?: Trade[]; windows?: WindowRecord[]; reset?: boolean };

  if (body.reset) {
    await store.reset();
    return ok({ reset: true });
  }
  for (const t of (body.trades ?? []).slice(0, 200)) {
    if (t?.id) await store.upsertTrade(t);
  }
  for (const w of (body.windows ?? []).slice(0, 200)) {
    if (w?.id) await store.upsertWindow(w);
  }
  return ok({ ok: true });
});
