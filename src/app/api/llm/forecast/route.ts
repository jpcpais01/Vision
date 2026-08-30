import { env } from '@/lib/env';
import { clientKey, errorMessage, fail, handler, ok, rateLimit } from '@/lib/api';
import { requestForecast } from '@/lib/llm/openrouter';
import { fetchChainlink, fetchHistory } from '@/lib/price/sources';
import { estimateVolatility } from '@/lib/quant/volatility';
import { trimBars } from '@/lib/price/aggregator';
import type { Bar, ChainlinkSnapshot, PriceSourceName } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The client-supplied budget is clamped below this, so the model always fails
// cleanly on its own deadline rather than being cut off by the platform.
export const maxDuration = 60;

interface ForecastBody {
  startPrice: number;
  currentPrice: number;
  windowStartMs: number;
  windowEndMs: number;
  /** 10s bars captured by the client. Omitted on the first cycle after load. */
  bars?: Bar[];
  historyMinutes?: number;
  source?: PriceSourceName;
  ewmaLambda?: number;
  llmTimeoutMs?: number;
}

/**
 * Ask the configured OpenRouter model for a calibrated P(UP).
 *
 * The API key never leaves the server. The client sends the bars it already
 * holds — they are fresher than anything this route could fetch, since the
 * browser is streaming trades directly from the exchange — and the route falls
 * back to fetching history itself when the client has none yet.
 */
export const POST = handler(async (req) => {
  const apiKey = env.openrouterKey();
  if (!apiKey) {
    return fail(
      'OPENROUTER_API_KEY is not configured on the server. Set it in your Vercel project environment variables.',
      503
    );
  }
  // One forecast per 5-minute window is the intended rate; this only stops a
  // runaway client from burning credits.
  if (!rateLimit(clientKey(req, 'llm'), 40, 60_000)) {
    return fail('rate limited', 429);
  }

  const body = (await req.json()) as ForecastBody;
  if (!isFinitePositive(body.startPrice) || !isFinitePositive(body.currentPrice)) {
    return fail('startPrice and currentPrice are required', 400);
  }
  if (!Number.isFinite(body.windowStartMs) || !Number.isFinite(body.windowEndMs)) {
    return fail('windowStartMs and windowEndMs are required', 400);
  }

  const minutes = clampInt(body.historyMinutes ?? 60, 5, 180);
  const source = body.source ?? 'binance';

  let bars: Bar[] = Array.isArray(body.bars) ? sanitizeBars(body.bars) : [];
  let interpolated = false;
  let feedLabel = source as string;

  if (bars.length < 60) {
    const history = await fetchHistory(minutes, source);
    bars = trimBars(history.bars, minutes);
    interpolated = history.interpolated;
    feedLabel = history.source;
  }

  const vol = estimateVolatility(bars, body.ewmaLambda ?? 0.97);

  // Best-effort: an oracle read that fails must not cost us the forecast.
  let chainlink: ChainlinkSnapshot | null = null;
  try {
    chainlink = await fetchChainlink(env.chainlinkRpc(), env.chainlinkFeed());
  } catch {
    chainlink = null;
  }

  const nowMs = Date.now();

  try {
    const result = await requestForecast(
      {
        startPrice: body.startPrice,
        currentPrice: body.currentPrice,
        windowStartMs: body.windowStartMs,
        windowEndMs: body.windowEndMs,
        nowMs,
        bars,
        vol,
        chainlink,
        interpolated,
        source: feedLabel,
      },
      {
        apiKey,
        model: env.openrouterModel(),
        siteUrl: env.openrouterSiteUrl(),
        siteName: env.openrouterSiteName(),
        baseUrl: env.openrouterBaseUrl(),
        timeoutMs: clampInt(body.llmTimeoutMs ?? 20_000, 5000, 50_000),
      }
    );

    return ok({ forecast: result, vol, barsUsed: bars.length, chainlink, serverTime: Date.now() });
  } catch (err) {
    return fail(errorMessage(err), 502, { vol, barsUsed: bars.length });
  }
});

function sanitizeBars(bars: Bar[]): Bar[] {
  return bars
    .filter(
      (b) =>
        b &&
        Number.isFinite(b.t) &&
        Number.isFinite(b.c) &&
        b.c > 0 &&
        Number.isFinite(b.o) &&
        b.o > 0
    )
    .slice(-1200);
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}
