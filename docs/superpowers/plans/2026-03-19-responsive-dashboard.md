# Responsive Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard engine fully responsive from 320px to 1440px+ with container-query-driven component variants, a mobile bottom sheet for filters, and a swipeable chart carousel.

**Architecture:** CSS-first approach — mobile-first base styles with `min-width` media queries for page layout and `@container` queries for component adaptation. JS changes limited to generating new mobile-only DOM elements (sticky header, bottom sheet) and wiring ResizeObserver for chart containers. All existing desktop behavior preserved.

**Tech Stack:** CSS Container Queries, CSS Scroll Snap, Shoelace Web Components (`sl-details` added), flatpickr, noUiSlider, ECharts (ResizeObserver)

**Spec:** `docs/superpowers/specs/2026-03-19-responsive-dashboard-design.md`

**Testing approach:** This is a CSS-heavy visual project. Each task ends with browser verification at 320px, 768px, and 1440px using Chrome DevTools responsive mode. No unit tests — visual inspection is the test.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `demo/demo.css` | Major rewrite (lines 1066–1112 replaced, new sections added) | All responsive CSS — container queries, media queries, fluid tokens, new components |
| `demo/dashboard-engine.js` | Moderate additions (~150 lines) | Mobile header DOM, bottom sheet DOM, ResizeObserver wiring, Shoelace `sl-details` import |
| `demo/dashboard.html` | Minor addition (1 line) | Add `sl-details` Shoelace import |

**Files NOT changed:** `dashboard-config.js`, `dashboard-meta.js`, `echarts-theme.js`, `chart-utils.js`, `source-utils.js`

---

### Task 1: Add Shoelace `sl-details` Import

**Files:**
- Modify: `demo/dashboard.html:30` (add import line after `badge.js`)

This component is needed for the bottom sheet filter accordion sections.

- [ ] **Step 1: Add the import**

In `demo/dashboard.html`, after line 30 (`import '.../badge/badge.js';`), add:

```js
  import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.20.1/cdn/components/details/details.js';
```

- [ ] **Step 2: Verify page loads without errors**

Open `dashboard.html` in browser. Check DevTools console — no import errors.

- [ ] **Step 3: Commit**

```bash
git add demo/dashboard.html
git commit -m "feat: add Shoelace sl-details import for filter accordion"
```

---

### Task 2: CSS Foundation — Mobile-First Rewrite & Fluid Tokens

**Files:**
- Modify: `demo/demo.css` — lines 1066–1112 (delete and replace), lines 7–36 (add tokens), lines 148–152 (fluid dashboard padding), lines 196–201 (KPI row base)

This is the foundation — rewrite the responsive section to mobile-first and add fluid sizing tokens. All subsequent tasks build on this.

- [ ] **Step 1: Add fluid sizing CSS custom properties**

In `demo/demo.css`, inside the `:root` block (after line 35, before the closing `}`), add:

```css
  /* Fluid responsive tokens */
  --ds-pad: clamp(12px, 3vw, 24px);
  --section-gap: clamp(8px, 2vw, 16px);
  --card-gap: clamp(8px, 1.5vw, 16px);
```

- [ ] **Step 2: Apply fluid dashboard padding**

Replace the fixed `.dashboard` padding (line 152):

```css
/* Old: padding: 20px 24px; */
/* New: */
.dashboard {
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--ds-pad);
}
```

- [ ] **Step 3: Delete old responsive section**

Delete the entire block from `/* ── Container Queries` comment through the end of file (lines 1066–1112). This removes all old `@container` and `@media` rules.

- [ ] **Step 4: Write new mobile-first responsive foundation**

Append to the end of `demo/demo.css`:

```css
/* ── Responsive Design — Mobile-First ──────────────────────────────── */
/* Base styles = phone layout. Complexity added upward via min-width.  */
/* Components adapt via @container queries, page via @media queries.   */

/* Container contexts — every component wrapper is a query container */
.kpi-row    { container: kpigrid / inline-size; }
.kpi        { container: kpicard / inline-size; }
.chart-card { container: chartcard / inline-size; }
.filter-bar { container: filterbar / inline-size; }
.location-grid { container: locgrid / inline-size; }

/* ── Page-level media queries (macro layout) ─────────────────────── */

/* Phone landscape+ (480px): 2-col KPIs */
@media (min-width: 480px) {
  .kpi-row { grid-template-columns: repeat(2, 1fr); }
}

/* Tablet (768px): multi-column grids, full model bar */
@media (min-width: 768px) {
  .kpi-row { grid-template-columns: repeat(3, 1fr); }
  .chart-grid { grid-template-columns: repeat(2, 1fr); }
}

/* Desktop (1200px): full grid */
@media (min-width: 1200px) {
  .kpi-row { grid-template-columns: repeat(4, 1fr); }
  .chart-grid { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
}
```

- [ ] **Step 5: Update KPI row base to single-column mobile-first**

Replace the `.kpi-row` rule (lines 196–201):

```css
.kpi-row {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--card-gap, 10px);
  margin-bottom: var(--section-gap, 16px);
}
```

- [ ] **Step 6: Update chart-grid base to single-column mobile-first**

Replace the `.chart-grid` rule (lines 371–376):

```css
.chart-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--card-gap, 16px);
  margin-bottom: var(--section-gap, 16px);
}
```

- [ ] **Step 7: Verify at 320px, 768px, 1440px**

Open dashboard in Chrome DevTools responsive mode. Check:
- 320px: single column everything, KPIs stacked
- 768px: 3-col KPIs, 2-col charts
- 1440px: 4-col KPIs, auto-fit charts (same as before)

- [ ] **Step 8: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): mobile-first foundation — fluid tokens, container contexts, page breakpoints"
```

---

### Task 3: KPI Card Container Query Variants

**Files:**
- Modify: `demo/demo.css` — KPI styles (lines 203–245) and new responsive section

KPI cards get 3 variants: minimal (base), compact (160px+), expanded (250px+).

- [ ] **Step 1: Rewrite KPI base styles to mobile-first minimal variant**

Replace `.kpi` styles (lines 203–245) with:

```css
/* KPI card — mobile-first: minimal pill variant */
.kpi {
  background: var(--bg-card-solid);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  position: relative;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 21, 88, 0.04);
}

.kpi::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 6px; height: 6px;
  border-radius: 50%;
  top: 50%; transform: translateY(-50%); left: 8px;
}

.kpi.kpi-green::before  { background: var(--accent-green); }
.kpi.kpi-blue::before   { background: var(--accent-blue); }
.kpi.kpi-amber::before  { background: var(--accent-amber); }
.kpi.kpi-red::before    { background: var(--accent-red); }
.kpi.kpi-purple::before { background: var(--accent-purple); }

.kpi-label {
  font-family: var(--font-sans);
  font-size: clamp(9px, 0.6rem + 0.3cqi, 11px);
  font-weight: 500;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.kpi-value {
  font-family: var(--font-sans);
  font-size: clamp(18px, 1rem + 2cqi, 26px);
  font-weight: 700;
  line-height: 1;
  color: var(--text-primary);
  letter-spacing: -0.02em;
}
```

- [ ] **Step 2: Add KPI container query variants**

Append to the responsive section at end of file:

```css
/* ── KPI card variants ─────────────────────────────────────────────── */

/* Minimal (base): pill — colored dot + value, label hidden */
.kpi .kpi-label { display: none; }
.kpi::before {
  width: 6px; height: 6px; border-radius: 50%;
  position: static; transform: none; flex-shrink: 0;
}

/* Compact (160px+): horizontal — label left, value right */
@container kpicard (min-width: 160px) {
  .kpi {
    justify-content: space-between;
    padding: 10px 12px;
  }
  .kpi .kpi-label { display: block; }
  .kpi::before {
    position: absolute;
    top: 0; left: 0; right: 0;
    width: auto; height: 2px;
    border-radius: 0;
    transform: none;
  }
}

/* Expanded (250px+): stacked — label top, big number below, hover lift */
@container kpicard (min-width: 250px) {
  .kpi {
    flex-direction: column;
    align-items: stretch;
    padding: 14px 16px;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .kpi:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0, 21, 88, 0.06); }
  .kpi .kpi-label { margin-bottom: 6px; }
}
```

- [ ] **Step 3: Verify KPI variants**

In Chrome DevTools responsive mode:
- 320px: KPIs should be minimal pills (dot + value, no label)
- 480px: 2-col, compact variant (label + value side by side)
- 1200px: 4-col, expanded variant (stacked, hover lift)

- [ ] **Step 4: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): KPI card 3-variant container queries — minimal/compact/expanded"
```

---

### Task 4: Chart Card Container Query Variants

**Files:**
- Modify: `demo/demo.css` — chart card styles and responsive section

- [ ] **Step 1: Add chart card container query variants**

Append to the responsive section at end of `demo/demo.css`:

```css
/* ── Chart card variants ───────────────────────────────────────────── */

/* Base (minimal): compact header, hide legend and card controls */
.chart-card .card-head { padding: 8px 12px; }
.chart-card .card-filters { display: none; }
.chart-card .show-all-toggle { display: none; }
.chart-card .dim-list-toggle { display: none; }

/* Compact (300px+): show chart at reduced height */
@container chartcard (min-width: 300px) {
  .chart-card .card-head { padding: 10px 14px; }
  .chart-card .chart-wrap { height: 200px; }
}

/* Expanded (500px+): full chrome — legend, controls, full height */
@container chartcard (min-width: 500px) {
  .chart-card .card-head { padding: 12px 16px; }
  .chart-card .card-filters { display: flex; }
  .chart-card .show-all-toggle { display: inline-flex; }
  .chart-card .dim-list-toggle { display: inline-flex; }
  .chart-card .chart-wrap { height: 280px; }
}
```

- [ ] **Step 2: Verify chart card variants**

In responsive mode:
- 320px: single-col, compact headers, no controls visible
- 768px: 2-col grid, compact variant
- 1200px: auto-fit, full expanded cards with all controls

- [ ] **Step 3: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): chart card 3-variant container queries — minimal/compact/expanded"
```

---

### Task 5: Chart Carousel (Phone Widths)

**Files:**
- Modify: `demo/demo.css` — responsive section

At phone widths, chart grids become horizontal scroll-snap carousels.

- [ ] **Step 1: Add carousel CSS**

Append to the responsive section:

```css
/* ── Chart carousel (phone only) ───────────────────────────────────── */
@media (max-width: 767px) {
  .chart-grid {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    gap: 12px;
    padding-bottom: 8px;
    /* Hide scrollbar but keep scroll */
    scrollbar-width: none;
  }
  .chart-grid::-webkit-scrollbar { display: none; }
  .chart-grid > .chart-card {
    flex: 0 0 85%;
    scroll-snap-align: center;
    margin-bottom: 0;
  }
  .chart-grid .card { margin-bottom: 0; }
}
```

- [ ] **Step 2: Verify carousel at 320px**

Swipe horizontally — cards should snap to center, showing a peek of the next card. Verify scroll-snap behavior is smooth.

- [ ] **Step 3: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): swipeable chart carousel with CSS scroll-snap at phone widths"
```

---

### Task 6: Filter Bar & Toggle Group Container Queries

**Files:**
- Modify: `demo/demo.css` — responsive section

- [ ] **Step 1: Add filter bar and toggle group responsive rules**

Append to the responsive section:

```css
/* ── Filter bar variants ───────────────────────────────────────────── */

/* Base: stacked controls */
.filter-bar-controls { flex-direction: column; gap: 8px; }
.filter-bar-item--range { max-width: none; }

/* Wide (400px+): inline controls */
@container filterbar (min-width: 400px) {
  .filter-bar-controls { flex-direction: row; gap: 16px; }
  .filter-bar-item--range { max-width: 300px; }
}

/* ── Toggle button groups ──────────────────────────────────────────── */
@container filterbar (max-width: 399px) {
  .pill-group { gap: 2px; }
  .pill { flex: 1; text-align: center; min-height: 44px; }
}
```

- [ ] **Step 2: Verify filter bar at narrow/wide widths**

- [ ] **Step 3: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): filter bar and toggle group container query variants"
```

---

### Task 7: Location Grid, List Panels, Tables — Container Queries

**Files:**
- Modify: `demo/demo.css` — replace `.location-grid` media query, add list/table responsive rules

- [ ] **Step 1: Replace location grid media query with container query**

Delete the existing `@media (max-width: 640px) .location-grid` rule (was around line 485–487) and add to responsive section:

```css
/* ── Location grid ─────────────────────────────────────────────────── */
/* Base: single column */
.location-grid { grid-template-columns: 1fr; }

@container locgrid (min-width: 500px) {
  .location-grid { grid-template-columns: repeat(2, 1fr); }
}
```

- [ ] **Step 2: Add list panel compact variant**

```css
/* ── List panels — compact on narrow containers ────────────────────── */
.dim-list-panel .dim-item { min-height: 44px; }
.dim-list-panel .dim-search { min-height: 44px; }

@container chartcard (min-width: 400px) {
  .dim-list-panel .dim-item { min-height: auto; }
}
```

- [ ] **Step 3: Add table responsive variant**

```css
/* ── Tables — horizontal scroll with frozen first column on narrow ── */
@container chartcard (max-width: 499px) {
  .table-scroll { overflow-x: auto; }
  .tbl th:first-child,
  .tbl td:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--bg-card-solid);
  }
  .table-scroll::after {
    content: '';
    position: absolute;
    top: 0; right: 0; bottom: 0;
    width: 24px;
    background: linear-gradient(to left, rgba(255,255,255,0.8), transparent);
    pointer-events: none;
  }
  .table-scroll { position: relative; }
}
```

- [ ] **Step 4: Verify at 320px**

Check location grid is single-column, list items have touch-friendly height, table first column freezes on scroll.

- [ ] **Step 5: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): location grid, list panel, and table container query variants"
```

---

### Task 8: Touch Targets & Small Component Adjustments

**Files:**
- Modify: `demo/demo.css` — responsive section

- [ ] **Step 1: Add touch target overrides for mobile**

Append to responsive section:

```css
/* ── Touch targets (mobile) ────────────────────────────────────────── */
@media (max-width: 767px) {
  .ds-select { --sl-input-height-small: 48px; }
  .dim-list-item, .dim-item { min-height: 44px; display: flex; align-items: center; }
  .pill { min-height: 36px; padding: 8px 14px; }
  .btn { min-height: 44px; }
  .gran-btn { min-height: 44px; padding: 8px 12px; }
  .mode-btn { min-height: 44px; padding: 8px 12px; }
}

/* ── Loading popover — full-width on phone ─────────────────────────── */
@media (max-width: 479px) {
  .loading-popover {
    right: 8px;
    left: 8px;
    width: auto;
  }
}

/* ── Progress overlay — narrower card on phone ─────────────────────── */
@media (max-width: 479px) {
  .progress-overlay .progress-steps {
    min-width: auto;
    margin: 0 16px;
    width: calc(100% - 32px);
  }
}
```

- [ ] **Step 2: Verify touch targets at 375px**

All buttons, pills, list items should be at least 44px tall. Loading popover should span full width with margins.

- [ ] **Step 3: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): touch targets, loading popover, and progress overlay mobile adjustments"
```

---

### Task 9: Header & Model Bar Mobile Layout

**Files:**
- Modify: `demo/demo.css` — header and model bar responsive rules

- [ ] **Step 1: Add header mobile-first responsive rules**

Replace the old header media query (was in deleted section) with new rules in responsive section:

```css
/* ── Header — stacks on phone ──────────────────────────────────────── */
.header {
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}

@media (min-width: 768px) {
  .header {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 0;
  }
}

/* ── Filter chips — horizontal scroll on mobile ────────────────────── */
@media (max-width: 767px) {
  .filter-chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding-bottom: 4px;
  }
  .filter-chips::-webkit-scrollbar { display: none; }
}
```

- [ ] **Step 2: Add model bar mobile-first responsive rules**

```css
/* ── Model bar — stacks on mobile, inline on tablet+ ──────────────── */
.model-bar-header {
  flex-direction: column;
  gap: 8px;
}
.model-bar-controls {
  flex-direction: column;
  align-items: stretch;
}
.model-bar-inline {
  padding-left: 0;
  border-left: none;
}
.period-control {
  flex-direction: column;
  gap: 4px;
  align-items: stretch;
}

@media (min-width: 768px) {
  .model-bar-header {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .model-bar-controls {
    flex-direction: row;
    align-items: center;
    gap: 10px;
  }
  .model-bar-inline {
    padding-left: 12px;
    border-left: 1px solid rgba(63, 101, 135, 0.08);
  }
  .model-bar-inline:first-child { padding-left: 0; border-left: none; }
  .period-control {
    flex-direction: row;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
  }
}
```

- [ ] **Step 3: Verify header and model bar**

- 320px: header stacks, model bar controls stack vertically, filter chips scroll horizontally
- 768px: header is row, model bar is inline, filter chips wrap

- [ ] **Step 4: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): header and model bar mobile-first layout"
```

---

### Task 10: Section Headers — Sticky + Collapsible on Mobile

**Files:**
- Modify: `demo/demo.css` — responsive section

- [ ] **Step 1: Add sticky collapsible section headers**

```css
/* ── Section headers — sticky on mobile ────────────────────────────── */
@media (max-width: 767px) {
  .card-head--toggle {
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--bg-card-solid);
    backdrop-filter: blur(8px);
  }
}
```

- [ ] **Step 2: Verify sticky behavior at 320px**

Scroll within a section — the section header should stick below the top of the viewport.

- [ ] **Step 3: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): sticky collapsible section headers on mobile"
```

---

### Task 11: Bottom Sheet Filter Drawer — CSS

**Files:**
- Modify: `demo/demo.css` — new component styles

- [ ] **Step 1: Add bottom sheet CSS**

Append to `demo/demo.css`:

```css
/* ── Bottom sheet filter drawer (mobile) ───────────────────────────── */
.filter-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 999;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.3s ease;
}
.filter-sheet-backdrop.open {
  opacity: 1;
  pointer-events: auto;
}

.filter-sheet {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  max-height: 85vh;
  background: var(--bg-card-solid);
  border-radius: 16px 16px 0 0;
  box-shadow: 0 -8px 40px rgba(0, 21, 88, 0.15);
  transform: translateY(100%);
  transition: transform 0.3s ease;
  z-index: 1000;
  display: flex;
  flex-direction: column;
}
.filter-sheet.open { transform: translateY(0); }

.filter-sheet-handle {
  width: 36px; height: 4px;
  background: var(--border-active);
  border-radius: 2px;
  margin: 8px auto;
  flex-shrink: 0;
}

.filter-sheet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.filter-sheet-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
}

.filter-sheet-count {
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}

.filter-sheet-close {
  appearance: none;
  background: none;
  border: none;
  font-size: 20px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px 8px;
  min-height: 44px;
  min-width: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.filter-sheet-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
  -webkit-overflow-scrolling: touch;
}

.filter-sheet-body sl-details {
  --sl-spacing-medium: 12px;
  border-bottom: 1px solid var(--border);
}
.filter-sheet-body sl-details::part(header) {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  padding: 12px 16px;
}
.filter-sheet-body sl-details::part(content) {
  padding: 0 16px 12px;
}

.filter-sheet-section-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filter-sheet-footer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
  background: var(--bg-card-solid);
}
.filter-sheet-footer sl-button { flex: 1; }

/* Mobile header filter trigger */
.filter-trigger {
  appearance: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 14px;
  background: var(--bg-card-solid);
  font-family: var(--font-sans);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: border-color 0.15s;
}
.filter-trigger:hover { border-color: var(--accent-blue); }
```

- [ ] **Step 2: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): bottom sheet filter drawer CSS"
```

---

### Task 12: Sticky Mobile Header — CSS

**Files:**
- Modify: `demo/demo.css` — new component styles

- [ ] **Step 1: Add mobile header CSS**

Append to `demo/demo.css`:

```css
/* ── Sticky mobile header ──────────────────────────────────────────── */
.mobile-header {
  display: none; /* hidden on tablet+ */
}

@media (max-width: 767px) {
  .mobile-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    position: sticky;
    top: 0;
    z-index: 50;
    background: rgba(255, 255, 255, 0.92);
    backdrop-filter: blur(16px);
    padding: 8px var(--ds-pad, 12px);
    border-bottom: 1px solid var(--border);
    margin: 0 calc(-1 * var(--ds-pad, 12px));
    width: calc(100% + 2 * var(--ds-pad, 12px));
  }

  .mobile-header-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-secondary);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 40%;
  }

  .mobile-header-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .mobile-header .period-trigger {
    font-size: 10px;
    padding: 4px 10px;
    min-height: 36px;
  }

  .mobile-header .ds-select {
    --sl-input-height-small: 36px;
    --sl-input-font-size-small: 10px;
    max-width: 80px;
  }

  /* Hide desktop model bar on mobile — mobile header replaces it */
  .model-bar { display: none; }
  /* Re-show on tablet+ */
}

@media (min-width: 768px) {
  .model-bar { display: block; }
}
```

- [ ] **Step 2: Commit**

```bash
git add demo/demo.css
git commit -m "feat(responsive): sticky mobile header CSS"
```

---

### Task 13: Bottom Sheet & Mobile Header — JS DOM Generation

**Files:**
- Modify: `demo/dashboard-engine.js` — add new functions, modify `buildDashboardDOM()`

This is the main JS task. We need to:
1. Generate mobile header DOM
2. Generate bottom sheet DOM
3. Wire open/close behavior
4. Sync filter count badge

- [ ] **Step 1: Add `buildMobileHeader()` function**

Add after `buildHeader()` function (after line ~367 in `dashboard-engine.js`):

```js
function buildMobileHeader(config, registry, timePanelInfo) {
  var el = document.createElement('div');
  el.className = 'mobile-header';

  var title = (config.title || registry.cube?.title || registry.cube?.name || '').toUpperCase();

  var periodHtml = '';
  if (timePanelInfo) {
    periodHtml = '<button class="period-trigger" id="mobile-period-trigger"></button>';
  }

  var granOpts = '';
  var granList = (registry.cube?.meta?.granularity?.available) || ['day','week','month','quarter','year'];
  var granDefault = (registry.cube?.meta?.granularity?.default) || 'week';
  granList.forEach(function(g) {
    granOpts += '<sl-option value="' + g + '"' + (g === granDefault ? ' selected' : '') + '>' +
      g.charAt(0).toUpperCase() + g.slice(1) + '</sl-option>';
  });

  el.innerHTML =
    '<div class="mobile-header-title">' + title + '</div>' +
    '<div class="mobile-header-controls">' +
      periodHtml +
      '<sl-select class="ds-select" size="small" value="' + granDefault + '" id="mobile-gran-select">' +
        granOpts +
      '</sl-select>' +
      '<button class="filter-trigger" id="filter-trigger">' +
        'Filters <sl-badge pill variant="primary" id="filter-count-badge">0</sl-badge>' +
      '</button>' +
    '</div>';

  return el;
}
```

- [ ] **Step 2: Add `buildFilterSheet()` function**

Add after `buildMobileHeader()`:

```js
function buildFilterSheet(registry) {
  var backdrop = document.createElement('div');
  backdrop.className = 'filter-sheet-backdrop';
  backdrop.id = 'filter-sheet-backdrop';

  var sheet = document.createElement('div');
  sheet.className = 'filter-sheet';
  sheet.id = 'filter-sheet';
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('role', 'dialog');

  sheet.innerHTML =
    '<div class="filter-sheet-handle"></div>' +
    '<div class="filter-sheet-header">' +
      '<span class="filter-sheet-title">Filters</span>' +
      '<span class="filter-sheet-count" id="filter-sheet-count"></span>' +
      '<button class="filter-sheet-close" id="filter-sheet-close" aria-label="Close">&times;</button>' +
    '</div>' +
    '<div class="filter-sheet-body" id="filter-sheet-body"></div>' +
    '<div class="filter-sheet-footer">' +
      '<sl-button variant="primary" size="small" id="filter-sheet-close-btn">Close</sl-button>' +
      '<sl-button variant="text" size="small" id="filter-sheet-clear">Clear All</sl-button>' +
    '</div>';

  return { backdrop: backdrop, sheet: sheet };
}
```

- [ ] **Step 3: Add `wireFilterSheet()` function**

```js
function wireFilterSheet() {
  var backdrop = document.getElementById('filter-sheet-backdrop');
  var sheet = document.getElementById('filter-sheet');
  var trigger = document.getElementById('filter-trigger');
  if (!backdrop || !sheet || !trigger) return;

  function openSheet() {
    backdrop.classList.add('open');
    sheet.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    backdrop.classList.remove('open');
    sheet.classList.remove('open');
    document.body.style.overflow = '';
  }

  trigger.addEventListener('click', openSheet);
  backdrop.addEventListener('click', closeSheet);

  var closeBtn = document.getElementById('filter-sheet-close');
  var closeBtnFooter = document.getElementById('filter-sheet-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeSheet);
  if (closeBtnFooter) closeBtnFooter.addEventListener('click', closeSheet);
}
```

- [ ] **Step 4: Add `updateFilterCount()` helper**

```js
function updateFilterCount() {
  var chips = document.querySelectorAll('#filter-chips sl-tag');
  var count = chips.length;
  var badge = document.getElementById('filter-count-badge');
  var sheetCount = document.getElementById('filter-sheet-count');
  if (badge) badge.textContent = count;
  if (sheetCount) sheetCount.textContent = count > 0 ? count + ' active' : '';
}
```

- [ ] **Step 5: Integrate into `buildDashboardDOM()`**

In `buildDashboardDOM()` (line ~1064), after the model bar is appended (around line 1116), add:

```js
  // Mobile header + filter sheet
  var mobileHeader = buildMobileHeader(config, registry, timePanelInfo);
  container.insertBefore(mobileHeader, container.children[1]); // after desktop header

  var filterSheetParts = buildFilterSheet(registry);
  document.body.appendChild(filterSheetParts.backdrop);
  document.body.appendChild(filterSheetParts.sheet);
```

- [ ] **Step 6: Wire filter sheet after DOM is built**

In the `main()` function, after `buildDashboardDOM()` is called and the model bar is wired, add:

```js
  wireFilterSheet();
```

- [ ] **Step 7: Call `updateFilterCount()` in `renderFilterChips()`**

In `renderFilterChips()` (around line 319, end of function), add:

```js
  updateFilterCount();
```

- [ ] **Step 8: Verify at 320px**

- Mobile header should appear with title, period, granularity, and Filters button
- Desktop model bar should be hidden
- Tapping Filters opens bottom sheet with backdrop
- Tapping backdrop or Close dismisses sheet
- Filter count badge updates when filters are added/removed

- [ ] **Step 9: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(responsive): mobile header, bottom sheet filter drawer, and filter count sync"
```

---

### Task 14: Populate Bottom Sheet with Filter Controls

**Files:**
- Modify: `demo/dashboard-engine.js` — populate `filter-sheet-body` with model bar controls

The bottom sheet body needs to mirror the model bar's filter controls — segments, booleans, facets, toggles, ranges — using Shoelace `<sl-details>` accordion sections.

- [ ] **Step 1: Add `populateFilterSheet()` function**

Add after `wireFilterSheet()`:

```js
function populateFilterSheet(registry, inlinePanels) {
  var body = document.getElementById('filter-sheet-body');
  if (!body) return;
  body.innerHTML = '';

  // Segments
  if (registry.segments && registry.segments.length > 0) {
    var segHtml = '<sl-details summary="Segments" open>' +
      '<div class="filter-sheet-section-body">' +
      buildDropdown('sheet-segments', '', 'All Data', registry.segments, true) +
      '</div></sl-details>';
    body.insertAdjacentHTML('beforeend', segHtml);
  }

  // Boolean dimensions
  var boolDims = registry.booleanDimensions || [];
  if (boolDims.length > 0) {
    var boolOpts = boolDims.map(function(d) {
      return { value: d.name, label: titleCase(d.name.replace(/_/g, ' ')) };
    });
    var boolHtml = '<sl-details summary="Include">' +
      '<div class="filter-sheet-section-body">' +
      buildDropdown('sheet-booleans', '', 'No filter', boolOpts, true) +
      '</div></sl-details>';
    body.insertAdjacentHTML('beforeend', boolHtml);
  }

  // Inline panels (toggles, ranges, facets)
  inlinePanels.forEach(function(panel) {
    var label = panel.label || titleCase((panel.dimension || '').replace(/_/g, ' '));
    var content = '';

    if (panel.chart === 'toggle') {
      content = '<div class="filter-sheet-section-body">' +
        '<div class="pill-group" data-dim="' + panel.dimension + '">' +
        buildToggleHtml(panel.dimension) + '</div></div>';
    } else if (panel.chart === 'range') {
      content = '<div class="filter-sheet-section-body">' +
        buildRangeSelector('sheet-range-' + panel.dimension, label, false) +
        '</div>';
    } else {
      content = '<div class="filter-sheet-section-body">' +
        buildDropdown('sheet-' + panel.dimension, '', label, [], true) +
        '</div>';
    }

    body.insertAdjacentHTML('beforeend',
      '<sl-details summary="' + label + '">' + content + '</sl-details>');
  });
}
```

- [ ] **Step 2: Call `populateFilterSheet()` in `buildDashboardDOM()`**

After the filter sheet parts are appended to the body, add:

```js
  populateFilterSheet(registry, inlinePanels);
```

- [ ] **Step 3: Wire Clear All button**

In `wireFilterSheet()`, add after the close button wiring:

```js
  var clearBtn = document.getElementById('filter-sheet-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      // Reset all filters by clicking the clear-all button if it exists
      var clearAll = document.getElementById('clear-all');
      if (clearAll) clearAll.click();
    });
  }
```

- [ ] **Step 4: Verify bottom sheet content at 320px**

Open bottom sheet — should show accordion sections with filter controls. Expanding sections reveals dropdowns, toggles, and range sliders.

- [ ] **Step 5: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(responsive): populate bottom sheet with model bar filter controls"
```

---

### Task 15: ResizeObserver for ECharts

**Files:**
- Modify: `demo/dashboard-engine.js` — add ResizeObserver wiring

Chart containers change size when container queries fire. ECharts needs JS notification to resize.

- [ ] **Step 1: Add `wireChartResize()` function**

Add to `dashboard-engine.js`:

```js
function wireChartResize() {
  var chartWraps = document.querySelectorAll('.chart-wrap');
  if (!chartWraps.length || typeof ResizeObserver === 'undefined') return;

  var ro = new ResizeObserver(function(entries) {
    entries.forEach(function(entry) {
      var instance = echarts.getInstanceByDom(entry.target);
      if (instance) {
        instance.resize();
      }
    });
  });

  chartWraps.forEach(function(wrap) {
    ro.observe(wrap);
  });
}
```

- [ ] **Step 2: Call `wireChartResize()` in `main()`**

After all charts are initialized (at the end of `main()`, after the progress overlay fades), add:

```js
  wireChartResize();
```

- [ ] **Step 3: Verify chart resizing**

Toggle Chrome DevTools responsive mode between widths — charts should resize without visual glitches.

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(responsive): ResizeObserver for ECharts container query resize"
```

---

### Task 16: Final Visual Verification & Polish

**Files:**
- Modify: `demo/demo.css` — any remaining adjustments found during testing

- [ ] **Step 1: Full verification sweep**

Test in Chrome DevTools responsive mode at each breakpoint. Check every item:

| Width | Verify |
|---|---|
| 320px | Single-col KPIs (minimal pills), chart carousel swipes, mobile header visible, model bar hidden, bottom sheet opens, touch targets 44px+ |
| 375px | Same as 320 but more breathing room |
| 480px | 2-col KPI grid (compact variant), carousel still active |
| 768px | 3-col KPIs (expanded), 2-col charts, mobile header hidden, model bar visible, no carousel |
| 1024px | Same as 768 but wider |
| 1200px | 4-col KPIs, auto-fit chart grid |
| 1440px | Max-width container, same as 1200 |

- [ ] **Step 2: Fix any issues found**

Common fixes:
- Overflow-x on `body` or `.dashboard` — add `overflow-x: hidden` if needed
- z-index conflicts between sticky header and Shoelace dropdowns
- Chart height too short at compact — adjust `chart-wrap` min-height

- [ ] **Step 3: Final commit**

```bash
git add demo/demo.css demo/dashboard-engine.js
git commit -m "fix(responsive): visual polish and edge case fixes from verification sweep"
```

---

## Task Dependency Graph

```
Task 1 (sl-details import)
    │
Task 2 (CSS foundation) ← everything depends on this
    │
    ├── Task 3 (KPI variants)
    ├── Task 4 (chart card variants)
    ├── Task 5 (carousel)
    ├── Task 6 (filter bar variants)
    ├── Task 7 (location/list/table)
    ├── Task 8 (touch targets)
    ├── Task 9 (header/model bar layout)
    ├── Task 10 (section headers)
    │
    ├── Task 11 (bottom sheet CSS)
    │   └── Task 13 (bottom sheet JS) → Task 14 (populate sheet)
    │
    ├── Task 12 (mobile header CSS)
    │   └── Task 13 (mobile header JS)
    │
    └── Task 15 (ResizeObserver)
         │
    Task 16 (final verification)
```

Tasks 3–12 can run in parallel after Task 2. Tasks 13–14 require 11+12. Task 15 is independent. Task 16 is last.
