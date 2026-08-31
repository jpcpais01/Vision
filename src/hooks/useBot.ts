'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useEngineContext } from '@/components/EngineProvider';
import { emptySnapshot, type BotSnapshot } from '@/lib/engine';
import type { StrategyId } from '@/lib/types';

/** This one strategy's live snapshot: its own config, position, history — plus the market data every bot shares. */
export function useBot(strategyId: StrategyId): BotSnapshot {
  const { engine } = useEngineContext();

  const subscribe = engine ? engine.subscribe : () => () => undefined;
  const getSnapshot = useCallback(
    () => (engine ? engine.getSnapshot(strategyId) : emptySnapshot(strategyId)),
    [engine, strategyId]
  );
  const getServerSnapshot = useCallback(() => emptySnapshot(strategyId), [strategyId]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
