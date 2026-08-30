import 'server-only';
import type { Bar, Tick } from './types';
import { fetchJson } from './http';
import { bucket, fillGaps } from './bars';

/**
 * ── Price data ───────────────────────────────────────────────────────────────
 *
 * Polymarket settles these markets on **Chainlink Data Streams BTC/USD** — an
 * aggregate of major centralised-exchange prices, published sub-second.
 * Chainlink does not offer that stream without commercial credentials, and its
 * free on-chain feed is a different, far slower product (it moves on a 0.5%
 * deviation or an hourly heartbeat), so it cannot produce a 10-second series.
 *
 * The closest thing available for free is **Pyth Network**, which is built the
 * same way: an aggregate of major venues, published continuously, delivered
 * through a public API with no key. It is not the settlement feed and will not
 * match it to the cent, but it is an oracle aggregate rather than one
 * exchange's tape — which is the property that matters here.
 *
 * The on-chain Chainlink feed is still read, purely as a cross-check: the gap
 * between the two is shown so a divergence is visible rather than silent.
 */

const HERMES = 'https://hermes.pyth.network';
const BENCHMARKS = 'https://benchmarks.pyth.network';

/** Pyth's BTC/USD price feed id. */
export const BTC_USD_FEED =
  'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

interface HermesLatest {
  parsed?: {
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
  }[];
}

/** Convert Pyth's integer-and-exponent representation to a plain number. */
function toPrice(raw: { price: string; expo: number }): number {
  return Number(raw.price) * 10 ** raw.expo;
}

/** The current BTC/USD price. */
export async function latest(): Promise<Tick> {
  const res = await fetchJson<HermesLatest>(
    `${HERMES}/v2/updates/price/latest?ids[]=0x${BTC_USD_FEED}&parsed=true`,
    { timeoutMs: 5000, retries: 1 }
  );
  const row = res.parsed?.[0];
  if (!row?.price) throw new Error('pyth: no parsed price in response');
  const p = toPrice(row.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error(`pyth: bad price ${row.price.price}`);
  return { t: row.price.publish_time * 1000, p };
}

interface TvHistory {
  s: string;
  t?: number[];
  c?: number[];
  errmsg?: string;
}

/**
 * Seed history for the chart and the volatility estimate.
 *
 * Pyth's public history is minute-resolution, so the returned 10-second series
 * is interpolated between minute closes for anything older than the session.
 * That is good enough to seed volatility and to draw a chart, and the engine
 * replaces it with genuinely observed 10-second bars as the session runs.
 */
export async function history(minutes: number, now = Date.now()): Promise<Bar[]> {
  const to = Math.floor(now / 1000);
  const from = to - minutes * 60 - 120;

  const res = await fetchJson<TvHistory>(
    `${BENCHMARKS}/v1/shims/tradingview/history` +
      `?symbol=${encodeURIComponent('Crypto.BTC/USD')}&resolution=1&from=${from}&to=${to}`,
    { timeoutMs: 9000, retries: 1 }
  );

  if (res.s !== 'ok' || !res.t?.length || !res.c?.length) {
    throw new Error(`pyth history: ${res.errmsg ?? res.s ?? 'empty response'}`);
  }

  const minuteBars: Bar[] = [];
  for (let i = 0; i < res.t.length; i++) {
    const c = res.c[i];
    if (Number.isFinite(c) && c > 0) minuteBars.push({ t: res.t[i] * 1000, c });
  }
  minuteBars.sort((a, b) => a.t - b.t);
  if (minuteBars.length < 2) throw new Error('pyth history: too few candles');

  // Spread each minute across six 10-second slots by interpolating in log
  // space, so the synthetic path is multiplicative rather than additive.
  const out: Bar[] = [];
  for (let i = 0; i < minuteBars.length; i++) {
    const bar = minuteBars[i];
    const next = minuteBars[i + 1]?.c ?? bar.c;
    for (let k = 0; k < 6; k++) {
      const w = k / 6;
      out.push({
        t: bucket(bar.t) + k * 10_000,
        c: k === 0 ? bar.c : Math.exp(Math.log(bar.c) * (1 - w) + Math.log(next) * w),
      });
    }
  }
  return fillGaps(out);
}

// ── Chainlink cross-check ───────────────────────────────────────────────────

const LATEST_ROUND = '0xfeaf968c';

export interface ChainlinkRead {
  price: number;
  updatedAt: number;
  ageMs: number;
}

/**
 * Read the free on-chain Chainlink BTC/USD aggregator.
 *
 * This is NOT the feed Polymarket settles on and it updates far too slowly to
 * trade from. It is here so the dashboard can show how far our price has
 * drifted from an independent oracle — a silent divergence is the failure mode
 * worth catching.
 */
export async function chainlink(rpcUrl: string, feed: string): Promise<ChainlinkRead> {
  const res = await fetchJson<{ result?: string; error?: { message: string } }>(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: feed, data: LATEST_ROUND }, 'latest'],
    }),
    timeoutMs: 6000,
    retries: 1,
  });

  if (res.error) throw new Error(`chainlink: ${res.error.message}`);
  const hex = (res.result ?? '').slice(2);
  if (hex.length < 64 * 5) throw new Error('chainlink: short response');

  const word = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const raw = BigInt('0x' + word(1));
  const signed = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  const price = Number(signed) / 1e8; // the BTC/USD aggregator uses 8 decimals
  const updatedAt = Number(BigInt('0x' + word(3))) * 1000;

  if (!Number.isFinite(price) || price <= 0) throw new Error('chainlink: bad answer');
  return { price, updatedAt, ageMs: Date.now() - updatedAt };
}
