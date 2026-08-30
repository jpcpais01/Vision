'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Engine, type Snapshot } from '@/lib/engine';
import { DEFAULT_CONFIG, sanitize } from '@/lib/config';
import type { Config, Trade, WindowRecord } from '@/lib/types';

export interface Health {
  capabilities: { liveTradingConfigured: boolean; liveTradingAllowed: boolean };
  liveBlockers: string[];
  storage: string;
  storageOk: boolean;
}

const TOKEN_KEY = 'vision:token';

export function useEngine() {
  const ref = useRef<Engine | null>(null);
  const tokenRef = useRef('');
  const [token, setTokenState] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [error, setError] = useState<string | null>(null);

  tokenRef.current = token;
  const headers = useCallback(
    (): Record<string, string> =>
      tokenRef.current ? { 'x-vision-token': tokenRef.current } : {},
    []
  );

  if (ref.current === null && typeof window !== 'undefined') ref.current = new Engine(headers);
  const engine = ref.current;

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(TOKEN_KEY);
      if (saved) setTokenState(saved);
    } catch {
      /* storage disabled */
    }
  }, []);

  const setToken = useCallback((v: string) => {
    setTokenState(v);
    try {
      if (v) sessionStorage.setItem(TOKEN_KEY, v);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage disabled */
    }
  }, []);

  const boot = useCallback(async () => {
    try {
      const h = await fetch('/api/health', { headers: headers(), cache: 'no-store' });
      if (h.status === 401) {
        setNeedsToken(true);
        return;
      }
      setNeedsToken(false);
      if (!h.ok) throw new Error(`health ${h.status}`);
      setHealth((await h.json()) as Health);

      const c = await fetch('/api/config', { headers: headers(), cache: 'no-store' });
      if (c.ok) setConfig(sanitize(((await c.json()) as { config: Config }).config));

      const s = await fetch('/api/state', { headers: headers(), cache: 'no-store' });
      if (s.ok && engine) {
        engine.hydrate((await s.json()) as { trades?: Trade[]; windows?: WindowRecord[] });
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [engine, headers]);

  useEffect(() => {
    void boot();
  }, [boot, token]);

  const snapshot = useSyncExternalStore(
    engine ? engine.subscribe : () => () => undefined,
    engine ? engine.getSnapshot : () => EMPTY,
    () => EMPTY
  );

  const update = useCallback(
    async (patch: Partial<Config>) => {
      const next = sanitize({ ...config, ...patch });
      setConfig(next);
      engine?.setConfig(next);
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers() },
          body: JSON.stringify(next),
        });
        if (res.ok) {
          const server = sanitize(((await res.json()) as { config: Config }).config);
          setConfig(server);
          engine?.setConfig(server);
        }
      } catch {
        // The engine already has it; limits are re-checked server-side per
        // order regardless, so a failed sync cannot loosen anything.
      }
    },
    [config, engine, headers]
  );

  const kill = useCallback(
    async (engaged: boolean) => {
      try {
        await fetch('/api/killswitch', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers() },
          body: JSON.stringify({ engaged }),
        });
      } catch {
        /* the local halt below still applies */
      }
      await update(engaged ? { killSwitch: true, autoTrade: false } : { killSwitch: false });
      if (engaged) {
        engine?.log('warn', 'Kill switch engaged — trading halted');
        engine?.stop();
      }
    },
    [engine, headers, update]
  );

  const reset = useCallback(async () => {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers() },
      body: JSON.stringify({ reset: true }),
    });
    window.location.reload();
  }, [headers]);

  return {
    engine,
    snapshot,
    config,
    health,
    error,
    needsToken,
    token,
    setToken,
    update,
    kill,
    reset,
    start: () => engine?.start(config),
    stop: () => engine?.stop(),
  };
}

const EMPTY: Snapshot = {
  running: false,
  config: DEFAULT_CONFIG,
  connected: false,
  feedError: null,
  price: null,
  priceAt: 0,
  chainlinkGap: null,
  chainlinkLive: false,
  ticks: [],
  volPct: null,
  volPct15: null,
  cycle: {
    market: null,
    phase: 'stopped',
    barrier: null,
    barrierSource: null,
    sim: null,
    askUp: null,
    askDown: null,
    edgeUp: null,
    edgeDown: null,
    tradeId: null,
    skipReason: null,
    track: [],
  },
  secondsLeft: null,
  secondsToOpen: null,
  calibratingSecondsLeft: null,
  quotes: { up: { bid: null, ask: null, askSize: 0 }, down: { bid: null, ask: null, askSize: 0 } },
  trades: [],
  windows: [],
  logs: [],
  stats: {
    trades: 0,
    wins: 0,
    losses: 0,
    open: 0,
    winRate: 0,
    pnl: 0,
    today: 0,
    windows: 0,
    brier: null,
    scored: 0,
  },
};
