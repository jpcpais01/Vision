import { env } from '@/lib/env';
import { fail, handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { fetchBook } from '@/lib/clob';
import { fill, quote } from '@/lib/book';
import { liveTradingBlockers, placeLiveOrder } from '@/lib/live';
import type { Mode, Side, Trade } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface Body {
  mode: Mode;
  marketId: string;
  marketSlug: string;
  tokenId: string;
  side: Side;
  shares: number;
  maxPrice: number;
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  ourProb: number;
  barrier: number;
}

/**
 * The only path to an order.
 *
 * The browser proposes and the server disposes: the kill switch is read here,
 * the book is re-fetched here, and the stake is re-clamped against the
 * server's own config — so editing the request in devtools changes nothing
 * that matters.
 */
export const POST = handler(async (req) => {
  const b = (await req.json()) as Body;
  const store = getStore();
  const [config, killSwitch] = await Promise.all([store.getConfig(), store.getKillSwitch()]);

  if (killSwitch) return fail('kill switch is engaged', 423);
  if (b.mode !== 'PAPER' && b.mode !== 'LIVE') return fail('invalid mode', 400);
  if (b.side !== 'UP' && b.side !== 'DOWN') return fail('invalid side', 400);
  if (!b.tokenId) return fail('tokenId required', 400);

  if (b.mode === 'LIVE') {
    const blockers = liveTradingBlockers();
    if (blockers.length > 0) return fail(`LIVE not enabled: ${blockers.join('; ')}`, 403);
  }

  // Price against the book as it is right now, not as the browser last saw it.
  const book = await fetchBook(env.clobUrl(), b.tokenId);
  const q = quote(book);
  if (q.ask === null) return fail('no offers to buy', 409);
  if (q.ask > b.maxPrice) return fail(`price moved to ${q.ask.toFixed(3)}`, 409);
  if (q.ask < 0.02 || q.ask > 0.98) return fail('price too extreme', 409);

  // Re-clamp the stake against the server's config, then against real depth.
  const affordable = Math.floor(config.stakeUsd / q.ask);
  const shares = Math.min(Math.floor(b.shares) || 0, affordable, Math.floor(q.askSize));
  const min = Math.max(1, Number(b.minOrderSize) || 5);
  if (shares < min) return fail(`size ${shares} below the market minimum of ${min}`, 409);

  const id = `${b.mode.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const base = {
    id,
    mode: b.mode,
    marketId: b.marketId,
    marketSlug: b.marketSlug,
    tokenId: b.tokenId,
    side: b.side,
    t: Date.now(),
    ourProb: clamp01(b.ourProb),
    marketProb: q.ask,
    edge: clamp01(b.ourProb) - q.ask,
    pnl: null,
    barrier: Number(b.barrier) || 0,
    settlePrice: null,
    outcome: null,
  };

  if (b.mode === 'PAPER') {
    const f = fill(book, shares, Number(b.tickSize) || 0.001);
    if (f.shares <= 0) return fail('no liquidity for a simulated fill', 409);
    const trade: Trade = {
      ...base,
      shares: f.shares,
      price: f.price,
      cost: f.shares * f.price,
      status: 'OPEN',
    };
    await store.upsertTrade(trade);
    return ok({ trade });
  }

  const res = await placeLiveOrder({
    tokenId: b.tokenId,
    side: b.side,
    price: Math.min(0.98, q.ask + (Number(b.tickSize) || 0.001)),
    size: shares,
    tickSize: Number(b.tickSize) || 0.001,
    negRisk: Boolean(b.negRisk),
  });

  const filled = res.fill.filledSize || shares;
  const price = res.fill.avgPrice || q.ask;
  const trade: Trade = {
    ...base,
    shares: filled,
    price,
    cost: filled * price,
    status: res.success ? 'OPEN' : 'FAILED',
    ...(res.error ? { error: res.error } : {}),
  };
  await store.upsertTrade(trade);
  return res.success ? ok({ trade }) : ok({ trade, error: res.error });
});

function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(1, Math.max(0, n));
}
