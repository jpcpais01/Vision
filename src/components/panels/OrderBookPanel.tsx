'use client';

import type { BookQuote, OrderBook, Side } from '@/lib/types';
import { Badge, Empty } from '@/components/ui/Primitives';
import { compact, cx, price as fmtPrice, pct, usd } from '@/lib/format';

/**
 * The executable book for both sides, five levels deep.
 *
 * Depth bars are scaled to the largest level on screen, so the shape of the
 * book — where the real size is sitting — is visible at a glance. The touch is
 * highlighted because that is the only price a marketable order actually gets.
 */
export function OrderBookPanel({
  upBook,
  downBook,
  upQuote,
  downQuote,
  modelPUp,
}: {
  upBook: OrderBook | null;
  downBook: OrderBook | null;
  upQuote: BookQuote | null;
  downQuote: BookQuote | null;
  modelPUp: number | null;
}) {
  if (!upBook && !downBook) {
    return <Empty>Waiting for the CLOB order book…</Empty>;
  }

  return (
    <div className="grid grid-cols-2 gap-3">
      <BookSide side="UP" book={upBook} quote={upQuote} modelP={modelPUp} />
      <BookSide
        side="DOWN"
        book={downBook}
        quote={downQuote}
        modelP={modelPUp === null ? null : 1 - modelPUp}
      />
    </div>
  );
}

function BookSide({
  side,
  book,
  quote,
  modelP,
}: {
  side: Side;
  book: OrderBook | null;
  quote: BookQuote | null;
  modelP: number | null;
}) {
  const isUp = side === 'UP';
  const asks = (book?.asks ?? []).slice(0, 5);
  const bids = (book?.bids ?? []).slice(0, 5);
  const maxSize = Math.max(1, ...asks.map((l) => l.size), ...bids.map((l) => l.size));
  const edge = modelP !== null && quote?.ask != null ? modelP - quote.ask : null;

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span
          className={cx(
            'text-2xs font-semibold uppercase tracking-wider',
            isUp ? 'text-up' : 'text-down'
          )}
        >
          {side}
        </span>
        {edge !== null ? (
          <Badge tone={edge > 0 ? 'up' : 'muted'} title="Model probability minus the ask">
            edge {edge >= 0 ? '+' : ''}
            {(edge * 100).toFixed(1)}¢
          </Badge>
        ) : null}
      </div>

      <div className="space-y-px">
        {/* Asks descend toward the touch, as on any trading ladder. */}
        {[...asks].reverse().map((l, i) => (
          <Level
            key={`a${l.price}-${i}`}
            price={l.price}
            size={l.size}
            maxSize={maxSize}
            tone="ask"
            isTouch={i === asks.length - 1}
          />
        ))}

        <div className="flex items-baseline justify-between border-y border-base-700/60 px-1 py-1">
          <span className="text-2xs text-slate-500">spread</span>
          <span className="tnum text-2xs font-medium text-slate-300">
            {quote?.spread != null ? `${(quote.spread * 100).toFixed(1)}¢` : '—'}
          </span>
          <span className="tnum text-2xs text-slate-500">
            mid {quote?.mid != null ? fmtPrice(quote.mid, 3) : '—'}
          </span>
        </div>

        {bids.map((l, i) => (
          <Level
            key={`b${l.price}-${i}`}
            price={l.price}
            size={l.size}
            maxSize={maxSize}
            tone="bid"
            isTouch={i === 0}
          />
        ))}
        {asks.length === 0 && bids.length === 0 ? (
          <div className="py-3 text-center text-2xs text-slate-600">empty book</div>
        ) : null}
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-2xs">
        <dt className="text-slate-500">Ask depth</dt>
        <dd className="tnum text-right text-slate-300">{usd(quote?.askDepthUsd ?? 0, 0)}</dd>
        <dt className="text-slate-500">Implied</dt>
        <dd className="tnum text-right text-slate-300">
          {quote?.ask != null ? pct(quote.ask, 1) : '—'}
        </dd>
      </dl>
    </div>
  );
}

function Level({
  price,
  size,
  maxSize,
  tone,
  isTouch,
}: {
  price: number;
  size: number;
  maxSize: number;
  tone: 'bid' | 'ask';
  isTouch: boolean;
}) {
  const width = Math.max(2, (size / maxSize) * 100);
  const isBid = tone === 'bid';
  return (
    <div
      className={cx(
        'relative flex items-center justify-between overflow-hidden rounded-sm px-1 py-0.5 text-2xs',
        isTouch && 'ring-1 ring-inset ring-base-600'
      )}
    >
      <div
        className={cx('absolute inset-y-0 right-0 rounded-sm', isBid ? 'bg-up/15' : 'bg-down/15')}
        style={{ width: `${width}%` }}
      />
      <span className={cx('tnum relative font-medium', isBid ? 'text-up' : 'text-down')}>
        {fmtPrice(price, 3)}
      </span>
      <span className="tnum relative text-slate-400">{compact(size)}</span>
    </div>
  );
}
