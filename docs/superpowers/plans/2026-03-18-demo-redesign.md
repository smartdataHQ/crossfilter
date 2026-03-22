# Demo Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the `demo/` app with the stockout theme, full-width layout, Stay Ended focus, and collapsible dev drawer.

**Architecture:** Full rewrite of `demo.css` and `demo/index.html`. Rewrite `echarts-theme.js` to match stockout palette. Minimal `demo.js` changes — preserve all element IDs, update a few class-based selectors, add default "Stay Ended" event filter on init. All dev-facing controls (source selector, event type pills, mode badges, perf log, action buttons) move into a collapsible `<details>` drawer.

**Tech Stack:** HTML, CSS (custom properties), ECharts, existing crossfilter2 demo JS

**Spec:** `docs/superpowers/specs/2026-03-18-demo-redesign-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `demo/demo.css` | Rewrite | Full stockout design system + new layout |
| `demo/index.html` | Rewrite | Full-width top-down layout, same element IDs |
| `demo/echarts-theme.js` | Rewrite | Stockout color palette + Lato font |
| `demo/demo.js` | Modify (~20 lines) | Default event filter, update 2 class selectors, loading text selector |

Files NOT changed: `demo/chart-utils.js`, `demo/source-utils.js`, `demo/proxy-server.mjs`

---

### Task 1: Rewrite `demo/echarts-theme.js`

**Files:**
- Rewrite: `demo/echarts-theme.js`

This is the simplest file and has no dependencies on the others, so it goes first.

- [ ] **Step 1: Rewrite the ECharts theme to match stockout palette**

Replace the entire file with the stockout-aligned theme. Keep the same export interface (`registerDemoEChartsTheme`, `getDemoEChartsThemeName`).

```js
var DEMO_THEME_NAME = 'crossfilter-demo-v7';
var registered = false;

export function registerDemoEChartsTheme(echarts) {
  if (!echarts || registered || typeof echarts.registerTheme !== 'function') {
    return DEMO_THEME_NAME;
  }

  echarts.registerTheme(DEMO_THEME_NAME, {
    backgroundColor: 'transparent',
    textStyle: {
      fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      color: '#3f6587',
    },
    title: {
      textStyle: {
        color: '#000e4a',
        fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: 14,
        fontWeight: 700,
      },
      subtextStyle: {
        color: '#3f6587',
        fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: 11,
      },
    },
    legend: {
      textStyle: {
        color: '#3f6587',
        fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      },
    },
    tooltip: {
      backgroundColor: 'rgba(255,255,255,0.95)',
      borderColor: 'rgba(63,101,135,0.15)',
      textStyle: {
        color: '#000e4a',
        fontFamily: "Lato, Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontSize: 12,
      },
      extraCssText: 'box-shadow: 0 2px 12px rgba(0,21,88,0.08); backdrop-filter: blur(8px); border-radius: 8px;',
    },
    color: ['#00c978', '#3d8bfd', '#f5a623', '#ef4565', '#9b59b6', '#00a8c6'],
    categoryAxis: {
      axisLine: { lineStyle: { color: 'rgba(63,101,135,0.12)' } },
      axisTick: { show: false },
      axisLabel: { color: '#3f6587', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(63,101,135,0.06)' } },
      splitArea: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#3f6587', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(63,101,135,0.06)' } },
      splitArea: { show: false },
    },
    grid: {
      left: 24,
      right: 20,
      top: 20,
      bottom: 24,
      containLabel: false,
    },
  });

  registered = true;
  return DEMO_THEME_NAME;
}

export function getDemoEChartsThemeName() {
  return DEMO_THEME_NAME;
}
```

- [ ] **Step 2: Verify the build still works**

Run: `npm run build`
Expected: clean exit, no errors

- [ ] **Step 3: Commit**

```bash
git add demo/echarts-theme.js
git commit -m "feat(demo): rewrite echarts theme to stockout palette"
```

---

### Task 2: Rewrite `demo/demo.css`

**Files:**
- Rewrite: `demo/demo.css`

Full CSS rewrite adopting the stockout design system. Use `demo-stockout/styles.css` as the primary reference. This is the largest task.

- [ ] **Step 1: Write CSS variables, reset, body, and loading overlay**

Start the file with:

1. **`:root` variables** — Copy all from stockout `styles.css` lines 1-30 (all `--bg-*`, `--border-*`, `--text-*`, `--accent-*`, `--radius`, `--shadow`, `--font-*`)
2. **Reset** — `* { margin: 0; padding: 0; box-sizing: border-box; }`
3. **Body** — `background: var(--bg-gradient)`, `font-family: var(--font-sans)`, `color: var(--text-primary)`, `min-height: 100vh`
4. **Loading overlay** — Adapt stockout lines 42-248: `.loading-overlay` (fixed, centered, z-index 1000), `.loading-header`, `.loading-title` (11px uppercase), `.loading-subtitle` (28px bold), `.loading-elapsed` (11px mono), `.loading-overall-bar` + `.loading-overall-fill`, `.loading-done`, `.fade-out` transition. Simplified to single source (no `.loading-source-row` grid needed).

- [ ] **Step 2: Write layout skeleton — dashboard, header, KPIs, cards**

5. **Dashboard** — `.dashboard { max-width: 1440px; margin: 0 auto; padding: 24px; }`
6. **Header** — Stockout-style flex row: `.header` with border-bottom, `.header-left h1` (12px uppercase muted), `.header-left h2` (28px bold), `.header-right` (flex with gap)
7. **KPI row** — `.kpi-row` 4-column grid with 12px gap, `.kpi` cards with glass background, colored `::before` top bars (`.kpi-green`, `.kpi-blue`, `.kpi-amber`, `.kpi-purple`), `.kpi-value` (28px bold), `.kpi-label` (12px muted)
8. **Cards** — `.card` glass background with blur, white border, 16px radius, shadow. `.card-head` flex with border-bottom. `.card-t` (14px semibold). `.card-filters` flex.

- [ ] **Step 3: Write dev drawer, filter controls, and chart grid styles**

9. **Dev drawer** — `.dev-drawer` card styling. `summary.dev-drawer-summary` as a subtle clickable bar (hide default marker with `list-style: none`). `.dev-drawer-body` flex column with padding and gap. `.dev-drawer-section`, `.dev-drawer-label` (small uppercase), `.dev-drawer-actions` grid, `.dev-badge` (inline pill), `.perf-log` (mono, max-height 200px, overflow-y auto)
10. **Filter-chart row** — `.filter-chart-row { display: grid; grid-template-columns: 280px 1fr; gap: 16px; margin-bottom: 16px; }`. `.filter-rail` sticky card.
11. **Filter controls** — `.filter-controls` flex column. `.filter-group`, `.filter-group-header`, `.filter-label` (12px uppercase). `.filter-input`, `.picker-trigger`, `.picker-dropdown`, `.picker-search`, `.picker-options`, `.picker-option`, `.picker-selected-pills`, `.picker-pill`, `.picker-pill-dismiss`, `.picker-placeholder`, `.picker-arrow`. `.checkbox-list`, `.multiselect-container`, `.range-container`, `.range-input`, `.lat-range`. `.filter-selected-count`. All restyled with stockout colors.
12. **Chart grid** — `.chart-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }`. `.chart-wrap { position: relative; height: 280px; padding: 8px; }`, `.chart-wrap-timeline { height: 340px; }`

- [ ] **Step 4: Write table, buttons, chips, badges, animations, responsive**

13. **Granularity buttons** — `.gran-btns` flex, `.gran-btn` small rounded buttons with blue active state (`.gran-btn--active`)
14. **Pills** — `.pill-group` flex wrap, `.pill` rounded button, `.pill--active` blue filled
15. **Data table** — `.table-scroll` (max-height 380px, overflow-y auto), `.tbl` collapse, `th` sticky with gradient background (like stockout lines 789-837), `td` subtle borders, `tr:hover` highlight
16. **Filter chips** — `.filter-chips` flex wrap, `.filter-chip` blue pill with hover
17. **Buttons** — `.btn` glass background, `.btn-ghost` transparent, `.btn-danger` red, `.btn-icon` minimal padding for gear, `.btn-tiny` small
18. **Group size badges** — `.group-size-badge` (small blue pill like stockout `.card-tag`)
19. **Error banner** — Fixed top center, red background, white text, z-index 2000
20. **Scrollbar** — 4px webkit scrollbar, `var(--border-active)` thumb
21. **Animations** — `@keyframes fadeUp` (opacity + translateY), `@keyframes shimmer`, `.anim` with `.d1`–`.d8` staggered delays (0.05s increments)
22. **Responsive** — `@media (max-width: 1024px)`: filter-chart-row to 1 column, chart-grid to 1 column, KPIs to 3 columns. `@media (max-width: 640px)`: KPIs to 2 columns, header stacks vertically.

- [ ] **Step 5: Commit**

```bash
git add demo/demo.css
git commit -m "feat(demo): rewrite CSS with stockout design system"
```

---

### Task 3: Rewrite `demo/index.html`

**Files:**
- Rewrite: `demo/index.html`

New full-width top-down layout. Every element ID from `demo.js` lines 232-296 must exist. Class-based queries (`.chart-grid`, `.filter-clear-btn`, `.gran-btn`, `.mode-btn`, `.table-scroll`, `.kpi-value`, `.kpi-label`, `.picker-placeholder`) must be present.

- [ ] **Step 1: Write the new HTML**

Structure (all IDs preserved):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crossfilter2 — Stay Ended Events</title>
  <link href="https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700;900&family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="demo.css">
</head>
<body>

<!-- Error banner -->
<div id="error-banner" class="error-banner" hidden></div>

<!-- Loading overlay (stockout-style) -->
<div id="loading-overlay" class="loading-overlay">
  <div class="loading-header">
    <div class="loading-title">CROSSFILTER2 DEMO</div>
    <div class="loading-subtitle">Loading data...</div>
    <div class="loading-elapsed">0.0s</div>
  </div>
  <div class="loading-overall-bar">
    <div class="loading-overall-fill"></div>
  </div>
  <div id="loading-done" class="loading-done" hidden>All data loaded</div>
</div>

<!-- Dashboard -->
<div id="dashboard" class="dashboard">

  <!-- Header -->
  <header class="header anim d1">
    <div class="header-left">
      <h1>CROSSFILTER2 DEMO</h1>
      <h2>Stay Ended Events</h2>
    </div>
    <div class="header-right">
      <div id="filter-chips" class="filter-chips"></div>
      <button id="clear-all-btn" class="btn btn-ghost">Clear All</button>
      <button id="dev-drawer-toggle" class="btn btn-ghost btn-icon" title="Developer tools">&#9881;</button>
    </div>
  </header>

  <!-- Dev drawer (collapsed, opened only via gear button) -->
  <details id="dev-drawer" class="dev-drawer anim d1">
    <summary class="dev-drawer-summary" aria-hidden="true"></summary>
    <div class="dev-drawer-body">
      <div class="dev-drawer-section">
        <div class="dev-drawer-label">Data Source</div>
        <div id="source-selector" class="gran-btns">
          <button data-source="file" class="mode-btn">Local File</button>
          <button data-source="live" class="mode-btn">Live API</button>
        </div>
      </div>
      <div class="dev-drawer-section">
        <div class="dev-drawer-label">Event Type</div>
        <div id="event-pills" class="pill-group"></div>
      </div>
      <div class="dev-drawer-section">
        <div class="dev-drawer-label">Runtime</div>
        <div id="mode-selector" class="gran-btns">
          <button class="mode-btn" type="button">Streaming Arrow</button>
          <button class="mode-btn" type="button">Worker Runtime</button>
          <button class="mode-btn" type="button">WASM Filters</button>
        </div>
        <div class="dev-badges">
          <span id="runtime-badge" class="dev-badge">—</span>
          <span id="stream-status" class="dev-badge">Worker: starting</span>
          <span id="latency-display" class="dev-badge">— ms</span>
          <span id="load-time" class="dev-badge">Load: — ms</span>
        </div>
      </div>
      <div class="dev-drawer-section">
        <div class="dev-drawer-label">Actions</div>
        <div class="dev-drawer-actions">
          <button id="add-rows-btn" class="btn" disabled>Add 1000 Rows</button>
          <button id="burst-append-btn" class="btn" disabled>Burst Append 10k</button>
          <button id="remove-filtered-btn" class="btn btn-danger" disabled>Remove Excluded</button>
        </div>
      </div>
      <details id="query-details" class="dev-drawer-section" style="display:none">
        <summary class="dev-drawer-label">Cube.dev Query</summary>
        <pre id="query-display" class="perf-log"></pre>
      </details>
      <div class="dev-drawer-section">
        <div class="dev-drawer-label">Performance Log</div>
        <pre id="perf-log" class="perf-log"></pre>
      </div>
    </div>
  </details>

  <!-- KPI row -->
  <section class="kpi-row anim d2">
    <div id="kpi-total" class="kpi kpi-green">
      <div class="kpi-label">Total Count</div>
      <div class="kpi-value">—</div>
    </div>
    <div id="kpi-locations" class="kpi kpi-blue">
      <div class="kpi-label">Visible Regions</div>
      <div class="kpi-value">—</div>
    </div>
    <div id="kpi-rows" class="kpi kpi-amber">
      <div class="kpi-label">Row Numbers</div>
      <div class="kpi-value">—</div>
    </div>
    <div id="kpi-timespan" class="kpi kpi-purple">
      <div class="kpi-label">Time Window</div>
      <div class="kpi-value">—</div>
    </div>
  </section>

  <!-- Timeline (full-width) -->
  <section class="card anim d3">
    <div class="card-head">
      <span class="card-t">Events Over Time</span>
      <div class="card-filters">
        <span class="group-size-badge" id="time-granularity-badge"></span>
        <div id="granularity-selector" class="gran-btns">
          <button data-gran="minute" class="gran-btn">Minute</button>
          <button data-gran="hour" class="gran-btn">Hour</button>
          <button data-gran="day" class="gran-btn">Day</button>
          <button data-gran="week" class="gran-btn">Week</button>
          <button data-gran="month" class="gran-btn">Month</button>
        </div>
      </div>
    </div>
    <div id="chart-timeline" class="chart-wrap chart-wrap-timeline"></div>
  </section>

  <!-- Filters + Chart grid (2-column) -->
  <div class="filter-chart-row">

    <!-- Filter rail -->
    <aside class="card filter-rail anim d4">
      <div class="card-head">
        <span class="card-t">Filters</span>
      </div>
      <div class="filter-controls">
        <div class="filter-group">
          <div class="filter-group-header">
            <label class="filter-label">Customer Country</label>
            <button class="filter-clear-btn" data-clear="customer_country" hidden>&times;</button>
          </div>
          <div id="customer-country-picker" class="multiselect-picker">
            <div class="picker-selected-pills" id="customer-country-pills"></div>
            <div class="picker-trigger" id="customer-country-trigger">
              <span class="picker-placeholder">Select countries...</span>
              <span class="picker-arrow">&#9662;</span>
            </div>
            <div class="picker-dropdown" id="customer-country-dropdown" hidden>
              <input type="text" class="picker-search" id="customer-country-search" placeholder="Search countries...">
              <div class="picker-options" id="customer-country-options"></div>
            </div>
          </div>
          <div class="filter-selected-count" id="customer-country-count"></div>
        </div>

        <div class="filter-group">
          <div class="filter-group-header">
            <label class="filter-label">Region</label>
            <button class="filter-clear-btn" data-clear="region" hidden>&times;</button>
          </div>
          <div class="multiselect-container">
            <input type="text" id="region-search" class="filter-input" placeholder="Search regions...">
            <div id="region-checkboxes" class="checkbox-list"></div>
          </div>
          <div class="filter-selected-count" id="region-count"></div>
        </div>

        <div class="filter-group">
          <div class="filter-group-header">
            <label class="filter-label">Time Range</label>
            <button class="filter-clear-btn" data-clear="time" hidden>&times;</button>
          </div>
          <div id="time-range-container" class="range-container">
            <input type="range" id="time-min" class="range-input" step="1">
            <input type="range" id="time-max" class="range-input" step="1">
            <div id="time-range-label" class="range-label">—</div>
          </div>
        </div>

        <div id="latitude-filter-group" class="filter-group">
          <div class="filter-group-header">
            <label class="filter-label">Latitude Range</label>
            <button class="filter-clear-btn" data-clear="latitude" hidden>&times;</button>
          </div>
          <div class="lat-range">
            <input type="number" id="lat-min" class="filter-input filter-input--small" placeholder="Min" step="0.1">
            <span>–</span>
            <input type="number" id="lat-max" class="filter-input filter-input--small" placeholder="Max" step="0.1">
          </div>
        </div>
      </div>
    </aside>

    <!-- Chart grid -->
    <div class="chart-grid">
      <section class="card chart-card anim d4">
        <div class="card-head">
          <span class="card-t">Events by Type</span>
          <span class="group-size-badge" id="event-group-size"></span>
        </div>
        <div id="chart-event" class="chart-wrap"></div>
      </section>
      <section class="card chart-card anim d4">
        <div class="card-head">
          <span class="card-t">Customer Countries</span>
          <span class="group-size-badge" id="cc-group-size"></span>
        </div>
        <div id="chart-customer-country" class="chart-wrap"></div>
      </section>
      <section class="card chart-card anim d5">
        <div class="card-head">
          <span class="card-t">Regions</span>
          <span class="group-size-badge" id="region-group-size"></span>
        </div>
        <div id="chart-region" class="chart-wrap"></div>
      </section>
      <section class="card chart-card anim d5">
        <div class="card-head">
          <span class="card-t">Divisions</span>
          <span class="group-size-badge" id="division-group-size"></span>
        </div>
        <div id="chart-division" class="chart-wrap"></div>
      </section>
      <section class="card chart-card anim d6">
        <div class="card-head">
          <span class="card-t">Municipalities</span>
          <span class="group-size-badge" id="muni-group-size"></span>
        </div>
        <div id="chart-municipality" class="chart-wrap"></div>
      </section>
      <section class="card chart-card anim d6">
        <div class="card-head">
          <span class="card-t">Localities</span>
          <div class="card-filters">
            <button id="locality-sort-toggle" class="btn btn-ghost btn-tiny">Toggle <span id="locality-sort-label">Least Frequent</span></button>
            <span class="group-size-badge" id="loc-group-size"></span>
          </div>
        </div>
        <div id="chart-locality" class="chart-wrap"></div>
      </section>
      <section class="card chart-card anim d7">
        <div class="card-head">
          <span class="card-t">Postal Codes</span>
          <span class="group-size-badge" id="postal-group-size"></span>
        </div>
        <div id="chart-postal" class="chart-wrap"></div>
      </section>
    </div>
  </div>

  <!-- Data table -->
  <section class="card anim d8">
    <div class="card-head">
      <span class="card-t">Data Table</span>
      <div class="card-filters">
        <button id="table-sort-toggle" class="btn btn-ghost btn-tiny">Showing: Most Recent</button>
        <span id="table-row-count" class="group-size-badge"></span>
      </div>
    </div>
    <div class="table-scroll">
      <table id="data-table" class="tbl">
        <thead><tr id="table-head"></tr></thead>
        <tbody id="table-body"></tbody>
      </table>
    </div>
  </section>

</div>

<script src="../crossfilter.js"></script>
<script src="../node_modules/echarts/dist/echarts.min.js"></script>
<script type="module" src="demo.js"></script>

</body>
</html>
```

Notes:
- `<summary>` in dev drawer is empty with `aria-hidden="true"` — the gear button in the header is the only visible toggle
- Runtime `.mode-btn` buttons have NO `mode-btn--active` class — JS owns the state via `initStaticUi()`
- Source `.mode-btn` buttons also start without `mode-btn--active` — JS sets it via `renderSourceButtons()`
- Loading overlay includes `.loading-elapsed` element for the elapsed timer per spec
- Loading overlay includes `.loading-done` element for the completion message

- [ ] **Step 2: Commit**

```bash
git add demo/index.html
git commit -m "feat(demo): rewrite HTML with full-width stockout layout"
```

---

### Task 4: Update `demo/demo.js` for new layout

**Files:**
- Modify: `demo/demo.js:259,267,399-403,2639-2641,2656-2669`

Minimal JS changes to work with the new HTML.

- [ ] **Step 1: Update class-based selectors in `cacheDom()`**

In `cacheDom()` (line ~259), remove the headerSubtitle line:
```js
// DELETE this line:
headerSubtitle: document.querySelector('.header-subtitle'),
```

In `cacheDom()` (line ~267), change:
```js
// OLD
loadingText: document.querySelector('.loading-text'),
// NEW
loadingText: document.querySelector('.loading-subtitle'),
```

- [ ] **Step 2: Update `setLoading` to use hidden attribute + fade-out**

Replace `setLoading()` at ~line 399-404:
```js
function setLoading(visible, text) {
  if (visible) {
    dom.loadingOverlay.removeAttribute('hidden');
    dom.loadingOverlay.classList.remove('fade-out');
    dom.loadingOverlay.style.display = '';
  } else {
    dom.loadingOverlay.classList.add('fade-out');
    setTimeout(function () {
      dom.loadingOverlay.setAttribute('hidden', '');
      dom.loadingOverlay.classList.remove('fade-out');
    }, 500);
  }
  if (text && dom.loadingText) {
    dom.loadingText.textContent = text;
  }
}
```

- [ ] **Step 3: Remove `headerSubtitle` reference in `initStaticUi()`**

At ~line 2639-2641, delete these lines:
```js
if (dom.headerSubtitle) {
  dom.headerSubtitle.textContent = 'Interactive Demo';
}
```

- [ ] **Step 4: Add default "Stay Ended" event filter on init**

In `start()` at ~line 2658, after `await hydrateInitialDataSource();` and before `initStaticUi();`, add:
```js
state.filters[FIELDS.event] = ['Stay Ended'];
```

- [ ] **Step 5: Wire the dev drawer toggle button**

In `attachControlListeners()`, after the existing resize listener (~line 2616), add:
```js
var devDrawerToggle = document.getElementById('dev-drawer-toggle');
var devDrawer = document.getElementById('dev-drawer');
if (devDrawerToggle && devDrawer) {
  devDrawerToggle.addEventListener('click', function () {
    devDrawer.open = !devDrawer.open;
  });
}
```

- [ ] **Step 6: Verify the demo loads**

Open `http://localhost:8081/demo/index.html` in a browser.
Expected: stockout-themed dashboard loads, filtered to Stay Ended, dev drawer collapsed.

- [ ] **Step 7: Commit**

```bash
git add demo/demo.js
git commit -m "feat(demo): update JS for new layout, default Stay Ended filter"
```

---

### Task 5: Integration Testing and Polish

**Files:**
- Possibly modify: `demo/demo.js`, `demo/demo.css`, `demo/index.html`

- [ ] **Step 1: Full functional test**

Open `http://localhost:8081/demo/index.html` and verify:
- Loading overlay appears and fades out
- KPI cards populate with data
- Timeline chart renders
- All 7 dimension charts render in the grid
- Data table populates and scrolls
- Filter controls work (country picker, region search, time range, latitude)
- Filter chips appear in header when filters active
- Clear All button works
- Dev drawer opens/closes via gear icon
- Event pills visible in dev drawer (Stay Ended pre-selected)
- Source selector toggles work
- Perf log shows entries
- Action buttons work when data loaded
- Granularity selector changes timeline

- [ ] **Step 2: Fix any issues found**

Address layout bugs, missing styles, broken selectors.

- [ ] **Step 3: Final commit**

```bash
git add -A demo/
git commit -m "feat(demo): polish and fix integration issues"
```

---

## Execution Order

Tasks are sequential: 1 → 2 → 3 → 4 → 5.

- **Task 1** (echarts theme): Independent, small, goes first
- **Task 2** (CSS): Design foundation — write the full stylesheet
- **Task 3** (HTML): New layout consuming the CSS
- **Task 4** (JS): Minimal tweaks to work with new HTML
- **Task 5** (integration): Test everything end-to-end, fix issues

**Critical path:** Task 2 (CSS) is the most work. Use `demo-stockout/styles.css` as a direct reference — copy patterns, adapt class names where the demo JS depends on them.
