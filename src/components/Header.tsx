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
 */
export function Header() {
  const pathname = usePathname();
  const strategyId = strategyFromPath(pathname);
  const v = useEngineContext();
  const bot = useBot(strategyId);

  return (
    <header className="mx-auto flex w-full max-w-[880px] flex-wrap items-center gap-3 px-4 pt-5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent)] text-[13px] font-bold text-white">
          V
        </span>
        <span className="text-[15px] font-semibold tracking-tight">Vision</span>
        <span className="rounded-md bg-[var(--accent-bg)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--accent)]">
          Paper
        </span>
      </div>

      <nav className="flex items-center gap-1 rounded-lg bg-[var(--chip)] p-1">
        {STRATEGIES.map((s) => (
          <Link
            key={s.id}
            href={`/${s.id}`}
            className={cx(
              'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              s.id === strategyId ? 'bg-[var(--card)] text-[var(--text)] shadow-sm' : 'text-[var(--muted)]'
            )}
          >
            {s.name}
          </Link>
        ))}
      </nav>

      <span className="flex items-center gap-1.5 text-xs text-[var(--muted)]" title="Binance's live trade stream">
        <span
          className={cx(
            'h-1.5 w-1.5 rounded-full',
            bot.connected ? 'bg-[var(--up)]' : bot.running ? 'bg-[var(--warn)]' : 'bg-[var(--line)]'
          )}
        />
        Binance {bot.connected ? 'live' : bot.running ? 'connecting' : 'offline'}
      </span>

      <div className="ml-auto flex items-center gap-2">
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
          {bot.config.killSwitch ? 'Reset stop' : 'Stop all'}
        </button>
      </div>
    </header>
  );
}
