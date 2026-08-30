import type { LlmForecast } from '../types';
import { clamp } from '../math/stats';

/**
 * Tolerant extraction of the forecast object.
 *
 * Models wrap JSON in prose, in ```json fences, or emit it after a reasoning
 * preamble. Rather than fail the cycle on formatting, we find the first
 * balanced object containing a probability key and validate its contents.
 */
export function parseForecast(content: string): LlmForecast | null {
  const candidates: string[] = [];

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(content);

  for (const candidate of candidates) {
    for (const objText of balancedObjects(candidate)) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(objText) as Record<string, unknown>;
      } catch {
        continue;
      }
      const pRaw = firstNumber(obj, ['p_up', 'pUp', 'probability_up', 'p', 'probability']);
      if (pRaw === null) continue;

      const pUp = toProbability(pRaw);
      // A probability that is neither in 0..1 nor a plausible percentage is
      // malformed. Rejecting the candidate is the only safe reading: this
      // number seeds the drift that sizes a real order, and silently coercing
      // 1.4 into 0.014 (or into certainty) would be a fabricated forecast.
      if (pUp === null) continue;

      const confRaw = firstNumber(obj, ['confidence', 'conf']) ?? 0.5;

      return {
        pUp,
        confidence: clamp(confRaw > 1 && confRaw <= 100 ? confRaw / 100 : confRaw, 0, 1),
        expectedMoveUsd: firstNumber(obj, ['expected_move_usd', 'expectedMoveUsd']),
        rationale: String(obj.rationale ?? obj.reasoning ?? '').slice(0, 600),
        keyFactors: Array.isArray(obj.key_factors)
          ? obj.key_factors.slice(0, 6).map((f) => String(f).slice(0, 120))
          : [],
        regime: normaliseRegime(obj.regime),
      };
    }
  }

  // Last resort: a bare probability somewhere in the text. The sign is part of
  // the capture on purpose — without it a "-0.2" reads as 0.2, turning a
  // malformed answer into a confident bearish one.
  const loose = content.match(/\b(?:p_?up|probability)[^\d+-]{0,12}([+-]?\d*\.?\d+)/i);
  const loosePUp = loose ? toProbability(Number(loose[1])) : null;
  if (loosePUp !== null) {
    return {
      pUp: loosePUp,
      confidence: 0.2,
      expectedMoveUsd: null,
      rationale: content.slice(0, 300),
      keyFactors: [],
      regime: 'unknown',
    };
  }
  return null;
}

/** Yield every balanced `{...}` span in the text, outermost first. */
function* balancedObjects(text: string): Generator<string> {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          i = j;
          break;
        }
      }
    }
  }
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace('%', '').trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function normaliseRegime(v: unknown): LlmForecast['regime'] {
  const s = String(v ?? '').toLowerCase().replace(/[\s_]+/g, '-');
  const allowed: LlmForecast['regime'][] = [
    'trending-up',
    'trending-down',
    'mean-reverting',
    'choppy',
    'unknown',
  ];
  return (allowed as string[]).includes(s) ? (s as LlmForecast['regime']) : 'unknown';
}

/**
 * Normalise a model-supplied probability.
 *
 * Returns 0..1 unchanged, converts an unambiguous percentage (2..100), and
 * returns null for anything else so the caller can reject the response rather
 * than trade on a guess.
 */
function toProbability(raw: number): number | null {
  if (!Number.isFinite(raw)) return null;
  if (raw >= 0 && raw <= 1) return clamp(raw, 0, 1);
  if (raw >= 2 && raw <= 100) return clamp(raw / 100, 0, 1);
  return null;
}
