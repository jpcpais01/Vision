/** Small fetch helper with timeout, retry and typed JSON, shared by all routes. */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Number of additional attempts after the first. */
  retries?: number;
  /** Base backoff in ms; doubled per attempt with jitter. */
  backoffMs?: number;
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 8000, retries = 1, backoffMs = 250, ...init } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        cache: 'no-store',
        headers: { accept: 'application/json', ...(init.headers ?? {}) },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        // 4xx other than 429 will not fix themselves — fail fast.
        if (res.status < 500 && res.status !== 429) {
          throw new HttpError(`${res.status} ${res.statusText}`, res.status, body.slice(0, 500));
        }
        throw new HttpError(`${res.status} ${res.statusText}`, res.status, body.slice(0, 500));
      }
      return (await res.json()) as T;
    } catch (err) {
      lastError = err;
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      if (attempt < retries) {
        const wait = backoffMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
        await sleep(wait);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a set of promises, returning the first to fulfil; rejects only if all do. */
export async function firstSuccess<T>(
  factories: (() => Promise<T>)[]
): Promise<{ value: T; index: number }> {
  const errors: unknown[] = [];
  for (let i = 0; i < factories.length; i++) {
    try {
      return { value: await factories[i](), index: i };
    } catch (err) {
      errors.push(err);
    }
  }
  const detail = errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
  throw new Error(`all sources failed: ${detail}`);
}
