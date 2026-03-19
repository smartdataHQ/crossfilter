# Metadata-Driven Dashboard Engine — Design Spec

## Overview

A generic, config-driven dashboard engine that renders interactive crossfilter-powered dashboards from a declarative config. The config maps Cube.dev model metadata to ECharts visualizations and crossfilter dimensions. Both the available data (Cube `/api/meta`) and the available chart types (ECharts runtime) are discovered on demand — nothing is hardcoded.

**End goal**: An LLM agent accepts a natural language dashboard request, selects the right Cube, and generates a config that this engine renders. The config schema is the structured output contract between the agent and the engine.

## Design Principles

1. **Zero hardcoding** — The engine NEVER references specific field names, labels, segments, or domain-specific content. Everything comes from the config and the Cube metadata. The engine must work for ANY cube without code changes.
2. **Minimal config** — A valid config is just `{ cube, panels }`. Everything else has sensible defaults inferred from metadata.
3. **Enum-based** — Constrained fields use enums so LLM structured output can't go off-rails.
4. **Declarative** — Config describes *what* to show, not *how* to render. The engine decides rendering.
5. **On-demand discovery** — Cube metadata fetched at runtime, ECharts types introspected at runtime. No hardcoded lists.
6. **Override anything** — Every inferred default is overridable in the config.
7. **Multi-worker** — Supports multiple crossfilter workers with automatic dimension budgeting and cross-worker filter propagation.
8. **Custom-made feel** — Dynamically generated dashboards should look and feel as if they were hand-crafted for the specific dataset. The engine uses metadata intelligence (descriptions, segments, value distributions, measure formats) to make informed presentation choices.

## Model Intelligence Bar

The dashboard surfaces the cube's built-in analytical intelligence as a top-level UI element, rendered directly below the header. This is auto-generated from metadata — the config can customize it but never needs to.

### What it surfaces

The engine inspects the Cube metadata and discovers:

1. **Segments** — Pre-defined data slices baked into the model (e.g., "POI Stops Only", "Weekday Only", "Long Stops"). These are server-side filters that the Cube model defines. Rendered as toggleable pills. Clicking one applies it as a Cube query filter, not a crossfilter dimension.

2. **Preset filters** — Boolean dimensions discovered from metadata (`field_type: "boolean"`). Grouped intelligently by inspecting field names for common prefixes or by proximity in the dimension list. Rendered as toggle pills.

3. **Dimension facets** — Low-cardinality string dimensions with `lc_values` in metadata (unique_values ≤ ~12). These are known enum values the model is aware of. Rendered as selectable pill groups.

4. **Cube identity** — The cube's `title` and `description` from metadata, plus dimension/measure counts, giving the user context about what data they're exploring.

### How it works

The engine classifies metadata fields into three presentation tiers:

| Metadata signal | Tier | Rendering |
|---|---|---|
| `segments` array | Segment pills | Toggle pills that apply server-side Cube segment filters |
| `field_type: "boolean"` | Quick toggles | On/off pills grouped by metadata proximity |
| `lc_values` present + `unique_values ≤ 12` | Facet pills | Multi-select pill groups with known values |
| `description` on cube | Context | Subtitle/tooltip on dashboard header |

### Config override

The config can customize which metadata features appear in the model bar:

```js
{
  modelBar: {
    segments: true,           // show segment pills (default: true if segments exist)
    presets: true,            // show boolean dimension toggles (default: true)
    facets: ['stay_type', 'activity_type'],  // explicit facet dimensions (default: auto-discovered)
    showDescription: true,    // show cube description (default: true)
  }
}
```

When `modelBar` is omitted, the engine auto-discovers everything from metadata. Setting `modelBar: false` hides it entirely.

### Interaction with crossfilter

- **Segments**: Applied as Cube query filters (server-side). Toggling a segment re-fetches data from the Cube API with the segment applied, then rebuilds crossfilter.
- **Boolean toggles**: Applied as crossfilter `filterExact(true)` / `filterExact(false)` / `filterAll()`.
- **Facet pills**: Applied as crossfilter `filterIn([...selectedValues])`.
- All model bar filters coordinate with panel filters through the same filter state.

## Architecture — Three Layers

### Layer 1: Schema (data wiring)

Declares which Cube to query, how to partition, and optionally how to split dimensions across crossfilter workers.

```js
{
  cube: "bluecar_stays",           // required — Cube model name
  partition: "bluecar.is",         // required — tenant/dataset partition value
                                   // applied as server-side filter: { member: "cube.partition", operator: "equals", values: [partition] }
  title: "Iceland Rental Stays",   // optional — dashboard title

  // Optional: explicit worker definitions. If omitted, engine auto-allocates.
  workers: [
    {
      id: "cf-main",               // worker identifier
      dimensions: [                 // explicit dimension list (≤32)
        "car_class", "region", "activity_type", "poi_category",
        "fuel_type", "stay_type", "customer_country", "stay_dow",
        "has_poi_match", "drive_type", "division", "municipality"
      ]
    },
    {
      id: "cf-geo",
      dimensions: ["locality", "postal_code", "street", "poi_name", "poi_subcategory"]
    }
  ],

  // Optional: dimensions filtered server-side only (not loaded into crossfilter)
  serverDimensions: ["booking"]
}
```

**Auto-allocation**: When `workers` is omitted, the engine collects all dimensions referenced by `panels`, groups them by affinity (co-filtered dimensions on the same worker), and splits across workers to stay within the 32-dimension budget.

### Layer 2: Panels (visualization config)

Array of panel declarations. Each panel maps a dimension or measure to a visualization.

#### Minimal panel

```js
{ dimension: "activity_type" }
```

The engine infers chart type, label, filter mode, sort, and limit from the Cube metadata for that dimension.

#### Full panel (all fields shown — every field except the first is optional)

```js
{
  // Data binding — one of dimension or measure (neither required for "table" panels)
  dimension: "car_class",          // Cube dimension short name
  // OR
  measure: "avg_stay_duration_hours",  // Cube measure short name

  // Visualization
  chart: "bar",                    // enum — see Chart Types below
  label: "Vehicle Class",          // display label (default: metadata description or field name)
  limit: 10,                       // top-N items to show (default: inferred from unique_values)
  sort: "value",                   // enum: "value" | "key" | "alphabetical"

  // Filtering
  filter: "in",                    // enum: "in" | "exact" | "range" | "none" | "server"

  // Time-specific (for datetime dimensions)
  granularity: "day",              // enum: "minute" | "hour" | "day" | "week" | "month"

  // Aggregation — controls what value each group entry shows
  op: "count",                     // enum: "count" | "sum" | "avg" | "min" | "max"
                                   // default: "count" for dimension panels
  field: "stay_duration_hours",    // which measure field to aggregate when op is sum/avg/min/max
                                   // e.g. { dimension: "car_class", op: "avg", field: "stay_duration_hours" }
                                   // → bar chart where each bar shows avg stay duration per car class

  // Table-specific (only for chart: "table")
  columns: ["car_class", "region", "stay_duration_hours", "poi_name"],  // which fields to show as columns

  // Layout hints
  section: "vehicles",             // group panels into named sections
  width: "full",                   // enum: "full" | "half" | "third" | "quarter"
  collapsed: false,                // start panel content collapsed (independent of section collapsed)
  searchable: true,                // add search input (default: inferred from unique_values > 50)

  // Worker assignment
  worker: "cf-main"                // explicit worker (default: auto-allocated)
}
```

#### Chart type inference from metadata

The engine selects the default chart type based on Cube metadata annotations:

| `field_type` | `unique_values` | Default chart | Rationale |
|---|---|---|---|
| `string` | ≤ 7 | `"pie"` | Very few categories — pie/donut works well |
| `string` | 8–50 | `"bar"` | Moderate cardinality — horizontal bars with counts |
| `string` | 51–500 | `"bar"` + searchable | Bar chart with search input |
| `string` | > 500 | `"list"` | Too many for a chart — searchable list only |
| `boolean` | 2 | `"toggle"` | On/off pill toggle |
| `number` | continuous | `"range"` | Range slider filter |
| `datetime` | — | `"line"` | Time series with granularity toggle |
| measure (single value) | — | `"kpi"` | KPI card with formatted value |

These defaults are always overridable via the `chart` field.

### Layer 3: Layout (arrangement)

Optional. Controls how panels are arranged on screen. If omitted, the engine uses a default layout algorithm.

```js
{
  layout: {
    // Section ordering and display
    sections: [
      { id: "kpis", label: "Key Metrics", columns: 4 },
      { id: "timeline", label: "Timeline", columns: 1 },
      { id: "overview", label: "Overview", columns: 3 },
      { id: "vehicles", label: "Vehicles", columns: 3, collapsed: false },
      { id: "geography", label: "Geography", columns: 2, collapsed: true },
      { id: "table", label: "Details", columns: 1 }
    ]
  }
}
```

**Default layout algorithm** (when `layout` is omitted):
1. KPI panels → top row, 4-column grid
2. Time series panels → full-width below KPIs
3. Remaining panels ordered by cardinality (low first), arranged in 3-column grid
4. Lists and high-cardinality panels → collapsed section
5. Data table → bottom

## Enum Reference

All enum fields — these constrain LLM structured output:

| Field | Enum values |
|---|---|
| `chart` | Discovered from ECharts at runtime (`"line"`, `"bar"`, `"pie"`, `"scatter"`, `"radar"`, `"treemap"`, `"heatmap"`, `"gauge"`, `"funnel"`, `"sunburst"`, `"boxplot"`, `"sankey"`, ...) plus non-chart controls: `"list"`, `"kpi"`, `"toggle"`, `"range"`, `"table"` |
| `filter` | `"in"` (multi-select, default for bar/list/pie), `"exact"` (single-select), `"range"` (min/max), `"none"` (display only), `"server"` (Cube query filter, not crossfilter) |
| `op` | `"count"` (default), `"sum"`, `"avg"`, `"min"`, `"max"` |
| `sort` | `"value"` (by aggregate, descending — default), `"key"` (by dimension value), `"alphabetical"` (A-Z) |
| `granularity` | `"minute"`, `"hour"`, `"day"`, `"week"`, `"month"` |
| `width` | `"full"`, `"half"`, `"third"`, `"quarter"` |

The `chart` enum is validated at runtime by checking the loaded ECharts instance for registered series types. Non-chart controls (`"list"`, `"kpi"`, `"toggle"`, `"range"`, `"table"`) are handled by the engine directly.

## Multi-Worker Filter Coordination

### Worker allocation

Each crossfilter worker supports up to 32 dimensions. When the config declares more dimensions than one worker can hold:

1. **Explicit**: Config declares `workers` array with dimension lists.
2. **Auto**: Engine groups dimensions by co-occurrence in panels (dimensions in the same section tend to be filtered together) and splits across workers.

### Filter propagation

All workers share a single `filters` state object. When a user clicks a bar in a chart:

1. `filters[dimension]` is updated
2. Engine calls `buildFiltersForWorker(workerId)` — sends only filters for dimensions that worker owns
3. Each worker applies its subset, returns filtered snapshot
4. Engine merges snapshots and re-renders all panels

This is the same pattern used in `demo-stockout/filter-router.js`.

### Server-side dimensions

Dimensions listed in `serverDimensions` are filtered by modifying the Cube query (adding a `filters` clause) and re-fetching. This is for very high-cardinality dimensions (e.g., `booking` with unique IDs) that shouldn't consume a client-side crossfilter slot.

## Measure Panel Data Flow

Measure panels (`chart: "kpi"`) need reactive values that update when crossfilter filters change.

**Approach**: The engine creates a crossfilter `groupAll()` with a custom reduce function for each measure panel. When any filter changes, the `groupAll` recomputes automatically via crossfilter's incremental reduce system.

- `op: "count"` → `groupAll().reduceCount()`
- `op: "sum"` → `groupAll().reduceSum(accessor)`
- `op: "avg"` → custom reduce: tracks sum + count, `.value()` returns sum/count
- `op: "min"` / `op: "max"` → custom reduce with running min/max

Measures that come pre-aggregated from the Cube query (e.g., `avg_availability`) use the field value directly. The engine detects this by checking whether the field appears in the Cube query's `measures` array (server-computed) vs `dimensions` array (raw values).

**Format inference**: The engine infers display formatting from the measure metadata:
- `format: "percent"` → show as "94.2%"
- Field name containing `_hours` → show as "2.4h"
- Field name containing `_isk` or `_sales` → show as "4.9K ISK" (currency)
- Otherwise → abbreviated number ("1.99M", "381K")

## Validation Behavior

When the config references a dimension or measure not found in the Cube metadata:
- The panel is **skipped** (not rendered) and a warning is logged to the console
- The engine does not throw — partial configs should degrade gracefully
- This is important for LLM-generated configs where the agent may reference fields that were renamed or removed

When the config specifies a `chart` type not registered in ECharts and not a built-in control:
- The panel renders a placeholder card with the chart type name and a "unsupported" message
- This allows future chart types to be visible as intent even before implementation

## Runtime Discovery

### Cube metadata (on-demand)

At startup, the engine fetches `GET /api/meta` and builds an internal registry:

```js
{
  dimensions: {
    "car_class": { type: "string", unique_values: 41, lc_values: [...], description: "..." },
    "stay_started_at": { type: "time", field_type: "datetime", min_value: "...", max_value: "..." },
    ...
  },
  measures: {
    "count": { type: "number" },
    "avg_stay_duration_hours": { type: "number" },
    ...
  },
  segments: ["poi_stops_only", "non_poi_stops_only", ...]
}
```

This registry is used for:
- Chart type inference (field_type + unique_values)
- Label generation (description field)
- Validation (does the config reference dimensions/measures that exist?)
- Color assignment (color_map / color_scale if present)

### ECharts types (on-demand)

At startup, the engine introspects the loaded ECharts instance to discover available series types. This list is used to validate `chart` enum values in the config and to provide the LLM agent with the current vocabulary.

## Example Config — bluecar_stays Test Fixture

This exercises all component types:

```js
var BLUECAR_STAYS_CONFIG = {
  cube: "bluecar_stays",
  partition: "bluecar.is",
  title: "Iceland Rental Car Stays",

  panels: [
    // KPIs
    { measure: "count", label: "Total Stays", chart: "kpi", section: "kpis" },
    { measure: "unique_bookings", label: "Bookings", chart: "kpi", section: "kpis" },
    { measure: "unique_cars", label: "Vehicles", chart: "kpi", section: "kpis" },
    { measure: "poi_match_rate", label: "POI Match Rate", chart: "kpi", section: "kpis" },

    // Time series
    { dimension: "stay_started_at", chart: "line", granularity: "day", section: "timeline", width: "full" },

    // Categorical charts
    { dimension: "activity_type", section: "overview" },
    { dimension: "car_class", limit: 12, section: "overview" },
    { dimension: "region", section: "overview" },

    // Vehicle details
    { dimension: "vehicle_make", section: "vehicles" },
    { dimension: "fuel_type", chart: "pie", section: "vehicles" },
    { dimension: "drive_type", chart: "pie", section: "vehicles" },

    // Geography (searchable lists)
    { dimension: "municipality", chart: "list", section: "geography" },
    { dimension: "locality", chart: "list", section: "geography" },
    { dimension: "poi_name", chart: "list", section: "geography" },
    { dimension: "poi_category", section: "geography" },

    // Boolean toggles
    { dimension: "has_poi_match", chart: "toggle", section: "filters" },
    { dimension: "is_first_stay", chart: "toggle", section: "filters" },

    // Numeric range
    { dimension: "stay_duration_hours", chart: "range", section: "filters" },

    // Data table — no dimension/measure required; shows all filtered rows
    { chart: "table", section: "details", width: "full",
      columns: ["car_class", "region", "activity_type", "poi_name", "stay_duration_hours", "stay_started_at"] }
  ],

  layout: {
    sections: [
      { id: "kpis", columns: 4 },
      { id: "timeline", columns: 1 },
      { id: "overview", label: "Overview", columns: 3 },
      { id: "vehicles", label: "Vehicles", columns: 3 },
      { id: "geography", label: "Geography", columns: 2, collapsed: true },
      { id: "filters", label: "Filters", columns: 4 },
      { id: "details", label: "Details", columns: 1 }
    ]
  }
};
```

## Component Rendering Contract

Each panel `chart` type maps to a render function. The engine provides each renderer with:

```js
{
  container: HTMLElement,          // DOM element to render into
  data: [{ key, value }],         // crossfilter group.all() output
  meta: { ... },                  // Cube metadata for this dimension/measure
  config: { ... },                // panel config from dashboard config
  theme: { ... },                 // ECharts theme tokens
  onFilter: function(value) {}    // callback to apply filter
}
```

Renderers are registered by chart type. ECharts-based renderers create/update an ECharts instance. Non-chart renderers (list, toggle, range, kpi, table) render DOM directly using the existing stockout CSS design system.

### Component Inventory

Derived from examining both existing demos. These are the concrete UI components the engine must support:

#### Standard demo baseline (primary layout reference)

| Component | Config `chart` | Description |
|---|---|---|
| **Header bar** | (engine chrome) | Title, subtitle, source badge, active filter chips (removable), "Clear All" button, settings gear |
| **KPI cards** | `"kpi"` | Colored top-border bar (cycles through accent palette), label, large formatted number. 4-column grid. |
| **Time series** | `"line"` | Full-width line chart with area gradient fill, granularity toggle buttons (minute/hour/day/week/month), ECharts dataZoom slider, click-to-filter by time bucket |
| **Horizontal bar chart** | `"bar"` | Ranked bars with count labels, cardinality badge, "List" toggle button to switch to searchable list mode. Click bar to toggle filter. Dynamic height based on item count. |
| **Searchable dimension list** | `"list"` | Scrollable list items with count bar + abbreviated count, search input (120ms debounce), infinite scroll pagination (80 items/page), click to toggle filter |
| **Collapsible section** | (layout) | Section header with "Expand to browse" link, collapses/expands child panels |
| **Data table** | `"table"` | Sticky header, sortable columns, source badge, row count, infinite scroll (50 rows/page), click row to filter |
| **Filter chips** | (engine chrome) | Active filters shown as removable pills in header area |

#### Stockout demo components (additional types to support)

| Component | Config `chart` | Description |
|---|---|---|
| **Pie/donut chart** | `"pie"` | Category breakdown with click-to-filter, single-select mode |
| **Multi-series line chart** | `"line"` (with config) | Peer comparison with multiple colored overlay lines, band shading (best/worst) |
| **Sortable data table with badges** | `"table"` (with config) | Colored status badges, trend arrows, column-specific formatting |
| **Forecast cards** | `"kpi"` (with config) | Top-N cards showing probability %, risk indicators |
| **DOW pattern bar chart** | `"bar"` (with config) | Color-coded bars by value range (uses color_scale from metadata), badges below chart |
| **Boolean toggle pills** | `"toggle"` | On/off pill buttons for boolean dimensions |
| **Numeric range** | `"range"` | Range slider for continuous numeric dimensions |

#### ECharts series types (available via runtime introspection)

ECharts 6.0.0 provides 23 series types. The engine validates `chart` values against the loaded instance. Currently used in demos: `line`, `bar`, `pie`. All others are available for future configs without engine changes.

## Visual Design

Reuses the stockout design system already in `demo/demo.css`:
- Glassmorphic cards with backdrop blur (`rgba(252, 254, 255, 0.4)` + `blur(10px)`)
- 5-accent color palette: green (`#00c978`), blue (`#3d8bfd`), amber (`#f5a623`), red (`#ef4565`), purple (`#9b59b6`)
- Typography: Lato (300/400/700/900) for text, JetBrains Mono for numbers/timestamps
- Responsive grid with CSS custom properties (`--radius: 8px`, `--shadow`, etc.)
- Staggered fade-in animations (0.4s with d1–d8 delay classes)
- Color tokens: `--bg-primary`, `--text-primary`, `--text-secondary`, `--text-muted`, `--accent-*`, `--accent-*-dim`

## File Structure

```
demo/
├── index.html                    # existing — will load engine
├── demo.css                      # existing — stockout design system
├── echarts-theme.js              # existing — ECharts theme
├── dashboard-engine.js           # NEW — core engine (config → DOM)
├── dashboard-config.js           # NEW — bluecar_stays test config
├── dashboard-meta.js             # NEW — Cube meta fetcher + inference logic
├── dashboard-renderers.js        # NEW — chart type renderers
├── fetch-cube-meta.mjs           # existing — CLI utility
├── proxy-server.mjs              # existing — dev server with /api/meta
└── source-utils.js               # existing — data loading utilities
```

## What This Spec Does NOT Cover (Yet)

- LLM agent config generation flow
- Array/map dimension support (semantic_events cube)
- Geographic map visualizations
- Real-time streaming updates
- Dashboard persistence / sharing
- Multi-cube joins in a single dashboard
