import WebSocket from 'ws';
import { handler, ok } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A one-shot diagnostic, not part of the trading engine's own path. The
 * browser client (`chainlinkFeed.ts`) connects, sends a subscribe message
 * that matches Polymarket's own documented protocol exactly, and gets
 * total silence back — no error, no data. The leading hypothesis is that
 * the server checks the WebSocket handshake's `Origin` header and only
 * actually activates the subscription for `https://polymarket.com` itself;
 * a browser can never override that header, but a server-side connection
 * can set anything. This tries both, side by side, to find out.
 */

const URL = 'wss://ws-live-data.polymarket.com';
const SUBSCRIBE = JSON.stringify({
  action: 'subscribe',
  subscriptions: [{ topic: 'crypto_prices_chainlink', type: 'update', filters: '{"symbol":"BTCUSDT"}' }],
});
const TIMEOUT_MS = 7000;

interface Attempt {
  label: string;
  opened: boolean;
  messages: string[];
  error: string | null;
  closedCode: number | null;
  closedReason: string | null;
}

function tryConnect(label: string, headers?: Record<string, string>): Promise<Attempt> {
  return new Promise((resolve) => {
    const result: Attempt = {
      label,
      opened: false,
      messages: [],
      error: null,
      closedCode: null,
      closedReason: null,
    };
    let done = false;
    const ws = new WebSocket(URL, headers ? { headers } : undefined);

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve(result);
    };
    const timer = setTimeout(finish, TIMEOUT_MS);

    ws.on('open', () => {
      result.opened = true;
      ws.send(SUBSCRIBE);
    });
    ws.on('message', (data) => {
      result.messages.push(String(data).slice(0, 200));
      if (result.messages.length >= 3) finish();
    });
    ws.on('error', (err) => {
      result.error = err instanceof Error ? err.message : String(err);
    });
    ws.on('close', (code, reason) => {
      result.closedCode = code;
      result.closedReason = reason.toString().slice(0, 200) || null;
      finish();
    });
  });
}

export const GET = handler(async () => {
  const [withOrigin, withoutOrigin] = await Promise.all([
    tryConnect('server-side, Origin: https://polymarket.com', { Origin: 'https://polymarket.com' }),
    tryConnect('server-side, no Origin override'),
  ]);
  return ok({ withOrigin, withoutOrigin });
});
