import type { BookLevel, BookQuote, FillReport, OrderBook } from '../types';

/**
 * CLOB order-book utilities.
 *
 * Split deliberately from the server-only fetching code: every function here is
 * pure, so the same quote maths and the same walk-the-book fill model run on
 * the client for the live dashboard and on the server for order placement.
 * Paper mode and live mode therefore price a fill through identical code.
 */

interface RawBook {
  market?: string;
  asset_id?: string;
  bids?: { price: string; size: string }[];
  asks?: { price: string; size: string }[];
  hash?: string;
  timestamp?: string;
}

export function parseBook(raw: RawBook, tokenId: string): OrderBook {
  const bids = (raw.bids ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(validLevel)
    .sort((a, b) => b.price - a.price);

  const asks = (raw.asks ?? [])
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter(validLevel)
    .sort((a, b) => a.price - b.price);

  return {
    tokenId: raw.asset_id ?? tokenId,
    bids,
    asks,
    t: Date.now(),
    hash: raw.hash,
  };
}

function validLevel(l: BookLevel): boolean {
  return Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0;
}

/**
 * Top-of-book summary plus the notional resting within `depthCents` of the
 * touch. Depth matters more than the touch size on Polymarket: a 5-share top
 * level backed by 400 shares one tick behind is tradeable; a lone 5-share level
 * is not.
 */
export function quoteFromBook(book: OrderBook | null, depthCents = 0.02): BookQuote {
  if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
    return {
      bid: null,
      ask: null,
      bidSize: 0,
      askSize: 0,
      mid: null,
      spread: null,
      bidDepthUsd: 0,
      askDepthUsd: 0,
    };
  }

  const bid = book.bids[0]?.price ?? null;
  const ask = book.asks[0]?.price ?? null;

  let bidDepthUsd = 0;
  if (bid !== null) {
    for (const l of book.bids) {
      if (l.price < bid - depthCents) break;
      bidDepthUsd += l.price * l.size;
    }
  }
  let askDepthUsd = 0;
  if (ask !== null) {
    for (const l of book.asks) {
      if (l.price > ask + depthCents) break;
      askDepthUsd += l.price * l.size;
    }
  }

  return {
    bid,
    ask,
    bidSize: book.bids[0]?.size ?? 0,
    askSize: book.asks[0]?.size ?? 0,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : (bid ?? ask),
    spread: bid !== null && ask !== null ? ask - bid : null,
    bidDepthUsd,
    askDepthUsd,
  };
}

/**
 * Walk the resting asks to price a marketable buy of `size` shares.
 *
 * This is the paper-mode fill model, and it is intentionally pessimistic:
 *  - it consumes real resting depth level by level rather than assuming the
 *    whole order fills at the touch;
 *  - it reports a partial fill when the book runs out, exactly as a
 *    fill-or-kill against a thin book would;
 *  - it never invents liquidity beyond what the live book actually showed.
 *
 * The one thing it cannot model is queue competition — another taker lifting
 * the same level microseconds earlier — so an extra adverse tick is applied
 * through `latencyTicks` to stand in for that race.
 */
export function simulateBuy(
  book: OrderBook | null,
  size: number,
  opts: { latencyTicks?: number; tickSize?: number; maxPrice?: number } = {}
): FillReport {
  const { latencyTicks = 1, tickSize = 0.001, maxPrice = 0.99 } = opts;
  const empty: FillReport = {
    simulated: true,
    requestedSize: size,
    filledSize: 0,
    avgPrice: 0,
    slippage: 0,
    levels: [],
    latencyMs: 0,
  };
  if (!book || book.asks.length === 0 || size <= 0) return empty;

  const touch = book.asks[0].price;
  let remaining = size;
  let cost = 0;
  let filled = 0;
  const levels: BookLevel[] = [];

  for (const level of book.asks) {
    if (remaining <= 1e-9) break;
    // Latency haircut: assume the front of each level may already be gone.
    // Deliberately NOT clamped to maxPrice — clamping would both defeat the
    // check below and quietly report a cheaper fill than the book can give.
    const adjPrice = level.price + latencyTicks * tickSize;
    if (adjPrice > maxPrice) break;
    const take = Math.min(remaining, level.size);
    cost += take * adjPrice;
    filled += take;
    remaining -= take;
    levels.push({ price: adjPrice, size: take });
  }

  if (filled <= 0) return empty;
  const avgPrice = cost / filled;
  return {
    simulated: true,
    requestedSize: size,
    filledSize: filled,
    avgPrice,
    slippage: avgPrice - touch,
    levels,
    latencyMs: 0,
  };
}

/** Round a price to the market's tick grid, away from us (conservative). */
export function roundPriceUp(price: number, tickSize: number): number {
  const ticks = Math.ceil(price / tickSize - 1e-9);
  return Number((ticks * tickSize).toFixed(6));
}

export function roundPriceDown(price: number, tickSize: number): number {
  const ticks = Math.floor(price / tickSize + 1e-9);
  return Number((ticks * tickSize).toFixed(6));
}

/**
 * Polymarket quotes UP and DOWN as separate books that must sum to $1. When one
 * side is thin, its complement often is not, so a synthetic quote derived from
 * the other book can be the better execution. This reports the crossed/locked
 * state so the UI can flag it and the risk layer can refuse to trade it.
 */
export function bookCoherence(
  up: BookQuote,
  down: BookQuote
): { impliedSum: number | null; crossed: boolean; arbitrage: number } {
  if (up.ask === null || down.ask === null) {
    return { impliedSum: null, crossed: false, arbitrage: 0 };
  }
  const sum = up.ask + down.ask;
  // Buying both sides below $1 is a risk-free profit and normally means one of
  // the books is stale — treat it as a data-quality signal, not a trade.
  return { impliedSum: sum, crossed: sum < 0.995, arbitrage: Math.max(0, 1 - sum) };
}
