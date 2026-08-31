import 'server-only';
import type { Config, CycleRecord, Position } from './types';
import { DEFAULT_CONFIG } from './config';
import { env } from './env';

/**
 * Server-side persistence.
 *
 * Vercel functions are stateless and short-lived, so in-memory state survives
 * only until the next cold start. That is fine for a demo and useless for a
 * trading log, so the store is written against a tiny interface with two
 * implementations: process memory (zero config) and Upstash Redis over REST
 * (durable, works from any runtime, no TCP connection to pool).
 *
 * The client is the source of truth for *live* state — it holds the tick
 * feed and drives the cycle — and posts completed records here. That split
 * keeps the hot loop off the serverless billing meter while still giving a
 * durable audit trail of every decision.
 */

const MAX_ROWS = 1000;

export interface Store {
  readonly kind: 'memory' | 'upstash';
  /** Round-trip probe. Configured is not the same as reachable. */
  ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  getConfig(): Promise<Config>;
  setConfig(config: Config): Promise<void>;
  getKillSwitch(): Promise<boolean>;
  setKillSwitch(on: boolean): Promise<void>;
  listPositions(): Promise<Position[]>;
  upsertPosition(p: Position): Promise<void>;
  listCycles(): Promise<CycleRecord[]>;
  upsertCycle(c: CycleRecord): Promise<void>;
  reset(): Promise<void>;
}

const KEYS = {
  config: 'vision:config',
  kill: 'vision:killswitch',
  positions: 'vision:positions',
  cycles: 'vision:cycles',
};

// ── Memory implementation ───────────────────────────────────────────────────

interface MemoryState {
  config: Config;
  kill: boolean;
  positions: Map<string, Position>;
  cycles: Map<string, CycleRecord>;
}

// Hung off globalThis so it survives Next.js module reloads in dev, which would
// otherwise wipe the session on every file save.
const g = globalThis as unknown as { __visionStore?: MemoryState };

function memoryState(): MemoryState {
  if (!g.__visionStore) {
    g.__visionStore = {
      config: { ...DEFAULT_CONFIG },
      kill: false,
      positions: new Map(),
      cycles: new Map(),
    };
  }
  return g.__visionStore;
}

class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  async ping() {
    return { ok: true, latencyMs: 0 };
  }
  async getConfig() {
    return { ...memoryState().config };
  }
  async setConfig(config: Config) {
    memoryState().config = { ...config };
  }
  async getKillSwitch() {
    return memoryState().kill;
  }
  async setKillSwitch(on: boolean) {
    memoryState().kill = on;
  }
  async listPositions() {
    return [...memoryState().positions.values()].sort((a, b) => a.openedAt - b.openedAt).slice(-MAX_ROWS);
  }
  async upsertPosition(p: Position) {
    memoryState().positions.set(p.id, p);
  }
  async listCycles() {
    return [...memoryState().cycles.values()].sort((a, b) => a.startMs - b.startMs).slice(-MAX_ROWS);
  }
  async upsertCycle(c: CycleRecord) {
    memoryState().cycles.set(c.id, c);
  }
  async reset() {
    const st = memoryState();
    st.positions.clear();
    st.cycles.clear();
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

  async getConfig() {
    return this.getJson<Config>(KEYS.config, { ...DEFAULT_CONFIG });
  }
  async setConfig(config: Config) {
    await this.command(['SET', KEYS.config, JSON.stringify(config)]);
  }
  async getKillSwitch() {
    const v = await this.command<string | null>(['GET', KEYS.kill]);
    return v === '1' || v === 'true';
  }
  async setKillSwitch(on: boolean) {
    await this.command(['SET', KEYS.kill, on ? '1' : '0']);
  }
  async listPositions() {
    const rows = await this.command<Record<string, string>>(['HGETALL', KEYS.positions]);
    return parseHash<Position>(rows).sort((a, b) => a.openedAt - b.openedAt).slice(-MAX_ROWS);
  }
  async upsertPosition(p: Position) {
    await this.command(['HSET', KEYS.positions, p.id, JSON.stringify(p)]);
  }
  async listCycles() {
    const rows = await this.command<Record<string, string>>(['HGETALL', KEYS.cycles]);
    return parseHash<CycleRecord>(rows).sort((a, b) => a.startMs - b.startMs).slice(-MAX_ROWS);
  }
  async upsertCycle(c: CycleRecord) {
    await this.command(['HSET', KEYS.cycles, c.id, JSON.stringify(c)]);
  }
  async reset() {
    await this.command(['DEL', KEYS.positions, KEYS.cycles]);
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
