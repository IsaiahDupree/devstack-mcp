// api/health.js — unauthenticated health check.
import { BASE_URL_FOR_HEALTH } from '../lib/tools.js';

export default function handler(req, res) {
  res.status(200).json({ ok: true, service: 'devstack-mcp', upstream: BASE_URL_FOR_HEALTH });
}
