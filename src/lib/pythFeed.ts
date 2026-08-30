import type { Tick } from './types';
import { BTC_USD_ID } from './pyth';

/**
 * ── Pyth Network — live stream ───────────────────────────────────────────────
 *
 * Hermes, Pyth's public price service, streams updates over Server-Sent
 * Events with no key and no auth — it is built specifically for a browser
 * (or any client) to subscribe to directly. This is the primary source for
 * the live price: sub-second latency, from a real aggregate of many
 * exchanges and market makers, not one exchange's tape.
 *
 * Confirmed against Pyth's own `pyth-crosschain` source on GitHub
 * (apps/hermes/server/src/api/rest/v2/sse.rs): the endpoint and the event
 * shape (the same `PriceUpdate` JSON as the REST `latest` endpoint, see
 * `pyth.ts`) are taken directly from it. The connection carries a 24h server-
 * side timeout, so a full reconnect cycle here is expected behaviour, not a
 * failure.
 */

const STREAM_URL = 'https://hermes.pyth.network/v2/updates/price/stream';
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];

interface HermesEvent {
  parsed?: { price?: { price?: string; expo?: number; publish_time?: number } }[];
}

export interface PythFeedOptions {
  onTick: (tick: Tick) => void;
  onStatus: (connected: boolean) => void;
}

export class PythFeed {
  private es: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private running = false;
  private connected = false;
  private lastTick: Tick | null = null;

  constructor(private opts: PythFeedOptions) {}

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.teardown();
    this.setConnected(false);
  }

  /** Most recent tick, or null if none has arrived yet (or it's gone stale). */
  latest(maxAgeMs = 5000): Tick | null {
    if (!this.lastTick) return null;
    return Date.now() - this.lastTick.t < maxAgeMs ? this.lastTick : null;
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    this.opts.onStatus(v);
  }

  private teardown(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.es) {
      this.es.onopen = null;
      this.es.onmessage = null;
      this.es.onerror = null;
      this.es.close();
      this.es = null;
    }
  }

  private connect(): void {
    if (!this.running || typeof EventSource === 'undefined') return;
    this.teardown();

    try {
      const es = new EventSource(`${STREAM_URL}?ids[]=${BTC_USD_ID}&parsed=true`);
      this.es = es;

      es.onopen = () => {
        this.attempt = 0;
        this.setConnected(true);
      };

      es.onmessage = (event) => {
        let parsed: HermesEvent;
        try {
          parsed = JSON.parse(event.data) as HermesEvent;
        } catch {
          return; // a stray non-JSON frame — not fatal
        }
        const p = parsed.parsed?.[0]?.price;
        if (!p || typeof p.price !== 'string' || typeof p.expo !== 'number') return;
        const value = Number(p.price) * 10 ** p.expo;
        if (!Number.isFinite(value) || value <= 0) return;

        const tick: Tick = {
          t: typeof p.publish_time === 'number' ? p.publish_time * 1000 : Date.now(),
          p: value,
        };
        this.lastTick = tick;
        this.opts.onTick(tick);
      };

      es.onerror = () => {
        this.setConnected(false);
        es.close();
        if (this.running) this.reconnect();
      };
    } catch {
      this.setConnected(false);
      if (this.running) this.reconnect();
    }
  }

  private reconnect(): void {
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
