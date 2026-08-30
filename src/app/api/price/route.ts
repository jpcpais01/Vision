import { handler, ok } from '@/lib/api';
import { latest } from '@/lib/binance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Current BTC/USD from Binance. Polled once a second by the engine. */
export const GET = handler(async () => ok(await latest()));
