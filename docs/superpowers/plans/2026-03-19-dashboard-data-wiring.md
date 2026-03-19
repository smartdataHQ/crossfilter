# Dashboard Data Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire config-driven crossfilter streaming workers to the dashboard engine so bar charts, pie charts, and KPIs render live Cube.dev data with click-to-filter.

**Architecture:** New `demo/dashboard-data.js` module owns the crossfilter data layer (scan config → build Cube query → create streaming worker → query → return results). The existing `demo/dashboard-engine.js` owns DOM and calls the data module. Chart rendering functions added to the engine transform group data into ECharts options.

**Tech Stack:** crossfilter2 streaming dashboard worker, Apache Arrow, ECharts, Cube.dev REST API (Arrow format), Shoelace components.

**Spec:** `docs/superpowers/specs/2026-03-19-dashboard-data-wiring-design.md`

**Conventions:** ES5 style (`var`, no arrow functions, no `let`/`const`). Zero hardcoded field names — everything from config + cube metadata registry.

---

## File Map

| File | Role | Action |
|---|---|---|
| `demo/dashboard-data.js` | Data layer: scan panels, build Cube query, create worker, query, merge responses | **Create** (~350 lines) |
| `demo/dashboard-engine.js` | DOM + rendering: wire data module, render charts, click-to-filter | **Modify** (replace TODO at line 1626, add rendering functions) |
| `demo/dashboard.html` | Shell: add Arrow runtime script | **Modify** (add 1 script tag) |
| `demo/chart-types.js` | Chart type registry (slot definitions) | Read-only dependency |
| `demo/dashboard-meta.js` | Cube metadata fetch + registry | Read-only dependency |
| `demo/echarts-theme.js` | ECharts theme | Read-only dependency |
| `demo/dashboards/bluecar-stays.json` | Example config | Read-only test fixture |

---

### Task 1: Add Apache Arrow runtime script to dashboard.html

The streaming dashboard worker needs the Arrow runtime to parse Arrow IPC streams. The stockout demo loads it via `importScripts` inside the worker blob, but the URL must be resolvable from the page.

**Files:**
- Modify: `demo/dashboard.html:36` (add script tag before crossfilter.js)

- [ ] **Step 1: Verify Arrow module exists**

Run: `ls node_modules/apache-arrow/Arrow.es2015.min.js`
Expected: file exists (already a dependency from stockout demo)

- [ ] **Step 2: Add Arrow script tag to dashboard.html**

In `demo/dashboard.html`, after line 36 (`<script src="../crossfilter.js"></script>`), the Arrow runtime is NOT loaded as a page script — it's loaded inside the Web Worker via `importScripts`. The worker receives the URL as `arrowRuntimeUrl`. Verify the path resolves:

The worker source in `src/dashboard-stream-worker.js` line 92-94 uses `importScripts(crossfilterUrl, arrowUrl)` inside the worker blob. The URLs are resolved relative to the page via `resolveAssetUrl()` in `src/dashboard-stream-worker.js` line 17-22. The `<base href="/demo/">` tag in `dashboard.html` line 6 means relative URLs resolve from `/demo/`.

So `../crossfilter.js` resolves to `/crossfilter.js` and `../node_modules/apache-arrow/Arrow.es2015.min.js` resolves to `/node_modules/apache-arrow/Arrow.es2015.min.js`.

No HTML change needed — the worker loads Arrow internally. Mark this complete.

- [ ] **Step 3: Commit**

No change to commit for this task — verified existing setup is sufficient.

---

### Task 2: Create `dashboard-data.js` — scanPanels and inferReduceOp

The core field-scanning logic that reads resolved panels, walks chart type slots, and collects dimensions, measures, groups, and KPIs needed for the worker.

**Files:**
- Create: `demo/dashboard-data.js`

- [ ] **Step 1: Create the file with imports and scanPanels**

Create `demo/dashboard-data.js` with:

```javascript
// demo/dashboard-data.js
// Data layer for the config-driven dashboard engine.
// Scans panels → builds Cube query → creates streaming worker → queries → returns results.
// Zero hardcoded field names — everything from config + cube registry.

import { getChartType } from './chart-types.js';

var crossfilter = globalThis.crossfilter;

// ── Infer reduce op from measure metadata ─────────────────────────────

function inferReduceOp(measureName, registry) {
  if (measureName === 'count') return 'count';
  var meta = registry.measures[measureName];
  if (!meta) return 'sum';
  var agg = meta.aggType;
  if (agg === 'count' || agg === 'countDistinct') return 'count';
  if (agg === 'avg') return 'avg';
  return 'sum';
}

// ── Scan resolved panels → collect fields needed by worker ────────────

function scanPanels(panels, registry) {
  var dims = new Set();
  var measures = new Set();
  var groups = [];
  var kpis = [];

  for (var i = 0; i < panels.length; ++i) {
    var panel = panels[i];
    var chartDef = getChartType(panel.chart);
    if (!chartDef) continue;

    var panelDimField = null;
    var panelMeasField = null;

    for (var s = 0; s < chartDef.slots.length; ++s) {
      var slot = chartDef.slots[s];
      var field = panel[slot.name];
      if (!field) continue;

      var fields = slot.array ? (Array.isArray(field) ? field : [field]) : [field];
      for (var f = 0; f < fields.length; ++f) {
        var fname = fields[f];
        if (slot.accepts === 'dimension') {
          dims.add(fname);
          if (!panelDimField) panelDimField = fname;
        } else if (slot.accepts === 'measure') {
          measures.add(fname);
          if (!panelMeasField) panelMeasField = fname;
        } else if (slot.accepts === 'any') {
          if (registry.dimensions[fname]) {
            dims.add(fname);
            if (!panelDimField) panelDimField = fname;
          } else {
            measures.add(fname);
            if (!panelMeasField) panelMeasField = fname;
          }
        }
      }
    }

    panel._dimField = panelDimField || panel.dimension || null;
    panel._measField = panelMeasField || panel.measure || null;

    var family = chartDef.family;
    if (panel._dimField && (family === 'category' || family === 'control')) {
      var measField = panel._measField;
      var op = measField ? inferReduceOp(measField, registry) : 'count';
      groups.push({
        id: panel.id,
        field: panel._dimField,
        metrics: [{ id: 'value', field: op === 'count' ? null : measField, op: op }],
      });
      panel._groupId = panel.id;
    }

    if (family === 'single' && panel._measField) {
      var kpiOp = inferReduceOp(panel._measField, registry);
      kpis.push({ id: panel.id, field: kpiOp === 'count' ? null : panel._measField, op: kpiOp });
      panel._kpiId = panel.id;
    }
  }

  measures.add('count');

  return { dims: dims, measures: measures, groups: groups, kpis: kpis };
}
```

- [ ] **Step 2: Verify file parses**

Run: `node -e "import('./demo/dashboard-data.js').then(() => console.log('OK')).catch(e => console.error(e.message))"`
Expected: OK (or import error about `chart-types.js` which is fine — confirms syntax is valid)

- [ ] **Step 3: Commit**

```bash
git add demo/dashboard-data.js
git commit -m "feat(dashboard): add scanPanels — slot-aware field collection from config"
```

---

### Task 3: Add Cube query construction and field projection to dashboard-data.js

Build the Cube.dev POST body and Arrow field rename/transform projection from scan results.

**Files:**
- Modify: `demo/dashboard-data.js`

- [ ] **Step 1: Add buildCubeQuery function**

Append after `scanPanels` in `demo/dashboard-data.js`:

```javascript
// ── Build Cube.dev POST query body ────────────────────────────────────

function buildCubeQuery(cubeName, dims, measures, registry) {
  var partition = registry._cubeMeta.partition;
  var filters = [];
  if (partition) {
    filters.push({ member: cubeName + '.partition', operator: 'equals', values: [partition] });
  }

  return {
    format: 'arrow',
    query: {
      dimensions: Array.from(dims).map(function(d) { return cubeName + '.' + d; }),
      measures: Array.from(measures).map(function(m) { return cubeName + '.' + m; }),
      filters: filters,
      limit: 1000000,
    },
  };
}
```

- [ ] **Step 2: Add buildProjection function**

Append after `buildCubeQuery`:

```javascript
// ── Build Arrow field rename + type transform projection ──────────────

function buildProjection(cubeName, dims, measures, registry) {
  var rename = {};
  var transforms = {};

  function addField(field) {
    rename[cubeName + '.' + field] = field;
    rename[cubeName + '__' + field] = field;
  }

  dims.forEach(function(d) { addField(d); });
  measures.forEach(function(m) { addField(m); });

  dims.forEach(function(d) {
    var meta = registry.dimensions[d];
    if (meta && (meta.type === 'number' || meta.type === 'boolean')) {
      transforms[d] = 'number';
    }
  });
  measures.forEach(function(m) {
    transforms[m] = 'number';
  });

  return { rename: rename, transforms: transforms };
}
```

- [ ] **Step 3: Commit**

```bash
git add demo/dashboard-data.js
git commit -m "feat(dashboard): add Cube query builder and Arrow field projection"
```

---

### Task 4: Add filter conversion and response merging to dashboard-data.js

Convert the engine's simple `filterState` to typed crossfilter filters, and merge responses from multiple workers.

**Files:**
- Modify: `demo/dashboard-data.js`

- [ ] **Step 1: Add buildFilters function**

Append after `buildProjection`:

```javascript
// ── Convert engine filterState to typed crossfilter filters ───────────

function buildFilters(filterState, workerDimensions) {
  var filters = {};
  for (var dim in filterState) {
    if (workerDimensions.indexOf(dim) < 0) continue;
    var val = filterState[dim];
    if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number') {
      filters[dim] = { type: 'range', range: val };
    } else {
      filters[dim] = { type: 'in', values: Array.isArray(val) ? val : [val] };
    }
  }
  return filters;
}
```

- [ ] **Step 2: Add buildGroupQueries function**

```javascript
// ── Build per-panel group query parameters ────────────────────────────

function buildGroupQueries(panels) {
  var queries = {};
  for (var i = 0; i < panels.length; ++i) {
    var p = panels[i];
    if (!p._groupId) continue;
    queries[p._groupId] = {
      limit: p._expanded ? null : p.limit,
      sort: 'desc',
      sortMetric: 'value',
      includeTotals: true,
      visibleOnly: true,
    };
  }
  return queries;
}
```

- [ ] **Step 3: Add mergeResponses function**

```javascript
// ── Merge worker responses into unified result ────────────────────────

function mergeResponses(responses) {
  var merged = { kpis: {}, groups: {} };
  for (var i = 0; i < responses.length; ++i) {
    var r = responses[i];
    if (!r || !r.snapshot) continue;
    var kpis = r.snapshot.kpis || {};
    for (var k in kpis) merged.kpis[k] = kpis[k];
    var groups = r.snapshot.groups || {};
    for (var g in groups) merged.groups[g] = groups[g];
  }
  return merged;
}
```

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-data.js
git commit -m "feat(dashboard): add filter conversion, group queries, and response merging"
```

---

### Task 5: Add createDashboardData — the public API of dashboard-data.js

The main entry point that wires everything together: scans panels, creates workers, and exposes `query()`, `on()`, and `ready`.

**Files:**
- Modify: `demo/dashboard-data.js`

- [ ] **Step 1: Add the createDashboardData export**

Append at the end of `demo/dashboard-data.js`:

```javascript
// ── Public API ────────────────────────────────────────────────────────

export async function createDashboardData(config, registry, resolvedPanels) {
  var cubeName = config.cube;
  var scanResult = scanPanels(resolvedPanels, registry);

  console.log('[dashboard-data] Scanned', resolvedPanels.length, 'panels →',
    scanResult.dims.size, 'dims,', scanResult.measures.size, 'measures,',
    scanResult.groups.length, 'groups,', scanResult.kpis.length, 'kpis');

  var cubeQuery = buildCubeQuery(cubeName, scanResult.dims, scanResult.measures, registry);
  var projection = buildProjection(cubeName, scanResult.dims, scanResult.measures, registry);

  var workerDims = Array.from(scanResult.dims);

  var workerHandle = await crossfilter.createStreamingDashboardWorker({
    crossfilterUrl: '../crossfilter.js',
    arrowRuntimeUrl: '../node_modules/apache-arrow/Arrow.es2015.min.js',
    batchCoalesceRows: 65536,
    wasm: true,
    emitSnapshots: false,
    progressThrottleMs: 100,
    dimensions: workerDims,
    groups: scanResult.groups,
    kpis: scanResult.kpis,
    sources: [{
      dataUrl: '/api/cube',
      id: cubeName,
      role: 'base',
      dataFetchInit: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cubeQuery),
      },
      projection: projection,
    }],
  });

  var listeners = { progress: [], ready: [], error: [] };

  workerHandle.on('progress', function(payload) {
    for (var i = 0; i < listeners.progress.length; ++i) listeners.progress[i](payload);
  });

  workerHandle.on('ready', function(payload) {
    for (var i = 0; i < listeners.ready.length; ++i) listeners.ready[i](payload);
  });

  workerHandle.on('error', function(payload) {
    for (var i = 0; i < listeners.error.length; ++i) listeners.error[i](payload);
  });

  return {
    ready: workerHandle.ready,

    on: function(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
    },

    query: function(filterState) {
      var filters = buildFilters(filterState || {}, workerDims);
      // Re-evaluate group queries each time (panel._expanded may change)
      var groupQueries = buildGroupQueries(resolvedPanels);
      // Pass flat request — workerHandle.query() wraps it in { request: ... } internally
      return workerHandle.query({
        filters: filters,
        snapshot: { groups: groupQueries },
      }).then(function(response) {
        return mergeResponses([response]);
      });
    },

    dispose: function() {
      return workerHandle.dispose();
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add demo/dashboard-data.js
git commit -m "feat(dashboard): add createDashboardData — public API for data layer"
```

---

### Task 6: Add formatMeasureValue to dashboard-engine.js

Helper function that formats a raw measure value for display using cube metadata.

**Files:**
- Modify: `demo/dashboard-engine.js` (add after `escapeHtml` function, around line 399)

- [ ] **Step 1: Add formatMeasureValue function**

In `demo/dashboard-engine.js`, after the `escapeHtml` function (line 399), add:

```javascript
// ── Measure value formatting (metadata-driven) ───────────────────────

function formatMeasureValue(value, meta) {
  if (value == null || value !== value) return '\u2014';
  if (!meta) return typeof value === 'number' ? value.toLocaleString() : String(value);
  if (meta.format === 'percent' || (meta.aggType === 'number' && /rate|percent/i.test(meta.description || ''))) {
    return (value * 100).toFixed(1) + '%';
  }
  if (/hours?/i.test(meta.description || '') || /duration.*hours/i.test(meta.fullName || '')) {
    return value.toFixed(1) + 'h';
  }
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(1);
}
```

- [ ] **Step 2: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): add metadata-driven measure value formatter"
```

---

### Task 7: Add renderBarChart and renderPieChart to dashboard-engine.js

Chart rendering functions that transform crossfilter group data into ECharts options.

**Files:**
- Modify: `demo/dashboard-engine.js` (add after `formatMeasureValue`, before the Main Entry section)

- [ ] **Step 1: Add renderBarChart function**

Add after `formatMeasureValue` in `demo/dashboard-engine.js`:

```javascript
// ── Chart Rendering (group data → ECharts) ───────────────────────────

var THEME_NAME = getDemoEChartsThemeName();

function renderBarChart(panelEl, panel, groupData) {
  var entries = groupData.entries || [];
  if (!entries.length) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  var categories = [];
  var values = [];
  for (var i = 0; i < entries.length; ++i) {
    categories.push(String(entries[i].key));
    values.push(entries[i].value.value);
  }

  var chartDef = getChartType(panel.chart);
  var isHorizontal = chartDef && chartDef.ecOptions && chartDef.ecOptions._horizontal;

  var catAxis = {
    type: 'category',
    data: isHorizontal ? categories.slice().reverse() : categories,
    axisLabel: { interval: 0, rotate: !isHorizontal && categories.length > 6 ? 30 : 0 },
  };
  var valAxis = { type: 'value' };

  var option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
    },
    grid: { left: 10, right: 10, top: 10, bottom: 10, containLabel: true },
    xAxis: isHorizontal ? valAxis : catAxis,
    yAxis: isHorizontal ? catAxis : valAxis,
    series: [{
      type: 'bar',
      data: isHorizontal ? values.slice().reverse() : values,
      barMaxWidth: 40,
    }],
  };

  var instance = echarts.getInstanceByDom(panelEl);
  if (!instance) {
    instance = echarts.init(panelEl, THEME_NAME, { renderer: 'canvas' });
  }
  instance.setOption(option, true);
  return instance;
}

function renderPieChart(panelEl, panel, groupData) {
  var entries = groupData.entries || [];
  if (!entries.length) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  var pieData = [];
  for (var i = 0; i < entries.length; ++i) {
    pieData.push({ name: String(entries[i].key), value: entries[i].value.value });
  }

  var chartDef = getChartType(panel.chart);
  var seriesOpts = {
    type: 'pie',
    data: pieData,
    label: { fontSize: 11, formatter: '{b}\n{d}%' },
    emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,21,88,0.15)' } },
  };

  // Apply chart-type-specific options (donut radius, rose, half, etc.)
  if (chartDef && chartDef.ecOptions) {
    var ec = chartDef.ecOptions;
    if (ec.radius) seriesOpts.radius = ec.radius;
    if (ec.roseType) seriesOpts.roseType = ec.roseType;
    if (ec.startAngle != null) seriesOpts.startAngle = ec.startAngle;
    if (ec.endAngle != null) seriesOpts.endAngle = ec.endAngle;
  }

  var option = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [seriesOpts],
  };

  var instance = echarts.getInstanceByDom(panelEl);
  if (!instance) {
    instance = echarts.init(panelEl, THEME_NAME, { renderer: 'canvas' });
  }
  instance.setOption(option, true);
  return instance;
}
```

- [ ] **Step 2: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): add bar and pie chart rendering from group data"
```

---

### Task 8: Add renderKpi, wireChartClick, and renderAllPanels to dashboard-engine.js

The KPI renderer, click-to-filter wiring, and the master render loop.

**Files:**
- Modify: `demo/dashboard-engine.js` (add after renderPieChart, before Main Entry section)

- [ ] **Step 1: Add renderKpi function**

```javascript
function renderKpi(panel, kpiValue, registry) {
  var el = document.querySelector('#panel-' + panel.id + ' .kpi-value');
  if (!el) return;
  var raw = kpiValue;
  if (raw == null || raw !== raw) { el.textContent = '\u2014'; return; }
  var meta = registry.measures[panel._measField];
  el.textContent = formatMeasureValue(raw, meta);
}
```

- [ ] **Step 2: Add wireChartClick function**

```javascript
function wireChartClick(instance, panel) {
  if (!instance || !panel._dimField) return;
  instance.on('click', function(params) {
    var dim = panel._dimField;
    var clickedValue = params.name || (params.data && params.data.name);
    if (!clickedValue) return;
    var current = filterState[dim];
    if (current === clickedValue || (Array.isArray(current) && current.length === 1 && current[0] === clickedValue)) {
      setFilter(dim, null);
    } else {
      setFilter(dim, clickedValue);
    }
  });
}
```

- [ ] **Step 3: Add renderAllPanels function**

This is the master render loop called after every query response:

```javascript
var _chartInstances = {};

function renderAllPanels(panels, response, registry) {
  for (var i = 0; i < panels.length; ++i) {
    var panel = panels[i];

    // KPI panels
    if (panel._kpiId && response.kpis) {
      var kpiVal = response.kpis[panel._kpiId];
      renderKpi(panel, kpiVal, registry);
      continue;
    }

    // Chart panels with groups
    if (panel._groupId && response.groups) {
      var groupData = response.groups[panel._groupId];
      if (!groupData) continue;

      var chartEl = document.getElementById('chart-' + panel.id);
      if (!chartEl) continue;

      var instance = null;
      var chartDef = getChartType(panel.chart);
      var ecType = chartDef ? chartDef.ecType : null;

      if (ecType === 'bar' || ecType === 'pictorialBar') {
        instance = renderBarChart(chartEl, panel, groupData);
      } else if (ecType === 'pie' || ecType === 'funnel') {
        instance = renderPieChart(chartEl, panel, groupData);
      }

      // Wire click-to-filter (only once per panel)
      if (instance && !_chartInstances[panel.id]) {
        wireChartClick(instance, panel);
        _chartInstances[panel.id] = instance;
      } else if (instance) {
        _chartInstances[panel.id] = instance;
      }

      // Update group total count badge
      if (groupData.total != null) {
        var countEl = document.getElementById('count-' + panel.id);
        if (countEl) countEl.textContent = groupData.total + ' values';
      }
    }
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): add KPI render, click-to-filter, and master render loop"
```

---

### Task 9: Wire data module into engine main() — replace the TODO

Connect everything: import dashboard-data, create the data layer, wire progress/error/ready, register filter listener, initial render.

**Files:**
- Modify: `demo/dashboard-engine.js:6` (add import)
- Modify: `demo/dashboard-engine.js:1626-1632` (replace TODO block)

- [ ] **Step 1: Add import for createDashboardData and getChartType**

At the top of `demo/dashboard-engine.js`, after the existing imports (line 25), add:

```javascript
import { createDashboardData } from './dashboard-data.js';
import { getChartType } from './chart-types.js';
```

- [ ] **Step 2: Replace the TODO block (lines 1626-1632)**

Replace this code in `main()`:

```javascript
    updateProgress(3, 'Streaming data into dashboard...');
    // TODO: wire crossfilter worker here — as data streams in,
    // charts update live under the overlay. Once complete, dismiss.
    // For now, simulate with a brief delay then dismiss.
    await new Promise(function (r) { setTimeout(r, 800); });
    dismissProgress();
    wireChartResize();
```

With:

```javascript
    updateProgress(3, 'Connecting to data source...');

    var data = await createDashboardData(config, registry, resolvedPanels);

    data.on('progress', function(payload) {
      if (payload.status === 'starting') {
        updateProgress(3, 'Connecting...');
      } else if (payload.status === 'downloading') {
        var pct = payload.fetch.percent;
        var label = pct != null ? Math.round(pct * 100) + '% downloaded' : 'Downloading...';
        updateProgress(3, label);
      } else if (payload.status === 'streaming') {
        updateProgress(3, payload.load.rowsLoaded.toLocaleString() + ' rows loaded');
      }
    });

    data.on('error', function(payload) {
      var msg = payload && payload.message ? payload.message : 'Data loading failed';
      progressCard.innerHTML = '<div class="progress-step progress-step--error">' +
        '<span class="progress-dot"></span>' +
        '<span>' + escapeHtml(msg) + '</span>' +
      '</div>';
    });

    await data.ready;
    console.log('[dashboard] Data loaded, rendering charts...');

    // Register filter listener: re-query and re-render on any filter change
    filterListeners.push(function(newFilterState) {
      data.query(newFilterState).then(function(response) {
        renderAllPanels(resolvedPanels, response, registry);
      });
    });

    // Initial render with current filter state (may have URL-restored filters)
    var initialResponse = await data.query(filterState);
    renderAllPanels(resolvedPanels, initialResponse, registry);

    dismissProgress();
    wireChartResize();
```

- [ ] **Step 3: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): wire crossfilter data layer into engine main()"
```

---

### Task 10: Manual end-to-end test

Verify the full pipeline works: config → Cube query → Arrow stream → crossfilter → bar chart → click-to-filter.

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

Run: `node demo/proxy-server.mjs`
Expected: `Dev server with Cube.dev proxy running at http://localhost:3333/`

Requires `.env` with `CUBE_TOKEN`, `CUBE_DATASOURCE`, `CUBE_BRANCH` configured.

- [ ] **Step 2: Open the dashboard in a browser**

Navigate to: `http://localhost:3333/demo/dashboards/bluecar-stays`

Expected behavior:
1. Progress overlay shows 4 steps, advancing through each
2. Step 4 shows "Connecting..." → "X% downloaded" → "Y rows loaded"
3. Progress dismisses
4. KPI cards show real values (Total Stays, Bookings, Vehicles, POI Match Rate)
5. Bar charts render with real data (Activity Type, Car Class, Region, Vehicle Make)
6. Pie charts render (Fuel Type, Drive Type)

- [ ] **Step 3: Test click-to-filter**

1. Click a bar segment in the "Activity Type" chart (e.g., "Parking")
2. Expected: URL updates with `?activity_type=Parking`
3. Expected: Filter chip appears in header showing "Activity Type: Parking"
4. Expected: All other charts re-render with filtered data (counts decrease)
5. Expected: KPIs update to reflect filtered totals

- [ ] **Step 4: Test filter removal**

1. Click the same bar segment again (toggle off)
2. Expected: URL clears the parameter
3. Expected: Filter chip removed
4. Expected: All charts return to unfiltered state

- [ ] **Step 5: Test URL state restore**

1. Navigate to `http://localhost:3333/demo/dashboards/bluecar-stays?region=Höfuðborgarsvæðið`
2. Expected: Dashboard loads with region filter pre-applied
3. Expected: Filter chip shows, charts show filtered data

- [ ] **Step 6: Check browser console for errors**

Open DevTools console. Expected: No errors. Should see log messages:
- `[dashboard] Cube registry: bluecar_stays — 91 dims, 54 measures`
- `[dashboard-data] Scanned X panels → Y dims, Z measures, N groups, M kpis`
- `[dashboard] Data loaded, rendering charts...`

- [ ] **Step 7: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(dashboard): address issues found in end-to-end testing"
```

---

### Task 11: Wire the Top-X / All toggle

Connect the existing show-all toggle button (already in DOM from `buildPanelCard`) to re-query the group with adjusted limit.

**Files:**
- Modify: `demo/dashboard-engine.js` — update `wireCardInteractions` function (line 1304-1313)

- [ ] **Step 1: Update the show-all toggle handler**

In `wireCardInteractions` (line 1304), the existing handler at line 1308-1313 currently has a `// TODO: re-render chart with all vs top-N` comment. Replace the click handler body:

Find in `demo/dashboard-engine.js`:
```javascript
    showAllBtn.addEventListener('click', function () {
      var expanded = showAllBtn.dataset.expanded === 'true';
      showAllBtn.dataset.expanded = expanded ? 'false' : 'true';
      showAllBtn.textContent = expanded ? 'Top ' + showAllBtn.dataset.limit : 'All';
      // TODO: re-render chart with all vs top-N
    });
```

Replace with:
```javascript
    showAllBtn.addEventListener('click', function () {
      var expanded = showAllBtn.dataset.expanded === 'true';
      showAllBtn.dataset.expanded = expanded ? 'false' : 'true';
      showAllBtn.textContent = expanded ? 'Top ' + showAllBtn.dataset.limit : 'All';
      // Toggle the _expanded flag on the panel — renderAllPanels reads this
      // to decide the group query limit. Then trigger a re-render via filter change.
      panel._expanded = !expanded;
      notifyFilterChange();
    });
```

- [ ] **Step 2: Verify the toggle works**

In browser: click "Top 10" on a bar chart → should switch to "All" and show all values.
Click "All" → should switch back to "Top 10" and limit to 10.

- [ ] **Step 3: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): wire Top-X / All toggle to re-query group limit"
```
