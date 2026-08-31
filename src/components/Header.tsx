'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEngineContext } from './EngineProvider';
import { useBot } from '@/hooks/useBot';
import { DEFAULT_STRATEGY, STRATEGIES, isStrategyId } from '@/lib/strategies';
import { cx } from '@/lib/format';
import type { StrategyId } from '@/lib/types';

function strategyFromPath(pathname: string): StrategyId {
  const seg = pathname.split('/')[1];
  return isStrategyId(seg) ? seg : DEFAULT_STRATEGY;
}

/**
 * Shared across every strategy page — Start/Stop and Stop-all act on the one
 * engine underneath all of them, not just whichever bot you're looking at.
 * Deliberately slim: this is the one fixed-height row above a viewport that
 * otherwise belongs entirely to the chart.
 */
export function Header() {
  const pathname = usePathname();
  const strategyId = strategyFromPath(pathname);
  const v = useEngineContext();
  const bot = useBot(strategyId);

  return (
    <header className="relative z-10 mx-auto flex w-full max-w-[900px] shrink-0 items-center gap-2 px-3 py-2">
      <nav className="flex items-center gap-0.5 rounded-lg bg-[var(--chip)] p-0.5">
        {STRATEGIES.map((s) => (
          <Link
            key={s.id}
            href={`/${s.id}`}
            className={cx(
              'rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors',
              s.id === strategyId ? 'bg-[var(--card)] text-[var(--text)] shadow-sm' : 'text-[var(--muted)]'
            )}
          >
            {s.name}
          </Link>
        ))}
      </nav>

      <span
        className="hidden items-center gap-1.5 text-[11px] text-[var(--muted)] sm:flex"
        title="Binance's live trade stream"
      >
        <span
          className={cx(
            'h-1.5 w-1.5 rounded-full',
            bot.connected ? 'bg-[var(--up)] glow-up' : bot.running ? 'bg-[var(--warn)]' : 'bg-[var(--line)]'
          )}
        />
        {bot.connected ? 'live' : bot.running ? 'connecting' : 'offline'}
      </span>
      <span
        className={cx(
          'h-2 w-2 shrink-0 rounded-full sm:hidden',
          bot.connected ? 'bg-[var(--up)]' : bot.running ? 'bg-[var(--warn)]' : 'bg-[var(--line)]'
        )}
        title="Binance connection"
      />

      <div className="ml-auto flex items-center gap-1.5">
        {bot.running ? (
          <button className="btn" onClick={v.stop}>
            Stop
          </button>
        ) : (
          <button className="btn btn-primary" onClick={v.start}>
            Start
          </button>
        )}
        <button
          className={cx('btn', bot.config.killSwitch ? 'btn-warn' : 'btn-danger')}
          onClick={() => void (bot.config.killSwitch ? v.kill(strategyId, false) : v.killAll())}
        >
          {bot.config.killSwitch ? 'Reset' : 'Stop all'}
        </button>
      </div>
    </header>
  );
}
