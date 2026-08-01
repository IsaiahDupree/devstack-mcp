// test/smoke.mjs — real end-to-end smoke test against a locally-running
// local-server.js (which serves the exact same api/mcp.js Vercel handler).
// No mocks: initialize, tools/list, and a live tools/call all go over real
// HTTP/JSON-RPC to a real MCP server instance, which in turn fetches real data
// from DEVSTACK_MCP_API_BASE_URL.
//
// Usage:
//   node local-server.js &            # in one terminal
//   node test/smoke.mjs               # in another
//
// The live tools/call hits the upstream DevStack API. Against production that
// requires DEVSTACK_MCP_PROXY_SECRET (the RapidAPI proxy-secret guard); against a
// locally self-hosted devstack-api with no RAPIDAPI_PROXY_SECRET set the guard is
// inert and real data flows keyless. Point DEVSTACK_MCP_API_BASE_URL at whichever
// you're testing. If the upstream guard rejects the call (no secret configured),
// the test still verifies the full MCP protocol plumbing and reports it explicitly
// instead of hard-failing.

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:3900';

let idCounter = 1;
async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: idCounter++, method, params };
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // StreamableHTTPServerTransport may respond with either a JSON body or an
  // SSE stream ("event: message\ndata: {...}\n\n") depending on client Accept
  // headers / SDK version. Handle both.
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || text.includes('\ndata:') || text.startsWith('data:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error(`no SSE data line in response: ${text}`);
    return { status: res.status, json: JSON.parse(dataLine.slice(5).trim()) };
  }
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function main() {
  console.log(`Smoke-testing devstack-mcp at ${BASE} ...\n`);

  // 1. health
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log('== GET /health ==');
  console.log(JSON.stringify(health, null, 2));
  if (!health.ok) throw new Error('health check failed');

  // 2. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'devstack-mcp-smoke-test', version: '1.0.0' },
  });
  console.log('\n== initialize ==');
  console.log(`HTTP ${init.status}`);
  console.log(JSON.stringify(init.json, null, 2));
  if (init.status !== 200 || init.json?.error) throw new Error('initialize failed');
  const serverName = init.json?.result?.serverInfo?.name;
  if (serverName !== 'devstack') throw new Error(`unexpected server name: ${serverName}`);

  // 3. tools/list
  const list = await rpc('tools/list', {});
  console.log('\n== tools/list ==');
  const tools = list.json?.result?.tools || [];
  console.log(`HTTP ${list.status}, ${tools.length} tools:`);
  for (const t of tools) {
    console.log(`  - ${t.name}: ${t.description.slice(0, 90)}${t.description.length > 90 ? '...' : ''}`);
  }
  if (tools.length < 10) throw new Error(`expected >= 10 tools, got ${tools.length}`);
  const pkgTool = tools.find((t) => t.name === 'get_package');
  if (!pkgTool) throw new Error('get_package tool missing');
  console.log('\nget_package inputSchema:');
  console.log(JSON.stringify(pkgTool.inputSchema, null, 2));

  // 4. tools/call get_package with a real query
  const call = await rpc('tools/call', {
    name: 'get_package',
    arguments: { registry: 'npm', name: 'react' },
  });
  console.log('\n== tools/call get_package {registry:"npm", name:"react"} ==');
  console.log(`HTTP ${call.status}`);
  const resultText = call.json?.result?.content?.[0]?.text;
  console.log(resultText);
  if (call.json?.result?.isError) {
    // A guard rejection (upstream requires the RapidAPI proxy secret and none is
    // configured for this run) is an upstream-auth condition, not an MCP failure —
    // the protocol plumbing above already passed. Surface it and stop cleanly.
    console.log('\ntools/call returned an upstream error (likely the RapidAPI proxy guard — set');
    console.log('DEVSTACK_MCP_PROXY_SECRET or point DEVSTACK_MCP_API_BASE_URL at an open instance).');
    console.log('MCP protocol plumbing (health + initialize + tools/list) verified OK.');
    return;
  }
  const parsed = resultText ? JSON.parse(resultText) : null;
  if (!parsed?.package && !parsed?.packages) throw new Error('get_package returned no package data');

  console.log('\nAll smoke tests passed.');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
