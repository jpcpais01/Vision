import 'server-only';
import type { Config, CycleRecord, Position, StrategyId } from './types';
import { DEFAULT_CONFIG } from './config';
import { env } from './env';

/**
 * Server-side persistence, one independent slice per strategy — each bot's
 * config and history lives under its own keys, entirely separate from every
 * other bot's.
 *
 * Vercel functions are stateless and short-lived, so in-memory state survives
 * only until the next cold start. That is fine for a demo and useless for a
 * trading log, so the store is written against a tiny interface with two
 * implementations: process memory (zero config) and Upstash Redis over REST
 * (durable, works from any runtime, no TCP connection to pool).
 *
 * The client is the source of truth for *live* state — it holds the tick
 * feed and drives the cycle for every bot — and posts completed records
 * here. That split keeps the hot loop off the serverless billing meter while
 * still giving a durable audit trail of every decision.
 */

const MAX_ROWS = 1000;

export interface Store {
  readonly kind: 'memory' | 'upstash';
  /** Round-trip probe. Configured is not the same as reachable. */
  ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  getConfig(strategyId: StrategyId): Promise<Config>;
  setConfig(strategyId: StrategyId, config: Config): Promise<void>;
  listPositions(strategyId: StrategyId): Promise<Position[]>;
  upsertPosition(strategyId: StrategyId, p: Position): Promise<void>;
  listCycles(strategyId: StrategyId): Promise<CycleRecord[]>;
  upsertCycle(strategyId: StrategyId, c: CycleRecord): Promise<void>;
  reset(strategyId: StrategyId): Promise<void>;
}

const keysFor = (id: StrategyId) => ({
  config: `vision:config:${id}`,
  positions: `vision:positions:${id}`,
  cycles: `vision:cycles:${id}`,
});

// ── Memory implementation ───────────────────────────────────────────────────

interface StrategyState {
  config: Config;
  positions: Map<string, Position>;
  cycles: Map<string, CycleRecord>;
}

// Hung off globalThis so it survives Next.js module reloads in dev, which would
// otherwise wipe the session on every file save.
const g = globalThis as unknown as { __visionStore?: Map<StrategyId, StrategyState> };

function memoryState(): Map<StrategyId, StrategyState> {
  if (!g.__visionStore) g.__visionStore = new Map();
  return g.__visionStore;
}

function strategyState(id: StrategyId): StrategyState {
  const store = memoryState();
  let s = store.get(id);
  if (!s) {
    s = { config: { ...DEFAULT_CONFIG }, positions: new Map(), cycles: new Map() };
    store.set(id, s);
  }
  return s;
}

class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  async ping() {
    return { ok: true, latencyMs: 0 };
  }
  async getConfig(id: StrategyId) {
    return { ...strategyState(id).config };
  }
  async setConfig(id: StrategyId, config: Config) {
    strategyState(id).config = { ...config };
  }
  async listPositions(id: StrategyId) {
    return [...strategyState(id).positions.values()].sort((a, b) => a.openedAt - b.openedAt).slice(-MAX_ROWS);
  }
  async upsertPosition(id: StrategyId, p: Position) {
    strategyState(id).positions.set(p.id, p);
  }
  async listCycles(id: StrategyId) {
    return [...strategyState(id).cycles.values()].sort((a, b) => a.startMs - b.startMs).slice(-MAX_ROWS);
  }
  async upsertCycle(id: StrategyId, c: CycleRecord) {
    strategyState(id).cycles.set(c.id, c);
  }
  async reset(id: StrategyId) {
    const s = strategyState(id);
    s.positions.clear();
    s.cycles.clear();
  }
}

// ── Upstash implementation ──────────────────────────────────────────────────

class UpstashStore implements Store {
  readonly kind = 'upstash' as const;

  constructor(
    private url: string,
    private token: string
  ) {}

  private async command<T>(args: (string | number)[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`upstash ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as { result: T; error?: string };
    if (json.error) throw new Error(`upstash: ${json.error}`);
    return json.result;
  }

  async ping() {
    const started = Date.now();
    try {
      await this.command<string>(['PING']);
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async getJson<T>(key: string, fallback: T): Promise<T> {
    const raw = await this.command<string | null>(['GET', key]);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  async getConfig(id: StrategyId) {
    return this.getJson<Config>(keysFor(id).config, { ...DEFAULT_CONFIG });
  }
  async setConfig(id: StrategyId, config: Config) {
    await this.command(['SET', keysFor(id).config, JSON.stringify(config)]);
  }
  async listPositions(id: StrategyId) {
    const rows = await this.command<Record<string, string>>(['HGETALL', keysFor(id).positions]);
    return parseHash<Position>(rows).sort((a, b) => a.openedAt - b.openedAt).slice(-MAX_ROWS);
  }
  async upsertPosition(id: StrategyId, p: Position) {
    await this.command(['HSET', keysFor(id).positions, p.id, JSON.stringify(p)]);
  }
  async listCycles(id: StrategyId) {
    const rows = await this.command<Record<string, string>>(['HGETALL', keysFor(id).cycles]);
    return parseHash<CycleRecord>(rows).sort((a, b) => a.startMs - b.startMs).slice(-MAX_ROWS);
  }
  async upsertCycle(id: StrategyId, c: CycleRecord) {
    await this.command(['HSET', keysFor(id).cycles, c.id, JSON.stringify(c)]);
  }
  async reset(id: StrategyId) {
    const k = keysFor(id);
    await this.command(['DEL', k.positions, k.cycles]);
  }
}

function parseHash<T>(rows: Record<string, string> | string[] | null): T[] {
  if (!rows) return [];
  // Upstash returns HGETALL as a flat array in some versions and an object in
  // others; both shapes are handled rather than pinned to one client version.
  const values = Array.isArray(rows) ? rows.filter((_, i) => i % 2 === 1) : Object.values(rows);
  const out: T[] = [];
  for (const v of values) {
    try {
      out.push(JSON.parse(v) as T);
    } catch {
      /* skip corrupt row */
    }
  }
  return out;
}

let cached: Store | null = null;

export function getStore(): Store {
  if (cached) return cached;
  const url = env.upstashUrl();
  const token = env.upstashToken();
  cached = url && token ? new UpstashStore(url, token) : new MemoryStore();
  return cached;
}
