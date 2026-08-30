import type { Tick } from './types';

/**
 * ── Polymarket's own live Chainlink relay ───────────────────────────────────
 *
 * These markets settle on Chainlink's BTC/USD Data Stream, which is not
 * available for free on its own — but Polymarket runs a public Real-Time Data
 * Service that relays it, with no key and no auth, specifically so people can
 * see the same price the markets resolve against. This connects to it
 * directly from the browser, the same way the rest of this engine talks to
 * live feeds: a server round trip would just add latency to a value that is
 * only useful if it is current.
 *
 * This is the engine's sole live price source — every number anywhere in the
 * app (the barrier, the running display, the volatility estimate, the
 * close) comes from this feed, with the on-chain Chainlink aggregator
 * (`chainlink.ts`) as its only fallback. No other exchange's data is ever
 * blended in.
 *
 * Confirmed against Polymarket's own `real-time-data-client` source
 * (github.com/Polymarket/real-time-data-client): the endpoint, the
 * subscription envelope, and the update message shape below are taken
 * directly from it.
 */

const URL = 'wss://ws-live-data.polymarket.com';
const SYMBOL = 'BTCUSDT';
const PING_MS = 5000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];

interface RtdsMessage {
  topic?: string;
  type?: string;
  payload?: {
    symbol?: string;
    timestamp?: number;
    value?: number;
    // The server sends one of these right after a filtered subscription is
    // acknowledged — a short historical burst rather than a single point.
    data?: { timestamp?: number; value?: number }[];
  };
}

export interface ChainlinkFeedOptions {
  onTick: (tick: Tick) => void;
  onStatus: (connected: boolean) => void;
  /**
   * Fires a handful of times (never spammed) when something worth seeing
   * happens that isn't a clean tick: the socket opened but nothing valid
   * arrived within a while, or a message came in that didn't match the
   * expected shape. This is the only way to actually diagnose a silently
   * wrong topic/filter/shape from a deployment this sandbox can't reach.
   */
  onDebug?: (msg: string) => void;
}

const SILENT_WARNING_MS = 8000;
const MAX_DEBUG_LOGS = 5;

export class ChainlinkFeed {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private silentTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private running = false;
  private connected = false;
  private lastTick: Tick | null = null;
  /** True once a single well-formed price update has ever arrived. */
  private everConnected = false;
  private debugLogsLeft = MAX_DEBUG_LOGS;

  constructor(private opts: ChainlinkFeedOptions) {}

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

  hasEverConnected(): boolean {
    return this.everConnected;
  }

  private emitTick(tick: Tick): void {
    if (this.silentTimer) {
      clearTimeout(this.silentTimer);
      this.silentTimer = null;
    }
    this.lastTick = tick;
    this.everConnected = true;
    this.opts.onTick(tick);
  }

  private debug(msg: string): void {
    if (this.debugLogsLeft <= 0) return;
    this.debugLogsLeft--;
    this.opts.onDebug?.(msg);
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    this.opts.onStatus(v);
  }

  private teardown(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.silentTimer) clearTimeout(this.silentTimer);
    this.silentTimer = null;
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (!this.running || typeof WebSocket === 'undefined') return;
    this.teardown();

    try {
      const ws = new WebSocket(URL);
      this.ws = ws;

      ws.onopen = () => {
        this.attempt = 0;
        this.setConnected(true);
        ws.send(
          JSON.stringify({
            action: 'subscribe',
            subscriptions: [
              { topic: 'crypto_prices_chainlink', type: 'update', filters: `{"symbol":"${SYMBOL}"}` },
            ],
          })
        );
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, PING_MS);

        // The socket opening only proves the handshake worked, not that the
        // subscription was understood — if nothing valid arrives shortly
        // after, that's the "silently wrong topic/filter" failure mode.
        this.silentTimer = setTimeout(() => {
          this.debug(
            this.lastTick
              ? `No new tick in ${SILENT_WARNING_MS / 1000}s — connected, but the relay has gone quiet`
              : `Connected ${SILENT_WARNING_MS / 1000}s ago with zero ticks received — the subscription may not be matching anything`
          );
        }, SILENT_WARNING_MS);
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') {
          this.debug(`Non-text frame received (${typeof event.data})`);
          return;
        }
        if (event.data === 'pong') return;
        let parsed: RtdsMessage;
        try {
          parsed = JSON.parse(event.data) as RtdsMessage;
        } catch {
          this.debug(`Non-JSON text frame: ${event.data.slice(0, 200)}`);
          return;
        }
        const p = parsed.payload;
        if (!p) {
          this.debug(`Message with no payload: ${event.data.slice(0, 300)}`);
          return;
        }
        if (p.symbol && p.symbol !== SYMBOL) {
          this.debug(`Payload for a different symbol ("${p.symbol}"), expected "${SYMBOL}"`);
          return;
        }

        if (Array.isArray(p.data)) {
          // The initial snapshot after subscribing — ingest every point so
          // there is real history on the tape immediately, not just a single
          // number, in the same order the server sent it.
          for (const point of p.data) {
            if (typeof point.value !== 'number' || !(point.value > 0)) continue;
            this.emitTick({ t: typeof point.timestamp === 'number' ? point.timestamp : Date.now(), p: point.value });
          }
          return;
        }

        if (typeof p.value !== 'number' || !(p.value > 0)) {
          this.debug(`Payload with no usable "value": ${event.data.slice(0, 300)}`);
          return;
        }
        this.emitTick({ t: typeof p.timestamp === 'number' ? p.timestamp : Date.now(), p: p.value });
      };

      ws.onerror = () => {
        /* onclose follows every onerror on a browser WebSocket; handle there */
      };

      ws.onclose = () => {
        this.setConnected(false);
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
