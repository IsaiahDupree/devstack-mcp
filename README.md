# devstack-mcp

This connector exposes developer-registry tools via MCP. This source revision requires a caller bearer token, individually enables tools, and has no default upstream. The hosted deployment may differ.

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

## Configuration

- `DEVSTACK_MCP_CLIENT_TOKEN`: separately generated caller bearer token, at least 32 UTF-8 bytes; missing or short values disable MCP access.
- `DEVSTACK_MCP_ALLOWED_TOOLS`: comma-separated explicit tool names; empty by default.
- `DEVSTACK_MCP_API_BASE_URL`: explicit origin, unset by default; remote origins require HTTPS and `DEVSTACK_MCP_ALLOW_REMOTE_UPSTREAM=1`. Redirects are refused.
- `DEVSTACK_MCP_PROXY_SECRET`: upstream proxy secret, separate from the caller token.
- `DEVSTACK_MCP_RATE_LIMIT`: best-effort per-instance shaping, default 30 calls/hour; not a hard spending cap.
- `DEVSTACK_MCP_LISTEN_HOST`: standalone bind host, default `127.0.0.1`.

A loopback API can itself call external providers. Flags do not authorize cloud workloads or expense. Existing clients must be migrated before restoration.

## Local verification

Run `npm run dev` on owned hardware. `npm run smoke` checks protocol and skips live lookup unless `SMOKE_ALLOW_REAL_LOOKUP=1` is set for an authorized workload. `DEVSTACK_API_ROOT=/path/to/devstack-api npm run check:local` tests against the real local API with outbound networking denied by macOS sandbox. Do not push until automatic build triggers are verified disabled; hosted deployment requires authorization for the exact workload and expense.
