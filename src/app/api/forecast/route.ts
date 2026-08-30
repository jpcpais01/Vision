import { env } from '@/lib/env';
import { errorMessage, fail, handler, ok } from '@/lib/api';
import { forecast } from '@/lib/llm';
import { history } from '@/lib/pyth';
import { HISTORY_MIN } from '@/lib/config';
import type { Bar } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

/**
 * Ask the model: higher or lower in five minutes, and how likely?
 * The API key stays here and never reaches the browser.
 */
export const POST = handler(async (req) => {
  const key = env.openrouterKey();
  if (!key) {
    return fail('OPENROUTER_API_KEY is not set on the server', 503);
  }

  const body = (await req.json()) as { bars?: Bar[]; current?: number };
  if (!(typeof body.current === 'number' && body.current > 0)) {
    return fail('current price required', 400);
  }

  // The client's bars are fresher; fall back to fetching if it has none yet.
  let bars = Array.isArray(body.bars)
    ? body.bars.filter((b) => b && Number.isFinite(b.t) && b.c > 0).slice(-200)
    : [];
  if (bars.length < 30) bars = await history(HISTORY_MIN);

  try {
    const f = await forecast(bars, body.current, {
      apiKey: key,
      model: env.openrouterModel(),
      baseUrl: env.openrouterBaseUrl(),
      referer: env.openrouterSiteUrl(),
      title: env.openrouterSiteName(),
      timeoutMs: 20_000,
    });
    return ok({ forecast: f, barsUsed: bars.length });
  } catch (err) {
    return fail(errorMessage(err), 502);
  }
});
