# Demo App Redesign — Stockout Theme Adoption

**Date:** 2026-03-18
**Status:** Approved
**Approach:** Full rewrite of demo CSS, HTML, and ECharts theme

## Goal

Redesign the `demo/` app to match the visual quality of `demo-stockout/`. The demo becomes a focused "Stay Ended" events dashboard with a polished, general-audience feel. Developer internals (source selector, event type picker, perf log, mutation buttons) live behind a collapsible dev drawer.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Theme adoption | Full — stockout palette, fonts, cards | User preference for visual unification |
| Layout | Full-width top-down (drop sidebar) | Matches stockout pattern, cleaner for dashboards |
| Event focus | Pre-filtered to "Stay Ended" | Gives the demo a concrete identity |
| Dev info | Collapsible drawer behind gear icon | Polish for general audience, devs can still access |
| Dimensions | All existing dimensions kept | Same charts, just scoped to Stay Ended |
| DOM contract | Preserve all element IDs | Minimize demo.js changes |

## Design System

Adopt from `demo-stockout/styles.css`:

- **Background:** `#f5f9ff` with `linear-gradient(45deg, #eaf3ff, #f5f9ff, #eaf2ff)`
- **Cards:** `rgba(252, 254, 255, 0.4)` + `backdrop-filter: blur(10px)` + white border + subtle shadow
- **Text:** primary `#000e4a`, secondary `#3f6587`, muted `#99b8cc`
- **Accents:** green `#00c978`, blue `#3d8bfd`, amber `#f5a623`, red `#ef4565`, purple `#9b59b6`
- **Fonts:** Lato (sans), JetBrains Mono (mono)
- **Radii:** 8px, 16px
- **Shadows:** `2px 2px 15px rgba(0, 21, 88, 0.05)`

## Layout

```
HEADER — "Stay Ended Events" + filter chips + gear icon
KPI ROW — 4 cards (count, regions, rows, time window)
TIMELINE — full-width events-over-time with granularity selector
FILTER + CHART GRID — 2-column: narrow filter rail + auto-fit chart grid
DATA TABLE — full-width, sorted
DEV DRAWER — collapsed: source, event type, modes, perf log, actions
```

Max-width 1440px, centered. Staggered fade-up animations.

## Header

- Left: uppercase kicker "CROSSFILTER2 DEMO", bold title "Stay Ended Events"
- Right: active filter chips (blue pills with x dismiss), gear icon for dev drawer

## Dev Drawer

Triggered by gear icon in header. Contains:
- Source selector (Local File / Live API toggle)
- Event type selector (defaults to Stay Ended)
- Mode indicators as small status pills
- Performance log (mono, scrollable)
- Action buttons (Add 1000 Rows, Burst Append 10k, Remove Excluded)
- Cube.dev query display

## Loading Screen

Stockout-style rich loading:
- Centered overlay: "CROSSFILTER2 DEMO" / "Loading data..."
- Elapsed timer, thin progress bar
- Source row with download progress
- Fade-out on complete

## Cards and Charts

Stockout card styling throughout:
- Glass card background with blur
- White border, 16px radius, subtle shadow
- Card header: title + badge, thin bottom border
- KPI cards: colored top accent bars (green, blue, amber, purple)

## ECharts Theme

Rewrite `echarts-theme.js` to match stockout `theme.js`:
- Palette: `['#00c978', '#3d8bfd', '#f5a623', '#ef4565', '#9b59b6', '#00a8c6']`
- Font: Lato
- Tooltip: white background, blur, subtle shadow
- Axis labels: `#3f6587`, no ticks

## Files Changed

| File | Change |
|------|--------|
| `demo/demo.css` | Full rewrite |
| `demo/index.html` | Full rewrite (preserve element IDs) |
| `demo/echarts-theme.js` | Rewrite to stockout palette |
| `demo/demo.js` | Default event filter to "Stay Ended"; update changed class selectors |
| `demo/chart-utils.js` | No change |
| `demo/source-utils.js` | No change |

## DOM Contract

All element IDs in `demo.js` lines 232-295 preserved. Class-based queries mapped:

| Current class | New class |
|---------------|-----------|
| `.chart-grid` | `.chart-grid` (keep) |
| `.filter-clear-btn` | `.filter-clear-btn` (keep) |
| `.gran-btn` | `.gran-btn` (keep) |
| `.mode-btn` | `.mode-btn` (keep) |
| `.table-scroll` | `.table-scroll` (keep) |
| `.loading-text` | `.loading-subtitle` (update in JS) |
| `.header-subtitle` | removed (update in JS) |
| `.kpi-value` | `.kpi-value` (keep) |
| `.kpi-label` | `.kpi-label` (keep) |
| `.picker-placeholder` | `.picker-placeholder` (keep) |
