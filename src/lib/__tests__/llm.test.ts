import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { requestForecast } from '../llm/openrouter';
import { sanitizeConfig, DEFAULT_CONFIG } from '../config';
import { estimateVolatility } from '../quant/volatility';
import type { Bar } from '../types';
import type { PromptContext } from '../llm/prompt';

/**
 * These tests run against a local stand-in for OpenRouter, so the retry,
 * budget and parsing behaviour is exercised for real rather than mocked at the
 * module boundary. Every case here is a failure mode observed in production:
 * a model that reasons past its token budget, a provider that returns the
 * answer in `reasoning`, and one that simply never replies.
 */

const bars: Bar[] = Array.from({ length: 120 }, (_, i) => {
  const p = 100_000 + Math.sin(i / 7) * 40;
  return { t: i * 10_000, o: p, h: p, l: p, c: p, v: 0 };
});

function context(): PromptContext {
  return {
    startPrice: 100_000,
    currentPrice: 100_030,
    windowStartMs: 1_800_000_000_000,
    windowEndMs: 1_800_000_300_000,
    nowMs: 1_800_000_150_000,
    bars,
    vol: estimateVolatility(bars, 0.97),
    chainlink: null,
    interpolated: false,
    source: 'binance',
  };
}

interface Recorded {
  bodies: Record<string, unknown>[];
}

/** Spin up a fake completions endpoint driven by a per-request handler. */
async function withServer(
  handler: (
    body: Record<string, unknown>,
    attempt: number
  ) => Promise<{ status: number; json: unknown; delayMs?: number }>,
  run: (url: string, recorded: Recorded) => Promise<void>
): Promise<void> {
  const recorded: Recorded = { bodies: [] };
  let attempt = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      recorded.bodies.push(body);
      const result = await handler(body, attempt++);
      const send = () => {
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.json));
      };
      if (result.delayMs) setTimeout(send, result.delayMs);
      else send();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1/chat/completions`, recorded);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function completion(content: string, extra: Record<string, unknown> = {}) {
  return {
    model: 'test/model',
    choices: [{ message: { content }, finish_reason: 'stop', ...extra }],
    usage: { prompt_tokens: 3000, completion_tokens: 100 },
  };
}

const GOOD = JSON.stringify({
  p_up: 0.57,
  confidence: 0.4,
  expected_move_usd: 45,
  regime: 'choppy',
  key_factors: ['flat drift'],
  rationale: 'no edge',
});

test('a clean JSON answer is parsed on the first attempt', async () => {
  await withServer(
    async () => ({ status: 200, json: completion(GOOD) }),
    async (url, recorded) => {
      const r = await requestForecast(context(), {
        apiKey: 'k',
        model: 'test/model',
        baseUrl: url,
        timeoutMs: 10_000,
      });
      assert.equal(r.pUp, 0.57);
      assert.equal(r.confidence, 0.4);
      assert.equal(recorded.bodies.length, 1, 'no retries needed');
    }
  );
});

test('reasoning is disabled and the token budget leaves room for the answer', async () => {
  await withServer(
    async () => ({ status: 200, json: completion(GOOD) }),
    async (url, recorded) => {
      await requestForecast(context(), {
        apiKey: 'k',
        model: 'test/model',
        baseUrl: url,
        timeoutMs: 10_000,
      });
      const body = recorded.bodies[0];
      assert.deepEqual(
        body.reasoning,
        { effort: 'none', exclude: true },
        'reasoning must be turned off — it is pure latency for a numeric answer'
      );
      assert.ok(
        (body.max_tokens as number) >= 1000,
        `max_tokens ${body.max_tokens} leaves no room if the model reasons anyway`
      );
    }
  );
});

test('an answer returned in `reasoning` with empty content is still recovered', async () => {
  // Some providers put a reasoning model's visible output in `reasoning` and
  // leave `content` empty. Throwing that away would waste a paid call.
  await withServer(
    async () => ({
      status: 200,
      json: {
        model: 'test/model',
        choices: [
          {
            message: { content: '', reasoning: `Let me think... ${GOOD}` },
            finish_reason: 'stop',
          },
        ],
      },
    }),
    async (url) => {
      const r = await requestForecast(context(), {
        apiKey: 'k',
        model: 'test/model',
        baseUrl: url,
        timeoutMs: 10_000,
      });
      assert.equal(r.pUp, 0.57);
    }
  );
});

test('an empty completion falls back through the attempt chain', async () => {
  await withServer(
    async (_body, attempt) =>
      attempt === 0
        ? { status: 200, json: completion('') }
        : { status: 200, json: completion(GOOD) },
    async (url, recorded) => {
      const r = await requestForecast(context(), {
        apiKey: 'k',
        model: 'test/model',
        baseUrl: url,
        timeoutMs: 10_000,
      });
      assert.equal(r.pUp, 0.57);
      assert.equal(recorded.bodies.length, 2);
      // The fallback must relax the schema constraint, since a strict schema is
      // the most likely reason a provider returned nothing.
      assert.deepEqual(recorded.bodies[1].response_format, { type: 'json_object' });
    }
  );
});

test('the third attempt drops the reasoning field for providers that reject it', async () => {
  await withServer(
    async (_body, attempt) =>
      attempt < 2
        ? { status: 200, json: completion('') }
        : { status: 200, json: completion(GOOD) },
    async (url, recorded) => {
      await requestForecast(context(), {
        apiKey: 'k',
        model: 'test/model',
        baseUrl: url,
        timeoutMs: 15_000,
      });
      assert.equal(recorded.bodies.length, 3);
      assert.equal(
        recorded.bodies[2].reasoning,
        undefined,
        'final attempt must not carry a field the provider may be rejecting'
      );
    }
  );
});

test('the timeout is a budget for the whole call, not for each attempt', async () => {
  // Three attempts at a full timeout each would run three times as long as the
  // caller asked for — past the serverless limit, so the function is killed and
  // the browser sees a dead connection rather than a clean failure.
  const budget = 3000;
  const started = Date.now();
  await withServer(
    async () => ({ status: 200, json: completion(''), delayMs: 5000 }),
    async (url) => {
      await assert.rejects(
        requestForecast(context(), {
          apiKey: 'k',
          model: 'test/model',
          baseUrl: url,
          timeoutMs: budget,
        })
      );
    }
  );
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < budget * 1.6,
    `took ${elapsed}ms for a ${budget}ms budget — the deadline is not shared across attempts`
  );
});

test('a slow first attempt still leaves time for a fallback', async () => {
  await withServer(
    async (_body, attempt) =>
      attempt === 0
        ? { status: 200, json: completion(''), delayMs: 10_000 }
        : { status: 200, json: completion(GOOD) },
    async (url) => {
      const r = await requestForecast(context(), {
        apiKey: 'k',
        model: 'test/model',
        baseUrl: url,
        timeoutMs: 6000,
      });
      assert.equal(r.pUp, 0.57, 'the fallback attempt should have landed inside the budget');
    }
  );
});

test('auth failures fail fast instead of burning the budget on retries', async () => {
  const started = Date.now();
  await withServer(
    async () => ({ status: 401, json: { error: { message: 'no credit' } } }),
    async (url, recorded) => {
      await assert.rejects(
        requestForecast(context(), {
          apiKey: 'bad',
          model: 'test/model',
          baseUrl: url,
          timeoutMs: 20_000,
        }),
        /401/
      );
      assert.equal(recorded.bodies.length, 1, 'a 401 will not fix itself on retry');
    }
  );
  assert.ok(Date.now() - started < 3000);
});

test('the request carries the auth header and never the key in the URL', async () => {
  const server = createServer();
  let seenAuth: string | undefined;
  server.on('request', (req, res) => {
    seenAuth = req.headers.authorization;
    assert.ok(!req.url?.includes('secret-key'), 'the key must not appear in the URL');
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion(GOOD)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await requestForecast(context(), {
      apiKey: 'secret-key',
      model: 'test/model',
      baseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
      timeoutMs: 8000,
    });
    assert.equal(seenAuth, 'Bearer secret-key');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the LLM budget stays inside the serverless function limit', () => {
  const clamped = sanitizeConfig({ llmTimeoutMs: 999_999 });
  assert.ok(clamped.llmTimeoutMs <= 55_000, 'must stay inside the serverless function limit');
  assert.ok(sanitizeConfig({ llmTimeoutMs: 1 }).llmTimeoutMs >= 5000);
});
