# Store Manager Stockout Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-crossfilter stockout analytics dashboard that coordinates 5 worker runtimes across 5 Cube.dev cubes, with URL-hash-driven filter state, ECharts visualizations, and a dark theme.

**Architecture:** Each cube gets its own `createStreamingDashboardWorker` instance. A `FilterRouter` reads the URL hash and dispatches `filterIn` calls to each runtime for dimensions they have loaded. The proxy server handles auth and forwards Cube API requests. Panels render progressively as workers become ready.

**Tech Stack:** crossfilter2 (`createStreamingDashboardWorker`), ECharts 5, Cube.dev `/api/v1/load` (Arrow IPC) + `/api/v1/meta` (JSON), Node.js proxy server.

**Spec:** `docs/superpowers/specs/2026-03-16-stockout-store-manager-dashboard-design.md`

**Commands:**
- Start dev server: `node demo-stockout/proxy-server.mjs`
- Open dashboard: `http://localhost:3334/demo-stockout/`
- Run tests: `npx vitest run`
- Lint: `npx eslint src/`

---

## File Map

| File | Responsibility |
|------|---------------|
| `demo-stockout/proxy-server.mjs` | Dev server: static files + proxy `/api/cube` and `/api/meta` to Synmetrix |
| `demo-stockout/index.html` | HTML shell with script tags, loading overlay, store picker, dashboard grid |
| `demo-stockout/styles.css` | Dark theme CSS: variables, layout grid, cards, KPIs, tables, badges, animations |
| `demo-stockout/theme.js` | ECharts dark theme registration |
| `demo-stockout/router.js` | URL hash ↔ filter state: parse, serialize, listen for changes |
| `demo-stockout/cube-registry.js` | Cube configs: Cube.dev query builders, crossfilter worker configs, field rename maps |
| `demo-stockout/filter-router.js` | Dispatches unified filters from URL state to N crossfilter runtimes |
| `demo-stockout/app.js` | Entry point: startup, store picker, worker creation, panel wiring |
| `demo-stockout/panels/kpis.js` | 6 KPI cards from cf-store + cf-analysis |
| `demo-stockout/panels/trend.js` | Monthly trend line chart from cf-trend |
| `demo-stockout/panels/category.js` | Category horizontal bar chart from cf-store (click-to-filter) |
| `demo-stockout/panels/stockout-table.js` | Currently stocked out products table from cf-store |
| `demo-stockout/panels/forecast.js` | 3-day forecast cards + at-risk table from cf-store |
| `demo-stockout/panels/risk-chart.js` | Top 10 risk products horizontal bar from cf-store |
| `demo-stockout/panels/early-warning.js` | Worsening products table from cf-warning |
| `demo-stockout/panels/dow-pattern.js` | Day-of-week bar chart from cf-dow |

---

## Task 1: Proxy Server

**Files:**
- Create: `demo-stockout/proxy-server.mjs`

The proxy is standalone infrastructure. It must work before anything else can load data.

- [ ] **1a: Create proxy server based on existing demo pattern**

Based on `demo/proxy-server.mjs` but with two changes: (1) also proxy `GET /api/meta` to the Synmetrix meta endpoint, (2) use port 3334 to avoid conflict with the existing demo server. Read `CUBE_TOKEN`, `CUBE_DATASOURCE`, `CUBE_BRANCH` from `.env`.

```js
// demo-stockout/proxy-server.mjs
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || '3334', 10);
const envPath = path.resolve(ROOT, '.env');

const CUBE_HOST = 'dbx.fraios.dev';
const CUBE_LOAD_PATH = '/api/v1/load';
const CUBE_META_PATH = '/api/v1/meta';

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.arrow':'application/vnd.apache.arrow.stream',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

const PROXY_RESPONSE_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-length',
  'content-type',
  'transfer-encoding',
  'x-request-id',
  'x-synmetrix-arrow-field-mapping',
  'x-synmetrix-arrow-field-mapping-encoding',
];

function readEnvConfig() {
  var config = {};
  if (!fs.existsSync(envPath)) return config;
  for (var line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    var eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    config[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
  }
  return config;
}

function withBearerPrefix(token) {
  if (!token) return '';
  return token.startsWith('Bearer ') ? token : 'Bearer ' + token;
}

function getAuthConfig(req) {
  var env = readEnvConfig();
  return {
    token: req.headers.authorization || withBearerPrefix(env.CUBE_TOKEN || process.env.CUBE_TOKEN || ''),
    datasourceId: req.headers['x-hasura-datasource-id'] || env.CUBE_DATASOURCE || process.env.CUBE_DATASOURCE || '',
    branchId: req.headers['x-hasura-branch-id'] || env.CUBE_BRANCH || process.env.CUBE_BRANCH || '',
  };
}

function proxyToCube(req, res, method, cubePath, body) {
  var auth = getAuthConfig(req);
  if (!auth.token || !auth.datasourceId || !auth.branchId) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing Cube config. Set CUBE_TOKEN, CUBE_DATASOURCE, CUBE_BRANCH in .env.' }));
    return;
  }

  var headers = {
    'Authorization': auth.token,
    'x-hasura-datasource-id': auth.datasourceId,
    'x-hasura-branch-id': auth.branchId,
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  var proxyReq = https.request({
    hostname: CUBE_HOST,
    port: 443,
    path: cubePath,
    method: method,
    headers: headers,
  }, function (proxyRes) {
    var respHeaders = { 'Access-Control-Allow-Origin': '*' };
    for (var h of PROXY_RESPONSE_HEADERS) {
      if (proxyRes.headers[h] != null) respHeaders[h] = proxyRes.headers[h];
    }
    res.writeHead(proxyRes.statusCode, respHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.setTimeout(300000, function () {
    proxyReq.destroy(new Error('Proxy timeout'));
  });
  proxyReq.on('error', function (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Proxy error: ' + err.message);
    }
  });
  if (body) proxyReq.write(body);
  proxyReq.end();
}

function serveStatic(req, res) {
  var filePath = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (filePath.endsWith('/')) filePath += 'index.html';
  fs.stat(filePath, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath).pipe(res);
  });
}

var server = http.createServer(function (req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-hasura-branch-id, x-hasura-datasource-id',
    });
    res.end();
    return;
  }

  if (req.url === '/api/meta' && req.method === 'GET') {
    proxyToCube(req, res, 'GET', CUBE_META_PATH, null);
    return;
  }

  if (req.url === '/api/cube' && req.method === 'POST') {
    var body = '';
    req.on('data', function (chunk) { body += chunk; });
    req.on('end', function () { proxyToCube(req, res, 'POST', CUBE_LOAD_PATH, body); });
    return;
  }

  serveStatic(req, res);
});

server.timeout = 300000;
server.keepAliveTimeout = 300000;
server.listen(PORT, function () {
  console.log('Stockout dashboard dev server at http://localhost:' + PORT + '/');
  console.log('  Static: ' + ROOT);
  console.log('  Proxy: POST /api/cube -> https://' + CUBE_HOST + CUBE_LOAD_PATH);
  console.log('  Proxy: GET  /api/meta -> https://' + CUBE_HOST + CUBE_META_PATH);
});
```

- [ ] **1b: Verify proxy works**

Run: `node demo-stockout/proxy-server.mjs &`
Then: `curl -s http://localhost:3334/api/meta | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('cubes',[])), 'cubes')"` → should print `6 cubes`
Kill: `kill %1`

- [ ] **1c: Commit**

```
feat(demo-stockout): add proxy server for stockout dashboard
```

---

## Task 2: HTML Shell + CSS + ECharts Theme

**Files:**
- Create: `demo-stockout/index.html`
- Create: `demo-stockout/styles.css`
- Create: `demo-stockout/theme.js`

Static foundation. No JS logic yet — just the visual structure with placeholder panels.

- [ ] **2a: Create `index.html`**

HTML shell with:
- Font imports (JetBrains Mono, DM Sans)
- ECharts and crossfilter script tags
- Loading overlay
- Store picker (hidden by default)
- Dashboard grid with all 8 panel containers (empty cards with IDs)
- Module script tag for `app.js`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Store Manager — Stockout Intelligence</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
</head>
<body>

<div id="loading-overlay" class="loading-overlay">
  <div class="loading-spinner"></div>
  <div class="loading-text">Starting...</div>
</div>

<div id="store-picker" class="store-picker" hidden>
  <div class="store-picker-inner">
    <h1 class="picker-title">STORE OPERATIONS</h1>
    <h2 class="picker-subtitle">Select Your Store</h2>
    <div id="store-grid" class="store-grid"></div>
  </div>
</div>

<div id="dashboard" class="dashboard" hidden>
  <header class="header anim d1">
    <div class="header-left">
      <h1>STORE OPERATIONS</h1>
      <h2>Essential Products <span id="store-name">—</span></h2>
    </div>
    <div class="header-right">
      <div class="filter-bar">
        <div id="filter-chips" class="filter-chips"></div>
        <button id="clear-filters-btn" class="btn btn-ghost" hidden>Clear Filters</button>
      </div>
      <select id="store-selector" class="store-select"></select>
    </div>
  </header>

  <section id="kpi-row" class="kpi-row anim d2"></section>

  <div class="grid-2col">
    <section class="card anim d3">
      <div class="card-head"><span class="card-t">MONTHLY AVAILABILITY TREND</span></div>
      <div id="panel-trend" class="chart-wrap"></div>
    </section>
    <section class="card anim d3">
      <div class="card-head"><span class="card-t">BY CATEGORY</span></div>
      <div id="panel-category" class="chart-wrap"></div>
    </section>
  </div>

  <section class="card anim d4">
    <div class="card-head"><span class="card-t">CURRENTLY STOCKED OUT</span> <span id="stockout-count" class="card-tag"></span></div>
    <div id="panel-stockout-table" class="table-scroll"></div>
  </section>

  <section class="card anim d5">
    <div class="card-head"><span class="card-t">AT RISK — NEXT 3 DAYS</span> <span id="forecast-count" class="card-tag"></span></div>
    <div id="panel-forecast-cards" class="forecast-cards"></div>
    <div id="panel-forecast-table" class="table-scroll"></div>
  </section>

  <div class="grid-2col">
    <section class="card anim d6">
      <div class="card-head"><span class="card-t">TOP 10 HIGHEST RISK</span></div>
      <div id="panel-risk" class="chart-wrap"></div>
    </section>
    <section class="card anim d6">
      <div class="card-head"><span class="card-t">DAY-OF-WEEK PATTERN</span></div>
      <div id="panel-dow" class="chart-wrap"></div>
      <div id="panel-dow-badges" class="dow-badges"></div>
    </section>
  </div>

  <section class="card anim d7">
    <div class="card-head"><span class="card-t">EARLY WARNING — WORSENING</span> <span id="warning-count" class="card-tag tag-red"></span></div>
    <div id="panel-early-warning" class="table-scroll"></div>
  </section>
</div>

<script src="../crossfilter.js"></script>
<script src="../node_modules/echarts/dist/echarts.min.js"></script>
<script type="module" src="app.js"></script>

</body>
</html>
```

- [ ] **2b: Create `styles.css`**

Dark theme CSS with all the design system variables, layout grid, card styles, KPI cards, table styles, badge system, animations, store picker, loading overlay. This is a large file (~400 lines) — write the full CSS based on the spec's design system variables and the existing mockup patterns from `/Users/stefanbaxter/Development/etl/cube/dashboards/store-manager.html`.

Key sections:
- `:root` variables (colors, fonts, radii)
- Reset + body (dark background, grid pattern)
- `.dashboard` layout (max-width 1440px, padding)
- `.header` (flex, store selector, filter chips)
- `.kpi-row` (6-column grid) + `.kpi` cards
- `.card` (dark card with border, head, body)
- `.grid-2col` (2-column CSS grid)
- `.chart-wrap` (chart container with min-height)
- `.table-scroll` + `.tbl` (dark table with sticky header)
- `.badge` system (b-critical, b-high, b-medium, b-low, b-worsening, b-improving, b-stable)
- `.forecast-cards` (flex row of forecast card items)
- `.dow-badges` (flex row of badge callouts)
- `.filter-chips` (active filter pill display)
- `.store-picker` (fullscreen store selection grid)
- `.loading-overlay` (centered spinner + text)
- `.anim` + `.d1`-`.d8` (fadeUp animation with cascading delays)
- `.store-select` (dark-themed select dropdown)

- [ ] **2c: Create `theme.js`**

ECharts theme registration matching the dark design system. Export a `registerTheme(echarts)` function and a `THEME_NAME` constant.

```js
// demo-stockout/theme.js
export var THEME_NAME = 'stockout-dark';

export function registerTheme(echarts) {
  echarts.registerTheme(THEME_NAME, {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: "'JetBrains Mono', monospace", color: '#7a8a9e' },
    title: { textStyle: { color: '#e8edf3' } },
    legend: { textStyle: { color: '#7a8a9e' } },
    tooltip: {
      backgroundColor: '#1a2332',
      borderColor: '#2a3a4e',
      textStyle: { color: '#e8edf3', fontFamily: "'JetBrains Mono', monospace", fontSize: 11 },
    },
    categoryAxis: {
      axisLine: { lineStyle: { color: '#1e2a3a' } },
      axisTick: { show: false },
      axisLabel: { color: '#7a8a9e', fontSize: 10 },
      splitLine: { lineStyle: { color: '#1e2a3a' } },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#7a8a9e', fontSize: 10 },
      splitLine: { lineStyle: { color: '#1e2a3a' } },
    },
    color: ['#00e68a', '#4da6ff', '#ffb84d', '#ff4d6a', '#b366ff', '#00b8d4'],
  });
}
```

- [ ] **2d: Verify static shell loads**

Run: `node demo-stockout/proxy-server.mjs &`
Open: `http://localhost:3334/demo-stockout/` — should show the loading overlay on a dark background. Console may show errors about missing `app.js` — that's expected.

- [ ] **2e: Commit**

```
feat(demo-stockout): add HTML shell, dark theme CSS, ECharts theme
```

---

## Task 3: Router (URL Hash ↔ State)

**Files:**
- Create: `demo-stockout/router.js`

Pure state management module. No DOM, no crossfilter — just URL hash parsing/serialization.

- [ ] **3a: Create `router.js`**

```js
// demo-stockout/router.js
//
// URL hash is the single source of truth.
// getState() parses hash into { store, category, supplier, ... }
// setState(patch) merges patch into current state and updates hash.
// onStateChange(cb) registers a listener called on hashchange.

var listeners = [];
var currentState = null;

// URL param name → cube dimension name
export var PARAM_TO_DIMENSION = {
  category: 'product_category',
  subcategory: 'product_sub_category',
  supplier: 'supplier',
  product: 'product',
  risk: 'risk_tier',
  active: 'is_currently_active',
};

export function parseHash(hash) {
  var raw = (hash || '').replace(/^#/, '');
  var params = new URLSearchParams(raw);
  var state = { store: params.get('store') || null };

  for (var param in PARAM_TO_DIMENSION) {
    var val = params.get(param);
    if (param === 'active') {
      state[param] = val === 'true' ? 'true' : val === 'false' ? 'false' : null;
    } else {
      state[param] = val || null;
    }
  }
  return state;
}

export function serializeHash(state) {
  var params = new URLSearchParams();
  if (state.store) params.set('store', state.store);
  for (var param in PARAM_TO_DIMENSION) {
    if (state[param]) params.set(param, state[param]);
  }
  var str = params.toString();
  return str ? '#' + str : '#';
}

export function getState() {
  if (!currentState) currentState = parseHash(location.hash);
  return currentState;
}

export function setState(patch) {
  var next = Object.assign({}, getState(), patch);
  // Remove null/empty values
  for (var key in next) {
    if (next[key] == null || next[key] === '') next[key] = null;
  }
  var hash = serializeHash(next);
  if (location.hash !== hash) {
    location.hash = hash;
  }
  // hashchange will fire and update currentState
}

export function onStateChange(callback) {
  listeners.push(callback);
  return function () {
    listeners = listeners.filter(function (cb) { return cb !== callback; });
  };
}

// Convert URL state to dashboard filter objects (for crossfilter runtime.updateFilters)
export function buildDashboardFilters(state, runtimeDimensions) {
  var filters = {};
  for (var param in PARAM_TO_DIMENSION) {
    var dimName = PARAM_TO_DIMENSION[param];
    var val = state[param];
    if (!val || !runtimeDimensions.includes(dimName)) continue;
    if (param === 'active') {
      filters[dimName] = { type: 'in', values: [val === 'true'] };
    } else {
      filters[dimName] = { type: 'in', values: val.split(',') };
    }
  }
  return filters;
}

function onHashChange() {
  var prev = currentState;
  currentState = parseHash(location.hash);
  for (var i = 0; i < listeners.length; ++i) {
    listeners[i](currentState, prev);
  }
}

window.addEventListener('hashchange', onHashChange);
currentState = parseHash(location.hash);
```

- [ ] **3b: Commit**

```
feat(demo-stockout): add URL hash router
```

---

## Task 4: Cube Registry

**Files:**
- Create: `demo-stockout/cube-registry.js`

Defines the 5 cube configurations: what Cube.dev query to send, what crossfilter dimensions/KPIs/groups to create, and field rename maps. Also fetches `/api/v1/meta` for validation.

- [ ] **4a: Create `cube-registry.js`**

This is the largest infrastructure module. It contains:
1. `CUBE_CONFIGS` — static config for each of the 5 cubes (Cube query template, crossfilter worker config)
2. `fetchMeta()` — calls `/api/meta` and returns the cube metadata
3. `buildCubeQuery(cubeId, store)` — produces the Cube.dev `/api/v1/load` JSON body for a given cube + store
4. `buildWorkerOptions(cubeId, store)` — produces the `createStreamingDashboardWorker` options
5. `getCubeConfig(cubeId)` — returns the static config for a cube
6. `ALL_CUBE_IDS` — the 5 cube IDs

Each cube config specifies:
- `cubeName`: the Cube.dev cube name (e.g., `stockout_store_dashboard`)
- `cubeQueryDimensions`: array of full Cube.dev dimension names to include in the query
- `cubeQueryMeasures`: array of full Cube.dev measure names
- `cubeQueryTimeDimensions`: optional time dimensions
- `workerDimensions`: array of short field names to use as crossfilter dimensions
- `workerKpis`: array of `{ id, field, op }` specs
- `workerGroups`: array of group specs
- `projection.rename`: map from Cube.dev field name → short field name (Cube returns `stockout_store_dashboard__product` in Arrow, we want `product`)

The rename map is critical: Cube.dev Arrow responses use double-underscore-joined field names (e.g., `stockout_store_dashboard__product_category`). The crossfilter worker needs these renamed to short names (e.g., `product_category`) so dimensions match across cubes.

Write the full config for all 5 cubes per the spec's Cube.dev query bodies and crossfilter worker configs.

- [ ] **4b: Commit**

```
feat(demo-stockout): add cube registry with 5 cube configs
```

---

## Task 5: Filter Router

**Files:**
- Create: `demo-stockout/filter-router.js`

The coordination layer between the URL router and the crossfilter runtimes.

- [ ] **5a: Create `filter-router.js`**

```js
// demo-stockout/filter-router.js
//
// Holds a registry of { id, runtime, dimensions } entries.
// When filters change, dispatches updateFilters() to each runtime
// for dimensions it has loaded. Ignores dimensions not in a runtime.

import { buildDashboardFilters } from './router.js';

var entries = [];
var panelCallbacks = [];

export function registerRuntime(id, runtime, dimensions) {
  entries.push({ id: id, runtime: runtime, dimensions: dimensions });
}

export function unregisterRuntime(id) {
  entries = entries.filter(function (e) { return e.id !== id; });
}

export function onPanelRefresh(callback) {
  panelCallbacks.push(callback);
}

export async function dispatchFilters(state) {
  var promises = [];
  for (var i = 0; i < entries.length; ++i) {
    var entry = entries[i];
    var filters = buildDashboardFilters(state, entry.dimensions);
    promises.push(
      entry.runtime.updateFilters(filters).catch(function (err) {
        console.error('Filter dispatch failed for ' + entry.id + ':', err);
      })
    );
  }
  await Promise.all(promises);
  // Notify panels to re-query
  for (var j = 0; j < panelCallbacks.length; ++j) {
    panelCallbacks[j]();
  }
}

export function disposeAll() {
  var disposePromises = entries.map(function (e) {
    return e.runtime.dispose().catch(function () {});
  });
  entries = [];
  return Promise.all(disposePromises);
}
```

- [ ] **5b: Commit**

```
feat(demo-stockout): add filter router for multi-crossfilter dispatch
```

---

## Task 6: App Entry Point + Store Picker

**Files:**
- Create: `demo-stockout/app.js`

The orchestrator. On load: parse URL → show store picker or create workers → wire panels → render.

- [ ] **6a: Create `app.js`**

This module:
1. Imports router, cube-registry, filter-router, theme, all panels
2. Registers the ECharts theme
3. If no `store` in URL → fetches store list via Cube query, renders store picker grid, waits for selection
4. On store selected → creates 5 workers in parallel, registers them with filter-router
5. Wires `router.onStateChange` → `filterRouter.dispatchFilters`
6. When each worker is ready → renders its panels
7. Handles store change (dispose all workers, recreate)

The store list fetch is a direct Cube query (not through a crossfilter worker): POST `/api/cube` with dimensions `[stockout_store_dashboard.sold_location]`, measures `[stockout_store_dashboard.count]`, filter `partition = bonus.is`, format `json` (not Arrow — small payload).

Write the full module. Use `crossfilter.createStreamingDashboardWorker(...)` for each cube. Each worker creation uses `buildWorkerOptions(cubeId, store)` from `cube-registry.js`.

- [ ] **6b: Verify store picker works**

Run: `node demo-stockout/proxy-server.mjs &`
Open: `http://localhost:3334/demo-stockout/` (no hash) — should show store picker with store names from the API.
Click a store → URL hash updates to `#store=StoreName`, dashboard container shows, loading overlay appears.

- [ ] **6c: Commit**

```
feat(demo-stockout): add app entry point with store picker and worker orchestration
```

---

## Task 7: KPI Panel

**Files:**
- Create: `demo-stockout/panels/kpis.js`

First panel — proves the cf-store and cf-analysis workers are functioning and KPIs render correctly.

- [ ] **7a: Create `panels/kpis.js`**

Exports `renderKpis(cfStoreResult, cfAnalysisResult)`. Reads KPI values from snapshot, renders 6 cards into `#kpi-row`. Each card has label, value, and color class. Data Quality card reads the `byQuality` group from cf-analysis, finds the key with the highest count.

Formatting helpers: `formatPercent(v)`, `formatISK(v)`, `formatCount(v)`.

```js
export function renderKpis(storeSnapshot, analysisSnapshot) {
  var el = document.getElementById('kpi-row');
  if (!el) return;

  var kpis = storeSnapshot ? storeSnapshot.kpis : {};
  var availability = kpis.avgAvail != null ? kpis.avgAvail : null;
  var active = kpis.totalActive != null ? kpis.totalActive : 0;
  var worsening = kpis.worsening != null ? kpis.worsening : 0;
  var confirmed = kpis.confirmed != null ? kpis.confirmed : 0;
  var suspect = kpis.suspect != null ? kpis.suspect : 0;
  var totalStockouts = confirmed + suspect;
  var lostSales = kpis.lostSales != null ? kpis.lostSales : 0;

  // Data quality from cf-analysis byQuality group
  var qualityLabel = '—';
  if (analysisSnapshot && analysisSnapshot.groups && analysisSnapshot.groups.byQuality) {
    var entries = analysisSnapshot.groups.byQuality.entries || analysisSnapshot.groups.byQuality;
    if (Array.isArray(entries) && entries.length) {
      entries.sort(function (a, b) { return (b.value && b.value.count || 0) - (a.value && a.value.count || 0); });
      qualityLabel = entries[0].key || '—';
    }
  }

  el.innerHTML = [
    kpiCard('Store Availability', formatPercent(availability), availabilityClass(availability)),
    kpiCard('Active Stockouts', formatCount(active), active > 0 ? 'kpi-red' : 'kpi-green'),
    kpiCard('Worsening', formatCount(worsening), worsening > 0 ? 'kpi-red' : 'kpi-green'),
    kpiCard('Total Stockouts', formatCount(totalStockouts), '', 'Confirmed: ' + confirmed + ' · Suspect: ' + suspect),
    kpiCard('Est. Lost Sales', formatISK(lostSales), 'kpi-amber'),
    kpiCard('Data Quality', qualityLabel, qualityClass(qualityLabel)),
  ].join('');
}
// ... helper functions: kpiCard, formatPercent, formatISK, formatCount, availabilityClass, qualityClass
```

- [ ] **7b: Verify KPIs render with live data**

Open: `http://localhost:3334/demo-stockout/#store=<a real store name>` — KPI row should show 6 cards with real values from the API.

- [ ] **7c: Commit**

```
feat(demo-stockout): add KPI panel
```

---

## Task 8: Trend + Category + Risk Panels (ECharts)

**Files:**
- Create: `demo-stockout/panels/trend.js`
- Create: `demo-stockout/panels/category.js`
- Create: `demo-stockout/panels/risk-chart.js`

Three ECharts chart panels. Each exports a `render` function that takes a snapshot/query result and renders into its container.

- [ ] **8a: Create `panels/trend.js`**

Monthly trend line chart from cf-trend `byMonth` group. Dual Y-axes: left = stockout events (area), right = products affected (dashed). X-axis = month labels from time bucket keys.

- [ ] **8b: Create `panels/category.js`**

Horizontal bar chart from cf-store `byCategory` group. Sorted worst-first. Color-coded by availability threshold. Click handler calls `router.setState({ category: clickedKey })`.

- [ ] **8c: Create `panels/risk-chart.js`**

Horizontal bar chart from cf-store rows (top 10 by risk_score). Color-coded by risk threshold.

- [ ] **8d: Verify all 3 charts render**

Open dashboard with a store selected — trend line, category bars, and risk bars should show real data.

- [ ] **8e: Commit**

```
feat(demo-stockout): add trend, category, and risk chart panels
```

---

## Task 9: Table Panels (Stockout + Forecast + Early Warning)

**Files:**
- Create: `demo-stockout/panels/stockout-table.js`
- Create: `demo-stockout/panels/forecast.js`
- Create: `demo-stockout/panels/early-warning.js`

Three table panels rendering row data into HTML tables with badges.

- [ ] **9a: Create `panels/stockout-table.js`**

Currently stocked out products. Queries cf-store rows with `is_currently_active = true` filter, sorted by `risk_score` desc. Renders table with badges for risk_tier, trend_signal, forecast_warning.

- [ ] **9b: Create `panels/forecast.js`**

At-risk products with 3-day forecast. Queries cf-store rows with `is_currently_active = false` + `forecast_stockout_probability >= 0.3` filter. Two parts: forecast summary cards (top 3-4) and full table. Parses `forecast_daily_prob` and `forecast_day_names` JSON strings.

- [ ] **9c: Create `panels/early-warning.js`**

Worsening products table. Queries cf-warning rows (all), post-filters for `trend_signal === 'worsening' || severity_trend === 'worsening'`, sorts by `risk_score` desc. Renders table with delta arrows comparing recent vs older half columns.

- [ ] **9d: Verify all 3 tables render**

Open dashboard — stockout table, forecast cards + table, and early warning table should show real data with badges.

- [ ] **9e: Commit**

```
feat(demo-stockout): add stockout table, forecast, and early warning panels
```

---

## Task 10: DOW Pattern Panel

**Files:**
- Create: `demo-stockout/panels/dow-pattern.js`

- [ ] **10a: Create `panels/dow-pattern.js`**

DOW bar chart from cf-dow rows. Fetches all rows, sums `dow_*_confirmed` columns for 7 bars, averages `dow_*_probability` for color intensity. Renders badges below chart: most common `dow_pattern` (mode), `highest_risk_day` (mode), weekday vs weekend rate comparison.

- [ ] **10b: Verify DOW chart renders**

Open dashboard — DOW bar chart with 7 bars and badges below.

- [ ] **10c: Commit**

```
feat(demo-stockout): add DOW pattern panel
```

---

## Task 11: Click-to-Filter + Filter Chips + Clear

**Files:**
- Modify: `demo-stockout/app.js`
- Modify: `demo-stockout/panels/category.js` (already has click handler from Task 8)

Wire up the full filter cycle: click category bar → URL hash updates → filter-router dispatches to all runtimes → all panels re-render. Add filter chip display and clear button.

- [ ] **11a: Add filter chip rendering to app.js**

When state changes, render active filters as removable chips in `#filter-chips`. Each chip shows the filter label and has a click handler that removes it from the URL hash. Show/hide the "Clear Filters" button.

- [ ] **11b: Add click-to-filter to additional charts**

Risk chart bars: clicking a product bar sets `product` URL filter.
DOW chart: clicking a day bar could set a filter, but DOW isn't a filterable dimension — skip.
Table rows: clicking a row could navigate to product detail — out of scope for v1.

- [ ] **11c: Verify full filter cycle**

1. Open dashboard with store selected
2. Click a category bar (e.g., "Dairy")
3. URL hash updates to include `category=Dairy`
4. All panels update — stockout table shows only Dairy products, KPIs reflect Dairy-only metrics, trend shows Dairy-only events
5. Filter chip "Dairy" appears. Click × to remove. URL and panels reset.
6. Use browser back button — returns to the Dairy-filtered state.

- [ ] **11d: Commit**

```
feat(demo-stockout): wire click-to-filter, filter chips, and clear button
```

---

## Task 12: Store Change + Error Handling + Polish

**Files:**
- Modify: `demo-stockout/app.js`

- [ ] **12a: Wire store selector dropdown**

When the store selector `<select>` changes, call `router.setState({ store: newStore })` and clear all other filters. In the router `onStateChange` handler, detect store change → `filterRouter.disposeAll()` → recreate all 5 workers with new store → re-render.

- [ ] **12b: Add error handling**

- Worker creation failure → show "Data unavailable" in affected panels
- Cube API error → show error text in the loading overlay or in the affected panel
- Worker timeout (30s) → same as creation failure
- Empty data (0 rows) → show "No stockout data for this store"

- [ ] **12c: Add loading skeleton states**

Each panel container shows a subtle shimmer animation (CSS-only) until its data loads. Replace shimmer with real content when ready.

- [ ] **12d: Final visual polish**

- Ensure all animations fire correctly (fadeUp with cascading delays)
- Ensure ECharts charts resize on window resize
- Ensure table scroll works with sticky headers
- Test with multiple stores

- [ ] **12e: Commit**

```
feat(demo-stockout): add store change, error handling, and visual polish
```

---

## Task 13: Final Verification

- [ ] **13a: End-to-end smoke test**

1. `node demo-stockout/proxy-server.mjs`
2. Open `http://localhost:3334/demo-stockout/` — store picker appears
3. Select a store → dashboard loads with KPIs, charts, tables
4. Click a category bar → all panels filter
5. Clear filter → all panels reset
6. Change store via dropdown → full reload with new store
7. Copy URL with filters, paste in new tab → same dashboard state loads
8. Browser back/forward → state navigates correctly

- [ ] **13b: Commit any final fixes**

```
fix(demo-stockout): final adjustments from smoke testing
```

---

## Delivery Order

1. Task 1 (Proxy) — must work first, enables all API calls
2. Task 2 (HTML + CSS + Theme) — visual foundation
3. Task 3 (Router) — URL state management
4. Task 4 (Cube Registry) — cube configs and query builders
5. Task 5 (Filter Router) — multi-crossfilter coordination
6. Task 6 (App + Store Picker) — worker orchestration, entry point
7. Task 7 (KPIs) — first panel, proves the pipeline works end-to-end
8. Task 8 (Trend + Category + Risk) — ECharts chart panels
9. Task 9 (Stockout + Forecast + Early Warning) — table panels
10. Task 10 (DOW) — last panel
11. Task 11 (Click-to-Filter) — interactivity
12. Task 12 (Store Change + Error Handling + Polish) — robustness
13. Task 13 (Verification) — smoke test
