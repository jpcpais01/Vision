import 'server-only';
import type { CycleRecord, LogEntry, Trade, TradingConfig } from './types';
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

const MAX_TRADES = 2000;
const MAX_CYCLES = 2000;
const MAX_LOGS = 1000;

export interface Store {
  readonly kind: 'memory' | 'upstash';
  /** Round-trip probe. Reports whether the backend is actually reachable. */
  ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  getConfig(): Promise<TradingConfig>;
  setConfig(config: TradingConfig): Promise<void>;
  getKillSwitch(): Promise<boolean>;
  setKillSwitch(on: boolean): Promise<void>;
  listTrades(): Promise<Trade[]>;
  upsertTrade(trade: Trade): Promise<void>;
  listCycles(): Promise<CycleRecord[]>;
  upsertCycle(cycle: CycleRecord): Promise<void>;
  listLogs(): Promise<LogEntry[]>;
  appendLogs(entries: LogEntry[]): Promise<void>;
  reset(scope: 'all' | 'trades' | 'cycles' | 'logs'): Promise<void>;
}

const KEYS = {
  config: 'vision:config',
  kill: 'vision:killswitch',
  trades: 'vision:trades',
  cycles: 'vision:cycles',
  logs: 'vision:logs',
};

// ── Memory implementation ───────────────────────────────────────────────────

interface MemoryState {
  config: TradingConfig;
  kill: boolean;
  trades: Map<string, Trade>;
  cycles: Map<string, CycleRecord>;
  logs: LogEntry[];
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
      cycles: new Map(),
      logs: [],
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
  async setConfig(config: TradingConfig) {
    memoryState().config = { ...config };
  }
  async getKillSwitch() {
    return memoryState().kill;
  }
  async setKillSwitch(on: boolean) {
    memoryState().kill = on;
  }
  async listTrades() {
    return sortByTime(Array.from(memoryState().trades.values())).slice(-MAX_TRADES);
  }
  async upsertTrade(trade: Trade) {
    memoryState().trades.set(trade.id, trade);
    trimMap(memoryState().trades, MAX_TRADES);
  }
  async listCycles() {
    return sortByStart(Array.from(memoryState().cycles.values())).slice(-MAX_CYCLES);
  }
  async upsertCycle(cycle: CycleRecord) {
    memoryState().cycles.set(cycle.id, cycle);
    trimMap(memoryState().cycles, MAX_CYCLES);
  }
  async listLogs() {
    return memoryState().logs.slice(-MAX_LOGS);
  }
  async appendLogs(entries: LogEntry[]) {
    const s = memoryState();
    s.logs.push(...entries);
    if (s.logs.length > MAX_LOGS) s.logs = s.logs.slice(-MAX_LOGS);
  }
  async reset(scope: 'all' | 'trades' | 'cycles' | 'logs') {
    const s = memoryState();
    if (scope === 'all' || scope === 'trades') s.trades.clear();
    if (scope === 'all' || scope === 'cycles') s.cycles.clear();
    if (scope === 'all' || scope === 'logs') s.logs = [];
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
    return this.getJson<TradingConfig>(KEYS.config, { ...DEFAULT_CONFIG });
  }
  async setConfig(config: TradingConfig) {
    await this.command(['SET', KEYS.config, JSON.stringify(config)]);
  }
  async getKillSwitch() {
    const v = await this.command<string | null>(['GET', KEYS.kill]);
    return v === '1' || v === 'true';
  }
  async setKillSwitch(on: boolean) {
    await this.command(['SET', KEYS.kill, on ? '1' : '0']);
  }

  // Records are stored in a hash keyed by id so re-posting an updated trade
  // (PENDING -> OPEN -> WON) overwrites rather than appends.
  async listTrades() {
    const rows = await this.command<Record<string, string>>(['HGETALL', KEYS.trades]);
    return sortByTime(parseHash<Trade>(rows)).slice(-MAX_TRADES);
  }
  async upsertTrade(trade: Trade) {
    await this.command(['HSET', KEYS.trades, trade.id, JSON.stringify(trade)]);
  }
  async listCycles() {
    const rows = await this.command<Record<string, string>>(['HGETALL', KEYS.cycles]);
    return sortByStart(parseHash<CycleRecord>(rows)).slice(-MAX_CYCLES);
  }
  async upsertCycle(cycle: CycleRecord) {
    await this.command(['HSET', KEYS.cycles, cycle.id, JSON.stringify(cycle)]);
  }
  async listLogs() {
    const rows = await this.command<string[]>(['LRANGE', KEYS.logs, 0, MAX_LOGS - 1]);
    return (rows ?? [])
      .map((r) => {
        try {
          return JSON.parse(r) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((x): x is LogEntry => x !== null)
      .reverse();
  }
  async appendLogs(entries: LogEntry[]) {
    if (entries.length === 0) return;
    await this.command(['LPUSH', KEYS.logs, ...entries.map((e) => JSON.stringify(e))]);
    await this.command(['LTRIM', KEYS.logs, 0, MAX_LOGS - 1]);
  }
  async reset(scope: 'all' | 'trades' | 'cycles' | 'logs') {
    const keys: string[] = [];
    if (scope === 'all' || scope === 'trades') keys.push(KEYS.trades);
    if (scope === 'all' || scope === 'cycles') keys.push(KEYS.cycles);
    if (scope === 'all' || scope === 'logs') keys.push(KEYS.logs);
    if (keys.length > 0) await this.command(['DEL', ...keys]);
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

function sortByTime<T extends { t: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.t - b.t);
}
function sortByStart<T extends { startMs: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.startMs - b.startMs);
}
function trimMap<T>(map: Map<string, T>, max: number) {
  if (map.size <= max) return;
  const drop = map.size - max;
  let i = 0;
  for (const key of map.keys()) {
    if (i++ >= drop) break;
    map.delete(key);
  }
}

let cached: Store | null = null;

export function getStore(): Store {
  if (cached) return cached;
  const url = env.upstashUrl();
  const token = env.upstashToken();
  cached = url && token ? new UpstashStore(url, token) : new MemoryStore();
  return cached;
}
