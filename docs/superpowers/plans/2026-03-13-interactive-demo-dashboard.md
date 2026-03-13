# Interactive Demo Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone HTML demo page that showcases every crossfilter2 API feature with 1M-row fleet-tracking Arrow data and 4 switchable engine modes for live performance comparison.

**Architecture:** Three files in `demo/` — an HTML shell that loads CDN dependencies + local crossfilter UMD, a CSS file with glass-morphism design tokens from cxs2, and a single ES module (`demo.js`) containing all dashboard logic. The module manages a central `state` object holding the crossfilter instance, all dimensions/groups, and current filter values. A `renderAll()` function batched via `requestAnimationFrame` updates every chart/KPI/table from group data.

**Tech Stack:** Vanilla JS (ES module), ECharts 5.5.1 (CDN), Apache Arrow 17.0.0 (CDN), crossfilter2 UMD bundle (local `crossfilter.js`).

**Spec:** `docs/superpowers/specs/2026-03-13-interactive-demo-dashboard-design.md`

---

## File Structure

```
demo/
  index.html    — HTML shell: CDN script tags, page layout skeleton, loading state
  demo.css      — All styles: CSS variables, glass cards, grid layout, filter controls, table
  demo.js       — All logic: data loading, crossfilter setup, dimensions, groups, KPIs,
                   filter controls, chart rendering, mode switching, demo controls, perf log
```

**Why a single JS file?** This is a self-contained demo, not a library. Splitting into many small modules would add import complexity without meaningful benefit — the file will be ~1200 lines, which is manageable for a flat procedural dashboard script. Sections are clearly delimited with comments.

---

## Chunk 1: Foundation (HTML + CSS + Data Loading)

### Task 1: Create demo directory and HTML shell

**Files:**
- Create: `demo/index.html`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p demo
```

- [ ] **Step 2: Write the HTML file**

Create `demo/index.html` with:
- `<!doctype html>`, charset, viewport meta
- Title: "Crossfilter2 — Interactive Demo"
- Google Fonts link for Lato (weights 300, 400, 700)
- `<link>` to `demo.css`
- `<script src="../crossfilter.js"></script>` (UMD bundle, sets `window.crossfilter`)
- `<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>` (ECharts, sets `window.echarts`)
- `<script>` tag that sets `window.Arrow` from the CDN ESM — use the pattern from `test/benchmark-arrow-browser.html` but with the CDN URL `https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm` loaded via a dynamic import that assigns to `window.Arrow`, then loads `demo.js`
- Body structure (all IDs for JS targeting):

```html
<div id="error-banner" class="error-banner" hidden></div>
<header id="header" class="header">
  <div class="header-left">
    <h1 class="header-title">Crossfilter2 <span class="header-subtitle">Interactive Demo</span></h1>
  </div>
  <div class="header-center">
    <div id="mode-selector" class="mode-selector">
      <button data-mode="row_baseline" class="mode-btn">Row (baseline)</button>
      <button data-mode="row_native" class="mode-btn">Row (native)</button>
      <button data-mode="arrow_js" class="mode-btn">Arrow + JS</button>
      <button data-mode="arrow_wasm" class="mode-btn mode-btn--active">Arrow + WASM</button>
    </div>
  </div>
  <div class="header-right">
    <span id="runtime-badge" class="badge">—</span>
    <span id="latency-display" class="badge badge--latency">— ms</span>
    <span id="load-time" class="badge">Load: — ms</span>
  </div>
</header>

<section id="filter-bar" class="filter-bar glass-card">
  <div class="filter-controls">
    <div class="filter-group">
      <label class="filter-label">Event Type</label>
      <div id="event-pills" class="pill-group"></div>
    </div>
    <div class="filter-group">
      <label class="filter-label">Customer Country</label>
      <select id="customer-country-select" class="filter-select"><option value="">All</option></select>
    </div>
    <div class="filter-group">
      <label class="filter-label">Location Country</label>
      <select id="location-country-select" class="filter-select"><option value="">All</option></select>
    </div>
    <div class="filter-group">
      <label class="filter-label">Region</label>
      <div id="region-multiselect" class="multiselect-container">
        <input type="text" id="region-search" class="filter-input" placeholder="Search regions...">
        <div id="region-checkboxes" class="checkbox-list"></div>
      </div>
    </div>
    <div class="filter-group">
      <label class="filter-label">Time Range</label>
      <div id="time-range-container" class="range-container">
        <input type="range" id="time-min" class="range-input" step="1">
        <input type="range" id="time-max" class="range-input" step="1">
        <div id="time-range-label" class="range-label">—</div>
      </div>
    </div>
    <div class="filter-group">
      <label class="filter-label">Latitude Range</label>
      <div class="lat-range">
        <input type="number" id="lat-min" class="filter-input filter-input--small" placeholder="Min" step="0.1">
        <span>–</span>
        <input type="number" id="lat-max" class="filter-input filter-input--small" placeholder="Max" step="0.1">
      </div>
    </div>
    <button id="clear-all-btn" class="btn btn--clear">Clear All</button>
  </div>
  <div id="filter-chips" class="filter-chips"></div>
</section>

<section id="kpi-row" class="kpi-row">
  <div id="kpi-total" class="glass-card kpi-card"><div class="kpi-value">—</div><div class="kpi-label">Total Events</div></div>
  <div id="kpi-locations" class="glass-card kpi-card"><div class="kpi-value">—</div><div class="kpi-label">Unique Locations</div></div>
  <div id="kpi-latitude" class="glass-card kpi-card"><div class="kpi-value">—</div><div class="kpi-label">Avg Latitude</div></div>
  <div id="kpi-timespan" class="glass-card kpi-card"><div class="kpi-value">—</div><div class="kpi-label">Time Span</div></div>
</section>

<section class="chart-grid">
  <div class="chart-col">
    <div class="glass-card chart-card"><div class="chart-header">Events by Type <span class="group-size-badge" id="event-group-size"></span></div><div id="chart-event" class="chart-container"></div></div>
    <div class="glass-card chart-card"><div class="chart-header">By Customer Country <span class="group-size-badge" id="cc-group-size"></span></div><div id="list-customer-country" class="list-container"></div></div>
    <div class="glass-card chart-card"><div class="chart-header">By Location Country <span class="group-size-badge" id="lc-group-size"></span></div><div id="list-location-country" class="list-container"></div></div>
  </div>
  <div class="chart-col">
    <div class="glass-card chart-card chart-card--tall"><div class="chart-header">Events over Time</div><div id="chart-timeline" class="chart-container chart-container--tall"></div></div>
    <div class="glass-card chart-card"><div class="chart-header">By Region <span class="group-size-badge" id="region-group-size"></span></div><div id="chart-region" class="chart-container"></div></div>
    <div class="glass-card chart-card"><div class="chart-header">By Division <span class="group-size-badge" id="division-group-size"></span></div><div id="chart-division" class="chart-container"></div></div>
  </div>
  <div class="chart-col">
    <div class="glass-card chart-card"><div class="chart-header">By Municipality (Top 20) <span class="group-size-badge" id="muni-group-size"></span></div><div id="list-municipality" class="list-container"></div></div>
    <div class="glass-card chart-card"><div class="chart-header">By Locality (Least Frequent) <span class="group-size-badge" id="loc-group-size"></span></div><div id="list-locality" class="list-container"></div></div>
    <div class="glass-card chart-card"><div class="chart-header">Top Postal Codes <span class="group-size-badge" id="postal-group-size"></span></div><div id="list-postal" class="list-container"></div></div>
  </div>
</section>

<section class="glass-card table-section">
  <div class="table-header">
    <span class="chart-header">Data Table</span>
    <div class="table-controls">
      <button id="table-sort-toggle" class="btn btn--small">Showing: Most Recent</button>
      <button id="table-prev" class="btn btn--small" disabled>← Prev</button>
      <span id="table-page-info" class="table-page-info">Page 1</span>
      <button id="table-next" class="btn btn--small">Next →</button>
    </div>
  </div>
  <div class="table-scroll">
    <table id="data-table" class="data-table">
      <thead><tr id="table-head"></tr></thead>
      <tbody id="table-body"></tbody>
    </table>
  </div>
</section>

<section class="demo-controls">
  <div class="demo-buttons">
    <button id="add-rows-btn" class="btn">Add 1000 Rows</button>
    <button id="remove-filtered-btn" class="btn btn--danger">Remove Excluded</button>
  </div>
  <div class="glass-card log-card">
    <div class="chart-header">Performance Log</div>
    <pre id="perf-log" class="perf-log"></pre>
  </div>
</section>

<div id="loading-overlay" class="loading-overlay">
  <div class="loading-spinner"></div>
  <div class="loading-text">Loading 1M rows...</div>
</div>
```

- [ ] **Step 3: Verify the file renders**

```bash
# From repo root
npx serve . -l 3333 &
# Open http://localhost:3333/demo/ in browser — should show the skeleton layout
```

- [ ] **Step 4: Commit**

```bash
git add demo/index.html
git commit -m "feat(demo): add HTML shell with full page layout skeleton"
```

---

### Task 2: Create CSS with glass-morphism styling

**Files:**
- Create: `demo/demo.css`

- [ ] **Step 1: Write the complete CSS file**

The CSS file should contain these sections in order:

**1. CSS custom properties** (`:root` block) — all design tokens from the spec:
```css
:root {
  --brand-primary: #3f6587;
  --brand-secondary: #99b8cc;
  --brand-accent: #000e4a;
  --brand-light: #c5d9e8;
  --brand-lighter: #f4f8fc;
  --surface-page: #f5f8ff;
  --surface-card: rgba(252, 254, 255, 0.40);
  --border-subtle: color-mix(in srgb, #3f6587 10%, transparent);
  --border-default: color-mix(in srgb, #3f6587 15%, transparent);
  --scrollbar-thumb: rgba(63, 101, 135, 0.3);
  --chart-axis-label: #333333;
  --glass-bg: linear-gradient(0deg, rgba(63,101,135,0.03) 0%, rgba(63,101,135,0.03) 100%),
              linear-gradient(180deg, rgba(252,254,255,0.40) 0%, rgba(252,254,255,0.10) 100%);
  --glass-border: rgba(255, 255, 255, 0.5);
  --glass-shadow: 2px 2px 15px 0 rgba(0, 21, 88, 0.05);
  --radius: 12px;
  --radius-sm: 8px;
}
```

**2. Reset and base styles:**
```css
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Lato', system-ui, sans-serif;
  background: var(--surface-page);
  color: var(--brand-accent);
  padding: 0 24px 24px;
  min-height: 100vh;
}
```

**3. `.glass-card` class** — the core reusable card:
```css
.glass-card {
  background: var(--glass-bg);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
  border-radius: var(--radius);
  padding: 16px;
}
```

**4. Header** — sticky top bar, flex layout with left/center/right sections. Mode buttons styled as a segmented control with `--brand-primary` active state, white text when active, ghost style when inactive.

**5. Filter bar** — flex wrap layout for `.filter-controls`. `.filter-group` takes min-width for reasonable sizing. `.pill-group` uses flex-wrap with small rounded pill buttons. `.filter-select` and `.filter-input` use consistent sizing with brand border. `.checkbox-list` is a scrollable div (max-height 150px) with checkboxes. `.range-container` positions two range inputs overlapped for a dual-handle slider. `.filter-chips` is a flex-wrap row of small dismissible chip elements.

**6. KPI row** — `.kpi-row` is a 4-column grid. `.kpi-card` centers content with `.kpi-value` in 28px bold and `.kpi-label` in 12px muted text.

**7. Chart grid** — `.chart-grid` is a 3-column grid with `gap: 16px`. `.chart-col` is a flex column with `gap: 16px`. `.chart-container` gets a fixed height of 250px. `.chart-container--tall` gets 350px. `.list-container` gets max-height 300px with overflow-y auto.

**8. List items** — `.list-item` is a flex row with a label, value, and a proportional bar background using a CSS linear-gradient on the element with a percentage width.

**9. Data table** — `.table-scroll` has overflow-x auto. `.data-table` is full-width with collapsed borders. `th` has sticky top, background `var(--surface-page)`, border-bottom `var(--border-default)`. `td` uses `var(--border-subtle)`. `.row-muted` gets opacity 0.4. `.table-controls` is a flex row with gap.

**10. Demo controls** — flex layout with buttons on left, log card expanding to fill. `.perf-log` is a `<pre>` with max-height 200px, overflow-y auto, dark bg (#111), light text, monospace font.

**11. Loading overlay** — fixed full-screen, centered spinner + text, semi-transparent white bg, z-index 1000.

**12. Utility classes** — `.btn` base button style, `.btn--clear` ghost variant, `.btn--danger` red variant, `.btn--small` compact variant, `.badge` inline-block pill with brand-light bg, `.badge--latency` with slightly larger font for the ms display.

**13. Scrollbar styling** — thin scrollbar with `--scrollbar-thumb` for webkit and firefox.

**14. Pill styles** — `.pill` has rounded-full, small padding, border. `.pill--active` has filled `--brand-primary` bg and white text.

- [ ] **Step 2: Verify visual rendering**

Open `http://localhost:3333/demo/` — the skeleton should now have glass-morphism cards, proper fonts, branded colors, and the grid layout visible even without data.

- [ ] **Step 3: Commit**

```bash
git add demo/demo.css
git commit -m "feat(demo): add glass-morphism CSS with cxs2 design tokens"
```

---

### Task 3: Create demo.js with data loading and field validation

**Files:**
- Create: `demo/demo.js`

- [ ] **Step 1: Write the initial module with constants and data loading**

```js
// demo/demo.js — Crossfilter2 Interactive Demo
// Loaded as ES module after crossfilter.js (UMD) and Arrow (CDN) are available.

var crossfilter = globalThis.crossfilter;
var Arrow = globalThis.Arrow;

// ─── Field Mapping ──────────────────────────────────────────────────
var FIELDS = {
  event: 'semantic_events__event',
  customer_country: 'semantic_events__dimensions_customer_country',
  location_label: 'semantic_events__location_label',
  location_country: 'semantic_events__location_country',
  division: 'semantic_events__location_division',
  latitude: 'semantic_events__location_latitude',
  locality: 'semantic_events__location_locality',
  municipality: 'semantic_events__location_municipality',
  postal_code: 'semantic_events__location_postal_code',
  postal_name: 'semantic_events__location_postal_name',
  region: 'semantic_events__location_region',
  location_code: 'semantic_events__location_code',
  timestamp: 'semantic_events__timestamp_minute'
};

var FIELD_LABELS = {
  event: 'Event Type',
  customer_country: 'Customer Country',
  location_label: 'Location',
  location_country: 'Location Country',
  division: 'Division',
  latitude: 'Latitude',
  locality: 'Locality',
  municipality: 'Municipality',
  postal_code: 'Postal Code',
  postal_name: 'Postal Name',
  region: 'Region',
  location_code: 'Location Code',
  timestamp: 'Timestamp'
};

// Table columns — includes sparse fields; cells render '—' when empty
var TABLE_COLUMNS = [
  'event', 'customer_country', 'location_country', 'region', 'division',
  'municipality', 'locality', 'location_label', 'postal_code',
  'postal_name', 'location_code', 'latitude', 'timestamp'
];

var ARROW_FILE = '../test/data/query-result.arrow';

var MODES = {
  row_baseline: { source: 'row', wasm: false, filterStrategy: 'function', kpiStrategy: 'separate' },
  row_native:   { source: 'row', wasm: false, filterStrategy: 'native',   kpiStrategy: 'combined' },
  arrow_js:     { source: 'arrow', wasm: false, filterStrategy: 'native',  kpiStrategy: 'combined' },
  arrow_wasm:   { source: 'arrow', wasm: true,  filterStrategy: 'native',  kpiStrategy: 'combined' }
};

// ─── State ──────────────────────────────────────────────────────────
var state = {
  arrowTable: null,
  materializedRows: null,
  cf: null,
  mode: 'arrow_wasm',
  dimensions: {},
  groups: {},
  kpis: null,
  filterValues: {},
  tableSort: 'top',
  tableOffset: 0,
  charts: {},
  dirty: false,
  rafId: null
};

// ─── DOM References ─────────────────────────────────────────────────
var dom = {};
function cacheDom() {
  dom.errorBanner = document.getElementById('error-banner');
  dom.runtimeBadge = document.getElementById('runtime-badge');
  dom.latencyDisplay = document.getElementById('latency-display');
  dom.loadTime = document.getElementById('load-time');
  dom.modeSelector = document.getElementById('mode-selector');
  dom.eventPills = document.getElementById('event-pills');
  dom.customerCountrySelect = document.getElementById('customer-country-select');
  dom.locationCountrySelect = document.getElementById('location-country-select');
  dom.regionSearch = document.getElementById('region-search');
  dom.regionCheckboxes = document.getElementById('region-checkboxes');
  dom.timeMin = document.getElementById('time-min');
  dom.timeMax = document.getElementById('time-max');
  dom.timeRangeLabel = document.getElementById('time-range-label');
  dom.latMin = document.getElementById('lat-min');
  dom.latMax = document.getElementById('lat-max');
  dom.clearAllBtn = document.getElementById('clear-all-btn');
  dom.filterChips = document.getElementById('filter-chips');
  dom.kpiTotal = document.querySelector('#kpi-total .kpi-value');
  dom.kpiLocations = document.querySelector('#kpi-locations .kpi-value');
  dom.kpiLatitude = document.querySelector('#kpi-latitude .kpi-value');
  dom.kpiTimespan = document.querySelector('#kpi-timespan .kpi-value');
  dom.tableBody = document.getElementById('table-body');
  dom.tableHead = document.getElementById('table-head');
  dom.tableSortToggle = document.getElementById('table-sort-toggle');
  dom.tablePrev = document.getElementById('table-prev');
  dom.tableNext = document.getElementById('table-next');
  dom.tablePageInfo = document.getElementById('table-page-info');
  dom.addRowsBtn = document.getElementById('add-rows-btn');
  dom.removeFilteredBtn = document.getElementById('remove-filtered-btn');
  dom.perfLog = document.getElementById('perf-log');
  dom.loadingOverlay = document.getElementById('loading-overlay');
}

// ─── Utilities ──────────────────────────────────────────────────────
function showError(message) {
  dom.errorBanner.textContent = message;
  dom.errorBanner.hidden = false;
}

function hideError() {
  dom.errorBanner.hidden = true;
}

function appendLog(message) {
  var now = new Date();
  var ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
    String(now.getMilliseconds()).padStart(3, '0')
  ].join(':').replace(/:(\d{3})$/, '.$1');
  dom.perfLog.textContent += '[' + ts + '] ' + message + '\n';
  dom.perfLog.scrollTop = dom.perfLog.scrollHeight;
}

function timedOp(label, fn) {
  var t0 = performance.now();
  var result = fn();
  var elapsed = performance.now() - t0;
  appendLog(label + ' — ' + elapsed.toFixed(2) + 'ms');
  dom.latencyDisplay.textContent = elapsed.toFixed(1) + ' ms';
  return result;
}

function formatTimestamp(epochMs) {
  if (epochMs == null || !Number.isFinite(epochMs)) return '—';
  return new Date(epochMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function formatNumber(n) {
  if (n == null) return '—';
  if (typeof n === 'number') return n.toLocaleString();
  return String(n);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// ─── Arrow Helpers ──────────────────────────────────────────────────
function getTableFromIPC(arrowModule) {
  return arrowModule.tableFromIPC
    || (arrowModule.default && arrowModule.default.tableFromIPC)
    || null;
}

function getFieldNames(table) {
  if (table && table.schema && Array.isArray(table.schema.fields)) {
    return table.schema.fields.map(function(f) { return f.name; });
  }
  return [];
}

function getColumn(table, fieldName) {
  if (typeof table.getChild === 'function') {
    var col = table.getChild(fieldName);
    if (col != null) return col;
  }
  if (typeof table.getColumn === 'function') {
    var col2 = table.getColumn(fieldName);
    if (col2 != null) return col2;
  }
  return table[fieldName];
}

function getValue(column, index) {
  if (column == null) return undefined;
  if (typeof column.get === 'function') return column.get(index);
  if (typeof column.at === 'function') return column.at(index);
  return column[index];
}

function materializeRows(table) {
  var fields = getFieldNames(table);
  var columns = fields.map(function(f, i) {
    return getColumn(table, f) || table.getChildAt(i);
  });
  var rows = new Array(table.numRows);
  for (var r = 0; r < table.numRows; r++) {
    var row = {};
    for (var c = 0; c < fields.length; c++) {
      row[fields[c]] = getValue(columns[c], r);
    }
    rows[r] = row;
  }
  return rows;
}

// ─── Data Loading ───────────────────────────────────────────────────
async function loadData() {
  if (!crossfilter) throw new Error('crossfilter.js not loaded. Ensure the UMD bundle is available at ../crossfilter.js');
  if (!Arrow) throw new Error('Apache Arrow not loaded. Check CDN availability.');

  var tableFromIPC = getTableFromIPC(Arrow);
  if (typeof tableFromIPC !== 'function') throw new Error('Arrow module does not export tableFromIPC.');

  var response = await fetch(ARROW_FILE);
  if (!response.ok) throw new Error('Failed to fetch ' + ARROW_FILE + ': ' + response.status + '. Serve the repo root with a static file server.');

  var bytes = new Uint8Array(await response.arrayBuffer());
  var table = tableFromIPC(bytes);

  // Validate fields
  var schemaFields = getFieldNames(table);
  var missing = [];
  for (var key in FIELDS) {
    if (schemaFields.indexOf(FIELDS[key]) === -1) missing.push(key + ' (' + FIELDS[key] + ')');
  }
  if (missing.length) throw new Error('Missing fields in Arrow data: ' + missing.join(', '));

  return table;
}

// ─── Bootstrap ──────────────────────────────────────────────────────
async function init() {
  cacheDom();
  try {
    dom.loadingOverlay.querySelector('.loading-text').textContent = 'Fetching Arrow data...';
    var t0 = performance.now();
    state.arrowTable = await loadData();
    appendLog('Arrow IPC decoded — ' + state.arrowTable.numRows.toLocaleString() + ' rows, ' + getFieldNames(state.arrowTable).length + ' columns');

    dom.loadingOverlay.querySelector('.loading-text').textContent = 'Building crossfilter...';
    buildEnvironment();
    renderAll();
    var loadElapsed = performance.now() - t0;
    dom.loadTime.textContent = 'Load: ' + loadElapsed.toFixed(0) + 'ms';

    dom.loadingOverlay.hidden = true;
    hideError();
  } catch (err) {
    dom.loadingOverlay.hidden = true;
    showError(err.message);
    console.error(err);
  }
}

init();
```

Note: `buildEnvironment()` is called but not yet defined — it will be added in Task 5. For now the page will show an error, which is expected.

- [ ] **Step 2: Verify the data loads in the browser**

Temporarily add `function buildEnvironment() { appendLog('buildEnvironment placeholder'); }` at the bottom of demo.js. Open the page. The loading overlay should disappear, the perf log should show the Arrow decode message, and the error banner should be hidden.

- [ ] **Step 3: Remove the placeholder and commit**

Remove the temporary `buildEnvironment` placeholder.

```bash
git add demo/demo.js
git commit -m "feat(demo): add demo.js with data loading, field validation, and utilities"
```

---

## Chunk 2: Crossfilter Engine (Dimensions, Groups, KPIs, Mode Switching)

### Task 4: Implement buildEnvironment and mode switching

**Files:**
- Modify: `demo/demo.js`

- [ ] **Step 1: Add the buildEnvironment function**

Append the following section to `demo/demo.js` after the utilities section and before `init()`. This creates the crossfilter instance, all 11 dimensions, all groups, and KPI reducers based on the current mode.

```js
// ─── Environment Build ──────────────────────────────────────────────
function buildEnvironment() {
  var modeConfig = MODES[state.mode];

  timedOp('configureRuntime(' + (modeConfig.wasm ? 'wasm' : 'js') + ')', function() {
    crossfilter.configureRuntime({ wasm: modeConfig.wasm });
  });

  var cf;
  if (modeConfig.source === 'arrow') {
    cf = timedOp('fromArrowTable(' + state.arrowTable.numRows + ' rows)', function() {
      return crossfilter.fromArrowTable(state.arrowTable);
    });
  } else {
    if (!state.materializedRows) {
      state.materializedRows = timedOp('materializeRows(' + state.arrowTable.numRows + ' rows)', function() {
        return materializeRows(state.arrowTable);
      });
    }
    cf = timedOp('crossfilter(' + state.materializedRows.length + ' rows)', function() {
      return crossfilter(state.materializedRows);
    });
  }
  state.cf = cf;

  // Create dimensions — all use string accessors (WASM-eligible) except latitude
  timedOp('create 11 dimensions', function() {
    state.dimensions = {
      event:            cf.dimension(FIELDS.event),
      customer_country: cf.dimension(FIELDS.customer_country),
      location_label:   cf.dimension(FIELDS.location_label),
      location_country: cf.dimension(FIELDS.location_country),
      division:         cf.dimension(FIELDS.division),
      latitude:         cf.dimension(function(d) { return d[FIELDS.latitude]; }),
      locality:         cf.dimension(FIELDS.locality),
      municipality:     cf.dimension(FIELDS.municipality),
      postal_code:      cf.dimension(FIELDS.postal_code),
      region:           cf.dimension(FIELDS.region),
      timestamp:        cf.dimension(FIELDS.timestamp)
    };
  });

  // Create groups
  timedOp('create groups', function() {
    state.groups = {
      event:            state.dimensions.event.group(),
      customer_country: state.dimensions.customer_country.group(),
      location_country: state.dimensions.location_country.group(),
      region:           state.dimensions.region.group(),
      division:         state.dimensions.division.group(),
      municipality:     state.dimensions.municipality.group(),
      locality:         state.dimensions.locality.group(),
      postal_code:      state.dimensions.postal_code.group(),
      timeline:         state.dimensions.timestamp.group(timeBucketFn)
    };

    // Apply specific reduce strategies per spec
    state.groups.region.reduceSum(function(d) { return d[FIELDS.latitude]; });
    state.groups.division.reduceCount();
    state.groups.locality.order(function(v) { return -v; });
  });

  // Create KPI reducers
  timedOp('create KPI reducers', function() {
    if (modeConfig.kpiStrategy === 'separate') {
      buildSeparateKpis();
    } else {
      buildCombinedKpi();
    }
  });

  // Register onChange
  cf.onChange(function() {
    scheduleRender();
  });

  // Update runtime badge
  var info = crossfilter.runtimeInfo();
  dom.runtimeBadge.textContent = info.active.toUpperCase() + ' | ' + cf.size().toLocaleString() + ' rows';
  if (!info.wasmSupported || (modeConfig.wasm && info.active !== 'wasm')) {
    dom.runtimeBadge.textContent += ' (WASM unavailable)';
  }

  // Populate filter controls
  populateFilterControls();

  // Note: renderAll() is NOT called here — the caller (init or switchMode)
  // is responsible for calling it after any filter restoration is complete.
  // This avoids a wasted render during mode switching.
}

function timeBucketFn(timestamp) {
  // Bucket to nearest hour
  if (!isFiniteNumber(timestamp)) return 0;
  return Math.floor(timestamp / 3600000) * 3600000;
}

function buildCombinedKpi() {
  var group = state.cf.groupAll().reduce(
    function(s, row) {
      s.totalRows += 1;
      var label = row[FIELDS.location_label];
      if (label != null && label !== '') {
        if (!s.locationSet.has(label)) s.locationSet.set(label, 0);
        s.locationSet.set(label, s.locationSet.get(label) + 1);
      }
      var lat = row[FIELDS.latitude];
      if (isFiniteNumber(lat) && lat !== 0) { s.latSum += lat; s.latCount += 1; }
      var ts = row[FIELDS.timestamp];
      if (isFiniteNumber(ts)) {
        if (ts < s.minTime) s.minTime = ts;
        if (ts > s.maxTime) s.maxTime = ts;
      }
      return s;
    },
    function(s, row) {
      s.totalRows -= 1;
      var label = row[FIELDS.location_label];
      if (label != null && label !== '' && s.locationSet.has(label)) {
        var c = s.locationSet.get(label) - 1;
        if (c <= 0) s.locationSet.delete(label);
        else s.locationSet.set(label, c);
      }
      var lat = row[FIELDS.latitude];
      if (isFiniteNumber(lat) && lat !== 0) { s.latSum -= lat; s.latCount -= 1; }
      // minTime/maxTime: cannot decrement efficiently, flag for recompute
      s.timeStale = true;
      return s;
    },
    function() {
      return { totalRows: 0, locationSet: new Map(), latSum: 0, latCount: 0,
               minTime: Infinity, maxTime: -Infinity, timeStale: false };
    }
  );
  state.kpis = { type: 'combined', group: group, separateGroups: null };
}

function buildSeparateKpis() {
  var totalRows = state.cf.groupAll().reduceCount();
  var latSum = state.cf.groupAll().reduceSum(function(d) {
    var v = d[FIELDS.latitude]; return isFiniteNumber(v) && v !== 0 ? v : 0;
  });
  var latCount = state.cf.groupAll().reduceSum(function(d) {
    var v = d[FIELDS.latitude]; return isFiniteNumber(v) && v !== 0 ? 1 : 0;
  });
  var locationCount = state.cf.groupAll().reduce(
    function(s, row) {
      var label = row[FIELDS.location_label];
      if (label != null && label !== '') {
        if (!s.set.has(label)) s.set.set(label, 0);
        s.set.set(label, s.set.get(label) + 1);
      }
      return s;
    },
    function(s, row) {
      var label = row[FIELDS.location_label];
      if (label != null && label !== '' && s.set.has(label)) {
        var c = s.set.get(label) - 1;
        if (c <= 0) s.set.delete(label);
        else s.set.set(label, c);
      }
      return s;
    },
    function() { return { set: new Map() }; }
  );
  var timeSpan = state.cf.groupAll().reduce(
    function(s, row) {
      var ts = row[FIELDS.timestamp];
      if (isFiniteNumber(ts)) {
        if (ts < s.minTime) s.minTime = ts;
        if (ts > s.maxTime) s.maxTime = ts;
      }
      return s;
    },
    function(s) {
      s.timeStale = true;
      return s;
    },
    function() { return { minTime: Infinity, maxTime: -Infinity, timeStale: false }; }
  );
  state.kpis = {
    type: 'separate',
    group: null,
    separateGroups: { totalRows: totalRows, latSum: latSum, latCount: latCount, locationCount: locationCount, timeSpan: timeSpan }
  };
}

function readKpis() {
  if (state.kpis.type === 'combined') {
    var s = state.kpis.group.value();
    // Recompute time bounds if stale
    if (s.timeStale) {
      recomputeTimeBounds(s);
    }
    return {
      totalRows: s.totalRows,
      uniqueLocations: s.locationSet.size,
      avgLat: s.latCount > 0 ? s.latSum / s.latCount : null,
      minTime: s.minTime === Infinity ? null : s.minTime,
      maxTime: s.maxTime === -Infinity ? null : s.maxTime
    };
  }
  var sg = state.kpis.separateGroups;
  var locState = sg.locationCount.value();
  var latS = sg.latSum.value();
  var latC = sg.latCount.value();
  var tsState = sg.timeSpan.value();
  if (tsState.timeStale) {
    recomputeTimeBounds(tsState);
  }
  return {
    totalRows: sg.totalRows.value(),
    uniqueLocations: locState.set.size,
    avgLat: latC > 0 ? latS / latC : null,
    minTime: tsState.minTime === Infinity ? null : tsState.minTime,
    maxTime: tsState.maxTime === -Infinity ? null : tsState.maxTime
  };
}

function recomputeTimeBounds(s) {
  s.minTime = Infinity;
  s.maxTime = -Infinity;
  var filtered = state.cf.allFiltered();
  for (var i = 0; i < filtered.length; i++) {
    var ts = filtered[i][FIELDS.timestamp];
    if (isFiniteNumber(ts)) {
      if (ts < s.minTime) s.minTime = ts;
      if (ts > s.maxTime) s.maxTime = ts;
    }
  }
  s.timeStale = false;
}
```

- [ ] **Step 2: Add the mode switching logic**

Append after the environment build section:

```js
// ─── Mode Switching ─────────────────────────────────────────────────
function saveFilterState() {
  var saved = {};
  for (var key in state.dimensions) {
    var dim = state.dimensions[key];
    if (dim.hasCurrentFilter()) {
      saved[key] = state.filterValues[key] || null;
    }
  }
  return saved;
}

function destroyEnvironment() {
  if (!state.cf) return;
  for (var gKey in state.groups) {
    if (state.groups[gKey] && typeof state.groups[gKey].dispose === 'function') {
      state.groups[gKey].dispose();
    }
  }
  if (state.kpis) {
    if (state.kpis.group) state.kpis.group.dispose();
    if (state.kpis.separateGroups) {
      for (var sKey in state.kpis.separateGroups) {
        state.kpis.separateGroups[sKey].dispose();
      }
    }
  }
  for (var dKey in state.dimensions) {
    if (state.dimensions[dKey] && typeof state.dimensions[dKey].dispose === 'function') {
      state.dimensions[dKey].dispose();
    }
  }
  state.cf = null;
  state.dimensions = {};
  state.groups = {};
  state.kpis = null;
}

function restoreFilterState(saved) {
  for (var key in saved) {
    if (!state.dimensions[key] || saved[key] == null) continue;
    applyFilter(key, saved[key]);
  }
}

function switchMode(newMode) {
  if (newMode === state.mode && state.cf) return;
  var saved = state.cf ? saveFilterState() : {};

  try {
    destroyEnvironment();
    state.mode = newMode;
    var t0 = performance.now();
    buildEnvironment();
    restoreFilterState(saved);
    renderAll(); // Single render after environment + filters are ready
    var elapsed = performance.now() - t0;
    dom.loadTime.textContent = 'Load: ' + elapsed.toFixed(0) + 'ms';
    appendLog('Mode switch to ' + newMode + ' — ' + elapsed.toFixed(2) + 'ms');
    updateModeButtons();
  } catch (err) {
    showError('Mode switch failed: ' + err.message);
    console.error(err);
  }
}

function updateModeButtons() {
  var buttons = dom.modeSelector.querySelectorAll('.mode-btn');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('mode-btn--active', buttons[i].dataset.mode === state.mode);
  }
}
```

- [ ] **Step 3: Add the render scheduling**

```js
// ─── Render Pipeline ────────────────────────────────────────────────
function scheduleRender() {
  if (state.rafId) return;
  state.dirty = true;
  state.rafId = requestAnimationFrame(function() {
    state.rafId = null;
    if (state.dirty) {
      state.dirty = false;
      renderAll();
    }
  });
}

function renderAll() {
  var t0 = performance.now();
  renderKpis();
  renderFilterChips();
  renderEventChart();
  renderListChart('customer_country', 'list-customer-country', 'cc-group-size');
  renderListChart('location_country', 'list-location-country', 'lc-group-size');
  renderTimelineChart();
  renderBarChart('region', 'chart-region', 'region-group-size');
  renderBarChart('division', 'chart-division', 'division-group-size');
  renderTopList('municipality', 'list-municipality', 'muni-group-size', 20);
  renderTopList('locality', 'list-locality', 'loc-group-size', 15);
  renderTopList('postal_code', 'list-postal', 'postal-group-size', 10);
  renderDataTable();
  updateRuntimeBadge();
  var elapsed = performance.now() - t0;
  appendLog('renderAll — ' + elapsed.toFixed(2) + 'ms');
}

function updateRuntimeBadge() {
  if (!state.cf) return;
  var info = crossfilter.runtimeInfo();
  dom.runtimeBadge.textContent = info.active.toUpperCase() + ' | ' + state.cf.size().toLocaleString() + ' rows';
}
```

- [ ] **Step 4: Add placeholder render functions so the module loads without errors**

```js
// ─── Render Stubs (replaced in Tasks 5-8) ───────────────────────────
function renderKpis() {}
function renderFilterChips() {}
function renderEventChart() {}
function renderListChart() {}
function renderTimelineChart() {}
function renderBarChart() {}
function renderTopList() {}
function renderDataTable() {}
function populateFilterControls() {}
function applyFilter() {}
```

Move `init()` call to the end of the file.

- [ ] **Step 5: Verify mode switching works**

Open the page. The log should show the build steps. Click different mode buttons — each should rebuild and log timings. The Arrow+WASM build should be fastest; row_baseline should be slowest due to row materialization.

- [ ] **Step 6: Commit**

```bash
git add demo/demo.js
git commit -m "feat(demo): add crossfilter engine with 11 dimensions, groups, KPIs, and mode switching"
```

---

## Chunk 3: Filter Controls and Rendering

### Task 5: Implement filter controls (populate + apply)

**Files:**
- Modify: `demo/demo.js` — replace `populateFilterControls` and `applyFilter` stubs

- [ ] **Step 1: Implement populateFilterControls**

Replace the `populateFilterControls` stub:

```js
function populateFilterControls() {
  // 1. Event pills
  var eventEntries = state.groups.event.all().slice().sort(function(a, b) { return b.value - a.value; });
  dom.eventPills.innerHTML = '';
  for (var i = 0; i < eventEntries.length; i++) {
    var pill = document.createElement('button');
    pill.className = 'pill';
    pill.textContent = eventEntries[i].key;
    pill.dataset.value = eventEntries[i].key;
    dom.eventPills.appendChild(pill);
  }
  dom.eventPills.addEventListener('click', function(e) {
    var pill = e.target.closest('.pill');
    if (!pill) return;
    pill.classList.toggle('pill--active');
    var active = [];
    var allPills = dom.eventPills.querySelectorAll('.pill--active');
    for (var j = 0; j < allPills.length; j++) active.push(allPills[j].dataset.value);
    applyFilter('event', active.length > 0 ? active : null);
  });

  // 2. Customer country dropdown
  populateSelect(dom.customerCountrySelect, state.groups.customer_country.all());
  dom.customerCountrySelect.addEventListener('change', function() {
    applyFilter('customer_country', this.value || null);
  });

  // 3. Location country dropdown
  populateSelect(dom.locationCountrySelect, state.groups.location_country.all());
  dom.locationCountrySelect.addEventListener('change', function() {
    applyFilter('location_country', this.value || null);
  });

  // 4. Region checkboxes
  var regionEntries = state.groups.region.all().slice()
    .filter(function(d) { return d.key != null && d.key !== ''; })
    .sort(function(a, b) { return b.value - a.value; });
  dom.regionCheckboxes.innerHTML = '';
  for (var r = 0; r < regionEntries.length; r++) {
    var label = document.createElement('label');
    label.className = 'checkbox-label';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = regionEntries[r].key;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + regionEntries[r].key + ' (' + regionEntries[r].value + ')'));
    dom.regionCheckboxes.appendChild(label);
  }
  dom.regionCheckboxes.addEventListener('change', function() {
    var checked = [];
    var cbs = dom.regionCheckboxes.querySelectorAll('input:checked');
    for (var k = 0; k < cbs.length; k++) checked.push(cbs[k].value);
    applyFilter('region', checked.length > 0 ? checked : null);
  });
  dom.regionSearch.addEventListener('input', function() {
    var term = this.value.toLowerCase();
    var labels = dom.regionCheckboxes.querySelectorAll('.checkbox-label');
    for (var m = 0; m < labels.length; m++) {
      labels[m].style.display = labels[m].textContent.toLowerCase().indexOf(term) >= 0 ? '' : 'none';
    }
  });

  // 5. Time range slider
  var oldest = state.dimensions.timestamp.bottom(1);
  var newest = state.dimensions.timestamp.top(1);
  var minTs = oldest.length > 0 ? oldest[0][FIELDS.timestamp] : 0;
  var maxTs = newest.length > 0 ? newest[0][FIELDS.timestamp] : 1;
  dom.timeMin.min = dom.timeMax.min = minTs;
  dom.timeMin.max = dom.timeMax.max = maxTs;
  dom.timeMin.value = minTs;
  dom.timeMax.value = maxTs;
  dom.timeRangeLabel.textContent = 'All';

  function onTimeChange() {
    var lo = +dom.timeMin.value;
    var hi = +dom.timeMax.value;
    if (lo > hi) { var tmp = lo; lo = hi; hi = tmp; }
    if (lo <= minTs && hi >= maxTs) {
      applyFilter('timestamp', null);
      dom.timeRangeLabel.textContent = 'All';
    } else {
      applyFilter('timestamp', [lo, hi]);
      dom.timeRangeLabel.textContent = formatTimestamp(lo).split(' ')[0] + ' – ' + formatTimestamp(hi).split(' ')[0];
    }
  }
  dom.timeMin.addEventListener('input', onTimeChange);
  dom.timeMax.addEventListener('input', onTimeChange);

  // 6. Latitude range inputs
  function onLatChange() {
    var min = dom.latMin.value !== '' ? parseFloat(dom.latMin.value) : undefined;
    var max = dom.latMax.value !== '' ? parseFloat(dom.latMax.value) : undefined;
    if (min === undefined && max === undefined) {
      applyFilter('latitude', null);
    } else {
      applyFilter('latitude', { min: min, max: max });
    }
  }
  dom.latMin.addEventListener('change', onLatChange);
  dom.latMax.addEventListener('change', onLatChange);
}

function populateSelect(selectEl, entries) {
  var sorted = entries.slice()
    .filter(function(d) { return d.key != null && d.key !== ''; })
    .sort(function(a, b) { return b.value - a.value; });
  // Keep the first "All" option, clear the rest
  while (selectEl.options.length > 1) selectEl.remove(1);
  for (var i = 0; i < sorted.length; i++) {
    var opt = document.createElement('option');
    opt.value = sorted[i].key;
    opt.textContent = sorted[i].key + ' (' + sorted[i].value + ')';
    selectEl.appendChild(opt);
  }
}
```

- [ ] **Step 2: Implement applyFilter**

Replace the `applyFilter` stub:

```js
function applyFilter(key, value) {
  var dim = state.dimensions[key];
  if (!dim) return;
  var modeConfig = MODES[state.mode];

  state.filterValues[key] = value;

  if (value == null || (Array.isArray(value) && value.length === 0)) {
    timedOp('filterAll(' + key + ')', function() { dim.filterAll(); });
    return;
  }

  if (key === 'latitude') {
    // filterFunction — custom predicate
    var min = value.min, max = value.max;
    var hasMin = isFiniteNumber(min), hasMax = isFiniteNumber(max);
    if (!hasMin && !hasMax) {
      timedOp('filterAll(' + key + ')', function() { dim.filterAll(); });
    } else {
      timedOp('filterFunction(latitude, ' + min + '-' + max + ')', function() {
        dim.filterFunction(function(v) {
          if (!isFiniteNumber(v)) return false;
          if (hasMin && v < min) return false;
          if (hasMax && v > max) return false;
          return true;
        });
      });
    }
    return;
  }

  if (key === 'timestamp') {
    timedOp('filterRange(timestamp, ' + formatTimestamp(value[0]) + ' – ' + formatTimestamp(value[1]) + ')', function() {
      dim.filterRange(value);
    });
    return;
  }

  // Discrete dimension
  if (Array.isArray(value)) {
    if (value.length === 1) {
      timedOp('filterExact(' + key + ', ' + value[0] + ')', function() { dim.filterExact(value[0]); });
    } else if (modeConfig.filterStrategy === 'function') {
      // Baseline mode: use filterFunction
      var set = new Set(value);
      timedOp('filterFunction(' + key + ', ' + value.length + ' values)', function() {
        dim.filterFunction(function(v) { return set.has(v); });
      });
    } else {
      timedOp('filterIn(' + key + ', ' + value.length + ' values)', function() { dim.filterIn(value); });
    }
  } else {
    timedOp('filterExact(' + key + ', ' + value + ')', function() { dim.filterExact(value); });
  }
}

function clearAllFilters() {
  timedOp('clearAllFilters', function() {
    for (var key in state.dimensions) {
      state.dimensions[key].filterAll();
    }
    state.filterValues = {};
    // Reset locality group to natural ordering (demonstrates orderNatural)
    // then re-apply reverse order — this proves both order() and orderNatural() work
    state.groups.locality.orderNatural();
    state.groups.locality.order(function(v) { return -v; });
  });
  // Reset UI controls
  var pills = dom.eventPills.querySelectorAll('.pill');
  for (var i = 0; i < pills.length; i++) pills[i].classList.remove('pill--active');
  dom.customerCountrySelect.value = '';
  dom.locationCountrySelect.value = '';
  var checkboxes = dom.regionCheckboxes.querySelectorAll('input[type="checkbox"]');
  for (var j = 0; j < checkboxes.length; j++) checkboxes[j].checked = false;
  dom.latMin.value = '';
  dom.latMax.value = '';
  // Time range sliders reset to full range
  dom.timeMin.value = dom.timeMin.min;
  dom.timeMax.value = dom.timeMax.max;
  dom.timeRangeLabel.textContent = 'All';
}
```

- [ ] **Step 3: Implement renderFilterChips**

Replace the stub:

```js
function renderFilterChips() {
  var html = '';
  for (var key in state.dimensions) {
    if (key === 'location_label') continue; // no direct filter for this
    var dim = state.dimensions[key];
    if (!dim.hasCurrentFilter()) continue;
    var display = FIELD_LABELS[key] || key;
    var val = dim.currentFilter();
    var valStr = Array.isArray(val) ? val.length + ' selected' : String(val);
    if (key === 'timestamp' && Array.isArray(val)) {
      valStr = formatTimestamp(val[0]) + ' – ' + formatTimestamp(val[1]);
    }
    html += '<span class="chip" data-key="' + key + '">' + display + ': ' + valStr + ' <button class="chip-dismiss">&times;</button></span>';
  }
  dom.filterChips.innerHTML = html;
  // Attach dismiss handlers
  var chips = dom.filterChips.querySelectorAll('.chip-dismiss');
  for (var i = 0; i < chips.length; i++) {
    chips[i].onclick = function() {
      var chipKey = this.parentElement.dataset.key;
      applyFilter(chipKey, null);
      // Also reset the corresponding UI control
      resetFilterControl(chipKey);
    };
  }
}

function resetFilterControl(key) {
  if (key === 'event') {
    var pills = dom.eventPills.querySelectorAll('.pill');
    for (var i = 0; i < pills.length; i++) pills[i].classList.remove('pill--active');
  } else if (key === 'customer_country') {
    dom.customerCountrySelect.value = '';
  } else if (key === 'location_country') {
    dom.locationCountrySelect.value = '';
  } else if (key === 'region') {
    var cbs = dom.regionCheckboxes.querySelectorAll('input[type="checkbox"]');
    for (var j = 0; j < cbs.length; j++) cbs[j].checked = false;
  } else if (key === 'timestamp') {
    dom.timeMin.value = dom.timeMin.min;
    dom.timeMax.value = dom.timeMax.max;
    dom.timeRangeLabel.textContent = 'All';
  } else if (key === 'latitude') {
    dom.latMin.value = '';
    dom.latMax.value = '';
  }
}
```

- [ ] **Step 4: Wire up event listeners for mode switching and clear-all**

Add to `init()` after `buildEnvironment()`:

```js
// Mode switcher
dom.modeSelector.addEventListener('click', function(e) {
  var btn = e.target.closest('.mode-btn');
  if (!btn) return;
  switchMode(btn.dataset.mode);
});

// Clear all
dom.clearAllBtn.addEventListener('click', clearAllFilters);
```

- [ ] **Step 5: Verify filter interactions in browser**

Open the page. Event pills should appear and be clickable. Country dropdowns should populate. Clicking a pill should add a filter chip and log the timing.

- [ ] **Step 6: Commit**

```bash
git add demo/demo.js
git commit -m "feat(demo): implement filter controls with filterIn, filterExact, filterRange, filterFunction"
```

---

### Task 6: Implement KPI card rendering

**Files:**
- Modify: `demo/demo.js` — replace `renderKpis` stub

- [ ] **Step 1: Implement renderKpis**

```js
function renderKpis() {
  var kpis = readKpis();
  var total = state.cf.size();
  var pct = total > 0 ? ((kpis.totalRows / total) * 100).toFixed(1) : '0';
  dom.kpiTotal.innerHTML = formatNumber(kpis.totalRows) + ' <span class="kpi-pct">(' + pct + '%)</span>';
  dom.kpiLocations.textContent = formatNumber(kpis.uniqueLocations);
  dom.kpiLatitude.textContent = kpis.avgLat != null ? kpis.avgLat.toFixed(4) + '\u00B0' : '—';
  dom.kpiTimespan.textContent = (kpis.minTime != null && kpis.maxTime != null)
    ? formatTimestamp(kpis.minTime).split(' ')[0] + ' – ' + formatTimestamp(kpis.maxTime).split(' ')[0]
    : '—';
}
```

- [ ] **Step 2: Add `.kpi-pct` style to demo.css**

```css
.kpi-pct { font-size: 14px; font-weight: 300; opacity: 0.6; }
```

- [ ] **Step 3: Verify KPI cards show real numbers**

Open the page. Should see Total Events count (1,000,000), Unique Locations count, Avg Latitude value, and Time Span dates. Apply a filter — KPIs should update.

- [ ] **Step 4: Commit**

```bash
git add demo/demo.js demo/demo.css
git commit -m "feat(demo): implement KPI card rendering with combined and separate reducers"
```

---

## Chunk 4: Charts and Lists

### Task 7: Implement ECharts-based charts

**Files:**
- Modify: `demo/demo.js` — replace `renderEventChart`, `renderTimelineChart`, `renderBarChart` stubs

- [ ] **Step 1: Add chart initialization**

In `buildEnvironment()`, after the initial render call, add chart instance creation:

```js
// Initialize ECharts instances
if (!state.charts.event) {
  state.charts.event = echarts.init(document.getElementById('chart-event'));
  state.charts.timeline = echarts.init(document.getElementById('chart-timeline'));
  state.charts.region = echarts.init(document.getElementById('chart-region'));
  state.charts.division = echarts.init(document.getElementById('chart-division'));
}
```

Also add `var echarts = globalThis.echarts;` at the top of the file near the crossfilter/Arrow declarations. (The ECharts CDN script tag was already included in the HTML from Task 1.)

- [ ] **Step 2: Implement renderEventChart**

```js
function renderEventChart() {
  var data = state.groups.event.all().slice().sort(function(a, b) { return a.value - b.value; });
  var categories = data.map(function(d) { return d.key; });
  var values = data.map(function(d) { return d.value; });
  document.getElementById('event-group-size').textContent = state.groups.event.size() + ' types';

  state.charts.event.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 140, right: 20, top: 10, bottom: 20 },
    xAxis: { type: 'value', axisLabel: { color: '#333333' } },
    yAxis: { type: 'category', data: categories, axisLabel: { color: '#333333', fontSize: 11 } },
    series: [{ type: 'bar', data: values, itemStyle: { color: '#3f6587' }, barMaxWidth: 30 }]
  }, true);

  // Click to filter
  state.charts.event.off('click');
  state.charts.event.on('click', function(params) {
    applyFilter('event', [params.name]);
  });
}
```

- [ ] **Step 3: Implement renderTimelineChart**

```js
function renderTimelineChart() {
  var data = state.groups.timeline.all().slice()
    .filter(function(d) { return d.key > 0; })
    .sort(function(a, b) { return a.key - b.key; });
  var xData = data.map(function(d) { return new Date(d.key).toISOString().slice(0, 13) + ':00'; });
  var yData = data.map(function(d) { return d.value; });

  state.charts.timeline.setOption({
    tooltip: { trigger: 'axis' },
    grid: { left: 60, right: 20, top: 30, bottom: 60 },
    xAxis: { type: 'category', data: xData, axisLabel: { rotate: 45, fontSize: 10, color: '#333' } },
    yAxis: { type: 'value', axisLabel: { color: '#333' } },
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      { type: 'slider', start: 0, end: 100, bottom: 5, height: 20 }
    ],
    series: [{
      type: 'line', data: yData, areaStyle: { opacity: 0.15 },
      lineStyle: { color: '#3f6587', width: 1.5 },
      itemStyle: { color: '#3f6587' }, symbol: 'none', smooth: true
    }]
  }, true);

  // Brush-to-filter: use dataZoom event
  state.charts.timeline.off('datazoom');
  state.charts.timeline.on('datazoom', function() {
    var option = state.charts.timeline.getOption();
    var zoom = option.dataZoom[0];
    if (zoom.startValue != null && zoom.endValue != null && data.length > 0) {
      var startIdx = Math.max(0, Math.floor(zoom.startValue));
      var endIdx = Math.min(data.length - 1, Math.ceil(zoom.endValue));
      if (startIdx < data.length && endIdx >= 0 && (startIdx > 0 || endIdx < data.length - 1)) {
        applyFilter('timestamp', [data[startIdx].key, data[endIdx].key]);
      }
    }
  });
}
```

- [ ] **Step 4: Implement renderBarChart (reusable for region and division)**

```js
function renderBarChart(groupKey, containerId, sizeId) {
  var group = state.groups[groupKey];
  var data = group.all().slice()
    .filter(function(d) { return d.key != null && d.key !== ''; })
    .sort(function(a, b) { return b.value - a.value; })
    .slice(0, 15);
  var categories = data.map(function(d) { return d.key; });
  var values = data.map(function(d) { return typeof d.value === 'number' ? d.value : 0; });
  document.getElementById(sizeId).textContent = group.size() + ' values';

  var chart = state.charts[groupKey];
  if (!chart) {
    chart = echarts.init(document.getElementById(containerId));
    state.charts[groupKey] = chart;
  }

  chart.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 10, right: 20, top: 10, bottom: 30, containLabel: true },
    xAxis: { type: 'category', data: categories, axisLabel: { rotate: 45, fontSize: 10, color: '#333' } },
    yAxis: { type: 'value', axisLabel: { color: '#333', fontSize: 10 } },
    series: [{ type: 'bar', data: values, itemStyle: { color: '#99b8cc' }, barMaxWidth: 24 }]
  }, true);

  chart.off('click');
  chart.on('click', function(params) {
    applyFilter(groupKey, [params.name]);
  });
}
```

- [ ] **Step 5: Verify charts render with real data**

Open the page. Events by Type should show a horizontal bar chart. Events over Time should show a line/area chart with dataZoom. Region and Division should show vertical bar charts. Clicking bars should apply filters.

- [ ] **Step 6: Commit**

```bash
git add demo/demo.js demo/index.html
git commit -m "feat(demo): implement ECharts for event, timeline, region, and division charts"
```

---

### Task 8: Implement list components

**Files:**
- Modify: `demo/demo.js` — replace `renderListChart` and `renderTopList` stubs

- [ ] **Step 1: Implement renderListChart (full sorted list with proportional bars)**

```js
function renderListChart(groupKey, containerId, sizeId) {
  var group = state.groups[groupKey];
  var data = group.all().slice()
    .filter(function(d) { return d.key != null && d.key !== ''; })
    .sort(function(a, b) { return b.value - a.value; });
  var container = document.getElementById(containerId);
  document.getElementById(sizeId).textContent = group.size() + ' values';
  var maxVal = data.length > 0 ? data[0].value : 1;

  var html = '';
  for (var i = 0; i < data.length; i++) {
    var pct = maxVal > 0 ? ((data[i].value / maxVal) * 100).toFixed(1) : 0;
    html += '<div class="list-item" data-key="' + escapeHtml(data[i].key) + '" data-group="' + groupKey + '">'
      + '<div class="list-bar" style="width:' + pct + '%"></div>'
      + '<span class="list-label">' + escapeHtml(data[i].key) + '</span>'
      + '<span class="list-value">' + formatNumber(data[i].value) + '</span>'
      + '</div>';
  }
  container.innerHTML = html;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```

Add a delegated click handler (once, in `init()`):

```js
document.querySelector('.chart-grid').addEventListener('click', function(e) {
  var item = e.target.closest('.list-item');
  if (!item) return;
  var key = item.dataset.key;
  var group = item.dataset.group;
  if (!key || !group) return;
  if (e.ctrlKey || e.metaKey) {
    // Multi-select: accumulate
    var current = state.filterValues[group];
    if (Array.isArray(current)) {
      var idx = current.indexOf(key);
      if (idx >= 0) {
        current = current.filter(function(v) { return v !== key; });
      } else {
        current = current.concat([key]);
      }
    } else {
      current = [key];
    }
    applyFilter(group, current.length > 0 ? current : null);
  } else {
    applyFilter(group, [key]);
  }
});
```

- [ ] **Step 2: Implement renderTopList (top-K lists for municipality, locality, postal)**

```js
function renderTopList(groupKey, containerId, sizeId, k) {
  var group = state.groups[groupKey];
  var data = group.top(k);
  var container = document.getElementById(containerId);
  document.getElementById(sizeId).textContent = group.size() + ' values';
  var maxVal = data.length > 0 ? data[0].value : 1;

  var html = '';
  for (var i = 0; i < data.length; i++) {
    var pct = maxVal > 0 ? ((data[i].value / maxVal) * 100).toFixed(1) : 0;
    html += '<div class="list-item" data-key="' + escapeHtml(data[i].key) + '" data-group="' + groupKey + '">'
      + '<div class="list-bar" style="width:' + pct + '%"></div>'
      + '<span class="list-label">' + escapeHtml(data[i].key) + '</span>'
      + '<span class="list-value">' + formatNumber(data[i].value) + '</span>'
      + '</div>';
  }
  container.innerHTML = html;
}
```

Note: For the locality list, `state.groups.locality.order(function(v) { return -v; })` was already set in `buildEnvironment`, so `group.top(15)` returns the *least* frequent entries, demonstrating `group.order()`.

- [ ] **Step 3: Add list item CSS to demo.css**

```css
.list-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  cursor: pointer;
  border-bottom: 1px solid var(--border-subtle);
  transition: background 0.15s;
}
.list-item:hover { background: rgba(63, 101, 135, 0.06); }
.list-bar {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  background: rgba(63, 101, 135, 0.08);
  border-radius: 0 4px 4px 0;
  pointer-events: none;
}
.list-label { position: relative; z-index: 1; font-size: 13px; }
.list-value { position: relative; z-index: 1; font-size: 12px; color: var(--brand-primary); font-weight: 700; }
```

- [ ] **Step 4: Verify lists render and click filtering works**

Open the page. Customer Country list should show sorted entries with proportional bars. Municipality should show top 20. Clicking an item should filter. Ctrl+click should multi-select.

- [ ] **Step 5: Commit**

```bash
git add demo/demo.js demo/demo.css
git commit -m "feat(demo): implement list components with proportional bars, top-K, and click-to-filter"
```

---

## Chunk 5: Data Table, Demo Controls, Polish

### Task 9: Implement the data table

**Files:**
- Modify: `demo/demo.js` — replace `renderDataTable` stub

- [ ] **Step 1: Implement renderDataTable**

```js
function renderDataTable() {
  // Build header if needed
  if (!dom.tableHead.children.length) {
    var headHtml = '';
    for (var h = 0; h < TABLE_COLUMNS.length; h++) {
      headHtml += '<th>' + (FIELD_LABELS[TABLE_COLUMNS[h]] || TABLE_COLUMNS[h]) + '</th>';
    }
    dom.tableHead.innerHTML = headHtml;
  }

  var dim = state.dimensions.timestamp;
  var rows;
  if (state.tableSort === 'top') {
    rows = dim.top(50, state.tableOffset);
  } else {
    rows = dim.bottom(50, state.tableOffset);
  }

  // Build an index lookup for isElementFiltered demo.
  // cf.all() returns all records in insertion order — we match row objects
  // by reference to find their original index for isElementFiltered().
  var allRecords = state.cf.all();
  var rowIndexMap = new Map();
  for (var ri = 0; ri < allRecords.length; ri++) {
    rowIndexMap.set(allRecords[ri], ri);
  }

  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var idx = rowIndexMap.get(row);
    var isMuted = (idx != null && !state.cf.isElementFiltered(idx));
    html += '<tr class="' + (isMuted ? 'row-muted' : '') + '">';
    for (var c = 0; c < TABLE_COLUMNS.length; c++) {
      var key = TABLE_COLUMNS[c];
      var val = row[FIELDS[key]];
      if (key === 'timestamp') {
        val = formatTimestamp(val);
      } else if (key === 'latitude') {
        val = isFiniteNumber(val) ? val.toFixed(6) : '—';
      } else {
        val = val != null && val !== '' ? escapeHtml(val) : '<span class="muted">—</span>';
      }
      html += '<td>' + val + '</td>';
    }
    html += '</tr>';
  }
  dom.tableBody.innerHTML = html;

  // Update page info
  var page = Math.floor(state.tableOffset / 50) + 1;
  dom.tablePageInfo.textContent = 'Page ' + page;
  dom.tablePrev.disabled = state.tableOffset === 0;
}
```

- [ ] **Step 2: Wire up table controls in init()**

```js
dom.tableSortToggle.addEventListener('click', function() {
  state.tableSort = state.tableSort === 'top' ? 'bottom' : 'top';
  state.tableOffset = 0;
  dom.tableSortToggle.textContent = 'Showing: ' + (state.tableSort === 'top' ? 'Most Recent' : 'Oldest');
  renderDataTable();
});

dom.tableNext.addEventListener('click', function() {
  state.tableOffset += 50;
  renderDataTable();
});

dom.tablePrev.addEventListener('click', function() {
  state.tableOffset = Math.max(0, state.tableOffset - 50);
  renderDataTable();
});
```

- [ ] **Step 3: Verify table renders with pagination**

Open the page. Data table should show 50 rows with all columns. "Next" button should paginate. Toggle should switch between most recent and oldest.

- [ ] **Step 4: Commit**

```bash
git add demo/demo.js
git commit -m "feat(demo): implement data table with top/bottom toggle and pagination"
```

---

### Task 10: Implement demo controls (add rows, remove filtered)

**Files:**
- Modify: `demo/demo.js`

- [ ] **Step 1: Implement add rows and remove filtered**

```js
// ─── Demo Controls ──────────────────────────────────────────────────
function generateSyntheticRows(count) {
  var allData = state.cf.all();
  if (allData.length === 0) return [];

  var rows = new Array(count);
  for (var i = 0; i < count; i++) {
    var source = allData[Math.floor(Math.random() * allData.length)];
    var row = {};
    // Copy all fields from a random existing row, then jitter timestamp and latitude
    for (var key in FIELDS) {
      row[FIELDS[key]] = source[FIELDS[key]];
    }
    // Jitter timestamp by +/- 1 hour
    var ts = row[FIELDS.timestamp];
    if (isFiniteNumber(ts)) {
      row[FIELDS.timestamp] = ts + Math.floor((Math.random() - 0.5) * 7200000);
    }
    // Jitter latitude by +/- 0.5 degrees
    var lat = row[FIELDS.latitude];
    if (isFiniteNumber(lat)) {
      row[FIELDS.latitude] = lat + (Math.random() - 0.5);
    }
    rows[i] = row;
  }
  return rows;
}

function onAddRows() {
  var rows = generateSyntheticRows(1000);
  timedOp('cf.add(1000 rows)', function() {
    state.cf.add(rows);
  });
}

function onRemoveFiltered() {
  var before = state.cf.size();
  timedOp('cf.remove()', function() {
    state.cf.remove();
  });
  var after = state.cf.size();
  appendLog('Removed ' + (before - after).toLocaleString() + ' rows, ' + after.toLocaleString() + ' remaining');
}
```

- [ ] **Step 2: Wire up buttons in init()**

```js
dom.addRowsBtn.addEventListener('click', onAddRows);
dom.removeFilteredBtn.addEventListener('click', onRemoveFiltered);
```

- [ ] **Step 3: Verify add/remove in browser**

Click "Add 1000 Rows" — KPI total should increase by 1000, charts update. Apply a filter, click "Remove Excluded" — excluded (non-matching) rows should be removed, total decreases.

- [ ] **Step 4: Commit**

```bash
git add demo/demo.js
git commit -m "feat(demo): implement add rows and remove filtered demo controls"
```

---

### Task 11: Final polish and manual verification

**Files:**
- Modify: `demo/demo.css` (minor adjustments)
- Modify: `demo/index.html` (if needed)

- [ ] **Step 1: Add chip CSS to demo.css**

```css
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 20px;
  background: var(--brand-light);
  color: var(--brand-accent);
  font-size: 12px;
  margin: 4px;
}
.chip-dismiss {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--brand-primary);
  padding: 0 2px;
  line-height: 1;
}
.chip-dismiss:hover { color: #c00; }
```

- [ ] **Step 2: Add `.muted` class and loading overlay animation**

```css
.muted { color: #999; }

.loading-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(245, 248, 255, 0.9);
  z-index: 1000;
}
.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--brand-light);
  border-top-color: var(--brand-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.loading-text {
  margin-top: 12px;
  font-size: 14px;
  color: var(--brand-primary);
}
```

- [ ] **Step 3: Resize ECharts on window resize**

Add to `init()`:

```js
window.addEventListener('resize', function() {
  for (var key in state.charts) {
    if (state.charts[key] && typeof state.charts[key].resize === 'function') {
      state.charts[key].resize();
    }
  }
});
```

- [ ] **Step 4: Full manual verification checklist**

Open `http://localhost:3333/demo/` and verify:

1. Page loads, shows loading overlay, then renders dashboard
2. All 4 KPI cards show values
3. Events by Type horizontal bar chart renders, clicking a bar filters
4. Customer Country and Location Country lists render with proportional bars
5. Ctrl+click multi-selects in lists
6. Events over Time line chart renders with dataZoom brush
7. Region bar chart shows latitude sums (not counts)
8. Division bar chart shows counts
9. Municipality list shows top 20
10. Locality list shows *least* frequent 15 (reverse order)
11. Postal codes list shows top 10
12. Data table shows 50 rows, pagination works, top/bottom toggle works
13. Event pills toggle and apply filterIn
14. Country dropdowns apply filterExact
15. Region checkboxes + search work
16. Time range slider applies filterRange
17. Latitude inputs apply filterFunction
18. Clear All resets everything
19. Filter chips appear and are dismissible
20. Mode switching works — all 4 modes build and render
21. Latency display updates on every interaction
22. Performance log accumulates entries
23. Add 1000 Rows increases total, charts update
24. Remove Excluded decreases total
25. Runtime badge shows WASM/JS + row count

- [ ] **Step 5: Commit**

```bash
git add demo/
git commit -m "feat(demo): add final CSS polish, resize handling, and loading overlay"
```

- [ ] **Step 6: Update .gitignore to NOT ignore the demo directory**

Verify `demo/` is not in `.gitignore` (it shouldn't be, but confirm).

```bash
git add -A demo/
git status
```

- [ ] **Step 7: Final commit with all demo files**

```bash
git add demo/
git commit -m "feat: complete interactive demo dashboard showcasing full crossfilter2 API"
```
