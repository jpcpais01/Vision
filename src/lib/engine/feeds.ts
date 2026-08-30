import type { OrderBook, PricePoint, PriceSourceName } from '../types';
import { parseBook } from '../polymarket/clob';

/**
 * Browser-side market data feeds.
 *
 * Running these in the browser rather than through the serverless backend is a
 * deliberate latency decision: a direct exchange WebSocket delivers a trade in
 * tens of milliseconds, whereas a polled serverless proxy adds a cold start, a
 * region hop and a poll interval — easily a second, on a market that lasts 300.
 *
 * Both feeds degrade to authenticated server polling when the socket cannot be
 * established, and both report which path they are on so the dashboard can show
 * it and the risk layer can widen its staleness budget.
 */

export type FeedMode = 'websocket' | 'polling' | 'disconnected';

export interface FeedStatus {
  mode: FeedMode;
  source: string;
  lastMessageAt: number;
  reconnects: number;
  error: string | null;
}

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

// ── BTC price feed ──────────────────────────────────────────────────────────

interface PriceFeedOptions {
  source: PriceSourceName;
  onTick: (tick: PricePoint) => void;
  onStatus: (status: FeedStatus) => void;
  /** Header factory so the polling fallback carries the access token. */
  headers: () => Record<string, string>;
}

export class PriceFeed {
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private status: FeedStatus = {
    mode: 'disconnected',
    source: 'none',
    lastMessageAt: 0,
    reconnects: 0,
    error: null,
  };
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: PriceFeedOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
    // If no message arrives for 10s the socket is dead even if it never fired
    // an error — exchanges drop idle connections silently behind proxies.
    this.watchdog = setInterval(() => {
      if (this.stopped) return;
      const age = Date.now() - this.status.lastMessageAt;
      if (this.status.mode === 'websocket' && this.status.lastMessageAt > 0 && age > 10_000) {
        this.setStatus({ error: `no data for ${Math.round(age / 1000)}s` });
        this.reconnect();
      }
    }, 5000);
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.setStatus({ mode: 'disconnected', source: 'none' });
  }

  getStatus(): FeedStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<FeedStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus(this.getStatus());
  }

  private teardown(): void {
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
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.teardown();

    const url = socketUrl(this.opts.source);
    if (!url || typeof WebSocket === 'undefined') {
      this.startPolling();
      return;
    }

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.attempt = 0;
        const sub = subscribeMessage(this.opts.source);
        if (sub) ws.send(sub);
        this.setStatus({
          mode: 'websocket',
          source: this.opts.source,
          error: null,
          lastMessageAt: Date.now(),
        });
      };

      ws.onmessage = (event) => {
        const tick = parseTick(this.opts.source, event.data);
        if (!tick) return;
        this.status.lastMessageAt = tick.t;
        this.opts.onTick(tick);
      };

      ws.onerror = () => {
        this.setStatus({ error: 'websocket error' });
      };

      ws.onclose = () => {
        if (this.stopped) return;
        this.reconnect();
      };
    } catch (err) {
      this.setStatus({ error: err instanceof Error ? err.message : 'socket failed' });
      this.startPolling();
    }
  }

  private reconnect(): void {
    if (this.stopped) return;
    this.teardown();
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.setStatus({ reconnects: this.status.reconnects + 1 });

    // After a few failed sockets, stop fighting the network and poll instead.
    if (this.attempt >= 3) {
      this.startPolling();
      // Keep trying the socket in the background — polling is the fallback,
      // not the destination.
      this.reconnectTimer = setTimeout(() => {
        this.attempt = 0;
        this.connect();
      }, 60_000);
      return;
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPolling(): void {
    if (this.stopped || this.pollTimer) return;
    this.setStatus({ mode: 'polling', source: `${this.opts.source} (server)` });

    const poll = async () => {
      try {
        const res = await fetch(`/api/price/tick?source=${this.opts.source}`, {
          headers: this.opts.headers(),
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`tick ${res.status}`);
        const data = (await res.json()) as { price: number; t: number };
        if (Number.isFinite(data.price) && data.price > 0) {
          this.status.lastMessageAt = Date.now();
          this.setStatus({ error: null });
          this.opts.onTick({ t: Date.now(), p: data.price });
        }
      } catch (err) {
        this.setStatus({ error: err instanceof Error ? err.message : 'poll failed' });
      }
    };

    void poll();
    this.pollTimer = setInterval(poll, 1000);
  }
}

function socketUrl(source: PriceSourceName): string | null {
  switch (source) {
    case 'binance':
      return 'wss://stream.binance.com:9443/ws/btcusdt@trade';
    case 'coinbase':
      return 'wss://ws-feed.exchange.coinbase.com';
    case 'kraken':
      return 'wss://ws.kraken.com';
    default:
      return null;
  }
}

function subscribeMessage(source: PriceSourceName): string | null {
  if (source === 'coinbase') {
    return JSON.stringify({
      type: 'subscribe',
      product_ids: ['BTC-USD'],
      channels: ['ticker'],
    });
  }
  if (source === 'kraken') {
    return JSON.stringify({
      event: 'subscribe',
      pair: ['XBT/USD'],
      subscription: { name: 'trade' },
    });
  }
  return null; // Binance encodes the subscription in the URL.
}

function parseTick(source: PriceSourceName, raw: unknown): PricePoint | null {
  if (typeof raw !== 'string') return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (source === 'binance') {
    const m = msg as { p?: string; T?: number; e?: string };
    if (m.e !== 'trade' || !m.p) return null;
    const p = Number(m.p);
    if (!Number.isFinite(p) || p <= 0) return null;
    return { t: m.T ?? Date.now(), p };
  }

  if (source === 'coinbase') {
    const m = msg as { type?: string; price?: string; time?: string };
    if (m.type !== 'ticker' || !m.price) return null;
    const p = Number(m.price);
    if (!Number.isFinite(p) || p <= 0) return null;
    const t = m.time ? Date.parse(m.time) : Date.now();
    return { t: Number.isFinite(t) ? t : Date.now(), p };
  }

  if (source === 'kraken') {
    // Trade payloads arrive as [channelID, [[price, volume, time, ...]], ...].
    if (!Array.isArray(msg)) return null;
    const trades = msg[1];
    if (!Array.isArray(trades) || trades.length === 0) return null;
    const last = trades[trades.length - 1];
    if (!Array.isArray(last)) return null;
    const p = Number(last[0]);
    const t = Number(last[2]) * 1000;
    if (!Number.isFinite(p) || p <= 0) return null;
    return { t: Number.isFinite(t) ? t : Date.now(), p };
  }

  return null;
}

// ── Polymarket order-book feed ──────────────────────────────────────────────

interface BookFeedOptions {
  onBook: (book: OrderBook) => void;
  onStatus: (status: FeedStatus) => void;
  headers: () => Record<string, string>;
}

const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/**
 * Subscribes to the CLOB's public market channel for a set of token ids.
 *
 * The channel sends a full `book` snapshot on subscribe and `price_change`
 * deltas thereafter. Deltas are applied locally, but a REST reconciliation runs
 * on a slow timer regardless: a dropped delta would otherwise leave the book
 * quietly wrong, and a quietly wrong book is worse than no book at all when it
 * is what you are pricing an edge against.
 */
export class BookFeed {
  private ws: WebSocket | null = null;
  private tokenIds: string[] = [];
  private books = new Map<string, OrderBook>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private status: FeedStatus = {
    mode: 'disconnected',
    source: 'polymarket-clob',
    lastMessageAt: 0,
    reconnects: 0,
    error: null,
  };

  constructor(private opts: BookFeedOptions) {}

  /** Point the feed at a new market. Safe to call on every window rollover. */
  setTokens(tokenIds: string[]): void {
    const same =
      tokenIds.length === this.tokenIds.length &&
      tokenIds.every((id, i) => id === this.tokenIds[i]);
    if (same) return;
    this.tokenIds = [...tokenIds];
    this.books.clear();
    if (!this.stopped) this.connect();
  }

  start(): void {
    this.stopped = false;
    if (this.tokenIds.length > 0) this.connect();
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => void this.reconcile(), 4000);
    }
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.status = { ...this.status, mode: 'disconnected' };
    this.opts.onStatus(this.getStatus());
  }

  getStatus(): FeedStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<FeedStatus>): void {
    this.status = { ...this.status, ...patch };
    this.opts.onStatus(this.getStatus());
  }

  private teardown(): void {
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private connect(): void {
    if (this.stopped || this.tokenIds.length === 0) return;
    this.teardown();

    if (typeof WebSocket === 'undefined') {
      this.startPolling();
      return;
    }

    try {
      const ws = new WebSocket(CLOB_WS);
      this.ws = ws;

      ws.onopen = () => {
        this.attempt = 0;
        ws.send(JSON.stringify({ assets_ids: this.tokenIds, type: 'market' }));
        this.setStatus({ mode: 'websocket', error: null, lastMessageAt: Date.now() });
        this.stopPolling();
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      ws.onerror = () => this.setStatus({ error: 'clob websocket error' });

      ws.onclose = () => {
        if (this.stopped) return;
        this.reconnect();
      };
    } catch (err) {
      this.setStatus({ error: err instanceof Error ? err.message : 'clob socket failed' });
      this.startPolling();
    }
  }

  private reconnect(): void {
    if (this.stopped) return;
    this.teardown();
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.setStatus({ reconnects: this.status.reconnects + 1 });
    if (this.attempt >= 3) {
      this.startPolling();
      this.reconnectTimer = setTimeout(() => {
        this.attempt = 0;
        this.connect();
      }, 60_000);
      return;
    }
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    if (raw === 'PONG' || raw.trim() === '') return;

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }

    const events = Array.isArray(payload) ? payload : [payload];
    this.status.lastMessageAt = Date.now();

    for (const evt of events) {
      const e = evt as {
        event_type?: string;
        asset_id?: string;
        bids?: { price: string; size: string }[];
        asks?: { price: string; size: string }[];
        changes?: { price: string; side: string; size: string }[];
        hash?: string;
      };
      if (!e.asset_id || !this.tokenIds.includes(e.asset_id)) continue;

      if (e.event_type === 'book') {
        const book = parseBook(e as never, e.asset_id);
        this.books.set(book.tokenId, book);
        this.opts.onBook(book);
      } else if (e.event_type === 'price_change' && Array.isArray(e.changes)) {
        const existing = this.books.get(e.asset_id);
        if (!existing) continue;
        const updated = applyChanges(existing, e.changes);
        this.books.set(updated.tokenId, updated);
        this.opts.onBook(updated);
      }
    }
    this.setStatus({ error: null });
  }

  private startPolling(): void {
    if (this.stopped || this.pollTimer || this.tokenIds.length === 0) return;
    this.setStatus({ mode: 'polling' });
    const poll = () => void this.reconcile();
    void poll();
    this.pollTimer = setInterval(poll, 1200);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Authoritative REST snapshot; also the polling fallback's only mechanism. */
  private async reconcile(): Promise<void> {
    if (this.stopped || this.tokenIds.length === 0) return;
    try {
      const res = await fetch(`/api/book?tokenIds=${this.tokenIds.join(',')}`, {
        headers: this.opts.headers(),
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`book ${res.status}`);
      const data = (await res.json()) as { books: Record<string, OrderBook> };
      for (const book of Object.values(data.books ?? {})) {
        if (!book?.tokenId) continue;
        this.books.set(book.tokenId, book);
        this.opts.onBook(book);
      }
      if (this.status.mode === 'polling') {
        this.status.lastMessageAt = Date.now();
        this.setStatus({ error: null });
      }
    } catch (err) {
      this.setStatus({ error: err instanceof Error ? err.message : 'book poll failed' });
    }
  }
}

/** Apply CLOB `price_change` deltas to a local book snapshot. */
function applyChanges(
  book: OrderBook,
  changes: { price: string; side: string; size: string }[]
): OrderBook {
  const bids = new Map(book.bids.map((l) => [l.price, l.size]));
  const asks = new Map(book.asks.map((l) => [l.price, l.size]));

  for (const change of changes) {
    const price = Number(change.price);
    const size = Number(change.size);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    const target = change.side?.toUpperCase() === 'BUY' ? bids : asks;
    // A size of zero means the level was consumed or pulled.
    if (size <= 0) target.delete(price);
    else target.set(price, size);
  }

  return {
    ...book,
    bids: Array.from(bids, ([price, size]) => ({ price, size })).sort((a, b) => b.price - a.price),
    asks: Array.from(asks, ([price, size]) => ({ price, size })).sort((a, b) => a.price - b.price),
    t: Date.now(),
  };
}
