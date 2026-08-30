import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { simulate } from '../montecarlo';
import { normCdf, normInv } from '../math/normal';
import { NormalSampler, Rng } from '../math/rng';
import { fillGaps, returns, shiftBars, shiftTicks, toBars, volatility } from '../bars';
import { fill, quote } from '../book';
import { parse, forecast, buildPrompt } from '../llm';
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

// ── The updater ─────────────────────────────────────────────────────────────

const SIGMA = 0.00002; // roughly 35% annualised

function sim(over: Partial<Parameters<typeof simulate>[0]> = {}) {
  return simulate({
    barrier: 100_000,
    current: 100_000,
    remainingSec: 300,
    llmPUp: 0.5,
    llmWeight: 1,
    sigma: SIGMA,
    paths: 40_000,
    seed: 7,
    ...over,
  });
}

test('at the barrier with no view, the answer is a coin flip', () => {
  assert.ok(Math.abs(sim().pUp - 0.5) < 0.01);
});

test('the model probability is reproduced when the full window remains', () => {
  // This is the definition of the drift solve: with the whole window left and
  // full weight, the simulation should return the prior it was given.
  for (const p of [0.6, 0.7, 0.4]) {
    const r = sim({ llmPUp: p });
    assert.ok(Math.abs(r.pUp - p) < 0.02, `expected ~${p}, got ${r.pUp.toFixed(3)}`);
  }
});

test('a move against the call overrules it', () => {
  // "UP at 75%", but BTC is $150 down with 30 seconds left. The recovery needed
  // is not plausible at this volatility, so the answer must collapse.
  const r = sim({ current: 99_850, remainingSec: 30, llmPUp: 0.75 });
  assert.ok(r.pUp < 0.05, `expected a low probability, got ${r.pUp}`);
});

test('a move with the call reinforces it', () => {
  const r = sim({ current: 100_120, remainingSec: 60, llmPUp: 0.6 });
  assert.ok(r.pUp > 0.9, `expected a high probability, got ${r.pUp}`);
});

test('the neutral control ignores the model but shares its randomness', () => {
  const r = sim({ llmPUp: 0.8 });
  assert.ok(r.pUp > 0.7, 'the primed run should follow the prior');
  assert.ok(Math.abs(r.pUpNeutral - 0.5) < 0.02, 'the control should not');

  // With no view, the two must agree — same shocks, same drift of zero.
  const flat = sim({ llmPUp: 0.5 });
  assert.ok(Math.abs(flat.pUp - flat.pUpNeutral) < 0.005);
});

test('the model weight scales its influence', () => {
  const full = sim({ llmPUp: 0.7, llmWeight: 1 });
  const half = sim({ llmPUp: 0.7, llmWeight: 0.5 });
  const none = sim({ llmPUp: 0.7, llmWeight: 0 });
  assert.ok(full.pUp > half.pUp && half.pUp > none.pUp);
  assert.ok(Math.abs(none.pUp - 0.5) < 0.02, 'zero weight means the call is ignored');
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

test('ticks fold into aligned 10-second closes', () => {
  const base = 1_800_000_000_000;
  const bars = toBars([
    { t: base + 1000, p: 100 },
    { t: base + 9000, p: 98 },
    { t: base + 11_000, p: 101 },
  ]);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].c, 98, 'the last tick in the bucket is the close');
  assert.equal(bars[1].t - bars[0].t, 10_000);
});

test('gaps are filled flat so the series stays evenly spaced', () => {
  const filled = fillGaps([
    { t: 0, c: 1 },
    { t: 40_000, c: 2 },
  ]);
  assert.equal(filled.length, 5);
  assert.equal(filled[1].c, 1, 'a gap contributes no return');
  assert.equal(returns(filled).filter((r) => r !== 0).length, 1);
});

test('volatility recovers a known sigma and is not fooled by a flat series', () => {
  const s = new NormalSampler(new Rng(4));
  const sigma10s = SIGMA * Math.sqrt(10);
  let p = 100_000;
  const bars: Bar[] = [];
  for (let i = 0; i < 300; i++) {
    p *= Math.exp(s.next() * sigma10s);
    bars.push({ t: i * 10_000, c: p });
  }
  const est = volatility(bars);
  assert.ok(Math.abs(est.sigma - SIGMA) / SIGMA < 0.3, `got ${est.sigma} vs ${SIGMA}`);

  const empty = volatility([]);
  assert.ok(empty.sigma > 0, 'never zero — that would make every edge look infinite');
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

// ── Forecast parsing ────────────────────────────────────────────────────────

test('the forecast reply is parsed in the shapes models actually emit', () => {
  const clean = parse('{"direction":"UP","probability":62}');
  assert.deepEqual(clean, { side: 'UP', probability: 0.62, pUp: 0.62 });

  const down = parse('{"direction":"DOWN","probability":58}');
  assert.equal(down?.side, 'DOWN');
  assert.ok(Math.abs(down!.pUp - 0.42) < 1e-9, 'pUp is the complement for a DOWN call');

  assert.equal(parse('```json\n{"direction":"up","probability":0.55}\n```')?.side, 'UP');
  assert.equal(parse('Here you go: {"direction":"lower","probability":70}')?.side, 'DOWN');
  assert.equal(parse('{"direction":"UP","probability":99}')?.probability, 0.95, 'swagger is capped');
});

test('a malformed reply is rejected rather than guessed at', () => {
  // These numbers size real orders; coercing nonsense would fabricate a call.
  assert.equal(parse('{"direction":"UP","probability":30}'), null, 'below 50 contradicts the direction');
  assert.equal(parse('{"direction":"MAYBE","probability":60}'), null);
  assert.equal(parse('{"probability":60}'), null, 'no direction, no trade');
  assert.equal(parse('I cannot help with that.'), null);
});

test('the prompt carries the tape and the current price', () => {
  const bars: Bar[] = Array.from({ length: 200 }, (_, i) => ({ t: i * 10_000, c: 100_000 + i }));
  const p = buildPrompt(bars, 100_250);
  assert.ok(p.includes('100250.00'), 'the current price must be stated');
  const series = p.split('\n').find((l) => /^[\d.,]+$/.test(l));
  assert.equal(series?.split(',').length, 180, '30 minutes of 10-second closes');
});

// ── The forecast call, against a stand-in server ────────────────────────────

async function withServer(
  handler: (body: Record<string, unknown>, n: number) => { status: number; json: unknown; delayMs?: number },
  run: (url: string, seen: Record<string, unknown>[]) => Promise<void>
) {
  const seen: Record<string, unknown>[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      const r = handler(body, n++);
      const send = () => {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, seen);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const REPLY = (content: string) => ({
  model: 'test',
  choices: [{ message: { content }, finish_reason: 'stop' }],
});
const GOOD = '{"direction":"UP","probability":61}';
const BARS: Bar[] = Array.from({ length: 190 }, (_, i) => ({ t: i * 10_000, c: 100_000 }));

test('a good reply comes back parsed, with reasoning turned off', async () => {
  await withServer(
    () => ({ status: 200, json: REPLY(GOOD) }),
    async (url, seen) => {
      const f = await forecast(BARS, 100_000, { apiKey: 'k', model: 'test', baseUrl: url });
      assert.equal(f.side, 'UP');
      assert.equal(f.probability, 0.61);
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].reasoning, { effort: 'none', exclude: true });
      assert.ok((seen[0].max_tokens as number) >= 500, 'room for the answer if it reasons anyway');
    }
  );
});

test('an empty reply retries once without the reasoning field', async () => {
  await withServer(
    (_b, n) => ({ status: 200, json: REPLY(n === 0 ? '' : GOOD) }),
    async (url, seen) => {
      const f = await forecast(BARS, 100_000, { apiKey: 'k', model: 'test', baseUrl: url });
      assert.equal(f.side, 'UP');
      assert.equal(seen.length, 2);
      assert.equal(seen[1].reasoning, undefined);
    }
  );
});

test('the timeout is a budget for the whole call, not for each attempt', async () => {
  const budget = 2500;
  const started = Date.now();
  await withServer(
    () => ({ status: 200, json: REPLY(''), delayMs: 6000 }),
    async (url) => {
      await assert.rejects(
        forecast(BARS, 100_000, { apiKey: 'k', model: 'test', baseUrl: url, timeoutMs: budget })
      );
    }
  );
  assert.ok(Date.now() - started < budget * 1.7, 'attempts must share one deadline');
});

test('a bad key fails immediately instead of burning the budget', async () => {
  await withServer(
    () => ({ status: 401, json: { error: { message: 'no credit' } } }),
    async (url, seen) => {
      await assert.rejects(
        forecast(BARS, 100_000, { apiKey: 'bad', model: 'test', baseUrl: url }),
        /401/
      );
      assert.equal(seen.length, 1, 'a 401 will not fix itself on retry');
    }
  );
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
  const c = sanitize({ minEdge: 5, stakeUsd: -10, llmWeight: 99, paths: 10_000_000 });
  assert.ok(c.minEdge <= 0.5);
  assert.ok(c.stakeUsd >= 1);
  assert.ok(c.llmWeight <= 1);
  assert.ok(c.paths <= 50_000);
  assert.equal(sanitize({ mode: 'HACK' }).mode, DEFAULT_CONFIG.mode);
  assert.equal(sanitize({ autoTrade: 'yes' }).autoTrade, DEFAULT_CONFIG.autoTrade);
});

test('the defaults let a trade happen at all', () => {
  // The old build shipped gates that could never be satisfied together. The
  // rule is now one comparison, so this just confirms it is reachable.
  const c = DEFAULT_CONFIG;
  assert.ok(c.minEdge > 0 && c.minEdge < 0.5);
  assert.ok(c.minSecondsLeft < 300, 'must leave room inside the window to enter');
  assert.ok(c.stakeUsd > 0);
});
