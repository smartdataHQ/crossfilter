# Dashboard Data Wiring — Design Spec

**Date:** 2026-03-19
**Status:** Draft
**Depends on:** [Dashboard Config Schema Design](2026-03-19-dashboard-config-schema-design.md)

## Goal

Wire config-driven crossfilter workers to the dashboard engine so that panels render live data, respond to filter changes, and support click-to-filter — all without a single hardcoded field name. The first deliverable is one bar chart panel end-to-end; the architecture supports all 54 chart types and multi-crossfilter.

## Scope — Phase 1

Wire up the **bar chart** panel (the "domain selector" component) as the first complete vertical slice:

1. Scan config panels → collect needed dimensions + measures
2. Build Cube.dev POST query from config + registry (Arrow format)
3. Create one `createStreamingDashboardWorker()` per cube
4. Field rename projection (Arrow qualified names → short names)
5. Worker groups: one per bar/pie panel (dimension → group with count/sum reducer)
6. Worker KPIs: one per KPI panel (groupAll reducer)
7. Progress overlay driven by real worker events
8. On worker ready: query groups → render ECharts bar chart
9. Click-to-filter on bar segments → setFilter → re-query → re-render all panels
10. Top-X / All toggle re-queries the group with adjusted limit

## Architecture

### New file: `demo/dashboard-data.js`

Single module responsible for the crossfilter data layer. The engine (`dashboard-engine.js`) calls it; it returns query results. Clean separation: engine owns DOM, data module owns workers.

Imports `getChartType` from `chart-types.js` to resolve slot definitions per panel.

```
dashboard-engine.js          dashboard-data.js
     │                            │
     │  createDashboardData(      │
     │    config, registry,       │
     │    resolvedPanels)         │
     │ ──────────────────────────>│
     │                            │── scanPanels() → fields needed
     │                            │── buildCubeQuery() → POST body
     │                            │── buildProjection() → rename + transforms
     │                            │── await createStreamingDashboardWorker()
     │                            │── register worker.on('progress'/'ready'/'error')
     │                            │
     │  .on('progress', fn)       │
     │ <──────────────────────────│── worker progress events
     │                            │
     │  .on('ready', fn)          │
     │ <──────────────────────────│── worker ready event
     │                            │
     │  .on('error', fn)          │
     │ <──────────────────────────│── worker error event
     │                            │
     │  .query(filterState)       │
     │ ──────────────────────────>│── converts filterState to typed filters
     │                            │── worker.query({ filters, snapshot })
     │ <──────────────────────────│── { kpis, groups }
     │                            │
     │  engine renders panels     │
     │  from response data        │
```

### Slot-aware field resolution

**Critical design decision:** The config uses chart-type-specific slot names (`category`, `name`, `x`, `value`, etc.) — not generic `dimension`/`measure` properties. For example:

- `{ "chart": "bar", "category": "activity_type" }` — dimension is in `panel.category`
- `{ "chart": "pie", "name": "fuel_type" }` — dimension is in `panel.name`
- `{ "chart": "kpi", "value": "count" }` — measure is in `panel.value`
- `{ "chart": "line", "x": "stay_started_at", "y": "count" }` — dimension in `panel.x`, measure in `panel.y`

The engine's existing `normalizeConfig()` (line 276-278) partially handles this:
```javascript
if (!panel.dimension) {
  panel.dimension = panel.category || panel.name || panel.x || panel.source || panel.date || panel.region || panel.lng || null;
}
if (!panel.measure) {
  panel.measure = panel.value || panel.y || panel.size || null;
}
```

This gives us `panel.dimension` and `panel.measure` as the primary field references. However, `scanPanels` must **also** walk the chart type's slot definitions to collect ALL referenced fields (e.g., a `scatter.bubble` panel references `x`, `y`, `size`, and `color` — four separate fields). The slot walk ensures every field used by any panel is included in the Cube query and worker dimensions.

### Panel → field scanning

Walk resolved panels. For each panel, read the chart type's slots from `chart-types.js` and collect:

| Slot accepts | Collected as | Example |
|---|---|---|
| `dimension` | Cube query dimension + worker dimension | `category: "activity_type"` |
| `measure` | Cube query measure | `value: "count"` |
| `any` | Check registry to classify as dimension or measure | `x: "stay_started_at"` |

Additionally:
- Every panel with a dimension in a category/control family gets a **worker group** (dimension.group() with metric reducer)
- Every KPI/gauge panel's measure gets a **worker KPI** (groupAll reducer)
- The `partition` filter from cube meta is always included in the Cube query
- Time dimensions referenced by `line` panels get the model period date range filter

```javascript
// scanPanels returns everything the worker needs
function scanPanels(panels, registry) {
  var dims = new Set();
  var measures = new Set();
  var groups = [];
  var kpis = [];

  for (var i = 0; i < panels.length; ++i) {
    var panel = panels[i];
    var chartDef = getChartType(panel.chart);
    if (!chartDef) continue;

    // Walk ALL slots to collect every referenced field
    var panelDimField = null;   // first dimension-type slot value
    var panelMeasField = null;  // first measure-type slot value

    for (var s = 0; s < chartDef.slots.length; ++s) {
      var slot = chartDef.slots[s];
      var field = panel[slot.name];
      if (!field) continue;

      // Array slots (levels, axes, columns, values)
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

    // Attach resolved fields to panel for rendering phase
    panel._dimField = panelDimField || panel.dimension || null;
    panel._measField = panelMeasField || panel.measure || null;

    // Category/control family: create a group (dimension → group with metric)
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

    // Single family (kpi, gauge): groupAll reducer
    if (family === 'single' && panel._measField) {
      var kpiOp = inferReduceOp(panel._measField, registry);
      kpis.push({ id: panel.id, field: kpiOp === 'count' ? null : panel._measField, op: kpiOp });
      panel._kpiId = panel.id;
    }
  }

  // Always include 'count' measure for default reductions
  measures.add('count');

  return { dims: dims, measures: measures, groups: groups, kpis: kpis };
}

// Infer reduce op from measure metadata
function inferReduceOp(measureName, registry) {
  if (measureName === 'count') return 'count';
  var meta = registry.measures[measureName];
  if (!meta) return 'sum';
  var agg = meta.aggType;
  if (agg === 'count' || agg === 'countDistinct') return 'count';
  if (agg === 'avg') return 'avg';
  return 'sum';
}
```

### Cube name resolution

The engine normalizes `config.cubes` (array) to `config.cube` (string) in `normalizeConfig()` (line 289-292). The data module receives `config.cube` — a single cube name for Phase 1. Multi-cube dashboards will pass the full `config.cubes` array; the data module creates one worker per entry.

For Phase 1, `sharedFilters: []` means single-cube mode with no cross-cube filter bridging. The multi-cube `sharedFilters` mechanism will be specified when the first multi-cube dashboard is built.

### Cube query construction

Mirrors `cube-registry.js:buildCubeQuery()` from the stockout demo — but derived entirely from the scan result + registry:

```javascript
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

### Field rename projection

Arrow responses use qualified names (`bluecar_stays.activity_type` or `bluecar_stays__activity_type`). Build rename map from the scan result:

```javascript
function buildProjection(cubeName, dims, measures, registry) {
  var rename = {};
  var transforms = {};

  function addField(field) {
    rename[cubeName + '.' + field] = field;
    rename[cubeName + '__' + field] = field;
  }

  dims.forEach(addField);
  measures.forEach(addField);

  // Mark numeric fields for type coercion (Arrow may send as string/bigint)
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

### Worker creation and initialization sequence

One streaming worker per cube. `createStreamingDashboardWorker()` returns a promise that resolves to the worker handle. Event listeners are registered on the handle after resolution.

```javascript
function createWorker(cubeName, scanResult, registry) {
  var cubeQuery = buildCubeQuery(cubeName, scanResult.dims, scanResult.measures, registry);
  var projection = buildProjection(cubeName, scanResult.dims, scanResult.measures, registry);

  // Returns a promise — must be awaited before registering .on() listeners
  return crossfilter.createStreamingDashboardWorker({
    crossfilterUrl: '../crossfilter.js',
    arrowRuntimeUrl: '../node_modules/apache-arrow/Arrow.es2015.min.js',
    batchCoalesceRows: 65536,
    wasm: true,
    emitSnapshots: false,       // Phase 1: no streaming snapshots
    progressThrottleMs: 100,
    dimensions: Array.from(scanResult.dims),
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
}

// Initialization flow:
// 1. var workerHandle = await createWorker(cubeName, scanResult, registry);
// 2. workerHandle.on('progress', progressCallback);
// 3. workerHandle.on('error', errorCallback);
// 4. await workerHandle.ready;  // resolves when data fully loaded
// 5. Initial query + render
```

### Multi-crossfilter support

The config declares `cubes: ["bluecar_stays"]` (or multiple). The data module creates one worker per cube. Each panel is associated with its cube (for Phase 1, all panels use `config.cube`; multi-cube panel-to-cube mapping will be added when needed).

Filter changes query all workers in parallel (like stockout's `refreshAllPanels`):

```javascript
// data.query(filterState) → Promise.all across workers
function query(filterState) {
  var promises = [];
  for (var cubeId in workers) {
    var filters = buildFilters(filterState, workerDimensions[cubeId]);
    promises.push(workers[cubeId].query({
      request: {
        filters: filters,
        snapshot: {},  // returns { kpis, groups, runtime }
      },
    }));
  }
  return Promise.all(promises).then(mergeResponses);
}

// mergeResponses combines worker results keyed by cube name.
// Each worker response has shape: { snapshot: { kpis, groups, runtime }, rows, ... }
// The merged result provides: { kpis: {...}, groups: { panelId: groupData, ... } }
function mergeResponses(responses) {
  var merged = { kpis: {}, groups: {} };
  for (var i = 0; i < responses.length; ++i) {
    var r = responses[i];
    if (!r || !r.snapshot) continue;
    // KPIs from snapshot
    var kpis = r.snapshot.kpis || {};
    for (var k in kpis) merged.kpis[k] = kpis[k];
    // Groups from snapshot
    var groups = r.snapshot.groups || {};
    for (var g in groups) merged.groups[g] = groups[g];
  }
  return merged;
}
```

The dimension check `workerDimensions[cubeId].indexOf(dim) >= 0` ensures a filter only applies to workers that have that dimension — same pattern as stockout's `buildDashboardFilters`.

### Filter state → crossfilter filter conversion

The engine's `filterState` uses simple values (`{ activity_type: "Parking" }` or `{ region: ["North", "South"] }`). The data module converts to typed filters the worker expects:

```javascript
function buildFilters(filterState, workerDimensions) {
  var filters = {};
  for (var dim in filterState) {
    if (workerDimensions.indexOf(dim) < 0) continue;
    var val = filterState[dim];
    if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number') {
      // Range filter (from range slider)
      filters[dim] = { type: 'range', range: val };
    } else {
      // In filter (from bar click, dropdown, toggle)
      filters[dim] = { type: 'in', values: Array.isArray(val) ? val : [val] };
    }
  }
  return filters;
}
```

### Group queries

Each bar/pie panel maps to a crossfilter group. The snapshot queries all groups configured on the worker. The default snapshot (empty `{}`) returns all groups with default parameters. For panel-specific limits, the query specifies group overrides:

```javascript
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

The response for each group is `{ entries: [{ key: "Parking", value: { value: 1234 } }, ...], total: 50 }`.

### Bar chart rendering

Transform group entries → ECharts options. Config-driven, no hardcoded fields:

```javascript
function renderBarChart(panelEl, panel, groupData, registry) {
  var entries = groupData.entries || [];
  var categories = [];
  var values = [];

  for (var i = 0; i < entries.length; ++i) {
    categories.push(String(entries[i].key));
    values.push(entries[i].value.value);
  }

  var chartDef = getChartType(panel.chart);
  var isHorizontal = chartDef.ecOptions && chartDef.ecOptions._horizontal;

  var catAxis = { type: 'category', data: categories };
  var valAxis = { type: 'value' };

  var option = {
    tooltip: { trigger: 'axis' },
    grid: { left: 10, right: 10, top: 10, bottom: 10, containLabel: true },
    xAxis: isHorizontal ? valAxis : catAxis,
    yAxis: isHorizontal ? catAxis : valAxis,
    series: [{
      type: 'bar',
      data: values,
      barMaxWidth: 40,
    }],
  };

  var instance = echarts.getInstanceByDom(panelEl) ||
    echarts.init(panelEl, themeName, { renderer: 'canvas' });
  instance.setOption(option, true);

  return instance;
}
```

### Click-to-filter wiring

Every chart panel that has a dimension gets a click handler. The handler uses `panel._dimField` (resolved during scanning) to know which dimension to filter:

```javascript
function wireChartClick(instance, panel) {
  instance.on('click', function(params) {
    var dim = panel._dimField;
    if (!dim) return;
    var clickedValue = params.name || (params.data && params.data.name);
    if (!clickedValue) return;

    // Toggle: if already filtered to this value, clear; otherwise set
    var current = filterState[dim];
    if (current === clickedValue || (Array.isArray(current) && current.length === 1 && current[0] === clickedValue)) {
      setFilter(dim, null);
    } else {
      setFilter(dim, clickedValue);
    }
  });
}
```

`setFilter` → `writeUrlState` → `notifyFilterChange` → data module `query(filterState)` → re-render all panels.

### Progress overlay and error handling

The engine already builds the progress overlay with 4 steps. Wire it to real worker events:

```javascript
data.on('progress', function(payload) {
  if (payload.status === 'starting') updateProgress(3, 'Connecting...');
  else if (payload.status === 'downloading') {
    var pct = payload.fetch.percent;
    var label = pct != null ? Math.round(pct * 100) + '% downloaded' : 'Downloading...';
    updateProgress(3, label);
  }
  else if (payload.status === 'streaming') {
    updateProgress(3, payload.load.rowsLoaded.toLocaleString() + ' rows loaded');
  }
});

data.on('ready', function() {
  refreshAllPanels();
  dismissProgress();
  wireChartResize();
});

data.on('error', function(payload) {
  // Show error in progress overlay, do not dismiss
  var msg = payload && payload.message ? payload.message : 'Data loading failed';
  progressCard.innerHTML = '<div class="progress-step progress-step--error">' +
    '<span class="progress-dot"></span>' +
    '<span>' + escapeHtml(msg) + '</span>' +
  '</div>';
});
```

### KPI rendering

KPI panels read from the snapshot's KPI values. The measure's metadata drives display formatting:

```javascript
function renderKpi(panel, kpiValue, registry) {
  var el = document.querySelector('#panel-' + panel.id + ' .kpi-value');
  if (!el) return;
  var raw = kpiValue;
  if (raw == null || raw !== raw) { el.textContent = '\u2014'; return; }

  var meta = registry.measures[panel._measField];
  el.textContent = formatMeasureValue(raw, meta);
}

// Format a measure value for display.
// Uses aggType and format from cube metadata.
function formatMeasureValue(value, meta) {
  if (value == null || value !== value) return '\u2014';
  if (!meta) return typeof value === 'number' ? value.toLocaleString() : String(value);
  // Percentage-like measures (rates, scores)
  if (meta.format === 'percent' || (meta.aggType === 'number' && /rate|percent/i.test(meta.description || ''))) {
    return (value * 100).toFixed(1) + '%';
  }
  // Duration measures
  if (/hours?/i.test(meta.description || '') || /duration.*hours/i.test(meta.fullName || '')) {
    return value.toFixed(1) + 'h';
  }
  // Count-like and default
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(1);
}
```

### Engine integration (replacing lines 1626-1632)

The current TODO block in `main()`:

```javascript
// BEFORE (lines 1626-1632):
updateProgress(3, 'Streaming data into dashboard...');
await new Promise(function (r) { setTimeout(r, 800); });
dismissProgress();
wireChartResize();

// AFTER:
var data = await createDashboardData(config, registry, resolvedPanels);

data.on('progress', function(payload) { /* progress overlay updates */ });
data.on('error', function(payload) { /* error display */ });

await data.ready;

// Register filter listener: on any filter change, re-query and re-render
filterListeners.push(function(newFilterState) {
  data.query(newFilterState).then(function(response) {
    renderAllPanels(resolvedPanels, response, registry);
  });
});

// Initial render
var initialResponse = await data.query(filterState);
renderAllPanels(resolvedPanels, initialResponse, registry);
dismissProgress();
wireChartResize();
```

### Refresh cycle

```
User clicks bar segment "Parking"
    ↓
setFilter('activity_type', 'Parking')
    ↓
filterState = { activity_type: 'Parking' }
writeUrlState(filterState)          ← URL bookmarkable
renderFilterChips()                 ← visual feedback
notifyFilterChange()
    ↓
filterListeners[0] = function(filterState) { data.query(filterState).then(renderAllPanels) }
    ↓
data.query(filterState)
    ├── buildFilters(filterState, workerDimensions['bluecar_stays'])
    │   → { activity_type: { type: 'in', values: ['Parking'] } }
    ├── worker.query({ request: { filters, snapshot: {} } })
    └── (future: second worker for other cube)
    ↓
response from worker = { snapshot: { kpis: { panel_id: value, ... }, groups: { panel_id: { entries: [...], total: N }, ... }, runtime: {...} } }
    ↓
mergeResponses → { kpis: {...}, groups: {...} }
    ↓
renderAllPanels(resolvedPanels, response, registry):
  for each panel:
    if kpi  → renderKpi(panel, response.kpis[panel._kpiId], registry)
    if bar  → renderBarChart(chartEl, panel, response.groups[panel._groupId], registry)
    if pie  → renderPieChart(chartEl, panel, response.groups[panel._groupId], registry)
    (future: line, scatter, table, etc.)
```

## File Changes

| File | Change |
|---|---|
| `demo/dashboard-data.js` | **New.** Data layer: scanPanels, buildCubeQuery, buildProjection, createWorker, query, buildFilters, mergeResponses, formatMeasureValue. Imports `getChartType` from `chart-types.js`. ~350 lines. |
| `demo/dashboard-engine.js` | Replace TODO at line 1627 with `createDashboardData()` call. Register `filterListener`. Add `renderBarChart()`, `renderPieChart()`, `renderKpi()`, `renderAllPanels()`, `wireChartClick()`. ~200 lines added. |
| `demo/chart-types.js` | No changes. Read-only dependency for slot lookups. |
| `demo/dashboard-meta.js` | No changes. Already provides everything needed. |
| `demo/dashboard.html` | Add `<script>` for Apache Arrow runtime (needed by streaming worker). |

## What This Design Does NOT Cover (Future Phases)

- Line/time-series charts (need time bucket groups + granularity switching)
- Scatter/bubble charts (need custom multi-measure groups)
- Table panels (need row queries, not groups)
- Selector/list panels (need group queries with search + pagination)
- Hierarchy charts (treemap, sunburst — need multi-level grouping)
- Relation charts (sankey, graph — need co-occurrence groups)
- Geographic charts (need GeoJSON registration)
- Segment filters (need Cube query filter integration)
- Range slider data bounds (need `worker.bounds()` query)
- Streaming snapshot updates (charts update while data loads — `emitSnapshots` set to false for Phase 1)
- Multi-cube `sharedFilters` bridging (single-cube only for Phase 1; `sharedFilters: []` in config)

## Conventions

- ES5 style (`var`, no arrow functions, no `let`/`const`) matching existing source
- No external dependencies beyond what's already loaded
- All field names from config + registry, zero hardcoding
- ECharts theme from `echarts-theme.js` (already registered)
