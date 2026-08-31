import { strict as assert } from 'node:assert';
import test from 'node:test';
import { bandFromDistribution, simulateCycle, tailProbability } from '../montecarlo';
import { normCdf, normInv } from '../math/normal';
import { NormalSampler, Rng } from '../math/rng';
import { toSeconds, volatility } from '../series';
import { fillQty, fillUsd, quote } from '../binanceBook';
import { DEFAULT_CONFIG, sanitize } from '../config';
import type { Tick } from '../types';

// ── Maths ───────────────────────────────────────────────────────────────────

test('normal CDF and its inverse agree', () => {
  for (const p of [0.02, 0.1, 0.5, 0.9, 0.98]) {
    assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6, `p=${p}`);
  }
});

test('the sampler produces unit-variance draws', () => {
  const s = new NormalSampler(new Rng(1));
  let sum = 0;
  let sq = 0;
  const n = 100_000;
  for (let i = 0; i < n; i++) {
    const z = s.next();
    sum += z;
    sq += z * z;
  }
  assert.ok(Math.abs(sum / n) < 0.02);
  assert.ok(Math.abs(sq / n - 1) < 0.03);
});

// ── The only model: a driftless Monte Carlo over the full cycle path ───────

const SIGMA = 0.0003; // per-second, roughly 30% annualised
const START = 100_000;

test('the tail probability matches the analytic lognormal tail', () => {
  // For a driftless GBM the one-sided tail probability at step s has a closed
  // form: 1 - Phi(logReturn / (sigma*sqrt(s))) above, Phi(...) below. The
  // literal Monte Carlo simulation should agree with it, within sampling noise.
  const dist = simulateCycle({ startPrice: START, sigma: SIGMA, cycleSec: 20, paths: 100_000, seed: 7 });

  for (const [sec, price] of [
    [10, START * 1.002],
    [10, START * 0.998],
    [20, START * 1.004],
  ] as const) {
    const got = tailProbability(dist, sec, START, price);
    const z = Math.log(price / START) / (SIGMA * Math.sqrt(sec));
    const analytic = price >= START ? 1 - normCdf(z) : normCdf(z);
    assert.ok(Math.abs(got - analytic) < 0.02, `sec=${sec} price=${price}: got ${got}, analytic ${analytic}`);
  }
});

test('at the start price, the tail probability is about a half either way', () => {
  const dist = simulateCycle({ startPrice: START, sigma: SIGMA, cycleSec: 20, paths: 50_000, seed: 3 });
  assert.ok(Math.abs(tailProbability(dist, 10, START, START) - 0.5) < 0.02);
});

test('the tail probability falls as the move gets more extreme', () => {
  const dist = simulateCycle({ startPrice: START, sigma: SIGMA, cycleSec: 20, paths: 50_000, seed: 5 });
  const near = tailProbability(dist, 15, START, START * 1.001);
  const far = tailProbability(dist, 15, START, START * 1.01);
  assert.ok(far < near, `expected a bigger move to be less likely: ${far} vs ${near}`);
});

test('the band brackets the start price and covers every second of the cycle', () => {
  const dist = simulateCycle({ startPrice: START, sigma: SIGMA, cycleSec: 20, paths: 20_000, seed: 9 });
  const band = bandFromDistribution(dist, 0.1);
  assert.equal(band.length, 20);
  for (const b of band) {
    assert.ok(b.lo < START && START < b.hi, `second ${b.sec}: expected start price inside [${b.lo}, ${b.hi}]`);
  }
  // The band should widen over time — more seconds means more room to roam.
  assert.ok(band[19].hi - band[19].lo > band[0].hi - band[0].lo);
});

test('the same seed replays exactly', () => {
  const a = simulateCycle({ startPrice: START, sigma: SIGMA, cycleSec: 20, paths: 1000, seed: 99 });
  const b = simulateCycle({ startPrice: START, sigma: SIGMA, cycleSec: 20, paths: 1000, seed: 99 });
  assert.deepEqual(Array.from(a.stepPrices[19]), Array.from(b.stepPrices[19]));
});

// ── One-second series and realised volatility ───────────────────────────────

test('ticks fold into one price point per whole second, last tick wins', () => {
  const base = 1_800_000_000_000;
  const points = toSeconds([
    { t: base + 100, p: 100 },
    { t: base + 900, p: 101 },
    { t: base + 1_400, p: 102 },
  ]);
  assert.equal(points.length, 2);
  assert.equal(points[0].p, 101, 'the last tick within the second is the sample');
  assert.equal(points[1].t - points[0].t, 1000);
});

test('volatility recovers a known per-second sigma', () => {
  const s = new NormalSampler(new Rng(4));
  let p = 100_000;
  const points: Tick[] = [];
  for (let i = 0; i < 61; i++) {
    p *= Math.exp(s.next() * SIGMA);
    points.push({ t: i * 1000, p });
  }
  const est = volatility(points.slice(-60));
  assert.ok(Math.abs(est.sigma - SIGMA) / SIGMA < 0.4, `got ${est.sigma} vs ${SIGMA}`);
  assert.equal(est.samples, 59);
});

test('with no real tape, volatility falls back to a plausible generic number, never zero', () => {
  const empty = volatility([]);
  assert.ok(empty.sigma > 0);
  assert.equal(empty.volPct, 45);
});

// ── Binance order book ──────────────────────────────────────────────────────

const book = {
  bids: [{ price: 99_950, size: 0.5 }],
  asks: [
    { price: 100_050, size: 0.1 },
    { price: 100_100, size: 1 },
  ],
  t: Date.now(),
};

test('the quote is the touch', () => {
  const q = quote(book);
  assert.equal(q.ask, 100_050);
  assert.equal(q.bid, 99_950);
  assert.equal(quote(null).ask, null);
});

test('opening walks the asks by USD budget and reports the average fill price', () => {
  const usd = 100_050 * 0.1 + 100_100 * 0.05; // exhausts the first level, part of the second
  const f = fillUsd(book, 'BUY', usd);
  assert.ok(Math.abs(f.qty - 0.15) < 1e-9);
  assert.ok(f.price > 100_050, 'crossing two levels must cost more than the touch');
  assert.equal(fillUsd(null, 'BUY', 10).qty, 0);
});

test('closing walks the book by exact quantity, buy side for a short, sell side for a long', () => {
  const exit = fillQty(book, 'SELL', 0.5);
  assert.ok(Math.abs(exit.qty - 0.5) < 1e-9);
  assert.equal(exit.price, 99_950, 'only one bid level, so the whole size fills there');

  // Cannot close more than the book has.
  const short = fillQty({ ...book, bids: [] }, 'SELL', 1);
  assert.equal(short.qty, 0);
});

test('a filled quantity is rounded down to a real lot size, never up', () => {
  // 0.15 BTC does not land on a 0.02 step — a live order could only ever get 0.14.
  const usd = 100_050 * 0.1 + 100_100 * 0.05;
  const f = fillUsd(book, 'BUY', usd, 0.02);
  assert.ok(Math.abs(f.qty - 0.14) < 1e-9, `got ${f.qty}`);

  // Rounding to below one full step reports no fill, not a fake sliver.
  assert.equal(fillQty(book, 'SELL', 0.004, 0.01).qty, 0);
});

// ── Config ──────────────────────────────────────────────────────────────────

test('config is clamped on write', () => {
  const c = sanitize({ closeAtSecond: 100, stakeUsd: -10, unlikeliness: 2 });
  assert.ok(c.closeAtSecond <= 19);
  assert.ok(c.stakeUsd >= 1);
  assert.ok(c.unlikeliness <= 0.4);
  assert.equal(sanitize({ autoTrade: 'yes' }).autoTrade, DEFAULT_CONFIG.autoTrade);
});

test('the defaults leave room to enter and close within one cycle', () => {
  const c = DEFAULT_CONFIG;
  assert.ok(c.closeAtSecond > 0 && c.closeAtSecond < 20);
  assert.ok(c.unlikeliness > 0 && c.unlikeliness < 1);
  assert.ok(c.stakeUsd > 0);
});
