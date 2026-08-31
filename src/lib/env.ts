// Server-only environment access. Importing this from a client component is a
// build error by design — every secret in the system is read through here.
import 'server-only';

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const env = {
  // Access control
  accessToken: () => str('VISION_ACCESS_TOKEN'),

  // Storage
  upstashUrl: () => str('UPSTASH_REDIS_REST_URL').replace(/\/+$/, ''),
  upstashToken: () => str('UPSTASH_REDIS_REST_TOKEN'),
};

/** Capability report surfaced by /api/health so the UI can explain gaps. */
export function capabilities() {
  return {
    durableStorage: env.upstashUrl().length > 0 && env.upstashToken().length > 0,
    accessControl: env.accessToken().length > 0,
  };
}
