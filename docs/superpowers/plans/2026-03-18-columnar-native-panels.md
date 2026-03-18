# Columnar-Native Panel Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all unnecessary `columnarToRows()` materialization in demo-stockout panels so columnar data from crossfilter workers is consumed natively — matching the canonical demo/demo.js pattern.

**Architecture:** Add columnar utility functions to `helpers.js` that operate on `{columns, length}` data with index arrays. Panels store raw columnar data and an index array (filtered/sorted subset). Row objects are only materialized for the final rendered subset (typically 10-50 visible table rows). Pure-aggregation panels (DOW, KPIs) never touch row objects.

**Tech Stack:** Vanilla ES5 (matching codebase conventions), no external deps. The columnar utilities follow crossfilter's own columnar conventions (`{columns, fields, length}`).

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `demo-stockout/panels/helpers.js` | Modify | Add columnar utility functions; keep `columnarToRows` for backward compat |
| `demo-stockout/panels/dow-pattern.js` | Modify | Pure columnar aggregation, zero row objects |
| `demo-stockout/panels/stockout-table.js` | Modify | Columnar filter/sort/slice, materialize only visible rows |
| `demo-stockout/panels/forecast.js` | Modify | Columnar filter/sort/slice, materialize only visible rows |
| `demo-stockout/panels/risk-chart.js` | Modify | Columnar filter/sort/top-10, materialize only 10 rows |
| `demo-stockout/panels/early-warning.js` | Modify | Columnar filter/sort/slice, materialize only visible rows; fix sort lookup |
| `demo-stockout/app-ops.js` | Modify | Replace top-level 50K `columnarToRows` with columnar-native `collectMatching` |
| `test/demo-columnar-helpers.test.js` | Create | Unit tests for columnar utilities |

---

### Task 1: Add columnar utility functions to helpers.js

**Files:**
- Modify: `demo-stockout/panels/helpers.js`
- Create: `test/demo-columnar-helpers.test.js`

These utilities operate on raw `{columns, length}` data with index arrays, avoiding row-object materialization.

- [ ] **Step 1: Write tests for columnar utilities**

Create `test/demo-columnar-helpers.test.js`:

```js
import { describe, it, expect } from 'vitest';
import {
  getColumns, filterIndices, sortIndices, materializeRows,
  countByColumn, sumColumn
} from '../demo-stockout/panels/helpers.js';

var SAMPLE = {
  columns: {
    product: ['Milk', 'Bread', 'Eggs', 'Cheese', 'Butter'],
    risk_score: [0.9, 0.3, 0.7, 0.5, 0.1],
    is_active: [true, false, true, false, true],
    category: ['Dairy', 'Bakery', 'Eggs', 'Dairy', 'Dairy'],
  },
  length: 5,
};

describe('getColumns', function () {
  it('normalizes {columns, length} result', function () {
    var c = getColumns(SAMPLE);
    expect(c.columns).toBe(SAMPLE.columns);
    expect(c.length).toBe(5);
  });
  it('normalizes nested .columns.columns', function () {
    var c = getColumns({ columns: SAMPLE.columns });
    expect(c.length).toBe(5);
  });
  it('returns empty for null', function () {
    var c = getColumns(null);
    expect(c.length).toBe(0);
  });
});

describe('filterIndices', function () {
  it('filters by predicate on columns', function () {
    var indices = filterIndices(SAMPLE.columns, SAMPLE.length, function (cols, i) {
      return cols.is_active[i] === true;
    });
    expect(Array.from(indices)).toEqual([0, 2, 4]);
  });
  it('returns empty for no matches', function () {
    var indices = filterIndices(SAMPLE.columns, SAMPLE.length, function () { return false; });
    expect(indices.length).toBe(0);
  });
});

describe('sortIndices', function () {
  it('sorts descending by numeric field', function () {
    var indices = [0, 1, 2, 3, 4];
    sortIndices(indices, SAMPLE.columns, 'risk_score', -1);
    expect(Array.from(indices)).toEqual([0, 2, 3, 1, 4]);
  });
  it('sorts ascending by string field', function () {
    var indices = [0, 1, 2, 3, 4];
    sortIndices(indices, SAMPLE.columns, 'product', 1);
    expect(Array.from(indices)).toEqual([2, 1, 4, 3, 0]);
  });
});

describe('materializeRows', function () {
  it('materializes only the given indices', function () {
    var rows = materializeRows(SAMPLE.columns, [0, 2]);
    expect(rows).toHaveLength(2);
    expect(rows[0].product).toBe('Milk');
    expect(rows[1].product).toBe('Eggs');
  });
  it('materializes with field projection', function () {
    var rows = materializeRows(SAMPLE.columns, [0], ['product', 'risk_score']);
    expect(Object.keys(rows[0])).toEqual(['product', 'risk_score']);
  });
});

describe('countByColumn', function () {
  it('counts values in field across indices', function () {
    var counts = countByColumn(SAMPLE.columns, [0, 2, 3, 4], 'category');
    expect(counts).toEqual({ Dairy: 3, Eggs: 1 });
  });
});

describe('sumColumn', function () {
  it('sums numeric column across indices', function () {
    var sum = sumColumn(SAMPLE.columns, [0, 2, 4], 'risk_score');
    expect(sum).toBeCloseTo(1.7);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run test/demo-columnar-helpers.test.js`
Expected: FAIL — functions not exported yet

- [ ] **Step 3: Implement columnar utilities in helpers.js**

Add to `demo-stockout/panels/helpers.js` (replace the existing `columnarToRows` section):

```js
// ---- Columnar utilities ----
//
// These operate on raw {columns, length} data with index arrays.
// Row objects are only created by materializeRows() for the final
// visible subset. This matches the canonical demo/demo.js pattern.

// Normalize any query result to { columns, length }.
export function getColumns(result) {
  if (!result || typeof result !== 'object') return { columns: {}, length: 0 };
  var cols = result.columns && typeof result.columns === 'object' ? result.columns : result;
  var keys = Object.keys(cols);
  var length = result.length != null ? result.length
    : (keys.length && cols[keys[0]] ? cols[keys[0]].length || 0 : 0);
  return { columns: cols, length: length };
}

// Return array of indices where predicate(columns, index) is true.
export function filterIndices(columns, length, predicate) {
  var indices = [];
  for (var i = 0; i < length; ++i) {
    if (predicate(columns, i)) indices.push(i);
  }
  return indices;
}

// Sort an array of indices in-place by column values.
export function sortIndices(indices, columns, field, direction) {
  var col = columns[field];
  if (!col) return indices;
  var dir = direction || -1;
  indices.sort(function (a, b) {
    var av = col[a], bv = col[b];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    av = av == null ? '' : av;
    bv = bv == null ? '' : bv;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
  return indices;
}

// Materialize only the given indices into row objects.
// Optional fields array limits which fields are copied.
export function materializeRows(columns, indices, fields) {
  var keys = fields || Object.keys(columns);
  var rows = new Array(indices.length);
  for (var i = 0; i < indices.length; ++i) {
    var row = {};
    var idx = indices[i];
    for (var k = 0; k < keys.length; ++k) {
      var col = columns[keys[k]];
      row[keys[k]] = col ? col[idx] : undefined;
    }
    rows[i] = row;
  }
  return rows;
}

// Count occurrences of each value in a column, scoped to indices.
export function countByColumn(columns, indices, field) {
  var col = columns[field];
  if (!col) return {};
  var counts = {};
  for (var i = 0; i < indices.length; ++i) {
    var v = col[indices[i]];
    if (v != null && v !== '') counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

// Sum a numeric column across the given indices.
export function sumColumn(columns, indices, field) {
  var col = columns[field];
  if (!col) return 0;
  var sum = 0;
  for (var i = 0; i < indices.length; ++i) {
    var v = Number(col[indices[i]]);
    if (v === v) sum += v; // NaN check
  }
  return sum;
}

// Legacy: full materialization. Keep for backward compat but prefer
// filterIndices + materializeRows for new code.
export function columnarToRows(result) {
  var c = getColumns(result);
  if (!c.length) return [];
  var all = [];
  for (var i = 0; i < c.length; ++i) all.push(i);
  return materializeRows(c.columns, all);
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run test/demo-columnar-helpers.test.js`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (existing + new)

- [ ] **Step 6: Commit**

```
feat(helpers): add columnar utility functions for zero-materialization panel rendering
```

---

### Task 2: Rewrite DOW panel to pure columnar

**Files:**
- Modify: `demo-stockout/panels/dow-pattern.js`

This is the purest win — the DOW panel only aggregates 7 sums and 2 mode-counts across all rows. It never needs row objects.

- [ ] **Step 1: Rewrite dow-pattern.js to use columnar access**

Replace `columnarToRows` usage with direct column iteration:

```js
// demo-stockout/panels/dow-pattern.js

import { getColumns, esc } from './helpers.js';
import { colorFor } from '../config.js';

var chartInstance = null;

export function disposeDow() {
  if (chartInstance) { chartInstance.dispose(); chartInstance = null; }
}

var DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var CONFIRMED_FIELDS = [
  'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
  'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
];
var TOTAL_FIELDS = [
  'dow_mon_total', 'dow_tue_total', 'dow_wed_total',
  'dow_thu_total', 'dow_fri_total', 'dow_sat_total', 'dow_sun_total',
];

export function renderDowPattern(rowsResult, echarts, themeName) {
  var el = document.getElementById('panel-dow');
  var badgesEl = document.getElementById('panel-dow-badges');
  if (!el) return;

  var c = getColumns(rowsResult);
  if (!c.length) {
    el.innerHTML = '<div class="panel-empty">No <abbr title="Day of Week">DOW</abbr> data</div>';
    if (badgesEl) badgesEl.innerHTML = '';
    return;
  }

  var cols = c.columns;
  var len = c.length;
  var confirmedTotals = [0, 0, 0, 0, 0, 0, 0];
  var observedTotals = [0, 0, 0, 0, 0, 0, 0];
  var weekdayRateSum = 0, weekendRateSum = 0;
  var patternCounts = {}, riskDayCounts = {};

  // Aggregate directly from columnar arrays — zero row materialization
  for (var d = 0; d < 7; ++d) {
    var confCol = cols[CONFIRMED_FIELDS[d]];
    var totalCol = cols[TOTAL_FIELDS[d]];
    if (confCol) {
      for (var i = 0; i < len; ++i) confirmedTotals[d] += Number(confCol[i]) || 0;
    }
    if (totalCol) {
      for (var i = 0; i < len; ++i) observedTotals[d] += Number(totalCol[i]) || 0;
    }
  }

  var weekdayCol = cols.weekday_stockout_rate;
  var weekendCol = cols.weekend_stockout_rate;
  var patternCol = cols.dow_pattern;
  var riskDayCol = cols.highest_risk_day;

  for (var i = 0; i < len; ++i) {
    if (weekdayCol) weekdayRateSum += Number(weekdayCol[i]) || 0;
    if (weekendCol) weekendRateSum += Number(weekendCol[i]) || 0;
    if (patternCol && patternCol[i]) patternCounts[patternCol[i]] = (patternCounts[patternCol[i]] || 0) + 1;
    if (riskDayCol && riskDayCol[i]) riskDayCounts[riskDayCol[i]] = (riskDayCounts[riskDayCol[i]] || 0) + 1;
  }

  var probAvgs = confirmedTotals.map(function (c, idx) {
    return observedTotals[idx] > 0 ? c / observedTotals[idx] : 0;
  });
  var barColors = probAvgs.map(function (p) { return colorFor('forecast_stockout_probability', p); });

  if (!chartInstance || chartInstance.isDisposed()) {
    chartInstance = echarts.init(el, themeName, { renderer: 'canvas' });
  }

  chartInstance.setOption({
    grid: { left: 50, right: 20, top: 10, bottom: 30, containLabel: false },
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        var idx = params[0].dataIndex;
        return DAY_NAMES[idx] + '<br>Confirmed: ' + confirmedTotals[idx] +
          '<br><abbr title="Average Probability">Avg Prob</abbr>: ' + (probAvgs[idx] * 100).toFixed(1) + '%';
      },
    },
    xAxis: { type: 'category', data: DAY_NAMES },
    yAxis: { type: 'value', name: 'Confirmed' },
    series: [{
      type: 'bar',
      data: confirmedTotals.map(function (v, idx) {
        return { value: v, itemStyle: { color: barColors[idx] } };
      }),
      barMaxWidth: 32,
    }],
  }, true);

  if (badgesEl) {
    var topPattern = mode(patternCounts);
    var topRiskDay = mode(riskDayCounts);
    var avgWeekdayRate = len > 0 ? (weekdayRateSum / len * 100).toFixed(1) : '0.0';
    var avgWeekendRate = len > 0 ? (weekendRateSum / len * 100).toFixed(1) : '0.0';

    badgesEl.innerHTML =
      '<div class="dow-badge">Pattern: <strong>' + esc(topPattern) + '</strong></div>' +
      '<div class="dow-badge">Highest Risk Day: <strong>' + esc(topRiskDay) + '</strong></div>' +
      '<div class="dow-badge">Weekday Rate: <strong>' + avgWeekdayRate + '%</strong></div>' +
      '<div class="dow-badge">Weekend Rate: <strong>' + avgWeekendRate + '%</strong></div>';
  }
}

function mode(counts) {
  var best = null, bestCount = 0;
  for (var key in counts) {
    if (counts[key] > bestCount) { bestCount = counts[key]; best = key; }
  }
  return best || '\u2014';
}
```

- [ ] **Step 2: Verify DOW panel still renders correctly**

Run: `npm test` (ensures no import/export breakage)
Manual: load dashboard, check DOW chart renders with bars and badges.

- [ ] **Step 3: Commit**

```
perf(dow-pattern): pure columnar aggregation — zero row materialization
```

---

### Task 3: Rewrite stockout-table to columnar-native

**Files:**
- Modify: `demo-stockout/panels/stockout-table.js`

The stockout table receives ~10K rows, filters to `is_currently_active`, sorts, then renders. With columnar-native: filter → sort → materialize only the visible subset.

- [ ] **Step 1: Rewrite stockout-table.js**

Replace `columnarToRows` with `getColumns` + `filterIndices` + `sortIndices` + `materializeRows`:

```js
// demo-stockout/panels/stockout-table.js

import {
  getColumns, filterIndices, sortIndices, materializeRows,
  countByColumn, esc, isActive, fieldBadge, fmtDur, fmtISK, fmtFreq,
  sortableHeader, attachSortHandlers
} from './helpers.js';

var columns = {};      // raw columnar data (never materialized in full)
var allIndices = [];    // indices matching isActive filter
var catSelect = null;
var supSelect = null;
var sortField = 'risk_score';
var sortDir = -1;
var productClickCallback = null;

export function onProductClick(callback) {
  productClickCallback = callback;
}

var COLUMNS = [
  { key: 'product', label: 'Product', title: 'Product name' },
  { key: 'stockout_pattern', label: 'Pattern', title: 'Stockout character from Cube model' },
  { key: 'avg_duration_days', label: '<abbr title="Average Duration">Avg Dur</abbr>', title: 'Average stockout duration' },
  { key: 'total_expected_lost_sales', label: '<abbr title="Total Lost Sales">Total Lost</abbr>', title: 'Total estimated lost sales' },
  { key: 'trend_signal', label: 'Status', title: 'Overall status from Cube model' },
  { key: 'stockouts_per_month', label: '<abbr title="Frequency per Month">Freq/Mo</abbr>', title: 'Historical stockout frequency' },
];

export function renderStockoutTable(storeResult) {
  var el = document.getElementById('panel-stockout-table');
  if (!el) return;

  catSelect = catSelect || document.getElementById('stockout-cat-filter');
  supSelect = supSelect || document.getElementById('stockout-sup-filter');

  var c = getColumns(storeResult);
  columns = c.columns;

  // Filter: only active stockouts (columnar — no row objects)
  allIndices = filterIndices(columns, c.length, function (cols, i) {
    return isActive(cols.is_currently_active ? cols.is_currently_active[i] : undefined);
  });

  // Sort the filtered indices
  sortIndices(allIndices, columns, sortField, sortDir);

  populateSelects();
  renderFiltered();
}

function onSort(field) {
  if (sortField === field) sortDir *= -1;
  else { sortField = field; sortDir = -1; }
  sortIndices(allIndices, columns, sortField, sortDir);
  renderFiltered();
}

function populateSelects() {
  if (!catSelect || !supSelect) return;
  var prevCat = catSelect.value, prevSup = supSelect.value;
  var catCounts = countByColumn(columns, allIndices, 'product_category');
  var supCounts = countByColumn(columns, allIndices, 'supplier');
  catSelect.innerHTML = '<option value="">All Categories (' + allIndices.length + ')</option>' +
    countsToOptions(catCounts);
  supSelect.innerHTML = '<option value="">All Suppliers (' + allIndices.length + ')</option>' +
    countsToOptions(supCounts);
  catSelect.value = prevCat; supSelect.value = prevSup;
  catSelect.onchange = renderFiltered; supSelect.onchange = renderFiltered;
}

function countsToOptions(counts) {
  var entries = [];
  for (var key in counts) entries.push({ name: key, count: counts[key] });
  entries.sort(function (a, b) { return b.count - a.count; });
  return entries.map(function (e) {
    return '<option value="' + esc(e.name) + '">' + esc(e.name) + ' (' + e.count + ')</option>';
  }).join('');
}

function renderFiltered() {
  var el = document.getElementById('panel-stockout-table');
  var countEl = document.getElementById('stockout-count');
  if (!el) return;

  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';
  var catCol = columns.product_category;
  var supCol = columns.supplier;

  // Sub-filter on indices (no row objects)
  var filtered = allIndices;
  if (catVal || supVal) {
    filtered = [];
    for (var f = 0; f < allIndices.length; ++f) {
      var idx = allIndices[f];
      if (catVal && catCol && catCol[idx] !== catVal) continue;
      if (supVal && supCol && supCol[idx] !== supVal) continue;
      filtered.push(idx);
    }
  }
  if (countEl) countEl.textContent = filtered.length + ' products';

  if (!filtered.length) {
    el.innerHTML = '<div class="panel-empty">No active stockouts' + (catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  // Materialize only the visible rows for HTML rendering
  var rows = materializeRows(columns, filtered);

  var html = '<table class="tbl">' + sortableHeader(COLUMNS, sortField, sortDir) + '<tbody>';
  for (var i = 0; i < rows.length; ++i) {
    var r = rows[i];
    html += '<tr data-product="' + esc(r.product) + '" style="cursor:pointer">' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + fieldBadge('stockout_pattern', r.stockout_pattern) + '</td>' +
      '<td>' + fmtDur(r.avg_duration_days) + '</td>' +
      '<td>' + fmtISK(r.total_expected_lost_sales) + '</td>' +
      '<td>' + fieldBadge('trend_signal', r.trend_signal) + '</td>' +
      '<td>' + fmtFreq(r.stockouts_per_month) + '</td>' +
      '</tr>';
  }
  el.innerHTML = html + '</tbody></table>';
  attachSortHandlers(el, onSort);
  ensureProductClickHandler(el);
}

var productClickBound = false;

function ensureProductClickHandler(el) {
  if (productClickBound) return;
  productClickBound = true;
  el.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-product]');
    if (!tr) return;
    if (productClickCallback) productClickCallback(tr.dataset.product);
  });
}
```

- [ ] **Step 2: Run tests, verify no breakage**

Run: `npm test`

- [ ] **Step 3: Commit**

```
perf(stockout-table): columnar-native filter/sort — materialize only visible rows
```

---

### Task 4: Rewrite forecast panel to columnar-native

**Files:**
- Modify: `demo-stockout/panels/forecast.js`

Same pattern as stockout-table. Also fixes the I5 finding: day-button counting now uses single-pass `countByColumn` instead of 3× `.filter().length`.

- [ ] **Step 1: Rewrite forecast.js**

Apply same `getColumns` + `filterIndices` + `sortIndices` + `materializeRows` pattern. Replace the day-button counting with `countByColumn`. Full replacement file follows the exact same structure as stockout-table above — store `columns` + `allIndices`, materialize only the rendered subset.

Key changes vs current code:
- `var c = getColumns(rowsResult)` instead of `columnarToRows(rowsResult)`
- `allIndices = filterIndices(...)` with tier predicate on columns
- `renderDayButtons()` uses `countByColumn(columns, allIndices, 'highest_risk_day')` — single pass
- `renderFiltered()` sub-filters on `allIndices`, materializes only visible rows
- Top-4 cards: `materializeRows(columns, allIndices.slice(0, 4))` — materializes 4 objects

- [ ] **Step 2: Run tests, verify no breakage**

Run: `npm test`

- [ ] **Step 3: Commit**

```
perf(forecast): columnar-native rendering — single-pass day counting
```

---

### Task 5: Rewrite risk-chart to columnar-native

**Files:**
- Modify: `demo-stockout/panels/risk-chart.js`

Only renders top 10 rows. Columnar filter → sort → take 10 → materialize 10 objects.

- [ ] **Step 1: Rewrite risk-chart.js**

Same pattern. Key: `allIndices` is sliced to 10 after sort, so `materializeRows` produces exactly 10 objects regardless of dataset size.

The `_freq_delta` custom sort uses a computed value. Handle this with a custom sort comparator that reads two columns:

```js
function sortByFreqDelta(indices, columns, dir) {
  var recent = columns.frequency_recent_per_month;
  var older = columns.frequency_older_per_month;
  indices.sort(function (a, b) {
    var ar = Number(recent ? recent[a] : 0) || 0;
    var ao = Number(older ? older[a] : 0) || 0;
    var br = Number(recent ? recent[b] : 0) || 0;
    var bo = Number(older ? older[b] : 0) || 0;
    var av = ao > 0 ? ar / ao : (ar > 0 ? 2 : 1);
    var bv = bo > 0 ? br / bo : (br > 0 ? 2 : 1);
    return (av - bv) * -dir || 0;
  });
}
```

- [ ] **Step 2: Run tests, verify no breakage**

Run: `npm test`

- [ ] **Step 3: Commit**

```
perf(risk-chart): columnar-native — materialize only top 10 rows
```

---

### Task 6: Rewrite early-warning to columnar-native + fix sort lookup

**Files:**
- Modify: `demo-stockout/panels/early-warning.js`

Also fixes I7: the `sortValue` function currently does `COLUMNS.filter(c => c.key === field)[0]` inside the sort comparator (O(n log n × 8) wasted iterations). Replace with a pre-built `COLUMN_MAP` lookup.

- [ ] **Step 1: Rewrite early-warning.js**

Same columnar pattern. Additionally:

```js
// Pre-built lookup map (fixes I7 — was COLUMNS.filter() inside sort comparator)
var COLUMN_MAP = {};
for (var cm = 0; cm < COLUMNS.length; ++cm) {
  COLUMN_MAP[COLUMNS[cm].key] = COLUMNS[cm];
}
```

The `sortIndices` call uses a custom comparator for delta columns:

```js
function doSort() {
  var col = COLUMN_MAP[sortField];
  if (col && col.type === 'delta') {
    var recentCol = columns[col.recent];
    var olderCol = columns[col.older];
    allIndices.sort(function (a, b) {
      var ar = Number(recentCol ? recentCol[a] : 0) || 0;
      var ao = Number(olderCol ? olderCol[a] : 0) || 0;
      var br = Number(recentCol ? recentCol[b] : 0) || 0;
      var bo = Number(olderCol ? olderCol[b] : 0) || 0;
      var av = ao > 0 ? ar / ao : (ar > 0 ? 2 : 1);
      var bv = bo > 0 ? br / bo : (br > 0 ? 2 : 1);
      return (av - bv) * -sortDir || 0;
    });
  } else {
    sortIndices(allIndices, columns, sortField, sortDir);
  }
}
```

- [ ] **Step 2: Run tests, verify no breakage**

Run: `npm test`

- [ ] **Step 3: Commit**

```
perf(early-warning): columnar-native + O(1) sort column lookup
```

---

### Task 7: Rewrite app-ops.js top-level columnarToRows

**Files:**
- Modify: `demo-stockout/app-ops.js`

The ops dashboard converts 50K rows at the top of `refreshAllPanels` (line 1391), then passes row arrays to all panels. Change to pass columnar data through, and convert `collectMatching` to work with columnar indices.

- [ ] **Step 1: Rewrite the refreshAllPanels result processing**

Replace `var allRows = columnarToRows(mainResult.rowSets.all)` with:

```js
var c = getColumns(mainResult ? mainResult.rowSets.all : null);
var allCols = c.columns;
var allLen = c.length;
```

Replace `collectMatching(allRows, predicate, comparator)` calls with columnar equivalents that produce index arrays, then materialize only at the render boundary.

The `collectMatching` pattern becomes:

```js
function collectMatchingIndices(columns, length, predicate, sortField, sortDir) {
  var indices = filterIndices(columns, length, predicate);
  sortIndices(indices, columns, sortField, sortDir);
  return indices;
}
```

`latestViewModel` stores both columnar data and index arrays. Render functions that need row objects call `materializeRows(allCols, indices)` at their own render boundary.

- [ ] **Step 2: Update all render functions that consume allRows**

Each render function in app-ops.js that receives `allRows` should receive `{ columns, indices }` instead and materialize only visible rows.

- [ ] **Step 3: Update renderDowGuidance to use getColumns directly**

The ops DOW guidance at line 1088 calls `columnarToRows(rowsResult)` — replace with `getColumns`.

- [ ] **Step 4: Run tests, verify no breakage**

Run: `npm test`

- [ ] **Step 5: Commit**

```
perf(app-ops): eliminate 50K-row columnarToRows — columnar-native throughout
```

---

### Task 8: Fix benchmark chart ECharts instance recreation (C1)

**Files:**
- Modify: `demo-stockout/app.js`

The benchmark chart disposes and recreates the ECharts instance on every render. Reuse it.

- [ ] **Step 1: Fix renderBenchmarkChart in app.js**

Find the section (~line 1030) that disposes and recreates:

```js
// BEFORE (current — recreates every render):
if (benchmarkChart && !benchmarkChart.isDisposed()) {
    benchmarkChart.dispose();
}
el.innerHTML = '';
benchmarkChart = echarts.init(el, THEME_NAME, { renderer: 'canvas' });
```

Replace with reuse pattern:

```js
// AFTER (reuse instance):
if (!benchmarkChart || benchmarkChart.isDisposed()) {
  el.innerHTML = '';
  benchmarkChart = echarts.init(el, THEME_NAME, { renderer: 'canvas' });
}
```

The `setOption(..., true)` call already replaces options fully, so instance reuse is safe.

- [ ] **Step 2: Verify benchmark chart still renders and updates on hover/click**

Run: `npm test`
Manual: toggle compare stores, change metric/granularity, verify chart updates.

- [ ] **Step 3: Commit**

```
perf(benchmark): reuse ECharts instance instead of dispose/recreate per render
```

---

### Task 9: Fix updateActiveFacets to use group aggregation (I1)

**Files:**
- Modify: `demo-stockout/app.js`
- Modify: `demo-stockout/app-ops.js`

Currently fetches 100K rows just to count active stockouts per store. Use `isolatedFilters` + `groups` query instead — returns ~20 entries (one per store) instead of 100K rows.

The challenge: cf-main doesn't have a `sold_location` group with `is_currently_active` metric. But `query({ isolatedFilters, groups })` only works with pre-configured groups. An alternative: use the columnar utilities to count directly from a smaller row fetch, or add a dedicated KPI query.

Actually, the simplest fix: keep the rows approach but with the new columnar utilities — `getColumns` + iterate columns directly. The 100K row transfer from worker is still wasteful, but the main-thread cost drops to near zero. The network/worker transfer is a separate optimization (requires adding a group spec to cube-registry).

- [ ] **Step 1: Replace columnarToRows with getColumns in updateActiveFacets**

Both files: use `getColumns` + direct column iteration instead of materializing 100K row objects:

```js
async function updateActiveFacets(facets) {
  if (!runtimes['cf-main']) return facets;
  try {
    var result = await runtimes['cf-main'].query({
      isolatedFilters: {},
      snapshot: false,
      rows: {
        fields: ['sold_location', 'is_currently_active'],
        limit: 100000,
        columnar: true,
      },
    });
    var c = getColumns(result.rows);
    var locCol = c.columns.sold_location;
    var activeCol = c.columns.is_currently_active;
    if (locCol && activeCol) {
      for (var i = 0; i < c.length; ++i) {
        var loc = locCol[i];
        if (facets[loc] && (activeCol[i] === 1 || activeCol[i] === true)) {
          facets[loc].active++;
        }
      }
    }
  } catch (err) { console.error('Active facet query failed:', err); }
  return facets;
}
```

- [ ] **Step 2: Run tests**

Run: `npm test`

- [ ] **Step 3: Commit**

```
perf(facets): iterate columns directly — avoid 100K row materialization
```

---
