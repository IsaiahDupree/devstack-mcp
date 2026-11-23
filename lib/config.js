// Cloud calls are disabled unless an operator explicitly authorizes the exact
// workload. A loopback upstream must itself enforce provider spending limits.
export function upstreamConfig(env = process.env) {
  const raw = env.DEVSTACK_MCP_API_BASE_URL?.trim();
  if (!raw) return { ok: false, reason: 'upstream_not_configured' };
  let url;
  try { url = new URL(raw); } catch { return { ok: false, reason: 'invalid_upstream_url' }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    return { ok: false, reason: 'invalid_upstream_url' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!local && url.protocol !== 'https:') return { ok: false, reason: 'remote_https_required' };
  if (!local && env.DEVSTACK_MCP_ALLOW_REMOTE_UPSTREAM !== '1') {
    return { ok: false, reason: 'remote_upstream_disabled' };
  }
  return { ok: true, baseUrl: url.origin, kind: local ? 'loopback' : 'remote' };
}
