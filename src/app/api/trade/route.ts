import { env } from '@/lib/env';
import { clientKey, fail, handler, ok, rateLimit } from '@/lib/api';
import { getStore } from '@/lib/store';
import { fetchBook } from '@/lib/polymarket/rest';
import { quoteFromBook, roundPriceUp, simulateBuy } from '@/lib/polymarket/clob';
import { liveTradingBlockers, placeLiveOrder } from '@/lib/polymarket/live';
import type { Mode, Side, Trade } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface TradeRequest {
  mode: Mode;
  marketId: string;
  marketSlug: string;
  tokenId: string;
  side: Side;
  size: number;
  /** Worst price we are willing to pay per share. */
  limitPrice: number;
  tickSize: number;
  minOrderSize: number;
  negRisk: boolean;
  modelP: number;
  llmP: number;
  marketP: number;
  edge: number;
  btcStart: number;
  btcEntry: number;
  secondsLeftAtEntry: number;
}

/**
 * Execute a trade. This is the only path to a real order in the system.
 *
 * The client proposes; the server disposes. Nothing the browser sends is
 * trusted for anything that matters:
 *
 *  - the order book is re-fetched here, so a paper fill is priced against
 *    depth that exists right now rather than whatever the tab last saw;
 *  - position size is re-clamped against the server-held config, so editing
 *    the request in devtools cannot exceed the configured caps;
 *  - the kill switch is read server-side on every request;
 *  - LIVE mode additionally requires `ALLOW_LIVE_TRADING=true` and a
 *    server-side private key, neither of which the UI can influence.
 *
 * The result is that PAPER and LIVE run the same gauntlet and differ only in
 * the final step: simulate the fill, or send it.
 */
export const POST = handler(async (req) => {
  if (!rateLimit(clientKey(req, 'trade'), 60, 60_000)) {
    return fail('rate limited', 429);
  }

  const body = (await req.json()) as TradeRequest;
  const store = getStore();
  const [config, killSwitch] = await Promise.all([store.getConfig(), store.getKillSwitch()]);

  // ── Hard stops ──────────────────────────────────────────────────────────
  if (killSwitch) return fail('kill switch is engaged', 423, { killSwitch: true });
  if (body.mode !== 'PAPER' && body.mode !== 'LIVE') return fail('invalid mode', 400);
  if (body.side !== 'UP' && body.side !== 'DOWN') return fail('invalid side', 400);
  if (!body.tokenId) return fail('tokenId required', 400);
  if (!Number.isFinite(body.size) || body.size <= 0) return fail('invalid size', 400);
  if (!Number.isFinite(body.limitPrice) || body.limitPrice <= 0 || body.limitPrice >= 1) {
    return fail('invalid limitPrice', 400);
  }

  if (body.mode === 'LIVE') {
    const blockers = liveTradingBlockers();
    if (blockers.length > 0) {
      return fail(`LIVE trading is not enabled: ${blockers.join('; ')}`, 403, { blockers });
    }
  }

  // ── Re-price against the live book ──────────────────────────────────────
  const book = await fetchBook(env.clobUrl(), body.tokenId);
  const quote = quoteFromBook(book);
  if (quote.ask === null) return fail('no resting asks on this token', 409);

  // Refuse if the market ran away from the price the decision was made at.
  if (quote.ask > body.limitPrice) {
    return fail('market moved beyond limit price', 409, {
      limitPrice: body.limitPrice,
      currentAsk: quote.ask,
    });
  }
  if (quote.ask < config.minPrice || quote.ask > config.maxPrice) {
    return fail('price outside configured bounds', 409, { ask: quote.ask });
  }
  if (quote.spread !== null && quote.spread > config.maxSpread) {
    return fail('spread widened beyond limit', 409, { spread: quote.spread });
  }

  // ── Re-clamp size against server-side risk limits ───────────────────────
  const tickSize = clampTick(body.tickSize);
  const capUsd = Math.min(
    config.maxPositionUsd,
    config.bankroll * config.maxPositionPctBankroll,
    config.bankroll
  );
  const maxShares = Math.floor(capUsd / quote.ask);
  const size = Math.min(Math.floor(body.size), maxShares, Math.floor(quote.askSize));

  const minOrderSize = Number.isFinite(body.minOrderSize) ? body.minOrderSize : 5;
  if (size < Math.max(1, minOrderSize)) {
    return fail('size below market minimum after risk clamping', 409, {
      requested: body.size,
      allowed: size,
      minOrderSize,
    });
  }

  // Pay up to one tick through the touch: enough to cross reliably, not enough
  // to turn a 4-cent edge into a 1-cent one.
  const limitPrice = Math.min(
    body.limitPrice,
    roundPriceUp(Math.min(quote.ask + tickSize, config.maxPrice), tickSize)
  );

  const now = Date.now();
  const id = `${body.mode.toLowerCase()}-${now.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const base: Omit<Trade, 'fill' | 'status' | 'entryPrice' | 'notional' | 'orderId'> = {
    id,
    mode: body.mode,
    marketId: body.marketId,
    marketSlug: body.marketSlug,
    tokenId: body.tokenId,
    side: body.side,
    t: now,
    size,
    modelP: clamp01(body.modelP),
    llmP: clamp01(body.llmP),
    marketP: quote.ask,
    edge: Number.isFinite(body.edge) ? body.edge : clamp01(body.modelP) - quote.ask,
    pnl: null,
    btcStart: body.btcStart,
    btcEntry: body.btcEntry,
    btcSettle: null,
    resolvedAt: null,
    outcome: null,
    secondsLeftAtEntry: body.secondsLeftAtEntry,
  };

  // ── Execute ─────────────────────────────────────────────────────────────
  if (body.mode === 'PAPER') {
    const started = Date.now();
    const fill = simulateBuy(book, size, { tickSize, latencyTicks: 1, maxPrice: config.maxPrice });
    fill.latencyMs = Date.now() - started;

    if (fill.filledSize <= 0) {
      return fail('simulated fill found no liquidity', 409);
    }

    const trade: Trade = {
      ...base,
      size: fill.filledSize,
      entryPrice: fill.avgPrice,
      notional: fill.filledSize * fill.avgPrice,
      status: 'OPEN',
      orderId: null,
      fill,
    };
    await store.upsertTrade(trade);
    return ok({ trade, simulated: true });
  }

  // LIVE
  const res = await placeLiveOrder({
    tokenId: body.tokenId,
    side: body.side,
    price: limitPrice,
    size,
    tickSize,
    negRisk: Boolean(body.negRisk),
  });

  const trade: Trade = {
    ...base,
    size: res.fill.filledSize || size,
    entryPrice: res.fill.avgPrice || limitPrice,
    notional: (res.fill.filledSize || size) * (res.fill.avgPrice || limitPrice),
    status: res.success ? 'OPEN' : 'FAILED',
    orderId: res.orderId,
    fill: res.fill,
    ...(res.error ? { error: res.error } : {}),
  };

  await store.upsertTrade(trade);
  if (!res.success) {
    return ok({ trade, simulated: false, error: res.error }, { status: 200 });
  }
  return ok({ trade, simulated: false });
});

function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.min(1, Math.max(0, n));
}

function clampTick(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0.001;
  return Math.min(0.1, Math.max(0.0001, n));
}
