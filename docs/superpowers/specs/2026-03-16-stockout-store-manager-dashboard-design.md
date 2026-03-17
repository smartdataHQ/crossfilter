# Store Manager Stockout Dashboard — Design Spec

## Purpose

A multi-crossfilter dashboard for store managers at Ís Bónus (Icelandic grocery chain) to monitor product stockout risk, availability trends, and 3-day forecasts for their store. Built as a demo of the crossfilter2 multi-crossfilter coordination architecture where unified filters are dispatched across multiple worker runtimes backed by different Cube.dev cubes.

## Data Source

- **Synmetrix/Cube.dev API**: `https://dbx.fraios.dev/api/v1/load` and `/api/v1/meta`
- **Datasource ID**: `977c3d36-b1b2-47bb-a854-b2c9f2f93fef`
- **Branch ID**: `f553ff44-1c23-47df-b771-44c526d81fe7`
- **Partition**: `bonus.is` (always filtered server-side, single tenant)
- **Auth**: Bearer token + `x-hasura-datasource-id` + `x-hasura-branch-id` headers via proxy

## Cubes Used (5 of 6)

| Cube | Title | Role in Dashboard |
|------|-------|-------------------|
| `stockout_store_dashboard` | Store Stockout Dashboard | KPIs, category breakdown, stocked-out table, forecast table, risk chart |
| `stockout_availability_trend` | Essential Products Availability Trend | Monthly availability trend line chart |
| `stockout_early_warning` | Stockout Early Warning | Worsening products table |
| `stockout_dow_analysis` | Stockout Day-of-Week Analysis | DOW stockout pattern chart |
| `is_bonus_stockout_analysis` | Stockout Analysis | Data quality indicator (signal_quality) |

The 6th cube (`is_bonus_stockout_availability`) is not used directly — `stockout_availability_trend` covers the same time-series need with a simpler schema.

## URL-Driven State

The URL hash is the single source of truth. No localStorage, no session state.

### Hash Schema

```
#store=Hagkaup+Skeifan&category=Dairy&supplier=MS+Iceland
```

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `store` | Yes | string | `sold_location` value. No store = show store picker. |
| `category` | No | string (comma-separated) | `product_category` filter |
| `subcategory` | No | string (comma-separated) | `product_sub_category` filter |
| `supplier` | No | string (comma-separated) | `supplier` filter |
| `product` | No | string (comma-separated) | `product` filter |
| `risk` | No | string (comma-separated) | `risk_tier` filter (Critical, High, Medium, Low) |
| `active` | No | `true` or `false` | `is_currently_active` filter |

All filter values are URL-encoded. Multiple values use comma separation: `category=Dairy,Bakery`. Hash changes trigger a full filter-dispatch cycle. Browser back/forward works.

All URL filters are always dispatched as `filterIn` (even single values) for consistency.

## Architecture

### File Structure

```
demo-stockout/
  index.html              — HTML shell, script tags for ECharts + crossfilter
  app.js                  — Entry point: startup, store picker, orchestration
  router.js               — URL hash ↔ filter state (parse, serialize, listen)
  filter-router.js        — Dispatches unified filters to N crossfilter workers
  cube-registry.js        — Meta-driven cube config, Cube query builders
  proxy-server.mjs        — Dev server proxying /api/cube and /api/meta
  panels/
    kpis.js               — 6 KPI cards
    trend.js              — Monthly availability trend (line chart)
    category.js           — By-category breakdown (horizontal bar)
    stockout-table.js     — Currently stocked out products (table)
    forecast.js           — 3-day forecast / at-risk products (cards + table)
    risk-chart.js         — Top 10 risk products (horizontal bar)
    early-warning.js      — Worsening products (table)
    dow-pattern.js        — Day-of-week pattern (bar chart)
  theme.js                — ECharts dark theme registration
  styles.css              — Dark theme CSS (matching existing design system)
```

### Core Modules

**`router.js`** — Parses and serializes the URL hash. Exposes:
- `getState()` → `{ store, category, supplier, ... }`
- `setState(patch)` → merges into hash, triggers `hashchange`
- `onStateChange(callback)` → registers listener
- All values are strings or null. No objects, no nesting.

**`filter-router.js`** — The coordination layer. Holds a registry of crossfilter runtimes and their loaded dimensions (from cube-registry). When `router.onStateChange` fires:
1. Diff old vs new filter state
2. For each runtime, build the dashboard-API-style filter object from the URL state, mapping URL params to Cube dimension names (e.g., `category` → `product_category`)
3. If all changed dimensions exist in the runtime → `runtime.updateFilters(filters)` (client-side, fast)
4. If a changed dimension is NOT loaded in a runtime → dispose that runtime + recreate it with new server-side filters baked into the Cube query. Show a loading indicator for the affected panels during the gap. This is rare for this dashboard since filter dimensions are loaded in all runtimes, but the infrastructure must support it for future dashboards.
5. After filter dispatch, re-query each runtime for its panels' data
6. Call panel render callbacks

**`cube-registry.js`** — Fetches `/api/v1/meta` on startup. Builds a config map:
- Per-cube: Cube query definition (dimensions, measures, filters, timeDimensions), crossfilter worker config (which fields become crossfilter dimensions, which become KPIs, which become groups)
- Cube query builder: given a cube config + extra server-side filters, produce the Cube.dev JSON query body for `/api/v1/load`
- `partition` and `sold_location` (the selected store) are always server-side filters in every Cube query — they are NOT loaded as crossfilter dimensions (saves 2 dimension slots per runtime)

**`app.js`** — Entry point:
1. Parse URL hash
2. If no `store` → fetch store list from `stockout_store_dashboard` (Cube query: dimensions `[sold_location]`, measures `[count]`, filter `partition=bonus.is`) → render store picker grid → user picks → hash updates → restart
3. Fetch `/api/v1/meta` → build cube registry
4. Create 5 crossfilter workers in parallel via `createStreamingDashboardWorker`
5. Wire up filter-router → panels
6. Progressive render as each worker becomes ready

### How Cube.dev Measures Map to Crossfilter

Cube.dev "measures" (like `avg_availability`, `sum_active`) are **pre-computed server-side aggregates** that arrive as column values in the Arrow response — one value per row. They are NOT computed by crossfilter.

For this dashboard, the Cube queries request measures alongside dimensions, producing one row per unique combination of dimension values. Each row has the pre-computed measure values as columns.

In the crossfilter worker:
- **Dimensions** (for filtering/grouping): fields used as crossfilter dimensions via the `dimensions` config
- **KPIs**: `{ id, field, op }` specs that compute aggregates from column values. For example, `{ id: 'totalActive', field: 'sum_active', op: 'sum' }` sums the per-row `sum_active` values across all rows matching the current filter. This is correct because `sum_active` is an additive measure (it counts active stockouts per product-store row).
- **Groups**: `{ id, field, metrics }` specs that group by a dimension and compute metrics per group
- **Row fields**: columns included in `rows()` query results for table display

**Aggregation correctness note**: Additive measures (`sum`, `count`) can be re-aggregated client-side safely. Non-additive measures (`avg`, `max`, `min`) cannot be naively re-aggregated. For `avg_availability` (a per-row average), the KPI uses `op: 'avg'` which averages the per-row values — this gives an unweighted average across product-store combinations, which is the intended "store availability" metric.

### Crossfilter Worker Configuration

Each crossfilter loads a specific subset of fields. `partition` and `sold_location` are always server-side filters, never crossfilter dimensions.

**cf-store** (`stockout_store_dashboard`):

Cube.dev query:
```json
{
  "dimensions": [
    "stockout_store_dashboard.product",
    "stockout_store_dashboard.product_category",
    "stockout_store_dashboard.product_sub_category",
    "stockout_store_dashboard.supplier",
    "stockout_store_dashboard.is_currently_active",
    "stockout_store_dashboard.risk_tier",
    "stockout_store_dashboard.risk_score",
    "stockout_store_dashboard.forecast_stockout_probability",
    "stockout_store_dashboard.trend_signal",
    "stockout_store_dashboard.forecast_warning",
    "stockout_store_dashboard.forecast_daily_prob",
    "stockout_store_dashboard.forecast_day_names",
    "stockout_store_dashboard.avg_duration_days",
    "stockout_store_dashboard.total_expected_lost_sales",
    "stockout_store_dashboard.days_since_last",
    "stockout_store_dashboard.stockouts_per_month",
    "stockout_store_dashboard.highest_risk_day",
    "stockout_store_dashboard.signal_quality"
  ],
  "measures": [
    "stockout_store_dashboard.avg_availability",
    "stockout_store_dashboard.sum_active",
    "stockout_store_dashboard.worsening_count",
    "stockout_store_dashboard.sum_confirmed_stockouts",
    "stockout_store_dashboard.sum_suspect_stockouts",
    "stockout_store_dashboard.sum_expected_lost_sales",
    "stockout_store_dashboard.count",
    "stockout_store_dashboard.avg_risk_score",
    "stockout_store_dashboard.critical_risk_count"
  ],
  "filters": [
    { "member": "stockout_store_dashboard.partition", "operator": "equals", "values": ["bonus.is"] },
    { "member": "stockout_store_dashboard.sold_location", "operator": "equals", "values": ["{store}"] }
  ],
  "limit": 50000
}
```

Crossfilter worker config:
- Dimensions (for client-side filtering): `product`, `product_category`, `product_sub_category`, `supplier`, `is_currently_active`, `risk_tier`, `risk_score`, `forecast_stockout_probability`
- KPIs: `{ id: 'avgAvail', field: 'avg_availability', op: 'avg' }`, `{ id: 'totalActive', field: 'sum_active', op: 'sum' }`, `{ id: 'worsening', field: 'worsening_count', op: 'sum' }`, `{ id: 'confirmed', field: 'sum_confirmed_stockouts', op: 'sum' }`, `{ id: 'suspect', field: 'sum_suspect_stockouts', op: 'sum' }`, `{ id: 'lostSales', field: 'sum_expected_lost_sales', op: 'sum' }`, `{ id: 'count', field: 'count', op: 'sum' }`
- Groups: `{ id: 'byCategory', field: 'product_category', metrics: [{ id: 'avgAvail', field: 'avg_availability', op: 'avg' }] }`
- Row fields (for tables): `trend_signal`, `forecast_warning`, `forecast_daily_prob`, `forecast_day_names`, `avg_duration_days`, `total_expected_lost_sales`, `days_since_last`, `stockouts_per_month`, `highest_risk_day`, `signal_quality`, `forecast_stockout_probability`
- Panels served: KPIs, Category, Stockout Table, Forecast Table, Risk Chart

**cf-trend** (`stockout_availability_trend`):

Cube.dev query:
```json
{
  "dimensions": [
    "stockout_availability_trend.product",
    "stockout_availability_trend.product_category",
    "stockout_availability_trend.product_sub_category",
    "stockout_availability_trend.supplier"
  ],
  "measures": [
    "stockout_availability_trend.stockout_events",
    "stockout_availability_trend.products_affected",
    "stockout_availability_trend.total_duration_ratio_delta",
    "stockout_availability_trend.total_expected_lost_sales"
  ],
  "timeDimensions": [
    { "dimension": "stockout_availability_trend.observation_date", "granularity": "month" }
  ],
  "filters": [
    { "member": "stockout_availability_trend.partition", "operator": "equals", "values": ["bonus.is"] },
    { "member": "stockout_availability_trend.sold_location", "operator": "equals", "values": ["{store}"] }
  ],
  "limit": 50000
}
```

Crossfilter worker config:
- Dimensions: `product`, `product_category`, `product_sub_category`, `supplier`, `observation_date` (time dimension, arrives as month-granularity timestamps from Cube's timeDimensions)
- Groups: `{ id: 'byMonth', field: 'observation_date', bucket: { type: 'timeBucket', granularity: 'month' }, metrics: [{ id: 'events', field: 'stockout_events', op: 'sum' }, { id: 'products', field: 'products_affected', op: 'sum' }] }`
- Panels served: Monthly Trend

Note: `observation_date` arrives as timestamps (Cube timeDimensions returns epoch milliseconds in Arrow). The crossfilter `timeBucket` handles the month grouping client-side.

**cf-warning** (`stockout_early_warning`):

Cube.dev query:
```json
{
  "dimensions": [
    "stockout_early_warning.product",
    "stockout_early_warning.product_category",
    "stockout_early_warning.product_sub_category",
    "stockout_early_warning.supplier",
    "stockout_early_warning.trend_signal",
    "stockout_early_warning.severity_trend",
    "stockout_early_warning.risk_tier",
    "stockout_early_warning.risk_score",
    "stockout_early_warning.availability",
    "stockout_early_warning.avg_duration_recent_half",
    "stockout_early_warning.avg_duration_older_half",
    "stockout_early_warning.frequency_recent_per_month",
    "stockout_early_warning.frequency_older_per_month",
    "stockout_early_warning.avg_impact_recent_half",
    "stockout_early_warning.avg_impact_older_half",
    "stockout_early_warning.forecast_stockout_probability",
    "stockout_early_warning.forecast_warning"
  ],
  "measures": [
    "stockout_early_warning.count",
    "stockout_early_warning.worsening_count",
    "stockout_early_warning.critical_risk_count",
    "stockout_early_warning.avg_risk_score",
    "stockout_early_warning.sum_expected_lost_sales"
  ],
  "filters": [
    { "member": "stockout_early_warning.partition", "operator": "equals", "values": ["bonus.is"] },
    { "member": "stockout_early_warning.sold_location", "operator": "equals", "values": ["{store}"] }
  ],
  "limit": 50000
}
```

Crossfilter worker config:
- Dimensions: `product`, `product_category`, `product_sub_category`, `supplier`, `trend_signal`, `severity_trend`, `risk_tier`, `risk_score`
- KPIs: `{ id: 'worsening', field: 'worsening_count', op: 'sum' }`, `{ id: 'critical', field: 'critical_risk_count', op: 'sum' }`
- Row fields: `availability`, `avg_duration_recent_half`, `avg_duration_older_half`, `frequency_recent_per_month`, `frequency_older_per_month`, `avg_impact_recent_half`, `avg_impact_older_half`, `forecast_stockout_probability`, `forecast_warning`
- Panels served: Early Warning Table

**cf-dow** (`stockout_dow_analysis`):

Cube.dev query:
```json
{
  "dimensions": [
    "stockout_dow_analysis.product",
    "stockout_dow_analysis.product_category",
    "stockout_dow_analysis.product_sub_category",
    "stockout_dow_analysis.supplier",
    "stockout_dow_analysis.dow_pattern",
    "stockout_dow_analysis.highest_risk_day",
    "stockout_dow_analysis.dow_mon_confirmed",
    "stockout_dow_analysis.dow_tue_confirmed",
    "stockout_dow_analysis.dow_wed_confirmed",
    "stockout_dow_analysis.dow_thu_confirmed",
    "stockout_dow_analysis.dow_fri_confirmed",
    "stockout_dow_analysis.dow_sat_confirmed",
    "stockout_dow_analysis.dow_sun_confirmed",
    "stockout_dow_analysis.dow_mon_probability",
    "stockout_dow_analysis.dow_tue_probability",
    "stockout_dow_analysis.dow_wed_probability",
    "stockout_dow_analysis.dow_thu_probability",
    "stockout_dow_analysis.dow_fri_probability",
    "stockout_dow_analysis.dow_sat_probability",
    "stockout_dow_analysis.dow_sun_probability",
    "stockout_dow_analysis.weekday_stockout_rate",
    "stockout_dow_analysis.weekend_stockout_rate"
  ],
  "measures": [
    "stockout_dow_analysis.count"
  ],
  "filters": [
    { "member": "stockout_dow_analysis.partition", "operator": "equals", "values": ["bonus.is"] },
    { "member": "stockout_dow_analysis.sold_location", "operator": "equals", "values": ["{store}"] }
  ],
  "limit": 50000
}
```

Crossfilter worker config:
- Dimensions: `product`, `product_category`, `product_sub_category`, `supplier`, `dow_pattern`, `highest_risk_day`
- Row fields: `dow_mon_confirmed` through `dow_sun_confirmed`, `dow_mon_probability` through `dow_sun_probability`, `weekday_stockout_rate`, `weekend_stockout_rate`
- Panels served: DOW Pattern

DOW chart aggregation: fetch all rows via `rows()`, then sum `dow_*_confirmed` columns across all returned rows to produce 7 aggregated bars. Average the `dow_*_probability` columns for the probability overlay.

**cf-analysis** (`is_bonus_stockout_analysis`):

Cube.dev query:
```json
{
  "dimensions": [
    "is_bonus_stockout_analysis.product",
    "is_bonus_stockout_analysis.product_category",
    "is_bonus_stockout_analysis.product_sub_category",
    "is_bonus_stockout_analysis.supplier",
    "is_bonus_stockout_analysis.signal_quality"
  ],
  "measures": [
    "is_bonus_stockout_analysis.count",
    "is_bonus_stockout_analysis.avg_availability",
    "is_bonus_stockout_analysis.high_noise_count"
  ],
  "filters": [
    { "member": "is_bonus_stockout_analysis.partition", "operator": "equals", "values": ["bonus.is"] },
    { "member": "is_bonus_stockout_analysis.sold_location", "operator": "equals", "values": ["{store}"] }
  ],
  "limit": 50000
}
```

Crossfilter worker config:
- Dimensions: `product`, `product_category`, `product_sub_category`, `supplier`, `signal_quality`
- Groups: `{ id: 'byQuality', field: 'signal_quality', metrics: [{ id: 'count', op: 'count' }] }`
- Panels served: Data Quality KPI badge

Data Quality computation: group by `signal_quality`, find the group with the highest count. Display that group's key as the badge. This uses the standard group API, not a "mode" operation.

### Server-Side vs Client-Side Filter Routing

**Client-side filter dimensions** (loaded in all 5 crossfilters): `product`, `product_category`, `product_sub_category`, `supplier`.

These 4 dimensions are in every crossfilter worker. Filters on any of them are dispatched as `runtime.updateFilters()` to all 5 runtimes — instant, no re-fetch.

**Server-side-only filters** (baked into every Cube query, not crossfilter dimensions): `partition`, `sold_location`.

`partition` is always `bonus.is`. `sold_location` is the selected store from the URL. These never change without a full runtime rebuild (changing store = dispose all 5 + recreate).

**Mixed-routing dimensions**: `is_currently_active`, `risk_tier`, `risk_score`, `trend_signal`, `severity_trend`, `forecast_stockout_probability` exist in some crossfilters but not all. When a URL filter targets one of these:
- Runtimes that have it as a dimension → `updateFilters()` (client-side)
- Runtimes that don't have it → ignore (the filter doesn't apply to that cube's panels)

This is NOT a server-side re-fetch scenario — it's a "this filter only affects panels backed by runtimes that have the dimension" case.

**When server-side re-fetch actually happens**: Only when the `store` URL parameter changes. This disposes all 5 workers and recreates them with the new store baked into the Cube queries.

## Panel Specifications

### 1. KPI Row

6 cards in a horizontal row.

| Card | Source | Computation | Format | Color Logic |
|------|--------|-------------|--------|-------------|
| Store Availability | cf-store KPI | `{ field: 'avg_availability', op: 'avg' }` — unweighted avg across product-store rows | `XX.X%` | Green >= 85%, amber >= 70%, red < 70% |
| Active Stockouts | cf-store KPI | `{ field: 'sum_active', op: 'sum' }` — additive count | Count | Red when > 0, green when 0 |
| Worsening | cf-store KPI | `{ field: 'worsening_count', op: 'sum' }` — additive count | Count | Red when > 0 |
| Total Stockouts | cf-store KPIs | `confirmed` + `suspect` KPI values summed in panel renderer | Count | Tooltip shows confirmed/suspect split |
| Est. Lost Sales | cf-store KPI | `{ field: 'sum_expected_lost_sales', op: 'sum' }` — additive | ISK compact ("4.2M ISK") | Always amber/red tones |
| Data Quality | cf-analysis group | `byQuality` group → pick key with highest count | Badge text | HIGH CONF=green, MIXED=amber, LOW CONF=red, HIGH NOISE=red |

ISK formatting: no currency symbol prefix. Thresholds: < 1000 → raw number, >= 1000 → "X.XK", >= 1M → "X.XM", >= 1B → "X.XB". Always suffixed with " ISK".

### 2. Monthly Availability Trend

**Source**: cf-trend, `byMonth` group.

ECharts line chart with dual Y-axes:
- Left Y: `events` metric (sum of distinct stockout events per month) — line with area fill
- Right Y: `products` metric (sum of products affected per month) — dashed line

X-axis: month labels derived from the time bucket keys. Tooltip shows both values.

### 3. By Category

**Source**: cf-store, `byCategory` group.

ECharts horizontal bar chart, sorted worst-availability-first. Color-coded by availability threshold (same as KPI). **Click a bar** → sets `category` in URL hash → all crossfilters filter to that category.

### 4. Currently Stocked Out Table

**Source**: cf-store. Apply client-side filter `is_currently_active = true` (this is a loaded crossfilter dimension), then `rows()` sorted by `risk_score` desc.

| Column | Field | Format |
|--------|-------|--------|
| Product | `product` | Text |
| Category | `product_category` | Text |
| Supplier | `supplier` | Text |
| Risk | `risk_tier` | Badge (Critical/High/Medium/Low) |
| Duration | `avg_duration_days` | "X.Xd" |
| Lost Sales | `total_expected_lost_sales` | ISK compact |
| Trend | `trend_signal` | Badge (Worsening/Stable/Improving) |
| Forecast | `forecast_warning` | Badge |

### 5. At Risk — Next 3 Days Forecast

**Source**: cf-store. Apply client-side filters: `is_currently_active = false` AND `forecast_stockout_probability` filterRange `[0.3, Infinity]` (both are loaded crossfilter dimensions). Then `rows()` sorted by `forecast_stockout_probability` desc.

Two parts:
1. **Forecast summary cards** — top 3-4 products with highest combined probability, each showing a 3-day breakdown parsed from `forecast_daily_prob` (JSON string) and `forecast_day_names` (JSON string). Each day shows probability as a mini bar + percentage.
2. **Table** with columns: Product, Category, Supplier, Combined Prob, Day 1/2/3 probs, Days Since Last, Freq/Month, Highest Risk Day.

JSON parsing: `forecast_daily_prob` contains a JSON array like `[0.62, 0.45, 0.38]`. `forecast_day_names` contains a JSON array like `["Mon", "Tue", "Wed"]`. Parse in the panel renderer. Handle parse errors gracefully (show "—" if malformed).

### 6. Top 10 Highest Risk Products

**Source**: cf-store, `rows()` sorted by `risk_score` desc, limit 10.

ECharts horizontal bar chart. Bar length = risk score (0-1). Color-coded: red >= 0.75, orange >= 0.5, amber >= 0.25, green < 0.25.

### 7. Early Warning — Worsening Products

**Source**: cf-warning. Apply client-side filters: `trend_signal` filterIn `['worsening']` OR `severity_trend` filterIn `['worsening']`. Since crossfilter can't do OR across dimensions, this is implemented as: fetch all rows, then post-filter in the panel renderer to rows where `trend_signal === 'worsening' || severity_trend === 'worsening'`. Sort by `risk_score` desc client-side.

| Column | Field | Format |
|--------|-------|--------|
| Product | `product` | Text |
| Category | `product_category` | Text |
| Trend | `trend_signal` | Badge |
| Severity | `severity_trend` | Badge |
| Risk | `risk_score` | Number (0-1) |
| Duration Recent | `avg_duration_recent_half` | "X.Xd" |
| Duration Older | `avg_duration_older_half` | "X.Xd" |
| Freq Recent | `frequency_recent_per_month` | "/mo" |
| Freq Older | `frequency_older_per_month` | "/mo" |
| Impact Recent | `avg_impact_recent_half` | ISK/day |
| Impact Older | `avg_impact_older_half` | ISK/day |

Delta indicators: arrow up/down comparing recent vs older columns.

### 8. DOW Pattern

**Source**: cf-dow, `rows()` query for all rows (all products at this store).

Aggregation: sum `dow_mon_confirmed` through `dow_sun_confirmed` across all rows to get 7 totals. Average `dow_mon_probability` through `dow_sun_probability` across all rows for probability overlay.

ECharts bar chart with 7 bars (Mon-Sun). Bar height = total confirmed days. Color intensity by average probability. Below the chart: weekday vs weekend stockout rate comparison (averaged across rows), and the most common `dow_pattern` (mode of the column) and `highest_risk_day` (mode) as callout badges.

## Visual Design

Dark theme matching the existing mockup design system:

```css
--bg-primary: #0a0e14
--bg-card: #111820
--bg-card-alt: #151d28
--bg-hover: #1a2332
--border: #1e2a3a
--text-primary: #e8edf3
--text-secondary: #7a8a9e
--text-muted: #4a5a6e
--accent-green: #00e68a     /* success/availability */
--accent-green-dim: #00e68a33
--accent-red: #ff4d6a       /* critical/danger */
--accent-red-dim: #ff4d6a22
--accent-amber: #ffb84d     /* warning */
--accent-amber-dim: #ffb84d22
--accent-blue: #4da6ff      /* info */
--accent-blue-dim: #4da6ff22
--accent-purple: #b366ff    /* secondary */
--font-mono: 'JetBrains Mono'
--font-sans: 'DM Sans'
```

- KPI values in mono font, large (24-28px)
- Table text in mono font, small (11px)
- Card titles in mono uppercase (10px, letter-spacing 2px)
- Badge system: colored pill backgrounds with matching text (9px mono, 600 weight, 2px 6px padding, 3px radius)
- Fade-up animation on load (cascading delays d1-d8, 0.05s increments)
- ECharts tooltips follow the dark theme (dark background, light text, mono font)
- Max width 1440px, centered

## Error Handling

- **Cube API error or timeout**: show error badge on affected panels ("Failed to load"), log to console. Other panels continue working.
- **Single worker fails to load**: render its panels with "Data unavailable" placeholder. Other workers and their panels are unaffected.
- **Worker creation timeout**: 30 second timeout per worker. If exceeded, show error state for that worker's panels.
- **Loading states**: each panel shows a shimmer/skeleton placeholder until its worker is ready. Panels appear progressively.
- **No data for store**: if a Cube query returns 0 rows (store has no stockout data), show "No stockout data for this store" in the dashboard body instead of empty charts.

## Proxy Server

New file at `demo-stockout/proxy-server.mjs` (based on `demo/proxy-server.mjs` pattern) that proxies:
- `POST /api/cube` → `https://dbx.fraios.dev/api/v1/load` (with auth headers from `.env`)
- `GET /api/meta` → `https://dbx.fraios.dev/api/v1/meta` (with auth headers from `.env`)
- Static files from the repo root

Auth config from `.env`:
```
CUBE_TOKEN=...
CUBE_DATASOURCE=977c3d36-b1b2-47bb-a854-b2c9f2f93fef
CUBE_BRANCH=f553ff44-1c23-47df-b771-44c526d81fe7
```

The proxy forwards `x-synmetrix-arrow-field-mapping` and `x-synmetrix-arrow-field-mapping-encoding` response headers (same as existing proxy).

## What This Proves

This demo validates the multi-crossfilter architecture:
1. **Unified filter state** across 5 independent crossfilter worker runtimes
2. **URL as single source of truth** — shareable, bookmarkable, back/forward works
3. **Client-side filter routing** — filters on shared dimensions are instant (no re-fetch)
4. **Server-side filter routing** — store change triggers full re-fetch (the infrastructure supports dimension-level routing for future dashboards with non-shared dimensions)
5. **Progressive loading** — panels render as their crossfilter becomes ready
6. **Meta-driven** — cube structure discovered from `/api/v1/meta`, not hardcoded
7. **Click-to-filter** — charts are interactive, clicking a category bar filters everything
8. **Real data** — live Cube.dev queries against a production Synmetrix semantic layer

## Out of Scope (v1)

- Other dashboard views (Product Manager, Quality Inspector, Category Detail, Product Detail) — these will be added as additional views with the same infrastructure
- Period/date range selector — the snapshot cubes don't have time dimensions; trend cube defaults to all available data
- Export / download
- Real-time auto-refresh
- Mobile-optimized layout
