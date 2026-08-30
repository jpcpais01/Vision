import WebSocket from 'ws';
import { handler, ok } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A one-shot diagnostic, not part of the trading engine's own path.
 *
 * Round 1 tested whether the server gates on the WebSocket handshake's
 * `Origin` header — it doesn't: both a spoofed `https://polymarket.com`
 * origin and no override at all connected, subscribed, and then received
 * zero messages. Origin is not the variable.
 *
 * Round 2: is it specifically the `crypto_prices_chainlink` topic that's
 * gated — Polymarket's own exact settlement source, plausibly held back
 * from public broadcast even though the plainer `crypto_prices` topic
 * (documented right alongside it) might be open. Subscribes to both, side
 * by side, to find out whether the WebSocket mechanism works at all here.
 */

const URL = 'wss://ws-live-data.polymarket.com';
const TIMEOUT_MS = 7000;

interface Attempt {
  label: string;
  opened: boolean;
  messages: string[];
  error: string | null;
  closedCode: number | null;
  closedReason: string | null;
}

function tryConnect(label: string, topic: string): Promise<Attempt> {
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
    const ws = new WebSocket(URL);

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
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          subscriptions: [{ topic, type: 'update', filters: '{"symbol":"BTCUSDT"}' }],
        })
      );
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
  const [chainlink, plain] = await Promise.all([
    tryConnect('topic: crypto_prices_chainlink', 'crypto_prices_chainlink'),
    tryConnect('topic: crypto_prices (plain)', 'crypto_prices'),
  ]);
  return ok({ chainlink, plain });
});
