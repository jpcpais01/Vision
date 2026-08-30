import { fail, handler, ok } from '@/lib/api';
import { getStore } from '@/lib/store';
import { calibrationBins, computeMetrics, forecastBrier } from '@/lib/quant/calibration';
import type { CycleRecord, LogEntry, Trade } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The durable record: every trade, every observed cycle, and derived metrics. */
export const GET = handler(async () => {
  const store = getStore();
  const [trades, cycles, logs] = await Promise.all([
    store.listTrades(),
    store.listCycles(),
    store.listLogs(),
  ]);

  return ok({
    trades,
    cycles,
    logs,
    metrics: computeMetrics(trades),
    calibration: calibrationBins(cycles),
    forecastQuality: forecastBrier(cycles),
    storage: store.kind,
    serverTime: Date.now(),
  });
});

interface StateWrite {
  trades?: Trade[];
  cycles?: CycleRecord[];
  logs?: LogEntry[];
}

/**
 * Upsert records from the engine.
 *
 * The browser drives the trading loop, so it is the only party that sees a
 * cycle end to end. It posts completed records here to make them durable —
 * batched, and idempotent by id, so a retry after a dropped connection cannot
 * duplicate a trade in the P&L.
 */
export const POST = handler(async (req) => {
  const store = getStore();
  const body = (await req.json()) as StateWrite;

  const trades = Array.isArray(body.trades) ? body.trades.slice(0, 200) : [];
  const cycles = Array.isArray(body.cycles) ? body.cycles.slice(0, 200) : [];
  const logs = Array.isArray(body.logs) ? body.logs.slice(0, 500) : [];

  if (trades.length === 0 && cycles.length === 0 && logs.length === 0) {
    return fail('nothing to write', 400);
  }

  for (const trade of trades) {
    if (typeof trade?.id === 'string' && trade.id.length > 0) await store.upsertTrade(trade);
  }
  for (const cycle of cycles) {
    if (typeof cycle?.id === 'string' && cycle.id.length > 0) await store.upsertCycle(cycle);
  }
  if (logs.length > 0) await store.appendLogs(logs);

  return ok({ written: { trades: trades.length, cycles: cycles.length, logs: logs.length } });
});
