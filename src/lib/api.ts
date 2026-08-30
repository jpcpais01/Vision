import 'server-only';
import { NextResponse } from 'next/server';
import { env } from './env';

/** Shared request plumbing for every route: auth, errors, no-store headers. */

export const NO_STORE = {
  'cache-control': 'no-store, no-cache, must-revalidate',
} as const;

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data as object, {
    ...init,
    headers: { ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

export function fail(message: string, status = 500, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { error: message, ...(extra ?? {}) },
    { status, headers: NO_STORE }
  );
}

/**
 * Optional shared-secret gate.
 *
 * The dashboard controls real money in LIVE mode, and a Vercel deployment URL
 * is public by default. When `VISION_ACCESS_TOKEN` is set every API call must
 * carry it; when it is unset the app runs open, and the UI says so plainly
 * rather than pretending to be secured.
 */
export function checkAuth(req: Request): { ok: true } | { ok: false; response: NextResponse } {
  const expected = env.accessToken();
  if (!expected) return { ok: true };

  const provided =
    req.headers.get('x-vision-token') ??
    new URL(req.url).searchParams.get('token') ??
    '';

  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, response: fail('unauthorised', 401) };
  }
  return { ok: true };
}

/** Constant-time comparison so the token cannot be discovered byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still burn a comparison so length mismatch is not measurably faster.
    let dummy = 0;
    for (let i = 0; i < b.length; i++) dummy |= b.charCodeAt(i);
    return dummy === -1;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Wrap a handler with auth + uniform error reporting. */
export function handler(
  fn: (req: Request) => Promise<NextResponse>
): (req: Request) => Promise<NextResponse> {
  return async (req: Request) => {
    const auth = checkAuth(req);
    if (!auth.ok) return auth.response;
    try {
      return await fn(req);
    } catch (err) {
      return fail(errorMessage(err), 500);
    }
  };
}

/** Simple per-process rate limit, keyed by route + client address. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

export function clientKey(req: Request, scope: string): string {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local';
  return `${scope}:${ip}`;
}
