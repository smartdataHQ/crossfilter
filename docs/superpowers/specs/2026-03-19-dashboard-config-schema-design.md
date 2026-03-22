# Dashboard Config Schema — Design Spec

**Date:** 2026-03-19
**Status:** Implemented

## Goal

A JSON Schema that constrains LLM structured output to produce valid, renderable dashboard configurations. The schema is generated per-cube from live Cube.dev metadata, so every dimension/measure name is enum-constrained — the LLM cannot hallucinate field names.

## Key Decisions

### Chart-first, not field-first

The config leads with the chart type, not the data field. The chart type determines which slot fields are available.

```json
// YES — chart-first (what we do)
{ "chart": "bar", "category": "activity_type", "value": "count" }

// NO — field-first (what we moved away from)
{ "dimension": "activity_type" }
```

The LLM picks the visualization, then assigns fields to its data slots. The engine renders exactly what it's told — no inference.

### Flat slot fields, not nested slots object

Slot fields (`category`, `name`, `x`, `y`, `source`, `target`, `size`, `color`, `levels`, etc.) are direct properties on the panel object, not nested inside a `slots` object. This keeps depth within OpenAI's limits and lets each field be individually enum-constrained.

```json
// YES — flat
{ "chart": "scatter.bubble", "x": "poi_match_score", "y": "avg_poi_distance_m", "size": "count", "color": "poi_category" }

// NO — nested
{ "chart": "scatter.bubble", "slots": { "x": "...", "y": "..." } }
```

### anyOf with chart-type discriminator

The panel schema uses `anyOf` with 29 branches. Each branch has a `chart` field (const or enum) that acts as the discriminator, plus only the slot fields relevant to that chart type. The LLM never sees irrelevant fields.

### Two audiences: LLM (dense) and human (sparse)

The schema enforces all fields as `required` (OpenAI strict mode). LLM output includes every field, with nulls for unused ones. Hand-written configs omit nullable fields — the engine applies defaults. Both formats are structurally identical; they differ only in completeness.

### Explicit shared filters for multi-cube

No implicit name matching across cubes. The config declares exactly which dimensions bridge which cubes:

```json
{ "sharedFilters": [{ "dimension": "sold_location", "cubes": ["cube_a", "cube_b"] }] }
```

### Primary selector in the modelbar

When a dashboard focuses on a single entity (a POI, a store, a product), one panel is marked `primary: true`. This goes in the modelbar section — always visible as a filter control, not buried in the main body.

## Architecture

### Schema generation pipeline

```
Cube.dev /api/meta
    ↓
generate-schema.js
    ├── extractCubeEnums()     → dimension/measure/segment name arrays
    ├── buildFullSchema()      → JSON Schema with $defs + anyOf branches
    └── generateSystemPrompt() → field catalog + chart guide + design guidelines
    ↓
Two outputs:
    1. JSON Schema  → OpenAI response_format.json_schema
    2. System prompt → OpenAI messages[0].content
```

### Files

| File | Purpose |
|---|---|
| `demo/chart-types.js` | Chart type registry — 54 types, 10 families, with slot definitions and ECharts options |
| `demo/schema/dashboard-schema-base.js` | Builds JSON Schema from chart registry + cube enums. Uses `$defs` for shared enums, `anyOf` for chart-type branches |
| `demo/schema/generate-schema.js` | Cube overlay generator + system prompt generator + CLI |
| `demo/schema/test-openai-call.mjs` | End-to-end test: generates schema + prompt, calls OpenAI, validates result |
| `demo/builder.html` | Conversational builder UI — chat panel + live dashboard preview |
| `demo/proxy-server.mjs` | Dev server with `/api/dashboard/generate` endpoint for builder |
| `demo/dashboard-engine.js` | Dashboard renderer — `normalizeConfig()` converts nested→flat, `resolvePanels()` preserves all slot fields |
| `demo/dashboards/*.json` | Dashboard config files (chart-first, nested format) |

## Config Format

### Root

```json
{
  "title": "Dashboard Title",
  "cubes": ["bluecar_stays"],
  "sharedFilters": [],
  "sections": [...]
}
```

### Section

```json
{
  "id": "overview",
  "label": "Overview",
  "location": "main",
  "columns": 3,
  "collapsed": false,
  "panels": [...]
}
```

`location`: `"main"` (default) or `"modelbar"` (compact filter strip).
`collapsed`: `true` renders as an accordion, closed by default.

### Panel

Every panel has a `chart` type and uses that type's slot field names:

```json
{ "chart": "kpi", "label": "Total Stays", "value": "count" }
{ "chart": "bar", "category": "region", "value": "count", "limit": 10 }
{ "chart": "pie.donut", "name": "fuel_type" }
{ "chart": "line", "x": "stay_ended_at", "y": "count", "width": "full" }
{ "chart": "scatter.bubble", "x": "poi_match_score", "y": "avg_poi_distance_m", "size": "count", "color": "poi_category" }
{ "chart": "sankey", "source": "prev_region", "target": "region", "value": "count" }
{ "chart": "treemap", "levels": ["region", "municipality", "locality"], "value": "count" }
{ "chart": "heatmap", "x": "stay_dow", "y": "region", "value": "count" }
{ "chart": "map.bubble", "lng": "longitude", "lat": "latitude", "size": "count", "color": "activity_type" }
{ "chart": "toggle", "dimension": "has_poi_match" }
{ "chart": "range", "dimension": "stay_duration_hours" }
{ "chart": "selector", "dimension": "poi_name", "primary": true, "searchable": true }
{ "chart": "table", "columns": ["region", "activity_type", "stay_duration_hours"] }
```

## Chart Type Registry (54 types, 10 families)

All types use `allTypeNames()` from `chart-types.js` as source of truth.

### category (13)
`bar`, `bar.horizontal`, `bar.stacked`, `bar.waterfall`, `bar.normalized`, `pie`, `pie.donut`, `pie.rose`, `pie.half`, `pie.nested`, `funnel`, `funnel.ascending`, `pictorialBar`

### time (6)
`line`, `line.smooth`, `line.step`, `line.area`, `line.bump`, `line.area.stacked`

### numeric (5)
`scatter`, `scatter.bubble`, `scatter.effect`, `heatmap`, `heatmap.calendar`

### geo (6)
`map`, `map.scatter`, `map.bubble`, `map.heatmap`, `map.lines`, `map.effect`

### single (4)
`gauge`, `gauge.progress`, `gauge.ring`, `kpi`

### hierarchy (4)
`treemap`, `sunburst`, `tree`, `tree.radial`

### relation (5)
`sankey`, `sankey.vertical`, `graph`, `graph.circular`, `chord`

### specialized (6)
`radar`, `candlestick`, `candlestick.ohlc`, `boxplot`, `themeRiver`, `parallel`

### tabular (1)
`table`

### control (4)
`selector`, `toggle`, `range`, `dropdown`

## Slot Field Type Constraints

Every slot field is enum-constrained to actual cube field names via `$defs`:

| Constraint | Slot fields |
|---|---|
| **Dimension only** | `category`, `color`, `date`, `dimension`, `innerName`, `lat`, `lng`, `name`, `pointLabel`, `region`, `source`, `sourceLat`, `sourceLng`, `stack`, `stream`, `target`, `targetLat`, `targetLng` |
| **Measure only** | `close`, `high`, `low`, `max`, `median`, `min`, `open`, `q1`, `q3`, `size`, `value` |
| **Dimension or measure** | `x`, `y` |
| **Dimension[] only** | `levels` |
| **Measure[] only** | `values` |
| **Any[] (dim or meas)** | `axes`, `columns` |

## Schema Limits (OpenAI raised limits, Jan 2026)

| Metric | Our schema | Limit | Status |
|---|---|---|---|
| Properties | ~265 | 5,000 | OK |
| Enum values | ~243 | 1,000 | OK |
| Enum chars | ~3,600 | 120,000 | OK |
| Object depth | 3 | 5 | OK |
| anyOf branches | 29 | — | OK |

Enum deduplication via `$defs`: dimension names (91), measure names (54), and chart types (54) are each defined once and referenced via `$ref`.

## System Prompt

Generated by `generateSystemPrompt()` alongside the schema. Contains:

1. **Cube metadata** — title, description, grain, period, granularity, refresh
2. **Field catalog** — every dimension (name, type, known values from `color_map`, tier labels from `color_scale`) and every measure (name, type, format, description)
3. **Segment list** — predefined boolean filters
4. **Chart type catalog** — all 54 types grouped by family with slot signatures
5. **Dashboard design guidelines** — information hierarchy, primary selectors, modelbar usage, collapsed sections, chart type selection by data pattern, geographic/travel chain patterns
6. **Config rules** — how to use slot fields, defaults, multi-cube patterns

~20k chars. Sent as the system message alongside the schema.

## Validation & Error Feedback

Errors are structured JSON designed for LLM self-correction:

```json
{
  "path": "sections[1].panels[0]",
  "panel": "Fleet Overview",
  "error": "missing_required_slot",
  "message": "Chart type 'scatter.bubble' requires slot 'size' (accepts: measure) but it was not provided",
  "hint": "Available measures: count, unique_bookings, avg_stay_duration_hours, ..."
}
```

### Stage 1: Config validation (before rendering)
- Field names exist in cube
- Chart type is valid
- Required slots are filled
- Slot values match their `accepts` constraint
- Section IDs are unique

### Stage 2: Render-time errors (ECharts failures)
- Raw ECharts error wrapped with panel config context
- `diagnosis` field maps rendering failure back to config terms

## Builder UI

`demo/builder.html` — conversational dashboard builder:

1. User describes dashboard in natural language
2. Proxy calls OpenAI with schema + system prompt + conversation history
3. Config saved as `_draft.json`, preview iframe reloads
4. User gives feedback, LLM receives current config + feedback, produces updated config
5. Iterate until satisfied
6. Download final JSON

The conversation includes the current config as context on subsequent turns so the LLM knows what to modify.

## Implementation Status

### Done

- Chart type registry (`chart-types.js`) — 54 types, 10 families, slot definitions, validation
- Schema generator — `$defs` + `anyOf` branches, cube-specific enums, OpenAI-compatible
- System prompt generator — field catalog, chart guide, design guidelines
- Config format — chart-first, nested sections, slot fields flat on panel
- Builder UI — conversational generation + live preview + iteration
- Proxy endpoint — `/api/dashboard/generate` calls OpenAI, saves `_draft.json`
- Config normalizer — converts nested format to engine's internal format, derives `dimension`/`measure` from slot fields
- `resolvePanels()` — preserves all slot fields through the pipeline
- Hand-written configs migrated to chart-first format
- OpenAI end-to-end test (`test-openai-call.mjs`)

### Not done — crossfilter + rendering wiring

The engine currently renders skeleton placeholders for all panels. No crossfilter workers are created, no ECharts instances are initialized, no data flows into charts. This is the next phase.

**What needs to happen:**

1. **Crossfilter worker creation** — for each cube in the config, create a `crossfilter.createDashboardWorker()` or `crossfilter.createStreamingDashboardWorker()` instance. Query the Cube.dev API for the fields referenced by the config's panels. The worker manages dimensions, groups, and KPI reducers.

2. **Dimension/group wiring per panel** — each panel's slot fields determine which crossfilter dimensions and groups to create:
   - `bar`/`pie`/`funnel`/`selector`: one dimension (from `category`/`name`/`dimension`), one group (reduceCount or reduceSum on `value`)
   - `line`: time dimension (from `x`), group bucketed by granularity
   - `scatter.bubble`: needs multiple measures per record — may require a custom group
   - `heatmap`: two dimensions, cross-tabulated group
   - `sankey`/`graph`/`chord`: two dimensions (source + target), group counting co-occurrences
   - `treemap`/`sunburst`: hierarchical grouping across `levels[]` dimensions
   - `kpi`/`gauge`: `groupAll()` with the appropriate reducer
   - `table`: no group — reads `allFiltered()` directly
   - `toggle`/`range`: dimension only, no group (filter-only)

3. **ECharts initialization per chart type** — each chart family needs a function that takes group data and produces ECharts options:
   - `category` family → `{ xAxis: { type: 'category', data: [...] }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: [...] }] }`
   - `pie` family → `{ series: [{ type: 'pie', data: [...] }] }`
   - `line` family → `{ xAxis: { type: 'time' }, series: [{ type: 'line', data: [...] }] }`
   - `scatter` family → `{ xAxis: { type: 'value' }, yAxis: { type: 'value' }, series: [{ type: 'scatter', data: [...] }] }`
   - `heatmap` → `{ xAxis, yAxis, visualMap, series: [{ type: 'heatmap' }] }`
   - `map` family → requires GeoJSON registration, `{ geo: {...}, series: [{ type: 'scatter', coordinateSystem: 'geo' }] }`
   - `sankey`/`graph`/`chord` → `{ series: [{ type: 'sankey', nodes: [...], links: [...] }] }`
   - `treemap`/`sunburst` → `{ series: [{ type: 'treemap', data: [...hierarchical...] }] }`
   - And so on for all 54 types
   - Each variant's `ecOptions` from `chart-types.js` gets merged into the base options

4. **Click-to-filter wiring** — every chart panel with a dimension gets click handlers that call `dimension.filter()` on the crossfilter worker. ECharts `click` event → extract category value → apply filter → all other panels update.

5. **Data update cycle** — when filters change, all groups re-evaluate. Each panel reads its group's `.all()` or `.value()` and updates its ECharts instance via `setOption()`. The crossfilter `onChange` callback triggers this.

6. **Native controls** — `selector`, `toggle`, `range`, `dropdown` don't use ECharts. They render as DOM elements (Shoelace components) and wire directly to crossfilter dimension filters. `selector` renders a searchable list, `toggle` renders Yes/No/All buttons, `range` renders a noUiSlider, `dropdown` renders a `<sl-select>`.

7. **KPI updates** — `kpi` and `gauge` panels read from `groupAll()` reducers and update on every filter change.

8. **Streaming data** — the crossfilter worker supports streaming ingest. As data arrives, charts update incrementally under the progress overlay.

### Not done — validation module

`demo/schema/validate-config.js` is referenced in the spec but doesn't exist as a standalone file. The validation logic is inline in `test-openai-call.mjs`. Should be extracted into a reusable module that both the test and the builder endpoint can call.

## What the Config Does NOT Control

- Visual styling (colors, fonts, spacing, borders) — engine/theme
- ECharts series options beyond structural variants — engine
- Animation, interaction behavior — engine
- Responsive breakpoints — CSS/container queries
- Click-to-filter wiring — universal engine behavior, not per-panel
