import 'server-only';
import type { Config, Trade, WindowRecord } from './types';
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
 * The client is the source of truth for *live* state — it holds the tick feed
 * and drives the cycle — and posts completed records here. That split keeps the
 * hot loop off the serverless billing meter while still giving a durable audit
 * trail of every decision.
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
  listTrades(): Promise<Trade[]>;
  upsertTrade(trade: Trade): Promise<void>;
  listWindows(): Promise<WindowRecord[]>;
  upsertWindow(w: WindowRecord): Promise<void>;
  reset(): Promise<void>;
}

const KEYS = {
  config: 'vision:config',
  kill: 'vision:killswitch',
  trades: 'vision:trades',
  windows: 'vision:windows',
};

// ── Memory implementation ───────────────────────────────────────────────────

interface MemoryState {
  config: Config;
  kill: boolean;
  trades: Map<string, Trade>;
  windows: Map<string, WindowRecord>;
}

// Hung off globalThis so it survives Next.js module reloads in dev, which would
// otherwise wipe the session on every file save.
const g = globalThis as unknown as { __visionStore?: MemoryState };

function memoryState(): MemoryState {
  if (!g.__visionStore) {
    g.__visionStore = {
      config: { ...DEFAULT_CONFIG },
      kill: false,
      trades: new Map(),
      windows: new Map(),
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
  async listTrades() {
    return [...memoryState().trades.values()].sort((a, b) => a.t - b.t).slice(-MAX_ROWS);
  }
  async upsertTrade(trade: Trade) {
    memoryState().trades.set(trade.id, trade);
  }
  async listWindows() {
    return [...memoryState().windows.values()].sort((a, b) => a.startMs - b.startMs).slice(-MAX_ROWS);
  }
  async upsertWindow(w: WindowRecord) {
    memoryState().windows.set(w.id, w);
  }
  async reset() {
    const st = memoryState();
    st.trades.clear();
    st.windows.clear();
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
  async listTrades() {
    const rows = await this.command<Record<string, string>>(['HGETALL', KEYS.trades]);
    return parseHash<Trade>(rows).sort((a, b) => a.t - b.t).slice(-MAX_ROWS);
  }
  async upsertTrade(trade: Trade) {
    await this.command(['HSET', KEYS.trades, trade.id, JSON.stringify(trade)]);
  }
  async listWindows() {
    const rows = await this.command<Record<string, string>>(['HGETALL', KEYS.windows]);
    return parseHash<WindowRecord>(rows).sort((a, b) => a.startMs - b.startMs).slice(-MAX_ROWS);
  }
  async upsertWindow(w: WindowRecord) {
    await this.command(['HSET', KEYS.windows, w.id, JSON.stringify(w)]);
  }
  async reset() {
    await this.command(['DEL', KEYS.trades, KEYS.windows]);
  }
}

function parseHash<T>(rows: Record<string, string> | string[] | null): T[] {
  if (!rows) return [];
  // Upstash returns HGETALL as a flat array in some versions and an object in
  // others; both shapes are handled rather than pinned to one client version.
  const values = Array.isArray(rows)
    ? rows.filter((_, i) => i % 2 === 1)
    : Object.values(rows);
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
