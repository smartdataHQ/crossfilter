# Line Chart & Table Enhancements — Design Spec

**Date:** 2026-03-20
**Status:** Draft
**Scope:** Schema slots, engine rendering, system prompt, demo config

## Overview

Five enhancements to the dashboard config system, all fitting the existing `chart-types.js` slot pattern and OpenAI structured output JSON Schema:

| Feature | Slot | Type | Chart Types |
|---|---|---|---|
| A. Line brush filtering | *(none — already works)* | — | line family |
| B. Comparison dimension | `compare` | dimension, optional | line family |
| C. Multi-metric system | `metrics` | measure[], optional | line family |
| D. Table header filters | `filters` | dimension[], optional | table |
| E. Table sparklines | `sparklines` | measure[], optional | table |

Plus a three-layer metrics architecture (panel-level, dashboard-level, formula editor).

## Context

The dashboard config JSON is used as OpenAI `response_format.json_schema` with `strict: true`. Constraints:

- All panel properties must be flat scalars or arrays of scalars (no nested objects — depth limit 5)
- `additionalProperties: false` everywhere
- Budget: ≤5000 properties, ≤1000 enum values, ≤120K enum chars
- The schema is auto-generated from `chart-types.js` slot definitions via `dashboard-schema-base.js`
- A system prompt (`prompts/generator-system.md`) gives the LLM semantic guidance

## A. Line Brush Filtering

**Already implemented.** Any `line` panel with a time `x` dimension gets dataZoom brush filtering automatically. The brush sets `setFilter(timeDim, [ts1, ts2])` which filters the crossfilter client-side. Lazy panels receive the brush range as a `timeDimensions.dateRange` in their Cube query. No config or schema changes needed.

## B. Comparison Dimension

### Schema

New slot on all line family types in `chart-types.js`:

```js
{ name: "compare", accepts: "dimension", required: false }
```

Config example:

```json
{ "chart": "line", "x": "stay_started_at", "y": "count", "compare": "activity_type" }
```

Schema impact: one nullable `$ref: dimField` added to the line-family panel branch.

### Engine Behavior

1. **`scanPanels` (dashboard-data.js):** When `panel.compare` is set, add the compare dimension to `groupByDims` and set `splitField` on the time-series group spec at creation time:
   ```js
   groups.push({
     id: panel.id,
     field: panel._dimField,
     metrics: [...],
     splitField: panel.compare,  // static split at group creation
   });
   ```
   **Note:** The existing time-family group registration (lines 89-98) does NOT currently use `splitField`. The dynamic breakdown mechanism (`setBreakdown`) disposes and recreates the group to add/remove `splitField` at runtime. For `compare`, we set `splitField` statically at creation time — this is simpler and does not conflict with the breakdown path. If the user activates a breakdown on a chart that already has `compare`, the breakdown replaces the `compare` split (breakdown takes precedence).

2. **`renderLineChart` (dashboard-engine.js):** When split data is present and the chart has `compare`:
   - Rank split keys by total volume across all time buckets
   - Show top 5 as colored lines (from ECharts theme palette)
   - Remaining keys are in the legend but hidden by default (user clicks legend to toggle)
   - No band or average line — just the top N lines
   - Tooltip shows all visible lines at the hovered timestamp

3. **`groupByDims`:** The compare dimension is added to the crossfilter worker's dimensions so it can be filtered. It is also added to the Cube query dimensions.

### Mutual exclusivity with `stack`

The `compare` slot is added to ALL line family types including those that already have `stack` (`line.area.stacked`, `line.area.normalized`, `line.bump`). However, `compare` and `stack` both use `splitField` on the group spec — only one can be active.

**Resolution:** `stack` takes precedence. If both `compare` and `stack` are set on the same panel, `scanPanels` uses `stack` as the `splitField` and ignores `compare`. The renderer follows the chart type's stacking behavior. The system prompt will advise: "Do not use `compare` on stacked chart types (`line.area.stacked`, `line.area.normalized`, `line.bump`) — use it on `line`, `line.smooth`, `line.step`, or `line.area`."

### Constraints

- Compare should only be used with low-cardinality dimensions (<20 values). The system prompt will enforce this guidance.
- The compare dimension must be in the "Safe for main query" list (not lazy).
- Do not combine `compare` with `stack` — stack takes precedence.

### Edge Cases

- **Compare dimension has 0 values:** Renders as a normal single-line chart (no split data).
- **Compare dimension has 1 value:** Renders a single named line (label from the value).
- **Compare + breakdown interaction:** If a user double-clicks to activate breakdown on a chart with `compare`, the breakdown replaces the compare split. Clearing the breakdown must restore the compare split. Implementation: `scanPanels` sets `panel._compareDim = panel.compare` when the compare slot is present. In `setBreakdown(null)`, check `timePanel._compareDim` and recreate the group with `splitField: timePanel._compareDim` instead of no splitField. Both `scanPanels` and `setBreakdown` are in `dashboard-data.js`.

## C. Multi-Metric System

Three layers, progressively implemented.

### Layer 1: Panel-Level Metric Switcher (implement now)

#### Schema

New slot on all line family types in `chart-types.js`:

```js
{ name: "metrics", accepts: "measure", required: false, array: true }
```

**Note:** The `metrics` slot is added ONLY to line family types in the schema. Layer 2 (dashboard-level active metric) does NOT require a `metrics` slot on bar/KPI/gauge types — it works through the resolution order without a slot. The global metric selector operates on the resolved measure field (`panel._measField`), not through a schema slot. This keeps the schema minimal and the LLM's job simple: it only needs to think about `metrics` when configuring line charts.

Config example:

```json
{
  "chart": "line", "x": "stay_started_at", "y": "count",
  "metrics": ["count", "unique_bookings", "unique_cars"]
}
```

`y` is the default metric shown. `metrics` lists alternatives the user can switch between.

#### Engine Behavior

1. **`scanPanels`:** When `panel.metrics` is set, register all listed measures as separate metric entries on the group:
   ```
   metrics: [
     { id: "value", field: "count", op: "count" },
     { id: "m_unique_bookings", field: "unique_bookings", op: "sum" },
     { id: "m_unique_cars", field: "unique_cars", op: "sum" }
   ]
   ```
   All metrics are loaded into the crossfilter reduce function — switching is instant.

2. **`buildPanelCard`:** When `panel.metrics` exists, render a metric dropdown adjacent to the viz picker in the card header. Reuses the same DOM/CSS pattern:
   ```html
   <div class="viz-picker metric-picker">
     <button class="viz-picker-trigger">
       <span class="metric-picker-label">Total Stays</span>
       <span class="viz-picker-caret">&#9662;</span>
     </button>
     <div class="viz-picker-menu">
       <button class="metric-item metric-item--active" data-metric="count">Total Stays</button>
       <button class="metric-item" data-metric="unique_bookings">Unique Bookings</button>
       <button class="metric-item" data-metric="unique_cars">Unique Vehicles</button>
     </div>
   </div>
   ```
   - `.metric-picker` reuses `.viz-picker` layout (relative positioning, popup menu)
   - Trigger shows the active metric label (from `registry.measures[name].description` or `inferLabel`)
   - Menu items are text buttons (not icons, unlike the viz picker which uses SVG chart icons)
   - `.metric-item--active` gets the same blue highlight as `.viz-icon--active`
   - Menu opens/closes with the same click handler pattern as the viz picker
   - Placed to the LEFT of the viz picker in the card header (metric choice is more prominent than viz choice)

3. **URL persistence:** Active metric stored as `_metric_<panelId>=unique_bookings`. Falls back to `y` when not set.

4. **`renderLineChart`:** Reads the active metric from `filterState['_metric_' + panel.id]`, falls back to `panel._measField`. Selects the corresponding metric entry from the group data.

### Layer 2: Dashboard-Level Active Metric (implement now)

1. **Global metric selector:** A dropdown in the model bar header area (or dashboard title bar). Lists all measures from the cube registry. No config enumeration needed — derived from `registry.measures`.

2. **URL persistence:** Stored as `_metric=unique_bookings`.

3. **Panel behavior:**
   - Panels with an explicit `y` or `value` are **pinned** — they always show their configured measure regardless of the global metric.
   - Panels where `y` or `value` is omitted (or set to `null`) **follow the global metric**. When the user switches the global metric, these panels update.
   - Panel-level `_metric_<panelId>` overrides the global `_metric` for that specific panel.
   - Affected panel types: line (Y-axis), bar (value), KPI (value), gauge (value).

4. **Resolution order:** `_metric_<panelId>` > `_metric` (global) > `panel.y` / `panel.value` (config default) > `"count"` (fallback).

5. **Re-render:** Changing the global metric triggers `notifyFilterChange()`. Each panel reads its resolved metric and re-renders from the existing crossfilter data — no re-query needed since all measures are already loaded.

#### Crossfilter Worker Scope for Global Metrics

Currently, `scanPanels` only registers measures explicitly referenced by panel configs. For the global metric selector to offer ALL cube measures, the Cube query must include all measures and the crossfilter worker must have them available for reduce functions.

**Implementation:** In `buildCubeQuery` (dashboard-data.js), always include ALL measures from `registry.measures` in `query.measures`, not just those discovered by `scanPanels`. The crossfilter worker's reduce function already accepts arbitrary metric entries — the cost is minimal (measures are scalars aggregated per group, not dimensions that expand the result grain). The Cube query size does not change significantly since measures don't affect the number of rows returned.

For group metric registration, each group registers metrics for its configured measure(s) plus the global active metric. When the global metric changes, groups that don't have the new metric registered need a dynamic update. Two approaches:

- **Eager:** Register ALL measures as metrics on every group at creation time. Simple but adds ~48 metric entries per group. The crossfilter reduce function would track all of them.
- **Lazy:** Register only configured metrics at creation. When the global metric changes to an unregistered measure, dispose and recreate affected groups with the new metric added. More complex but lighter.

**Recommendation:** Use the eager approach. 48 metrics × ~15 groups = ~720 metric entries. Each is a single accumulator in the reduce function (one addition/subtraction per row per metric). This is negligible compared to the dimension indexing cost. The simplicity of not needing dynamic group recreation justifies the small overhead.

#### KPIs and Non-Local Measures

KPIs with `countDistinct` or computed aggregations (`poi_match_rate`, `avg_stay_duration_hours`, etc.) cannot be reduced client-side — they currently use direct Cube API queries via `fetchKpis()`. When the global metric switches to one of these non-local measures:

1. The engine detects that the resolved metric is not locally reducible (check `kpiMeta.aggType` — only `count` and `sum` are local).
2. For non-local metrics, the engine triggers a KPI re-fetch via `queryKpis()` with the new measure.
3. The existing `executeKpiRefresh` mechanism already handles this — it queries Cube directly for non-local KPIs.
4. The global metric simply changes which measure is passed to `fetchKpis`.

For bar/pie/line panels, non-local measures (like `avg`) are already handled by the crossfilter's `avg` reduce op — no Cube re-query needed. The `inferReduceOp` function maps `aggType` to the correct op.

### Layer 3: Formula Metrics (spec only, implement later)

1. **User-defined derived metrics** via an expression editor: e.g., `unique_bookings / unique_cars`.

2. **Compilation:** Formulas compile to custom crossfilter reduce functions (add/remove/initial). The worker API already supports `createGroup`/`disposeGroup` for dynamic group management.

3. **Integration:** Once defined, formula metrics appear in the global metric selector alongside cube measures. They behave identically — switchable, URL-persistable.

4. **Storage:** Formulas stored in URL (for sharing) or in a separate `formulas` config array (for LLM-generated dashboards).

5. **This layer is documented as an extension point only. No implementation required in this phase.**

## D. Table Header Filters

### Schema

New slot on the `table` type:

```js
{ name: "filters", accepts: "dimension", required: false, array: true }
```

Config example:

```json
{
  "chart": "table", "columns": ["car_class", "region", "poi_name", "count"],
  "filters": ["activity_type", "fuel_type"]
}
```

Filter dimensions do not need to be in the `columns` array. They are scoping filters placed in the header, not display columns. They should be low-cardinality dimensions.

### Prerequisite: Table Multi-Column Data

The current table rendering (`dashboard-engine.js` ~line 2021) is minimal — it only renders `entry.key` (first dimension) and `entry.value.value` (count). Before filters and sparklines can work, the table rendering must be enhanced to support multiple measure columns from the group data. This requires:

1. `scanPanels` registers multiple metrics on the table group (one per measure in `columns`)
2. The renderer reads each metric from `entry.value.m_<measureName>` instead of just `entry.value.value`
3. Non-first dimension columns read from the crossfilter's raw row data or from a split group

This prerequisite work is included in the implementation scope.

### Engine Behavior

1. **`scanPanels`:** Filter dimensions are added to `groupByDims` so the crossfilter worker has them available for client-side filtering. They are included in the Cube query dimensions.

2. **`buildPanelCard`:** When `panel.filters` exists, render native `<select>` elements in the `.card-head` row, right-aligned after the panel title. CSS matches the stockout demo pattern:
   - `.filter-select`: 12px font, `max-width: 160px`, white bg, 1px border, 3px padding
   - `.card-filters`: flex row, `gap: 6px`, `align-items: center`

3. **Select population:** On each render, count occurrences of each filter dimension value in the current group data. Build options sorted descending by count: `<option value="Gasoline">Gasoline (142)</option>`. First option: `"All {label} ({total})"`.

4. **Filtering:** On `<select>` change, filter the table entries client-side (hide rows where the dimension doesn't match). Multiple filters combine with AND logic. Count badge updates. Previous select values are preserved across re-renders.

5. **Single-select only.** Each dropdown allows one value or "All".

## E. Table Sparklines

### Schema

New slot on the `table` type:

```js
{ name: "sparklines", accepts: "measure", required: false, array: true }
```

Config example:

```json
{
  "chart": "table",
  "columns": ["car_class", "region", "count", "unique_bookings"],
  "sparklines": ["count"]
}
```

Any measure listed in both `columns` and `sparklines` renders as a mini line chart instead of a plain number.

### Engine Behavior

1. **`scanPanels`:** When `panel.sparklines` is set, the cube's `time_dimension` (from `registry._cubeMeta.time_dimension`) is added as a hidden group-by dimension on the table's group. The Cube query returns data at the grain of `[first_table_dim, time_dim]` instead of just `[first_table_dim]`.

2. **Data partitioning:** The engine receives entries keyed by `[row_key, timestamp]`. Before rendering, it partitions the data: for each unique row key, collect the time-series values for each sparkline measure.

3. **Cell rendering:** Sparkline columns render as inline ECharts instances:
   - Size: ~120x24px
   - No axes, no labels, no grid — just the line shape
   - Minimal config: `animation: false`, transparent background
   - Color matches the measure's theme color or default accent blue

4. **Instance management:** Sparkline ECharts instances are created on first render and cached by `row_key + measure_name`. On re-render, they update via `setOption` (no re-init). On panel dispose, all instances are disposed.

5. **Time axis:** Implicit from `registry._cubeMeta.time_dimension`. No config needed. The granularity matches the dashboard's active granularity (from `_granularity` URL state or model default).

6. **Extensibility:** The architecture of adding hidden group-by dimensions to the table query leaves room for future enhancements (e.g., hidden dimensions for row-level detail expansion).

### Data Flow Detail

The crossfilter worker's group API uses simple keys (not composite). Rather than creating a `[row_key, timestamp]` composite key group, the sparkline data uses the existing table group's `splitField` mechanism:

1. `scanPanels` creates the table group with `field: first_table_dim` and `splitField: time_dimension`
2. The group returns entries as: `{ key: "car_class_value", value: { timestamp1: { value: 5 }, timestamp2: { value: 3 } } }`
3. The renderer iterates the split keys (timestamps) to build the sparkline series per row

This avoids composite keys entirely — it uses the same split data structure that stacked bar charts and comparison line charts already use.

### Table Filter Data Access

Filter dimensions (e.g., `activity_type`, `fuel_type`) are NOT the table's group key — the table is grouped by `first_table_dim`. The filter dimension values per row are not available in the group entries (which only contain `{ key, value: { metrics } }`).

**Solution:** Use the crossfilter worker's `rows` API to fetch raw column data for the filter dimensions. The `query()` call already supports a `rows` parameter (used by the stockout demo):

```js
workerHandle.query({
  filters: filters,
  snapshot: { groups: groupQueries },
  rows: {
    fields: panel.filters,  // ['activity_type', 'fuel_type']
    limit: 50000,
    columnar: true,
  },
});
```

This returns `{ rows: { columns: { activity_type: [...], fuel_type: [...] } } }` alongside the group snapshot. The table renderer uses the columnar arrays to:

1. **Populate filter selects:** Count unique values across all rows (like the stockout demo's `populateSelects`)
2. **Filter table rows:** Match each group entry's position against the columnar filter arrays

The `rows` request adds minimal overhead — it returns only the requested columns, not all data. Filter dimensions are already in `groupByDims` so the worker has indexed them.

**Alternative (simpler but less flexible):** Add filter dimensions as `splitField` on the table group. This embeds filter values into the group entries as nested keys. However, the group API only supports a single `splitField`, which is already used by sparklines for the time dimension. The `rows` approach avoids this conflict and supports any number of filter dimensions.

**When both `sparklines` and `filters` are present on the same table panel:** The `splitField` is used for sparkline time data, and the `rows` API is used for filter dimension data. These are independent mechanisms that coexist without conflict.

**Required change to `mergeResponses`:** The current `mergeResponses` function (dashboard-data.js) only extracts `snapshot.kpis` and `snapshot.groups` — `rows` data is silently discarded. The `query()` method and `mergeResponses` must be updated to pass through `rows` data from the worker response. The merged result becomes `{ kpis: {}, groups: {}, rows: {} }`.

### Sparkline Instance Lifecycle

Since the table re-renders via `innerHTML` replacement, all ECharts instances on old DOM nodes are orphaned. On each render cycle:

1. Dispose all previously tracked sparkline instances for this panel
2. Render new table HTML
3. Create fresh ECharts instances on the new DOM nodes
4. Track the new instances for next disposal cycle

This is simpler than incremental DOM updates and acceptable given tables typically have <100 rows with at most 1-2 sparkline columns.

### Edge Cases

- **`sparklines` references a measure not in `columns`:** Ignored — only measures present in both arrays get sparkline treatment.
- **Cube has no `time_dimension`:** Sparklines are silently disabled — measures render as plain numbers.
- **`filters` dimension has all null values:** The select shows only "All (N)" — no value options.
- **`metrics` array is empty or contains only `y`:** Metric switcher is not rendered — behaves as a normal line chart.
- **`compare` + `metrics` interaction:** When the user switches the metric via the dropdown while comparison lines are active, each comparison line switches to the new metric. The split structure is the same — only the selected metric entry changes.

## System Prompt Updates

### Auto-generated sections (no manual changes)

The chart type catalog in `buildChartTypeCatalog()` is auto-generated from `chart-types.js` slot definitions. Adding the 4 new slots automatically updates the catalog output.

### Manual additions to `prompts/generator-system.md`

**Under "Time series:" in Chart Type Selection:**

> - Use `compare` to split a time series by a low-cardinality dimension — each value becomes a separate line. Top 5 shown by default. Only use with dimensions that have <20 unique values (those with color_map are ideal). Do not use compare with high-cardinality dimensions.
> - Use `metrics` to list alternative Y-axis measures the user can switch between. `y` is the default; `metrics` lists alternatives. All metrics are loaded — switching is instant. Labels come from the cube measure descriptions.

**New subsection "Table Options" under Chart Type Selection:**

> - Use `filters` on a table panel to add single-select dropdown filters in the table header. Use low-cardinality dimensions (those with color_map or <20 values). Filter dimensions do not need to be in the columns array — they scope the table data without being displayed as columns.
> - Use `sparklines` to render measure columns as inline mini trend charts instead of plain numbers. Requires the cube to have a `time_dimension` in its metadata. Only list measures that are also in the `columns` array.

**Under "Lazy Sections":**

> - `compare` and `filters` dimensions are loaded into the main crossfilter query — they must be low-cardinality (safe for main query).
> - `sparklines` adds the time dimension to the table group, increasing data volume by a factor of time buckets. This is bounded and acceptable for tables with <100 rows and standard granularities.

## Demo Dashboard Config

Update `bluecar-stays.json` to showcase all features:

**Timeline panel (B + C):**
```json
{
  "chart": "line", "label": "Stays Over Time", "width": "full",
  "x": "stay_started_at", "y": "count",
  "compare": "activity_type",
  "metrics": ["count", "unique_bookings", "unique_cars"]
}
```

`activity_type` has 6 values with a color_map — ideal for comparison. Metrics let the user switch between total stays, unique bookings, and unique vehicles.

**Details table (D + E) — new section:**
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

## Schema Budget Impact

| Metric | Before | After | Limit |
|---|---|---|---|
| Properties | ~180 | ~200 | 5000 |
| Enum values | ~280 | ~280 | 1000 |
| Object depth | 4 | 4 | 5 |

All well within OpenAI structured output limits.

## Files Modified

| File | Changes |
|---|---|
| `demo/chart-types.js` | Add 4 slots to line family + table type |
| `demo/schema/dashboard-schema-base.js` | No changes (auto-generates from slots) |
| `demo/schema/generate-schema.js` | No changes (auto-generates from slots) |
| `demo/dashboard-engine.js` | Comparison rendering, metric switcher UI, metric dropdown, table filter selects, sparkline rendering |
| `demo/dashboard-data.js` | Compare splitField + `_compareDim`, multi-metric group registration (eager all-measures), table filter dims, sparkline time dim, `mergeResponses` + `query()` pass through `rows` data |
| `demo/dashboard-meta.js` | No changes |
| `demo/demo.css` | Metric picker styles (reuse viz-picker), filter-select styles, sparkline cell styles |
| `demo/prompts/generator-system.md` | Guidance for compare, metrics, filters, sparklines |
| `demo/dashboards/bluecar-stays.json` | Demo config using all features |
