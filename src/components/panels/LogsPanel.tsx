'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry, LogLevel } from '@/lib/types';
import { Empty } from '@/components/ui/Primitives';
import { cx, timeMs } from '@/lib/format';

const LEVEL_STYLE: Record<LogLevel, string> = {
  debug: 'text-slate-600',
  info: 'text-slate-400',
  warn: 'text-warn',
  error: 'text-down',
  trade: 'text-accent',
};

/** Rolling event log with level filtering and follow-tail. */
export function LogsPanel({ logs }: { logs: LogEntry[] }) {
  const [levels, setLevels] = useState<Set<LogLevel>>(
    () => new Set<LogLevel>(['info', 'warn', 'error', 'trade'])
  );
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => logs.filter((l) => levels.has(l.level)), [logs, levels]);

  useEffect(() => {
    if (follow && scroller.current) {
      scroller.current.scrollTop = scroller.current.scrollHeight;
    }
  }, [filtered.length, follow]);

  const toggle = (level: LogLevel) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {(['trade', 'info', 'warn', 'error', 'debug'] as LogLevel[]).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => toggle(l)}
            className={cx(
              'rounded border px-1.5 py-0.5 text-2xs capitalize transition-colors',
              levels.has(l)
                ? 'border-base-600 bg-base-800 text-slate-300'
                : 'border-base-800 text-slate-600'
            )}
          >
            {l}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setFollow((f) => !f)}
          className={cx(
            'ml-auto rounded border px-1.5 py-0.5 text-2xs transition-colors',
            follow
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-base-700 text-slate-500'
          )}
        >
          {follow ? 'following' : 'paused'}
        </button>
      </div>

      <div
        ref={scroller}
        className="scroll-thin min-h-[140px] flex-1 overflow-y-auto rounded-md border border-base-800 bg-base-950/60 p-2 font-mono text-[10.5px] leading-relaxed"
        onWheel={() => setFollow(false)}
      >
        {filtered.length === 0 ? (
          <Empty>No log entries at these levels.</Empty>
        ) : (
          filtered.map((l) => (
            <div key={l.id} className="flex gap-2 py-px">
              <span className="shrink-0 text-slate-600">{timeMs(l.t)}</span>
              <span className="w-16 shrink-0 truncate text-slate-600">{l.scope}</span>
              <span className={cx('min-w-0 break-words', LEVEL_STYLE[l.level])}>
                {l.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
