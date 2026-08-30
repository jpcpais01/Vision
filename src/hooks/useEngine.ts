'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { TradingEngine, type EngineSnapshot } from '@/lib/engine/engine';
import { DEFAULT_CONFIG, sanitizeConfig } from '@/lib/config';
import type { TradingConfig } from '@/lib/types';

export interface HealthInfo {
  capabilities: {
    llm: boolean;
    liveTradingConfigured: boolean;
    liveTradingAllowed: boolean;
    chainlink: boolean;
    durableStorage: boolean;
    accessControl: boolean;
    model: string;
  };
  liveBlockers: string[];
  storage: string;
  storageOk: boolean;
  storageLatencyMs: number;
  storageError: string | null;
  endpoints: Record<string, unknown>;
}

const TOKEN_KEY = 'vision:access-token';

/**
 * Owns the engine instance and everything around it: the access token, the
 * server-held config, the durable record, and the start/stop lifecycle.
 *
 * The engine itself is created once and lives for the page's lifetime — it
 * holds an hour of tick history that would be expensive to rebuild, so it must
 * survive re-renders and even a stop/start of the trading loop.
 */
export function useEngine() {
  const engineRef = useRef<TradingEngine | null>(null);
  const [token, setTokenState] = useState<string>('');
  const [authRequired, setAuthRequired] = useState(false);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [config, setConfigState] = useState<TradingConfig>(DEFAULT_CONFIG);
  const [booting, setBooting] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);

  const tokenRef = useRef('');
  tokenRef.current = token;

  const getHeaders = useCallback((): Record<string, string> => {
    return tokenRef.current ? { 'x-vision-token': tokenRef.current } : {};
  }, []);

  if (engineRef.current === null && typeof window !== 'undefined') {
    engineRef.current = new TradingEngine({ getHeaders });
  }
  const engine = engineRef.current;

  // Restore a previously entered token before the first request goes out.
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TOKEN_KEY);
      if (saved) setTokenState(saved);
    } catch {
      /* private mode or storage disabled — the user can re-enter it */
    }
  }, []);

  const setToken = useCallback((value: string) => {
    setTokenState(value);
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* non-fatal */
    }
  }, []);

  /** Load capabilities, config and the durable record. */
  const boot = useCallback(async () => {
    setBooting(true);
    try {
      const healthRes = await fetch('/api/health', { headers: getHeaders(), cache: 'no-store' });
      if (healthRes.status === 401) {
        setAuthRequired(true);
        setBooting(false);
        return;
      }
      if (!healthRes.ok) throw new Error(`health ${healthRes.status}`);
      setAuthRequired(false);
      setHealth((await healthRes.json()) as HealthInfo);

      const configRes = await fetch('/api/config', { headers: getHeaders(), cache: 'no-store' });
      if (configRes.ok) {
        const data = (await configRes.json()) as { config: TradingConfig };
        setConfigState(sanitizeConfig(data.config));
      }

      const stateRes = await fetch('/api/state', { headers: getHeaders(), cache: 'no-store' });
      if (stateRes.ok && engine) {
        const data = await stateRes.json();
        engine.hydrate({ trades: data.trades, cycles: data.cycles, logs: data.logs });
      }
      setFatal(null);
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
    } finally {
      setBooting(false);
    }
  }, [engine, getHeaders]);

  useEffect(() => {
    void boot();
    // Re-boot when the token changes so a freshly entered token takes effect.
  }, [boot, token]);

  const snapshot = useSyncExternalStore(
    engine ? engine.subscribe : noopSubscribe,
    engine ? engine.getSnapshot : getServerSnapshot,
    getServerSnapshot
  );

  /** Persist a config change to the server, then apply it to the engine. */
  const updateConfig = useCallback(
    async (patch: Partial<TradingConfig>) => {
      const next = sanitizeConfig({ ...config, ...patch });
      setConfigState(next);
      engine?.setConfig(next);
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...getHeaders() },
          body: JSON.stringify(next),
        });
        if (res.ok) {
          const data = (await res.json()) as { config: TradingConfig };
          const server = sanitizeConfig(data.config);
          setConfigState(server);
          engine?.setConfig(server);
        }
      } catch {
        // The engine already has the change; the server copy retries on the
        // next edit. Trading limits are re-checked server-side per order
        // regardless, so a failed sync cannot loosen anything.
      }
    },
    [config, engine, getHeaders]
  );

  const start = useCallback(async () => {
    if (!engine) return;
    await engine.start(config);
  }, [engine, config]);

  const stop = useCallback(() => engine?.stop(), [engine]);

  /** Emergency stop: server flag + cancel resting orders + halt the loop. */
  const engageKillSwitch = useCallback(
    async (engaged: boolean) => {
      try {
        await fetch('/api/killswitch', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...getHeaders() },
          body: JSON.stringify({ engaged }),
        });
      } catch {
        /* the local halt below still applies */
      }
      const patch: Partial<TradingConfig> = engaged
        ? { killSwitch: true, autoTrade: false }
        : { killSwitch: false };
      await updateConfig(patch);
      if (engaged) {
        engine?.log('warn', 'risk', 'KILL SWITCH ENGAGED — auto-trading halted');
        engine?.stop();
      }
    },
    [engine, getHeaders, updateConfig]
  );

  const resetRecords = useCallback(
    async (scope: 'all' | 'trades' | 'cycles' | 'logs') => {
      await fetch('/api/state/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ scope }),
      });
      window.location.reload();
    },
    [getHeaders]
  );

  const liveBlockers = useMemo(() => health?.liveBlockers ?? [], [health]);

  return {
    engine,
    snapshot,
    config,
    health,
    liveBlockers,
    booting,
    fatal,
    authRequired,
    token,
    setToken,
    updateConfig,
    start,
    stop,
    engageKillSwitch,
    resetRecords,
    reload: boot,
  };
}

function noopSubscribe() {
  return () => undefined;
}

/** SSR snapshot: an inert engine state so the first paint matches the client. */
function getServerSnapshot(): EngineSnapshot {
  return SERVER_SNAPSHOT;
}

const SERVER_SNAPSHOT: EngineSnapshot = {
  running: false,
  config: DEFAULT_CONFIG,
  now: 0,
  priceStatus: {
    mode: 'disconnected',
    source: 'none',
    lastMessageAt: 0,
    reconnects: 0,
    error: null,
  },
  bookStatus: {
    mode: 'disconnected',
    source: 'none',
    lastMessageAt: 0,
    reconnects: 0,
    error: null,
  },
  btc: null,
  btcAt: 0,
  chainlink: null,
  bars: [],
  recentTicks: [],
  vol: null,
  historyReady: false,
  interpolatedFeed: false,
  market: null,
  upcoming: [],
  books: {},
  quotes: {},
  upTokenId: null,
  downTokenId: null,
  cycle: {
    market: null,
    phase: 'idle',
    startPrice: null,
    startPriceSource: null,
    startPriceCapturedAt: null,
    llm: null,
    llmError: null,
    llmDispatchedAt: null,
    llmPriceAtDispatch: null,
    pathDuringLlm: [],
    mc: null,
    finalPUp: null,
    vol: null,
    decision: null,
    tradeId: null,
    history: [],
    decisionLatencyMs: null,
  },
  secondsLeft: null,
  elapsedSec: null,
  trades: [],
  cycles: [],
  logs: [],
  metrics: {
    trades: 0,
    resolved: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    pnl: 0,
    turnover: 0,
    roi: 0,
    avgEdge: 0,
    brier: 0,
    brierBaseline: 0.25,
    brierSkill: 0,
    calibrationError: 0,
    logLoss: 0,
    maxDrawdown: 0,
    sharpe: 0,
    bestTrade: 0,
    worstTrade: 0,
    currentStreak: 0,
  },
  errors: [],
};
