// demo-stockout/app.js
//
// Multi-crossfilter stockout dashboard.
//
// Architecture:
//   - 3 crossfilter workers load ALL stores at startup (one Arrow stream each)
//   - sold_location is a crossfilter dimension in every worker
//   - Selecting a store dispatches sold_location filter to all 3 runtimes
//   - Store switching is instant (client-side filter, no re-fetch)
//   - Yesterday data loaded once, filtered by store in JS
//
// Query batching:
//   - cf-store:   1 query() with snapshot + 3 rowSets per refresh
//   - cf-warning: 1 rows() call shared by stockout table + early warning
//   - cf-dow:     1 rows() call
//   - Total: 3 postMessage round-trips per refresh cycle

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
var workersReady = false;
var allEndedYesterday = [];   // all stores
var allStartedYesterday = []; // all stores
var endedCategoryFilter = null;

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
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
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

// ---- Worker Creation (once, all stores) ----

async function createWorkers() {
  setOverlay(true, 'Loading all store data...');

  showShimmer('panel-trend');
  showShimmer('panel-category');
  showShimmer('panel-stockout-table');
  showShimmer('panel-forecast-table');
  showShimmer('panel-risk');
  showShimmer('panel-dow');
  showShimmer('panel-early-warning');
  dom.kpiRow.innerHTML = '<div class="shimmer" style="grid-column:1/-1;min-height:80px;"></div>';

  // All network requests in parallel: 3 workers + 2 yesterday fetches + store list
  var results = await Promise.allSettled(
    ALL_CUBE_IDS.map(function (cubeId) {
      var opts = buildWorkerOptions(cubeId);
      return crossfilter.createStreamingDashboardWorker(opts).then(function (runtime) {
        return runtime.ready.then(function () {
          var config = getCubeConfig(cubeId);
          registerRuntime(cubeId, runtime, config.workerDimensions);
          runtimes[cubeId] = runtime;
          return runtime;
        });
      });
    }).concat([
      fetchEndedYesterday().then(function (data) { allEndedYesterday = data; }),
      fetchStartedYesterday().then(function (data) { allStartedYesterday = data; }),
      fetchStoreList().then(function (stores) { storeList = stores; }),
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
  populateStoreSelector();
  setOverlay(false);
}

// ---- Batched Panel Refresh ----
//
// 3 worker round-trips per refresh:
//   cf-store:   query({ snapshot, rowSets: { stockout, forecast, risk } })
//   cf-warning: rows({ ... })
//   cf-dow:     rows({ ... })

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
  if (!workersReady) return;

  var promises = [];

  // cf-store: ONE query with snapshot + 3 rowSets
  if (runtimes['cf-store']) {
    promises.push(
      runtimes['cf-store'].query({
        snapshot: {},
        rowCount: true,
        rowSets: {
          stockout: { fields: STORE_FIELDS, limit: 500, sortBy: 'risk_score', direction: 'top', columnar: true },
          forecast: { fields: STORE_FIELDS, limit: 500, sortBy: 'forecast_stockout_probability', direction: 'top', columnar: true },
          risk:     { fields: STORE_FIELDS, limit: 200, sortBy: 'risk_score', direction: 'top', columnar: true },
        },
      }).catch(function (err) { console.error('cf-store query failed:', err); return null; })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  // cf-warning: ONE rows() call
  if (runtimes['cf-warning']) {
    promises.push(
      runtimes['cf-warning'].rows({
        fields: WARNING_FIELDS, limit: 1000, sortBy: 'risk_score', direction: 'top', columnar: true,
      }).catch(function (err) { console.error('cf-warning query failed:', err); return null; })
    );
  } else {
    promises.push(Promise.resolve(null));
  }

  // cf-dow: ONE rows() call
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
  var storeResult = results[0];
  var warningRows = results[1];
  var dowRows = results[2];

  // Render all panels synchronously from batched results
  var ended = endedForStore();
  var started = startedForStore();

  if (storeResult) {
    renderKpis(storeResult.snapshot, ended, started);
    renderStockoutTable(storeResult.rowSets.stockout, warningRows);
    renderForecast(storeResult.rowSets.forecast);
    renderRiskChart(storeResult.rowSets.risk, warningRows);
  } else {
    renderKpis(null, ended, started);
    document.getElementById('panel-stockout-table').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    document.getElementById('panel-forecast-table').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    document.getElementById('panel-risk').innerHTML = '<div class="panel-empty">Data unavailable</div>';
  }

  renderEarlyWarning(warningRows);
  renderDowPattern(dowRows, echarts, THEME_NAME);
  refreshEndedYesterday();
  renderFilterChips();
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

// ---- DOW product filter (from risk table click) ----

setProductClickHandler(async function (product) {
  var label = document.getElementById('dow-product-label');
  if (label) {
    if (product) { label.textContent = product; label.removeAttribute('hidden'); }
    else { label.setAttribute('hidden', ''); }
  }
  if (!runtimes['cf-dow']) return;
  // Apply product filter ON TOP of existing store filter
  var state = getState();
  var filters = {};
  if (state.store) filters.sold_location = { type: 'in', values: [state.store] };
  if (product) filters.product = { type: 'in', values: [product] };
  await runtimes['cf-dow'].updateFilters(filters);
  try {
    var result = await runtimes['cf-dow'].rows({ fields: DOW_FIELDS, limit: 50000, columnar: true });
    renderDowPattern(result, echarts, THEME_NAME);
  } catch (err) { console.error('DOW query failed:', err); }
});

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

  if (!workersReady) return; // still loading

  // Dispatch sold_location + other filters to ALL runtimes (instant, client-side)
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
