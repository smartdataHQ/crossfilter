# Time-Series Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the line chart a fully interactive time-range selector with click-to-filter, range brush, breakdown by category dimension, and switchable visualization — all URL-persisted.

**Architecture:** The time dimension is already in the crossfilter worker. This plan adds: (1) click handler for single time-slice selection, (2) dataZoom brush for range crossfiltering with URL persistence, (3) a breakdown toggle on category panels that re-creates the worker with a `splitField` group, (4) multi-line rendering from split group data, (5) a visualization type selector in the time chart header.

**Tech Stack:** ECharts dataZoom/click events, crossfilter filterExact/filterRange, chart-types.js `time` family registry.

**Spec:** `docs/superpowers/specs/2026-03-20-timeseries-interaction-design.md`

**Conventions:** ES5 style (`var`, no arrow functions). Zero hardcoded field names. All state in URL via `filterState`.

---

## File Map

| File | Role | Action |
|---|---|---|
| `demo/dashboard-engine.js` | DOM + rendering: line chart click/brush, breakdown toggle UI, viz selector, render multi-line | **Modify** |
| `demo/dashboard-data.js` | Data layer: rebuild worker with split group on breakdown change | **Modify** |
| `demo/chart-types.js` | Chart type registry | Read-only (import `typesByFamily`) |
| `demo/dashboards/bluecar-stays.json` | Test config | No changes needed |

---

### Task 1: Single time-slice click on line chart

Add a click handler to the line chart that selects/deselects a single time bucket. Uses `filterExact` semantics via `setFilter`.

**Files:**
- Modify: `demo/dashboard-engine.js` — update `renderLineChart` and add click wiring in the existing `wireLineBrush` function

- [ ] **Step 1: Add click handler to wireLineBrush**

In `demo/dashboard-engine.js`, the existing `wireLineBrush` function (around line 850) handles `datazoom` events. Add a `click` handler to the same function:

After the `instance.on('datazoom', ...)` block, add:

```javascript
  // Single time-slice click: select/deselect one time bucket
  instance.on('click', function(params) {
    var ts = Array.isArray(params.value) ? params.value[0] : params.value;
    if (ts == null) return;
    ts = Number(ts);

    // Toggle: if already filtered to this exact timestamp, clear
    var current = filterState[dim];
    if (current === ts || current === String(ts) ||
        (Array.isArray(current) && current.length === 1 && Number(current[0]) === ts)) {
      setFilter(dim, null);
    } else {
      setFilter(dim, ts);
    }
  });
```

- [ ] **Step 2: Update renderLineChart to visually mark the selected time slice**

In `renderLineChart`, after building the `seriesData` array, add logic to highlight the selected point. If `filterState[dim]` is a single value (not an array of two), add `markPoint` to the series:

After the `seriesOpts` definition (around line 764), add:

```javascript
  // Highlight selected time slice if single-click active
  if (currentRange && !Array.isArray(currentRange)) {
    var selectedTs = Number(currentRange);
    seriesOpts.markPoint = {
      data: [{ coord: [selectedTs, null], symbol: 'circle', symbolSize: 12 }],
      itemStyle: { color: '#3d8bfd' },
    };
  }
```

- [ ] **Step 3: Test in browser**

Load dashboard. Click a data point on the line chart.
Expected: URL updates with single timestamp, all other panels filter to that week, clicking again clears.

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): single time-slice click on line chart"
```

---

### Task 2: Fix dataZoom brush URL persistence and restore

The dataZoom range should persist in the URL and restore on page load. The current implementation partially works but needs the dataZoom to position itself from URL state on initial render.

**Files:**
- Modify: `demo/dashboard-engine.js` — update `renderLineChart` dataZoom initialization

- [ ] **Step 1: Distinguish single-click vs range in filterState for the time dim**

In `renderLineChart`, update the `currentRange` reading logic to handle both:

```javascript
  var dim = panel._dimField;
  var currentFilter = dim ? filterState[dim] : null;
  var selectedTimestamp = null;  // single click
  var rangeStart = null;        // brush range
  var rangeEnd = null;

  if (currentFilter != null) {
    if (Array.isArray(currentFilter) && currentFilter.length === 2) {
      rangeStart = Number(currentFilter[0]);
      rangeEnd = Number(currentFilter[1]);
    } else {
      selectedTimestamp = Number(Array.isArray(currentFilter) ? currentFilter[0] : currentFilter);
    }
  }
```

Then use `rangeStart`/`rangeEnd` for dataZoom `startValue`/`endValue`, and `selectedTimestamp` for the markPoint.

- [ ] **Step 2: Update wireLineBrush to handle range vs full-range detection**

The existing `wireLineBrush` already has debounced `datazoom` handling. Ensure it correctly detects full range and clears the filter. The `xData` array is available in closure from `renderLineChart` — but since `wireLineBrush` is a separate function, pass it via the panel or store it.

Store the xData range on the panel: `panel._timeRange = { min: xData[0], max: xData[xData.length - 1] };`

Then in `wireLineBrush`, use `panel._timeRange` to detect full range.

- [ ] **Step 3: Test URL persistence**

1. Drag the dataZoom slider to select a range
2. Expected: URL updates with two timestamp values
3. Reload the page
4. Expected: dataZoom restores to the same position, panels show filtered data

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): dataZoom range persists in URL and restores on load"
```

---

### Task 3: Add visualization type toggle to time chart header

Add a small selector in the time chart's card header that lets the user switch between line, smooth, step, area, stacked area, and bump chart types.

**Files:**
- Modify: `demo/dashboard-engine.js` — update `buildPanelCard` for line chart panels, add viz type change handler
- Read: `demo/chart-types.js` — import `typesByFamily`

- [ ] **Step 1: Import typesByFamily**

At the top of `demo/dashboard-engine.js`, update the chart-types import:

```javascript
import { getChartType, typesByFamily } from './chart-types.js';
```

- [ ] **Step 2: Add viz selector to line chart card header**

In `buildPanelCard`, find the `panel.chart === 'line'` branch (around line 1783). Before the `body` assignment, build the header with a viz type selector:

```javascript
  } else if (panel.chart === 'line' || panel._isTimeSeries) {
    // Viz type selector for time-series charts
    var timeTypes = typesByFamily('time');
    var currentTimeChart = filterState['_timeChart'] || panel.chart;
    var vizOptions = '';
    for (var vt = 0; vt < timeTypes.length; ++vt) {
      var tt = timeTypes[vt];
      // Skip stacked/bump if no breakdown (they need multiple series)
      var label = tt.type.replace('line.', '').replace('area.', 'area ') || 'Line';
      if (tt.type === 'line') label = 'Line';
      vizOptions += '<sl-option value="' + tt.type + '">' + escapeHtml(label.charAt(0).toUpperCase() + label.slice(1)) + '</sl-option>';
    }
    headRight += '<sl-select size="small" class="ds-select viz-type-select" data-panel="' + panel.id + '" value="' + currentTimeChart + '" hoist>' + vizOptions + '</sl-select>';

    body = '<div id="chart-' + panel.id + '" class="chart-wrap chart-wrap-timeline">' +
      buildSkeletonLine() +
    '</div>';
```

- [ ] **Step 3: Wire viz type change handler**

After `buildDashboardDOM` is called in `main()`, wire the viz type selects. Add after `wireFilterSheet()`:

```javascript
    // Wire viz type selectors on time charts
    var vizSelects = container.querySelectorAll('.viz-type-select');
    for (var vs = 0; vs < vizSelects.length; ++vs) {
      (function(sel) {
        sel.addEventListener('sl-change', function() {
          filterState['_timeChart'] = sel.value;
          writeUrlState(filterState);
          notifyFilterChange();
        });
      })(vizSelects[vs]);
    }
```

- [ ] **Step 4: Update renderLineChart to apply viz type ecOptions**

In `renderLineChart`, read the active viz type and apply its ecOptions:

```javascript
  var activeChartType = filterState['_timeChart'] || panel.chart;
  var chartDef = getChartType(activeChartType);
  // ... apply chartDef.ecOptions to seriesOpts
```

- [ ] **Step 5: Test viz switching**

Click the viz selector dropdown on the time chart. Switch to "Area". Expected: chart re-renders with area fill. URL updates with `_timeChart=line.area`.

- [ ] **Step 6: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): switchable time-series visualization type"
```

---

### Task 4: Add breakdown toggle to category panel headers

Each bar/pie/selector panel gets a small breakdown toggle button. Clicking it sets that panel's dimension as the active breakdown for the time chart.

**Files:**
- Modify: `demo/dashboard-engine.js` — update `buildPanelCard` to add breakdown button, add handler

- [ ] **Step 1: Add breakdown toggle button to category panel headers**

In `buildPanelCard`, for panels that have a `_groupId` and are in category/control families, add a breakdown toggle button in `headRight`:

```javascript
  // Breakdown toggle for category panels (drives time chart multi-line)
  if (panel._dimField && panel._groupId) {
    var isActiveBreakdown = filterState['_breakdown'] === panel.id;
    headRight += '<sl-button size="small" variant="' + (isActiveBreakdown ? 'primary' : 'text') + '" class="breakdown-toggle" data-panel="' + panel.id + '" data-dim="' + panel._dimField + '" title="Break down time chart by ' + escapeHtml(panel.label) + '">\u2261</sl-button>';
  }
```

(Using `≡` as the icon — a stacked-lines symbol suggesting breakdown/split.)

- [ ] **Step 2: Wire breakdown toggle click handler**

After `wireFilterSheet()` in `main()`, add:

```javascript
    // Wire breakdown toggles on category panels
    container.addEventListener('click', function(e) {
      var btn = e.target.closest('.breakdown-toggle');
      if (!btn) return;
      var panelId = btn.dataset.panel;
      var currentBreakdown = filterState['_breakdown'];
      if (currentBreakdown === panelId) {
        delete filterState['_breakdown'];
      } else {
        filterState['_breakdown'] = panelId;
      }
      writeUrlState(filterState);
      // Update button states
      var allBtns = container.querySelectorAll('.breakdown-toggle');
      for (var b = 0; b < allBtns.length; ++b) {
        allBtns[b].variant = allBtns[b].dataset.panel === filterState['_breakdown'] ? 'primary' : 'text';
      }
      triggerBreakdownChange();
    });
```

- [ ] **Step 3: Add visual indicator on the active breakdown panel**

In `renderAllPanels`, after rendering chart panels, update the card's visual state:

```javascript
  // Update breakdown visual indicators
  var breakdownId = filterState['_breakdown'];
  var allCards = document.querySelectorAll('.chart-card');
  for (var ci = 0; ci < allCards.length; ++ci) {
    allCards[ci].classList.toggle('chart-card--breakdown', allCards[ci].id === 'panel-' + breakdownId);
  }
```

Add a subtle CSS class — for now via inline style or by adding to the existing demo.css.

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): breakdown toggle on category panel headers"
```

---

### Task 5: Re-create worker with split group on breakdown change

When breakdown is activated, re-create the crossfilter worker with an additional `splitField` group on the time dimension. When deactivated, re-create without the split.

**Files:**
- Modify: `demo/dashboard-data.js` — add `setBreakdown(dimField)` method, rebuild worker
- Modify: `demo/dashboard-engine.js` — add `triggerBreakdownChange` function

- [ ] **Step 1: Add setBreakdown to dashboard-data.js public API**

In the returned object from `createDashboardData`, add:

```javascript
    // Set or clear the breakdown dimension for time-series split groups
    setBreakdown: function(breakdownDimField) {
      // Update the scan result's time-series groups to include splitField
      for (var g = 0; g < scanResult.groups.length; ++g) {
        var group = scanResult.groups[g];
        // Find the time-series group (the one with _isTimeSeries panel)
        var matchingPanel = null;
        for (var p = 0; p < resolvedPanels.length; ++p) {
          if (resolvedPanels[p]._groupId === group.id && resolvedPanels[p]._isTimeSeries) {
            matchingPanel = resolvedPanels[p];
            break;
          }
        }
        if (matchingPanel) {
          if (breakdownDimField) {
            group.splitField = breakdownDimField;
          } else {
            delete group.splitField;
          }
        }
      }

      // Re-create the worker with updated groups
      workerHandle.dispose();
      return createWorker(cubeName, scanResult, registry, serverState).then(function(newHandle) {
        workerHandle = newHandle;

        newHandle.on('progress', function(payload) {
          for (var i = 0; i < listeners.progress.length; ++i) listeners.progress[i](payload);
        });
        newHandle.on('ready', function(payload) {
          for (var i = 0; i < listeners.ready.length; ++i) listeners.ready[i](payload);
        });
        newHandle.on('error', function(payload) {
          for (var i = 0; i < listeners.error.length; ++i) listeners.error[i](payload);
        });

        return newHandle.ready;
      });
    },
```

- [ ] **Step 2: Add triggerBreakdownChange to dashboard-engine.js**

After the `triggerServerReload` function, add:

```javascript
function triggerBreakdownChange() {
  if (!_dashboardData) return;
  var breakdownId = filterState['_breakdown'];
  var breakdownDim = null;

  if (breakdownId) {
    // Find the panel and its dimension
    for (var i = 0; i < _dashboardPanels.length; ++i) {
      if (_dashboardPanels[i].id === breakdownId) {
        breakdownDim = _dashboardPanels[i]._dimField;
        break;
      }
    }
  }

  _dashboardData.setBreakdown(breakdownDim).then(function() {
    return _dashboardData.query(filterState);
  }).then(function(response) {
    renderAllPanels(_dashboardPanels, response, _dashboardRegistry);
  }).catch(function(err) {
    console.error('[dashboard] Breakdown change failed:', err);
  });
}
```

- [ ] **Step 3: Test breakdown activation**

1. Click the breakdown toggle on "Activity Type"
2. Expected: button highlights, worker re-creates with splitField
3. Line chart should now receive split group data (handled in Task 6)

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-data.js demo/dashboard-engine.js
git commit -m "feat(dashboard): re-create worker with split group on breakdown change"
```

---

### Task 6: Render multi-line chart from split group data

Update `renderLineChart` to handle both single-line (no breakdown) and multi-line (breakdown active) rendering.

**Files:**
- Modify: `demo/dashboard-engine.js` — update `renderLineChart`

- [ ] **Step 1: Detect split group data format**

The split group returns `{ key: timestamp, value: { splitKey1: { value: N }, splitKey2: { value: N }, ... } }` instead of `{ key: timestamp, value: { value: N } }`.

At the start of `renderLineChart`, detect which format we have:

```javascript
  // Detect if this is split group data (breakdown active)
  var firstEntry = entries[0];
  var isSplit = firstEntry && firstEntry.value && firstEntry.value.value === undefined;
```

- [ ] **Step 2: Build multi-line series from split data**

When `isSplit` is true, collect all split keys and build one series per key:

```javascript
  if (isSplit) {
    // Collect all split keys across all entries
    var splitKeys = {};
    for (var si = 0; si < entries.length; ++si) {
      var sv = entries[si].value;
      for (var sk in sv) splitKeys[sk] = true;
    }

    var seriesList = [];
    var keyNames = Object.keys(splitKeys);

    // If the breakdown dimension has active filters, only show those
    var breakdownId = filterState['_breakdown'];
    var breakdownDim = null;
    for (var bp = 0; bp < (_dashboardPanels || []).length; ++bp) {
      if (_dashboardPanels[bp].id === breakdownId) {
        breakdownDim = _dashboardPanels[bp]._dimField;
        break;
      }
    }
    var activeFilter = breakdownDim ? filterState[breakdownDim] : null;
    if (activeFilter) {
      var filterValues = Array.isArray(activeFilter) ? activeFilter : [activeFilter];
      keyNames = keyNames.filter(function(k) { return filterValues.indexOf(k) >= 0; });
    } else {
      // No filter: show top N by total count
      var keyTotals = {};
      for (var ki = 0; ki < keyNames.length; ++ki) keyTotals[keyNames[ki]] = 0;
      for (var ei = 0; ei < entries.length; ++ei) {
        var ev = entries[ei].value;
        for (var ek in ev) {
          if (ev[ek] && ev[ek].value) keyTotals[ek] += ev[ek].value;
        }
      }
      keyNames.sort(function(a, b) { return (keyTotals[b] || 0) - (keyTotals[a] || 0); });
      keyNames = keyNames.slice(0, 8);  // Top 8
    }

    for (var li = 0; li < keyNames.length; ++li) {
      var lineKey = keyNames[li];
      var lineData = [];
      for (var le = 0; le < entries.length; ++le) {
        var lv = entries[le].value[lineKey];
        lineData.push([entries[le].key, lv ? lv.value : 0]);
      }
      var lineSeries = {
        type: 'line',
        name: lineKey,
        data: lineData,
        showSymbol: false,
      };
      // Apply viz type ecOptions
      if (chartDef && chartDef.ecOptions) {
        if (chartDef.ecOptions.smooth) lineSeries.smooth = true;
        if (chartDef.ecOptions.step) lineSeries.step = chartDef.ecOptions.step;
        if (chartDef.ecOptions.areaStyle) lineSeries.areaStyle = chartDef.ecOptions.areaStyle;
      }
      seriesList.push(lineSeries);
    }

    option.series = seriesList;
    option.legend = { show: true, top: 0, textStyle: { fontSize: 10 } };
  }
```

- [ ] **Step 3: Test multi-line rendering**

1. Click breakdown toggle on "Activity Type"
2. Expected: line chart shows multiple colored lines (sightseeing, overnight, meal, etc.)
3. Click "sightseeing" in the bar chart (filter it)
4. Expected: line chart shows only the "sightseeing" line

- [ ] **Step 4: Commit**

```bash
git add demo/dashboard-engine.js
git commit -m "feat(dashboard): multi-line rendering from split group breakdown"
```

---

### Task 7: End-to-end test and polish

Verify all interactions work together and persist in the URL.

**Files:** None (testing + minor fixes)

- [ ] **Step 1: Test single click + URL**

1. Click a data point → URL has single timestamp → reload → chart marks the point
2. Click again → URL clears → all panels return to unfiltered

- [ ] **Step 2: Test range brush + URL**

1. Drag dataZoom handles → URL has two timestamps → reload → zoom restores
2. Reset to full range → URL clears

- [ ] **Step 3: Test viz type switch + URL**

1. Switch to "Area" → URL has `_timeChart=line.area` → reload → area chart renders
2. Switch to "Step" → chart updates, URL updates

- [ ] **Step 4: Test breakdown + URL**

1. Click breakdown on "Activity Type" → URL has `_breakdown=activity_type-5`
2. Reload → breakdown restores, multi-line chart renders
3. Click "sightseeing" bar → only sightseeing line shown
4. Cmd+click "overnight" → two lines shown
5. Clear breakdown → single line restores

- [ ] **Step 5: Test combined interactions**

1. Set breakdown + zoom range + filter bar chart
2. Reload → all three states restore from URL
3. All panels reflect the combined filters

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix(dashboard): polish time-series interactions after e2e testing"
```
