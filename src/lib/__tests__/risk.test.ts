import { strict as assert } from 'node:assert';
import test from 'node:test';
import { evaluate, shrinkProbability, type PortfolioState } from '../engine/risk';
import { forecastLatencyMs } from '../engine/engine';
import type { CycleState } from '../engine/engine';
import { DEFAULT_CONFIG, WINDOW_SECONDS, sanitizeConfig } from '../config';
import { bookCoherence, quoteFromBook, roundPriceDown, roundPriceUp } from '../polymarket/clob';
import type { BtcMarket, OrderBook, TradingConfig } from '../types';

const NOW = 1_800_000_000_000;

function market(over: Partial<BtcMarket> = {}): BtcMarket {
  return {
    id: 'mkt-1',
    slug: 'bitcoin-up-or-down-test',
    question: 'Bitcoin Up or Down?',
    conditionId: '0xcond',
    startMs: NOW - 150_000,
    endMs: NOW + 150_000,
    tokens: [
      { tokenId: 'UPTOK', outcome: 'Up', side: 'UP' },
      { tokenId: 'DNTOK', outcome: 'Down', side: 'DOWN' },
    ],
    minTickSize: 0.001,
    minOrderSize: 5,
    negRisk: false,
    acceptingOrders: true,
    closed: false,
    ...over,
  };
}

function book(bid: number, ask: number, size = 500): OrderBook {
  return {
    tokenId: 'x',
    bids: [
      { price: bid, size },
      { price: bid - 0.01, size: size * 2 },
    ],
    asks: [
      { price: ask, size },
      { price: ask + 0.01, size: size * 2 },
    ],
    t: NOW,
  };
}

function portfolio(over: Partial<PortfolioState> = {}): PortfolioState {
  return {
    openPositions: 0,
    openMarketIds: [],
    tradesLastHour: 0,
    tradesToday: 0,
    realisedPnlToday: 0,
    consecutiveLosses: 0,
    bankroll: 1000,
    ...over,
  };
}

function config(over: Partial<TradingConfig> = {}): TradingConfig {
  return { ...DEFAULT_CONFIG, autoTrade: true, ...over };
}

/** A state with a clear, tradeable edge on UP: model 62%, ask 0.50. */
function goodSetup(over: { cfg?: Partial<TradingConfig>; pf?: Partial<PortfolioState> } = {}) {
  return {
    config: config(over.cfg),
    market: market(),
    books: {
      UPTOK: { ...book(0.48, 0.5), tokenId: 'UPTOK' },
      DNTOK: { ...book(0.48, 0.5), tokenId: 'DNTOK' },
    },
    pUp: 0.62,
    pUpStdErr: 0.003,
    llmConfidence: 0.6,
    nowMs: NOW,
    dataAgeMs: 400,
    decisionLatencyMs: 3000,
    portfolio: portfolio(over.pf),
  };
}

test('a clean edge is approved and sized', () => {
  const d = evaluate(goodSetup());
  assert.equal(d.trade, true, `rejected: ${d.rejectReasons.join(', ')}`);
  assert.equal(d.rejectReasons.length, 0);
  assert.equal(d.best?.side, 'UP');
  assert.ok(d.size > 0);
  assert.ok(d.notional > 0 && d.notional <= DEFAULT_CONFIG.maxPositionUsd);
  // Edge = pWin - ask, with a one-standard-error haircut applied against us.
  assert.ok(Math.abs((d.best?.edge ?? 0) - (0.62 - 0.003 - 0.5)) < 1e-9);
});

test('the DOWN side is chosen when the model is bearish', () => {
  const d = evaluate({ ...goodSetup(), pUp: 0.3 });
  assert.equal(d.trade, true, `rejected: ${d.rejectReasons.join(', ')}`);
  assert.equal(d.best?.side, 'DOWN');
  assert.ok(Math.abs((d.best?.pWin ?? 0) - (0.7 - 0.003)) < 1e-9);
});

test('the standard-error haircut always works against the trade', () => {
  const tight = evaluate({ ...goodSetup(), pUpStdErr: 0 });
  const noisy = evaluate({ ...goodSetup(), pUpStdErr: 0.05 });
  assert.ok((noisy.best?.edge ?? 0) < (tight.best?.edge ?? 0));
  // A noisy simulation must be able to take the edge below the threshold.
  const veryNoisy = evaluate({ ...goodSetup(), pUpStdErr: 0.09 });
  assert.ok(veryNoisy.rejectReasons.includes('insufficient-edge'));
});

// ── Each gate blocks in isolation ───────────────────────────────────────────

const gateCases: {
  name: string;
  reason: string;
  input: Parameters<typeof evaluate>[0];
}[] = [
  {
    name: 'edge below the minimum',
    reason: 'insufficient-edge',
    input: { ...goodSetup(), pUp: 0.52 },
  },
  {
    name: 'spread too wide',
    reason: 'spread-too-wide',
    input: {
      ...goodSetup(),
      books: {
        UPTOK: { ...book(0.3, 0.5), tokenId: 'UPTOK' },
        DNTOK: { ...book(0.3, 0.5), tokenId: 'DNTOK' },
      },
    },
  },
  {
    name: 'top of book too thin',
    reason: 'insufficient-liquidity',
    input: {
      ...goodSetup(),
      books: {
        UPTOK: { ...book(0.48, 0.5, 3), tokenId: 'UPTOK' },
        DNTOK: { ...book(0.48, 0.5, 3), tokenId: 'DNTOK' },
      },
    },
  },
  {
    name: 'price outside bounds',
    reason: 'price-out-of-bounds',
    input: {
      ...goodSetup(),
      pUp: 0.999,
      books: {
        UPTOK: { ...book(0.95, 0.96), tokenId: 'UPTOK' },
        DNTOK: { ...book(0.02, 0.04), tokenId: 'DNTOK' },
      },
    },
  },
  {
    name: 'too late in the window',
    reason: 'too-late',
    input: { ...goodSetup(), market: market({ endMs: NOW + 10_000 }) },
  },
  {
    name: 'too early in the window',
    reason: 'too-early',
    input: { ...goodSetup(), market: market({ endMs: NOW + 290_000 }) },
  },
  {
    name: 'stale data',
    reason: 'stale-data',
    input: { ...goodSetup(), dataAgeMs: 30_000 },
  },
  {
    name: 'latency budget blown',
    reason: 'latency-budget',
    input: { ...goodSetup(), decisionLatencyMs: 60_000 },
  },
  {
    name: 'LLM confidence too low',
    reason: 'low-confidence',
    input: { ...goodSetup(), llmConfidence: 0.05 },
  },
  {
    name: 'kill switch engaged',
    reason: 'kill-switch',
    input: goodSetup({ cfg: { killSwitch: true } }),
  },
  {
    name: 'auto-trade off',
    reason: 'mode-disabled',
    input: goodSetup({ cfg: { autoTrade: false } }),
  },
  {
    name: 'market not accepting orders',
    reason: 'no-market',
    input: { ...goodSetup(), market: market({ acceptingOrders: false }) },
  },
  {
    name: 'no book at all',
    reason: 'no-book',
    input: { ...goodSetup(), books: {} },
  },
  {
    name: 'position limit reached',
    reason: 'max-open-positions',
    input: goodSetup({ pf: { openPositions: 1 } }),
  },
  {
    name: 'already positioned in this market',
    reason: 'already-in-market',
    input: goodSetup({ pf: { openMarketIds: ['mkt-1'], openPositions: 0 } }),
  },
  {
    name: 'hourly trade cap',
    reason: 'trade-rate-limit',
    input: goodSetup({ pf: { tradesLastHour: 99 } }),
  },
  {
    name: 'daily loss limit',
    reason: 'daily-loss-limit',
    input: goodSetup({ pf: { realisedPnlToday: -500 } }),
  },
  {
    name: 'consecutive-loss circuit breaker',
    reason: 'daily-loss-limit',
    input: goodSetup({ pf: { consecutiveLosses: 9 } }),
  },
  {
    name: 'bankroll exhausted',
    reason: 'bankroll-too-small',
    input: goodSetup({ pf: { bankroll: 0 } }),
  },
];

for (const c of gateCases) {
  test(`gate blocks: ${c.name}`, () => {
    const d = evaluate(c.input);
    assert.equal(d.trade, false, `expected a rejection for ${c.name}`);
    assert.ok(
      d.rejectReasons.includes(c.reason as never),
      `expected "${c.reason}" among [${d.rejectReasons.join(', ')}]`
    );
  });
}

test('rejections accumulate rather than short-circuiting', () => {
  const d = evaluate({
    ...goodSetup({ cfg: { killSwitch: true }, pf: { openPositions: 5 } }),
    dataAgeMs: 90_000,
    llmConfidence: 0,
  });
  assert.ok(d.rejectReasons.length >= 4, `only got ${d.rejectReasons.join(', ')}`);
  assert.ok(d.rejectReasons.includes('kill-switch'));
  assert.ok(d.rejectReasons.includes('stale-data'));
  assert.ok(d.rejectReasons.includes('max-open-positions'));
  assert.ok(d.rejectReasons.includes('low-confidence'));
});

// ── Sizing ──────────────────────────────────────────────────────────────────

test('size respects the hard caps, not just Kelly', () => {
  // Huge edge and a huge bankroll: Kelly would size enormously, so the caps
  // are the only thing standing between the model and the whole account.
  const d = evaluate({
    ...goodSetup({ cfg: { maxPositionUsd: 25, maxPositionPctBankroll: 1 } }),
    pUp: 0.95,
    portfolio: portfolio({ bankroll: 1_000_000 }),
  });
  assert.ok(d.notional <= 25.0001, `notional ${d.notional} exceeded the $25 cap`);
});

test('the percentage cap binds when it is tighter than the dollar cap', () => {
  const d = evaluate({
    ...goodSetup({ cfg: { maxPositionUsd: 10_000, maxPositionPctBankroll: 0.01 } }),
    pUp: 0.95,
    portfolio: portfolio({ bankroll: 2000 }),
  });
  assert.ok(d.notional <= 20.0001, `notional ${d.notional} exceeded 1% of $2000`);
});

test('size never exceeds the resting depth it was priced against', () => {
  const d = evaluate({
    ...goodSetup({ cfg: { maxPositionUsd: 5000, maxPositionPctBankroll: 1 } }),
    pUp: 0.95,
    books: {
      UPTOK: { ...book(0.48, 0.5, 30), tokenId: 'UPTOK' },
      DNTOK: { ...book(0.48, 0.5, 30), tokenId: 'DNTOK' },
    },
    portfolio: portfolio({ bankroll: 100_000 }),
  });
  assert.ok(d.size <= 30, `size ${d.size} exceeded the 30 shares at the touch`);
});

test('a lower Kelly fraction produces a smaller position', () => {
  const bold = evaluate(goodSetup({ cfg: { kellyFraction: 1, maxPositionUsd: 100_000, maxPositionPctBankroll: 1 } }));
  const timid = evaluate(goodSetup({ cfg: { kellyFraction: 0.1, maxPositionUsd: 100_000, maxPositionPctBankroll: 1 } }));
  assert.ok(timid.notional < bold.notional, `${timid.notional} should be below ${bold.notional}`);
});

test('a sub-minimum size is rejected rather than rounded up', () => {
  const d = evaluate({
    ...goodSetup({ cfg: { maxPositionUsd: 1, maxPositionPctBankroll: 0.001 } }),
    portfolio: portfolio({ bankroll: 100 }),
  });
  assert.equal(d.trade, false);
  assert.ok(d.rejectReasons.includes('size-below-minimum'));
});

// ── Config sanitisation ─────────────────────────────────────────────────────

test('config sanitisation clamps hostile values into bounds', () => {
  const c = sanitizeConfig({
    kellyFraction: 99,
    minEdge: -5,
    maxPositionUsd: 1e12,
    mcPaths: 10_000_000,
    bankroll: 500,
    probabilityShrink: 5,
  });
  assert.ok(c.kellyFraction <= 1);
  assert.ok(c.minEdge >= 0.005);
  assert.ok(c.mcPaths <= 200_000);
  assert.ok(c.probabilityShrink <= 0.9);
  assert.ok(c.maxPositionUsd <= c.bankroll, 'a position can never exceed the bankroll');
});

test('config sanitisation preserves cross-field invariants', () => {
  const c = sanitizeConfig({ minPrice: 0.4, maxPrice: 0.2, minSecondsLeft: 200, maxSecondsLeft: 50 });
  assert.ok(c.maxPrice > c.minPrice);
  assert.ok(c.maxSecondsLeft > c.minSecondsLeft);
});

test('config sanitisation ignores unknown and mistyped fields', () => {
  const c = sanitizeConfig({ mode: 'HACK', mcEngine: 'nonsense', kellyFraction: 'lots', evil: true });
  assert.equal(c.mode, DEFAULT_CONFIG.mode);
  assert.equal(c.mcEngine, DEFAULT_CONFIG.mcEngine);
  assert.equal(c.kellyFraction, DEFAULT_CONFIG.kellyFraction);
  assert.ok(!('evil' in c));
});

// ── Book helpers ────────────────────────────────────────────────────────────

test('tick rounding moves conservatively in each direction', () => {
  assert.ok(Math.abs(roundPriceUp(0.5234, 0.01) - 0.53) < 1e-9);
  assert.ok(Math.abs(roundPriceDown(0.5234, 0.01) - 0.52) < 1e-9);
  assert.ok(Math.abs(roundPriceUp(0.52, 0.01) - 0.52) < 1e-9, 'an exact tick is left alone');
});

test('book coherence flags a crossed pair of books', () => {
  const normal = bookCoherence(
    quoteFromBook({ ...book(0.48, 0.51), tokenId: 'a' }),
    quoteFromBook({ ...book(0.46, 0.51), tokenId: 'b' })
  );
  assert.equal(normal.crossed, false);
  assert.ok((normal.impliedSum ?? 0) > 1);

  const crossed = bookCoherence(
    quoteFromBook({ ...book(0.4, 0.42), tokenId: 'a' }),
    quoteFromBook({ ...book(0.4, 0.42), tokenId: 'b' })
  );
  assert.equal(crossed.crossed, true, 'two asks summing to 0.84 is a stale book, not free money');
  assert.ok(crossed.arbitrage > 0.15);
});

test('shrink is applied before sizing, so it can remove a marginal trade', () => {
  const raw = 0.545;
  const shrunk = shrinkProbability(raw, 0.4);
  const before = evaluate({ ...goodSetup({ cfg: { minEdge: 0.04 } }), pUp: raw, pUpStdErr: 0 });
  const after = evaluate({ ...goodSetup({ cfg: { minEdge: 0.04 } }), pUp: shrunk, pUpStdErr: 0 });
  assert.equal(before.trade, true);
  assert.equal(after.trade, false);
  assert.ok(after.rejectReasons.includes('insufficient-edge'));
});


// ── Gate feasibility ────────────────────────────────────────────────────────

/**
 * The timing gates must admit a non-empty window, or the engine sits out every
 * market while reporting perfectly reasonable-looking rejections.
 *
 * This bit us for real: `maxDecisionLatencyMs` was measured as time elapsed
 * since the forecast was dispatched, which grows for the whole window, while
 * `maxSecondsLeft` requires waiting before entering. With the shipped defaults
 * the first gate demanded t <= 12s and the second demanded t >= 40s, so no
 * trade was ever possible. The gate now bounds the forecast's own round trip,
 * which is independent of t.
 */
test('the default timing gates admit a non-empty trade window', () => {
  const c = DEFAULT_CONFIG;
  const earliest = WINDOW_SECONDS - c.maxSecondsLeft;
  const latest = WINDOW_SECONDS - c.minSecondsLeft;
  assert.ok(
    latest > earliest,
    `min/max seconds-left leave no room: t in [${earliest}, ${latest}]`
  );
  assert.ok(latest - earliest >= 30, 'the window should be wide enough to be usable');
});

test('the forecast-latency gate does not depend on when in the window we act', () => {
  // Same forecast, evaluated early and late. Only the seconds-left gates should
  // differ; the latency gate must behave identically at both times.
  const forecastLatencyMs = 4000;
  const at = (elapsed: number) => {
    const base = goodSetup();
    return evaluate({
      ...base,
      market: market({ startMs: NOW - elapsed * 1000, endMs: NOW + (300 - elapsed) * 1000 }),
      decisionLatencyMs: forecastLatencyMs,
    });
  };
  for (const elapsed of [50, 120, 200, 250]) {
    const d = at(elapsed);
    assert.ok(
      !d.rejectReasons.includes('latency-budget'),
      `a ${forecastLatencyMs}ms forecast was rejected for latency at t=${elapsed}s`
    );
  }
  // A genuinely slow forecast is still refused, wherever in the window we are.
  const slow = evaluate({ ...goodSetup(), decisionLatencyMs: 60_000 });
  assert.ok(slow.rejectReasons.includes('latency-budget'));
});

test('there is a reachable state where every gate passes at once', () => {
  // A full end-to-end feasibility check: mid-window, fresh data, a fast
  // forecast, a real edge, and an empty book of positions.
  const c = DEFAULT_CONFIG;
  const elapsed = WINDOW_SECONDS - (c.minSecondsLeft + c.maxSecondsLeft) / 2;
  const d = evaluate({
    ...goodSetup(),
    market: market({ startMs: NOW - elapsed * 1000, endMs: NOW + (300 - elapsed) * 1000 }),
    dataAgeMs: c.maxDataAgeMs / 2,
    decisionLatencyMs: c.maxDecisionLatencyMs / 2,
  });
  assert.equal(
    d.trade,
    true,
    `no reachable trade under default gates: ${d.rejectReasons.join(', ')}`
  );
});


test('forecast latency is the model round trip, not the age of the forecast', () => {
  const dispatched = NOW - 200_000; // forecast sent 200s ago
  const cycle = {
    llm: { latencyMs: 3200 },
    llmDispatchedAt: dispatched,
  } as unknown as CycleState;

  // The forecast is 200 seconds old, but it only took 3.2s to produce. The gate
  // must see 3.2s — anything else makes it fight `maxSecondsLeft` and the
  // engine never trades.
  assert.equal(forecastLatencyMs(cycle, NOW), 3200);
  assert.ok(
    forecastLatencyMs(cycle, NOW) < DEFAULT_CONFIG.maxDecisionLatencyMs,
    'a fast forecast must stay tradeable however late in the window we act'
  );

  // Still in flight: report the wait so far, which is what the UI counts up.
  const pending = { llm: null, llmDispatchedAt: NOW - 4000 } as unknown as CycleState;
  assert.equal(forecastLatencyMs(pending, NOW), 4000);

  const idle = { llm: null, llmDispatchedAt: null } as unknown as CycleState;
  assert.equal(forecastLatencyMs(idle, NOW), 0);
});

test('a fast forecast stays tradeable at every point in the allowed window', () => {
  // End-to-end feasibility using the engine's own latency rule rather than a
  // hand-passed number — this is the exact combination that used to deadlock.
  const c = DEFAULT_CONFIG;
  const cycle = { llm: { latencyMs: 3500 }, llmDispatchedAt: NOW - 250_000 } as unknown as CycleState;

  let tradeable = 0;
  for (let elapsed = WINDOW_SECONDS - c.maxSecondsLeft; elapsed <= WINDOW_SECONDS - c.minSecondsLeft; elapsed += 10) {
    const now = NOW;
    const d = evaluate({
      ...goodSetup(),
      market: market({ startMs: now - elapsed * 1000, endMs: now + (WINDOW_SECONDS - elapsed) * 1000 }),
      nowMs: now,
      dataAgeMs: 500,
      decisionLatencyMs: forecastLatencyMs(cycle, now),
    });
    if (d.trade) tradeable++;
  }
  assert.ok(tradeable > 15, `only ${tradeable} tradeable moments across the allowed window`);
});
