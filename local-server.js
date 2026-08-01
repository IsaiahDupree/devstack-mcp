// local-server.js — a tiny plain-Node http server that mimics the parts of the
// Vercel Node serverless request/response contract our api/*.js handlers rely on
// (req.body pre-parsed as JSON for POST, res.status().json()). Used for local
// dev (`npm run dev`) and the smoke test (`npm run smoke`) — not deployed.

import http from 'node:http';
import { URL } from 'node:url';
import mcpHandler from './api/mcp.js';
import healthHandler from './api/health.js';

const PORT = Number(process.env.PORT || 3900);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function withVercelHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  withVercelHelpers(res);
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (pathname === '/mcp' || pathname === '/api/mcp') {
      if (req.method === 'POST') {
        const raw = await readBody(req);
        req.body = raw ? JSON.parse(raw) : undefined;
      }
      return await mcpHandler(req, res);
    }
    if (pathname === '/health' || pathname === '/api/health') {
      return await healthHandler(req, res);
    }
    res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${pathname}` } });
  } catch (err) {
    console.error('[local-server] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { code: 'internal', message: String(err.message || err) } });
    }
  }
});

server.listen(PORT, () => {
  console.log(`devstack-mcp local dev server listening on http://localhost:${PORT}`);
  console.log(`  MCP endpoint:    http://localhost:${PORT}/mcp`);
  console.log(`  Health endpoint: http://localhost:${PORT}/health`);
  console.log(`  Upstream:        ${process.env.DEVSTACK_MCP_API_BASE_URL || 'https://devstack-api.vercel.app'}`);
});
