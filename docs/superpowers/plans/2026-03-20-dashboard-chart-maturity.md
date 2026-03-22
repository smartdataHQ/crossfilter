# Dashboard Chart Maturity & Builder Validation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gap between the 54 chart types declared in `chart-types.js` and the ~24 actually rendered by the engine, add validation feedback to the builder, and mature the dashboard generation workflow.

**Architecture:** The engine (`dashboard-engine.js`) dispatches rendering by `ecType` in `renderAllPanels`. Each missing chart family needs: (1) a render function that turns crossfilter group data into ECharts options, (2) a `buildPanelCard` body template, (3) `renderAllPanels` dispatch wiring, and (4) `scanPanels` data-layer support for multi-slot families. The builder (`builder.html`) needs client-side config validation against available renderers before preview. Work is decomposed by chart family to enable parallel subagent execution.

**Tech Stack:** ECharts 5/6 (already loaded), crossfilter2, Shoelace web components, vanilla ES5 (project convention — `var`, no arrow functions, no classes)

---

## Current State Assessment

### Rendering (engine dispatches in `renderAllPanels` lines 1285-1353)

| ecType dispatch | Render function | Chart types covered |
|---|---|---|
| `'line'` | `renderLineChart` | line, line.smooth, line.step, line.area, line.area.stacked, line.bump (via viz picker: also bar, bar.stacked, bar.normalized, line.area.normalized as time-axis variants — note: `line.area.normalized` is handled in engine code but not declared in `chart-types.js`) |
| `'bar' \|\| 'pictorialBar'` | `renderBarChart` | bar, bar.horizontal, pictorialBar (note: `bar.stacked`, `bar.normalized` are `ecType: 'bar'` but dispatch to `renderBarChart` which does NOT handle stacking — they render as plain bars) |
| `'pie' \|\| 'funnel'` | `renderPieChart` | pie, pie.donut, pie.rose, pie.half, pie.nested, funnel, funnel.ascending |
| (no ecType) `'kpi'` | `renderKpi` | kpi |
| (no ecType) `'gauge'*` | `renderGaugeChart` | gauge, gauge.progress, gauge.ring |
| (no ecType) `'selector'/'dropdown'` | `renderSelectorList` | selector, dropdown |
| (no ecType) `'toggle'` | DOM toggle | toggle |
| (no ecType) `'range'` | noUiSlider | range |
| `'table'` (buildPanelCard only) | *partial — DOM template exists, no data wiring* | table |

### DOM templates in `buildPanelCard` (lines 2085-2163)
Explicit: table, toggle, range, selector/list, line, pie, bar. Everything else falls to **generic fallback** (line 2158: skeleton bars placeholder).

### Data layer (`scanPanels` in `dashboard-data.js` lines 31-150)
Only handles families: `time`, `category`, `control`, `single`. The `numeric`, `geo`, `hierarchy`, `relation`, `specialized`, `tabular` families are **not classified** — their dimensions don't get added to the crossfilter worker, no groups are created, no data flows.

### What's fully missing (no render, no DOM, no data)

| Family | Types | Slots needed | Notes |
|---|---|---|---|
| **category** (stacked) | bar.stacked, bar.normalized, bar.waterfall | category + value + stack | Dispatch hits `renderBarChart` but stacking not implemented |
| **numeric** | scatter, scatter.bubble, scatter.effect, heatmap, heatmap.calendar | x + y (+ size, color) | |
| **geo** | map, map.scatter, map.bubble, map.heatmap, map.lines, map.effect | region/lng/lat + value | Deferred — requires GeoJSON registration |
| **hierarchy** | treemap, sunburst, tree, tree.radial | levels[] + value | Needs nested tree-building from flat rows |
| **relation** | sankey, sankey.vertical, graph, graph.circular, chord | source + target + value | `chord` uses `ecType: 'custom'` — requires `renderItem` |
| **specialized** | radar, candlestick, candlestick.ohlc, boxplot, themeRiver, parallel | varies | candlestick/boxplot need multiple measures per row |
| **tabular** | table | columns[] | DOM template exists, no data wiring |

### Prerequisite: `line.area.normalized`

The engine's viz picker and render code handle `line.area.normalized` (100% stacked area), but this type is **not declared in `chart-types.js`**. Before Task 1, add it to the registry so `getChartType()` and `allTypeNames()` include it. This brings the total to 55 declared types.

### Builder gaps
1. No validation — LLM generates configs with unimplemented chart types, preview shows empty panels
2. No cube selector — hardcoded to first cube
3. No save/rename — only `_draft.json`
4. No feedback on what chart types are available/implemented

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `demo/dashboard-engine.js` | Rendering dispatch + render functions + DOM templates | Modify — add render functions, extend `buildPanelCard`, extend `renderAllPanels` |
| `demo/dashboard-data.js` | Data layer — panel scanning, Cube query building, crossfilter wiring | Modify — extend `scanPanels` for new families |
| `demo/chart-renderers.js` | **NEW** — Extracted render functions for complex chart types (keeps engine focused) | Create |
| `demo/chart-support.js` | **NEW** — Runtime registry of which chart types have working renderers (for validation) | Create |
| `demo/builder.html` | Builder UI + generation flow | Modify — add validation, cube selector, save flow |
| `demo/schema/generate-schema.js` | Schema + system prompt generation | Modify — filter to implemented types only |
| `test/dashboard-charts.test.js` | **NEW** — Tests for chart renderer functions | Create |
| `test/chart-support.test.js` | **NEW** — Tests for chart support registry | Create |
| `test/dashboard-validation.test.js` | **NEW** — Tests for config validation | Create |

---

## Task 1: Chart Support Registry + Validation Foundation

**Files:**
- Create: `demo/chart-support.js`
- Create: `test/chart-support.test.js`
- Modify: `demo/dashboard-engine.js` (import + warning on unsupported types)

This task creates the validation infrastructure. A runtime registry tracks which chart types have working renderers. The engine warns (console + visual) when a config uses an unsupported type. The builder can query this to filter LLM output.

- [ ] **Step 1: Write failing tests for chart-support registry**

```javascript
// test/chart-support.test.js
import { describe, it, expect } from 'vitest';
import { isChartSupported, listSupported, listUnsupported, validateConfig } from '../demo/chart-support.js';
import { allTypeNames } from '../demo/chart-types.js';

describe('chart-support', function () {
  it('reports bar as supported', function () {
    expect(isChartSupported('bar')).toBe(true);
  });

  it('reports unknown types as unsupported', function () {
    expect(isChartSupported('nonexistent')).toBe(false);
  });

  it('listSupported returns only implemented types', function () {
    var supported = listSupported();
    expect(supported).toContain('bar');
    expect(supported).toContain('kpi');
    expect(supported).toContain('line');
    // These are not yet implemented
    expect(supported).not.toContain('sankey');
    expect(supported).not.toContain('heatmap');
  });

  it('listUnsupported returns types without renderers', function () {
    var unsupported = listUnsupported();
    expect(unsupported.length).toBeGreaterThan(0);
    // Every type is in exactly one list
    var supported = listSupported();
    var all = allTypeNames();
    expect(supported.length + unsupported.length).toBe(all.length);
  });

  it('validateConfig returns errors for unsupported chart types', function () {
    var config = {
      title: 'Test',
      cubes: ['test_cube'],
      sharedFilters: [],
      sections: [{
        id: 's1', label: 'Test', location: 'main', columns: 2, collapsed: false,
        panels: [
          { chart: 'bar', dimension: 'region', cube: 'test_cube', label: 'Region', primary: false, limit: 10, searchable: false, width: null },
          { chart: 'sankey', source: 'from', target: 'to', cube: 'test_cube', label: 'Flow', primary: false, limit: null, searchable: false, width: null },
        ],
      }],
    };
    var result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('sankey');
    expect(result.warnings).toEqual([]);
  });

  it('validateConfig passes for all-supported configs', function () {
    var config = {
      title: 'Test',
      cubes: ['test_cube'],
      sharedFilters: [],
      sections: [{
        id: 's1', label: 'KPIs', location: 'main', columns: 3, collapsed: false,
        panels: [
          { chart: 'kpi', value: 'count', cube: 'test_cube', label: 'Total', primary: false, limit: null, searchable: false, width: null },
          { chart: 'bar', category: 'region', cube: 'test_cube', label: 'Region', primary: false, limit: 10, searchable: false, width: null },
        ],
      }],
    };
    var result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/chart-support.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement chart-support.js**

```javascript
// demo/chart-support.js
// Runtime registry of which chart types have working renderers.
// Used by the engine (warning on unsupported) and builder (validation).

import { allTypeNames, getChartType } from './chart-types.js';

// Set of chart type names that have a working render path in
// dashboard-engine.js. Update this set as new renderers are added.
var SUPPORTED = {
  // category family
  bar: true,
  'bar.horizontal': true,
  pictorialBar: true,
  pie: true,
  'pie.donut': true,
  'pie.rose': true,
  'pie.half': true,
  'pie.nested': true,
  funnel: true,
  'funnel.ascending': true,
  // time family (via renderLineChart + viz picker)
  line: true,
  'line.smooth': true,
  'line.step': true,
  'line.area': true,
  'line.area.stacked': true,
  'line.area.normalized': true,
  'line.bump': true,
  // single family
  kpi: true,
  gauge: true,
  'gauge.progress': true,
  'gauge.ring': true,
  // control family
  selector: true,
  dropdown: true,
  toggle: true,
  range: true,
};

export function isChartSupported(typeName) {
  return SUPPORTED[typeName] === true;
}

export function listSupported() {
  return allTypeNames().filter(function (t) { return SUPPORTED[t] === true; });
}

export function listUnsupported() {
  return allTypeNames().filter(function (t) { return !SUPPORTED[t]; });
}

// Mark a chart type as supported (called when new renderers are registered)
export function registerSupport(typeName) {
  SUPPORTED[typeName] = true;
}

// Validate a dashboard config — returns { valid, errors, warnings }
export function validateConfig(config) {
  var errors = [];
  var warnings = [];
  var sections = config.sections || [];

  for (var s = 0; s < sections.length; ++s) {
    var panels = sections[s].panels || [];
    for (var p = 0; p < panels.length; ++p) {
      var chart = panels[p].chart;
      if (!chart) continue;
      if (!getChartType(chart)) {
        errors.push('Unknown chart type "' + chart + '" in section "' + sections[s].id + '"');
      } else if (!SUPPORTED[chart]) {
        errors.push('Chart type "' + chart + '" is not yet implemented (section "' + sections[s].id + '", panel "' + (panels[p].label || p) + '")');
      }
    }
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/chart-support.test.js`
Expected: PASS

- [ ] **Step 5: Add visual warning in engine for unsupported chart types**

In `demo/dashboard-engine.js`, in `buildPanelCard` at the generic else fallback (line ~2158), add an unsupported badge:

```javascript
// In the else block at line 2158, replace the generic fallback:
  } else {
    // Check if chart type is known but unimplemented
    var _chartDef = getChartType(panel.chart);
    if (_chartDef) {
      body = '<div class="panel-unsupported">' +
        '<span class="unsupported-icon">&#9888;</span>' +
        '<span class="unsupported-label">Chart type "' + escapeHtml(panel.chart) + '" is not yet supported</span>' +
      '</div>';
    } else {
      body = '<div id="chart-' + panel.id + '" class="chart-wrap">' +
        buildSkeletonBars(6) +
      '</div>';
    }
  }
```

Also add the CSS for `.panel-unsupported` in the inline style injection in `main()`.

- [ ] **Step 6: Commit**

```bash
git add demo/chart-support.js test/chart-support.test.js demo/dashboard-engine.js
git commit -m "feat(dashboard): add chart support registry and unsupported type warnings"
```

---

## Task 2: Builder Validation Feedback

**Files:**
- Modify: `demo/builder.html` (add validation after generation)
- Modify: `demo/proxy-server.mjs` (add `/api/chart-support` endpoint, filter schema to supported types)

The builder should validate generated configs against the support registry and show warnings to the user. The schema generator should optionally constrain to implemented types only.

- [ ] **Step 1: Add validation endpoint to proxy server**

In `demo/proxy-server.mjs`, add a `GET /api/chart-support` route that returns the supported/unsupported chart type lists. This runs server-side since the builder doesn't import ES modules.

```javascript
// In the request handler, add before the catch-all:
if (req.method === 'GET' && pathname === '/api/chart-support') {
  var { listSupported, listUnsupported } = await import('./chart-support.js');
  var body = JSON.stringify({
    supported: listSupported(),
    unsupported: listUnsupported(),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
  return;
}
```

- [ ] **Step 2: Add `supportedOnly` option to schema generator**

In `demo/schema/generate-schema.js`, modify `generateDashboardSchema` to accept an options object:

```javascript
export function generateDashboardSchema(metaResponse, cubeNames, options) {
  var enums = extractCubeEnums(metaResponse, cubeNames);
  var opts = options || {};

  var dimEnum = enums.dimensions;
  var measEnum = enums.measures;
  var cubeEnum = enums.cubes;
  var chartTypeEnum = opts.supportedOnly
    ? allTypeNames().filter(function (t) { return isChartSupported(t); })
    : allTypeNames();

  var schema = buildFullSchema(chartTypeEnum, dimEnum, measEnum, cubeEnum);
  // ... rest unchanged
}
```

Import `isChartSupported` from `../chart-support.js` at the top.

- [ ] **Step 3: Wire supportedOnly into the generation endpoint**

In `demo/proxy-server.mjs` `handleDashboardGenerate`, pass `{ supportedOnly: true }` to `generateDashboardSchema`:

```javascript
var schema = generateDashboardSchema(metaResponse, cubes, { supportedOnly: true });
```

- [ ] **Step 4: Add validation feedback in builder.html**

After receiving the generated config, fetch `/api/chart-support` and show warnings:

```javascript
// After currentConfig is set (line ~174), add:
var supportRes = await fetch('/api/chart-support');
var support = await supportRes.json();
var unsupportedSet = {};
for (var u = 0; u < support.unsupported.length; ++u) {
  unsupportedSet[support.unsupported[u]] = true;
}

var issues = [];
var sections = currentConfig.sections || [];
for (var si = 0; si < sections.length; ++si) {
  var panels = sections[si].panels || [];
  for (var pi = 0; pi < panels.length; ++pi) {
    if (panels[pi].chart && unsupportedSet[panels[pi].chart]) {
      issues.push(panels[pi].chart + ' ("' + (panels[pi].label || 'unnamed') + '")');
    }
  }
}
if (issues.length > 0) {
  addMessage('error', 'Warning: ' + issues.length + ' panel(s) use unsupported chart types: ' +
    issues.join(', ') + '. These will show placeholder panels.');
}
```

- [ ] **Step 5: Commit**

```bash
git add demo/builder.html demo/proxy-server.mjs demo/schema/generate-schema.js
git commit -m "feat(builder): validate generated configs against supported chart types"
```

---

## Task 3: Stacked/Normalized Bar Charts (category family)

**Files:**
- Modify: `demo/dashboard-engine.js` (extend `renderBarChart` + `buildPanelCard`)
- Modify: `demo/dashboard-data.js` (extend `scanPanels` for stacked category charts)
- Modify: `demo/chart-support.js` (register new types)
- Create: `test/dashboard-charts.test.js`

The time-series renderer already handles `bar.stacked` and `bar.normalized` for time-axis data. Category-axis stacked bars need a different data path: two crossfilter dimensions (category + stack), cross-tabulated into multiple series.

- [ ] **Step 1: Extend scanPanels for stacked category charts**

In `demo/dashboard-data.js` `scanPanels`, after the `category || control` block (line ~115), add handling for stacked bar types:

```javascript
      } else if (family === 'category' && (chartType === 'bar.stacked' || chartType === 'bar.normalized' || chartType === 'bar.waterfall')) {
        // Stacked bars need both the category dim AND the stack dim
        groupByDims.add(panel._dimField);
        if (panel.stack) groupByDims.add(panel.stack);

        var stackMeasField = panel._measField;
        var stackOp = stackMeasField ? inferReduceOp(stackMeasField, registry) : 'count';
        groups.push({
          id: panel.id,
          field: panel._dimField,
          metrics: [{ id: 'value', field: stackOp === 'count' ? null : stackMeasField, op: stackOp }],
          splitField: panel.stack || null,
        });
        panel._groupId = panel.id;
```

- [ ] **Step 2: Add DOM templates in buildPanelCard for bar.stacked/normalized/waterfall**

Currently `buildPanelCard` only matches `panel.chart === 'bar'` exactly (line 2144). Stacked/normalized/waterfall types fall to the generic else fallback. Add explicit cases or broaden the bar check:

```javascript
  } else if (panel.chart === 'bar' || panel.chart === 'bar.horizontal' ||
             panel.chart === 'bar.stacked' || panel.chart === 'bar.normalized' ||
             panel.chart === 'bar.waterfall') {
    body = '<div id="chart-' + panel.id + '" class="chart-wrap">' +
      buildSkeletonBars(Math.min(panel.limit || 10, 8)) +
    '</div>';
```

- [ ] **Step 3: Extend renderBarChart to handle stacked data**

In `demo/dashboard-engine.js`, extend `renderBarChart` to detect split group data and render stacked/normalized series. When `groupData` has split entries (like the time-series split path), build multiple bar series with `stack: 'category'`.

The pattern mirrors what `renderLineChart` already does for split data (lines 976-1091) but with vertical bars on a category axis.

- [ ] **Step 4: Add bar.waterfall render path**

Waterfall is a special bar layout where each bar starts where the previous one ended. ECharts supports this via invisible "placeholder" bars + actual bars.

- [ ] **Step 5: Register support and test**

In `demo/chart-support.js`, add:
```javascript
  'bar.stacked': true,
  'bar.normalized': true,
  'bar.waterfall': true,
```

- [ ] **Step 6: Commit**

```bash
git add demo/dashboard-engine.js demo/dashboard-data.js demo/chart-support.js
git commit -m "feat(dashboard): implement stacked, normalized, and waterfall bar charts"
```

---

## Task 4: Scatter & Heatmap Charts (numeric family)

**Files:**
- Modify: `demo/dashboard-engine.js` (add `renderScatterChart`, `renderHeatmapChart`, DOM templates, dispatch)
- Modify: `demo/dashboard-data.js` (extend `scanPanels` for numeric family)
- Modify: `demo/chart-support.js`

Scatter charts need two measures (x, y) plus optional size/color. The data layer needs to expose raw rows or multi-measure group data rather than simple key→value groups.

- [ ] **Step 1: Extend scanPanels for numeric family**

```javascript
      } else if (family === 'numeric') {
        // Scatter/heatmap need multiple fields per row
        // x can be dimension or measure, y is measure
        if (panel._dimField) groupByDims.add(panel._dimField);
        // For heatmap: both x and y are dimensions
        if (panel.y && registry.dimensions[panel.y]) groupByDims.add(panel.y);
        if (panel.color && registry.dimensions[panel.color]) groupByDims.add(panel.color);

        var numMeasField = panel._measField;
        var numOp = numMeasField ? inferReduceOp(numMeasField, registry) : 'count';
        // For scatter, x is the primary group-by dimension
        groups.push({
          id: panel.id,
          field: panel._dimField,
          metrics: [{ id: 'value', field: numOp === 'count' ? null : numMeasField, op: numOp }],
        });
        panel._groupId = panel.id;
      }
```

- [ ] **Step 2: Add renderScatterChart**

```javascript
function renderScatterChart(panelEl, panel, groupData) {
  var entries = groupData.entries || [];
  if (!entries.length) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  var chartDef = getChartType(panel.chart);
  var scatterData = [];
  for (var i = 0; i < entries.length; ++i) {
    var e = entries[i];
    var point = [e.key, e.value.value];
    scatterData.push(point);
  }

  var seriesOpts = {
    type: chartDef.ecType || 'scatter',
    data: scatterData,
    symbolSize: 8,
  };

  if (chartDef.ecOptions) {
    var ec = chartDef.ecOptions;
    if (ec.effectType) seriesOpts.effectType = ec.effectType;
    if (ec.coordinateSystem) seriesOpts.coordinateSystem = ec.coordinateSystem;
  }

  var option = {
    tooltip: { trigger: 'item' },
    grid: { left: 10, right: 10, top: 10, bottom: 10, containLabel: true },
    xAxis: { type: 'value', name: panel.x || '' },
    yAxis: { type: 'value', name: panel.y || '' },
    series: [seriesOpts],
  };

  var instance = echarts.getInstanceByDom(panelEl);
  if (!instance) instance = echarts.init(panelEl, THEME_NAME, { renderer: 'canvas' });
  option.animation = false;
  instance.clear();
  instance.setOption(option, { notMerge: true });
  return instance;
}
```

- [ ] **Step 3: Add renderHeatmapChart**

ECharts heatmap on cartesian needs: two category axes (x, y) + value for color intensity. The data layer produces entries keyed by the x dimension; we need a cross-tab of x × y → value. This requires a `splitField` group (y dimension) similar to stacked bars.

- [ ] **Step 4: Add DOM templates in buildPanelCard**

Add cases for `scatter`, `heatmap` chart types with appropriate `chart-wrap` containers.

- [ ] **Step 5: Wire dispatch in renderAllPanels**

```javascript
      } else if (ecType === 'scatter' || ecType === 'effectScatter') {
        instance = renderScatterChart(chartEl, panel, groupData);
      } else if (ecType === 'heatmap') {
        instance = renderHeatmapChart(chartEl, panel, groupData);
      }
```

- [ ] **Step 6: Register support and commit**

```javascript
  scatter: true,
  'scatter.bubble': true,
  'scatter.effect': true,
  heatmap: true,
  'heatmap.calendar': true,
```

```bash
git add demo/dashboard-engine.js demo/dashboard-data.js demo/chart-support.js
git commit -m "feat(dashboard): implement scatter, bubble, effectScatter, and heatmap charts"
```

---

## Task 5: Hierarchy Charts (treemap, sunburst, tree)

**Files:**
- Modify: `demo/dashboard-engine.js` (add `renderHierarchyChart`)
- Modify: `demo/dashboard-data.js` (extend `scanPanels` for hierarchy family)
- Modify: `demo/chart-support.js`

Hierarchy charts use `levels[]` (array of dimension names) to build nested tree data. The data layer needs to query all level dimensions, and the renderer must nest them into ECharts' tree/treemap data format `{ name, value, children: [...] }`.

- [ ] **Step 1: Extend scanPanels for hierarchy family**

Hierarchy charts need ALL level dimensions as group-by dims so the crossfilter worker has them. We create a group per level to get value aggregates at each level, then build the tree client-side.

```javascript
      } else if (family === 'hierarchy') {
        // levels[] is an array of dimensions forming the hierarchy
        var levels = panel.levels;
        if (Array.isArray(levels)) {
          for (var lv = 0; lv < levels.length; ++lv) {
            groupByDims.add(levels[lv]);
          }
        }
        // Create groups for EACH level — the renderer will cross-reference
        // to build the nested tree structure
        var hierMeasField = panel._measField;
        var hierOp = hierMeasField ? inferReduceOp(hierMeasField, registry) : 'count';
        if (Array.isArray(levels)) {
          for (var lg = 0; lg < levels.length; ++lg) {
            groups.push({
              id: panel.id + '__level' + lg,
              field: levels[lg],
              metrics: [{ id: 'value', field: hierOp === 'count' ? null : hierMeasField, op: hierOp }],
              splitField: lg > 0 ? levels[lg - 1] : null,
            });
          }
        }
        panel._groupId = panel.id + '__level0';
        panel._allLevelGroupIds = Array.isArray(levels)
          ? levels.map(function (_, idx) { return panel.id + '__level' + idx; })
          : [];
      }
```

- [ ] **Step 2: Add renderHierarchyChart**

**Design note:** Crossfilter groups produce flat `key → value` aggregates, not nested rows. To build the `{ name, value, children }` tree that ECharts treemap/sunburst requires:

1. The first level group (`__level0`) gives top-level entries: `{ key: 'RegionA', value: 500 }`
2. The second level group (`__level1`) uses `splitField` to give entries split by parent: `{ key: 'CityX', value: { RegionA: { value: 300 }, RegionB: { value: 200 } } }`
3. The renderer walks levels in order, nesting children under their parent from the split data

This mirrors the existing split-group pattern used by `renderLineChart` for breakdown (lines 976-1091), but nests recursively instead of creating parallel series.

```javascript
function renderHierarchyChart(panelEl, panel, response, registry) {
  // Collect group data for all levels
  var levelGroups = [];
  for (var lg = 0; lg < panel._allLevelGroupIds.length; ++lg) {
    var gid = panel._allLevelGroupIds[lg];
    var gdata = response.groups[gid];
    if (gdata) levelGroups.push(gdata);
  }
  if (!levelGroups.length || !levelGroups[0].entries || !levelGroups[0].entries.length) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  // Build tree from level groups
  // Level 0: root children from flat entries
  var rootChildren = [];
  var entries0 = levelGroups[0].entries;
  for (var i = 0; i < entries0.length; ++i) {
    rootChildren.push({
      name: String(entries0[i].key),
      value: entries0[i].value.value,
      children: [],
    });
  }

  // Level 1+: nest children using split data
  if (levelGroups.length > 1) {
    var entries1 = levelGroups[1].entries || [];
    for (var j = 0; j < entries1.length; ++j) {
      var childName = String(entries1[j].key);
      var splits = entries1[j].value;
      for (var parentName in splits) {
        if (parentName === 'value') continue;
        var parentNode = null;
        for (var rn = 0; rn < rootChildren.length; ++rn) {
          if (rootChildren[rn].name === parentName) { parentNode = rootChildren[rn]; break; }
        }
        if (parentNode && splits[parentName] && splits[parentName].value) {
          parentNode.children.push({
            name: childName,
            value: splits[parentName].value,
          });
        }
      }
    }
  }

  var chartDef = getChartType(panel.chart);
  // ... build ECharts option based on ecType (treemap vs sunburst vs tree)
}
```

- [ ] **Step 3: Wire dispatch and register support**

```javascript
      } else if (ecType === 'treemap' || ecType === 'sunburst' || ecType === 'tree') {
        instance = renderHierarchyChart(chartEl, panel, groupData, registry);
      }
```

Register: `treemap`, `sunburst`, `tree`, `tree.radial`.

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js demo/dashboard-data.js demo/chart-support.js
git commit -m "feat(dashboard): implement treemap, sunburst, and tree charts"
```

---

## Task 6: Relation Charts (sankey, graph, chord)

**Files:**
- Modify: `demo/dashboard-engine.js` (add `renderSankeyChart`, `renderGraphChart`)
- Modify: `demo/dashboard-data.js` (extend `scanPanels` for relation family)
- Modify: `demo/chart-support.js`

Sankey and graph charts need two dimensions (source, target) and one measure (value). The data layer needs to group by both dimensions to produce `{ source, target, value }` link data.

- [ ] **Step 1: Extend scanPanels for relation family**

```javascript
      } else if (family === 'relation') {
        // source and target are both dimensions
        if (panel.source) groupByDims.add(panel.source);
        if (panel.target) groupByDims.add(panel.target);

        var relMeasField = panel._measField;
        var relOp = relMeasField ? inferReduceOp(relMeasField, registry) : 'count';
        // Group by source dim, split by target for cross-tabulation
        groups.push({
          id: panel.id,
          field: panel.source || panel._dimField,
          metrics: [{ id: 'value', field: relOp === 'count' ? null : relMeasField, op: relOp }],
          splitField: panel.target || null,
        });
        panel._groupId = panel.id;
      }
```

- [ ] **Step 2: Add renderSankeyChart**

ECharts sankey needs `{ nodes: [{ name }], links: [{ source, target, value }] }`. Extract from split group data.

```javascript
function renderSankeyChart(panelEl, panel, groupData) {
  var entries = groupData.entries || [];
  if (!entries.length) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  var nodeSet = {};
  var links = [];

  for (var i = 0; i < entries.length; ++i) {
    var sourceName = String(entries[i].key);
    nodeSet[sourceName] = true;
    var targets = entries[i].value;
    for (var t in targets) {
      if (t === 'value') continue;
      nodeSet[t] = true;
      var val = targets[t] && targets[t].value || 0;
      if (val > 0) {
        links.push({ source: sourceName, target: t, value: val });
      }
    }
  }

  var nodes = Object.keys(nodeSet).map(function (n) { return { name: n }; });
  var chartDef = getChartType(panel.chart);
  var seriesOpts = {
    type: 'sankey',
    data: nodes,
    links: links,
    emphasis: { focus: 'adjacency' },
    lineStyle: { color: 'gradient', curveness: 0.5 },
  };
  if (chartDef && chartDef.ecOptions && chartDef.ecOptions.orient) {
    seriesOpts.orient = chartDef.ecOptions.orient;
  }

  var option = {
    tooltip: { trigger: 'item' },
    series: [seriesOpts],
  };

  var instance = echarts.getInstanceByDom(panelEl);
  if (!instance) instance = echarts.init(panelEl, THEME_NAME, { renderer: 'canvas' });
  option.animation = false;
  instance.clear();
  instance.setOption(option, { notMerge: true });
  return instance;
}
```

- [ ] **Step 3: Add renderGraphChart**

Similar structure to sankey — nodes + links. ECharts graph uses `{ nodes: [{ name, symbolSize }], links: [{ source, target, value }] }` with force/circular layout from `ecOptions`.

- [ ] **Step 4: Wire dispatch and register support**

```javascript
      } else if (ecType === 'sankey') {
        instance = renderSankeyChart(chartEl, panel, groupData);
      } else if (ecType === 'graph') {
        instance = renderGraphChart(chartEl, panel, groupData);
      }
```

Register: `sankey`, `sankey.vertical`, `graph`, `graph.circular`.

**Note on `chord`:** This type uses `ecType: 'custom'` in chart-types.js, which requires implementing an ECharts custom series with a `renderItem` function. This is significantly more complex than standard series types. Defer `chord` to a follow-up task — do NOT register it as supported. The unsupported badge will show correctly.

- [ ] **Step 5: Commit**

```bash
git add demo/dashboard-engine.js demo/dashboard-data.js demo/chart-support.js
git commit -m "feat(dashboard): implement sankey, graph charts (chord deferred — requires custom renderItem)"
```

---

## Task 7: Table Panel Data Wiring

**Files:**
- Modify: `demo/dashboard-engine.js` (wire table rendering in `renderAllPanels`)
- Modify: `demo/dashboard-data.js` (extend `scanPanels` for tabular family)
- Modify: `demo/chart-support.js`

The table DOM template already exists in `buildPanelCard` (line 2087). What's missing is: the data layer doesn't create any groups for table panels, and `renderAllPanels` doesn't populate the `<tbody>`. Tables need access to raw crossfilter rows (not grouped data).

- [ ] **Step 1: Extend scanPanels for tabular family**

Tables query all their `columns[]` fields as dimensions. They don't group — they show individual records from the crossfilter's current filtered state.

```javascript
      } else if (family === 'tabular') {
        // Table needs all column fields as dimensions (for display + filtering)
        var cols = panel.columns;
        if (Array.isArray(cols)) {
          for (var ci = 0; ci < cols.length; ++ci) {
            if (registry.dimensions[cols[ci]]) groupByDims.add(cols[ci]);
          }
        }
        panel._isTable = true;
      }
```

- [ ] **Step 2: Add renderTable function**

Wire `renderAllPanels` to populate the table body from the crossfilter's `allFiltered()` or top records. Include sort toggle and pagination (the skeleton already has a sort button and scroll container).

- [ ] **Step 3: Register support and commit**

```javascript
  table: true,
```

```bash
git add demo/dashboard-engine.js demo/dashboard-data.js demo/chart-support.js
git commit -m "feat(dashboard): wire table panel data rendering with sort and pagination"
```

---

## Task 8: Specialized Charts (radar, themeRiver, parallel, candlestick, boxplot)

**Files:**
- Modify: `demo/dashboard-engine.js`
- Modify: `demo/dashboard-data.js`
- Modify: `demo/chart-support.js`

Lower-priority charts that are useful but less commonly generated by the LLM. Candlestick and boxplot need multiple measures per data point.

- [ ] **Step 1: Add renderRadarChart**

Radar needs `axes[]` (dimensions) and `values[]` (measures). ECharts radar config: `radar: { indicator: [...] }`, `series: [{ type: 'radar', data: [...] }]`.

- [ ] **Step 2: Add renderThemeRiverChart**

ThemeRiver uses `date` (time dim), `value` (measure), `stream` (category dim). ECharts: `series: [{ type: 'themeRiver', data: [[date, value, stream], ...] }]`.

- [ ] **Step 3: Add renderParallelChart**

Parallel coordinates: `axes[]` (any fields). ECharts: `parallelAxis: [...]`, `series: [{ type: 'parallel', data: [...] }]`.

- [ ] **Step 4: Add renderCandlestickChart**

Candlestick needs `date` + 4 measures (open, close, low, high). The data layer needs all 4 measures as group metrics so the worker computes them per time bucket. `candlestick.ohlc` uses `ecType: 'custom'` and requires a `renderItem` function — defer this like chord. Only standard `candlestick` (ecType: 'candlestick') is feasible.

- [ ] **Step 5: Add renderBoxplotChart**

Boxplot needs `category` + 5 measures (min, q1, median, q3, max). Similar multi-metric approach. ECharts boxplot data format: `[[min, q1, median, q3, max], ...]`.

- [ ] **Step 6: Extend scanPanels, wire dispatch, register**

```javascript
      } else if (family === 'specialized') {
        // Each specialized type has unique slot needs
        if (panel._dimField) groupByDims.add(panel._dimField);
        if (panel.stream) groupByDims.add(panel.stream);
        if (panel.axes && Array.isArray(panel.axes)) {
          for (var ai = 0; ai < panel.axes.length; ++ai) {
            if (registry.dimensions[panel.axes[ai]]) groupByDims.add(panel.axes[ai]);
          }
        }
        // Multi-measure types: collect all measure slots as separate metrics
        var specMetrics = [];
        var measSlots = ['value', 'open', 'close', 'low', 'high', 'min', 'q1', 'median', 'q3', 'max'];
        for (var ms = 0; ms < measSlots.length; ++ms) {
          var mField = panel[measSlots[ms]];
          if (mField && registry.measures[mField]) {
            measures.add(mField);
            specMetrics.push({ id: measSlots[ms], field: mField, op: inferReduceOp(mField, registry) });
          }
        }
        if (specMetrics.length === 0) {
          specMetrics.push({ id: 'value', field: null, op: 'count' });
        }
        groups.push({
          id: panel.id,
          field: panel._dimField || (panel.axes && panel.axes[0]) || null,
          metrics: specMetrics,
        });
        panel._groupId = panel.id;
      }
```

Register: `radar`, `themeRiver`, `parallel`, `candlestick`, `boxplot`.

**Deferred:** `candlestick.ohlc` (ecType: 'custom', needs renderItem — same issue as chord).

- [ ] **Step 5: Commit**

```bash
git add demo/dashboard-engine.js demo/dashboard-data.js demo/chart-support.js
git commit -m "feat(dashboard): implement radar, themeRiver, and parallel charts"
```

---

## Task 9: Geographic Charts (map family) — Deferred

**Note:** Geographic charts (map, map.scatter, map.bubble, map.heatmap, map.lines, map.effect) require ECharts geo/map registration with GeoJSON data for the target region. This is a significant dependency (which GeoJSON to load? Iceland? Global?) and should be scoped as its own mini-project after the core chart types are stable.

For now, these remain in the "unsupported" list, and the engine shows the unsupported warning badge. The LLM system prompt should note this limitation.

- [ ] **Step 1: Add geo limitation note to system prompt**

In `demo/schema/generate-schema.js` `generateSystemPrompt`, add after the geographic section:

```javascript
lines.push('**NOTE:** Geographic map chart types (map, map.scatter, map.bubble, map.heatmap, map.lines, map.effect) are NOT YET AVAILABLE in the rendering engine. Do not use them. Use bar charts with location dimensions instead until map support is added.');
```

- [ ] **Step 2: Commit**

```bash
git add demo/schema/generate-schema.js
git commit -m "docs(dashboard): note geo chart types as unavailable in system prompt"
```

---

## Task 10: Builder UX Improvements

**Files:**
- Modify: `demo/builder.html`
- Modify: `demo/proxy-server.mjs`

Three improvements: cube selector, save/rename, and available cubes endpoint.

- [ ] **Step 1: Add `/api/cubes` endpoint**

In `demo/proxy-server.mjs`, add a route that returns available cube names from the meta endpoint:

```javascript
if (req.method === 'GET' && pathname === '/api/cubes') {
  var metaResponse = await loadCubeMeta();
  var cubes = (metaResponse.cubes || []).map(function (c) {
    return { name: c.name, title: c.title || c.name };
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ cubes: cubes }));
  return;
}
```

- [ ] **Step 2: Add cube selector to builder header**

In `demo/builder.html`, add a `<select>` in the header that fetches from `/api/cubes` on load and sends the selected cube name with the generation request:

```html
<select id="cube-select" class="cube-select">
  <option value="">Loading cubes...</option>
</select>
```

Wire it to fetch on page load and include `cubeNames: [selectedCube]` in the POST body.

- [ ] **Step 3: Add save-as functionality**

Add a "Save As" button that prompts for a dashboard name and POSTs to a new `/api/dashboard/save` endpoint:

```javascript
// proxy-server.mjs
if (req.method === 'POST' && pathname === '/api/dashboard/save') {
  var body = await readBody(req);
  var { name, config } = JSON.parse(body);
  var safeName = name.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  var filePath = path.resolve(DEMO_DIR, 'dashboards', safeName + '.json');
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ saved: safeName }));
  return;
}
```

- [ ] **Step 4: Add supported chart type count to status bar**

Show `"N/55 chart types supported"` in the builder status area after fetching `/api/chart-support`. Compute the total dynamically from `supported.length + unsupported.length`.

- [ ] **Step 5: Commit**

```bash
git add demo/builder.html demo/proxy-server.mjs
git commit -m "feat(builder): add cube selector, save-as, and chart support status"
```

---

## Task 11: Integration Test — bluecar-stays Dashboard

**Files:**
- Create: `test/dashboard-validation.test.js`

Validate that the existing dashboard configs (`bluecar-stays.json`, `bluecar-fleet.json`, etc.) pass validation as chart support grows.

- [ ] **Step 1: Write validation tests**

```javascript
// test/dashboard-validation.test.js
import { describe, it, expect } from 'vitest';
import { validateConfig } from '../demo/chart-support.js';
import fs from 'node:fs';
import path from 'node:path';

var DASHBOARDS_DIR = path.resolve(import.meta.dirname, '../demo/dashboards');

function loadConfig(name) {
  var filePath = path.resolve(DASHBOARDS_DIR, name + '.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('dashboard config validation', function () {
  it('bluecar-fleet.json tracks support coverage', function () {
    var config = loadConfig('bluecar-fleet');
    var result = validateConfig(config);
    // bluecar-fleet uses: kpi, bar, pie, line, range, table
    // table is unsupported until Task 7 completes
    if (result.errors.length > 0) {
      console.log('Unsupported in bluecar-fleet:', result.errors);
    }
    // Baseline: only table is unsupported (1 error). Update as support grows.
    expect(result.errors.length).toBeLessThanOrEqual(1);
  });

  it('bluecar-geography.json reports unsupported geo types', function () {
    var config = loadConfig('bluecar-geography');
    var result = validateConfig(config);
    // Geography configs will have map.* types which are deferred
    var geoErrors = result.errors.filter(function (e) { return e.indexOf('map') >= 0; });
    expect(geoErrors.length).toBeGreaterThan(0);
  });

  it('bluecar-ai-generated.json tracks support coverage', function () {
    var config = loadConfig('bluecar-ai-generated');
    var result = validateConfig(config);
    var totalPanels = 0;
    var sections = config.sections || [];
    for (var s = 0; s < sections.length; ++s) {
      totalPanels += (sections[s].panels || []).length;
    }
    var coverage = ((totalPanels - result.errors.length) / totalPanels * 100).toFixed(0);
    console.log('AI-generated dashboard coverage: ' + coverage + '% (' +
      (totalPanels - result.errors.length) + '/' + totalPanels + ' panels supported)');
  });
});
```

- [ ] **Step 2: Run and document baseline**

Run: `npx vitest run test/dashboard-validation.test.js`
Record the baseline coverage percentage. As tasks 3-8 complete, re-run to track progress.

- [ ] **Step 3: Commit**

```bash
git add test/dashboard-validation.test.js
git commit -m "test(dashboard): add config validation integration tests with coverage tracking"
```

---

## Execution Order

Tasks are designed for parallel execution where possible:

**Sequential dependencies:**
- Task 1 (support registry) must complete first — all other tasks depend on it
- Task 2 (builder validation) depends on Task 1

**Parallelizable after Task 1:**
- Tasks 3, 4, 5, 6, 7, 8 (chart families) are independent of each other
- Task 9 (geo note) is independent
- Task 10 (builder UX) is independent of chart tasks
- Task 11 (integration tests) should run last to measure coverage

**Recommended execution order:**
1. Prerequisite: Add `line.area.normalized` to `chart-types.js`
2. Task 1 → Task 2 (foundation)
3. Tasks 3, 4, 5, 6, 7 in parallel (chart families)
4. Task 8 (specialized — lower priority)
5. Task 9 + 10 in parallel (geo note + builder UX)
6. Task 11 (integration validation)

---

## Deferred Items (follow-up projects)

| Item | Reason | Complexity |
|---|---|---|
| Geographic charts (map.*) | Requires GeoJSON registration — which regions? | Medium-high |
| `chord` chart | `ecType: 'custom'` requires ECharts `renderItem` function | Medium |
| `candlestick.ohlc` | `ecType: 'custom'` requires ECharts `renderItem` function | Medium |
| `pie.nested` stacking | Currently renders as flat pie — needs inner/outer ring logic | Low-medium |
| Multi-model support | Builder generates for one cube at a time, no `sharedFilters` UI | Medium |
| Conversation pruning | Builder conversation grows unbounded on long sessions | Low |
