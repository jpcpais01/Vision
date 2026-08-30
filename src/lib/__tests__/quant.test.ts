import { strict as assert } from 'node:assert';
import test from 'node:test';
import { normCdf, normInv } from '../math/normal';
import { NormalSampler, Rng } from '../math/rng';
import { analyticPUp, runMonteCarlo } from '../quant/montecarlo';
import { estimateVolatility } from '../quant/volatility';
import { shrinkProbability } from '../engine/risk';
import { quoteFromBook, simulateBuy } from '../polymarket/clob';
import { computeMetrics } from '../quant/calibration';
import { ticksToBars, fillBarGaps, upsampleToTenSeconds } from '../price/aggregator';
import { parseForecast } from '../llm/parseForecast';
import type { Bar, MonteCarloInput, OrderBook, Trade, VolEstimate } from '../types';

// ── Normal distribution ─────────────────────────────────────────────────────

test('normCdf matches known values', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normCdf(-1.96) - 0.025) < 1e-4);
  assert.ok(Math.abs(normCdf(2.5758) - 0.995) < 1e-4);
});

test('normInv inverts normCdf to high precision', () => {
  for (const p of [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
    const x = normInv(p);
    assert.ok(Math.abs(normCdf(x) - p) < 1e-6, `p=${p} round-trip failed`);
  }
});

// ── RNG ─────────────────────────────────────────────────────────────────────

test('Rng is uniform, in range, and deterministic per seed', () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  let sum = 0;
  const n = 200_000;
  for (let i = 0; i < n; i++) {
    const v = a.next();
    assert.equal(v, b.next(), 'same seed must replay identically');
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    sum += v;
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean - 0.5) < 0.005, `mean ${mean} not ~0.5`);
});

test('NormalSampler produces unit normal draws', () => {
  const s = new NormalSampler(new Rng(7));
  const n = 200_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const z = s.next();
    sum += z;
    sumSq += z * z;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  assert.ok(Math.abs(mean) < 0.01, `mean ${mean}`);
  assert.ok(Math.abs(variance - 1) < 0.02, `variance ${variance}`);
});

test('Student-t sampler is standardised to unit variance', () => {
  const s = new NormalSampler(new Rng(99));
  const n = 300_000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const z = s.nextStudentT(6);
    sum += z;
    sumSq += z * z;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
  // Standardised t has unit variance by construction; the Wilson-Hilferty
  // chi-square approximation leaves a small bias, which must stay small.
  assert.ok(Math.abs(variance - 1) < 0.12, `variance ${variance}`);
});

// ── Monte Carlo ─────────────────────────────────────────────────────────────

function vol(sigmaPerSec: number): VolEstimate {
  return {
    sigmaPerSec,
    annualisedPct: sigmaPerSec * Math.sqrt(365 * 24 * 3600) * 100,
    sigma10s: sigmaPerSec * Math.sqrt(10),
    excessKurtosis: 0,
    samples: 360,
    windows: [],
    method: 'ewma-blend',
  };
}

function baseInput(over: Partial<MonteCarloInput> = {}): MonteCarloInput {
  return {
    startPrice: 100_000,
    currentPrice: 100_000,
    elapsedSec: 0,
    remainingSec: 300,
    priorPUp: 0.5,
    priorWeight: 0,
    vol: vol(0.00002), // ~35% annualised
    recentReturns: [],
    paths: 40_000,
    engine: 'gbm',
    studentT: 0,
    seed: 42,
    ...over,
  };
}

test('driftless simulation at the barrier gives 50%', () => {
  const r = runMonteCarlo(baseInput());
  assert.ok(Math.abs(r.pUp - 0.5) < 0.01, `pUp ${r.pUp}`);
});

test('simulation matches the closed-form Gaussian answer across states', () => {
  const cases = [
    { currentPrice: 100_000, remainingSec: 300, prior: 0.5, weight: 0 },
    { currentPrice: 100_050, remainingSec: 150, prior: 0.5, weight: 0 },
    { currentPrice: 99_940, remainingSec: 60, prior: 0.5, weight: 0 },
    { currentPrice: 100_020, remainingSec: 200, prior: 0.65, weight: 1 },
    { currentPrice: 99_980, remainingSec: 100, prior: 0.35, weight: 1 },
  ];

  for (const c of cases) {
    const input = baseInput({
      currentPrice: c.currentPrice,
      remainingSec: c.remainingSec,
      elapsedSec: 300 - c.remainingSec,
      priorPUp: c.prior,
      priorWeight: c.weight,
    });
    const sim = runMonteCarlo(input);
    const exact = analyticPUp({
      startPrice: input.startPrice,
      currentPrice: input.currentPrice,
      remainingSec: input.remainingSec,
      elapsedSec: input.elapsedSec,
      sigmaPerSec: input.vol.sigmaPerSec,
      priorPUp: input.priorPUp,
      priorWeight: input.priorWeight,
    });
    assert.ok(
      Math.abs(sim.pUp - exact) < 0.012,
      `sim ${sim.pUp.toFixed(4)} vs exact ${exact.toFixed(4)} for ${JSON.stringify(c)}`
    );
  }
});

test('an already-realised move dominates a contrary LLM prior late in the window', () => {
  // The model said 75% UP, but BTC has fallen $150 with 30 seconds left.
  // The conditional update must reject the prior, not average with it.
  const r = runMonteCarlo(
    baseInput({
      currentPrice: 99_850,
      elapsedSec: 270,
      remainingSec: 30,
      priorPUp: 0.75,
      priorWeight: 1,
      paths: 40_000,
    })
  );
  assert.ok(r.pUp < 0.05, `expected a low probability, got ${r.pUp}`);
});

test('a realised move in the prior direction raises the probability', () => {
  const r = runMonteCarlo(
    baseInput({
      currentPrice: 100_120,
      elapsedSec: 240,
      remainingSec: 60,
      priorPUp: 0.6,
      priorWeight: 1,
    })
  );
  assert.ok(r.pUp > 0.9, `expected a high probability, got ${r.pUp}`);
});

test('the prior moves the answer in the right direction, and priorWeight scales it', () => {
  const neutral = runMonteCarlo(baseInput({ priorPUp: 0.5, priorWeight: 1 }));
  const bullish = runMonteCarlo(baseInput({ priorPUp: 0.7, priorWeight: 1 }));
  const damped = runMonteCarlo(baseInput({ priorPUp: 0.7, priorWeight: 0.4 }));
  const bearish = runMonteCarlo(baseInput({ priorPUp: 0.3, priorWeight: 1 }));

  assert.ok(bullish.pUp > neutral.pUp + 0.1, 'bullish prior should raise P(UP)');
  assert.ok(bearish.pUp < neutral.pUp - 0.1, 'bearish prior should lower P(UP)');
  assert.ok(
    damped.pUp > neutral.pUp && damped.pUp < bullish.pUp,
    `damped ${damped.pUp} should sit between ${neutral.pUp} and ${bullish.pUp}`
  );
  // With priorWeight = 1 and the full window remaining, the simulation should
  // reproduce the prior itself — that is the definition of the drift solve.
  assert.ok(Math.abs(bullish.pUp - 0.7) < 0.015, `expected ~0.70, got ${bullish.pUp}`);
});

test('a settled window returns a deterministic answer', () => {
  const up = runMonteCarlo(baseInput({ currentPrice: 100_010, remainingSec: 0 }));
  const down = runMonteCarlo(baseInput({ currentPrice: 99_990, remainingSec: 0 }));
  assert.equal(up.pUp, 1);
  assert.equal(down.pUp, 0);
});

test('higher volatility pulls a winning position back toward 50%', () => {
  const calm = runMonteCarlo(
    baseInput({ currentPrice: 100_050, remainingSec: 60, elapsedSec: 240, vol: vol(0.00001) })
  );
  const wild = runMonteCarlo(
    baseInput({ currentPrice: 100_050, remainingSec: 60, elapsedSec: 240, vol: vol(0.00008) })
  );
  assert.ok(calm.pUp > wild.pUp, `calm ${calm.pUp} should exceed wild ${wild.pUp}`);
  assert.ok(wild.pUp > 0.5, 'still in the money, so still above 50%');
});

test('the bootstrap engine tracks the parametric one on Gaussian input', () => {
  // Feed it Gaussian returns; the resampled answer must agree with the
  // parametric one, or the standardisation of the pool is wrong.
  const sampler = new NormalSampler(new Rng(3));
  const sigma10s = 0.00002 * Math.sqrt(10);
  const returns = Array.from({ length: 180 }, () => sampler.next() * sigma10s);

  const shared = { currentPrice: 100_040, elapsedSec: 200, remainingSec: 100, recentReturns: returns };
  const gbm = runMonteCarlo(baseInput({ ...shared, engine: 'gbm' }));
  const boot = runMonteCarlo(baseInput({ ...shared, engine: 'bootstrap' }));
  const blend = runMonteCarlo(baseInput({ ...shared, engine: 'blend' }));

  assert.ok(Math.abs(gbm.pUp - boot.pUp) < 0.03, `gbm ${gbm.pUp} vs bootstrap ${boot.pUp}`);
  assert.ok(
    blend.pUp > Math.min(gbm.pUp, boot.pUp) - 0.02 &&
      blend.pUp < Math.max(gbm.pUp, boot.pUp) + 0.02,
    'blend should sit between its components'
  );
});

test('simulation is reproducible for a given seed and reports a sane error', () => {
  const a = runMonteCarlo(baseInput({ seed: 555 }));
  const b = runMonteCarlo(baseInput({ seed: 555 }));
  assert.equal(a.pUp, b.pUp);
  // Off the money the estimator has genuine spread; at the money antithetic
  // pairing makes it exact, so only the floor is guaranteed there.
  const offMoney = runMonteCarlo(
    baseInput({ seed: 555, currentPrice: 100_030, elapsedSec: 150, remainingSec: 150 })
  );
  assert.ok(offMoney.standardError > 0 && offMoney.standardError < 0.02, `se ${offMoney.standardError}`);
  assert.ok(a.standardError > 0, 'standard error is floored at the discretisation, never zero');
  assert.equal(a.paths, 40_000);
  assert.ok(a.quantiles.q05 < a.quantiles.q50 && a.quantiles.q50 < a.quantiles.q95);
  assert.equal(
    a.histogram.counts.reduce((s, c) => s + c, 0) <= a.paths,
    true
  );
});

// ── Volatility ──────────────────────────────────────────────────────────────

function syntheticBars(sigmaPerSec: number, seed: number, count = 360): Bar[] {
  const sigma10s = sigmaPerSec * Math.sqrt(10);
  const sampler = new NormalSampler(new Rng(seed));
  let price = 100_000;
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    price *= Math.exp(sampler.next() * sigma10s);
    bars.push({ t: i * 10_000, o: price, h: price, l: price, c: price, v: 0 });
  }
  return bars;
}

test('volatility estimator is unbiased for a known sigma', () => {
  // A single EWMA estimate has ~12% sampling error by construction, so the
  // property worth asserting is the absence of bias across draws, not the
  // accuracy of any one of them.
  const sigmaPerSec = 0.00003;
  const estimates: number[] = [];
  for (let seed = 1; seed <= 12; seed++) {
    const est = estimateVolatility(syntheticBars(sigmaPerSec, seed), 0.97);
    estimates.push(est.sigmaPerSec);
    const err = Math.abs(est.sigmaPerSec - sigmaPerSec) / sigmaPerSec;
    assert.ok(err < 0.35, `seed ${seed}: ${est.sigmaPerSec} vs ${sigmaPerSec} (${(err * 100).toFixed(1)}%)`);
  }
  const mean = estimates.reduce((a, b) => a + b, 0) / estimates.length;
  const bias = Math.abs(mean - sigmaPerSec) / sigmaPerSec;
  assert.ok(bias < 0.08, `mean estimate ${mean} is ${(bias * 100).toFixed(1)}% off the true sigma`);
});

test('volatility estimator reports its inputs and tracks a regime shift', () => {
  const est = estimateVolatility(syntheticBars(0.00003, 11), 0.97);
  assert.equal(est.samples, 359);
  assert.equal(est.windows.length, 3);

  // Splice a calm hour onto a violent five minutes: the estimate must move
  // decisively toward the recent regime, not average the whole hour.
  const calm = syntheticBars(0.00001, 5, 330);
  const violent = syntheticBars(0.00012, 6, 30).map((b, i) => ({
    ...b,
    t: calm[calm.length - 1].t + (i + 1) * 10_000,
  }));
  const shifted = estimateVolatility([...calm, ...violent], 0.97);
  const calmOnly = estimateVolatility(calm, 0.97);
  assert.ok(
    shifted.sigmaPerSec > calmOnly.sigmaPerSec * 3,
    `regime shift not picked up: ${shifted.sigmaPerSec} vs ${calmOnly.sigmaPerSec}`
  );
});

test('volatility estimator falls back rather than returning zero', () => {
  const est = estimateVolatility([], 0.97);
  assert.ok(est.sigmaPerSec > 0);
  assert.ok(est.annualisedPct > 10 && est.annualisedPct < 200);
});

// ── Aggregation ─────────────────────────────────────────────────────────────

test('ticks fold into aligned 10-second OHLC bars', () => {
  const t0 = 1_700_000_000_000;
  const base = Math.floor(t0 / 10_000) * 10_000;
  const bars = ticksToBars([
    { t: base + 1000, p: 100 },
    { t: base + 4000, p: 105 },
    { t: base + 9000, p: 98 },
    { t: base + 11_000, p: 101 },
  ]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].o, 100);
  assert.equal(bars[0].h, 105);
  assert.equal(bars[0].l, 98);
  assert.equal(bars[0].c, 98);
  assert.equal(bars[1].t - bars[0].t, 10_000);
});

test('gap filling produces an evenly spaced series', () => {
  const filled = fillBarGaps([
    { t: 0, o: 1, h: 1, l: 1, c: 1, v: 0 },
    { t: 40_000, o: 2, h: 2, l: 2, c: 2, v: 0 },
  ]);
  assert.equal(filled.length, 5);
  for (let i = 1; i < filled.length; i++) {
    assert.equal(filled[i].t - filled[i - 1].t, 10_000);
  }
  assert.equal(filled[1].c, 1, 'synthetic bars carry the previous close');
});

test('upsampling 60s candles yields six 10s bars each', () => {
  const out = upsampleToTenSeconds(
    [
      { t: 0, o: 100, h: 100, l: 100, c: 100, v: 6 },
      { t: 60_000, o: 106, h: 106, l: 106, c: 106, v: 6 },
    ],
    60
  );
  assert.equal(out.length, 12);
  assert.equal(out[0].c, 100, 'observed closes pass through untouched');
  assert.ok(out[3].c > 100 && out[3].c < 106, 'interpolated between closes');
});

// ── Order book / fills ──────────────────────────────────────────────────────

const book: OrderBook = {
  tokenId: 'x',
  bids: [
    { price: 0.48, size: 100 },
    { price: 0.47, size: 250 },
  ],
  asks: [
    { price: 0.52, size: 40 },
    { price: 0.53, size: 120 },
    { price: 0.56, size: 500 },
  ],
  t: Date.now(),
};

test('quote reports touch, spread and depth within 2 cents', () => {
  const q = quoteFromBook(book);
  assert.equal(q.bid, 0.48);
  assert.equal(q.ask, 0.52);
  assert.ok(Math.abs((q.spread ?? 0) - 0.04) < 1e-9);
  assert.equal(q.mid, 0.5);
  // 0.52*40 + 0.53*120 within 2c of the touch; 0.56 is outside.
  assert.ok(Math.abs(q.askDepthUsd - (0.52 * 40 + 0.53 * 120)) < 1e-9);
});

test('paper fills walk the book and report partials honestly', () => {
  const fill = simulateBuy(book, 100, { tickSize: 0.001, latencyTicks: 1 });
  assert.equal(fill.filledSize, 100);
  // 40 @ 0.521 then 60 @ 0.531, including the one-tick latency haircut.
  const expected = (40 * 0.521 + 60 * 0.531) / 100;
  assert.ok(Math.abs(fill.avgPrice - expected) < 1e-9, `avg ${fill.avgPrice} vs ${expected}`);
  assert.ok(fill.slippage > 0, 'crossing multiple levels must cost something');

  const huge = simulateBuy(book, 10_000, { tickSize: 0.001 });
  assert.equal(huge.filledSize, 660, 'cannot fill beyond resting depth');

  const none = simulateBuy({ ...book, asks: [] }, 10);
  assert.equal(none.filledSize, 0);
});

test('a fill never pays above the configured maximum price', () => {
  const fill = simulateBuy(book, 600, { tickSize: 0.001, maxPrice: 0.54 });
  assert.ok(fill.avgPrice <= 0.54);
  assert.ok(fill.filledSize < 600, 'levels above the cap are skipped');
});

// ── Risk helpers ────────────────────────────────────────────────────────────

test('shrinkProbability pulls toward 0.5 and is monotone', () => {
  assert.equal(shrinkProbability(0.5, 0.2), 0.5);
  assert.ok(Math.abs(shrinkProbability(0.8, 0.5) - 0.65) < 1e-9);
  assert.ok(Math.abs(shrinkProbability(0.2, 0.5) - 0.35) < 1e-9);
  assert.equal(shrinkProbability(0.9, 0), 0.9);
  assert.ok(shrinkProbability(0.7, 0.3) < 0.7);
});

// ── Metrics ─────────────────────────────────────────────────────────────────

function trade(over: Partial<Trade>): Trade {
  return {
    id: Math.random().toString(36),
    mode: 'PAPER',
    marketId: 'm',
    marketSlug: 's',
    tokenId: 't',
    side: 'UP',
    t: Date.now(),
    entryPrice: 0.5,
    size: 100,
    notional: 50,
    modelP: 0.6,
    llmP: 0.6,
    marketP: 0.5,
    edge: 0.1,
    status: 'WON',
    pnl: 50,
    btcStart: 100_000,
    btcEntry: 100_000,
    btcSettle: 100_100,
    resolvedAt: Date.now(),
    outcome: 'UP',
    secondsLeftAtEntry: 120,
    orderId: null,
    fill: {
      simulated: true,
      requestedSize: 100,
      filledSize: 100,
      avgPrice: 0.5,
      slippage: 0,
      levels: [],
      latencyMs: 5,
    },
    ...over,
  };
}

test('metrics compute P&L, win rate and Brier correctly', () => {
  const trades = [
    trade({ status: 'WON', pnl: 50, modelP: 0.6 }),
    trade({ status: 'LOST', pnl: -50, modelP: 0.6 }),
    trade({ status: 'WON', pnl: 50, modelP: 0.8 }),
  ];
  const m = computeMetrics(trades);
  assert.equal(m.resolved, 3);
  assert.equal(m.wins, 2);
  assert.equal(m.losses, 1);
  assert.ok(Math.abs(m.winRate - 2 / 3) < 1e-9);
  assert.equal(m.pnl, 50);
  assert.equal(m.turnover, 150);

  // Brier = mean((p - y)^2) = (0.16 + 0.36 + 0.04)/3
  const expectedBrier = (0.4 ** 2 + 0.6 ** 2 + 0.2 ** 2) / 3;
  assert.ok(Math.abs(m.brier - expectedBrier) < 1e-9, `brier ${m.brier}`);
  assert.ok(m.brierSkill > 0, 'better than a coin flip on this sample');
  assert.ok(m.maxDrawdown >= 50, `drawdown ${m.maxDrawdown}`);
});

test('metrics ignore unresolved trades in scoring', () => {
  const m = computeMetrics([trade({ status: 'OPEN', pnl: null })]);
  assert.equal(m.resolved, 0);
  assert.equal(m.pnl, 0);
  assert.equal(m.trades, 1);
});

// ── LLM parsing ─────────────────────────────────────────────────────────────

test('forecast parser handles clean JSON, fences, prose and percentages', () => {
  const clean = parseForecast(
    '{"p_up":0.62,"confidence":0.4,"expected_move_usd":40,"regime":"choppy","key_factors":["a"],"rationale":"r"}'
  );
  assert.ok(clean);
  assert.equal(clean.pUp, 0.62);
  assert.equal(clean.regime, 'choppy');

  const fenced = parseForecast('Here you go:\n```json\n{"p_up": 0.4, "confidence": 0.9}\n```\nHope that helps.');
  assert.ok(fenced);
  assert.equal(fenced.pUp, 0.4);

  const percent = parseForecast('{"p_up": 62, "confidence": 40}');
  assert.ok(percent);
  assert.ok(Math.abs(percent.pUp - 0.62) < 1e-9, 'percentages are normalised');

  const prose = parseForecast('After weighing the tape, p_up is about 0.55 in my view.');
  assert.ok(prose);
  assert.ok(Math.abs(prose.pUp - 0.55) < 1e-9);

  const nested = parseForecast('{"meta":{"x":1},"p_up":0.33,"regime":"trending_down"}');
  assert.ok(nested);
  assert.equal(nested.pUp, 0.33);
  assert.equal(nested.regime, 'trending-down');

  assert.equal(parseForecast('I cannot help with that.'), null);
});

test('forecast parser rejects malformed probabilities rather than guessing', () => {
  // 1.4 is neither a probability nor a plausible percentage. Coercing it — to
  // 0.014 or to certainty — would fabricate a forecast that sizes real orders.
  assert.equal(parseForecast('{"p_up": 1.4}'), null);
  assert.equal(parseForecast('{"p_up": -0.2}'), null);
  assert.equal(parseForecast('{"p_up": 150}'), null);

  // Unambiguous percentages are still accepted.
  const pctForm = parseForecast('{"p_up": 62}');
  assert.ok(pctForm);
  assert.ok(Math.abs(pctForm.pUp - 0.62) < 1e-9);

  // The boundaries stay valid probabilities.
  assert.equal(parseForecast('{"p_up": 1}')?.pUp, 1);
  assert.equal(parseForecast('{"p_up": 0}')?.pUp, 0);
});
