import type { LlmResult } from '../types';
import { SYSTEM_PROMPT, buildUserPrompt, type PromptContext } from './prompt';
import { parseForecast } from './parseForecast';

const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Shortest attempt worth starting; below this a round trip cannot land. */
const MIN_ATTEMPT_MS = 1500;

/** JSON schema the model is constrained to when the provider supports it. */
const RESPONSE_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'btc_updown_forecast',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['p_up', 'confidence', 'expected_move_usd', 'regime', 'key_factors', 'rationale'],
      properties: {
        p_up: { type: 'number', minimum: 0, maximum: 1 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        expected_move_usd: { type: 'number' },
        regime: {
          type: 'string',
          enum: ['trending-up', 'trending-down', 'mean-reverting', 'choppy', 'unknown'],
        },
        key_factors: { type: 'array', items: { type: 'string' }, maxItems: 6 },
        rationale: { type: 'string' },
      },
    },
  },
};

export interface ForecastOptions {
  apiKey: string;
  model: string;
  siteUrl?: string;
  siteName?: string;
  /** Total budget across every attempt. The 5-minute clock does not wait. */
  timeoutMs?: number;
  temperature?: number;
  /** Override for a self-hosted gateway, a proxy, or tests. */
  baseUrl?: string;
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string; reasoning?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: number };
  model?: string;
}

/**
 * Request a calibrated P(UP) from the configured OpenRouter model.
 *
 * The call is on the critical path of a 300-second market, so it is wrapped in
 * a hard timeout rather than left to the provider's own. If the model is slow
 * the caller keeps recording the BTC path and simply gets a later, and
 * therefore more informative, conditional update when the answer lands.
 */
export async function requestForecast(
  ctx: PromptContext,
  opts: ForecastOptions
): Promise<LlmResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const userPrompt = buildUserPrompt(ctx);

  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.apiKey}`,
    'content-type': 'application/json',
  };
  if (opts.siteUrl) headers['HTTP-Referer'] = opts.siteUrl;
  if (opts.siteName) headers['X-Title'] = opts.siteName;

  const basePayload = {
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    // Low but non-zero: deterministic decoding on a probability question tends
    // to collapse onto round numbers like 0.5 and 0.6.
    temperature: opts.temperature ?? 0.2,
    // The answer is ~120 tokens of JSON. The headroom exists because a model
    // that reasons before answering spends this budget on reasoning first, and
    // a budget that runs out mid-thought returns empty `content` — which reads
    // as a timeout rather than as the truncation it is.
    max_tokens: 1500,
    top_p: 0.9,
    // Disable reasoning where the provider supports it. This forecast wants a
    // number, not a deliberation, and reasoning tokens are pure latency here.
    reasoning: { effort: 'none', exclude: true },
  };

  // Retried without `reasoning` in case a provider rejects the unknown field.
  const { reasoning: _dropReasoning, ...noReasoningPayload } = basePayload;

  // Prefer a strict schema; fall back to plain JSON mode, then to free text
  // with reasoning left at the provider's default. Providers on OpenRouter
  // differ in what they honour, and a forecast that arrives as prose is still
  // better than no forecast.
  const attempts: Record<string, unknown>[] = [
    { ...basePayload, response_format: RESPONSE_SCHEMA },
    { ...basePayload, response_format: { type: 'json_object' } },
    { ...noReasoningPayload, response_format: { type: 'json_object' } },
  ];

  // `timeoutMs` is the budget for the whole call, not for each attempt. Three
  // attempts at a full timeout each would run past the serverless function's
  // own limit, and the caller would see the function die rather than a clean
  // failure it could act on.
  const deadline = started + timeoutMs;

  let lastError: unknown = null;
  // Set when the failure is one no retry can fix, so the loop stops instead of
  // spending the caller's whole budget re-asking the same rejected question.
  let fatal = false;

  for (let i = 0; i < attempts.length; i++) {
    const payload = attempts[i];
    const remaining = deadline - Date.now();
    // Below this a round trip cannot realistically complete, so stop and report
    // the failure while the caller still has clock left in its window.
    if (remaining < MIN_ATTEMPT_MS) {
      lastError =
        lastError ?? new Error(`LLM budget of ${timeoutMs}ms exhausted before a usable answer`);
      break;
    }
    // The first attempt gets the larger share, but never so much that a
    // timeout leaves nothing for the fallback — the fallback exists precisely
    // for the case where the first attempt is the one that hangs.
    const attemptMs =
      i === 0
        ? Math.max(MIN_ATTEMPT_MS, Math.min(Math.floor(remaining * 0.6), remaining - MIN_ATTEMPT_MS))
        : remaining;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptMs);
    try {
      const res = await fetch(opts.baseUrl ?? DEFAULT_OPENROUTER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: 'no-store',
      });

      const text = await res.text();
      if (!res.ok) {
        lastError = new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
        // A bad key, no credit, or a blocked account will not be fixed by
        // dropping `response_format`. Break out directly: `throw` here would be
        // caught by this block's own `catch` and retried, and `continue` would
        // skip past any check placed after the try — both defeat the fast-fail.
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          fatal = true;
          break;
        }
        continue;
      }

      const json = JSON.parse(text) as OpenRouterResponse;
      if (json.error) {
        lastError = new Error(`OpenRouter: ${json.error.message ?? 'unknown error'}`);
        continue;
      }

      const choice = json.choices?.[0];
      const content = choice?.message?.content ?? '';
      // Some providers put a reasoning model's visible answer in `reasoning`
      // and leave `content` empty, or truncate mid-answer. Both are recoverable
      // — the JSON is usually right there — so look before giving up.
      const fallbackContent = choice?.message?.reasoning ?? '';

      if (!content.trim() && !fallbackContent.trim()) {
        lastError = new Error(
          choice?.finish_reason === 'length'
            ? 'OpenRouter returned an empty completion (token budget exhausted before any content — the model is likely reasoning)'
            : `OpenRouter returned an empty completion (finish_reason: ${choice?.finish_reason ?? 'unknown'})`
        );
        continue;
      }

      const forecast = parseForecast(content) ?? parseForecast(fallbackContent);
      if (!forecast) {
        lastError = new Error(
          `could not parse a forecast from the response (finish_reason: ${choice?.finish_reason ?? 'unknown'}): ${(content || fallbackContent).slice(0, 200)}`
        );
        continue;
      }

      return {
        ...forecast,
        model: json.model ?? opts.model,
        latencyMs: Date.now() - started,
        promptTokens: json.usage?.prompt_tokens ?? null,
        completionTokens: json.usage?.completion_tokens ?? null,
        requestedAt: ctx.nowMs,
        requestPrice: ctx.currentPrice,
        raw: content.slice(0, 4000),
      };
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error(
          `LLM attempt ${i + 1} timed out after ${attemptMs}ms (budget ${timeoutMs}ms)`
        );
        // Do not abandon the budget on one slow attempt — a lighter fallback
        // request may still land inside it.
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  if (lastError instanceof Error) {
    if (fatal) lastError.message = `${lastError.message} (not retried — credentials or billing)`;
    throw lastError;
  }
  throw new Error('LLM request failed');
}

export { parseForecast };
