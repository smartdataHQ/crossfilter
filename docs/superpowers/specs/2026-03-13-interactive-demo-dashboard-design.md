# Interactive Demo Dashboard — Design Spec

## Purpose

A standalone HTML demo page that showcases the full crossfilter2 API using the 1M-row `test/data/query-result.arrow` fleet-tracking dataset. Users can switch between 4 engine modes (row baseline, row native, Arrow+JS, Arrow+WASM) and feel the performance difference through live latency instrumentation. Every crossfilter feature is demonstrated through an interactive dashboard with glass-morphism styling adapted from the cxs2 project.

## Technology Stack

- **No framework** — vanilla JS, single HTML file + supporting JS module(s)
- **ECharts 5.5.1** — loaded via CDN (`cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js`)
- **Apache Arrow 17.0.0** — loaded via CDN (`cdn.jsdelivr.net/npm/apache-arrow@17.0.0/Arrow.es2015.min.js`)
- **Crossfilter2** — the local UMD build (`crossfilter.js`)
- **CSS** — glass-morphism design tokens extracted from cxs2's `globals.css`

## Data

Source: `test/data/query-result.arrow` — 1,000,000 rows, 13 fields.

| Short name | Arrow field name | Type | Notes |
|------------|-----------------|------|-------|
| event | `semantic_events__event` | Utf8 | Alert/activity type |
| customer_country | `semantic_events__dimensions_customer_country` | Utf8 | Customer's country |
| location_label | `semantic_events__location_label` | Utf8 | Specific place name |
| location_country | `semantic_events__location_country` | Utf8 | Country where event occurred |
| division | `semantic_events__location_division` | Utf8 | Admin division |
| latitude | `semantic_events__location_latitude` | Float64 | Coordinate |
| locality | `semantic_events__location_locality` | Utf8 | City/town |
| municipality | `semantic_events__location_municipality` | Utf8 | Municipality |
| postal_code | `semantic_events__location_postal_code` | Utf8 | Postal code |
| postal_name | `semantic_events__location_postal_name` | Utf8 | Sparse/empty |
| region | `semantic_events__location_region` | Utf8 | Region |
| location_code | `semantic_events__location_code` | Utf8 | Sparse/empty |
| timestamp | `semantic_events__timestamp_minute` | Timestamp | Epoch ms |

All 13 fields are represented in the dashboard. The two sparse fields (postal_name, location_code) appear in the data table when non-empty.

### Field Name Mapping

The Arrow file uses long prefixed names (`semantic_events__location_region`). The demo uses short names (`region`) for readability. A `FIELDS` mapping object bridges them:

```js
const FIELDS = {
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
```

All `cf.dimension()` calls use the full Arrow field name via `FIELDS.shortName`. Row property access also uses full names: `row[FIELDS.latitude]`. This works identically for both `fromArrowTable()` (where materialized rows have Arrow field names as keys) and `crossfilter(rows)` (where `materializeRows()` produces the same keys).

On startup, validate that every `FIELDS` value exists in the Arrow table's schema. Show an error banner if any field is missing.

## Page Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ HEADER: Title | Mode selector (4 radio buttons) | Runtime badge     │
│         Latency display (ms) | Load time (ms)                       │
├──────────────────────────────────────────────────────────────────────┤
│ FILTER BAR                                                           │
│ Event pills | Customer country dropdown | Location country dropdown  │
│ Region multi-select | Time range brush | Latitude range inputs       │
│ Active filter chips (dismissible)                        [Clear All] │
├──────────────────────────────────────────────────────────────────────┤
│ KPI ROW: [ Total Events ] [ Unique Locations ] [ Avg Lat ] [ Span ] │
├─────────────────────┬──────────────────────┬─────────────────────────┤
│ COLUMN 1            │ COLUMN 2             │ COLUMN 3               │
│                     │                      │                        │
│ Events by Type      │ Events over Time     │ By Municipality        │
│ (horiz bar)         │ (line/area + brush)  │ (scrollable list,      │
│                     │                      │  top 20)               │
│ By Customer Country │ By Region            │                        │
│ (sorted list)       │ (bar, reduceSum)     │ By Locality            │
│                     │                      │ (list, reverse order)  │
│ By Location Country │ By Division          │                        │
│ (sorted list)       │ (bar, reduceCount)   │ Top Postal Codes       │
│                     │                      │ (mini list)            │
├─────────────────────┴──────────────────────┴─────────────────────────┤
│ DATA TABLE: top(50) — 50 most recent, all 11 non-empty fields       │
├──────────────────────────────────────────────────────────────────────┤
│ DEMO CONTROLS: [Add 1000 rows] [Remove filtered] | Performance log  │
└──────────────────────────────────────────────────────────────────────┘
```

## Components Detail

### Header Bar

- **Title**: "Crossfilter2 — Interactive Demo"
- **Mode selector**: 4 radio-style buttons: `Row (baseline)` | `Row (native)` | `Arrow + JS` | `Arrow + WASM`. Default: Arrow+WASM. Switching rebuilds the entire crossfilter instance, re-applies current filters, re-renders all charts.
- **Runtime badge**: shows `crossfilter.runtimeInfo().active` (js/wasm), row count via `cf.size()`, column count.
- **Latency display**: updates on every filter/render cycle with `performance.now()` delta.
- **Load time**: time to parse Arrow + build crossfilter + create all dimensions/groups.

### Filter Bar

| Control | Field | Crossfilter method | UX |
|---------|-------|-------------------|-----|
| Event type pills | event | `filterIn([...])` | Toggle pills on/off, multi-select |
| Customer country dropdown | customer_country | `filterExact(value)` | Single-select with "All" option |
| Location country dropdown | location_country | `filterExact(value)` | Single-select with "All" option |
| Region multi-select | region | `filterIn([...])` | Checkbox list, searchable |
| Time range slider | timestamp | `filterRange([lo, hi])` | Dual-handle range slider, shows date labels |
| Latitude range inputs | latitude | `filterFunction(fn)` | Two number inputs (min/max) with custom predicate |
| Clear all button | all | `filterAll()` on every dimension | Resets everything |

Active filter chips are rendered by iterating all dimensions and calling `dimension.hasCurrentFilter()`. For dimensions with an active filter, `dimension.currentFilter()` provides the display value. Clicking a chip calls `filterAll()` on that dimension to dismiss it.

### KPI Cards

Single combined `groupAll().reduce(add, remove, initial)` powering all 4 cards:

| Card | Value | Reducer logic |
|------|-------|---------------|
| Total Events | `state.totalRows` (+ percentage of unfiltered via `cf.size()`) | Increment/decrement count |
| Unique Locations | `state.locationSet.size` | Add/remove from Set of location_label values |
| Avg Latitude | `state.latSum / state.latCount` | Running sum + count of non-zero latitude |
| Time Span | Format `state.minTime` – `state.maxTime` | Track min/max timestamp (recompute on remove via `allFiltered()` fallback) |

In **row_baseline mode**, KPIs use 4 separate `groupAll()` reducers (one per card) to demonstrate the performance difference vs. the combined approach used in all other modes.

Glass-morphism card styling: gradient bg, backdrop-blur(10px), semi-transparent border, soft shadow.

### Charts — Column 1 (Grouped lists)

**Events by Type** — Horizontal bar chart (ECharts)
- `cf.dimension(FIELDS.event)` with string accessor (WASM-eligible)
- `dimension.group()` default reduce (count)
- Click a bar → `filterExact(clickedValue)` on the event dimension
- Shows all group entries via `group.all()`

**By Customer Country** — Sorted list with proportional bars
- `cf.dimension(FIELDS.customer_country)` string accessor
- `dimension.group()` count
- Click item → `filterExact(value)`, Ctrl+click → accumulate `filterIn([...])`
- `group.all()` sorted by value descending

**By Location Country** — Same pattern
- `cf.dimension(FIELDS.location_country)` string accessor
- `dimension.group()` count
- Click/Ctrl+click filtering

### Charts — Column 2 (Time + geographic aggregations)

**Events over Time** — Line/area chart with brush
- `cf.dimension(FIELDS.timestamp)` — numeric timestamp
- `dimension.group(timeBucketFn)` — custom key function that buckets to hour or day depending on range. Demonstrates `group(keyFunction)`.
- ECharts dataZoom (brush) component → on brush end, apply `filterRange([brushStart, brushEnd])`
- `group.all()` for x/y data

**By Region** — Vertical bar chart
- `cf.dimension(FIELDS.region)` string accessor
- `dimension.group().reduceSum(row => row[FIELDS.latitude])` — demonstrates `reduceSum` by summing the actual latitude values per region (total latitude degrees, meaningful for geographic spread). Shows a real numeric aggregation.
- `group.all()` sorted

**By Division** — Vertical bar chart
- `cf.dimension(FIELDS.division)` string accessor
- `dimension.group().reduceCount()` — demonstrates `reduceCount()`
- `group.all()` sorted

### Charts — Column 3 (Deep geographic + postal)

**By Municipality** — Scrollable list
- `cf.dimension(FIELDS.municipality)` string accessor
- `dimension.group()` count
- Display via `group.top(20)` — demonstrates `group.top(k)`
- Click to filter

**By Locality** — Scrollable list
- `cf.dimension(FIELDS.locality)` string accessor
- `dimension.group()` count
- `group.order(entry => -entry)` then `group.top(15)` — reverse ordering so `top()` returns the *least* frequent localities. Demonstrates that `group.order()` changes the meaning of `top()`.
- Click to filter

**Top Postal Codes** — Mini list
- `cf.dimension(FIELDS.postal_code)` string accessor
- `dimension.group()` count
- `group.top(10)`

### Data Table

- Powered by `cf.dimension(FIELDS.timestamp).top(50)` — 50 most recent filtered records (highest timestamps = most recent). Demonstrates `dimension.top(k)`.
- A toggle button switches to `dimension.bottom(50)` to show the 50 oldest records. Demonstrates `dimension.bottom(k)`.
- Both `top` and `bottom` support an offset parameter: a "Next page" button calls `dimension.top(50, currentOffset)` to paginate. Demonstrates `top(k, offset)`.
- Columns: event, customer_country, location_country, region, division, municipality, locality, location_label, postal_code, postal_name (if non-empty), location_code (if non-empty), latitude, timestamp
- Rows where `cf.isElementFiltered(index)` is false get a muted style — demonstrates `isElementFiltered()`
- Plain HTML `<table>` with sticky header, scrollable body

### Demo Controls

- **"Add 1000 rows"** button: generates 1000 synthetic rows by sampling existing dimension values. For each row: pick a random event type from the event dimension's `group.all()` keys, random country/region/etc from their respective groups, a random timestamp within the current data range, and a latitude sampled from the existing range. Rows are plain objects with full Arrow field names as keys. Calls `cf.add(rows)`. All charts update. Demonstrates `add()`.
- **"Remove filtered"** button: calls `cf.remove()` which removes currently-filtered-out records (or a predicate-based variant). Demonstrates `remove()`.
- **Performance log**: scrollable `<pre>` that accumulates timestamped entries for every operation: `[12:34:56.789] filterIn(event, 3 values) — 1.2ms`.

### Timing & Render Pipeline

Each filter/mutation operation is wrapped in a timing helper:

```js
function timedFilter(label, fn) {
  var t0 = performance.now();
  fn();
  var elapsed = performance.now() - t0;
  appendLog(label + ' — ' + elapsed.toFixed(2) + 'ms');
  updateLatencyDisplay(elapsed);
}
```

This captures the operation name and parameters (e.g., `"filterIn(event, 3 values)"`) rather than relying on `onChange`, which only provides the event type string.

`cf.onChange(callback)` is still registered to trigger the re-render of all charts/KPIs/table. Chart updates are batched via a single `requestAnimationFrame` call — when `onChange` fires, it sets a dirty flag and schedules one rAF that re-reads all groups and updates all ECharts instances and the table. This prevents redundant renders when multiple filters change in sequence.

### Error Handling

- **Arrow fetch failure**: show an error banner with instructions to serve the repo root with a static server and ensure `test/data/query-result.arrow` exists.
- **WASM init failure**: automatically fall back to JS mode. Show a warning badge in the header: "WASM unavailable — using JS fallback". The mode button for Arrow+WASM stays selectable but displays the same warning.
- **Mode switch failure**: catch errors during rebuild, show an inline error, and revert to the previous working mode.
- **Missing fields**: on startup, validate all FIELDS against the Arrow schema. Show a clear error listing any missing fields.

## Mode Switching Logic

```
User clicks mode button
  → Save current filter state (which dimensions have which filter values
    via dimension.currentFilter() / dimension.hasCurrentFilter())
  → Dispose all groups, dimensions (cleanup via .dispose())
  → If mode is row_baseline:
      → crossfilter.configureRuntime({ wasm: false })
      → cf = crossfilter(materializeRows(arrowTable))
      → Use filterFunction() for discrete multi-select (slower path)
      → Use 4 separate groupAll() reducers for KPIs (slower path)
  → If mode is row_native:
      → crossfilter.configureRuntime({ wasm: false })
      → cf = crossfilter(materializeRows(arrowTable))
      → Use filterIn()/filterExact() (native filters)
      → Use 1 combined groupAll() reducer for KPIs
  → If mode is arrow_js:
      → crossfilter.configureRuntime({ wasm: false })
      → cf = crossfilter.fromArrowTable(arrowTable)
      → Use filterIn()/filterExact() (native filters)
      → Use 1 combined groupAll() reducer for KPIs
  → If mode is arrow_wasm:
      → crossfilter.configureRuntime({ wasm: true })
      → cf = crossfilter.fromArrowTable(arrowTable)
      → Use filterIn()/filterExact() (native filters)
      → Use 1 combined groupAll() reducer for KPIs
  → Recreate all dimensions and groups
  → Re-apply saved filter state
  → Re-render everything
  → Display build time + first render time
```

## Crossfilter API Coverage

| API | Where | Notes |
|-----|-------|-------|
| `crossfilter(rows)` | Row modes | Materialized row objects |
| `crossfilter.fromArrowTable(table)` | Arrow modes | Lazy columnar ingest |
| `crossfilter.configureRuntime()` | Mode switcher | Toggle WASM on/off |
| `crossfilter.runtimeInfo()` | Runtime badge | Live status |
| `cf.add(records)` | Add rows button | Live data addition |
| `cf.remove(predicate)` | Remove filtered button | Data removal |
| `cf.dimension(string)` | 10 categorical dims | WASM-eligible path |
| `cf.dimension(function)` | Latitude dimension | `d => d[FIELDS.latitude]` — function accessor for filterFunction demo |
| `cf.dimension(value, isArray)` | — | Out of scope (see below) |
| `cf.groupAll()` | KPI cards | Global aggregation |
| `groupAll().reduce(add,rm,init)` | KPI cards (combined) | Custom combined reducer |
| `groupAll().reduceCount()` | KPI cards (baseline mode, Total Events) | Separate count |
| `groupAll().reduceSum(fn)` | KPI cards (baseline mode, Avg Latitude numerator) | Separate sum |
| `dimension.group()` | Every chart (10 charts) | Default count grouping |
| `dimension.group(keyFn)` | Time series | Custom bucketing |
| `group.reduceCount()` | Division chart | Explicit count |
| `group.reduceSum(fn)` | Region chart | Sum of latitude values |
| `group.reduce(add,rm,init)` | KPI cards (via groupAll) | Custom reducer |
| `group.all()` | Most charts | Read all group entries |
| `group.top(k)` | Municipality, Locality, Postal | Top-K groups |
| `group.order(fn)` | Locality list | Reverse order (`-entry`) |
| `group.orderNatural()` | — | Default; explicitly called after clearing custom order |
| `group.size()` | Tooltip on group chart headers | "N unique values" |
| `dimension.top(k)` | Data table (default) | Most recent records |
| `dimension.top(k, offset)` | Data table pagination | Offset-based paging |
| `dimension.bottom(k)` | Data table (toggle) | Oldest records |
| `dimension.currentFilter()` | Filter chips display | Read active filter |
| `dimension.hasCurrentFilter()` | Filter chips display | Check if filtered |
| `filterExact(value)` | Country dropdowns, bar clicks | Single value match |
| `filterIn([values])` | Event pills, region multi-select | Set membership |
| `filterRange([lo,hi])` | Time brush slider | Continuous range |
| `filterFunction(fn)` | Latitude range inputs, baseline mode multi-select | Custom predicate |
| `filterAll()` | Clear-all, chip dismiss, mode switch | Reset |
| `cf.size()` | Runtime badge, KPI percentage | Record count |
| `cf.all()` | Synthetic row generation (sample from full data) | All records |
| `cf.allFiltered()` | KPI time span recompute, percentage calc | Filtered records |
| `cf.onChange(fn)` | Render pipeline | Change listener |
| `cf.isElementFiltered()` | Data table row styling | Per-element check |
| `dimension.dispose()` | Mode switch cleanup | Resource cleanup |
| `group.dispose()` | Mode switch cleanup | Resource cleanup |

## Styling

Extracted from cxs2 `globals.css` — light mode only for the demo:

```css
/* Design tokens */
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

/* Glass card */
background: linear-gradient(0deg, rgba(63,101,135,0.03) 0%, rgba(63,101,135,0.03) 100%),
            linear-gradient(180deg, rgba(252,254,255,0.40) 0%, rgba(252,254,255,0.10) 100%);
backdrop-filter: blur(10px);
border: 1px solid rgba(255, 255, 255, 0.5);
box-shadow: 2px 2px 15px 0 rgba(0, 21, 88, 0.05);
border-radius: 12px;
```

Font: Lato (Google Fonts CDN), fallback system-ui. ECharts axis labels use `--chart-axis-label`. Table borders use `--border-subtle`. Scrollable containers use `--scrollbar-thumb`.

## File Structure

```
demo/
  index.html          — Main page, loads CSS + scripts
  demo.js             — Dashboard logic (ES module)
  demo.css            — Glass-morphism styles + layout
```

Served via any static file server from the repository root. The HTML references `../crossfilter.js` for the UMD bundle and fetches `../test/data/query-result.arrow` at runtime.

## Out of Scope

- Dark mode (light only for demo simplicity)
- React/framework integration
- Map visualization (would require Leaflet/Mapbox, adds complexity without demonstrating more crossfilter features)
- Responsive/mobile layout (desktop-focused demo)
- `crossfilter.fromColumns()` — redundant with `fromArrowTable()` for this dataset
- `cf.dimension(value, isArray)` — iterable/array dimensions are a niche feature for multi-valued fields; the fleet-tracking dataset does not have array-valued columns, so demonstrating this would require synthetic data that distracts from the real dataset story
