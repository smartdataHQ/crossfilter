# Dashboard First Principles

These principles govern how we build dashboards with crossfilter2, Cube.dev, and ECharts. They apply to every dashboard we create.

## 1. Performance Architecture

We build superfast dashboards using streaming data, efficient formats, and optimized processing.

- **Arrow IPC streaming** — data arrives as a binary stream, parsed incrementally in a web worker. No JSON parsing, no main-thread blocking.
- **WASM-accelerated filtering** — filter scans run in WebAssembly inside the worker. The JS fallback exists but WASM is always preferred.
- **Worker threads** — all crossfilter processing happens off the main thread. The main thread only renders.
- **Batched queries** — use `query()` with `rowSets` to fetch snapshot + multiple row result sets in a single postMessage round-trip. Never make separate `rows()` calls for data that can be batched.
- **Typed-array transfer** — columnar results use transferable ArrayBuffers (zero-copy from worker to main thread).
- **Progressive loading** — `emitSnapshots: true` renders partial results while data is still streaming in.

## 2. Multi-Crossfilter Strategy

We divide requests into multiple crossfilter workers when that improves performance or enables independent interactions.

- Each worker loads one Cube.dev data source via Arrow streaming.
- Workers are created in parallel — all Arrow streams start simultaneously.
- A single worker handles all panels that share the same filtering context.
- Separate workers are used when:
  - A panel needs an independent filter (e.g., clicking a product filters the DOW chart but not the stockout table).
  - A cube has a fundamentally different data shape (e.g., time-series vs. product-level aggregates).
  - Splitting reduces the column count per Arrow stream, improving transfer and parse time.
- Some dimensions may always be fetched server-side (e.g., `partition`) while others are crossfilter dimensions for client-side filtering.

## 3. Unified Filter Dispatch

Common dimensions are used as filters across multiple crossfilters and server-processed components.

- Shared dimensions (like `sold_location`, `product_category`, `supplier`) exist in every worker that needs them.
- The URL hash is the single source of truth for filter state. Changing the hash dispatches `updateFilters()` to all registered runtimes simultaneously.
- Filter dispatch is instant — no network requests, pure client-side crossfilter operations.
- Non-crossfilter data (e.g., yesterday's stockout events from a direct Cube JSON query) is filtered in JS using the same store/category values from the URL state.
- The filter-router pattern: `URL hash → parseState → buildDashboardFilters → dispatch to N runtimes → re-query → re-render`.

## 4. Consistent Terminology

We use the same terminology for the same things on a dashboard and across multiple dashboards.

- A column that shows the same metric must have the same label everywhere. If "Risk Score" appears in two tables, both say "Risk Score" with the same tooltip.
- Column headers include `title` attributes with full descriptions. Users hover to understand.
- When we shorten labels, we use `<abbr title="...">` tags so the full meaning is always accessible.
- Standardized terms (examples):
  - **Risk Score** — composite score (0-100%) combining frequency, duration, impact, and trend
  - **3-Day Prob** — probability of stockout in the next 3 days from DOW-based forecast
  - **Status** — composite trend signal (Active, Worsening, Improving, Stable)
  - **Duration Δ / Frequency Δ / Impact Δ** — recent-half vs. older-half comparison with directional arrows
  - **Pattern** — stockout character label (Longer, Typical, Rare)

## 5. No Business Logic in Dashboards

We only ever display data on dashboards. We never include business logic or interpretation in the frontend.

- Labels like "Longer", "Rare", "Worsening" come from the Cube model, not from JS code in the dashboard.
- Thresholds, classifications, and scoring formulas belong in the Cube SQL definitions.
- If a dashboard needs a new label or classification, we add it to the Cube model first, then display it.
- This ensures data consistency across all dashboards — every dashboard that shows "risk_score" gets the same value computed the same way.
- The dashboard's job is: fetch, filter, sort, and render. Never compute, classify, or interpret.

**Current violations to fix:** The `labelBadge()` functions in `stockout-table.js` and `risk-chart.js` compute Pattern labels (Longer/Typical/Rare) in JS. These should move to a Cube dimension.

## 6. Discovery Through Interaction

Understandable and intuitive dashboards that allow users to play with and discover information are our specialty.

- Cross-filtering is the primary interaction model. Click a chart element → filter the dashboard.
- Local filters (compact dropdowns, day buttons) let users drill down within a panel without affecting other panels.
- Sortable table headers let users reorder data to find what matters to them.
- Click-to-filter interactions show the selected state clearly (highlighted rows, active buttons, selected pie slices).
- Filter chips show active filters and allow one-click removal.
- URL state makes every view shareable and bookmarkable. Browser back/forward navigates filter history.

## 7. Meaningful Color System

Colors have a meaning. We use them consistently.

| Color | Variable | Meaning | Usage |
|-------|----------|---------|-------|
| Green `#00e68a` | `--accent-green` | Good / low risk / improving | Availability ≥ 85%, risk < 25%, improving trends |
| Amber `#ffb84d` | `--accent-amber` | Warning / moderate | Availability 70-85%, risk 25-50%, watch items |
| Orange `#ff8c4d` | — | Elevated risk | Risk 50-75% |
| Red `#ff4d6a` | `--accent-red` | Critical / high risk / worsening | Availability < 70%, risk ≥ 75%, worsening trends |
| Blue `#4da6ff` | `--accent-blue` | Informational / neutral / selected | Stable trends, selected items, info badges |
| Purple `#b366ff` | `--accent-purple` | Secondary / supplementary | Secondary metrics |

- The same color thresholds apply everywhere. A 75% risk score is red in every table, chart, and badge.
- Directional arrows use: red `↑` = worsening, green `↓` = improving, muted `→` = stable.
- Badge background uses the dim variant (`--accent-red-dim` = `#ff4d6a22`) for subtle coloring.

## 8. Industry-Grounded KPIs

We always research industry KPIs when building dashboards and use them in the models/cubes and on the dashboards.

- Before building a dashboard, research what KPIs are standard in the domain (e.g., retail stockout rate, availability percentage, lost sales estimation).
- Use industry-standard formulas where they exist. Document deviations.
- KPI definitions live in the Cube model, not the dashboard. The dashboard displays them; the Cube computes them.
- When industry KPIs don't exist for a specific use case, define them clearly in the Cube model documentation and apply them consistently.

---

## Architecture Reference

```
┌─────────────────────────────────────────────────────┐
│                    Browser Main Thread               │
│                                                      │
│  URL Hash ──→ Router ──→ Filter Router ──→ Panels   │
│                              │                       │
│                    ┌─────────┼─────────┐             │
│                    ▼         ▼         ▼             │
│              ┌──────┐  ┌──────┐  ┌──────┐           │
│              │Worker│  │Worker│  │Worker│            │
│              │  #1  │  │  #2  │  │  #3  │           │
│              └──┬───┘  └──┬───┘  └──┬───┘           │
│                 │         │         │                │
│           Arrow+WASM Arrow+WASM Arrow+WASM          │
│                 │         │         │                │
└─────────────────┼─────────┼─────────┼───────────────┘
                  │         │         │
                  ▼         ▼         ▼
            ┌─────────────────────────────┐
            │      Cube.dev / Synmetrix    │
            │   (Arrow IPC streaming API)  │
            └─────────────────────────────┘
```

### Per-Refresh Query Pattern

```
Filter change (e.g., store switch)
  │
  ├─→ cf-store.query({ snapshot, rowSets: {A, B, C} })   ← 1 round-trip
  ├─→ cf-warning.rows({ fields, columnar: true })         ← 1 round-trip
  └─→ cf-dow.rows({ fields, columnar: true })             ← 1 round-trip
  │
  └─→ All panels render synchronously from results
```
