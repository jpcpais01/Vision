import 'server-only';
import type { Bar, Tick } from './types';
import { fetchJson } from './http';
import { fillGaps, toBars } from './bars';

/**
 * ── Price data — Binance ─────────────────────────────────────────────────────
 *
 * Polymarket settles these markets on Chainlink Data Streams, which needs
 * commercial credentials, and the free on-chain Chainlink feed updates far too
 * slowly (a 0.5% deviation or an hourly heartbeat) to trade from. Binance gives
 * genuine per-second resolution for free, with no key, which is what a 10-second
 * bar series actually needs.
 *
 * It is one exchange's tape rather than an oracle aggregate, so at the open of
 * each window the engine reads the free on-chain Chainlink price once and
 * offsets every Binance-derived number by the difference — see
 * `Engine.computeOffset` in `engine.ts`. That keeps the level anchored to the
 * settlement oracle while all the second-to-second movement still comes from
 * Binance's real tape.
 */

// Binance publishes the same API on several hosts; a regional block tends to
// hit them one at a time, so the list is walked rather than given up on.
const HOSTS = [
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://data-api.binance.vision',
];

async function firstSuccess<T>(factories: (() => Promise<T>)[]): Promise<T> {
  const errors: unknown[] = [];
  for (const f of factories) {
    try {
      return await f();
    } catch (err) {
      errors.push(err);
    }
  }
  const detail = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
  throw new Error(`all hosts failed: ${detail}`);
}

/** The current BTC/USD price. */
export async function latest(): Promise<Tick> {
  return firstSuccess(
    HOSTS.map((host) => async () => {
      const r = await fetchJson<{ price: string }>(
        `${host}/api/v3/ticker/price?symbol=BTCUSDT`,
        { timeoutMs: 3500, retries: 0 }
      );
      const p = Number(r.price);
      if (!Number.isFinite(p) || p <= 0) throw new Error('bad price');
      return { t: Date.now(), p };
    })
  );
}

type Kline = [number, string, string, string, string, ...unknown[]];

/**
 * `minutes` of real 1-second klines, folded into 10-second bars.
 * Binance caps a request at 1000 rows, so anything over ~16 minutes needs
 * several calls; they run in parallel since this sits on the critical path
 * at startup.
 */
export async function history(minutes: number, now = Date.now()): Promise<Bar[]> {
  const end = now;
  const start = end - minutes * 60_000;
  const chunkMs = 1000 * 1000; // 1000 one-second candles per request

  return firstSuccess(
    HOSTS.map((host) => async () => {
      const chunks: { from: number; to: number }[] = [];
      for (let s = start; s < end; s += chunkMs) {
        chunks.push({ from: s, to: Math.min(s + chunkMs, end) });
      }

      const rows = await Promise.all(
        chunks.map((c) =>
          fetchJson<Kline[]>(
            `${host}/api/v3/klines?symbol=BTCUSDT&interval=1s&startTime=${c.from}&endTime=${c.to}&limit=1000`,
            { timeoutMs: 7000, retries: 0 }
          )
        )
      );

      const ticks: Tick[] = rows
        .flat()
        .map((k) => ({ t: Number(k[0]), p: Number(k[4]) }))
        .filter((t) => Number.isFinite(t.p) && t.p > 0);

      if (ticks.length < 60) throw new Error(`only ${ticks.length} candles returned`);
      return fillGaps(toBars(ticks));
    })
  );
}
