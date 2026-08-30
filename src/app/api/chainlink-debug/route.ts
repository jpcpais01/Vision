import WebSocket, { RawData } from 'ws';
import { handler, ok } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A one-shot diagnostic, not part of the trading engine's own path.
 *
 * Round 1 ruled out the WebSocket handshake's `Origin` header as a gate.
 * Round 2 ruled out topic choice (`crypto_prices_chainlink` vs the plainer
 * `crypto_prices`) — both subscribe cleanly and both then receive zero
 * messages within 7s.
 *
 * Round 3: is "zero messages" actually true, or is it "zero *text* frames"?
 * The `ws` package's `message` event carries an `isBinary` flag, and the
 * official Polymarket client only ever checks `typeof data === "string"` —
 * if the server ever answers with a binary frame (compression negotiation,
 * a different content-type on this route, anything), both our code and
 * their own reference client would silently treat it as nothing. This
 * captures frame type and raw bytes directly, and waits longer in case the
 * first tick is just slow to arrive rather than never arriving.
 */

const URL = 'wss://ws-live-data.polymarket.com';
const TIMEOUT_MS = 20000;

interface Frame {
  atMs: number;
  isBinary: boolean;
  byteLength: number;
  hex: string;
  text: string;
}

interface Attempt {
  label: string;
  opened: boolean;
  frames: Frame[];
  error: string | null;
  closedCode: number | null;
  closedReason: string | null;
}

function tryConnect(label: string, topic: string): Promise<Attempt> {
  return new Promise((resolve) => {
    const start = Date.now();
    const result: Attempt = {
      label,
      opened: false,
      frames: [],
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
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      result.frames.push({
        atMs: Date.now() - start,
        isBinary,
        byteLength: buf.length,
        hex: buf.subarray(0, 64).toString('hex'),
        text: buf.subarray(0, 200).toString('utf8'),
      });
      if (result.frames.length >= 5) finish();
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
