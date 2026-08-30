import type { Bar, Forecast, Side } from './types';

/**
 * ── The forecast ─────────────────────────────────────────────────────────────
 *
 * We ask the model one question and allow it two numbers.
 *
 *   "Given the last 30 minutes of prices and the price right now, will Bitcoin
 *    be higher or lower in five minutes — and how likely is that?"
 *
 * No confidence score, no regime label, no rationale that feeds a gate. Those
 * were extra surface with no path to a decision. The direction picks the side
 * we are allowed to trade for the whole window; the probability seeds the
 * simulation. Everything after that is arithmetic on live prices.
 */

const URL = 'https://openrouter.ai/api/v1/chat/completions';

const SYSTEM = `You forecast very short-horizon Bitcoin moves. You answer with JSON only.

You will be given the last 30 minutes of Bitcoin prices, sampled every 10 seconds, and the current price.

Answer one question: in 5 minutes, will the price be HIGHER or LOWER than it is right now?

Return exactly this JSON and nothing else:
{"direction":"UP","probability":62}

- "direction" is "UP" or "DOWN" — whichever you think is more likely.
- "probability" is a whole number from 50 to 95: how likely that direction is, as a percentage.
- Over 5 minutes Bitcoin is close to a coin flip. If you see nothing, say 50 or 51. Real signal is rare.
- Anything above 70 needs a strong, visible reason in the recent prices. Being confidently wrong is the worst outcome.
- No text before or after the JSON. No code fences. First character "{", last character "}".`;

export interface ForecastOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  baseUrl?: string;
  referer?: string;
  title?: string;
}

/** Build the user message: the tape, then the question. */
export function buildPrompt(bars: Bar[], current: number): string {
  const closes = bars.slice(-180); // 30 minutes at 10 seconds
  const series = closes.map((b) => b.c.toFixed(1)).join(',');

  const first = closes[0]?.c ?? current;
  const changeBps = first > 0 ? ((current - first) / first) * 10_000 : 0;
  const hi = Math.max(...closes.map((b) => b.c), current);
  const lo = Math.min(...closes.map((b) => b.c), current);

  return `Current BTC price: ${current.toFixed(2)}

Last ${closes.length} closes, one every 10 seconds, oldest first:
${series}

Over this window: ${changeBps >= 0 ? '+' : ''}${changeBps.toFixed(0)} bps, high ${hi.toFixed(0)}, low ${lo.toFixed(0)}.

In 5 minutes, will the price be higher or lower than ${current.toFixed(2)}?
Reply with the JSON object only.`;
}

export async function forecast(
  bars: Bar[],
  current: number,
  opts: ForecastOptions
): Promise<Forecast> {
  const started = Date.now();
  const budget = opts.timeoutMs ?? 20_000;
  const deadline = started + budget;

  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.apiKey}`,
    'content-type': 'application/json',
  };
  if (opts.referer) headers['HTTP-Referer'] = opts.referer;
  if (opts.title) headers['X-Title'] = opts.title;

  const payload = {
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildPrompt(bars, current) },
    ],
    temperature: 0.2,
    // Room to spare: on OpenRouter reasoning tokens come out of this budget,
    // and a model that thinks past it returns empty content, which looks
    // exactly like a hang.
    max_tokens: 800,
    reasoning: { effort: 'none', exclude: true },
    response_format: { type: 'json_object' },
  };

  // Two attempts sharing one budget — the second drops `reasoning` in case the
  // provider rejects the field.
  const attempts: Record<string, unknown>[] = [
    payload,
    { ...payload, reasoning: undefined },
  ];

  let lastError: unknown = null;

  for (let i = 0; i < attempts.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    const slice = i === 0 ? Math.max(1500, Math.floor(remaining * 0.65)) : remaining;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), slice);
    try {
      const res = await fetch(opts.baseUrl ?? URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(attempts[i]),
        signal: controller.signal,
        cache: 'no-store',
      });
      const text = await res.text();

      if (!res.ok) {
        lastError = new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
        // A bad key or no credit will not fix itself on retry.
        if (res.status === 401 || res.status === 402 || res.status === 403) break;
        continue;
      }

      const json = JSON.parse(text) as {
        model?: string;
        choices?: { message?: { content?: string; reasoning?: string } }[];
        error?: { message?: string };
      };
      if (json.error) {
        lastError = new Error(`OpenRouter: ${json.error.message ?? 'unknown'}`);
        continue;
      }

      const msg = json.choices?.[0]?.message;
      const content = msg?.content?.trim() || msg?.reasoning?.trim() || '';
      const parsed = parse(content);
      if (!parsed) {
        lastError = new Error(`unparseable reply: ${content.slice(0, 160) || '(empty)'}`);
        continue;
      }

      return {
        ...parsed,
        latencyMs: Date.now() - started,
        model: json.model ?? opts.model,
        priceAtRequest: current,
        raw: content.slice(0, 500),
      };
    } catch (err) {
      lastError = err instanceof Error && err.name === 'AbortError'
        ? new Error(`forecast timed out after ${slice}ms of a ${budget}ms budget`)
        : err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('forecast failed');
}

/**
 * Pull `{direction, probability}` out of the reply.
 *
 * Tolerant about wrapping (fences, stray prose) but strict about values: a
 * probability outside 50–100 is rejected rather than coerced, because this
 * number sizes real orders.
 */
export function parse(content: string): Pick<Forecast, 'side' | 'probability' | 'pUp'> | null {
  const objects = content.match(/\{[^{}]*\}/g) ?? [];
  const candidates = [...objects, content];

  for (const candidate of candidates) {
    let side: Side | null = null;
    let prob: number | null = null;

    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      side = readSide(obj.direction ?? obj.side ?? obj.prediction);
      prob = readProb(obj.probability ?? obj.prob ?? obj.confidence);
    } catch {
      // Not JSON — fall back to reading it out of the text.
      side = readSide(candidate.match(/"?(?:direction|side)"?\s*[:=]\s*"?(up|down|higher|lower)/i)?.[1]);
      prob = readProb(candidate.match(/"?probability"?\s*[:=]\s*"?([\d.]+)/i)?.[1]);
    }

    if (side && prob !== null) {
      return { side, probability: prob, pUp: side === 'UP' ? prob : 1 - prob };
    }
  }
  return null;
}

function readSide(v: unknown): Side | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (['up', 'higher', 'above', 'long', 'bull', 'bullish'].includes(s)) return 'UP';
  if (['down', 'lower', 'below', 'short', 'bear', 'bearish'].includes(s)) return 'DOWN';
  return null;
}

function readProb(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace('%', '').trim());
  if (!Number.isFinite(n)) return null;
  // Accept 0.62 or 62, but nothing that is not a probability of the stated
  // direction — which by construction is at least a coin flip.
  const p = n > 1 ? n / 100 : n;
  if (p < 0.5 || p > 1) return null;
  // Cap the swagger: nothing about five minutes of Bitcoin justifies 99%.
  return Math.min(p, 0.95);
}
