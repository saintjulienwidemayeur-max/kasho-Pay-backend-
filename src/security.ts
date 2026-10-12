// Security helpers with no third-party dependency (so they can be unit tested anywhere).

// ------------------------------------------------------------ rate limiting
type Bucket = { count: number; resetAt: number };

/**
 * Fixed-window in-memory rate limiter. `key` decides who is counted (IP, user id, ...).
 * Works for a single server process. Behind several instances use a shared store (Redis).
 */
export function createRateLimiter(opts: { windowMs: number; max: number; key: (req: any) => string; message?: string }) {
  const buckets = new Map<string, Bucket>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.max(opts.windowMs, 10_000));
  (sweep as any).unref?.();

  const middleware = (req: any, res: any, next: any) => {
    const now = Date.now();
    const k = opts.key(req);
    let b = buckets.get(k);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(k, b);
    }
    b.count += 1;
    const remaining = Math.max(0, opts.max - b.count);
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    if (b.count > opts.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))));
      return res.status(429).json({ error: { message: opts.message ?? "Too many requests. Please wait a moment and try again." } });
    }
    return next();
  };
  (middleware as any).size = () => buckets.size;
  return middleware as typeof middleware & { size: () => number };
}

// ------------------------------------------------------------ handler lookup
/** Own-property lookup only: "constructor", "__proto__", "toString"... must never resolve to a handler. */
export function getHandler<T>(map: Record<string, T>, name: unknown): T | undefined {
  if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) return undefined;
  return Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
}

// ------------------------------------------------------------ storage paths (KYC uploads)
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

/** A KYC file must live directly in the caller's own folder: "<userId>/<file>", no traversal. */
export function isOwnStoragePath(path: unknown, userId: string): path is string {
  if (typeof path !== "string" || !userId) return false;
  const parts = path.split("/");
  if (parts.length !== 2 || parts[0] !== userId) return false;
  const file = parts[1]!;
  return SAFE_FILE.test(file) && !file.includes("..");
}

// ------------------------------------------------------------ headers
export function securityHeaders(production: boolean) {
  return (_req: any, res: any, next: any) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (production) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

/** API answers carry card numbers, balances, ...: never let a browser or proxy cache them. */
export function noStore(_req: any, res: any, next: any) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  next();
}

// ------------------------------------------------------------ misc
export function bearerToken(header: string | undefined | null): string | null {
  const m = /^Bearer ([A-Za-z0-9._~+\/=-]{10,4096})$/.exec(header ?? "");
  return m ? m[1]! : null;
}

export function isJsonRequest(contentType: string | undefined | null): boolean {
  return /^application\/json(\s*;.*)?$/i.test(contentType ?? "");
}

/** Origin allow-list. LAN/localhost origins are accepted only outside production. */
export function makeOriginCheck(allowed: string[], allowLan: boolean) {
  const lan = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/;
  return (origin: string | undefined): boolean => !origin || allowed.includes(origin) || (allowLan && lan.test(origin));
}
