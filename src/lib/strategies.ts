import type { Direction, StrategyId } from './types';

/**
 * Both strategies watch the exact same thing: how unlikely the live price is,
 * against the shared Monte Carlo simulation, at this second of the cycle.
 * They disagree only on what that unlikeliness means once it crosses the
 * threshold — the entire difference between them is one word, LONG vs SHORT,
 * for which side of the start price the move is on.
 */
export interface StrategyDef {
  id: StrategyId;
  name: string;
  tagline: string;
  blurb: string;
  /** Which way to bet when the live price is above the cycle's start price. */
  directionForAbove: Direction;
}

export const STRATEGIES: StrategyDef[] = [
  {
    id: 'reversion',
    name: 'Reversion',
    tagline: 'Bets against the move',
    blurb:
      "When the price strays further from the cycle's start than the simulation thinks likely, bets it snaps back toward more probable levels.",
    directionForAbove: 'SHORT',
  },
  {
    id: 'momentum',
    name: 'Momentum',
    tagline: 'Bets with the move',
    blurb:
      "When the price strays further from the cycle's start than the simulation thinks likely, bets that something real — not noise — is driving it, and it keeps going.",
    directionForAbove: 'LONG',
  },
];

export const DEFAULT_STRATEGY: StrategyId = STRATEGIES[0].id;

export function isStrategyId(v: unknown): v is StrategyId {
  return typeof v === 'string' && STRATEGIES.some((s) => s.id === v);
}

export function strategyDef(id: StrategyId): StrategyDef {
  return STRATEGIES.find((s) => s.id === id) ?? STRATEGIES[0];
}

/** The one place the two strategies actually differ: which way to bet on an unlikely move. */
export function directionFor(strategyId: StrategyId, priceAboveStart: boolean): Direction {
  const above = strategyDef(strategyId).directionForAbove;
  const below: Direction = above === 'LONG' ? 'SHORT' : 'LONG';
  return priceAboveStart ? above : below;
}
