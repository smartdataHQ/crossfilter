# Metadata-Driven Dashboard Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a config-driven dashboard engine that renders crossfilter-powered dashboards from a declarative config, using Cube.dev metadata and ECharts visualizations.

**Architecture:** Three new modules: `dashboard-meta.js` (metadata fetching + inference), `dashboard-config.js` (bluecar_stays test fixture), and `dashboard-engine.js` (config → DOM rendering + crossfilter wiring). A new `dashboard.html` entry point loads the engine while preserving the existing `index.html`/`demo.js` demo intact.

**Tech Stack:** crossfilter2, ECharts 6.0.0, Cube.dev `/api/meta` + `/api/v1/load`, existing stockout CSS design system, Apache Arrow streaming.

**Spec:** `docs/superpowers/specs/2026-03-19-metadata-driven-dashboard-design.md`

---

### Task 1: Metadata Module — Fetch + Parse + Infer

**Files:**
- Create: `demo/dashboard-meta.js`

This module fetches Cube `/api/meta`, parses it into a registry keyed by short field name, and provides inference functions (chart type, label, filter mode, limit).

- [ ] **Step 1: Create `dashboard-meta.js` with `fetchCubeMeta()`**

```js
// demo/dashboard-meta.js
// Fetches Cube.dev /api/meta and builds a field registry for a given cube.
// Provides inference functions for chart type, label, filter mode.

var META_API = '/api/meta';

// Fetch raw meta from Cube API
export function fetchCubeMeta() {
  return fetch(META_API).then(function (res) {
    if (!res.ok) throw new Error('Meta fetch failed: ' + res.status);
    return res.json();
  });
}

// Build a registry for a specific cube: { dimensions: {}, measures: {}, segments: [] }
export function buildCubeRegistry(metaResponse, cubeName) {
  var cubes = metaResponse && metaResponse.cubes || [];
  var cube = null;
  for (var i = 0; i < cubes.length; ++i) {
    if (cubes[i].name === cubeName) { cube = cubes[i]; break; }
  }
  if (!cube) throw new Error('Cube "' + cubeName + '" not found. Available: ' + cubes.map(function(c) { return c.name; }).join(', '));

  var registry = { name: cubeName, title: cube.title || cubeName, dimensions: {}, measures: {}, segments: [] };

  var dims = cube.dimensions || [];
  for (var d = 0; d < dims.length; ++d) {
    var dim = dims[d];
    var shortName = dim.name.split('.').pop();
    registry.dimensions[shortName] = {
      fullName: dim.name,
      type: dim.type || 'string',
      meta: dim.meta || {},
      description: dim.description || '',
    };
  }

  var measures = cube.measures || [];
  for (var m = 0; m < measures.length; ++m) {
    var meas = measures[m];
    var mShort = meas.name.split('.').pop();
    registry.measures[mShort] = {
      fullName: meas.name,
      type: meas.type || 'number',
      aggType: meas.aggType || '',
      format: meas.format || '',
      description: meas.description || '',
    };
  }

  var segs = cube.segments || [];
  for (var s = 0; s < segs.length; ++s) {
    registry.segments.push(segs[s].name.split('.').pop());
  }

  return registry;
}

// Infer the best chart type from metadata
export function inferChartType(fieldName, registry) {
  // Check measures first
  if (registry.measures[fieldName]) return 'kpi';

  var dim = registry.dimensions[fieldName];
  if (!dim) return 'bar';

  var meta = dim.meta || {};
  var fieldType = meta.field_type || dim.type || 'string';
  var unique = typeof meta.unique_values === 'number' ? meta.unique_values : -1;

  if (fieldType === 'boolean') return 'toggle';
  if (fieldType === 'datetime' || dim.type === 'time') return 'line';
  if (fieldType === 'number' || fieldType === 'float') return 'range';

  // String types — by cardinality
  if (unique >= 0 && unique <= 7) return 'pie';
  if (unique > 500) return 'list';
  return 'bar';
}

// Infer a human-readable label from metadata
export function inferLabel(fieldName, registry) {
  var dim = registry.dimensions[fieldName];
  if (dim) {
    if (dim.meta && dim.meta.description) return dim.meta.description;
    // Convert snake_case to Title Case
    return fieldName.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }
  var meas = registry.measures[fieldName];
  if (meas) {
    if (meas.description) return meas.description;
    return fieldName.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }
  return fieldName;
}

// Infer default filter mode
export function inferFilterMode(fieldName, registry) {
  if (registry.measures[fieldName]) return 'none';
  var dim = registry.dimensions[fieldName];
  if (!dim) return 'in';
  var meta = dim.meta || {};
  var fieldType = meta.field_type || dim.type || 'string';
  if (fieldType === 'boolean') return 'exact';
  if (fieldType === 'datetime' || dim.type === 'time') return 'range';
  if (fieldType === 'number' || fieldType === 'float') return 'range';
  return 'in';
}

// Infer default top-N limit
export function inferLimit(fieldName, registry) {
  var dim = registry.dimensions[fieldName];
  if (!dim) return 12;
  var meta = dim.meta || {};
  var unique = typeof meta.unique_values === 'number' ? meta.unique_values : -1;
  if (unique > 0 && unique <= 20) return unique;
  return 12;
}

// Infer whether search should be enabled
export function inferSearchable(fieldName, registry) {
  var dim = registry.dimensions[fieldName];
  if (!dim) return false;
  var meta = dim.meta || {};
  var unique = typeof meta.unique_values === 'number' ? meta.unique_values : -1;
  return unique > 50;
}

// Discover available ECharts series types from the loaded instance
export function discoverEChartsTypes(echarts) {
  // ECharts doesn't expose a public registry API, so we check known types
  // by attempting to detect what's available in the loaded build.
  // The full build registers all types; custom builds may have a subset.
  var knownTypes = [
    'line', 'bar', 'pie', 'scatter', 'radar', 'map', 'tree', 'treemap',
    'graph', 'gauge', 'funnel', 'parallel', 'sankey', 'boxplot',
    'candlestick', 'effectScatter', 'lines', 'heatmap', 'pictorialBar',
    'themeRiver', 'sunburst', 'custom',
  ];
  // For now return all known types — validation happens when rendering
  return knownTypes;
}
```

- [ ] **Step 2: Verify the module loads**

Open browser console at `http://localhost:3333/demo/dashboard.html` (will create in next task), confirm no errors. Or test with a quick inline script.

- [ ] **Step 3: Commit**

```bash
git add demo/dashboard-meta.js
git commit -m "feat(dashboard): add metadata module — fetch, parse, infer chart types"
```

---

### Task 2: Dashboard Config — bluecar_stays Test Fixture

**Files:**
- Create: `demo/dashboard-config.js`

The test config exercises all component types: KPIs, time series, bar charts, pie charts, lists, toggles, range, and table.

- [ ] **Step 1: Create `dashboard-config.js`**

```js
// demo/dashboard-config.js
// Test fixture config for the bluecar_stays cube.
// Exercises all component types the engine must support.

export var BLUECAR_STAYS_CONFIG = {
  cube: 'bluecar_stays',
  partition: 'bluecar.is',
  title: 'Iceland Rental Car Stays',

  panels: [
    // KPIs
    { measure: 'count', label: 'Total Stays', chart: 'kpi', section: 'kpis' },
    { measure: 'unique_bookings', label: 'Bookings', chart: 'kpi', section: 'kpis' },
    { measure: 'unique_cars', label: 'Vehicles', chart: 'kpi', section: 'kpis' },
    { measure: 'poi_match_rate', label: 'POI Match Rate', chart: 'kpi', section: 'kpis' },

    // Time series
    { dimension: 'stay_started_at', chart: 'line', granularity: 'day', section: 'timeline', width: 'full' },

    // Categorical charts
    { dimension: 'activity_type', section: 'overview' },
    { dimension: 'car_class', limit: 12, section: 'overview' },
    { dimension: 'region', section: 'overview' },

    // Vehicle details
    { dimension: 'vehicle_make', section: 'vehicles' },
    { dimension: 'fuel_type', chart: 'pie', section: 'vehicles' },
    { dimension: 'drive_type', chart: 'pie', section: 'vehicles' },

    // Geography (searchable lists)
    { dimension: 'municipality', chart: 'list', section: 'geography' },
    { dimension: 'locality', chart: 'list', section: 'geography' },
    { dimension: 'poi_name', chart: 'list', section: 'geography' },
    { dimension: 'poi_category', section: 'geography' },

    // Boolean toggles
    { dimension: 'has_poi_match', chart: 'toggle', section: 'filters' },
    { dimension: 'is_first_stay', chart: 'toggle', section: 'filters' },

    // Numeric range
    { dimension: 'stay_duration_hours', chart: 'range', section: 'filters' },

    // Data table
    { chart: 'table', section: 'details', width: 'full',
      columns: ['car_class', 'region', 'activity_type', 'poi_name', 'stay_duration_hours', 'stay_started_at'] },
  ],

  layout: {
    sections: [
      { id: 'kpis', columns: 4 },
      { id: 'timeline', columns: 1 },
      { id: 'overview', label: 'Overview', columns: 3 },
      { id: 'vehicles', label: 'Vehicles', columns: 3 },
      { id: 'geography', label: 'Geography', columns: 2, collapsed: true },
      { id: 'filters', label: 'Filters', columns: 4 },
      { id: 'details', label: 'Details', columns: 1 },
    ],
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add demo/dashboard-config.js
git commit -m "feat(dashboard): add bluecar_stays test config fixture"
```

---

### Task 3: Dashboard Engine — Config → DOM Wireframe

**Files:**
- Create: `demo/dashboard-engine.js`
- Create: `demo/dashboard.html`

The engine reads the config, fetches metadata, resolves panel defaults, generates the DOM skeleton, and renders placeholder cards. No crossfilter wiring yet — just layout proof.

- [ ] **Step 1: Create `dashboard.html`**

Minimal HTML that loads the CSS, ECharts, crossfilter, and the engine module. The engine generates all DOM from config — no hardcoded panels in HTML.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard Engine</title>
  <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700;900&family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="demo.css">
</head>
<body>
<div id="error-banner" class="error-banner" hidden></div>
<div id="dashboard" class="dashboard"></div>
<script src="../crossfilter.js"></script>
<script src="../node_modules/echarts/dist/echarts.min.js"></script>
<script type="module" src="dashboard-engine.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `dashboard-engine.js` — DOM generation from config**

The engine:
1. Imports config and meta module
2. Fetches Cube metadata
3. Resolves panel defaults (chart type, label, filter, limit)
4. Generates DOM: header → sections → panel cards
5. Each panel card is a placeholder showing its chart type and dimension name

```js
// demo/dashboard-engine.js
// Core engine: reads config, fetches metadata, generates DOM, wires crossfilter.
// Phase 1: DOM wireframe with placeholder cards.

import { BLUECAR_STAYS_CONFIG } from './dashboard-config.js';
import {
  fetchCubeMeta,
  buildCubeRegistry,
  inferChartType,
  inferLabel,
  inferFilterMode,
  inferLimit,
  inferSearchable,
} from './dashboard-meta.js';
import {
  registerDemoEChartsTheme,
  getDemoEChartsThemeName,
} from './echarts-theme.js';

var echarts = globalThis.echarts;
var crossfilter = globalThis.crossfilter;

// ── Resolve panel defaults from metadata ──────────────────────────────

function resolvePanels(config, registry) {
  var panels = config.panels || [];
  var resolved = [];
  for (var i = 0; i < panels.length; ++i) {
    var p = panels[i];
    var fieldName = p.dimension || p.measure || null;
    var chartType = p.chart || (fieldName ? inferChartType(fieldName, registry) : 'table');

    // Validate field exists in registry (skip if not found)
    if (fieldName && !registry.dimensions[fieldName] && !registry.measures[fieldName]) {
      console.warn('[dashboard] Skipping panel — field "' + fieldName + '" not found in cube "' + registry.name + '"');
      continue;
    }

    resolved.push({
      id: p.id || (fieldName ? fieldName : 'panel-' + i),
      dimension: p.dimension || null,
      measure: p.measure || null,
      chart: chartType,
      label: p.label || (fieldName ? inferLabel(fieldName, registry) : chartType),
      limit: p.limit || (fieldName ? inferLimit(fieldName, registry) : 50),
      sort: p.sort || 'value',
      filter: p.filter || (fieldName ? inferFilterMode(fieldName, registry) : 'none'),
      granularity: p.granularity || null,
      op: p.op || 'count',
      field: p.field || null,
      columns: p.columns || null,
      section: p.section || '_default',
      width: p.width || null,
      collapsed: p.collapsed != null ? p.collapsed : false,
      searchable: p.searchable != null ? p.searchable : (fieldName ? inferSearchable(fieldName, registry) : false),
      worker: p.worker || null,
    });
  }
  return resolved;
}

// ── Resolve layout sections ───────────────────────────────────────────

function resolveSections(config, resolvedPanels) {
  var layoutSections = config.layout && config.layout.sections || [];
  var sectionMap = {};
  for (var s = 0; s < layoutSections.length; ++s) {
    var sec = layoutSections[s];
    sectionMap[sec.id] = {
      id: sec.id,
      label: sec.label || null,
      columns: sec.columns || 3,
      collapsed: sec.collapsed || false,
      panels: [],
    };
  }

  // Assign panels to sections
  for (var i = 0; i < resolvedPanels.length; ++i) {
    var p = resolvedPanels[i];
    if (!sectionMap[p.section]) {
      sectionMap[p.section] = { id: p.section, label: p.section, columns: 3, collapsed: false, panels: [] };
    }
    sectionMap[p.section].panels.push(p);
  }

  // Return sections in layout order, then any extras
  var ordered = [];
  var seen = {};
  for (var j = 0; j < layoutSections.length; ++j) {
    var id = layoutSections[j].id;
    if (sectionMap[id] && sectionMap[id].panels.length > 0) {
      ordered.push(sectionMap[id]);
      seen[id] = true;
    }
  }
  var keys = Object.keys(sectionMap);
  for (var k = 0; k < keys.length; ++k) {
    if (!seen[keys[k]] && sectionMap[keys[k]].panels.length > 0) {
      ordered.push(sectionMap[keys[k]]);
    }
  }

  return ordered;
}

// ── DOM Generation ────────────────────────────────────────────────────

var ACCENT_COLORS = ['green', 'blue', 'amber', 'red', 'purple'];

function buildHeader(config) {
  var header = document.createElement('header');
  header.className = 'header anim d1';
  header.innerHTML =
    '<div class="header-left">' +
      '<h1>' + escapeHtml(config.title || 'Dashboard') + '</h1>' +
    '</div>' +
    '<div class="header-right">' +
      '<div id="filter-chips" class="filter-chips"></div>' +
      '<button id="clear-all-btn" class="btn btn-ghost">Clear All</button>' +
    '</div>';
  return header;
}

function buildSectionEl(section, animDelay) {
  var isCollapsible = section.collapsed;
  var wrapper;

  if (isCollapsible) {
    wrapper = document.createElement('details');
    wrapper.className = 'card anim d' + animDelay;
    var summary = document.createElement('summary');
    summary.className = 'card-head card-head--toggle';
    summary.innerHTML =
      '<span class="card-t">' + escapeHtml(section.label || section.id) + '</span>' +
      '<div class="card-filters"><span class="group-size-badge">Expand to browse</span></div>';
    wrapper.appendChild(summary);
  } else if (section.label) {
    wrapper = document.createElement('section');
    wrapper.className = 'anim d' + animDelay;
  } else {
    wrapper = document.createElement('section');
    wrapper.className = 'anim d' + animDelay;
  }

  wrapper.dataset.sectionId = section.id;
  return wrapper;
}

function buildPanelCard(panel, accentIdx) {
  var isKpi = panel.chart === 'kpi';
  var card = document.createElement('div');

  if (isKpi) {
    var color = ACCENT_COLORS[accentIdx % ACCENT_COLORS.length];
    card.className = 'kpi kpi-' + color;
    card.id = 'panel-' + panel.id;
    card.innerHTML =
      '<div class="kpi-label">' + escapeHtml(panel.label) + '</div>' +
      '<div class="kpi-value">\u2014</div>';
    return card;
  }

  card.className = 'card chart-card';
  card.id = 'panel-' + panel.id;

  var head = '<div class="card-head">' +
    '<span class="card-t">' + escapeHtml(panel.label) + '</span>' +
    '<div class="card-filters">' +
      '<span class="group-size-badge chart-type-badge">' + panel.chart + '</span>' +
    '</div>' +
  '</div>';

  var body = '';
  if (panel.chart === 'table') {
    body = '<div class="table-scroll"><table class="tbl">' +
      '<thead><tr id="table-head-' + panel.id + '"></tr></thead>' +
      '<tbody id="table-body-' + panel.id + '"></tbody>' +
    '</table></div>';
  } else if (panel.chart === 'toggle') {
    body = '<div class="pill-group" id="toggle-' + panel.id + '"></div>';
  } else if (panel.chart === 'range') {
    body = '<div class="range-wrap" id="range-' + panel.id + '">' +
      '<input type="range" class="range-slider" min="0" max="100" value="0">' +
      '<span class="range-label">\u2014</span>' +
    '</div>';
  } else if (panel.chart === 'list') {
    body = '<div class="dim-list-panel">' +
      '<input type="text" class="dim-search" placeholder="Search ' + escapeHtml(panel.label.toLowerCase()) + '...">' +
      '<div class="dim-list-scroll" id="list-' + panel.id + '"></div>' +
    '</div>';
  } else {
    // ECharts chart container
    body = '<div id="chart-' + panel.id + '" class="chart-wrap' +
      (panel.chart === 'line' ? ' chart-wrap-timeline' : '') + '"></div>';
  }

  // Search input for bar charts with searchable flag
  var searchHtml = '';
  if (panel.searchable && panel.chart === 'bar') {
    searchHtml = '<div id="search-panel-' + panel.id + '" class="dim-list-panel" hidden>' +
      '<input type="text" class="dim-search" placeholder="Search ' + escapeHtml(panel.label.toLowerCase()) + '...">' +
      '<div class="dim-list-scroll" id="list-' + panel.id + '"></div>' +
    '</div>';
  }

  card.innerHTML = head + body + searchHtml;
  return card;
}

function buildDashboardDOM(container, config, sections) {
  container.innerHTML = '';

  // Header
  container.appendChild(buildHeader(config));

  var animDelay = 2;
  var kpiAccent = 0;

  for (var s = 0; s < sections.length; ++s) {
    var section = sections[s];
    var sectionEl = buildSectionEl(section, Math.min(animDelay, 8));

    // Grid container for panels
    var isKpiSection = section.panels.length > 0 && section.panels[0].chart === 'kpi';
    var gridEl;

    if (isKpiSection) {
      gridEl = document.createElement('section');
      gridEl.className = 'kpi-row';
    } else if (section.columns > 1 && section.panels.length > 1) {
      gridEl = document.createElement('div');
      gridEl.className = 'chart-grid';
      gridEl.style.gridTemplateColumns = 'repeat(' + section.columns + ', 1fr)';
    } else {
      gridEl = document.createDocumentFragment();
    }

    for (var p = 0; p < section.panels.length; ++p) {
      var panel = section.panels[p];
      var card = buildPanelCard(panel, kpiAccent);
      if (panel.chart === 'kpi') kpiAccent++;
      if (panel.width === 'full' && gridEl.style) {
        card.style.gridColumn = '1 / -1';
      }
      gridEl.appendChild(card);
    }

    if (section.collapsed) {
      var body = document.createElement('div');
      body.className = 'location-body';
      var innerGrid = document.createElement('div');
      innerGrid.className = 'location-grid';
      // Move children from gridEl into innerGrid
      while (gridEl.firstChild) innerGrid.appendChild(gridEl.firstChild);
      body.appendChild(innerGrid);
      sectionEl.appendChild(body);
    } else {
      sectionEl.appendChild(gridEl);
    }

    container.appendChild(sectionEl);
    animDelay++;
  }
}

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Main Entry ────────────────────────────────────────────────────────

async function main() {
  var container = document.getElementById('dashboard');
  var config = BLUECAR_STAYS_CONFIG;

  // Show loading state
  container.innerHTML = '<div class="loading-popover" style="position:static;display:block;margin:40px auto">' +
    '<div class="loading-pop-header"><span class="loading-pop-title">Loading metadata...</span></div>' +
    '<div class="loading-pop-bar"><div class="loading-pop-bar-fill" style="width:30%"></div></div></div>';

  try {
    // Register ECharts theme
    registerDemoEChartsTheme(echarts);

    // Fetch metadata
    var metaResponse = await fetchCubeMeta();
    var registry = buildCubeRegistry(metaResponse, config.cube);
    console.log('[dashboard] Cube registry:', registry.name, '—',
      Object.keys(registry.dimensions).length, 'dims,',
      Object.keys(registry.measures).length, 'measures');

    // Resolve panels and sections
    var resolvedPanels = resolvePanels(config, registry);
    var sections = resolveSections(config, resolvedPanels);
    console.log('[dashboard] Resolved', resolvedPanels.length, 'panels in', sections.length, 'sections');

    // Build DOM
    buildDashboardDOM(container, config, sections);
    console.log('[dashboard] DOM wireframe rendered');

  } catch (err) {
    container.innerHTML = '<div class="error-banner" style="display:block">' +
      'Dashboard error: ' + escapeHtml(err.message) + '</div>';
    console.error('[dashboard]', err);
  }
}

main();
```

- [ ] **Step 3: Verify wireframe renders in browser**

Navigate to `http://localhost:3333/demo/dashboard.html`. Confirm:
- Header with title "Iceland Rental Car Stays"
- 4 KPI cards with colored top borders
- Timeline section with line chart placeholder
- 3-column grid of bar/pie chart placeholders
- Collapsible geography section
- Data table placeholder at bottom
- No console errors

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard.html demo/dashboard-engine.js
git commit -m "feat(dashboard): engine wireframe — config-driven DOM generation from metadata"
```

---

### Task 4: Data Loading — Cube Query + Crossfilter Worker

**Files:**
- Modify: `demo/dashboard-engine.js`

Wire up data loading: build a Cube query from the config, fetch Arrow data via the streaming worker, create crossfilter dimensions and groups.

- [ ] **Step 1: Add `buildCubeQuery()` to engine**

Build the Cube API query body from config + resolved panels:
- Collect all dimension field names referenced by panels
- Collect all measure field names referenced by panels
- Add partition filter
- Add time dimension granularity if present
- Request `format: 'arrow'`

- [ ] **Step 2: Add `createWorker()` to engine**

Use `crossfilter.createStreamingDashboardWorker()` with:
- dimensions from resolved panels
- groups for each dimension panel (reduceCount or reduceSum)
- KPI specs from measure panels
- Source pointing to `/api/cube` with the built query

- [ ] **Step 3: Wire worker events to panel rendering**

On `snapshot` events from the worker:
- Update KPI values
- Update group data for each chart panel

- [ ] **Step 4: Verify data loads and KPIs show values**

Navigate to dashboard, confirm KPIs populate with numbers from the Cube data.

- [ ] **Step 5: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): data loading — Cube query, crossfilter worker, KPI rendering"
```

---

### Task 5: Bar Chart Renderer

**Files:**
- Modify: `demo/dashboard-engine.js`

Implement the bar chart renderer: horizontal bars with count labels, click-to-filter, dynamic height.

- [ ] **Step 1: Add `renderBarChart()` function**

Uses ECharts horizontal bar series. Reuses `chart-utils.js` for height calculation and label truncation.

- [ ] **Step 2: Wire bar click to filter**

On click: toggle the clicked value in `filters[dimension]`, re-query worker.

- [ ] **Step 3: Verify bar charts render with real data**

Confirm bar charts show for activity_type, car_class, region with correct values and click-to-filter works.

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): bar chart renderer with click-to-filter"
```

---

### Task 6: Line Chart Renderer (Time Series)

**Files:**
- Modify: `demo/dashboard-engine.js`

- [ ] **Step 1: Add `renderLineChart()` function**

Line chart with area gradient fill, granularity toggle, dataZoom slider.

- [ ] **Step 2: Wire granularity toggle**

Switching granularity rebuilds the time dimension group.

- [ ] **Step 3: Verify timeline renders**

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): line chart renderer with granularity toggle"
```

---

### Task 7: Pie Chart Renderer

**Files:**
- Modify: `demo/dashboard-engine.js`

- [ ] **Step 1: Add `renderPieChart()` — donut with click-to-filter**
- [ ] **Step 2: Verify pie charts render for fuel_type and drive_type**
- [ ] **Step 3: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): pie chart renderer"
```

---

### Task 8: Searchable List Renderer

**Files:**
- Modify: `demo/dashboard-engine.js`

- [ ] **Step 1: Add `renderDimensionList()` — scrollable list with search + pagination**
- [ ] **Step 2: Wire search input with debounce**
- [ ] **Step 3: Verify lists render for municipality, locality, poi_name**
- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): searchable dimension list renderer"
```

---

### Task 9: Toggle + Range Renderers

**Files:**
- Modify: `demo/dashboard-engine.js`

- [ ] **Step 1: Add `renderToggle()` — boolean pill buttons**
- [ ] **Step 2: Add `renderRange()` — range slider for numeric dimensions**
- [ ] **Step 3: Verify toggles and range sliders work**
- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): toggle and range filter renderers"
```

---

### Task 10: Data Table Renderer

**Files:**
- Modify: `demo/dashboard-engine.js`

- [ ] **Step 1: Add `renderTable()` — sticky header, sorted columns, row count**
- [ ] **Step 2: Wire table to show filtered rows from crossfilter**
- [ ] **Step 3: Verify table renders with correct columns from config**
- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): data table renderer"
```

---

### Task 11: Filter Coordination — Chips + Clear All

**Files:**
- Modify: `demo/dashboard-engine.js`

- [ ] **Step 1: Add filter chip rendering**

When a filter is active, show a chip in the header with the dimension label + value. Click × to remove.

- [ ] **Step 2: Wire "Clear All" button**
- [ ] **Step 3: Verify filter chips appear/disappear when clicking charts**
- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): filter chips and Clear All coordination"
```

---

### Task 12: Update Spec with Implementation Learnings

**Files:**
- Modify: `docs/superpowers/specs/2026-03-19-metadata-driven-dashboard-design.md`

- [ ] **Step 1: Update spec with any config changes discovered during implementation**
- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-03-19-metadata-driven-dashboard-design.md
git commit -m "docs: update dashboard spec with implementation learnings"
```
