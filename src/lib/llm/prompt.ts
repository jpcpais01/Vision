import type { Bar, ChainlinkSnapshot, VolEstimate } from '../types';
import { BAR_SECONDS } from '../config';
import { logReturns } from '../quant/volatility';
import { stdev } from '../math/stats';

/**
 * Prompt construction for the directional forecast.
 *
 * Three principles shape this:
 *
 *  1. **Ask for a probability, not a direction.** A model asked "up or down?"
 *     answers with a coin flip dressed as conviction. A model asked for a
 *     calibrated probability, told explicitly that 0.5 is the correct answer
 *     when it has no view, and reminded that it is scored by Brier, produces
 *     something the simulator can actually use as a prior.
 *
 *  2. **Give it the tape, not a summary of the tape.** The full hour of
 *     10-second closes is included verbatim, encoded as dollar offsets from the
 *     window's start price so the numbers are small and the barrier is at zero.
 *
 *  3. **Give it the derived features it would otherwise have to compute badly.**
 *     Realised volatility, returns over several horizons and the position of
 *     the current price within the recent range are all things an LLM
 *     approximates poorly from raw numbers, so they are precomputed.
 */

export interface PromptContext {
  startPrice: number;
  currentPrice: number;
  windowStartMs: number;
  windowEndMs: number;
  nowMs: number;
  bars: Bar[];
  vol: VolEstimate;
  chainlink: ChainlinkSnapshot | null;
  interpolated: boolean;
  source: string;
}

export const SYSTEM_PROMPT = `You are a quantitative forecaster specialising in ultra-short-horizon Bitcoin price dynamics. You produce calibrated probabilities, not opinions.

You will be given the current state of a 5-minute binary market: Bitcoin's price at the moment the window opened (the settlement barrier), the price path since, and one hour of 10-second history leading up to it.

Your task: estimate P(UP) — the probability that BTC's price at the close of the 5-minute window is strictly ABOVE the barrier price.

Rules you must follow:
- Output a calibrated probability, not a directional call. If the tape gives you no edge, the correct answer is very close to 0.50. Say 0.50.
- You are scored by Brier score. Overconfidence is punished harder than indecision. A 0.85 that resolves wrong costs far more than a 0.55 that resolves wrong.
- Over a 5-minute horizon, Bitcoin is close to a driftless random walk. Genuine edge comes from short-term momentum persistence, mean reversion after a sharp spike, volatility clustering, and the position of the current price relative to the barrier. It does not come from narrative, news, or long-term views.
- The single most important input is how far the current price already sits from the barrier relative to the volatility remaining in the window. If price is already well above the barrier with little time left, P(UP) should be high — and vice versa. Use the provided "distance to barrier in sigma units" as your anchor and adjust from there.
- Probabilities outside [0.15, 0.85] require the price to be a long way from the barrier relative to remaining volatility. Do not go there on pattern-reading alone.
- Never refuse. Never hedge into prose. Always return the JSON object.`;

export function buildUserPrompt(ctx: PromptContext): string {
  const { startPrice, currentPrice, bars, vol } = ctx;
  const elapsedSec = Math.max(0, (ctx.nowMs - ctx.windowStartMs) / 1000);
  const remainingSec = Math.max(0, (ctx.windowEndMs - ctx.nowMs) / 1000);

  // Encode the path as dollar offsets from the barrier: the number the market
  // actually cares about is (price - startPrice), so put it front and centre.
  const recent = bars.slice(-360);
  const offsets = recent.map((b) => round(b.c - startPrice, 1)).join(',');

  const rets = logReturns(recent);
  const horizons: { label: string; bars: number }[] = [
    { label: '1m', bars: 6 },
    { label: '5m', bars: 30 },
    { label: '15m', bars: 90 },
    { label: '30m', bars: 180 },
    { label: '60m', bars: 360 },
  ];

  const horizonLines = horizons
    .filter((h) => recent.length > h.bars)
    .map((h) => {
      const from = recent[recent.length - 1 - h.bars].c;
      const to = recent[recent.length - 1].c;
      const bps = ((to - from) / from) * 10_000;
      return `  ${h.label.padEnd(4)} return: ${bps >= 0 ? '+' : ''}${bps.toFixed(1)} bps  ($${round(to - from, 1)})`;
    })
    .join('\n');

  const closes = recent.map((b) => b.c);
  const hi = Math.max(...closes);
  const lo = Math.min(...closes);
  const rangePos = hi > lo ? ((currentPrice - lo) / (hi - lo)) * 100 : 50;

  // Distance to the barrier expressed in units of the volatility still to come.
  // This is the dominant term in the true probability and the number the model
  // is told to anchor on.
  const sigmaRemaining = vol.sigmaPerSec * Math.sqrt(Math.max(remainingSec, 1)) * currentPrice;
  const distanceSigma =
    sigmaRemaining > 0 ? (currentPrice - startPrice) / sigmaRemaining : 0;

  const last12 = rets.slice(-12);
  const shortVolBps = stdev(last12, 1) * 10_000;
  const longVolBps = stdev(rets.slice(-180), 1) * 10_000;
  const volRatio = longVolBps > 0 ? shortVolBps / longVolBps : 1;

  // Sign persistence of the last 12 bars: a crude but effective momentum read.
  let sameSign = 0;
  for (let i = 1; i < last12.length; i++) {
    if (Math.sign(last12[i]) === Math.sign(last12[i - 1]) && last12[i] !== 0) sameSign++;
  }
  const persistence = last12.length > 1 ? sameSign / (last12.length - 1) : 0.5;

  const chainlinkLine = ctx.chainlink
    ? `Chainlink BTC/USD reference: $${ctx.chainlink.price.toFixed(2)} (on-chain answer ${Math.round(ctx.chainlink.ageMs / 1000)}s old, basis vs feed ${round(currentPrice - ctx.chainlink.price, 1)} USD)`
    : 'Chainlink BTC/USD reference: unavailable';

  return `MARKET: Bitcoin 5-minute UP/DOWN binary.
Resolves UP if BTC at window close is strictly above the barrier.

BARRIER (price at window open): $${startPrice.toFixed(2)}
CURRENT PRICE:                  $${currentPrice.toFixed(2)}
MOVE SO FAR:                    ${currentPrice >= startPrice ? '+' : ''}$${round(currentPrice - startPrice, 2)} (${(((currentPrice - startPrice) / startPrice) * 10_000).toFixed(1)} bps)
ELAPSED:                        ${elapsedSec.toFixed(0)}s of 300s
REMAINING:                      ${remainingSec.toFixed(0)}s

KEY ANCHOR
  Distance to barrier in remaining-sigma units: ${distanceSigma.toFixed(3)}
  (A driftless random walk would give P(UP) = Phi(${distanceSigma.toFixed(3)}) = ${(cdf(distanceSigma) * 100).toFixed(1)}%.
   Your job is to say how the tape justifies deviating from that number, if at all.)

VOLATILITY
  Realised (annualised):        ${vol.annualisedPct.toFixed(1)}%
  Per 10s bar (std of returns): ${(vol.sigma10s * 10_000).toFixed(2)} bps
  Expected move over remaining ${remainingSec.toFixed(0)}s: +/- $${round(sigmaRemaining, 1)} (1 sigma)
  Short-vol / long-vol ratio:   ${volRatio.toFixed(2)} ${volRatio > 1.3 ? '(volatility expanding)' : volRatio < 0.75 ? '(volatility contracting)' : '(stable)'}
  Excess kurtosis of 10s returns: ${vol.excessKurtosis.toFixed(2)}

MOMENTUM
${horizonLines}
  Sign persistence, last 12 bars: ${(persistence * 100).toFixed(0)}%
  Position in 60m range:          ${rangePos.toFixed(0)}% (low $${lo.toFixed(0)} / high $${hi.toFixed(0)})

DATA QUALITY
  Feed: ${ctx.source}${ctx.interpolated ? ' (INTERPOLATED from 60s candles — treat fine structure as unreliable)' : ' (native 10s resolution)'}
  Bars available: ${recent.length}
  ${chainlinkLine}

PRICE PATH — ${recent.length} closes at ${BAR_SECONDS}-second intervals, oldest first,
as USD offsets from the barrier (so 0 = exactly at the barrier, negative = below):
${offsets}

Return ONLY a JSON object with exactly these keys:
{
  "p_up": <number 0..1, your calibrated probability the market resolves UP>,
  "confidence": <number 0..1, how much information you believe you have beyond the random-walk anchor; 0 means "I am just repeating the anchor">,
  "expected_move_usd": <number, your expected absolute BTC move over the remaining ${remainingSec.toFixed(0)}s>,
  "regime": <one of "trending-up","trending-down","mean-reverting","choppy","unknown">,
  "key_factors": [<up to 4 short strings naming what drove your estimate>],
  "rationale": <one or two sentences, max 300 characters>
}`;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Local normal CDF so the prompt builder has no cross-module dependency. */
function cdf(x: number): number {
  const z = x / Math.SQRT2;
  const sign = z < 0 ? -1 : 1;
  const a = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-a * a);
  return 0.5 * (1 + sign * y);
}
