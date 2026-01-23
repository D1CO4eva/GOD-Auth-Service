import { sendError } from '../utils/respond.mjs';

export function createRateLimiter({ windowSeconds, maxRequests }) {
  const windowMs = windowSeconds * 1000;
  const store = new Map();
  let lastCleanup = Date.now();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';

    if (now - lastCleanup > windowMs) {
      for (const [key, entry] of store.entries()) {
        if (now - entry.windowStart > windowMs) {
          store.delete(key);
        }
      }
      lastCleanup = now;
    }

    const entry = store.get(ip);
    if (!entry || now - entry.windowStart > windowMs) {
      store.set(ip, { windowStart: now, count: 1 });
      return next();
    }

    if (entry.count >= maxRequests) {
      // Do not reveal rate-limit internals to the client.
      return sendError(res, 429, 'rate_limited');
    }

    entry.count += 1;
    return next();
  };
}