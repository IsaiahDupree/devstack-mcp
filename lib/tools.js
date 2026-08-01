// lib/tools.js — MCP tool definitions for the DevStack connector.
//
// One tool per DevStack API endpoint (see openapi.yaml in the devstack-api repo
// for the source of truth). Every tool is a thin, stateless fetch against the live
// DevStack deployment — no caching, no per-caller auth, no per-caller state.
// DevStack's data (npm / PyPI / Docker Hub / VS Code package metadata, dependency
// graphs, vulnerabilities, cross-registry lookups, ...) is public developer-registry
// information, so there is nothing to gate on the MCP-caller side: every caller
// sends the same request shape and gets the same real data back.
//
// The upstream devstack-api deployment IS metered (sold on RapidAPI/Apify), and its
// /v1/* routes sit behind a RapidAPI proxy-secret guard (see devstack-api/src/guard.js).
// This connector authenticates its own outbound calls with that same proxy secret
// (DEVSTACK_MCP_PROXY_SECRET, sent as the X-RapidAPI-Proxy-Secret header the RapidAPI
// proxy would inject) and applies its own soft per-IP rate limit (api/mcp.js +
// lib/ratelimit.js) so this free MCP tier stays a discovery/growth channel rather
// than an unmetered bypass of the paid listing.
//
// Base URL is configurable via DEVSTACK_MCP_API_BASE_URL for local/self-hosted
// testing; it defaults to the production deployment.

import { z } from 'zod';

const BASE_URL = (process.env.DEVSTACK_MCP_API_BASE_URL || 'https://devstack-api.vercel.app').replace(/\/+$/, '');
// The production DevStack deployment gates /v1/* behind a RapidAPI proxy-secret
// (see devstack-api/src/guard.js). RapidAPI normally injects the X-RapidAPI-Proxy-Secret
// header on the consumer's behalf; this connector sends that same header itself (from
// DEVSTACK_MCP_PROXY_SECRET) to reach real data — see lib/ratelimit.js for the usage
// cap that keeps this a free/discovery tier rather than an unmetered bypass of the
// paid RapidAPI/Apify listing.
const PROXY_SECRET = process.env.DEVSTACK_MCP_PROXY_SECRET || '';

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const asError = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
});

// Every DevStack tool only reads developer-registry data — never writes, never
// touches a caller's account (there is no account). openWorldHint is true because
// the underlying data comes from live upstream registries (npm, PyPI, Docker Hub,
// VS Code, deps.dev, OSV.dev, ecosyste.ms — an open, changing world outside this
// server's control). The one POST endpoint (batch vulnerability scan) is a
// read-only query, not a mutation, so it is annotated read-only too.
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function buildUrl(path, params = {}) {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function callDevStack(path, { params, method = 'GET', body } = {}) {
  const url = buildUrl(path, params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  let res;
  try {
    const headers = { accept: 'application/json' };
    if (PROXY_SECRET) headers['X-RapidAPI-Proxy-Secret'] = PROXY_SECRET;
    const init = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(`DevStack API request failed (${url.pathname}${url.search}): ${e.message || e}`);
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let body_;
  try {
    body_ = text ? JSON.parse(text) : null;
  } catch {
    body_ = { raw: text };
  }

  if (!res.ok) {
    const message = body_?.error?.message || `DevStack API returned HTTP ${res.status} for ${url.pathname}${url.search}`;
    const err = new Error(message);
    err.status = res.status;
    err.body = body_;
    throw err;
  }
  return body_;
}

// Wraps a (args) => { path, params, method?, body? } mapper into an MCP tool handler
// that calls DevStack and returns the JSON as tool-result content, or a typed error.
function forward(mapper) {
  return async (args = {}) => {
    try {
      const { path, params, method, body } = mapper(args);
      return asText(await callDevStack(path, { params, method, body }));
    } catch (err) {
      return asError(err);
    }
  };
}

export function registerTools(server) {
  server.registerTool(
    'get_package',
    {
      title: 'Get normalized package details',
      description:
        'Full normalized details for one package by registry + name, in a single unified Package shape across npm, PyPI, Docker Hub, and the VS Code Marketplace. name handles scoped npm ids (e.g. @types/node), Docker namespaces (e.g. library/nginx or a bare nginx for official images), and VS Code publisher.extension ids. With registry=all the request fans out to every registry in parallel and returns a packages array (missing registries are silently dropped); otherwise a single package is returned.',
      inputSchema: {
        registry: z.enum(['npm', 'pypi', 'docker', 'vscode', 'all']).describe('Target registry. "all" fans out to every registry and merges results.'),
        name: z.string().describe('Package name / id. Supports scoped npm ids (@scope/pkg), Docker namespaces (ns/name or a bare name for official images), and VS Code publisher.extension ids.'),
      },
      annotations: RO,
    },
    forward(({ registry, name }) => ({
      path: '/v1/package',
      params: { registry, name },
    }))
  );

  server.registerTool(
    'search_packages',
    {
      title: 'Search packages across registries',
      description:
        'Search a registry for packages matching q. registry=all fans out to npm, Docker Hub, and the VS Code Marketplace and merges the results. PyPI has no public search API, so registry=pypi returns 400 not_supported — look a PyPI package up by name via get_package instead. Results are normalized PackageSummary items (npm adds a relevance score; Docker adds isOfficial).',
      inputSchema: {
        registry: z.enum(['npm', 'pypi', 'docker', 'vscode', 'all']).describe('Target registry. "all" fans out to npm, Docker, and VS Code and merges results. pypi returns not_supported.'),
        q: z.string().describe('Search query.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results per registry. Clamped to 1-50. Default 20.'),
      },
      annotations: RO,
    },
    forward(({ registry, q, limit }) => ({
      path: '/v1/search',
      params: { registry, q, limit },
    }))
  );

  server.registerTool(
    'get_versions',
    {
      title: 'Get published versions / tags',
      description:
        'List published versions (npm/PyPI), image tags (Docker Hub, most recent 25), or extension versions (VS Code) for a package. registry=all is NOT supported here — pick a single registry. Each item carries version and released, plus registry-specific extras (files for PyPI, size for Docker tags).',
      inputSchema: {
        registry: z.enum(['npm', 'pypi', 'docker', 'vscode']).describe('Target registry. "all" is not supported here — pick one.'),
        name: z.string().describe('Package name / id (scoped npm ids, Docker namespaces, and VS Code publisher.extension ids supported).'),
      },
      annotations: RO,
    },
    forward(({ registry, name }) => ({
      path: '/v1/versions',
      params: { registry, name },
    }))
  );

  server.registerTool(
    'get_downloads',
    {
      title: 'Get download / pull statistics',
      description:
        'Download statistics for a package. Only npm (via api.npmjs.org) and PyPI (via pypistats.org) support this; any other registry returns 400 not_supported. npm returns a period window with downloads, start, and end; PyPI returns last_day, last_week, and last_month totals.',
      inputSchema: {
        registry: z.enum(['npm', 'pypi']).describe('Target registry. Only npm and pypi expose download stats.'),
        name: z.string().describe('Package name.'),
      },
      annotations: RO,
    },
    forward(({ registry, name }) => ({
      path: '/v1/downloads',
      params: { registry, name },
    }))
  );

  server.registerTool(
    'get_dependency_graph',
    {
      title: 'Get resolved dependency graph',
      description:
        'The fully resolved dependency graph for one exact package version, via deps.dev. Returns a flat nodes[] array plus integer-index edges[] (walk from/to to rebuild the tree). Each node carries relation (self | direct | indirect) and a direct boolean; node[0] is always the queried root (relation: self). Node order is NOT stable — look nodes up by name/relation, never by positional index. system is case-insensitive and lowercased (npm, pypi, cargo, go, maven, nuget). version is REQUIRED (a graph is resolved for one exact version).',
      inputSchema: {
        system: z.enum(['npm', 'pypi', 'cargo', 'go', 'maven', 'nuget']).describe('Package system / ecosystem for deps.dev. Case-insensitive, lowercased server-side.'),
        name: z.string().describe('Package name / id.'),
        version: z.string().describe('Exact version to resolve (e.g. 18.2.0). Required.'),
      },
      annotations: RO,
    },
    forward(({ system, name, version }) => ({
      path: '/v1/deps',
      params: { system, name, version },
    }))
  );

  server.registerTool(
    'get_vulnerabilities',
    {
      title: 'Get vulnerabilities for a package',
      description:
        'Known vulnerabilities (CVE / GHSA / PYSEC / GO advisories) for a package, via OSV.dev. Pass version to filter to advisories affecting that exact version, or omit it for the package\'s full advisory history. Each result carries the OSV id, cross-id aliases, a severity word grade (LOW|MODERATE|HIGH|CRITICAL), the cvss vector string, affectedRanges with fixed-version events, references, and cwes. A clean package returns count: 0 with an empty list (not an error). ecosystem is CASE-SENSITIVE — use OSV\'s spelling (npm, PyPI, Go, crates.io, Maven, NuGet, RubyGems, …). Use scan_vulnerabilities_batch for lockfile batch scans.',
      inputSchema: {
        ecosystem: z.string().describe('OSV ecosystem, CASE-SENSITIVE (e.g. npm, PyPI, Go, crates.io, Maven, NuGet, RubyGems).'),
        name: z.string().describe('Package name.'),
        version: z.string().optional().describe('Exact version to filter advisories to. Omit for full history.'),
      },
      annotations: RO,
    },
    forward(({ ecosystem, name, version }) => ({
      path: '/v1/vulns',
      params: { ecosystem, name, version },
    }))
  );

  server.registerTool(
    'scan_vulnerabilities_batch',
    {
      title: 'Batch vulnerability scan (lockfile)',
      description:
        'Scan many packages in one call — ideal for a whole lockfile. Pass a queries[] array (max 100) of { ecosystem, name, version? }; results are returned positionally aligned, one row per query, each with a count and a hydrated vulns[] array. Advisories are de-duplicated and hydrated across the batch. ecosystem is CASE-SENSITIVE (OSV spelling).',
      inputSchema: {
        queries: z.array(z.object({
          ecosystem: z.string().optional().describe('OSV ecosystem (case-sensitive). e.g. npm, PyPI, Go.'),
          name: z.string().describe('Package name (required).'),
          version: z.string().optional().describe('Exact version. Omit for full history.'),
        })).min(1).max(100).describe('Up to 100 { ecosystem, name, version? } queries, ideal for a whole lockfile.'),
      },
      annotations: RO,
    },
    forward(({ queries }) => ({
      path: '/v1/vulns',
      method: 'POST',
      body: { queries },
    }))
  );

  server.registerTool(
    'get_insights',
    {
      title: 'Get project insights — OSSF Scorecard + repo signal',
      description:
        'Health and security insights for a package\'s source project, via deps.dev. Returns the linked source repository, GitHub stars/forks/openIssues, licenses, resolved dependencyCount, security advisories, and the full OSSF Scorecard (ossfScore 0..10 plus the per-check breakdown). Omit version to use the registry default version — note deps.dev\'s default is a MOVING target and an unverified default mirror may have no computed scorecard (ossfScore: null); pin version for a stable, scorecard-backed result. system is lowercased (npm, pypi, cargo, go, maven, …).',
      inputSchema: {
        system: z.enum(['npm', 'pypi', 'cargo', 'go', 'maven', 'nuget']).describe('Package system / ecosystem for deps.dev. Case-insensitive, lowercased server-side.'),
        name: z.string().describe('Package name / id.'),
        version: z.string().optional().describe('Exact version. Omit for the (moving) registry default version.'),
      },
      annotations: RO,
    },
    forward(({ system, name, version }) => ({
      path: '/v1/insights',
      params: { system, name, version },
    }))
  );

  server.registerTool(
    'search_ecosystems',
    {
      title: 'Cross-registry package lookup (50+ ecosystems)',
      description:
        'Look a package name up across 50+ registries at once, via ecosyste.ms. This is an EXACT-name lookup (not fuzzy full-text): q=react returns the react package everywhere it exists (npm, cargo, nuget, pub, bower, …), each as a normalized ecosystemsPackage with reverse-dependency counts. Pass ecosystem to narrow to one registry. Results carry dependentReposCount, dependentPackagesCount, and vulnerabilityCount.',
      inputSchema: {
        q: z.string().describe('Exact package name to look up across registries.'),
        ecosystem: z.string().optional().describe('Narrow to one ecosystem (e.g. pypi, npm, cargo). Omit to search all.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results. Clamped to 1-50. Default 20.'),
      },
      annotations: RO,
    },
    forward(({ q, ecosystem, limit }) => ({
      path: '/v1/ecosystems/search',
      params: { q, ecosystem, limit },
    }))
  );

  server.registerTool(
    'get_ecosystems_package',
    {
      title: 'Get one package on one registry (with reverse-dep counts)',
      description:
        'Full normalized metadata for one package on one of 50+ registries, via ecosyste.ms — including the fields v1 registries can\'t give you: dependentReposCount and dependentPackagesCount (reverse dependencies), ecosystem, and vulnerabilityCount. Scoped/namespaced names are handled automatically. Returns 404 if the package does not exist on that ecosystem.',
      inputSchema: {
        ecosystem: z.string().describe('Target ecosyste.ms ecosystem slug (e.g. npm, pypi, cargo, rubygems).'),
        name: z.string().describe('Package name / id.'),
      },
      annotations: RO,
    },
    forward(({ ecosystem, name }) => ({
      path: '/v1/ecosystems/package',
      params: { ecosystem, name },
    }))
  );
}

export const BASE_URL_FOR_HEALTH = BASE_URL;
