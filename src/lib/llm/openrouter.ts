import 'server-only';
import type { LlmResult } from '../types';
import { SYSTEM_PROMPT, buildUserPrompt, type PromptContext } from './prompt';
import { parseForecast } from './parseForecast';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

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
  /** Hard deadline. The 5-minute clock does not wait for the model. */
  timeoutMs?: number;
  temperature?: number;
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
    max_tokens: 700,
    top_p: 0.9,
  };

  // Prefer a strict schema; fall back to plain JSON mode, then to free text.
  // Providers on OpenRouter differ in what they honour, and a forecast that
  // arrives as prose is still better than no forecast.
  const attempts: Record<string, unknown>[] = [
    { ...basePayload, response_format: RESPONSE_SCHEMA },
    { ...basePayload, response_format: { type: 'json_object' } },
    basePayload,
  ];

  let lastError: unknown = null;

  for (const payload of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: 'no-store',
      });

      const text = await res.text();
      if (!res.ok) {
        lastError = new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
        // 401/402 will not be fixed by dropping response_format.
        if (res.status === 401 || res.status === 402 || res.status === 403) throw lastError;
        continue;
      }

      const json = JSON.parse(text) as OpenRouterResponse;
      if (json.error) {
        lastError = new Error(`OpenRouter: ${json.error.message ?? 'unknown error'}`);
        continue;
      }

      const content = json.choices?.[0]?.message?.content ?? '';
      if (!content.trim()) {
        lastError = new Error('OpenRouter returned an empty completion');
        continue;
      }

      const forecast = parseForecast(content);
      if (!forecast) {
        lastError = new Error(`could not parse forecast from: ${content.slice(0, 200)}`);
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
        throw new Error(`LLM timed out after ${timeoutMs}ms`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('LLM request failed');
}

export { parseForecast };
