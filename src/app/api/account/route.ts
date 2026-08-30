import { handler, ok } from '@/lib/api';
import { fetchBalance, liveTradingBlockers } from '@/lib/polymarket/live';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * LIVE account buying power. Returns the blockers instead of an error when the
 * deployment has no credentials, so PAPER users see an explanation rather than
 * a red failure.
 */
export const GET = handler(async () => {
  const blockers = liveTradingBlockers();
  if (blockers.length > 0) {
    return ok({ available: false, blockers, balance: null, allowance: null });
  }
  const res = await fetchBalance();
  return ok({
    available: res.ok,
    blockers: [],
    balance: res.balance ?? null,
    allowance: res.allowance ?? null,
    error: res.error ?? null,
  });
});
