import 'server-only';
import { fetchJson } from './http';

/**
 * ── Chainlink cross-check ────────────────────────────────────────────────────
 *
 * The free on-chain Chainlink BTC/USD aggregator. This is NOT the Data Stream
 * Polymarket actually settles on — that needs commercial credentials — and it
 * updates far too slowly to drive a decision on its own (a 0.5% deviation or an
 * hourly heartbeat). But it is a genuine oracle read, so it is used once per
 * window: at the open, to anchor the Binance-derived price to it (see
 * `Engine.computeOffset` in `engine.ts`), and continuously in the background,
 * to show the live gap between the two so a divergence is visible rather than
 * silent.
 */

const LATEST_ROUND = '0xfeaf968c';

export interface ChainlinkRead {
  price: number;
  updatedAt: number;
  ageMs: number;
}

export async function chainlink(rpcUrl: string, feed: string): Promise<ChainlinkRead> {
  const res = await fetchJson<{ result?: string; error?: { message: string } }>(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to: feed, data: LATEST_ROUND }, 'latest'],
    }),
    timeoutMs: 6000,
    retries: 1,
  });

  if (res.error) throw new Error(`chainlink: ${res.error.message}`);
  const hex = (res.result ?? '').slice(2);
  if (hex.length < 64 * 5) throw new Error('chainlink: short response');

  const word = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const raw = BigInt('0x' + word(1));
  const signed = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
  const price = Number(signed) / 1e8; // the BTC/USD aggregator uses 8 decimals
  const updatedAt = Number(BigInt('0x' + word(3))) * 1000;

  if (!Number.isFinite(price) || price <= 0) throw new Error('chainlink: bad answer');
  return { price, updatedAt, ageMs: Date.now() - updatedAt };
}
