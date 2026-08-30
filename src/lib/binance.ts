import 'server-only';
import type { Tick } from './types';
import { fetchJson } from './http';

/**
 * ── Live price — Binance ─────────────────────────────────────────────────────
 *
 * The second-by-second tape. Polymarket settles on Chainlink Data Streams,
 * which needs commercial credentials, and the free on-chain Chainlink feed
 * updates far too slowly (a 0.5% deviation or an hourly heartbeat) to build a
 * volatility estimate from. Binance gives genuine per-second data for free,
 * with no key.
 *
 * There is deliberately no history fetch here. The engine does not seed a
 * lookback window from anywhere — it accumulates its own rolling 30 minutes of
 * real ticks from the moment it starts, and waits out a calibration period
 * before trading its first window. See `CALIBRATION_MIN_SEC` in config.ts and
 * `Engine.start` in engine.ts.
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
