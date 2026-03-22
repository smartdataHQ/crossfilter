# Implementation Plan: Line Chart & Table Enhancements

**Spec:** `docs/superpowers/specs/2026-03-20-line-chart-table-enhancements-design.md`
**Branch:** Create from `fix/readme-filterin-threshold` (current working branch)

> **IMPORTANT:** Read the full spec before starting. It contains the complete design rationale, edge cases, mutual exclusivity rules, data flow details, and schema constraints that are not repeated in this plan. This plan tells you WHAT to do and WHERE; the spec tells you WHY and handles ambiguity.

## Project Context

This is a crossfilter2-based dashboard engine. The dashboard config JSON doubles as an OpenAI structured output schema — the LLM generates configs that conform to it. The schema is auto-generated from slot definitions in `chart-types.js`.

### Key Files You Must Read First

Before starting any step, read and understand these files:

- **`demo/chart-types.js`** — Slot definitions for all 60+ chart types. Each type has `{ type, ecType, family, slots, ecOptions }`. Slots are `{ name, accepts, required, array }`. The schema builder groups types by slot signature. You will add 4 new slots here.
- **`demo/dashboard-data.js`** — Data layer. `scanPanels()` (line ~31) classifies panel fields into group-by dims, server filter dims, time dims, measures, groups, and KPIs. `createWorker()` (line ~473) builds the crossfilter worker. `buildGroupQueries()` (line ~419) builds per-panel group query params. `mergeResponses()` (line ~458) merges worker responses. `setBreakdown()` (line ~733) disposes/recreates groups with splitField.
- **`demo/dashboard-engine.js`** — Rendering engine (~3800 lines). `buildPanelCard()` (line ~2643) builds DOM for each panel type. `renderLineChart()` (line ~1447) renders time series with split data support. `renderSelectorList()` (line ~1805) renders dimension lists. The viz picker pattern (line ~3362) is the DOM/CSS template for the metric picker.
- **`demo/demo.css`** — All component styles. `.viz-picker` and `.viz-icon` classes (injected at line ~3364 of engine) are the pattern to reuse for the metric picker. `.filter-select` style exists in `demo-stockout/styles.css` as reference.
- **`demo/prompts/generator-system.md`** — LLM system prompt. Add guidance for new features here.
- **`demo/dashboards/bluecar-stays.json`** — Demo config to update.
- **`demo-stockout/panels/stockout-table.js`** — Reference implementation for table header filter selects (the `populateSelects()` pattern).
- **`demo-stockout/panels/helpers.js`** — `countsToOptions()` helper for building select options with counts.

### Conventions

- ES5-style code throughout: `var` declarations, no arrow functions, no `let`/`const`, no classes.
- All slot fields are flat scalars or arrays of scalars — no nested objects.
- The codebase uses `var` + function closures, not modern JS.
- Tests are in `test/crossfilter.test.js` (vitest). The demo layer has no unit tests — verify by running the dashboard at `http://localhost:3333/demo/dashboard.html#bluecar-stays`.

---

## Step 1: Schema — Add Slots to chart-types.js

**Files:** `demo/chart-types.js`

### 1a. Add `compare` and `metrics` slots to all line family types

Find every chart type definition where `family: 'time'`. These are: `line`, `line.smooth`, `line.step`, `line.area`, `line.area.stacked`, `line.area.normalized`, `line.bump`.

Add to each type's `slots` array:

```js
{ name: 'compare', accepts: 'dimension', required: false },
{ name: 'metrics', accepts: 'measure', required: false, array: true }
```

**Important:** Types that already have a `stack` slot (`line.area.stacked`, `line.area.normalized`, `line.bump`) will now have BOTH `stack` and `compare`. This is intentional — mutual exclusivity is enforced at runtime in `scanPanels`, not in the schema. The schema allows both so the LLM can generate either.

### 1b. Add `filters` and `sparklines` slots to the table type

Find the `table` chart type definition. Add to its `slots` array:

```js
{ name: 'filters', accepts: 'dimension', required: false, array: true },
{ name: 'sparklines', accepts: 'measure', required: false, array: true }
```

### Verification

Run `node demo/schema/generate-schema.js bluecar_stays 2>&1 | tail -10` to verify the schema generates without errors and stats remain within limits (properties ≤5000, enum values ≤1000, depth ≤5).

---

## Step 2: Data Layer — scanPanels + Worker Changes

**Files:** `demo/dashboard-data.js`

### 2a. Compare dimension in scanPanels

In `scanPanels()`, in the time-family branch (around line 89), after the group is created:

- When `panel.compare` is set AND `panel.stack` is NOT set, add `splitField: panel.compare` to the group spec.
- Add `panel.compare` to `groupByDims`.
- Set `panel._compareDim = panel.compare` for breakdown restore.
- When both `panel.compare` and `panel.stack` are set, use `panel.stack` as `splitField` (stack takes precedence). Still set `panel._compareDim` for potential future use but don't use it as splitField.

### 2b. Multi-metric group registration

In `scanPanels()`, when `panel.metrics` is an array:

- For each measure in `panel.metrics`, add it to the `measures` Set.
- Register additional metric entries on the group: `{ id: 'm_' + measureName, field: measureName, op: inferReduceOp(measureName, registry) }`.
- The primary metric (`panel._measField`) is always `{ id: 'value', ... }` as before.

### 2c. Eager all-measures registration for global metric

In `buildCubeQuery()`, change the measures array to include ALL measures from the registry, not just those discovered by `scanPanels`:

```js
// Replace:
measures: Array.from(scanResult.measures).map(...)
// With:
measures: Object.keys(registry.measures).map(function(m) { return cubeName + '.' + m; })
```

For group metric registration, in `scanPanels()`, after all groups are built, iterate all groups and register ALL registry measures as additional metric entries (with `id: 'm_' + name`). This enables the global metric selector to switch any group to any measure without group recreation.

### 2d. Table filter dimensions

In the `family === 'tabular'` branch of `scanPanels()`:

- When `panel.filters` is an array, add each filter dimension to `groupByDims`.
- Register multiple metrics on the table group for each measure in `panel.columns`.

### 2e. Table sparkline time dimension

In the `family === 'tabular'` branch:

- When `panel.sparklines` is an array and `registry._cubeMeta.time_dimension` exists, set `splitField: registry._cubeMeta.time_dimension` on the table group spec.
- Add the time dimension to `groupByDims` (if not already present from a time-series panel).

### 2f. mergeResponses — pass through rows

Update `mergeResponses()` to include `rows` data:

```js
function mergeResponses(responses) {
  var merged = { kpis: {}, groups: {}, rows: {} };
  for (var i = 0; i < responses.length; ++i) {
    var r = responses[i];
    if (!r || !r.snapshot) continue;
    var kpis = r.snapshot.kpis || {};
    for (var k in kpis) merged.kpis[k] = kpis[k];
    var groups = r.snapshot.groups || {};
    for (var g in groups) merged.groups[g] = groups[g];
  }
  // Pass through rows (not inside snapshot)
  for (var j = 0; j < responses.length; ++j) {
    if (responses[j] && responses[j].rows) merged.rows = responses[j].rows;
  }
  return merged;
}
```

Also update the `query()` method to include `rows` in the worker query when table panels have `filters`.

### 2g. setBreakdown — compare restore

In `setBreakdown()` (line ~733), when `breakdownDimField` is null (clearing breakdown):

```js
if (!breakdownDimField && timePanel._compareDim) {
  newSpec.splitField = timePanel._compareDim;
}
```

### 2h. buildProjection — include all measures

Update `buildProjection()` to include all registry measures in the rename/transform maps, not just those from `scanResult.measures`.

### Verification

Add `console.log` statements to verify:
- The Cube query includes all measures
- Groups have the expected metric entries
- The compare splitField appears in the group spec

---

## Step 3: Engine — Comparison Line Rendering

**Files:** `demo/dashboard-engine.js`

### 3a. renderLineChart — compare mode

In `renderLineChart()` (around line 1447), the function already handles split data for breakdown. When `panel.compare` is set (and split data is present):

- Collect all split keys and sum their values across all time buckets.
- Sort by total descending.
- Show top 5 as named colored lines (use ECharts theme palette colors).
- Remaining keys: add to legend but set `legendHoverLink: false` and series hidden by default (`emphasis: { disabled: true }`... actually, use ECharts legend `selected` object to control which are visible).
- Each line gets `smooth: true` if chart type includes smooth.
- Tooltip includes all visible series at the hovered timestamp.

**Reference:** The existing split-data rendering for breakdown (around line 1609 in the engine) already iterates split keys and builds series. The compare mode is similar but limits visible lines to top 5 and uses static colors instead of the breakdown's dynamic assignment.

### Verification

Update `bluecar-stays.json` timeline panel to add `"compare": "activity_type"` and verify 6 colored lines appear (activity_type has 6 values, all shown since ≤5 threshold — adjust threshold or show all when ≤ 8).

---

## Step 4: Engine — Metric Switcher UI

**Files:** `demo/dashboard-engine.js`, `demo/demo.css`

### 4a. Metric picker DOM in buildPanelCard

In `buildPanelCard()`, when `panel.metrics` is an array with >1 entries, generate a metric picker dropdown. Insert it into `headRight` BEFORE the viz picker markup.

**HTML structure** (match the viz picker pattern exactly):

```html
<div class="viz-picker metric-picker">
  <button class="viz-picker-trigger">
    <span class="metric-picker-label">{active metric label}</span>
    <span class="viz-picker-caret">&#9662;</span>
  </button>
  <div class="viz-picker-menu metric-picker-menu">
    <button class="metric-item metric-item--active" data-metric="count">Total Stays</button>
    <button class="metric-item" data-metric="unique_bookings">Unique Bookings</button>
  </div>
</div>
```

Get labels from `registry.measures[name].description` or `inferLabel(name, registry)`.

### 4b. Metric picker click handler

Wire the click handler in the same delegated event listener that handles the viz picker (around line 3432 in main()). Pattern:

- Click `.metric-item` → set `filterState['_metric_' + panelId] = metric`, call `writeUrlState(filterState)`, update active state on menu items, update trigger label, close menu.
- Click `.viz-picker-trigger` inside `.metric-picker` → toggle menu open/close.

### 4c. renderLineChart — read active metric

In `renderLineChart()`, resolve the active metric:

```js
var activeMetric = filterState['_metric_' + panel.id] || filterState['_metric'] || panel._measField;
var metricId = activeMetric === panel._measField ? 'value' : 'm_' + activeMetric;
```

Read data from `entry.value[metricId]` instead of `entry.value.value`. For split data (compare), read `entry.value[splitKey][metricId]`.

### 4d. CSS for metric picker

Add to `demo.css` or inline styles (existing viz picker styles are injected as inline `<style>` in `main()`):

```css
.metric-picker-label { font-size: 11px; font-family: var(--font-sans); }
.metric-item { display: block; width: 100%; text-align: left; border: none; background: none;
  padding: 6px 12px; font-size: 11px; cursor: pointer; color: #3f6587; white-space: nowrap; }
.metric-item:hover { background: rgba(63,101,135,0.08); }
.metric-item--active { color: #3d8bfd; background: rgba(61,139,253,0.1); font-weight: 600; }
```

The `.metric-picker-menu` grid should be `grid-template-columns: 1fr` (single column, not the 5-column grid the viz picker uses for icons).

### Verification

Add `"metrics": ["count", "unique_bookings", "unique_cars"]` to the timeline panel in `bluecar-stays.json`. Verify the dropdown appears next to the viz picker, switching metrics updates the line chart, and the selection persists in the URL.

---

## Step 5: Engine — Global Metric Selector

**Files:** `demo/dashboard-engine.js`

### 5a. Global metric dropdown in model bar

In `buildDashboardDOM()`, add a metric selector dropdown to the dashboard header area (near the title or in the model bar). List all measures from `registry.measures`.

Use the same native `<select>` pattern as the table filter selects (simpler than the viz-picker popup for a global control):

```html
<select id="global-metric-select" class="filter-select">
  <option value="">Default Metric</option>
  <option value="count">Total Stays</option>
  <option value="unique_bookings">Unique Bookings</option>
  ...
</select>
```

### 5b. Global metric change handler

Wire the select's `change` event:

```js
filterState['_metric'] = select.value || null;
writeUrlState(filterState);
notifyFilterChange();
executeKpiRefresh();
```

### 5c. Metric resolution in renderers

Create a helper function used by all renderers:

```js
function resolveActiveMetric(panel) {
  return filterState['_metric_' + panel.id]
    || filterState['_metric']
    || panel._measField
    || 'count';
}
```

Update `renderLineChart`, `renderBarChart`, `renderPieChart`, `renderKpi`, and gauge rendering to use `resolveActiveMetric(panel)` instead of directly reading `panel._measField`. Only apply the global metric to panels where `panel._measField` was not explicitly set in the config (i.e., `panel.y` or `panel.value` was null/omitted).

### 5d. KPI handling for non-local measures

In `executeKpiRefresh()`, use the resolved metric. If the resolved metric is non-local (check `registry.measures[name].aggType` — only `count` and `sum` are local), include it in the `fetchKpis()` call.

### 5e. URL restore

In `readUrlState()` / `restoreStateFromUrl()`, parse `_metric` and `_metric_<panelId>` keys from the URL hash.

### Verification

Select a global metric, verify all non-pinned panels update. Verify KPIs re-fetch for non-local measures. Verify URL persistence and restore on reload.

---

## Step 6: Table Multi-Column Data (Prerequisite)

**Files:** `demo/dashboard-data.js`, `demo/dashboard-engine.js`

### 6a. Multi-metric table group registration

In `scanPanels()`, the `family === 'tabular'` branch (line ~193):

- For each measure in `panel.columns`, register a metric entry: `{ id: 'm_' + name, field: name, op: inferReduceOp(name, registry) }`.
- Keep the default `{ id: 'value', field: null, op: 'count' }` as the first metric.

### 6b. Table rendering with multiple measures

In the table rendering code (engine line ~2021), update to read each column's value from the group entry:

- Dimension columns: `entry.key` (for first dim) or from rows data for additional dims.
- Measure columns: `entry.value['m_' + measureName].value` or `entry.value.value` for count.
- Format values using `formatMeasureValue()` with the measure's metadata.

### Verification

Add a table to `bluecar-stays.json` with multiple measure columns and verify they render with correct values.

---

## Step 7: Table Header Filters

**Files:** `demo/dashboard-engine.js`, `demo/dashboard-data.js`, `demo/demo.css`

### 7a. Filter select DOM in buildPanelCard

In `buildPanelCard()`, when `panel.chart === 'table'` and `panel.filters` exists:

Add native `<select>` elements to the `.card-head` `.card-filters` div:

```html
<select id="tbl-filter-{panelId}-{dimName}" class="filter-select">
  <option value="">All {Label} ({total})</option>
</select>
```

### 7b. Query with rows for filter data

In the `query()` method of `createDashboardData()`, when table panels have `filters`, include a `rows` parameter:

```js
rows: {
  fields: tableFilterDims,
  limit: 50000,
  columnar: true,
}
```

### 7c. Filter select population

In the table rendering function, populate filter selects from the `rows` data:

- Count unique values per filter dimension (use the `countsToOptions` pattern from `demo-stockout/panels/helpers.js`).
- Sort options descending by count.
- Preserve previous selection across re-renders.

### 7d. Client-side table filtering

Wire `onchange` on each select:

- Read selected values from all filter selects.
- Filter table entries: for each entry, check if its index in the columnar rows data matches all active filter values.
- Re-render only matching rows.
- Update count badge.

### 7e. CSS

Add `.filter-select` styles to `demo.css` matching the stockout demo:

```css
.filter-select {
  background: var(--bg-card-solid);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: 12px;
  padding: 3px 6px;
  outline: none;
  cursor: pointer;
  max-width: 160px;
}
```

### Verification

Add `"filters": ["fuel_type", "drive_type"]` to the table panel in `bluecar-stays.json`. Verify dropdowns appear in the table header, populate with counts, and filter the table rows.

---

## Step 8: Table Sparklines

**Files:** `demo/dashboard-engine.js`, `demo/dashboard-data.js`, `demo/demo.css`

### 8a. Sparkline time dimension in scanPanels

Already handled in step 2e. Verify the table group has `splitField: time_dimension`.

### 8b. Data partitioning in table renderer

Before rendering table rows, partition the split data:

```js
// entries = [{ key: "car_class_val", value: { ts1: { m_count: { value: 5 } }, ts2: { m_count: { value: 3 } } } }]
// Build sparklineData[rowKey][measureName] = [{ ts, value }, ...]
var sparklineData = {};
for (var i = 0; i < entries.length; ++i) {
  var rowKey = entries[i].key;
  sparklineData[rowKey] = {};
  var splits = entries[i].value;
  for (var measure in panel.sparklines) {
    var series = [];
    for (var ts in splits) {
      var metricId = 'm_' + panel.sparklines[measure];
      series.push({ ts: Number(ts), value: splits[ts][metricId] ? splits[ts][metricId].value : 0 });
    }
    series.sort(function(a, b) { return a.ts - b.ts; });
    sparklineData[rowKey][panel.sparklines[measure]] = series;
  }
}
```

### 8c. Sparkline cell rendering

For sparkline columns, render a `<td>` with a container div:

```html
<td><div class="sparkline-cell" id="spark-{panelId}-{rowIdx}-{measure}"></div></td>
```

After innerHTML is set, iterate sparkline cells and create ECharts instances:

```js
var sparkEl = document.getElementById('spark-' + panelId + '-' + rowIdx + '-' + measure);
var chart = echarts.init(sparkEl, THEME_NAME, { renderer: 'canvas', width: 120, height: 24 });
chart.setOption({
  animation: false,
  grid: { left: 0, right: 0, top: 0, bottom: 0 },
  xAxis: { show: false, type: 'value' },
  yAxis: { show: false, type: 'value' },
  series: [{ type: 'line', data: seriesData, symbol: 'none', lineStyle: { width: 1.5 } }],
});
```

### 8d. Sparkline instance lifecycle

Track all sparkline instances per panel in a module-level map:

```js
var _sparklineInstances = {};  // panelId → [chart, chart, ...]
```

Before each table re-render, dispose all instances for that panel:

```js
if (_sparklineInstances[panelId]) {
  for (var si = 0; si < _sparklineInstances[panelId].length; ++si) {
    _sparklineInstances[panelId][si].dispose();
  }
}
_sparklineInstances[panelId] = [];
```

### 8e. CSS

```css
.sparkline-cell { width: 120px; height: 24px; display: inline-block; }
```

### Verification

Add `"sparklines": ["count"]` to the table panel. Verify mini line charts appear in the count column, update when filters change, and dispose properly.

---

## Step 9: System Prompt Updates

**Files:** `demo/prompts/generator-system.md`

Add the guidance text specified in the spec:

1. Under "Time series:" — add `compare` and `metrics` guidance.
2. New "Table Options" subsection — add `filters` and `sparklines` guidance.
3. Under "Lazy Sections" — add notes about `compare`, `filters`, and `sparklines` cardinality requirements.
4. Under "What NOT to do" — add: "Do not use `compare` with high-cardinality dimensions (30+ values)" and "Do not use `compare` on stacked chart types".

---

## Step 10: Demo Config + Final Verification

**Files:** `demo/dashboards/bluecar-stays.json`

### 10a. Update timeline panel

```json
{ "chart": "line", "label": "Stays Over Time", "width": "full",
  "x": "stay_started_at", "y": "count",
  "compare": "activity_type",
  "metrics": ["count", "unique_bookings", "unique_cars"] }
```

### 10b. Add details table section

Add after the vehicle section (before modelbar):

```json
{
  "id": "details",
  "label": "Details",
  "location": "main",
  "columns": 1,
  "collapsed": true,
  "panels": [
    {
      "chart": "table", "label": "Activity Breakdown", "width": "full",
      "columns": ["activity_type", "region", "count", "unique_bookings"],
      "filters": ["fuel_type", "drive_type"],
      "sparklines": ["count"]
    }
  ]
}
```

### 10c. Final verification checklist

1. `npm test` — all 239 crossfilter tests pass
2. `npx eslint src/` — no errors
3. `node demo/schema/generate-schema.js bluecar_stays` — schema generates, stats within limits
4. Load `http://localhost:3333/demo/dashboard.html#bluecar-stays`:
   - Timeline shows 6 comparison lines (one per activity_type)
   - Metric dropdown appears next to viz picker, switching works
   - Global metric selector in model bar works
   - URL persists metric selections across reload
   - Table shows multiple columns with correct values
   - Table filter dropdowns populate and filter
   - Sparkline mini charts render in count column
   - Comparison + metric switch interaction works (all lines switch metric)
   - Breakdown (double-click) overrides compare, clearing restores compare
