# Metadata-Driven Dashboard Engine — Design Spec

## Overview

A generic, config-driven dashboard engine that renders interactive crossfilter-powered dashboards from a declarative config. The config maps Cube.dev model metadata to ECharts visualizations and crossfilter dimensions. Both the available data (Cube `/api/meta`) and the available chart types (ECharts runtime) are discovered on demand — nothing is hardcoded.

**End goal**: An LLM agent accepts a natural language dashboard request, selects the right Cube, and generates a config that this engine renders. The config schema is the structured output contract between the agent and the engine.

## First Principles — UX & Interaction

These are non-negotiable interaction patterns that every component must follow:

1. **Informative selectors** — All pulldowns and selectors use Shoelace `<sl-select>` with searchable items and facet-like totals from crossfilter. Every control communicates data, never just labels.

2. **Clean surfaces, details on demand** — Long text is tucked away. Descriptions, metadata context, and explanations are available via Shoelace `<sl-tooltip>` on `(i)` icons, not inline clutter. The UI stays extra clean.

3. **Bookmarkable state** — All selected parameters, dimensions, filters, and settings are encoded in the URL query string (`?param=value&...`). Every dashboard state is a shareable, bookmarkable URL. Loading a URL restores the exact state across all input types: selects, toggles, range sliders, and period.

4. **Top-X with "Other"** — When showing Top X items (bar charts, lists), always include an X+1 item labeled "Other" that aggregates the remaining values. Top-X limit is adaptive: inferred from metadata `unique_values` cardinality. When all items fit, no "Top X" toggle is shown.

5. **Top-X paired with "Show All"** — A single toggle button switches between "Top X" and "All" — no redundant labels.

6. **Infinite scroll + search for long lists** — Lists with many items use infinite scroll with a search input. No pagination buttons — just scroll and search.

7. **Clear selection state** — Selected items use Shoelace component states (variant="primary" for active toggles, checkmarks in selects). Never ambiguous.

8. **Filters visible and removable** — Active filters are always visible at the top as Shoelace `<sl-tag removable>` chips. Single selections show `"Name: Value"`. Multiple selections consolidate to `"Name (N)"` with a Shoelace tooltip listing all values on hover. Removing a chip syncs back to the corresponding input control.

9. **Dimension group drill-down** — Selecting a dimension group allows the user to break relevant visualizations into the corresponding sub-groups (Top X style).

10. **Responsive everything** — CSS Container Queries for chart cards, KPIs, and filter bars. Viewport media queries for the model bar (container-type breaks dropdown positioning). Components adapt to their own available space.

11. **Meaningful loading progress** — Progress is shown as a frosted overlay (`backdrop-filter: blur(8px)`) on top of the live dashboard. The dashboard renders immediately with skeleton placeholders and updates as data streams in. The overlay shows named steps with checkmarks, then fades away.

12. **Business-user language** — This UI is for business users. Never use technical terms (boolean, dimension, integer, string, null, array). Internal filter keys use clean prefixes (`_focus`, `_include`, `_granularity`) that title-case to human labels in chips.

13. **Visible selected values** — Range controls use noUiSlider dual-handle sliders with `behaviour: 'drag'` (drag the fill to shift the range). Values shown inline beside the track.

14. **Use proven component libraries** — NEVER hand-build standard UI components. These are solved problems. Our stack:
    - **Shoelace** (`@shoelace-style/shoelace` v2.20.1 via CDN) — Primary component library. Cherry-picked: `select`, `option`, `tooltip`, `tag`, `button`, `button-group`, `icon-button`, `badge`. Uses Floating UI internally.
    - **flatpickr** — Date range picker with dual calendar, custom presets bar.
    - **noUiSlider** — Dual-handle range slider with drag behavior.
    - **ECharts 6.0.0** — Charting.

15. **Skeleton placeholders** — Every component renders a skeleton matching its final shape: shimmer bars for bar charts, SVG wave for time series, SVG donut arcs for pie charts, shimmer rows for tables, shimmer items with count bars for lists.

## Design Principles — Architecture

1. **Zero hardcoding** — The engine NEVER references specific field names, labels, segments, or domain-specific content. Everything from config + Cube metadata. The engine works for ANY cube without code changes.
2. **Minimal config** — A valid config is just `{ cube, panels }`. Everything else inferred from metadata.
3. **Enum-based** — Constrained fields use enums so LLM structured output can't go off-rails.
4. **Declarative** — Config describes *what* to show, not *how* to render.
5. **On-demand discovery** — Cube metadata fetched at runtime. No hardcoded lists.
6. **Override anything** — Every inferred default is overridable in the config.
7. **Multi-worker** — Supports multiple crossfilter workers with automatic dimension budgeting and cross-worker filter propagation.
8. **Custom-made feel** — Dynamically generated dashboards look hand-crafted for the dataset.
9. **DRY internals** — Shared helpers for repeated patterns: `titleCase()`, `buildToggleHtml()`, `wireToggleClicks()`, `resetToggleGroup()`, `afterUpdate()`, `getDimDescription()`.

## Model Intelligence Bar

The dashboard surfaces the cube's analytical intelligence as a top-level control surface below the header.

### Structure

```
┌─────────────────────────────────────────────────────────────────┐
│ BLUECAR STAYS (i)                    [2025-01-01 to 2026-03-19] [Weekly ▾] (i) │
├─────────────────────────────────────────────────────────────────┤
│ [All Data ▾] [No filter ▾]  Has Poi Match [Yes][No][All]  ...  │
│                              Is First Stay [Yes][No][All]       │
│                              Stay Duration Hours [0──●────●──100] │
└─────────────────────────────────────────────────────────────────┘
```

**Title line**: Cube title + `(i)` tooltip with description + period selector (flatpickr) + granularity dropdown (sl-select)

**Controls row**: Segments dropdown + boolean include dropdown + inline toggle buttons + range sliders. Panels with `section: "modelbar"` and `layout.location: "modelbar"` render here as inline controls instead of separate cards.

### Auto-discovered from metadata

| Source | Rendering |
|---|---|
| `registry.segments` | `<sl-select>` multi-select dropdown ("All Data" placeholder) |
| Boolean dimensions not in panels | `<sl-select>` multi-select dropdown ("No filter" placeholder) |
| `lc_values` + `unique_values ≤ 12` | `<sl-select>` per facet dimension |
| `cube.description` | `<sl-tooltip>` on `(i)` icon |
| `cube.meta.period` | flatpickr date range with presets |
| `cube.meta.granularity` | `<sl-select>` single-select dropdown |

### Config override

```js
{ modelBar: false }           // hide entirely
{ modelBar: { segments: false, presets: false } }  // selective
```

## Cube Model Metadata Contract

The cube model declares its data characteristics in the cube-level `meta` property, read from `/api/meta`.

```yaml
cubes:
  - name: bluecar_stays
    meta:
      grain: stay_event
      grain_description: One row per car stay (Stop Ended event)
      time_dimension: stay_ended_at
      time_zone: Atlantic/Reykjavik
      partition: bluecar.is
      event_type: Stay Ended
      period:
        earliest: "2025-01-01"
        latest: now
        typical_range: last_12_months
      refresh:
        cadence: hourly
        delay: ~30 minutes behind real-time
        incremental_window: 7 days
      granularity:
        available: [hour, day, week, month, quarter, year]
        default: week
        notes: "Stay events are instantaneous. Hour is the finest useful bucket."
```

All fields optional. Fallbacks:
- `period` absent → uses dimension `min_value`/`max_value` from metadata if available
- `granularity` absent → offers all Cube.dev standard granularities, defaults to `week`
- `typical_range` absent → shows full range

Supported `typical_range`: `last_7_days`, `last_30_days`, `last_90_days`, `last_6_months`, `last_12_months`, `year_to_date`, `all`

## Architecture — Three Layers

### Layer 1: Schema (data wiring)

```js
{
  cube: "bluecar_stays",
  partition: "bluecar.is",
  title: "Iceland Rental Car Stays",
  workers: [{ id: "cf-main", dimensions: [...] }],  // optional
  serverDimensions: ["booking"]  // optional
}
```

### Layer 2: Panels (visualization config)

Minimal: `{ dimension: "activity_type" }` — engine infers everything.

Full panel fields: `dimension|measure`, `chart`, `label`, `limit`, `sort`, `filter`, `granularity`, `op`, `field`, `columns`, `section`, `width`, `collapsed`, `searchable`, `worker`.

### Layer 3: Layout (arrangement)

```js
{
  layout: {
    sections: [
      { id: "kpis", columns: 4 },
      { id: "timeline", columns: 1 },
      { id: "modelbar", location: "modelbar" },  // renders inside model bar
      { id: "overview", label: "Overview", columns: 3 },
      { id: "details", label: "Details", columns: 1 }
    ]
  }
}
```

Sections with `location: "modelbar"` render their panels as inline controls in the model bar instead of separate cards.

## Visual Design

Refined analytics design system in `demo/demo.css`:

- **Surfaces**: Solid white cards (`#ffffff`) with 1px border (`rgba(63,101,135,0.1)`) and subtle shadow (`0 1px 3px rgba(0,21,88,0.04)`). Clean, not glassmorphic.
- **Background**: Gentle gradient (`linear-gradient(160deg, #f0f5fc, #f7f9fd, #f5f8ff)`)
- **5-accent palette**: green (`#00c978`), blue (`#3d8bfd`), amber (`#f5a623`), red (`#ef4565`), purple (`#9b59b6`)
- **Typography**: Lato (400/500/600/700) for text, JetBrains Mono for numbers/dates/timestamps
- **Border radius**: 8px everywhere (consistent, not mixed)
- **KPI cards**: 2px colored top stripe, subtle hover lift (`translateY(-1px)`)
- **Animations**: 0.4s fade-up with d1–d8 staggered delays
- **Container Queries**: Chart cards, KPIs, filter bars adapt to their own width
- **Responsive**: 1024px breakpoint (1-col charts, 3-col KPIs), 640px breakpoint (2-col KPIs, stacked header)

## Component Library Integration

### Shoelace (via CDN)

Loaded as ES modules from `cdn.jsdelivr.net`. Components cherry-picked to minimize payload. Styled via CSS custom properties (`--sl-*`) mapped to our design tokens, plus `::part()` selectors for deeper customization.

```html
<script type="module">
  import { setBasePath } from '.../utilities/base-path.js';
  setBasePath('https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.20.1/cdn');
  import '.../components/select/select.js';
  import '.../components/option/option.js';
  import '.../components/tooltip/tooltip.js';
  import '.../components/tag/tag.js';
  import '.../components/button/button.js';
  import '.../components/button-group/button-group.js';
  import '.../components/icon-button/icon-button.js';
  import '.../components/badge/badge.js';
</script>
```

### Shoelace Design Token Mapping

```css
.ds-select {
  --sl-input-font-family: var(--font-sans);
  --sl-input-font-size-small: 12px;
  --sl-input-height-small: 32px;
  --sl-input-border-radius-small: var(--radius);
  --sl-input-border-color: var(--border);
  --sl-input-border-color-hover: var(--accent-blue);
  --sl-color-primary-600: var(--accent-blue);
  --sl-shadow-large: 0 8px 32px rgba(0, 21, 88, 0.12);
}
```

## File Structure

```
demo/
├── dashboard.html             # Entry point — loads Shoelace, flatpickr, noUiSlider, ECharts, engine
├── dashboard-engine.js        # Core engine: config → DOM, filter state, URL sync, component wiring
├── dashboard-config.js        # bluecar_stays test fixture config
├── dashboard-meta.js          # Cube meta fetcher, registry builder, inference, model meta extraction
├── demo.css                   # Design system — all visual styling
├── echarts-theme.js           # ECharts theme registration
├── chart-utils.js             # Bar chart height/label utilities
├── fetch-cube-meta.mjs        # CLI utility for inspecting Cube metadata
├── proxy-server.mjs           # Dev server: /api/cube, /api/meta proxy
└── source-utils.js            # Data source preferences/sanitization
```

## What This Spec Does NOT Cover (Yet)

- **Fully responsive design (320px–1440px+)** — see `docs/superpowers/specs/2026-03-19-responsive-dashboard-design.md`
- LLM agent config generation flow
- Array/map dimension support (semantic_events cube)
- Geographic map visualizations
- Real-time streaming updates / live data wiring
- Dashboard persistence / sharing
- Multi-cube joins in a single dashboard
- Crossfilter worker integration (data loading, group rendering)
- ECharts chart rendering (bar, line, pie — currently skeleton placeholders only)
