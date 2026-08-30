import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { simulate } from '../montecarlo';
import { normCdf, normInv } from '../math/normal';
import { NormalSampler, Rng } from '../math/rng';
import { fillGaps, returns, shiftBars, shiftTicks, toBars, twap, volatility } from '../bars';
import { fill, quote } from '../book';
import { discover } from '../market';
import { DEFAULT_CONFIG, sanitize } from '../config';
import type { Bar } from '../types';

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

// ── The only model: a driftless Monte Carlo ─────────────────────────────────

const SIGMA = 0.00002; // roughly 35% annualised

function sim(over: Partial<Parameters<typeof simulate>[0]> = {}) {
  return simulate({
    barrier: 100_000,
    current: 100_000,
    remainingSec: 300,
    sigma: SIGMA,
    paths: 40_000,
    seed: 7,
    ...over,
  });
}

test('at the barrier, with nothing else known, the answer is a coin flip', () => {
  assert.ok(Math.abs(sim().pUp - 0.5) < 0.01);
});

test('there is no drift term — an identical run has nothing to disagree with', () => {
  // The whole point of removing the forecasting step: the simulation takes no
  // view of its own. Two runs with the same inputs and the same seed must be
  // identical, and a run started exactly at the barrier has no reason to lean
  // either way regardless of how many times it is re-seeded.
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = sim({ seed });
    assert.ok(Math.abs(r.pUp - 0.5) < 0.02, `seed ${seed}: expected ~0.5, got ${r.pUp}`);
  }
});

test('being above the barrier means P(UP) is above a half, and vice versa', () => {
  // A move small relative to sigma*sqrt(t), so both cases land meaningfully
  // between 0 and 1 rather than saturating at the extremes.
  const above = sim({ current: 100_010, remainingSec: 120 });
  const below = sim({ current: 99_990, remainingSec: 120 });
  assert.ok(above.pUp > 0.5, `expected > 0.5, got ${above.pUp}`);
  assert.ok(below.pUp < 0.5, `expected < 0.5, got ${below.pUp}`);
  assert.ok(
    Math.abs(above.pUp - (1 - below.pUp)) < 0.02,
    `expected roughly symmetric cases, got ${above.pUp} vs ${1 - below.pUp}`
  );
});

test('the same distance from the barrier matters less with less time left', () => {
  // A given gap is easier to hold onto (or harder to close) the less time
  // there is left for volatility to erase it.
  const early = sim({ current: 100_100, remainingSec: 280 });
  const late = sim({ current: 100_100, remainingSec: 20 });
  assert.ok(late.pUp > early.pUp, `expected less time to raise confidence: ${late.pUp} vs ${early.pUp}`);
});

test('more volatility pulls a winning position back toward even', () => {
  const calm = sim({ current: 100_050, remainingSec: 60, sigma: SIGMA / 2 });
  const wild = sim({ current: 100_050, remainingSec: 60, sigma: SIGMA * 4 });
  assert.ok(calm.pUp > wild.pUp);
  assert.ok(wild.pUp > 0.5, 'still in the money, so still better than even');
});

test('a finished window is decided, not simulated', () => {
  assert.equal(sim({ current: 100_010, remainingSec: 0 }).pUp, 1);
  assert.equal(sim({ current: 99_990, remainingSec: 0 }).pUp, 0);
});

test('the same seed replays exactly', () => {
  assert.equal(sim({ seed: 99 }).pUp, sim({ seed: 99 }).pUp);
});

// ── Bars and volatility ─────────────────────────────────────────────────────

test('ticks fold into aligned 15-second closes', () => {
  const base = 1_800_000_000_000;
  const bars = toBars([
    { t: base + 1000, p: 100 },
    { t: base + 14_000, p: 98 },
    { t: base + 16_000, p: 101 },
  ]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].c, 98, 'the last tick in the bucket is the close');
  assert.equal(bars[1].t - bars[0].t, 15_000);
});

test('gaps are filled flat so the series stays evenly spaced', () => {
  const filled = fillGaps([
    { t: 0, c: 1 },
    { t: 60_000, c: 2 }, // a 4-bar gap at the 15s bar size
  ]);
  assert.equal(filled.length, 5);
  assert.equal(filled[1].c, 1, 'a gap contributes no return');
  assert.equal(returns(filled).filter((r) => r !== 0).length, 1);
});

test('volatility recovers a known sigma from a plain average of the last 10 returns', () => {
  const s = new NormalSampler(new Rng(4));
  const sigma15s = SIGMA * Math.sqrt(15);
  let p = 100_000;
  const bars: Bar[] = [];
  for (let i = 0; i < 40; i++) {
    p *= Math.exp(s.next() * sigma15s);
    bars.push({ t: i * 15_000, c: p });
  }
  const est = volatility(bars);
  assert.ok(Math.abs(est.sigma - SIGMA) / SIGMA < 0.5, `got ${est.sigma} vs ${SIGMA}`);
  assert.equal(est.samples, 10, 'only the last 10 returns are used');

  const empty = volatility([]);
  assert.ok(empty.sigma > 0, 'never zero — that would make every edge look infinite');
});

test('a couple of minutes of real 15-second bars clears the fallback', () => {
  // 11 bars gives 10 returns — the full window volatility() looks at.
  const bars: Bar[] = Array.from({ length: 11 }, (_, i) => ({ t: i * 15_000, c: 100_000 + i * 3 }));
  const est = volatility(bars);
  assert.ok(est.sigma > 0);
  // A steadily rising series with no noise has a real, tiny, non-fallback sigma.
  assert.ok(est.volPct < 45, `expected a real estimate below the 45% fallback, got ${est.volPct}`);
});

test('the TWAP is a flat average of an unmoving tape, and ignores what fell outside the window', () => {
  const now = 1_800_000_000_000;
  const ticks = [
    { t: now - 90_000, p: 999 }, // outside the 60s window — must not count
    { t: now - 60_000, p: 100 },
    { t: now - 30_000, p: 100 },
    { t: now, p: 100 },
  ];
  assert.equal(twap(ticks, 60_000, now), 100);
  assert.equal(twap([], 60_000, now), null);
});

// ── Chainlink anchor offset ─────────────────────────────────────────────────

test('shifting re-levels every close by the same amount', () => {
  const bars: Bar[] = [
    { t: 0, c: 100_000 },
    { t: 10_000, c: 100_050 },
    { t: 20_000, c: 99_980 },
  ];
  const shifted = shiftBars(bars, 25);
  assert.deepEqual(
    shifted.map((b) => b.c),
    [100_025, 100_075, 100_005]
  );
  // Shape is preserved — only the level moves.
  assert.equal(shifted[1].c - shifted[0].c, bars[1].c - bars[0].c);
  assert.equal(shifted[0].t, bars[0].t, 'timestamps are untouched');
});

test('a zero delta returns the same array rather than a needless copy', () => {
  const bars: Bar[] = [{ t: 0, c: 100_000 }];
  assert.equal(shiftBars(bars, 0), bars);
  const ticks = [{ t: 0, p: 100_000 }];
  assert.equal(shiftTicks(ticks, 0), ticks);
});

test('shifting ticks matches shifting bars', () => {
  const ticks = [
    { t: 0, p: 99_900 },
    { t: 1000, p: 99_950 },
  ];
  const shifted = shiftTicks(ticks, -40);
  assert.deepEqual(shifted.map((t) => t.p), [99_860, 99_910]);
});

// ── Book ────────────────────────────────────────────────────────────────────

const book = {
  tokenId: 'x',
  bids: [{ price: 0.48, size: 100 }],
  asks: [
    { price: 0.52, size: 40 },
    { price: 0.55, size: 200 },
  ],
  t: Date.now(),
};

test('the quote is the touch', () => {
  const q = quote(book);
  assert.equal(q.ask, 0.52);
  assert.equal(q.bid, 0.48);
  assert.equal(q.askSize, 40);
  assert.equal(quote(null).ask, null);
});

test('a paper fill walks real depth and reports shortfalls honestly', () => {
  const f = fill(book, 100, 0.001);
  assert.equal(f.shares, 100);
  // 40 at 0.521, 60 at 0.551 — a tick worse than shown, for the queue race.
  assert.ok(Math.abs(f.price - (40 * 0.521 + 60 * 0.551) / 100) < 1e-9);
  assert.ok(f.price > 0.52, 'crossing two levels must cost more than the touch');

  assert.equal(fill(book, 10_000, 0.001).shares, 240, 'cannot fill beyond the book');
  assert.equal(fill({ ...book, asks: [] }, 10).shares, 0);
});

// ── Market discovery ────────────────────────────────────────────────────────

/**
 * A stand-in for Gamma's /markets?slug=... endpoint. Polymarket's BTC 5-minute
 * markets sit on a fixed grid — each opens on a UTC timestamp divisible by 300
 * and is slugged `btc-updown-5m-<window-start-seconds>` — so the current and
 * next window can be computed from the clock. This is the fix for a real bug:
 * the previous approach searched a listing by question text, which Polymarket
 * also uses for BTC "Up or Down" series at other durations (hourly, daily),
 * and documented `active=true` filtering that can drop these recurring
 * markets from that listing entirely — either way, a wrong or missing market,
 * not a clean failure.
 */
function gammaRow(startSec: number) {
  return {
    id: `mkt-${startSec}`,
    slug: `btc-updown-5m-${startSec}`,
    question: 'Bitcoin Up or Down',
    outcomes: '["Up","Down"]',
    clobTokenIds: `["up-${startSec}","down-${startSec}"]`,
    closed: false,
    acceptingOrders: true,
  };
}

async function withGamma(
  known: Set<number>,
  run: (url: string, requested: string[]) => Promise<void>
) {
  const requested: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const slug = url.searchParams.get('slug') ?? '';
    requested.push(slug);
    const m = slug.match(/^btc-updown-5m-(\d+)$/);
    const startSec = m ? Number(m[1]) : NaN;
    const body = known.has(startSec) ? [gammaRow(startSec)] : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, requested);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('discovery requests the grid-aligned slug for "now", not a search', async () => {
  // 2024-01-01T00:07:43Z — 463s past midnight, not on a 5-minute boundary.
  const now = Date.UTC(2024, 0, 1, 0, 7, 43);
  const windowStart = Math.floor(now / 1000 / 300) * 300; // must floor to :05:00
  await withGamma(new Set([windowStart, windowStart + 300]), async (url, requested) => {
    const d = await discover(url, now);
    assert.ok(requested.includes(`btc-updown-5m-${windowStart}`));
    assert.ok(requested.includes(`btc-updown-5m-${windowStart + 300}`));
    assert.equal(d.live?.slug, `btc-updown-5m-${windowStart}`);
    assert.equal(d.live?.startMs, windowStart * 1000);
    assert.equal(d.live?.endMs, (windowStart + 300) * 1000);
    assert.equal(d.next?.slug, `btc-updown-5m-${windowStart + 300}`);
  });
});

test('discovery trusts the slug for window boundaries, not the row', async () => {
  // Even if Gamma's own date fields were missing or wrong, the slug is the
  // one thing that cannot lie about which five minutes this market covers.
  const now = Date.UTC(2024, 0, 1, 12, 0, 0);
  const windowStart = Math.floor(now / 1000 / 300) * 300;
  await withGamma(new Set([windowStart]), async (url) => {
    const d = await discover(url, now);
    assert.equal(d.live?.startMs, windowStart * 1000);
    assert.equal(d.live?.endMs, windowStart * 1000 + 300_000);
  });
});

test('a market outside its own window is reported in the right slot', async () => {
  const now = Date.UTC(2024, 0, 1, 12, 0, 0);
  const windowStart = Math.floor(now / 1000 / 300) * 300;
  // Only the *next* window exists yet — the current one has not been created.
  await withGamma(new Set([windowStart + 300]), async (url) => {
    const d = await discover(url, now);
    assert.equal(d.live, null);
    assert.equal(d.next?.startMs, (windowStart + 300) * 1000);
  });
});

test('falls back to a listing search when the grid produces nothing', async () => {
  const now = Date.UTC(2024, 0, 1, 12, 0, 0);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    if (url.searchParams.has('slug')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
      return;
    }
    // The listing fallback: one row shaped like a real 5-minute market.
    const start = new Date(now);
    const end = new Date(now + 300_000);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify([
        {
          id: 'fallback-1',
          slug: 'bitcoin-up-or-down-fallback',
          question: 'Bitcoin Up or Down',
          startDate: start.toISOString(),
          endDate: end.toISOString(),
          outcomes: '["Up","Down"]',
          clobTokenIds: '["u1","d1"]',
          closed: false,
        },
      ])
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const d = await discover(`http://127.0.0.1:${port}`, now);
    assert.equal(d.live?.id, 'fallback-1');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// ── Config ──────────────────────────────────────────────────────────────────

test('config is clamped on write', () => {
  const c = sanitize({ minEdge: 5, stakeUsd: -10, paths: 10_000_000 });
  assert.ok(c.minEdge <= 0.5);
  assert.ok(c.stakeUsd >= 1);
  assert.ok(c.paths <= 50_000);
  assert.equal(sanitize({ mode: 'HACK' }).mode, DEFAULT_CONFIG.mode);
  assert.equal(sanitize({ autoTrade: 'yes' }).autoTrade, DEFAULT_CONFIG.autoTrade);
});

test('the defaults let a trade happen at all', () => {
  const c = DEFAULT_CONFIG;
  assert.ok(c.minEdge > 0 && c.minEdge < 0.5);
  assert.ok(c.minSecondsLeft < 300, 'must leave room inside the window to enter');
  assert.ok(c.stakeUsd > 0);
});
