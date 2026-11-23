// api/health.js — unauthenticated health check.
import { upstreamStatus } from '../lib/tools.js';

export default function handler(req, res) {
  const status = upstreamStatus();
  res.status(200).json({ ok: true, service: 'devstack-mcp', upstream: status.baseUrl ?? null, upstream_status: status });
}
