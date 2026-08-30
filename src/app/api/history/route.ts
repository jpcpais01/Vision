import { handler, ok } from '@/lib/api';
import { history } from '@/lib/binance';
import { volatility } from '@/lib/bars';
import { HISTORY_MIN } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 30 minutes of real 10-second closes from Binance, to seed the chart and volatility. */
export const GET = handler(async (req) => {
  const minutes = Number(new URL(req.url).searchParams.get('minutes')) || HISTORY_MIN;
  const bars = await history(Math.min(120, Math.max(5, minutes)));
  return ok({ bars, vol: volatility(bars) });
});
