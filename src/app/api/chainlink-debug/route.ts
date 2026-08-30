import { RealTimeDataClient } from '@polymarket/real-time-data-client';
import { handler, ok } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A one-shot diagnostic, not part of the trading engine's own path.
 *
 * Rounds 1-3 (Origin header, topic choice, binary-frame decoding) all ruled
 * out our own hand-rolled reimplementation as the problem — connects,
 * subscribes cleanly, then zero frames for 20s either way. This round
 * removes every last chance of a transcription mismatch by running
 * Polymarket's own unmodified `@polymarket/real-time-data-client` package,
 * calling it exactly the way their README does. If this also gets nothing,
 * the problem is not in anything we wrote.
 */

const TIMEOUT_MS = 20000;

interface Result {
  connected: boolean;
  messages: unknown[];
  disconnectedEvents: number;
}

function run(): Promise<Result> {
  return new Promise((resolve) => {
    const result: Result = { connected: false, messages: [], disconnectedEvents: 0 };
    let done = false;
    let client: RealTimeDataClient;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        client.disconnect();
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const timer = setTimeout(finish, TIMEOUT_MS);

    client = new RealTimeDataClient({
      onConnect: (c) => {
        result.connected = true;
        c.subscribe({
          subscriptions: [{ topic: 'crypto_prices_chainlink', type: 'update', filters: '{"symbol":"BTCUSDT"}' }],
        });
      },
      onMessage: (_c, message) => {
        result.messages.push(message);
        if (result.messages.length >= 5) finish();
      },
      onStatusChange: (status) => {
        if (String(status) === 'DISCONNECTED') result.disconnectedEvents++;
      },
      autoReconnect: false,
    });
    client.connect();
  });
}

export const GET = handler(async () => {
  const result = await run();
  return ok(result);
});
