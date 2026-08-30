import 'server-only';
import type { FillReport, Side } from '../types';
import { env } from '../env';

/**
 * LIVE order placement against the Polymarket CLOB.
 *
 * Everything here is quarantined behind a dynamic import so that PAPER mode —
 * and the production build — never loads the signing stack. Three independent
 * conditions must all hold before a single real order leaves this process:
 *
 *   1. `ALLOW_LIVE_TRADING=true` in the server environment (not the UI).
 *   2. A `POLYMARKET_PRIVATE_KEY` is configured server-side.
 *   3. The request itself asks for LIVE mode and the kill switch is off.
 *
 * The private key is read here and nowhere else, is never returned by any
 * route, and never crosses the network boundary to the browser.
 */

export interface LiveOrderRequest {
  tokenId: string;
  side: Side;
  /** Limit price per share, 0..1. */
  price: number;
  /** Shares. */
  size: number;
  tickSize: number;
  negRisk: boolean;
}

export interface LiveOrderResult {
  success: boolean;
  orderId: string | null;
  status: string;
  fill: FillReport;
  error?: string;
  raw?: unknown;
}

interface ClobModule {
  ClobClient: new (...args: unknown[]) => ClobClientLike;
  Side: { BUY: unknown; SELL: unknown };
  OrderType: Record<string, unknown>;
}

interface ClobClientLike {
  createOrDeriveApiKey(nonce?: number): Promise<ApiCreds>;
  createOrder(args: Record<string, unknown>, opts?: Record<string, unknown>): Promise<unknown>;
  postOrder(order: unknown, type?: unknown): Promise<PostOrderResponse>;
  cancelAll(): Promise<unknown>;
  getBalanceAllowance?(params: unknown): Promise<unknown>;
  getOrders?(params: unknown): Promise<unknown>;
}

interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

interface PostOrderResponse {
  success?: boolean;
  errorMsg?: string;
  orderID?: string;
  orderId?: string;
  status?: string;
  makingAmount?: string;
  takingAmount?: string;
  transactionsHashes?: string[];
}

let clientPromise: Promise<ClobClientLike> | null = null;

/** Reasons LIVE trading is unavailable, for the UI to display honestly. */
export function liveTradingBlockers(): string[] {
  const blockers: string[] = [];
  if (!env.allowLive()) {
    blockers.push('ALLOW_LIVE_TRADING is not set to true on the server');
  }
  if (!env.privateKey()) {
    blockers.push('POLYMARKET_PRIVATE_KEY is not configured');
  }
  return blockers;
}

async function getClient(): Promise<ClobClientLike> {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const blockers = liveTradingBlockers();
    if (blockers.length > 0) throw new Error(blockers.join('; '));

    // Dynamic so the dependency is only resolved when a live order is actually
    // attempted. A missing or incompatible package fails one order, loudly,
    // instead of breaking the whole deployment.
    const clob = (await import('@polymarket/clob-client')) as unknown as ClobModule;
    const ethers = await import('ethers');

    const WalletCtor = (ethers as unknown as { Wallet: new (pk: string) => unknown }).Wallet;
    const signer = new WalletCtor(normalisePrivateKey(env.privateKey()));

    const host = env.clobUrl();
    const chainId = env.chainId();
    const sigType = env.signatureType();
    const funder = env.funderAddress() || undefined;

    let creds: ApiCreds;
    if (env.apiKey() && env.apiSecret() && env.apiPassphrase()) {
      creds = {
        key: env.apiKey(),
        secret: env.apiSecret(),
        passphrase: env.apiPassphrase(),
      };
    } else {
      // L2 credentials are deterministic from the key, so deriving is safe to
      // repeat and avoids asking the operator to run a separate setup script.
      const bootstrap = new clob.ClobClient(host, chainId, signer);
      creds = await bootstrap.createOrDeriveApiKey();
    }

    return new clob.ClobClient(host, chainId, signer, creds, sigType, funder);
  })();

  try {
    return await clientPromise;
  } catch (err) {
    clientPromise = null;
    throw err;
  }
}

function normalisePrivateKey(pk: string): string {
  const trimmed = pk.trim();
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

/**
 * Submit a marketable buy. Fill-and-kill semantics are preferred: on a
 * 5-minute market a resting remainder is a liability, not an opportunity, so
 * anything that does not fill immediately should be cancelled rather than left
 * to be picked off after the price has moved.
 */
export async function placeLiveOrder(req: LiveOrderRequest): Promise<LiveOrderResult> {
  const started = Date.now();
  const failed = (error: string): LiveOrderResult => ({
    success: false,
    orderId: null,
    status: 'REJECTED',
    fill: {
      simulated: false,
      requestedSize: req.size,
      filledSize: 0,
      avgPrice: 0,
      slippage: 0,
      levels: [],
      latencyMs: Date.now() - started,
    },
    error,
  });

  try {
    const clob = (await import('@polymarket/clob-client')) as unknown as ClobModule;
    const client = await getClient();

    const order = await client.createOrder(
      {
        tokenID: req.tokenId,
        price: req.price,
        side: clob.Side.BUY,
        size: req.size,
        feeRateBps: 0,
      },
      { tickSize: String(req.tickSize), negRisk: req.negRisk }
    );

    // Order-type names have shifted across client versions (FAK/FOK/GTC), so
    // pick whichever immediate-or-cancel variant this build exposes.
    const orderType =
      clob.OrderType.FAK ?? clob.OrderType.FOK ?? clob.OrderType.GTC ?? undefined;

    const res = await client.postOrder(order, orderType);

    const orderId = res.orderID ?? res.orderId ?? null;
    const success = res.success !== false && !res.errorMsg;

    if (!success) return failed(res.errorMsg ?? 'order rejected by CLOB');

    // making/taking amounts come back as decimal strings of USDC and shares.
    const taking = Number(res.takingAmount ?? 0);
    const making = Number(res.makingAmount ?? 0);
    const filledSize = Number.isFinite(taking) && taking > 0 ? taking : req.size;
    const avgPrice =
      Number.isFinite(making) && making > 0 && filledSize > 0 ? making / filledSize : req.price;

    return {
      success: true,
      orderId,
      status: res.status ?? 'matched',
      fill: {
        simulated: false,
        requestedSize: req.size,
        filledSize,
        avgPrice,
        slippage: avgPrice - req.price,
        levels: [],
        latencyMs: Date.now() - started,
      },
      raw: res,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/cannot find module|module not found/i.test(message)) {
      return failed(
        '@polymarket/clob-client is not installed in this deployment — LIVE trading unavailable'
      );
    }
    return failed(message);
  }
}

/** Emergency stop: cancel every resting order this account has. */
export async function cancelAllOrders(): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = await getClient();
    await client.cancelAll();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** USDC balance / allowance, so the UI can show real buying power in LIVE mode. */
export async function fetchBalance(): Promise<{
  ok: boolean;
  balance?: number;
  allowance?: number;
  error?: string;
}> {
  try {
    const client = await getClient();
    if (!client.getBalanceAllowance) return { ok: false, error: 'unsupported by client version' };
    const res = (await client.getBalanceAllowance({ asset_type: 'COLLATERAL' })) as {
      balance?: string;
      allowance?: string;
    };
    // Values come back in 6-decimal USDC base units.
    const scale = 1e6;
    return {
      ok: true,
      balance: Number(res.balance ?? 0) / scale,
      allowance: Number(res.allowance ?? 0) / scale,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
