import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from '../lib/tools.js';
import { clientIp, checkAndConsume } from '../lib/ratelimit.js';
import { createHash, timingSafeEqual } from 'node:crypto';

function authorized(req, secret) {
  const value = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
  const digest = s => createHash('sha256').update(s).digest();
  return value.length > 0 && timingSafeEqual(digest(value), digest(secret));
}

export default async function handler(req, res) {
  // Streamable-HTTP stateless servers only accept POST; GET/SSE-resume and
  // DELETE/session-teardown don't apply since there is no session state.
  if (req.method === 'GET' || req.method === 'DELETE') {
    return res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed (stateless server)' },
      id: null,
    });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    });
  }

  const secret = process.env.DEVSTACK_MCP_CLIENT_TOKEN || '';
  if (Buffer.byteLength(secret, 'utf8') < 32) return res.status(503).json({ error: { code: 'auth_not_configured', message: 'MCP access is not configured.' } });
  if (!authorized(req, secret)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: { code: 'unauthorized', message: 'Valid bearer token required.' } });
  }

  // Only tools/call actually reaches the metered upstream (initialize/tools/list
  // are free protocol handshake) — see lib/ratelimit.js for why this exists.
  if (req.body?.method === 'tools/call') {
    const { allowed, limit } = checkAndConsume(clientIp(req));
    if (!allowed) {
      return res.status(200).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? null,
        result: {
          isError: true,
          content: [{
            type: 'text',
            text: `Rate limit exceeded (${limit} tool calls/hour on this free connector). For higher volume, use DevStack via RapidAPI or Apify: https://devstack-api.vercel.app`,
          }],
        },
      });
    }
  }

  const server = new McpServer({ name: 'devstack', version: '1.0.0' });
  registerTools(server);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}
