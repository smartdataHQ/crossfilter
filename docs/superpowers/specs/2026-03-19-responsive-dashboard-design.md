# Responsive Dashboard Engine — Design Spec

## Overview

Transform the metadata-driven dashboard engine (`demo/dashboard.html` + `demo.css` + `dashboard-engine.js`) into a fully responsive application that works from 320px phone to 1440px+ ultrawide. Every component has multiple purpose-built variants that transform — not just shrink — at different container sizes.

**Core principle**: Responsive components are not responsive pages. A responsive page reflows the same components into fewer columns. A responsive component *becomes a different version of itself* — drastically more concise, showing different information density, using a completely different layout. The component at 300px is not a squished version of the component at 800px.

**Architecture**: CSS container queries drive component-level adaptation. Media queries handle page-level macro layout only. Base styles are mobile-first.

## Breakpoint Strategy (Mobile-First)

| Range | Name | Layout |
|---|---|---|
| < 480px | Phone portrait | Single column, bottom sheet filters, stacked KPIs, swipeable chart carousel |
| 480–767px | Phone landscape / large phone | 2-col KPIs, single-col charts, bottom sheet filters |
| 768–1199px | Tablet | 2-col charts, 3-col KPIs, inline model bar (simplified) |
| 1200px+ | Desktop | Full grid per config (3-4 col), full model bar, all controls inline |

All breakpoints are mobile-first (`min-width`). Base CSS = phone layout. Complexity added upward.

### Migration from Current Breakpoints

The existing `demo.css` uses desktop-first `max-width` queries. This spec replaces them entirely with mobile-first `min-width` queries:

| Old (desktop-first) | New (mobile-first) | Behavior Change |
|---|---|---|
| `@media (max-width: 1024px)` → 1-col charts, 3-col KPIs | `@media (min-width: 768px)` → 2-col charts, 3-col KPIs | Tablet threshold shifts from 1024 to 768 — more devices get multi-column |
| `@media (max-width: 640px)` → 2-col KPIs, stacked header/model bar | `@media (min-width: 480px)` → 2-col KPIs | Phone landscape gets 2-col KPIs starting at 480 instead of staying at 640 |
| `@container chartcard (max-width: 280px)` | `@container chartcard (min-width: 300px)` | Inverted: base = minimal, queries add complexity |
| `@container kpicard (max-width: 160px)` | `@container kpicard (min-width: 160px)` | Same threshold, inverted direction |
| `@container filterbar (max-width: 400px)` | `@container filterbar (min-width: 400px)` | Same threshold, inverted direction |

**All existing `max-width` container queries and media queries in `demo.css` lines 1075–1112 will be deleted and replaced.** This is a full rewrite of the responsive section, not an incremental addition.

## CSS Architecture

### Layer Separation

| Concern | Mechanism | Why |
|---|---|---|
| Page macro layout | `@media (min-width)` | Sidebar visibility, main column count, bottom sheet vs inline |
| Component self-adaptation | `@container (min-width)` | KPI variant, chart density, filter layout |
| Fluid sizing within containers | `clamp()` + `cqi` units | Smooth scaling between breakpoints |
| Component state styling | Container style queries | Context-based variants (Chrome/Edge only, progressive) |

### Container Query Contexts

Every component wrapper gets `container: <name> / inline-size`:

| Container Name | Element | Purpose |
|---|---|---|
| `kpicard` | `.kpi` | KPI card variant switching |
| `chartcard` | `.chart-card` | Chart density/legend/controls |
| `filterbar` | `.filter-bar` | Filter control stacking |
| `modelbar` | n/a — uses media queries | Containment clips Shoelace dropdown overlays |
| `kpigrid` | `.kpi-row` | KPI grid column count (see KPI section for rules) |
| `chartgrid` | `.chart-grid` | Chart grid column count (see Chart Carousel section for rules) |

**Model bar exception**: `container-type: inline-size` creates CSS containment which clips absolutely-positioned Shoelace dropdown overlays. The model bar uses viewport media queries instead. This is a known constraint documented in `demo.css`.

### Fluid Sizing Tokens

```css
/* Dashboard-level */
--ds-pad: clamp(12px, 3vw, 24px);

/* Card-level (use cqi inside container contexts) */
--card-pad: clamp(8px, 3cqi, 16px);
--card-title: clamp(11px, 0.7rem + 0.5cqi, 13px);
--kpi-value: clamp(18px, 1rem + 2cqi, 26px);
--kpi-label: clamp(9px, 0.6rem + 0.3cqi, 11px);

/* Spacing */
--section-gap: clamp(8px, 2vw, 16px);
--card-gap: clamp(8px, 1.5vw, 16px);
```

## Component Variants

### KPI Grid — Container-Driven Column Count

The KPI row adapts its column count via container query on the grid container itself:

```css
.kpi-row {
  container: kpigrid / inline-size;
  display: grid;
  gap: 10px;
  grid-template-columns: 1fr; /* base: single column */
}

@container kpigrid (min-width: 480px) {
  .kpi-row { grid-template-columns: repeat(2, 1fr); }
}

@container kpigrid (min-width: 768px) {
  .kpi-row { grid-template-columns: repeat(3, 1fr); }
}

@container kpigrid (min-width: 1000px) {
  .kpi-row { grid-template-columns: repeat(4, 1fr); }
}
```

### Chart Grid — Container-Driven Column Count

```css
.chart-grid {
  container: chartgrid / inline-size;
  display: grid;
  gap: 16px;
  grid-template-columns: 1fr; /* base: single column */
}

@container chartgrid (min-width: 768px) {
  .chart-grid { grid-template-columns: repeat(2, 1fr); }
}

@container chartgrid (min-width: 1200px) {
  .chart-grid { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
}
```

### KPI Cards — 3 Variants

**Expanded** (container >= 250px):
- Current design: label top, big number below, 2px colored top stripe
- Hover lift effect (`translateY(-1px)`)
- Full padding (14px 16px)

**Compact** (container 160–250px):
- Horizontal layout: label left, value right, same row
- Tighter padding (10px 12px)
- Smaller value font
- Colored stripe remains

**Minimal** (container < 160px):
- Pill-shaped inline stat
- Colored dot (6px circle) + value only
- Label accessible via `<sl-tooltip>` on tap/hover
- Minimal padding (6px 10px)
- No hover lift, no stripe

```css
/* Base: minimal (mobile-first) */
.kpi {
  container: kpicard / inline-size;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
}
.kpi-label { /* sr-only or tooltip */ }

/* Compact */
@container kpicard (min-width: 160px) {
  .kpi {
    justify-content: space-between;
    padding: 10px 12px;
  }
  .kpi-label { /* visible, inline */ }
}

/* Expanded */
@container kpicard (min-width: 250px) {
  .kpi {
    flex-direction: column;
    align-items: stretch;
    padding: 14px 16px;
  }
}
```

### Chart Cards — 3 Variants

**Expanded** (container >= 500px):
- Full chart with legend beside or below
- Axis labels and titles visible
- Card header: title + filter controls + show-all toggle
- Full card chrome (border, shadow, rounded corners)

**Compact** (container 300–500px):
- Chart only — legend hidden (or moved to single-line top row)
- Axis titles hidden, tick count reduced
- Compact card header: title only, controls collapsed behind `...` menu or hidden
- Reduced padding

**Minimal** (container < 300px):
- Micro-chart visualization:
  - Time series → sparkline (no axes, no labels)
  - Bar chart → horizontal mini-bars (top 5 only, label + thin bar)
  - Pie chart → single-line "Top: Category (42%)" summary
  - List → top 3 items with counts
  - Table → primary column + value column only
- Title only, no card chrome
- Touch target: entire card tappable to expand to full-screen overlay

```css
.chart-card {
  container: chartcard / inline-size;
}

/* Base: minimal */
.chart-card .card-head { padding: 8px 12px; }
.chart-card .chart-legend { display: none; }
.chart-card .chart-axis-title { display: none; }

/* Compact */
@container chartcard (min-width: 300px) {
  .chart-card .card-head { padding: 10px 14px; }
  .chart-card .chart-wrap { height: 200px; }
}

/* Expanded */
@container chartcard (min-width: 500px) {
  .chart-card .card-head { padding: 12px 16px; }
  .chart-card .chart-legend { display: block; }
  .chart-card .chart-wrap { height: 280px; }
  .chart-card .card-filters { display: flex; }
}
```

### Swipeable Chart Carousel (Phone Only)

At phone widths (< 768px media query), chart sections render as a horizontal scroll-snap carousel instead of a grid:

```css
@media (max-width: 767px) {
  .chart-grid {
    display: flex;
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
    gap: 12px;
    padding-bottom: 8px;
  }
  .chart-grid > .chart-card {
    flex: 0 0 85%;
    scroll-snap-align: center;
  }
}
```

- Each card snaps to center, showing a peek of the next card (signals scrollability)
- Dot indicators below carousel showing position (optional, CSS-only with scroll-timeline if supported)
- Cards use their container-query compact/minimal variants within the carousel

### Model Bar — 2 Variants

**Desktop** (viewport >= 768px):
- Full inline bar: title + (i) tooltip + period picker + granularity dropdown in header row
- Controls row: segments, booleans, facets, toggles, ranges — all inline with flex-wrap
- Current implementation preserved. **Note**: mobile treatment now activates at 768px (was 640px), so devices between 640–767px that previously got inline model bar will now get the mobile split view. This is intentional — the inline model bar is too cramped below 768px.

**Mobile** (viewport < 768px):
Split into two surfaces:

**1. Sticky compact header bar:**
```
┌──────────────────────────────────────────┐
│ BLUECAR STAYS    [Jan 1 – Mar 19] [W ▾] │
│                         [Filters (3)]    │
└──────────────────────────────────────────┘
```
- Fixed to top on scroll (`position: sticky; top: 0`)
- Title (truncated if needed) + period trigger + granularity select
- "Filters" button with active filter count badge
- Compact: 48px height, z-index above content

**2. Bottom sheet filter drawer** (opened by Filters button):
- Slides up from bottom, 85vh max-height
- Semi-transparent backdrop (`rgba(0,0,0,0.3)`)
- Rounded top corners (16px)
- Drag handle at top (visual affordance)
- Inside: accordion sections, one per filter group:
  - Segments (multi-select checkboxes)
  - Boolean dimensions (toggle switches)
  - Facet dimensions (searchable checkbox lists)
  - Range filters (full-width sliders)
- Sticky footer: "Close" (primary) + "Clear All" (ghost) buttons
- Filters apply **live** as selections change (consistent with crossfilter's incremental model — no batching)
- Active filter count updates live in the sheet header and on the trigger badge
- Close: tap backdrop, swipe down, or tap X

```css
.filter-sheet {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
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
.filter-sheet-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.3);
  z-index: 999;
}
```

### Filter Chips — 2 Variants

**Desktop** (viewport >= 768px):
- Current: horizontal flex-wrap in header-right, all chips visible as `<sl-tag removable>`

**Mobile** (< 768px):
- Single row, horizontal scroll (no wrap)
- If > 3 active filters: show "N active" summary badge + horizontal scroll of chips
- Tapping a chip removes it (same as desktop)
- Tapping the summary badge opens the filter bottom sheet

### Data Tables — 2 Variants

**Desktop** (container >= 500px):
- Current scrollable table with sticky header

**Compact** (container < 500px):
- **3-4 columns**: Frozen first column (`position: sticky; left: 0`) + horizontal scroll
  - Right-edge fade gradient signals more content
  - Minimum column width: 100px
- **5+ columns**: Card-per-row layout
  - Primary column becomes card title/header
  - Remaining columns become label:value pairs stacked vertically
  - Each card has bottom border separator

### List Panels (Dimension Value Lists) — 2 Variants

**Desktop** (container >= 400px):
- Current: inline within card, search input + scrollable list with count bars

**Mobile** (container < 400px):
- List stays inline but more compact:
  - Tighter padding (4px 10px per item)
  - Count bars thinner (2px instead of 3px)
  - Search input: 44px height for touch
  - Max-height reduced to 240px
  - Items: 44px minimum height for touch targets
- For panels inside the filter bottom sheet: full-width accordion sections

### Section Headers — Mobile Enhancement

All sections become collapsible (not just `collapsed: true` sections). The engine's `buildSectionEl()` wraps every section in a `<details>` with a `card-head card-head--toggle` summary. On mobile, these summaries become sticky:

```css
/* Existing class from dashboard-engine.js buildSectionEl() */
.card-head--toggle {
  position: sticky;
  top: 48px; /* below sticky mobile header */
  z-index: 5;
  background: var(--bg-gradient);
}
```

- Tap to collapse/expand section content (native `<details>` behavior)
- Chevron indicator (rotates on collapse)
- Sticky on scroll (stacks below mobile header bar)

### Toggle Button Groups

Toggle button groups (`.pill-group`, Yes/No/All buttons) adapt at narrow widths:

```css
/* Base: compact pills */
.pill-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

/* Inside filter bar at narrow widths: full-width rows */
@container filterbar (max-width: 400px) {
  .pill-group { gap: 2px; }
  .pill { flex: 1; text-align: center; min-height: 44px; }
}
```

### Loading Popover — Mobile Adjustment

The loading popover (280px wide, fixed bottom-right) needs repositioning at phone widths:

```css
@media (max-width: 479px) {
  .loading-popover {
    right: 8px;
    left: 8px;
    width: auto; /* full-width with margins */
  }
}
```

### Progress Overlay — Mobile Adjustment

```css
@media (max-width: 479px) {
  .progress-overlay .progress-steps {
    min-width: auto;
    margin: 0 16px;
    width: calc(100% - 32px);
  }
}
```

### Location Grid

The 2-column dimension browsing grid stacks to single column on mobile (currently handled at 640px, moves to container query):

```css
.location-grid {
  container: locgrid / inline-size;
  display: grid;
  grid-template-columns: 1fr;
}

@container locgrid (min-width: 500px) {
  .location-grid { grid-template-columns: repeat(2, 1fr); }
}
```

## Touch Targets

| Element | Minimum Size | Implementation |
|---|---|---|
| Buttons, chips, tags | 44x44px | Min-height + padding |
| Dropdown/select triggers | 48px height | `--sl-input-height-small: 48px` on mobile |
| Slider handles | 48px touch area | Invisible expanded hit area |
| List items | 44px height | `min-height: 44px` |
| Card tap targets | 44px minimum | Natural from padding |
| Adjacent target spacing | 8px minimum | `gap` properties |

Mobile touch target overrides:
```css
@media (max-width: 767px) {
  .ds-select { --sl-input-height-small: 48px; }
  .dim-list-item, .dim-item { min-height: 44px; }
  .pill { min-height: 36px; padding: 8px 14px; }
  .btn { min-height: 44px; }
  .gran-btn { min-height: 44px; padding: 8px 12px; }
}
```

## New Components

### 1. Bottom Sheet (`filter-sheet`)

A slide-up drawer for mobile filter controls.

**Structure:**
```html
<div class="filter-sheet-backdrop" hidden></div>
<div class="filter-sheet" aria-modal="true" role="dialog">
  <div class="filter-sheet-handle"></div>
  <div class="filter-sheet-header">
    <span class="filter-sheet-title">Filters</span>
    <span class="filter-sheet-count">3 active</span>
    <button class="filter-sheet-close" aria-label="Close">&times;</button>
  </div>
  <div class="filter-sheet-body">
    <!-- Accordion sections per filter group (Shoelace for consistency) -->
    <sl-details summary="Segments" open>
      <div class="filter-sheet-section-body">...</div>
    </sl-details>
  </div>
  <div class="filter-sheet-footer">
    <sl-button variant="primary" size="small">Close</sl-button>
    <sl-button variant="text" size="small">Clear All</sl-button>
  </div>
</div>
```

**Behavior:**
- Opens via "Filters" button in sticky mobile header
- Closes via: backdrop tap, X button, swipe down (optional JS), Close button
- Body scrollable, footer sticky
- Accordion sections use `<sl-details>` (Shoelace) for consistent styling with the rest of the UI
- Filter controls inside are the same Shoelace components, just stacked vertically

### 2. Swipeable Carousel

CSS scroll-snap based, applied to the existing `.chart-grid` element via media query. No new wrapper needed — no JS library needed.

The `.chart-grid` class already exists in the engine. At phone widths, the media query switches it from `display: grid` to `display: flex` with scroll-snap (see "Swipeable Chart Carousel" section above). On tablet+ it remains a grid.

### 3. Sticky Mobile Header

```html
<div class="mobile-header">
  <div class="mobile-header-title">BLUECAR STAYS</div>
  <div class="mobile-header-controls">
    <button class="period-trigger">Jan 1 – Mar 19</button>
    <sl-select class="ds-select" size="small"><!-- granularity --></sl-select>
    <button class="filter-trigger">
      Filters <sl-badge pill>3</sl-badge>
    </button>
  </div>
</div>
```

- `position: sticky; top: 0; z-index: 50`
- Only visible at < 768px (media query)
- Replaces the full model bar header on mobile
- Period + granularity controls are moved here from model bar
- Filter button triggers the bottom sheet

## Implementation Notes

### dashboard-engine.js Changes

1. **Bottom sheet generation**: New function to build filter sheet DOM from the same registry data currently used by model bar
2. **Mobile header generation**: Extract period + granularity controls into a separate sticky header at mobile widths
3. **Carousel mode**: When building chart grids, apply carousel class at mobile widths (CSS handles the layout switch)
4. **ECharts resize**: Add `ResizeObserver` on each chart container to call `chart.resize()` when container queries trigger layout changes
5. **Filter sync**: Bottom sheet filter changes must sync with inline model bar controls (same crossfilter dimensions)

### demo.css Changes

1. **Rewrite to mobile-first**: Invert all breakpoints from `max-width` to `min-width`
2. **Add container query contexts**: Every component wrapper gets `container: name / inline-size`
3. **Add fluid sizing**: Replace fixed values with `clamp()` + `cqi`
4. **Add bottom sheet styles**: New component
5. **Add carousel styles**: Scroll-snap rules
6. **Add touch target overrides**: Mobile minimum sizes
7. **Add sticky header styles**: Mobile header bar

### What Does NOT Change

- `dashboard-config.js` — config format unchanged, no responsive config needed
- `dashboard-meta.js` — metadata layer unchanged
- `dashboard.html` — no structural changes needed (all DOM is engine-generated)
- Design system tokens (colors, fonts, shadows, radius) — unchanged
- Shoelace component usage — same components, just resized

## File Impact

| File | Change Type | Scope |
|---|---|---|
| `demo/demo.css` | Major rewrite | Mobile-first rewrite, container queries, new components |
| `demo/dashboard-engine.js` | Moderate additions | Bottom sheet, mobile header, carousel mode, ResizeObserver |
| `demo/dashboard.html` | No change | — |
| `demo/dashboard-config.js` | No change | — |
| `demo/dashboard-meta.js` | No change | — |

## Success Criteria

1. Dashboard renders correctly and is fully usable at 320px, 480px, 768px, 1024px, 1440px
2. Every component has distinct expanded/compact/minimal variants (not just "smaller")
3. All interactive elements meet 44px minimum touch target on mobile
4. Filter controls accessible via bottom sheet on mobile, inline on desktop
5. Chart carousel works with scroll-snap on phone widths
6. Period + granularity always visible on mobile (sticky header)
7. No horizontal overflow at any width
8. Fluid typography and spacing scale smoothly between breakpoints
9. Existing desktop design is preserved — changes are additive
