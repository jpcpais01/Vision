'use client';

import type { ReactNode } from 'react';
import { cx } from '@/lib/format';

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  subtitle,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cx('panel flex flex-col', className)}>
      <header className="panel-header">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="panel-title">{title}</h2>
          {subtitle ? (
            <span className="truncate text-2xs text-slate-500">{subtitle}</span>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
      </header>
      <div className={cx('panel-body flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
  size = 'md',
  title,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'accent' | 'warn' | 'muted';
  size?: 'sm' | 'md' | 'lg';
  title?: string;
}) {
  const toneClass = {
    neutral: 'text-slate-100',
    up: 'text-up',
    down: 'text-down',
    accent: 'text-accent',
    warn: 'text-warn',
    muted: 'text-slate-500',
  }[tone];
  const sizeClass = { sm: 'text-sm', md: 'text-lg', lg: 'text-2xl' }[size];

  return (
    <div className="min-w-0" title={title}>
      <div className="label truncate">{label}</div>
      <div className={cx('tnum mt-0.5 font-semibold leading-tight', toneClass, sizeClass)}>
        {value}
      </div>
      {sub ? <div className="tnum mt-0.5 truncate text-2xs text-slate-500">{sub}</div> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'accent' | 'warn' | 'muted';
  title?: string;
}) {
  const cls = {
    neutral: 'border-base-600 bg-base-800/70 text-slate-300',
    up: 'border-up/40 bg-up/10 text-up',
    down: 'border-down/40 bg-down/10 text-down',
    accent: 'border-accent/40 bg-accent/10 text-accent',
    warn: 'border-warn/40 bg-warn/10 text-warn',
    muted: 'border-base-700 bg-base-850/60 text-slate-500',
  }[tone];
  return (
    <span className={cx('chip', cls)} title={title}>
      {children}
    </span>
  );
}

export function Dot({ tone }: { tone: 'up' | 'down' | 'warn' | 'muted' | 'accent' }) {
  const cls = {
    up: 'bg-up',
    down: 'bg-down',
    warn: 'bg-warn',
    accent: 'bg-accent',
    muted: 'bg-slate-600',
  }[tone];
  return <span className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', cls)} />;
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  tone = 'accent',
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  tone?: 'accent' | 'up' | 'down';
  title?: string;
}) {
  const onCls = { accent: 'bg-accent/70', up: 'bg-up/70', down: 'bg-down/70' }[tone];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'flex items-center gap-2 text-xs transition-opacity',
        disabled && 'cursor-not-allowed opacity-40'
      )}
    >
      <span
        className={cx(
          'relative h-4 w-7 shrink-0 rounded-full transition-colors',
          checked ? onCls : 'bg-base-600'
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          )}
        />
      </span>
      <span className={checked ? 'text-slate-200' : 'text-slate-500'}>{label}</span>
    </button>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  suffix,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block" title={hint}>
      <span className="label mb-1 flex items-center justify-between gap-2">
        <span className="truncate">{label}</span>
        {suffix ? <span className="normal-case text-slate-600">{suffix}</span> : null}
      </span>
      <input
        type="number"
        className="field"
        value={Number.isFinite(value) ? value : ''}
        step={step}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="block" title={hint}>
      <span className="label mb-1 truncate">{label}</span>
      <select
        className="field"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[80px] items-center justify-center px-4 text-center text-2xs text-slate-600">
      {children}
    </div>
  );
}

/** Horizontal bar used for probability comparisons. */
export function ProbBar({
  value,
  tone = 'accent',
  marker,
  markerLabel,
}: {
  value: number;
  tone?: 'up' | 'down' | 'accent' | 'warn';
  marker?: number | null;
  markerLabel?: string;
}) {
  const cls = { up: 'bg-up', down: 'bg-down', accent: 'bg-accent', warn: 'bg-warn' }[tone];
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="relative h-1.5 w-full overflow-visible rounded-full bg-base-700">
      <div
        className={cx('h-full rounded-full transition-[width] duration-500', cls)}
        style={{ width: `${v * 100}%` }}
      />
      {marker !== null && marker !== undefined && Number.isFinite(marker) ? (
        <div
          className="absolute -top-0.5 h-2.5 w-0.5 rounded-full bg-slate-300"
          style={{ left: `${Math.max(0, Math.min(1, marker)) * 100}%` }}
          title={markerLabel}
        />
      ) : null}
    </div>
  );
}
