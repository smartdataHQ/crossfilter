// demo-stockout/app.js
//
// Entry point: startup, store picker, worker orchestration, panel wiring.
//
// Optimization strategy:
//   - 3 crossfilter workers (cf-store, cf-warning, cf-dow) created in parallel
//   - 2 lightweight JSON fetches (ended/started yesterday) in parallel with workers
//   - Each worker gets ONE batched query() call per refresh cycle:
//     cf-store:   snapshot + 3 rowSets (stockout, forecast, risk) in 1 round-trip
//     cf-warning: 1 rows() call (used by stockout table + early warning)
//     cf-dow:     1 rows() call
//   - Total: 3 postMessage round-trips per refresh (was 8)

import { registerTheme, THEME_NAME } from './theme.js';
import { getState, setState, onStateChange, PARAM_TO_DIMENSION } from './router.js';
import { ALL_CUBE_IDS, buildWorkerOptions, fetchStoreList, fetchEndedYesterday, fetchStartedYesterday, getCubeConfig } from './cube-registry.js';
import { registerRuntime, dispatchFilters, disposeAll, onPanelRefresh } from './filter-router.js';
import { renderKpis } from './panels/kpis.js';
import { renderStockoutTable } from './panels/stockout-table.js';
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
var loadToken = 0;
var endedYesterdayData = [];
var startedYesterdayData = [];
var endedCategoryFilter = null;
var lastWarningRows = null; // cached cf-warning rows, shared by stockout table + early warning

// ---- DOM refs ----

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

// ---- Helpers ----

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
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Math.round(v) + '';
}

// ---- Store Picker ----

async function showStorePicker() {
  setOverlay(true, 'Loading stores...');
  try {
    storeList = await fetchStoreList();
  } catch (err) {
    setOverlay(false);
    dom.picker.removeAttribute('hidden');
    dom.storeGrid.innerHTML = '<div class="panel-error">Failed to load stores: ' + err.message + '</div>';
    return;
  }
  setOverlay(false);

  dom.storeGrid.innerHTML = '';
  for (var i = 0; i < storeList.length; ++i) {
    var store = storeList[i];
    var btn = document.createElement('button');
    btn.className = 'store-btn';
    btn.innerHTML = store.name + '<span class="store-btn-count">' + (store.count || 0) + ' products</span>';
    btn.dataset.store = store.name;
    btn.addEventListener('click', function (e) { setState({ store: e.currentTarget.dataset.store }); });
    dom.storeGrid.appendChild(btn);
  }

  dom.picker.removeAttribute('hidden');
}

// ---- Store Selector ----

function populateStoreSelector() {
  dom.storeSelector.innerHTML = '';
  for (var i = 0; i < storeList.length; ++i) {
    var opt = document.createElement('option');
    opt.value = storeList[i].name;
    opt.textContent = storeList[i].name;
    dom.storeSelector.appendChild(opt);
  }
  dom.storeSelector.value = currentStore || '';
}

dom.storeSelector.addEventListener('change', function () {
  var newStore = dom.storeSelector.value;
  if (newStore && newStore !== currentStore) {
    var patch = { store: newStore };
    for (var param in PARAM_TO_DIMENSION) patch[param] = null;
    setState(patch);
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

// ---- Worker Creation ----

async function createWorker(cubeId, store, token) {
  var opts = buildWorkerOptions(cubeId, store);
  var runtime = await crossfilter.createStreamingDashboardWorker(opts);
  if (token !== loadToken) { await runtime.dispose(); return null; }

  await runtime.ready;
  if (token !== loadToken) { await runtime.dispose(); return null; }

  var config = getCubeConfig(cubeId);
  registerRuntime(cubeId, runtime, config.workerDimensions);
  runtimes[cubeId] = runtime;
  return runtime;
}

async function loadDashboard(store) {
  var token = ++loadToken;
  currentStore = store;

  dom.picker.setAttribute('hidden', '');
  dom.dashboard.removeAttribute('hidden');
  dom.storeName.textContent = store;
  populateStoreSelector();
  setOverlay(true, 'Loading data for ' + store + '...');

  showShimmer('panel-trend');
  showShimmer('panel-category');
  showShimmer('panel-stockout-table');
  showShimmer('panel-forecast-table');
  showShimmer('panel-risk');
  showShimmer('panel-dow');
  showShimmer('panel-early-warning');
  dom.kpiRow.innerHTML = '<div class="shimmer" style="grid-column:1/-1;min-height:80px;"></div>';

  // All network requests in parallel: 3 workers + 2 yesterday fetches
  var results = await Promise.allSettled(
    ALL_CUBE_IDS.map(function (cubeId) {
      return createWorker(cubeId, store, token);
    }).concat([
      fetchEndedYesterday(store).then(function (data) { endedYesterdayData = data; }),
      fetchStartedYesterday(store).then(function (data) { startedYesterdayData = data; }),
    ])
  );

  if (token !== loadToken) return;

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

  setOverlay(false);

  var state = getState();
  await dispatchFilters(state);
  await refreshAllPanels();
}

// ---- Batched Panel Refresh ----
//
// Key optimization: each worker gets ONE query() call per refresh cycle.
// cf-store: snapshot (KPIs) + 3 rowSets (stockout, forecast, risk) = 1 round-trip
// cf-warning: 1 rows() call, result shared by stockout table + early warning
// cf-dow: 1 rows() call

// All fields needed from cf-store across all panels
var STORE_FIELDS = [
  'product', 'product_category', 'supplier', 'risk_score',
  'avg_duration_days', 'median_duration_days', 'stddev_duration_days',
  'total_expected_lost_sales', 'trend_signal', 'severity_trend',
  'is_currently_active', 'dow_pattern', 'highest_risk_day',
  'stockouts_per_month', 'total_stockouts', 'confirmed_stockouts',
  'avg_days_between_stockouts', 'days_since_last',
  'forecast_stockout_probability', 'forecast_warning',
];

var WARNING_FIELDS = [
  'product', 'product_category', 'supplier',
  'trend_signal', 'severity_trend', 'is_currently_active',
  'risk_score', 'forecast_stockout_probability', 'forecast_warning',
  'avg_duration_recent_half', 'avg_duration_older_half',
  'frequency_recent_per_month', 'frequency_older_per_month',
  'avg_impact_recent_half', 'avg_impact_older_half',
];

var DOW_FIELDS = [
  'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
  'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
  'dow_mon_probability', 'dow_tue_probability', 'dow_wed_probability',
  'dow_thu_probability', 'dow_fri_probability', 'dow_sat_probability', 'dow_sun_probability',
  'weekday_stockout_rate', 'weekend_stockout_rate', 'dow_pattern', 'highest_risk_day',
];

async function refreshAllPanels() {
  // 3 worker queries in parallel (1 round-trip each)
  var promises = [];

  // cf-store: ONE query() with snapshot + 3 rowSets
  if (runtimes['cf-store']) {
    promises.push(
      runtimes['cf-store'].query({
        snapshot: {},
        rowCount: true,
        rowSets: {
          stockout: { fields: STORE_FIELDS, limit: 200, sortBy: 'risk_score', direction: 'top', columnar: true },
          forecast: { fields: STORE_FIELDS, limit: 200, sortBy: 'forecast_stockout_probability', direction: 'top', columnar: true },
          risk:     { fields: STORE_FIELDS, limit: 50, sortBy: 'risk_score', direction: 'top', columnar: true },
        },
      }).catch(function (err) { console.error('cf-store query failed:', err); return null; })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  // cf-warning: ONE rows() call, shared by stockout table merge + early warning
  if (runtimes['cf-warning']) {
    promises.push(
      runtimes['cf-warning'].rows({
        fields: WARNING_FIELDS, limit: 500, sortBy: 'risk_score', direction: 'top', columnar: true,
      }).catch(function (err) { console.error('cf-warning query failed:', err); return null; })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  // cf-dow: ONE rows() call
  if (runtimes['cf-dow']) {
    promises.push(
      runtimes['cf-dow'].rows({
        fields: DOW_FIELDS, limit: 5000, columnar: true,
      }).catch(function (err) { console.error('cf-dow query failed:', err); return null; })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  var results = await Promise.all(promises);
  var storeResult = results[0];
  var warningRows = results[1];
  var dowRows = results[2];

  // Cache warning rows for shared use
  lastWarningRows = warningRows;

  // Render all panels from the batched results (no more async, pure rendering)
  if (storeResult) {
    renderKpis(storeResult.snapshot, endedYesterdayData, startedYesterdayData);
    renderStockoutTable(storeResult.rowSets.stockout, warningRows);
    renderForecast(storeResult.rowSets.forecast);
    renderRiskChart(storeResult.rowSets.risk, warningRows);
  } else {
    renderKpis(null, endedYesterdayData, startedYesterdayData);
    document.getElementById('panel-stockout-table').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    document.getElementById('panel-forecast-table').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    document.getElementById('panel-risk').innerHTML = '<div class="panel-empty">Data unavailable</div>';
  }

  renderEarlyWarning(warningRows);
  renderDowPattern(dowRows, echarts, THEME_NAME);
  refreshEndedYesterday();
  renderFilterChips();
}

// ---- Ended Yesterday (local data, no crossfilter) ----

function refreshEndedYesterday() {
  renderEndedYesterdayTable(endedYesterdayData, endedCategoryFilter);
  renderEndedCategoryPie(endedYesterdayData);
}

function renderEndedYesterdayTable(data, categoryFilter) {
  var el = document.getElementById('panel-trend');
  if (!el) return;

  var filtered = data || [];
  if (categoryFilter) {
    filtered = filtered.filter(function (r) { return r.category === categoryFilter; });
  }

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
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + esc(r.category) + '</td>' +
      '<td>' + r.durationDays.toFixed(1) + 'd</td>' +
      '<td>' + formatISKShort(r.lostSales) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table></div>';
  el.innerHTML = html;
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
      renderEndedYesterdayTable(endedYesterdayData, endedCategoryFilter);
      renderEndedCategoryPie(endedYesterdayData);
    });
  }

  categoryPieInstance.setOption({
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie',
      radius: ['30%', '70%'],
      center: ['50%', '50%'],
      data: pieData.map(function (d) {
        var selected = d.name === endedCategoryFilter;
        return {
          name: d.name, value: d.value, selected: selected,
          itemStyle: selected ? { borderColor: '#e8edf3', borderWidth: 2 } : {},
        };
      }),
      label: { fontSize: 10, color: '#7a8a9e', formatter: '{b}\n{c}' },
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } },
      selectedMode: 'single',
      selectedOffset: 6,
    }],
  }, true);
}

// ---- DOW product filter (from risk table click) ----

var dowProductFilter = null;

setProductClickHandler(async function (product) {
  dowProductFilter = product;
  var label = document.getElementById('dow-product-label');
  if (label) {
    if (product) { label.textContent = product; label.removeAttribute('hidden'); }
    else { label.setAttribute('hidden', ''); }
  }
  if (!runtimes['cf-dow']) return;
  await runtimes['cf-dow'].updateFilters(product ? { product: { type: 'in', values: [product] } } : {});
  // Re-fetch DOW only (1 round-trip)
  try {
    var result = await runtimes['cf-dow'].rows({ fields: DOW_FIELDS, limit: 5000, columnar: true });
    renderDowPattern(result, echarts, THEME_NAME);
  } catch (err) {
    console.error('DOW query failed:', err);
  }
});

// ---- State Change Handler ----

onStateChange(async function (newState, prevState) {
  if (newState.store !== (prevState && prevState.store)) {
    if (!newState.store) {
      await disposeAll();
      runtimes = {};
      dom.dashboard.setAttribute('hidden', '');
      showStorePicker();
      return;
    }
    if (categoryPieInstance) { categoryPieInstance.dispose(); categoryPieInstance = null; }
    disposeDow();
    endedCategoryFilter = null;
    lastWarningRows = null;
    await disposeAll();
    runtimes = {};
    await loadDashboard(newState.store);
    return;
  }

  // Filter change: dispatch to all runtimes, then one batched refresh
  await dispatchFilters(newState);
  await refreshAllPanels();
});

onPanelRefresh(function () {});

// ---- Resize ----

window.addEventListener('resize', function () {
  [document.getElementById('panel-dow'), document.getElementById('panel-category')].forEach(function (el) {
    if (el) {
      var instance = echarts.getInstanceByDom(el);
      if (instance) instance.resize();
    }
  });
});

// ---- Init ----

(async function init() {
  var state = getState();

  if (!state.store) {
    await showStorePicker();
  } else {
    fetchStoreList().then(function (stores) {
      storeList = stores;
      populateStoreSelector();
    }).catch(function () {});

    await loadDashboard(state.store);
  }
})();
