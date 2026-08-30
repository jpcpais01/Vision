// Server-only environment access. Importing this from a client component is a
// build error by design — every secret in the system is read through here.
import 'server-only';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

export const env = {
  // Access control
  accessToken: () => str('VISION_ACCESS_TOKEN'),

  // Polymarket
  clobUrl: () => str('POLYMARKET_CLOB_URL', 'https://clob.polymarket.com').replace(/\/+$/, ''),
  gammaUrl: () => str('POLYMARKET_GAMMA_URL', 'https://gamma-api.polymarket.com').replace(/\/+$/, ''),
  chainId: () => num('POLYMARKET_CHAIN_ID', 137),
  privateKey: () => str('POLYMARKET_PRIVATE_KEY'),
  funderAddress: () => str('POLYMARKET_FUNDER_ADDRESS'),
  signatureType: () => num('POLYMARKET_SIGNATURE_TYPE', 0),
  apiKey: () => str('POLYMARKET_API_KEY'),
  apiSecret: () => str('POLYMARKET_API_SECRET'),
  apiPassphrase: () => str('POLYMARKET_API_PASSPHRASE'),
  allowLive: () => bool('ALLOW_LIVE_TRADING', false),

  // Chainlink — the free on-chain aggregator, used as a fallback anchor behind
  // Polymarket's own live relay (see chainlinkFeed.ts).
  chainlinkRpc: () => str('CHAINLINK_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
  chainlinkFeed: () =>
    str('CHAINLINK_BTC_USD_FEED', '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c'),

  // Storage
  upstashUrl: () => str('UPSTASH_REDIS_REST_URL').replace(/\/+$/, ''),
  upstashToken: () => str('UPSTASH_REDIS_REST_TOKEN'),
};

/** Capability report surfaced by /api/health so the UI can explain gaps. */
export function capabilities() {
  return {
    liveTradingConfigured: env.privateKey().length > 0,
    liveTradingAllowed: env.allowLive(),
    durableStorage: env.upstashUrl().length > 0 && env.upstashToken().length > 0,
    accessControl: env.accessToken().length > 0,
  };
}
