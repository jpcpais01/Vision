import 'server-only';
import type { Bar, ChainlinkSnapshot, PriceSnapshot, PriceSourceName } from '../types';
import { BAR_SECONDS } from '../config';
import { fetchJson, firstSuccess } from '../http';
import { bucketStart, fillBarGaps, ticksToBars, upsampleToTenSeconds } from './aggregator';

/**
 * Real BTC price data, with failover.
 *
 * Only Binance publishes 1-second klines, which is the only public REST source
 * that can reconstruct a true 10-second history an hour deep. It is also the
 * source most likely to be unavailable from a given serverless region, so the
 * other venues are kept as graded fallbacks and the caller is told, explicitly,
 * when the series it received is interpolated rather than observed.
 */

export interface HistoryResult {
  bars: Bar[];
  source: PriceSourceName;
  /** True when bars were upsampled from coarser candles. */
  interpolated: boolean;
  /** Native resolution of the underlying candles, in seconds. */
  nativeSeconds: number;
  fetchMs: number;
  endpoint: string;
}

// Binance publishes the same API on several hostnames; regional blocks tend to
// hit them one at a time, so we walk the list rather than giving up.
const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://data-api.binance.vision',
];

type BinanceKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  ...unknown[],
];

/**
 * Pull `minutes` of 1-second klines and fold them into 10-second bars.
 * Binance caps a request at 1000 klines, so an hour needs four calls; they are
 * issued in parallel because the whole history fetch sits on the critical path
 * at the top of every 5-minute window.
 */
async function binanceHistory(minutes: number, nowMs: number): Promise<HistoryResult> {
  const started = Date.now();
  const totalSeconds = Math.ceil(minutes * 60);
  const endTime = nowMs;
  const startTime = endTime - totalSeconds * 1000;

  return firstSuccess(
    BINANCE_HOSTS.map((host) => async () => {
      const chunkSeconds = 1000;
      const chunks: { start: number; end: number }[] = [];
      for (let s = startTime; s < endTime; s += chunkSeconds * 1000) {
        chunks.push({ start: s, end: Math.min(s + chunkSeconds * 1000, endTime) });
      }

      const results = await Promise.all(
        chunks.map((c) =>
          fetchJson<BinanceKline[]>(
            `${host}/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime=${c.start}&endTime=${c.end}&limit=1000`,
            { timeoutMs: 7000, retries: 0 }
          )
        )
      );

      const ticks = results
        .flat()
        .map((k) => ({ t: Number(k[0]), p: Number(k[4]) }))
        .filter((x) => Number.isFinite(x.p) && x.p > 0);

      if (ticks.length < 60) throw new Error(`binance returned ${ticks.length} klines`);

      const bars = fillBarGaps(ticksToBars(ticks));
      return {
        bars,
        source: 'binance' as const,
        interpolated: false,
        nativeSeconds: 1,
        fetchMs: Date.now() - started,
        endpoint: host,
      };
    })
  ).then((r) => r.value);
}

interface CoinbaseCandle extends Array<number> {}

/** Coinbase Exchange candles. Minimum granularity is 60s, so this is degraded. */
async function coinbaseHistory(minutes: number, nowMs: number): Promise<HistoryResult> {
  const started = Date.now();
  const granularity = 60;
  const end = new Date(nowMs).toISOString();
  const start = new Date(nowMs - minutes * 60_000).toISOString();
  const rows = await fetchJson<CoinbaseCandle[]>(
    `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}&start=${start}&end=${end}`,
    { timeoutMs: 7000, retries: 1 }
  );
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('coinbase returned no candles');

  // Coinbase rows are [time, low, high, open, close, volume], newest first.
  const coarse: Bar[] = rows
    .map((r) => ({
      t: bucketStart(Number(r[0]) * 1000),
      l: Number(r[1]),
      h: Number(r[2]),
      o: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[5]) || 0,
    }))
    .filter((b) => Number.isFinite(b.c) && b.c > 0)
    .sort((a, b) => a.t - b.t);

  return {
    bars: upsampleToTenSeconds(coarse, granularity),
    source: 'coinbase',
    interpolated: true,
    nativeSeconds: granularity,
    fetchMs: Date.now() - started,
    endpoint: 'api.exchange.coinbase.com',
  };
}

/** Kraken OHLC. Also 60s minimum — the last line of defence. */
async function krakenHistory(minutes: number, nowMs: number): Promise<HistoryResult> {
  const started = Date.now();
  const since = Math.floor((nowMs - minutes * 60_000) / 1000);
  const res = await fetchJson<{ error: string[]; result: Record<string, unknown> }>(
    `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=${since}`,
    { timeoutMs: 7000, retries: 1 }
  );
  if (res.error?.length) throw new Error(`kraken: ${res.error.join(',')}`);
  const key = Object.keys(res.result).find((k) => k !== 'last');
  const rows = (key ? res.result[key] : []) as unknown[][];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('kraken returned no candles');

  const coarse: Bar[] = rows
    .map((r) => ({
      t: bucketStart(Number(r[0]) * 1000),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
      v: Number(r[6]) || 0,
    }))
    .filter((b) => Number.isFinite(b.c) && b.c > 0)
    .sort((a, b) => a.t - b.t);

  return {
    bars: upsampleToTenSeconds(coarse, 60),
    source: 'kraken',
    interpolated: true,
    nativeSeconds: 60,
    fetchMs: Date.now() - started,
    endpoint: 'api.kraken.com',
  };
}

/** Ordered history fetch: true 10s resolution first, degraded sources after. */
export async function fetchHistory(
  minutes: number,
  preferred: PriceSourceName = 'binance',
  nowMs = Date.now()
): Promise<HistoryResult> {
  const all: Record<string, () => Promise<HistoryResult>> = {
    binance: () => binanceHistory(minutes, nowMs),
    coinbase: () => coinbaseHistory(minutes, nowMs),
    kraken: () => krakenHistory(minutes, nowMs),
  };
  const order = [preferred, 'binance', 'coinbase', 'kraken'].filter(
    (v, i, arr) => arr.indexOf(v) === i && v in all
  ) as PriceSourceName[];

  const { value } = await firstSuccess(order.map((name) => all[name]));
  return value;
}

// ── Spot ticks ──────────────────────────────────────────────────────────────

async function binanceTick(): Promise<PriceSnapshot> {
  const started = Date.now();
  const { value } = await firstSuccess(
    BINANCE_HOSTS.map((host) => async () => {
      const r = await fetchJson<{ price: string }>(
        `${host}/api/v3/ticker/price?symbol=BTCUSDT`,
        { timeoutMs: 3500, retries: 0 }
      );
      const price = Number(r.price);
      if (!Number.isFinite(price) || price <= 0) throw new Error('binance bad price');
      return price;
    })
  );
  return { price: value, t: Date.now(), source: 'binance', latencyMs: Date.now() - started };
}

async function coinbaseTick(): Promise<PriceSnapshot> {
  const started = Date.now();
  const r = await fetchJson<{ price: string }>(
    'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    { timeoutMs: 3500, retries: 1 }
  );
  const price = Number(r.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('coinbase bad price');
  return { price, t: Date.now(), source: 'coinbase', latencyMs: Date.now() - started };
}

async function krakenTick(): Promise<PriceSnapshot> {
  const started = Date.now();
  const r = await fetchJson<{ error: string[]; result: Record<string, { c: string[] }> }>(
    'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    { timeoutMs: 3500, retries: 1 }
  );
  const key = Object.keys(r.result ?? {})[0];
  const price = Number(r.result?.[key]?.c?.[0]);
  if (!Number.isFinite(price) || price <= 0) throw new Error('kraken bad price');
  return { price, t: Date.now(), source: 'kraken', latencyMs: Date.now() - started };
}

export async function fetchTick(
  preferred: PriceSourceName = 'binance'
): Promise<PriceSnapshot> {
  const all: Record<string, () => Promise<PriceSnapshot>> = {
    binance: binanceTick,
    coinbase: coinbaseTick,
    kraken: krakenTick,
  };
  const order = [preferred, 'binance', 'coinbase', 'kraken'].filter(
    (v, i, arr) => arr.indexOf(v) === i && v in all
  ) as PriceSourceName[];
  const { value } = await firstSuccess(order.map((n) => all[n]));
  return value;
}

// ── Chainlink reference feed ────────────────────────────────────────────────

const SELECTOR_LATEST_ROUND = '0xfeaf968c'; // latestRoundData()
const SELECTOR_DECIMALS = '0x313ce567'; // decimals()

/**
 * Read the Chainlink BTC/USD aggregator directly over JSON-RPC.
 *
 * Polymarket's crypto up/down markets settle against an oracle price, not
 * against a single exchange's tape, so the Chainlink answer is the number that
 * ultimately decides the bet. It updates on deviation/heartbeat rather than
 * continuously, which is why it is used as a *reference* — to detect basis
 * between the oracle and the exchange feed driving the simulation — and never
 * as the high-frequency path itself.
 *
 * Decoded by hand rather than via ethers so this stays dependency-free and can
 * run on the edge runtime.
 */
export async function fetchChainlink(
  rpcUrl: string,
  feed: string
): Promise<ChainlinkSnapshot> {
  const body = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: feed, data: SELECTOR_LATEST_ROUND }, 'latest'],
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'eth_call',
      params: [{ to: feed, data: SELECTOR_DECIMALS }, 'latest'],
    },
  ];

  const res = await fetchJson<{ id: number; result?: string; error?: { message: string } }[]>(
    rpcUrl,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 6000,
      retries: 1,
    }
  );

  const byId = new Map(res.map((r) => [r.id, r]));
  const round = byId.get(1);
  const dec = byId.get(2);
  if (round?.error) throw new Error(`chainlink latestRoundData: ${round.error.message}`);
  if (!round?.result || round.result === '0x') throw new Error('chainlink empty response');

  const hex = round.result.slice(2);
  if (hex.length < 64 * 5) throw new Error('chainlink short response');
  const word = (i: number) => hex.slice(i * 64, (i + 1) * 64);

  const roundId = BigInt('0x' + word(0));
  const answer = toSignedBigInt(word(1));
  const updatedAt = Number(BigInt('0x' + word(3))) * 1000;
  const decimals =
    dec?.result && dec.result !== '0x' ? Number(BigInt(dec.result)) : 8;

  const price = Number(answer) / 10 ** decimals;
  if (!Number.isFinite(price) || price <= 0) throw new Error('chainlink bad answer');

  return {
    price,
    roundId: roundId.toString(),
    updatedAt,
    ageMs: Date.now() - updatedAt,
    decimals,
    feed,
    chain: 'ethereum',
  };
}

/** Two's-complement decode of a 32-byte int256 word. */
function toSignedBigInt(word: string): bigint {
  const v = BigInt('0x' + word);
  const limit = 1n << 255n;
  return v >= limit ? v - (1n << 256n) : v;
}

export { BAR_SECONDS };
