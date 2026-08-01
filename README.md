# devstack-mcp

A remote **MCP (Model Context Protocol)** connector for [DevStack API](https://devstack-api.vercel.app) — the libraries.io successor: one keyless, normalized view of the whole developer registry across **npm, PyPI, Docker Hub, and the VS Code Marketplace** (search, package details, versions, download/pull stats), plus **resolved dependency graphs** (deps.dev), **per-version vulnerabilities** (OSV.dev), **OSSF Scorecard insights** (deps.dev), and **cross-registry lookups over 50+ ecosystems** (ecosyste.ms).

**Target deploy:** `https://devstack-mcp.vercel.app/mcp` — 10 tools. Since the upstream DevStack deployment is metered (RapidAPI/Apify) and gates `/v1/*` behind a RapidAPI proxy-secret guard, this connector authenticates its own outbound calls with that same proxy secret (`DEVSTACK_MCP_PROXY_SECRET`, sent as the `X-RapidAPI-Proxy-Secret` header) and applies a soft per-IP rate limit (`DEVSTACK_MCP_RATE_LIMIT`, default 30 tool-calls/hour, in-memory) so the free MCP tier stays a discovery channel rather than an unmetered bypass of the paid listing — see `lib/ratelimit.js`.

## What this is, and why it's a separate connector

DevStack API is a plain REST API. Any HTTP client can already call it directly. This repo exists because **MCP clients (Claude, ChatGPT, and other MCP-aware agents) don't consume arbitrary REST APIs — they consume MCP tools.** `devstack-mcp` is a thin adapter layer that:

- Exposes each DevStack endpoint as a discoverable, typed MCP **tool** (name, description, zod input schema, annotations) that an LLM can reason about and call directly, instead of having to be taught the REST surface out-of-band.
- Speaks the MCP **streamable-HTTP** transport at a single `/mcp` endpoint, so it can be registered as a connector in Claude, ChatGPT, or any other MCP client with one URL.
- Does nothing else. It has no business logic of its own — every tool call is a pass-through `fetch` to DevStack, and the JSON response DevStack returns is handed back verbatim as the tool result.

## Authentication: None on the MCP side (deliberate)

DevStack's data has **no per-user dimension at all** — it's public developer-registry metadata (package listings, versions, download counts, dependency graphs, published CVEs). There is nothing to gate per-caller, so this connector intentionally ships with:

- No OAuth, no login, no per-user bearer tokens
- No Supabase / database
- No demo-vs-real account split — every caller gets the same real, live data

The one server-side secret it carries (`DEVSTACK_MCP_PROXY_SECRET`) is **not** per-caller auth — it's how this connector, as a single consumer, gets past the upstream's RapidAPI proxy-secret guard to reach real data. Combined with the soft per-IP rate limit, that keeps this a free discovery tier over the metered DevStack product rather than an unmetered bypass of the paid RapidAPI/Apify listing.

## Tool list

One tool per DevStack `/v1` endpoint (from `devstack-api/openapi.yaml`):

| Tool | DevStack endpoint | Description |
|---|---|---|
| `get_package` | `GET /v1/package` | Normalized package details by registry + name (`registry=all` fans out). |
| `search_packages` | `GET /v1/search` | Search npm/Docker/VS Code (or `all`); PyPI has no search API. |
| `get_versions` | `GET /v1/versions` | Published versions / image tags / extension versions. |
| `get_downloads` | `GET /v1/downloads` | Download / pull statistics (npm + PyPI only). |
| `get_dependency_graph` | `GET /v1/deps` | Fully resolved dependency graph for one exact version (deps.dev). |
| `get_vulnerabilities` | `GET /v1/vulns` | Known CVEs/GHSAs per package/version (OSV.dev). |
| `scan_vulnerabilities_batch` | `POST /v1/vulns` | Batch/lockfile vulnerability scan — up to 100 queries in one call (OSV.dev). |
| `get_insights` | `GET /v1/insights` | OSSF Scorecard + repo signal + licenses/advisories (deps.dev). |
| `search_ecosystems` | `GET /v1/ecosystems/search` | Cross-registry exact-name lookup across 50+ ecosystems (ecosyste.ms). |
| `get_ecosystems_package` | `GET /v1/ecosystems/package` | One package on one registry, with reverse-dependency counts (ecosyste.ms). |

All 10 tools are read-only and annotated `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`. `scan_vulnerabilities_batch` is an HTTP `POST` but is a read-only *query* (it mutates nothing), so it carries the same read-only annotations.

## How it wraps devstack-api

Each tool handler does a plain `fetch(\`${DEVSTACK_MCP_API_BASE_URL}${path}\`, ...)` against the real DevStack REST API and returns the parsed JSON as MCP tool-result content:

```js
{ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
```

Upstream HTTP errors (4xx/5xx) are caught and surfaced as a typed MCP error result via an `asError` helper rather than crashing the request.

### Environment variables

| Env var | Purpose | Default |
|---|---|---|
| `DEVSTACK_MCP_API_BASE_URL` | Upstream DevStack base URL. | `https://devstack-api.vercel.app` |
| `DEVSTACK_MCP_PROXY_SECRET` | RapidAPI proxy secret, sent as `X-RapidAPI-Proxy-Secret` to pass the upstream `/v1/*` guard. | `""` (omitted) |
| `DEVSTACK_MCP_RATE_LIMIT` | Soft per-IP tool-calls/hour cap for this free tier. | `30` |

## Project layout

```
api/mcp.js       MCP endpoint (StreamableHTTPServerTransport, stateless, no per-caller auth)
api/health.js    GET /api/health
lib/tools.js     All 10 tool definitions (zod schemas + fetch-and-forward handlers)
lib/ratelimit.js Soft per-IP tools/call cap (free discovery tier)
local-server.js  Plain-Node http server for local dev / smoke testing (not deployed)
test/smoke.mjs   Real end-to-end smoke test (initialize, tools/list, tools/call)
vercel.json      Routes /mcp -> api/mcp.js, /health -> api/health.js
server.json      MCP registry publish manifest
```

## Local development

```bash
npm install
npm run dev          # starts local-server.js on http://localhost:3900
```

Endpoints locally: `POST http://localhost:3900/mcp`, `GET http://localhost:3900/health`.

To point at a self-hosted / open DevStack instance instead of production (useful for a fully keyless end-to-end run, since production's `/v1/*` is behind the RapidAPI proxy-secret guard):

```bash
# In devstack-api (guard is inert when RAPIDAPI_PROXY_SECRET is unset):
node server.js                                   # listens on :8080

# In devstack-mcp:
DEVSTACK_MCP_API_BASE_URL=http://localhost:8080 npm run dev
```

## Smoke test

```bash
npm run dev &                 # terminal 1
npm run smoke                 # terminal 2
```

`test/smoke.mjs` drives the running server over real HTTP/JSON-RPC and verifies:

1. `GET /health` returns `{ ok: true, ... }`
2. `initialize` succeeds and reports `serverInfo.name === "devstack"`
3. `tools/list` returns all 10 tools with their zod-derived JSON schemas
4. `tools/call` for `get_package` with `{ registry: "npm", name: "react" }` returns real package data fetched live (not mocked)

Against production, step 4 needs `DEVSTACK_MCP_PROXY_SECRET` set (the RapidAPI proxy guard); against a locally self-hosted `devstack-api` with no `RAPIDAPI_PROXY_SECRET`, the guard is inert and real data flows keyless.

## Deploy

Not deployed by this build. Once ready:

```bash
cd /Users/isaiahdupree/Software/devstack-mcp
npx vercel --yes --prod
```

After deploy, set `DEVSTACK_MCP_PROXY_SECRET` in the Vercel project so the connector can reach the guarded production `/v1/*`, then register the MCP connector URL in Claude/ChatGPT/any MCP client:

```
https://<deployment-domain>/mcp
```
