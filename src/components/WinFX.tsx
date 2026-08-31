'use client';

import { useEffect } from 'react';
import { cx } from '@/lib/format';
import type { WinTier } from '@/lib/sound';

export interface WinFxEvent {
  tier: WinTier;
  /** Unique per firing, so the same tier twice in a row still restarts the animation. */
  key: number;
}

const LABEL: Record<WinTier, string> = {
  big: 'Big win',
  great: 'Great win',
  amazing: 'Amazing win',
};

const DURATION_MS: Record<WinTier, number> = {
  big: 1300,
  great: 1700,
  amazing: 2100,
};

const SPARK_COUNT: Record<WinTier, number> = {
  big: 0,
  great: 8,
  amazing: 16,
};

/** The celebratory overlay for a position's favorable move clearing a multiple
 *  of the fixed 10%-tail distance — see StrategyDashboard's tier-tracking
 *  effect for when this fires. Purely decorative: renders nothing without an
 *  active event, and never blocks a click underneath it. */
export function WinFX({ fx, onDone }: { fx: WinFxEvent | null; onDone: () => void }) {
  useEffect(() => {
    if (!fx) return;
    const id = setTimeout(onDone, DURATION_MS[fx.tier]);
    return () => clearTimeout(id);
  }, [fx, onDone]);

  if (!fx) return null;

  const sparks = SPARK_COUNT[fx.tier];

  return (
    <div
      key={fx.key}
      className={cx('pointer-events-none absolute inset-0 z-30 flex items-center justify-center', `winfx-${fx.tier}`)}
    >
      <div className="winfx-flash" />
      {Array.from({ length: sparks }, (_, i) => (
        <span key={i} className="winfx-spark" style={{ '--angle': `${(360 / sparks) * i}deg` } as React.CSSProperties} />
      ))}
      <div className="winfx-label">{LABEL[fx.tier]}</div>
    </div>
  );
}
