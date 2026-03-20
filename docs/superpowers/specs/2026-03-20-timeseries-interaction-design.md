# Time-Series Interaction — Design Spec

**Date:** 2026-03-20
**Status:** Draft
**Depends on:** [Dashboard Data Wiring](2026-03-19-dashboard-data-wiring-design.md)

## Goal

Make time-series charts fully interactive: single time-slice selection, range brush for crossfiltering, breakdown by an explicitly chosen category dimension, and switchable visualization type. All state persisted in the URL.

## Interactions

### A) Single time-slice click

Click on a data point → selects that one time bucket (one week at current granularity). Acts as `filterExact` on the time dimension. All other panels update to show data for only that time slice.

Click the same point again → deselects (clears the time filter).

**URL:** `stay_started_at=1719187200000` (timestamp of the selected bucket)

### B) Range brush via dataZoom

Drag the dataZoom slider handles or use mouse wheel/drag inside the chart to select a time range. Acts as `filterRange` on the time dimension. All other panels update to show data within that range.

Resetting to full range → clears the time filter.

**URL:** `stay_started_at=1719187200000&stay_started_at=1756080000000` (two values = range)

### C + D) URL persistence

Both single-click selection (one value) and range brush (two values) persist via the standard `filterState` → `writeUrlState` mechanism. The time dimension name is the URL key.

- Single click: `?stay_started_at=1719187200000`
- Range: `?stay_started_at=1719187200000&stay_started_at=1756080000000`
- No selection: parameter absent

On page load, `readUrlState` restores the filter state, the crossfilter applies it, and the dataZoom positions itself to match.

### E + F) Breakdown by active group

Any category panel (bar, pie, selector) can be explicitly selected as the **active breakdown group**. When active:

- The time chart renders **one line per category value** instead of a single aggregate line
- If the breakdown dimension also has an active filter (e.g., only "sightseeing" and "overnight" selected), only those values appear as lines
- If no filter is active on the breakdown dimension, the top N values by count are shown as lines (plus an "Other" aggregate for the rest)

**Activation:** Each category panel's card header gets a subtle "breakdown" toggle (e.g., a small chart icon). Clicking it sets that dimension as the active breakdown. Clicking it again deactivates breakdown.

**Visual indicator:** The active breakdown panel gets a subtle visual treatment — e.g., a thin accent border or a small "breakdown active" badge — that's clear but not heavy.

**URL:** `_breakdown=activity_type-5` (panel ID of the active breakdown)

**Only one breakdown active at a time.** Selecting a new one deactivates the previous.

### Implementation: breakdown group query

When a breakdown is active, the time-series panel needs a **split group** — a crossfilter group that returns `{ key: timestamp, value: { splitKey1: count, splitKey2: count, ... } }`.

This is the same pattern as the stockout demo's `byStoreDay` group with `splitField: 'sold_location'`. The crossfilter dashboard runtime supports this via `splitField` in the group spec.

When breakdown is activated:
1. Remove the old time-series group from the worker query
2. Add a new group with `splitField` set to the breakdown dimension
3. Re-query the worker
4. Render multiple lines from the split values

**Important:** This does NOT require a server reload. The breakdown dimension is already in the crossfilter worker (it's a group-by dim). The split group is a client-side crossfilter operation.

However, the current architecture creates groups at worker initialization time. Adding a split group dynamically requires either:
- (a) Pre-creating split groups for all possible breakdown dimensions (wasteful)
- (b) Disposing and re-creating the worker with the new group config (simple but triggers a mini-reload)
- (c) Using the worker's row query to get all filtered records and aggregating client-side

**Recommended: option (b)** — re-create the worker with the updated group config when breakdown changes. The data is already cached in the Cube response; the worker re-ingests from Arrow. This is a mini-reload but fast since the data is already fetched. Show a subtle loading indicator on the time chart only.

### G) Switchable visualization type

The time-series chart header includes a visualization toggle that cycles through all chart types in the `time` family from the chart registry:

- `line` — basic line
- `line.smooth` — smoothed
- `line.step` — stepped
- `line.area` — area fill
- `line.area.stacked` — stacked areas (only meaningful with breakdown active)
- `line.bump` — bump chart (only meaningful with breakdown active)

**UI:** A small dropdown or icon button group in the card header. Shows the current type.

**URL:** `_timeChart=line.area` (stores the selected variant)

**Rendering:** When the type changes, `renderLineChart` reads the new chart type's `ecOptions` from the registry and applies them (smooth, step, areaStyle, etc.). No data change needed.

### Interaction summary

```
Time chart interactions:
  Click data point  → filterExact(timeDim, timestamp)  → URL + crossfilter
  Drag dataZoom     → filterRange(timeDim, [from, to]) → URL + crossfilter
  Reset zoom        → clearFilter(timeDim)              → URL + crossfilter

Category panel interactions:
  Click breakdown   → set _breakdown=panelId            → URL + re-create worker with split group
  Click again       → clear _breakdown                  → URL + re-create worker without split

Time chart header:
  Change viz type   → set _timeChart=line.area          → URL + re-render (no data change)
```

## URL State Keys

| Key | Values | Effect |
|---|---|---|
| `{timeDim}` | single timestamp or two timestamps | Time filter (click or range) |
| `_breakdown` | panel ID | Which category panel drives the line breakdown |
| `_timeChart` | chart type name | Visualization variant for time-series panels |

## What This Spec Does NOT Cover

- Bubble charts over time with accompanying time selector (mentioned as future)
- Per-component granularity overrides (future)
- Stacked area normalization (future)
- Multiple time-series panels with independent breakdowns (future)
