// Best-effort per-instance rate shaping only; not a fleet-wide spending cap.
const WINDOW_MS = 60 * 60_000; // 1 hour
const MAX_PER_WINDOW = Number(process.env.DEVSTACK_MCP_RATE_LIMIT || 30);

const hits = new Map(); // ip -> array of timestamps within the current window

function prune(now) {
  // Opportunistic cleanup so the Map doesn't grow unbounded across a warm instance's lifetime.
  if (hits.size < 500) return;
  for (const [ip, arr] of hits) {
    const kept = arr.filter((t) => now - t < WINDOW_MS);
    if (kept.length) hits.set(ip, kept);
    else hits.delete(ip);
  }
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Returns { allowed, remaining, limit } and records the hit if allowed.
export function checkAndConsume(ip) {
  const now = Date.now();
  prune(now);
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(ip, arr);
    return { allowed: false, remaining: 0, limit: MAX_PER_WINDOW };
  }
  arr.push(now);
  hits.set(ip, arr);
  return { allowed: true, remaining: MAX_PER_WINDOW - arr.length, limit: MAX_PER_WINDOW };
}
