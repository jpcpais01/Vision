'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Engine } from '@/lib/engine';
import { sanitize } from '@/lib/config';
import { primeSound } from '@/lib/sound';
import { STRATEGIES } from '@/lib/strategies';
import type { Config, CycleRecord, Position, StrategyId } from '@/lib/types';

/**
 * One Engine instance for the whole app, created here at the root layout so
 * it survives client-side navigation between strategy pages — every bot
 * keeps trading regardless of which one you're looking at. A page-scoped
 * instance would tear the engine down (and every bot with it) on every
 * `/reversion` ↔ `/momentum` switch.
 */

export interface Health {
  storage: string;
  storageOk: boolean;
}

interface EngineContextValue {
  engine: Engine | null;
  health: Health | null;
  error: string | null;
  needsToken: boolean;
  token: string;
  setToken: (v: string) => void;
  start: () => void;
  stop: () => void;
  update: (strategyId: StrategyId, patch: Partial<Config>) => Promise<void>;
  kill: (strategyId: StrategyId, engaged: boolean) => Promise<void>;
  killAll: () => Promise<void>;
  reset: (strategyId: StrategyId) => Promise<void>;
}

const EngineContext = createContext<EngineContextValue | null>(null);

const TOKEN_KEY = 'vision:token';

export function EngineProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<Engine | null>(null);
  const tokenRef = useRef('');
  const [token, setTokenState] = useState('');
  const [needsToken, setNeedsToken] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  tokenRef.current = token;
  const headers = useCallback(
    (): Record<string, string> => (tokenRef.current ? { 'x-vision-token': tokenRef.current } : {}),
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
    if (!engine) return;
    try {
      const h = await fetch('/api/health', { headers: headers(), cache: 'no-store' });
      if (h.status === 401) {
        setNeedsToken(true);
        return;
      }
      setNeedsToken(false);
      if (!h.ok) throw new Error(`health ${h.status}`);
      setHealth((await h.json()) as Health);

      // Every strategy's config and history is loaded up front, not lazily
      // per page visit — each bot keeps running whether or not its page is
      // the one currently open.
      await Promise.all(
        STRATEGIES.map(async ({ id }) => {
          const c = await fetch(`/api/config/${id}`, { headers: headers(), cache: 'no-store' });
          if (c.ok) engine.setConfig(id, sanitize(((await c.json()) as { config: Config }).config));

          const s = await fetch(`/api/state/${id}`, { headers: headers(), cache: 'no-store' });
          if (s.ok) engine.hydrate(id, (await s.json()) as { positions?: Position[]; cycles?: CycleRecord[] });
        })
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [engine, headers]);

  useEffect(() => {
    void boot();
  }, [boot, token]);

  const update = useCallback(
    async (strategyId: StrategyId, patch: Partial<Config>) => {
      if (!engine) return;
      const current = engine.getSnapshot(strategyId).config;
      const next = sanitize({ ...current, ...patch });
      engine.setConfig(strategyId, next);
      try {
        const res = await fetch(`/api/config/${strategyId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers() },
          body: JSON.stringify(next),
        });
        if (res.ok) {
          const server = sanitize(((await res.json()) as { config: Config }).config);
          engine.setConfig(strategyId, server);
        }
      } catch {
        // The engine already has it; limits are re-checked server-side too,
        // so a failed sync cannot loosen anything.
      }
    },
    [engine, headers]
  );

  const kill = useCallback(
    async (strategyId: StrategyId, engaged: boolean) => {
      await update(strategyId, engaged ? { killSwitch: true, autoTrade: false } : { killSwitch: false });
    },
    [update]
  );

  const killAll = useCallback(async () => {
    await Promise.all(STRATEGIES.map(({ id }) => kill(id, true)));
    engine?.log('warn', 'Stop all — every bot halted');
    engine?.stop();
  }, [engine, kill]);

  const reset = useCallback(
    async (strategyId: StrategyId) => {
      await fetch(`/api/state/${strategyId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers() },
        body: JSON.stringify({ reset: true }),
      });
      window.location.reload();
    },
    [headers]
  );

  const value: EngineContextValue = {
    engine,
    health,
    error,
    needsToken,
    token,
    setToken,
    start: () => {
      primeSound(); // must happen inside this click's own call stack, or the browser blocks audio later
      void engine?.start();
    },
    stop: () => engine?.stop(),
    update,
    kill,
    killAll,
    reset,
  };

  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngineContext(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error('useEngineContext must be used within EngineProvider');
  return ctx;
}
