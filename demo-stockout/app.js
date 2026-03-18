// demo-stockout/app.js
//
// Multi-crossfilter stockout dashboard.
//
// Architecture:
//   - 3 crossfilter workers, load ALL stores at startup
//     cf-main (stockout_analysis): KPIs, tables, forecast, risk, early warning
//     cf-dow  (stockout_analysis): DOW chart (independent product click filter)
//     cf-trend (stockout_availability): benchmark peer-comparison chart
//   - sold_location is a crossfilter dimension — store switching is instant
//   - Color/label config loaded from Cube /api/meta (Principle 6)
//
// Query batching (3 postMessage round-trips per refresh):
//   - cf-main:  query({ snapshot, rowSets: { stockout, forecast, risk, warning } })
//   - cf-dow:   rows({ fields, columnar: true })
//   - cf-trend: query({ groups: { byStoreDay } }) — unfiltered by store for peer bands

import { registerTheme, THEME_NAME } from './theme.js';
import { getState, setState, onStateChange, PARAM_TO_DIMENSION, buildDashboardFilters } from './router.js';
import { ALL_CUBE_IDS, buildWorkerOptions, fetchStoreList, fetchEndedYesterday, fetchStartedYesterday, fetchEndedDayBefore, fetchStartedDayBefore, fetchMeta, getCubeConfig } from './cube-registry.js';
import { loadMeta, namedColor } from './config.js';
import { registerRuntime, dispatchFilters, disposeAll, onPanelRefresh } from './filter-router.js';
import { renderKpis } from './panels/kpis.js';
import { renderStockoutTable, onProductClick } from './panels/stockout-table.js';
import { renderForecast } from './panels/forecast.js';
import { renderRiskChart, setProductClickHandler } from './panels/risk-chart.js';
import { renderEarlyWarning } from './panels/early-warning.js';
import { renderDowPattern, disposeDow } from './panels/dow-pattern.js';

var crossfilter = globalThis.crossfilter;
var echarts = globalThis.echarts;

if (!crossfilter) throw new Error('crossfilter not loaded');
if (!echarts) throw new Error('echarts not loaded');

registerTheme(echarts);

// ---- State ----

var runtimes = {};
var storeList = [];
var currentStore = null;
var workersReady = false;
var allEndedYesterday = [];
var allStartedYesterday = [];
var allEndedDayBefore = [];   // for KPI trend comparison
var allStartedDayBefore = [];
var endedCategoryFilter = null;
var benchmarkChart = null;
var benchmarkGranularity = 'week';  // 'week' or 'month'
var benchmarkMetric = 'availability';
var benchmarkProduct = null;
var compareStores = [];  // stores to show as individual lines
var COMPARE_COLORS = ['#b366ff', '#ff8c4d', '#00e6e6', '#e6e600', '#ff66b2'];

// ---- DOM ----

var dom = {
  overlay: document.getElementById('loading-overlay'),
  overlayText: document.querySelector('.loading-text'),
  picker: document.getElementById('store-picker'),
  storeGrid: document.getElementById('store-grid'),
  dashboard: document.getElementById('dashboard'),
  storeName: document.getElementById('store-name'),
  storeSelector: document.getElementById('store-selector'),
  filterChips: document.getElementById('filter-chips'),
  clearBtn: document.getElementById('clear-filters-btn'),
  kpiRow: document.getElementById('kpi-row'),
};

function setOverlay(show, text) {
  if (text) dom.overlayText.textContent = text;
  if (show) dom.overlay.removeAttribute('hidden');
  else dom.overlay.setAttribute('hidden', '');
}

function showShimmer(elId) {
  var el = document.getElementById(elId);
  if (el && !el.querySelector('.shimmer')) {
    el.innerHTML = '<div class="shimmer" style="margin:12px;min-height:120px;"></div>';
  }
}

function esc(v) {
  if (v == null) return '\u2014';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatISKShort(v) {
  if (v == null || isNaN(v)) return '\u2014';
  v = Number(v);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + '<abbr title="million">M</abbr>';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + '<abbr title="thousand">K</abbr>';
  return Math.round(v) + '';
}

// Filter yesterday data by current store (client-side)
function endedForStore() {
  if (!currentStore) return allEndedYesterday;
  return allEndedYesterday.filter(function (r) { return r.store === currentStore; });
}

function startedForStore() {
  if (!currentStore) return allStartedYesterday;
  return allStartedYesterday.filter(function (r) { return r.store === currentStore; });
}

function endedDayBeforeForStore() {
  if (!currentStore) return allEndedDayBefore;
  return allEndedDayBefore.filter(function (r) { return r.store === currentStore; });
}

function startedDayBeforeForStore() {
  if (!currentStore) return allStartedDayBefore;
  return allStartedDayBefore.filter(function (r) { return r.store === currentStore; });
}

// Facet counts per store (for faceted selectors)
function buildStoreFacets() {
  var facets = {};
  for (var i = 0; i < storeList.length; ++i) {
    facets[storeList[i].name] = { active: 0, ended: 0, started: 0 };
  }
  for (var e = 0; e < allEndedYesterday.length; ++e) {
    var s = allEndedYesterday[e].store;
    if (facets[s]) facets[s].ended++;
  }
  for (var st = 0; st < allStartedYesterday.length; ++st) {
    var s2 = allStartedYesterday[st].store;
    if (facets[s2]) facets[s2].started++;
  }
  return facets;
}

// Update active counts from cf-main data (called after workers ready)
async function updateActiveFacets(facets) {
  if (!runtimes['cf-main']) return facets;
  try {
    // Temporarily clear store filter to get all-store data
    await runtimes['cf-main'].updateFilters({});
    var result = await runtimes['cf-main'].rows({
      fields: ['sold_location', 'is_currently_active'],
      limit: 100000,
      columnar: true,
    });
    // Restore current filter
    if (currentStore) {
      await runtimes['cf-main'].updateFilters({ sold_location: { type: 'in', values: [currentStore] } });
    }
    var cols = result && result.columns ? result.columns : result;
    if (cols && cols.sold_location) {
      for (var i = 0; i < cols.sold_location.length; ++i) {
        var loc = cols.sold_location[i];
        var active = cols.is_currently_active[i];
        if (facets[loc] && (active === 1 || active === true)) {
          facets[loc].active++;
        }
      }
    }
  } catch (err) { console.error('Active facet query failed:', err); }
  return facets;
}

// ---- Store Picker ----

var storeFacets = {};

function showStorePicker() {
  if (!storeList.length) {
    dom.storeGrid.innerHTML = '<div class="panel-error">No stores loaded</div>';
    dom.picker.removeAttribute('hidden');
    return;
  }

  dom.storeGrid.innerHTML = '';
  for (var i = 0; i < storeList.length; ++i) {
    var store = storeList[i];
    var f = storeFacets[store.name] || { active: 0, ended: 0, started: 0 };
    var btn = document.createElement('button');
    btn.className = 'store-btn';
    btn.innerHTML = store.name +
      '<span class="store-btn-facets">' +
      '<span class="facet facet-red" title="Active stockouts">' + f.active + '</span>' +
      '<span class="facet facet-green" title="Ended yesterday">' + f.ended + '</span>' +
      '<span class="facet facet-amber" title="Started yesterday">' + f.started + '</span>' +
      '</span>';
    btn.dataset.store = store.name;
    btn.addEventListener('click', function (e) { setState({ store: e.currentTarget.dataset.store }); });
    dom.storeGrid.appendChild(btn);
  }

  dom.picker.removeAttribute('hidden');
}

// ---- Store Selector (custom dropdown) ----

var storeDropdown = document.getElementById('store-dropdown');
var storeDropdownActive = -1;
var storeDropdownItems = [];

function populateStoreSelector() {
  dom.storeSelector.value = currentStore || '';
}

function renderStoreDropdown(query) {
  if (!storeDropdown) return;
  var q = (query || '').toLowerCase();
  var matched = [];
  var rest = [];

  for (var i = 0; i < storeList.length; ++i) {
    var name = storeList[i].name;
    if (q && name.toLowerCase().indexOf(q) >= 0) {
      matched.push(name);
    } else {
      rest.push(name);
    }
  }

  // Matched items first (alphabetically), then all others alphabetically
  matched.sort(function (a, b) { return a.localeCompare(b); });
  rest.sort(function (a, b) { return a.localeCompare(b); });
  storeDropdownItems = matched.concat(rest);

  var html = '';
  for (var j = 0; j < storeDropdownItems.length; ++j) {
    var storeName = storeDropdownItems[j];
    var f = storeFacets[storeName] || { active: 0, ended: 0, started: 0 };
    var isMatch = q && storeName.toLowerCase().indexOf(q) >= 0;
    var isCurrent = storeName === currentStore;
    var cls = 'store-opt';
    if (isMatch) cls += ' store-opt-match';
    if (isCurrent) cls += ' store-opt-current';
    if (j === storeDropdownActive) cls += ' store-opt-active';
    html += '<div class="' + cls + '" data-store="' + esc(storeName) + '">' +
      esc(storeName) +
      '<span class="store-opt-facets">' +
      '<span class="facet facet-red">' + f.active + '</span>' +
      '<span class="facet facet-green">' + f.ended + '</span>' +
      '<span class="facet facet-amber">' + f.started + '</span>' +
      '</span></div>';
  }
  storeDropdown.innerHTML = html;
  storeDropdown.removeAttribute('hidden');

  // Scroll active item into view
  if (storeDropdownActive >= 0) {
    var activeEl = storeDropdown.children[storeDropdownActive];
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }
}

function selectStore(name) {
  closeStoreDropdown();
  if (name && name !== currentStore) {
    var patch = { store: name };
    for (var param in PARAM_TO_DIMENSION) patch[param] = null;
    setState(patch);
  }
}

function closeStoreDropdown() {
  if (storeDropdown) storeDropdown.setAttribute('hidden', '');
  storeDropdownActive = -1;
  storeDropdownItems = [];
}

dom.storeSelector.addEventListener('focus', function () {
  storeDropdownActive = -1;
  renderStoreDropdown(dom.storeSelector.value);
});

dom.storeSelector.addEventListener('input', function () {
  storeDropdownActive = -1;
  renderStoreDropdown(dom.storeSelector.value);
});

dom.storeSelector.addEventListener('keydown', function (e) {
  if (!storeDropdownItems.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    storeDropdownActive = Math.min(storeDropdownActive + 1, storeDropdownItems.length - 1);
    renderStoreDropdown(dom.storeSelector.value);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    storeDropdownActive = Math.max(storeDropdownActive - 1, 0);
    renderStoreDropdown(dom.storeSelector.value);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (storeDropdownActive >= 0 && storeDropdownItems[storeDropdownActive]) {
      selectStore(storeDropdownItems[storeDropdownActive]);
    }
  } else if (e.key === 'Escape') {
    closeStoreDropdown();
    dom.storeSelector.blur();
  }
});

if (storeDropdown) {
  storeDropdown.addEventListener('click', function (e) {
    var opt = e.target.closest('.store-opt');
    if (opt) selectStore(opt.dataset.store);
  });
}

document.addEventListener('click', function (e) {
  if (!e.target.closest('.store-selector-wrap')) {
    closeStoreDropdown();
  }
});

// ---- Filter Chips ----

function renderFilterChips() {
  var state = getState();
  var chips = [];
  for (var param in PARAM_TO_DIMENSION) {
    var val = state[param];
    if (val) chips.push({ param: param, label: param.charAt(0).toUpperCase() + param.slice(1) + ': ' + val });
  }

  dom.filterChips.innerHTML = '';
  for (var i = 0; i < chips.length; ++i) {
    var chip = document.createElement('button');
    chip.className = 'filter-chip';
    chip.dataset.param = chips[i].param;
    chip.innerHTML = chips[i].label + ' <span class="chip-x">&times;</span>';
    chip.addEventListener('click', function (e) {
      var p = {};
      p[e.currentTarget.dataset.param] = null;
      setState(p);
    });
    dom.filterChips.appendChild(chip);
  }

  dom.clearBtn[chips.length > 0 ? 'removeAttribute' : 'setAttribute']('hidden', '');
}

dom.clearBtn.addEventListener('click', function () {
  var patch = {};
  for (var param in PARAM_TO_DIMENSION) patch[param] = null;
  setState(patch);
});

// ---- Sensitivity Toggle ----

(function () {
  var wrap = document.getElementById('sensitivity-toggle');
  if (!wrap) return;

  // Sync button state from URL on load
  var initState = getState();
  if (initState.sensitivity) {
    var btns = wrap.querySelectorAll('.gran-btn');
    for (var i = 0; i < btns.length; ++i) {
      btns[i].classList.toggle('gran-active', (btns[i].dataset.sens || '') === (initState.sensitivity || ''));
    }
  }

  wrap.addEventListener('click', function (e) {
    var btn = e.target.closest('.gran-btn');
    if (!btn) return;
    var sens = btn.dataset.sens || null;
    var current = getState().sensitivity || null;
    if (sens === current) return;
    var btns = wrap.querySelectorAll('.gran-btn');
    for (var i = 0; i < btns.length; ++i) {
      btns[i].classList.toggle('gran-active', (btns[i].dataset.sens || '') === (sens || ''));
    }
    setState({ sensitivity: sens });
  });
})();

// ---- Worker Creation (once, all stores) ----

async function createWorkers() {
  setOverlay(true, 'Starting...');

  showShimmer('panel-benchmark');
  showShimmer('panel-trend');
  showShimmer('panel-category');
  showShimmer('panel-stockout-table');
  showShimmer('panel-forecast-table');
  showShimmer('panel-risk');
  showShimmer('panel-dow');
  showShimmer('panel-early-warning');
  dom.kpiRow.innerHTML = '<div class="shimmer" style="grid-column:1/-1;min-height:80px;"></div>';

  // Progress tracking (Principle 1: report progress for operations > 1s)
  var progress = { workers: 0, extras: 0, total: ALL_CUBE_IDS.length + 6 };
  function updateProgress(label) {
    var done = progress.workers + progress.extras;
    var pct = Math.round(done / progress.total * 100);
    setOverlay(true, label + ' (' + pct + '%)');
  }

  // All network requests in parallel: 2 workers + meta + 2 yesterday fetches + store list
  var results = await Promise.allSettled(
    ALL_CUBE_IDS.map(function (cubeId) {
      var opts = buildWorkerOptions(cubeId);
      updateProgress('Connecting to ' + cubeId);
      return crossfilter.createStreamingDashboardWorker(opts).then(function (runtime) {
        return runtime.ready.then(function (readyPayload) {
          progress.workers++;
          var rows = readyPayload && readyPayload.load ? readyPayload.load.rowsLoaded : '?';
          updateProgress(cubeId + ': ' + rows + ' rows loaded');
          var config = getCubeConfig(cubeId);
          registerRuntime(cubeId, runtime, config.workerDimensions);
          runtimes[cubeId] = runtime;
          return runtime;
        });
      });
    }).concat([
      fetchMeta().then(function (meta) {
        loadMeta(meta);
        progress.extras++;
        updateProgress('Config loaded from meta');
      }),
      fetchEndedYesterday().then(function (data) {
        allEndedYesterday = data;
        progress.extras++;
        updateProgress('Ended yesterday: ' + data.length + ' events');
      }),
      fetchStartedYesterday().then(function (data) {
        allStartedYesterday = data;
        progress.extras++;
        updateProgress('Started yesterday: ' + data.length + ' events');
      }),
      fetchEndedDayBefore().then(function (data) {
        allEndedDayBefore = data;
        progress.extras++;
        updateProgress('Ended day before: ' + data.length + ' events');
      }),
      fetchStartedDayBefore().then(function (data) {
        allStartedDayBefore = data;
        progress.extras++;
        updateProgress('Started day before: ' + data.length + ' events');
      }),
      fetchStoreList().then(function (stores) {
        storeList = stores;
        progress.extras++;
        updateProgress(stores.length + ' stores loaded');
      }),
    ])
  );

  var failedCubes = [];
  for (var i = 0; i < ALL_CUBE_IDS.length; ++i) {
    if (results[i].status === 'rejected' || !results[i].value) {
      failedCubes.push(ALL_CUBE_IDS[i]);
      console.error('Worker failed: ' + ALL_CUBE_IDS[i],
        results[i].status === 'rejected' ? results[i].reason : 'null');
    }
  }

  if (failedCubes.length === ALL_CUBE_IDS.length) {
    setOverlay(false);
    dom.kpiRow.innerHTML = '<div class="panel-error" style="grid-column:1/-1;">Failed to load data.</div>';
    return;
  }

  workersReady = true;

  // Build faceted store data (Principle 4: faceted selectors)
  storeFacets = buildStoreFacets();
  await updateActiveFacets(storeFacets);
  populateStoreSelector();
  setOverlay(false);
}

// ---- Batched Panel Refresh ----
//
// 3 worker round-trips per refresh:
//   cf-main:   query({ snapshot, rowSets: { stockout, forecast, risk } })
//   cf-main: rows({ ... })
//   cf-dow:     rows({ ... })

// All fields needed from cf-main (stockout_analysis)
var MAIN_FIELDS = [
  'product', 'product_category', 'supplier', 'risk_score',
  'avg_duration_days', 'total_expected_lost_sales', 'trend_signal',
  'severity_trend', 'stockout_pattern', 'forecast_tier',
  'is_currently_active', 'highest_risk_day',
  'stockouts_per_month', 'days_since_last',
  'forecast_stockout_probability', 'forecast_warning',
  'forecast_tier', 'risk_tier',
  // Trending half-comparisons (for delta columns)
  'avg_duration_recent_half', 'avg_duration_older_half',
  'frequency_recent_per_month', 'frequency_older_per_month',
  'avg_impact_recent_half', 'avg_impact_older_half',
];

var DOW_FIELDS = [
  'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
  'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
  'dow_mon_total', 'dow_tue_total', 'dow_wed_total',
  'dow_thu_total', 'dow_fri_total', 'dow_sat_total', 'dow_sun_total',
  'dow_mon_probability', 'dow_tue_probability', 'dow_wed_probability',
  'dow_thu_probability', 'dow_fri_probability', 'dow_sat_probability', 'dow_sun_probability',
  'weekday_stockout_rate', 'weekend_stockout_rate', 'dow_pattern', 'highest_risk_day',
];

async function refreshAllPanels() {
  if (!workersReady) return;

  var promises = [];

  // cf-main: ONE query with snapshot + 4 rowSets (1 postMessage round-trip)
  if (runtimes['cf-main']) {
    promises.push(
      runtimes['cf-main'].query({
        snapshot: {},
        rowCount: true,
        rowSets: {
          stockout: { fields: MAIN_FIELDS, limit: 10000, sortBy: 'risk_score', direction: 'top', columnar: true },
          forecast: { fields: MAIN_FIELDS, limit: 10000, sortBy: 'forecast_stockout_probability', direction: 'top', columnar: true },
          risk:     { fields: MAIN_FIELDS, limit: 10000, sortBy: 'risk_score', direction: 'top', columnar: true },
          warning:  { fields: MAIN_FIELDS, limit: 10000, sortBy: 'risk_score', direction: 'top', columnar: true },
        },
      }).catch(function (err) { console.error('cf-main query failed:', err); return null; })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  // cf-dow: ONE rows() call (1 postMessage round-trip)
  if (runtimes['cf-dow']) {
    promises.push(
      runtimes['cf-dow'].rows({
        fields: DOW_FIELDS, limit: 50000, columnar: true,
      }).catch(function (err) { console.error('cf-dow query failed:', err); return null; })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  var results = await Promise.all(promises);
  var mainResult = results[0];
  var dowRows = results[1];

  // Render all panels synchronously from batched results
  var ended = endedForStore();
  var started = startedForStore();
  var endedPrev = endedDayBeforeForStore();
  var startedPrev = startedDayBeforeForStore();

  if (mainResult) {
    renderKpis(mainResult.snapshot, ended, started, endedPrev, startedPrev);
    renderStockoutTable(mainResult.rowSets.stockout);
    renderForecast(mainResult.rowSets.forecast);
    renderRiskChart(mainResult.rowSets.risk);
    renderEarlyWarning(mainResult.rowSets.warning);
  } else {
    renderKpis(null, ended, started, endedPrev, startedPrev);
    document.getElementById('panel-stockout-table').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    document.getElementById('panel-forecast-table').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    document.getElementById('panel-risk').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    document.getElementById('panel-early-warning').innerHTML = '<div class="panel-empty">Data unavailable</div>';
  }
  renderDowPattern(dowRows, echarts, THEME_NAME);
  refreshEndedYesterday();
  renderFilterChips();
  refreshBenchmarkChart();
}

// ---- Ended Yesterday (local data, filtered by store in JS) ----

function refreshEndedYesterday() {
  var ended = endedForStore();
  renderEndedYesterdayTable(ended, endedCategoryFilter);
  renderEndedCategoryPie(ended);
}

function renderEndedYesterdayTable(data, categoryFilter) {
  var el = document.getElementById('panel-trend');
  if (!el) return;

  var filtered = data || [];
  if (categoryFilter) filtered = filtered.filter(function (r) { return r.category === categoryFilter; });

  var countEl = document.getElementById('ended-count');
  if (countEl) countEl.textContent = filtered.length + ' products';

  if (!filtered.length) {
    el.innerHTML = '<div class="panel-empty">' +
      (categoryFilter ? 'No ended stockouts in ' + esc(categoryFilter) : 'No confirmed stockouts ended yesterday') + '</div>';
    return;
  }

  var sorted = filtered.slice().sort(function (a, b) { return b.lostSales - a.lostSales; });

  var html = '<div class="table-scroll" style="max-height:260px;"><table class="tbl"><thead><tr>' +
    '<th>Product</th><th>Category</th><th>Duration</th><th>Lost Sales</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < sorted.length; ++i) {
    var r = sorted[i];
    html += '<tr><td class="val">' + esc(r.product) + '</td><td>' + esc(r.category) +
      '</td><td>' + r.durationDays.toFixed(1) + 'd</td><td>' + formatISKShort(r.lostSales) + '</td></tr>';
  }

  el.innerHTML = html + '</tbody></table></div>';
}

var categoryPieInstance = null;

function renderEndedCategoryPie(data) {
  var el = document.getElementById('panel-category');
  if (!el) return;

  if (!data || !data.length) {
    el.innerHTML = '<div class="panel-empty">No data</div>';
    return;
  }

  var counts = {};
  for (var i = 0; i < data.length; ++i) {
    var cat = data[i].category || 'Unknown';
    counts[cat] = (counts[cat] || 0) + 1;
  }

  var pieData = [];
  for (var key in counts) pieData.push({ name: key, value: counts[key] });
  pieData.sort(function (a, b) { return b.value - a.value; });

  if (!categoryPieInstance || categoryPieInstance.isDisposed()) {
    categoryPieInstance = echarts.init(el, THEME_NAME, { renderer: 'canvas' });
    categoryPieInstance.on('click', function (params) {
      endedCategoryFilter = params.name === endedCategoryFilter ? null : params.name;
      var ended = endedForStore();
      renderEndedYesterdayTable(ended, endedCategoryFilter);
      renderEndedCategoryPie(ended);
    });
  }

  categoryPieInstance.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie', radius: ['30%', '70%'], center: ['50%', '50%'],
      data: pieData.map(function (d) {
        var sel = d.name === endedCategoryFilter;
        return { name: d.name, value: d.value, selected: sel,
          itemStyle: sel ? { borderColor: '#e8edf3', borderWidth: 2 } : {} };
      }),
      label: { fontSize: 10, color: '#7a8a9e', formatter: '{b}\n{c}' },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } },
      selectedMode: 'single', selectedOffset: 6,
    }],
  }, true);
}

// ---- Benchmark Chart ----

var lastBenchmarkGroupData = null;

// Granularity toggle — only re-renders, no re-query needed (data is daily)
(function () {
  var wrap = document.getElementById('benchmark-granularity');
  if (!wrap) return;
  wrap.addEventListener('click', function (e) {
    var btn = e.target.closest('.gran-btn');
    if (!btn) return;
    var gran = btn.dataset.gran;
    if (gran === benchmarkGranularity) return;
    benchmarkGranularity = gran;
    var btns = wrap.querySelectorAll('.gran-btn');
    for (var i = 0; i < btns.length; ++i) {
      btns[i].classList.toggle('gran-active', btns[i].dataset.gran === gran);
    }
    if (lastBenchmarkGroupData) renderBenchmarkChart(lastBenchmarkGroupData);
  });
})();

// Metric toggle — switches between availability %, stockout events, avg duration
(function () {
  var wrap = document.getElementById('benchmark-metric');
  if (!wrap) return;
  wrap.addEventListener('click', function (e) {
    var btn = e.target.closest('.gran-btn');
    if (!btn) return;
    var metric = btn.dataset.metric;
    if (metric === benchmarkMetric) return;
    benchmarkMetric = metric;
    var btns = wrap.querySelectorAll('.gran-btn');
    for (var i = 0; i < btns.length; ++i) {
      btns[i].classList.toggle('gran-active', btns[i].dataset.metric === metric);
    }
    if (lastBenchmarkGroupData) renderBenchmarkChart(lastBenchmarkGroupData);
  });
})();

// ---- Compare stores picker ----

var hoverStore = null;

(function () {
  var wrap = document.getElementById('compare-control');
  var btn = document.getElementById('compare-btn');
  var dropdown = document.getElementById('compare-dropdown');
  if (!btn || !dropdown || !wrap) return;

  function openDropdown() {
    renderCompareDropdown();
    dropdown.removeAttribute('hidden');
  }

  function closeDropdown() {
    dropdown.setAttribute('hidden', '');
    // Clear hover preview
    if (hoverStore) {
      hoverStore = null;
      if (lastBenchmarkGroupData) renderBenchmarkChart(lastBenchmarkGroupData);
    }
  }

  function toggleDropdown(e) {
    e.stopPropagation();
    if (dropdown.hasAttribute('hidden')) openDropdown();
    else closeDropdown();
  }

  btn.addEventListener('click', toggleDropdown);

  // Chip clicks also open dropdown
  wrap.addEventListener('click', function (e) {
    var chip = e.target.closest('.compare-chip');
    if (!chip) return;
    e.stopPropagation();
    openDropdown();
  });

  dropdown.addEventListener('click', function (e) {
    var opt = e.target.closest('.store-opt');
    if (!opt) return;
    var store = opt.dataset.store;
    var idx = compareStores.indexOf(store);
    if (idx >= 0) {
      compareStores.splice(idx, 1);
    } else if (compareStores.length < COMPARE_COLORS.length) {
      compareStores.push(store);
    }
    hoverStore = null;
    renderCompareDropdown();
    renderCompareChips();
    if (lastBenchmarkGroupData) renderBenchmarkChart(lastBenchmarkGroupData);
  });

  dropdown.addEventListener('mouseover', function (e) {
    var opt = e.target.closest('.store-opt');
    if (!opt) return;
    var store = opt.dataset.store;
    if (store !== hoverStore && compareStores.indexOf(store) < 0) {
      hoverStore = store;
      if (lastBenchmarkGroupData) renderBenchmarkChart(lastBenchmarkGroupData);
    }
  });

  dropdown.addEventListener('mouseleave', function () {
    if (hoverStore) {
      hoverStore = null;
      if (lastBenchmarkGroupData) renderBenchmarkChart(lastBenchmarkGroupData);
    }
  });

  document.addEventListener('click', function (e) {
    if (!e.target.closest('.compare-wrap')) closeDropdown();
  });
})();

function renderCompareDropdown() {
  var dropdown = document.getElementById('compare-dropdown');
  if (!dropdown) return;
  var html = '';
  for (var i = 0; i < storeList.length; ++i) {
    var name = storeList[i].name;
    if (name === currentStore) continue;
    var isCompared = compareStores.indexOf(name) >= 0;
    var colorIdx = isCompared ? compareStores.indexOf(name) : -1;
    var cls = 'store-opt' + (isCompared ? ' store-opt-compared' : '');
    var colorDot = colorIdx >= 0
      ? '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + COMPARE_COLORS[colorIdx % COMPARE_COLORS.length] + ';margin-right:6px"></span>'
      : '';
    html += '<div class="' + cls + '" data-store="' + esc(name) + '">' + colorDot + esc(name) + '</div>';
  }
  dropdown.innerHTML = html;
}

function renderCompareChips() {
  var wrap = document.getElementById('compare-control');
  if (!wrap) return;
  // Remove old chips
  var oldChips = wrap.querySelectorAll('.compare-chip');
  for (var i = 0; i < oldChips.length; ++i) oldChips[i].remove();

  // Insert chips before the button
  var btn = document.getElementById('compare-btn');
  for (var j = 0; j < compareStores.length; ++j) {
    var color = COMPARE_COLORS[j % COMPARE_COLORS.length];
    var chip = document.createElement('button');
    chip.className = 'compare-chip';
    chip.dataset.store = compareStores[j];
    chip.style.background = color + '22';
    chip.style.color = color;
    chip.innerHTML = esc(compareStores[j]) + ' <span class="chip-x">&times;</span>';
    wrap.insertBefore(chip, btn);
  }

  // Update button text
  btn.textContent = compareStores.length ? '+' : '+ Compare';
}

async function refreshBenchmarkChart() {
  if (!runtimes['cf-trend'] || !currentStore) return;

  // Build isolated filter set: mirror all dashboard filters EXCEPT sold_location,
  // override product with benchmarkProduct if set
  var state = getState();
  var trendConfig = getCubeConfig('cf-trend');
  var benchmarkFilters = buildDashboardFilters(state, trendConfig.workerDimensions);
  delete benchmarkFilters.sold_location;
  if (benchmarkProduct) {
    benchmarkFilters.product = { type: 'in', values: [benchmarkProduct] };
  } else {
    delete benchmarkFilters.product;
  }

  var result;
  try {
    result = await runtimes['cf-trend'].query({
      isolatedFilters: benchmarkFilters,
      snapshot: false,
      groups: {
        byStoreDay: {
          sort: 'natural',
          limit: null,
          includeTotals: false,
        },
      },
    });
  } catch (err) {
    console.error('cf-trend benchmark query failed:', err);
    return;
  }

  lastBenchmarkGroupData = result && result.groups ? result.groups.byStoreDay : null;
  renderBenchmarkChart(lastBenchmarkGroupData);
}

function renderBenchmarkChart(groupData) {
  var el = document.getElementById('panel-benchmark');
  var contextTag = document.getElementById('benchmark-context');
  if (!el) return;

  var entries = groupData && groupData.entries ? groupData.entries : groupData || [];
  if (!entries.length) {
    if (benchmarkChart && !benchmarkChart.isDisposed()) benchmarkChart.dispose();
    benchmarkChart = null;
    el.innerHTML = '<div class="panel-empty">No time-series data for comparison</div>';
    if (contextTag) contextTag.textContent = '';
    return;
  }

  // Each entry: { key: timestamp, value: { "Store A": { events, products, lostSales, duration, days }, ... } }
  // Collect per-store daily metric values from the split group
  var storeDaily = {};
  var allDates = [];

  for (var i = 0; i < entries.length; ++i) {
    var dateKey = Number(entries[i].key);
    allDates.push(dateKey);
    var splits = entries[i].value;
    if (!splits) continue;
    for (var store in splits) {
      if (!storeDaily[store]) storeDaily[store] = {};
      storeDaily[store][dateKey] = splits[store];
    }
  }

  var buckets = bucketDates(allDates, benchmarkGranularity);

  // Metric config
  var METRIC_CONFIG = {
    availability: { label: 'Availability %', unit: '%', invert: true, format: function (v) { return v.toFixed(1) + '%'; } },
    events: { label: 'Stockout Events', unit: '', invert: false, format: function (v) { return Math.round(v); } },
    duration: { label: 'Avg Duration (days)', unit: 'd', invert: false, format: function (v) { return v.toFixed(1) + 'd'; } },
  };
  var mc = METRIC_CONFIG[benchmarkMetric] || METRIC_CONFIG.availability;

  var labels = [];
  var selectedLine = [];
  var avgLine = [];
  var bandLower = [];
  var bandUpper = [];
  var compareLines = {};
  var allCompareNames = compareStores.slice();
  if (hoverStore && compareStores.indexOf(hoverStore) < 0) allCompareNames.push(hoverStore);
  for (var ci = 0; ci < allCompareNames.length; ++ci) {
    compareLines[allCompareNames[ci]] = [];
  }
  var storeNames = Object.keys(storeDaily);
  var storeCount = storeNames.length;

  for (var b = 0; b < buckets.length; ++b) {
    var bucket = buckets[b];
    labels.push(bucket.label);
    var daysInBucket = bucket.dates.length;

    var storeValues = [];
    var selectedValue = 0;
    var compareValues = {};

    for (var s = 0; s < storeNames.length; ++s) {
      var storeName = storeNames[s];
      var val = computeStoreMetric(storeDaily[storeName], bucket.dates);
      storeValues.push(val);
      if (storeName === currentStore) selectedValue = val;
      if (allCompareNames.indexOf(storeName) >= 0) compareValues[storeName] = val;
    }

    // For availability: higher = better, so best = max, worst = min
    // For events/duration: lower = better, so best = min, worst = max
    storeValues.sort(function (a, b2) { return a - b2; });
    var sum = 0;
    for (var t = 0; t < storeValues.length; ++t) sum += storeValues[t];
    var avg = storeCount > 0 ? sum / storeCount : 0;

    selectedLine.push(Math.round(selectedValue * 100) / 100);
    avgLine.push(Math.round(avg * 100) / 100);

    bandLower.push(storeValues[0] || 0);
    bandUpper.push(storeValues[storeValues.length - 1] || 0);

    for (var cs = 0; cs < allCompareNames.length; ++cs) {
      var csName = allCompareNames[cs];
      compareLines[csName].push(Math.round((compareValues[csName] || 0) * 100) / 100);
    }
  }

  function computeStoreMetric(storeData, dates) {
    if (benchmarkMetric === 'availability') {
      // Availability = 100 * (1 - products_affected / (160 * observation_days))
      // 'days' metric counts actual observation rows (one per product-day with a stockout)
      // 'products' sums distinct products affected per observation day
      // For a proper ratio: products / days gives avg products stocked out per day
      var totalProducts = 0;
      var observationDays = 0;
      for (var d = 0; d < dates.length; ++d) {
        var entry = storeData ? storeData[dates[d]] : null;
        if (entry) {
          totalProducts += Number(entry.products) || 0;
          observationDays += Number(entry.days) || 0;
        }
      }
      // Each observation day has up to 160 products; 'days' counts product-day observations
      // so products/days is meaningless. Instead: products = sum of distinct products per week.
      // For weekly bucket: products = sum of daily distinct-product counts across the week.
      // Approximate daily avg: products / 7 (for a full week)
      var weeksInBucket = dates.length;
      var calendarDays = weeksInBucket * 7;
      if (!calendarDays) return 100;
      return 100 * (1 - totalProducts / (160 * calendarDays));
    }
    if (benchmarkMetric === 'duration') {
      var durSum = 0;
      var durCount = 0;
      for (var d = 0; d < dates.length; ++d) {
        var entry = storeData ? storeData[dates[d]] : null;
        if (entry && entry.duration != null) {
          durSum += Number(entry.duration) || 0;
          durCount += 1;
        }
      }
      return durCount > 0 ? durSum / durCount : 0;
    }
    // events (default)
    var total = 0;
    for (var d = 0; d < dates.length; ++d) {
      var entry = storeData ? storeData[dates[d]] : null;
      if (entry) total += Number(entry.events) || 0;
    }
    return total;
  }

  // Trim to last 52 weeks (discard leading partial/warm-up weeks)
  var maxBuckets = benchmarkGranularity === 'month' ? 12 : 52;
  if (labels.length > maxBuckets) {
    var trim = labels.length - maxBuckets;
    labels = labels.slice(trim);
    selectedLine = selectedLine.slice(trim);
    avgLine = avgLine.slice(trim);
    bandLower = bandLower.slice(trim);
    bandUpper = bandUpper.slice(trim);
    for (var tc = 0; tc < allCompareNames.length; ++tc) {
      compareLines[allCompareNames[tc]] = compareLines[allCompareNames[tc]].slice(trim);
    }
  }

  if (contextTag) {
    contextTag.textContent = benchmarkProduct
      ? benchmarkProduct
      : storeCount + ' stores · ' + benchmarkGranularity + 'ly';
  }

  if (benchmarkChart && !benchmarkChart.isDisposed()) {
    benchmarkChart.dispose();
  }
  el.innerHTML = '';
  benchmarkChart = echarts.init(el, THEME_NAME, { renderer: 'canvas' });

  benchmarkChart.setOption({
    animation: false,
    grid: { left: 50, right: 24, top: 36, bottom: 40 },
    legend: {
      top: 0,
      itemWidth: 10,
      itemHeight: 10,
      data: ['Your Store', 'Avg Store', 'Best Store', 'Worst Store'].concat(allCompareNames),
    },
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        var idx = params[0].dataIndex;
        var best = mc.invert ? bandUpper[idx] : bandLower[idx];
        var worst = mc.invert ? bandLower[idx] : bandUpper[idx];
        var tip = '<b>' + labels[idx] + '</b> — ' + mc.label + '<br>';
        tip += '<span style="color:' + namedColor('blue') + '">\u25cf</span> Your Store: ' + mc.format(selectedLine[idx]) + '<br>';
        tip += '<span style="color:' + namedColor('muted') + '">\u25cf</span> Avg Store: ' + mc.format(avgLine[idx]) + '<br>';
        tip += '<span style="color:' + namedColor('green') + '">\u25cf</span> Best Store: ' + mc.format(best) + '<br>';
        tip += '<span style="color:' + namedColor('red') + '">\u25cf</span> Worst Store: ' + mc.format(worst);
        for (var ci = 0; ci < allCompareNames.length; ++ci) {
          var isHov = allCompareNames[ci] === hoverStore && compareStores.indexOf(allCompareNames[ci]) < 0;
          var cColor = isHov ? namedColor('purple') : COMPARE_COLORS[ci % COMPARE_COLORS.length];
          var cVal = compareLines[allCompareNames[ci]] ? compareLines[allCompareNames[ci]][idx] : 0;
          tip += '<br><span style="color:' + cColor + '">\u25cf</span> ' + allCompareNames[ci] + ': ' + mc.format(cVal);
        }
        return tip;
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
    },
    yAxis: (function () {
      // Auto-zoom: compute tight Y range from all visible series
      var allVals = selectedLine.concat(avgLine, bandLower, bandUpper);
      var dataMin = Math.min.apply(null, allVals);
      var dataMax = Math.max.apply(null, allVals);
      var padding = (dataMax - dataMin) * 0.1 || 1;
      var yMin = Math.floor(dataMin - padding);
      var yMax = Math.ceil(dataMax + padding);
      if (benchmarkMetric === 'availability') {
        yMax = Math.min(yMax, 100);
        yMin = Math.max(yMin, 0);
      } else {
        yMin = Math.max(yMin, 0);
      }
      return {
        type: 'value',
        name: mc.label,
        nameTextStyle: { fontSize: 10 },
        min: yMin,
        max: yMax,
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
        axisLabel: benchmarkMetric === 'availability' ? { formatter: '{value}%' } : {},
      };
    })(),
    series: [
      // Band: best store baseline (invisible)
      {
        name: 'Best Store',
        type: 'line',
        stack: 'band',
        symbol: 'none',
        itemStyle: { color: namedColor('green') },
        lineStyle: { width: 1, color: namedColor('green'), opacity: 0.3 },
        areaStyle: { opacity: 0 },
        data: bandLower,
      },
      // Band: gap from best to worst (shaded — higher = worse)
      {
        name: 'Worst Store',
        type: 'line',
        stack: 'band',
        symbol: 'none',
        itemStyle: { color: namedColor('red') },
        lineStyle: { width: 1, color: namedColor('red'), opacity: 0.3 },
        areaStyle: {
          color: mc.invert ? {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(0,230,138,0.06)' },
              { offset: 1, color: 'rgba(255,77,106,0.12)' },
            ],
          } : {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(255,77,106,0.12)' },
              { offset: 1, color: 'rgba(0,230,138,0.06)' },
            ],
          },
        },
        data: bandUpper.map(function (v, idx) { return v - bandLower[idx]; }),
      },
      // Average store line
      {
        name: 'Avg Store',
        type: 'line',
        smooth: true,
        symbol: 'none',
        itemStyle: { color: namedColor('muted') },
        lineStyle: { width: 1.5, color: namedColor('muted'), type: 'dashed' },
        data: avgLine,
      },
      // Selected store line
      {
        name: 'Your Store',
        type: 'line',
        smooth: true,
        symbol: 'none',
        itemStyle: { color: namedColor('blue') },
        lineStyle: { width: 3, color: namedColor('blue') },
        data: selectedLine,
      },
    ].concat(allCompareNames.map(function (csName, idx) {
      var isHover = csName === hoverStore && compareStores.indexOf(csName) < 0;
      var color = isHover ? namedColor('purple') : COMPARE_COLORS[idx % COMPARE_COLORS.length];
      return {
        name: csName,
        type: 'line',
        smooth: true,
        symbol: 'none',
        itemStyle: { color: color },
        lineStyle: { width: isHover ? 2 : 2, color: color, type: isHover ? 'dashed' : 'solid' },
        data: compareLines[csName] || [],
      };
    })),
  }, true);
}

function bucketDates(sortedDates, granularity) {
  var buckets = [];
  var currentBucket = null;

  for (var i = 0; i < sortedDates.length; ++i) {
    var ts = sortedDates[i];
    var d = new Date(ts);
    var label;
    var bucketKey;

    if (granularity === 'month') {
      label = String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
      bucketKey = label;
    } else {
      // week — group entries are already weekly (Monday-bucketed)
      label = 'W ' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0');
      bucketKey = ts;
    }

    if (!currentBucket || currentBucket.key !== bucketKey) {
      currentBucket = { key: bucketKey, label: label, dates: [] };
      buckets.push(currentBucket);
    }
    currentBucket.dates.push(ts);
  }

  return buckets;
}

// ---- Product click (stockout table → benchmark chart) ----

onProductClick(function (product) {
  benchmarkProduct = benchmarkProduct === product ? null : product;
  highlightStockoutRow(benchmarkProduct);
  refreshBenchmarkChart();
});

function highlightStockoutRow(product) {
  var el = document.getElementById('panel-stockout-table');
  if (!el) return;
  var rows = el.querySelectorAll('tr[data-product]');
  for (var i = 0; i < rows.length; ++i) {
    rows[i].classList.toggle('risk-selected', rows[i].dataset.product === product);
  }
}

// ---- DOW product filter (from risk table click) ----

var dowSelectedProduct = null;

setProductClickHandler(async function (product) {
  dowSelectedProduct = product;
  var label = document.getElementById('dow-product-label');
  if (label) {
    if (product) { label.textContent = product; label.removeAttribute('hidden'); }
    else { label.setAttribute('hidden', ''); }
  }
  await applyDowFilters();
});

async function applyDowFilters() {
  if (!runtimes['cf-dow']) return;
  var state = getState();
  var filters = {};
  if (state.store) filters.sold_location = { type: 'in', values: [state.store] };
  if (dowSelectedProduct) filters.product = { type: 'in', values: [dowSelectedProduct] };
  await runtimes['cf-dow'].updateFilters(filters);
  try {
    var result = await runtimes['cf-dow'].rows({ fields: DOW_FIELDS, limit: 50000, columnar: true });
    renderDowPattern(result, echarts, THEME_NAME);
  } catch (err) { console.error('DOW query failed:', err); }
}

// ---- State Change Handler ----

onStateChange(async function (newState, prevState) {
  // No store selected → show picker
  if (!newState.store) {
    dom.dashboard.setAttribute('hidden', '');
    dom.picker.removeAttribute('hidden');
    return;
  }

  // Store selected → show dashboard
  dom.picker.setAttribute('hidden', '');
  dom.dashboard.removeAttribute('hidden');
  currentStore = newState.store;
  dom.storeName.textContent = currentStore;
  dom.storeSelector.value = currentStore;
  endedCategoryFilter = null;
  benchmarkProduct = null;
  compareStores = [];
  renderCompareChips();

  if (!workersReady) return; // still loading

  // Dispatch sold_location + other filters to ALL runtimes (instant, client-side)
  await dispatchFilters(newState);
  // Re-apply DOW product filter (dispatchFilters overwrites cf-dow filters)
  if (dowSelectedProduct) await applyDowFilters();
  await refreshAllPanels();
});

onPanelRefresh(function () {});

// ---- Resize ----

window.addEventListener('resize', function () {
  [document.getElementById('panel-benchmark'), document.getElementById('panel-dow'), document.getElementById('panel-category')].forEach(function (el) {
    if (el) {
      var instance = echarts.getInstanceByDom(el);
      if (instance) instance.resize();
    }
  });
});

// ---- Init ----

(async function init() {
  // Create all workers ONCE (loads all stores)
  await createWorkers();

  var state = getState();
  if (state.store) {
    // Store in URL → apply filter and show dashboard
    currentStore = state.store;
    dom.storeName.textContent = currentStore;
    dom.storeSelector.value = currentStore;
    dom.picker.setAttribute('hidden', '');
    dom.dashboard.removeAttribute('hidden');
    populateStoreSelector();
    await dispatchFilters(state);
    await refreshAllPanels();
  } else {
    // No store → show picker
    populateStoreSelector();
    showStorePicker();
  }
})();
