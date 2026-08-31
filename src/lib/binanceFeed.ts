import type { Tick } from './types';

/**
 * ── Binance — live trade stream ──────────────────────────────────────────────
 *
 * Binance's public WebSocket, free and no key, streaming every executed
 * trade on BTCUSDT in real time — genuinely continuous, sub-second updates.
 * This is the strategy's own reference tape: unlike the old design, there is
 * no external settlement price to chase or reconstruct — Binance's live
 * price *is* the thing the simulation and every trade are measured against.
 *
 * Confirmed against Binance's own `binance-spot-api-docs` source on GitHub
 * (web-socket-streams.md): the base URL, the `<symbol>@trade` stream name,
 * and the trade event shape (`p` = price, `T` = trade time in ms) below are
 * taken directly from it.
 */

const URL = 'wss://stream.binance.com:9443/ws/btcusdt@trade';
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];

interface TradeEvent {
  e?: string;
  p?: string;
  T?: number;
}

export interface BinanceFeedOptions {
  onTick: (tick: Tick) => void;
  onStatus: (connected: boolean) => void;
}

export class BinanceFeed {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private running = false;
  private connected = false;
  private lastTick: Tick | null = null;

  constructor(private opts: BinanceFeedOptions) {}

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
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        let parsed: TradeEvent;
        try {
          parsed = JSON.parse(event.data) as TradeEvent;
        } catch {
          return;
        }
        if (parsed.e !== 'trade' || typeof parsed.p !== 'string') return;
        const price = Number(parsed.p);
        if (!Number.isFinite(price) || price <= 0) return;

        const tick: Tick = { t: typeof parsed.T === 'number' ? parsed.T : Date.now(), p: price };
        this.lastTick = tick;
        this.opts.onTick(tick);
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
