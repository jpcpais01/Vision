import { RealTimeDataClient } from '@polymarket/real-time-data-client';
import { handler, ok } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A one-shot diagnostic, not part of the trading engine's own path.
 *
 * Rounds 1-4 ruled out the Origin header, topic choice, binary-frame
 * decoding, and any transcription mismatch against Polymarket's own
 * client — all connect and subscribe cleanly, then receive zero frames.
 *
 * Round 5: Polymarket's own official Rust SDK had a confirmed, since-fixed
 * bug (Polymarket/rs-clob-client#136) where the Chainlink topic silently
 * receives nothing unless `filters` uses Chainlink's own pair notation
 * ("btc/usd", lowercase, slash-separated) rather than the exchange-style
 * "BTCUSDT" used elsewhere. This also lines up with Polymarket's Aug 7
 * 2026 move to Chainlink TWAP settlement, which plausibly reworked the
 * Chainlink-sourced topic's symbol format along with it. Testing all three
 * candidate formats side by side against the one topic that matters.
 */

const TIMEOUT_MS = 15000;

interface Result {
  label: string;
  connected: boolean;
  messages: unknown[];
}

function run(label: string, filters: string): Promise<Result> {
  return new Promise((resolve) => {
    const result: Result = { label, connected: false, messages: [] };
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
        c.subscribe({ subscriptions: [{ topic: 'crypto_prices_chainlink', type: 'update', filters }] });
      },
      onMessage: (_c, message) => {
        result.messages.push(message);
        if (result.messages.length >= 3) finish();
      },
      autoReconnect: false,
    });
    client.connect();
  });
}

export const GET = handler(async () => {
  const [lowerSlash, upperSlash, exchangeStyle] = await Promise.all([
    run('btc/usd (lowercase, slash)', '{"symbol":"btc/usd"}'),
    run('BTC/USD (uppercase, slash)', '{"symbol":"BTC/USD"}'),
    run('BTCUSDT (exchange style, as before)', '{"symbol":"BTCUSDT"}'),
  ]);
  return ok({ lowerSlash, upperSlash, exchangeStyle });
});
