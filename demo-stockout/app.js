// demo-stockout/app.js
//
// Entry point: startup, store picker, worker orchestration, panel wiring.

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

// Wire risk table product click -> DOW chart filter
var dowProductFilter = null;
setProductClickHandler(async function (product) {
  dowProductFilter = product;
  var label = document.getElementById('dow-product-label');
  if (label) {
    if (product) { label.textContent = product; label.removeAttribute('hidden'); }
    else { label.setAttribute('hidden', ''); }
  }
  if (!runtimes['cf-dow']) return;
  if (product) {
    await runtimes['cf-dow'].updateFilters({ product: { type: 'in', values: [product] } });
  } else {
    await runtimes['cf-dow'].updateFilters({});
  }
  await refreshDow();
});

// State
var runtimes = {};    // { cubeId: runtime }
var storeList = [];
var currentStore = null;
var loadToken = 0;
var endedYesterdayData = [];
var startedYesterdayData = [];
var endedCategoryFilter = null; // local filter for ended-yesterday pie chart

// DOM refs
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
  if (show) {
    dom.overlay.removeAttribute('hidden');
  } else {
    dom.overlay.setAttribute('hidden', '');
  }
}

function showShimmer(elId) {
  var el = document.getElementById(elId);
  if (el && !el.querySelector('.shimmer')) {
    el.innerHTML = '<div class="shimmer" style="margin:12px;min-height:120px;"></div>';
  }
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
    btn.addEventListener('click', onStoreClick);
    dom.storeGrid.appendChild(btn);
  }

  dom.picker.removeAttribute('hidden');
}

function onStoreClick(e) {
  var storeName = e.currentTarget.dataset.store;
  setState({ store: storeName });
}

// ---- Store Selector Dropdown ----

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
    // Clear all filters and set new store
    var patch = { store: newStore };
    for (var param in PARAM_TO_DIMENSION) {
      patch[param] = null;
    }
    setState(patch);
  }
});

// ---- Filter Chips ----

function renderFilterChips() {
  var state = getState();
  var chips = [];

  for (var param in PARAM_TO_DIMENSION) {
    var val = state[param];
    if (!val) continue;
    var label = param.charAt(0).toUpperCase() + param.slice(1);
    chips.push({ param: param, label: label + ': ' + val });
  }

  dom.filterChips.innerHTML = '';
  for (var i = 0; i < chips.length; ++i) {
    var chip = document.createElement('button');
    chip.className = 'filter-chip';
    chip.dataset.param = chips[i].param;
    chip.innerHTML = chips[i].label + ' <span class="chip-x">&times;</span>';
    chip.addEventListener('click', onChipRemove);
    dom.filterChips.appendChild(chip);
  }

  if (chips.length > 0) {
    dom.clearBtn.removeAttribute('hidden');
  } else {
    dom.clearBtn.setAttribute('hidden', '');
  }
}

function onChipRemove(e) {
  var param = e.currentTarget.dataset.param;
  var patch = {};
  patch[param] = null;
  setState(patch);
}

dom.clearBtn.addEventListener('click', function () {
  var patch = {};
  for (var param in PARAM_TO_DIMENSION) {
    patch[param] = null;
  }
  setState(patch);
});

// ---- Worker Creation ----

async function createWorker(cubeId, store, token) {
  var opts = buildWorkerOptions(cubeId, store);
  var runtime = await crossfilter.createStreamingDashboardWorker(opts);
  if (token !== loadToken) {
    await runtime.dispose();
    return null;
  }

  await runtime.ready;
  if (token !== loadToken) {
    await runtime.dispose();
    return null;
  }

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

  // Show shimmers
  showShimmer('panel-trend');
  showShimmer('panel-category');
  showShimmer('panel-stockout-table');
  showShimmer('panel-forecast-table');
  showShimmer('panel-risk');
  showShimmer('panel-dow');
  showShimmer('panel-early-warning');
  dom.kpiRow.innerHTML = '<div class="shimmer" style="grid-column:1/-1;min-height:80px;"></div>';

  // Create workers + fetch yesterday data in parallel
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
      console.error('Worker creation failed for ' + ALL_CUBE_IDS[i] + ':',
        results[i].status === 'rejected' ? results[i].reason : 'returned null');
    }
  }

  if (failedCubes.length === ALL_CUBE_IDS.length) {
    setOverlay(false);
    dom.kpiRow.innerHTML = '<div class="panel-error" style="grid-column:1/-1;">Failed to load any data for this store.</div>';
    return;
  }

  setOverlay(false);

  // Apply initial filters from URL
  var state = getState();
  await dispatchFilters(state);

  // Initial render
  await refreshAllPanels();
}

// ---- Panel Rendering ----

async function refreshAllPanels() {
  await Promise.all([
    refreshKpis(),
    refreshStockoutTable(),
    refreshForecast(),
    refreshRiskChart(),
    refreshEarlyWarning(),
    refreshDow(),
  ]);
  refreshEndedYesterday();
  renderFilterChips();
}

async function refreshKpis() {
  var storeSnapshot = null;

  if (runtimes['cf-store']) {
    try {
      var storeResult = await runtimes['cf-store'].query({
        snapshot: {},
        rowCount: true,
      });
      storeSnapshot = storeResult.snapshot;
    } catch (err) { console.error('KPI store query failed:', err); }
  }

  renderKpis(storeSnapshot, endedYesterdayData, startedYesterdayData);
}

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
    el.innerHTML = '<div class="panel-empty">' + (categoryFilter ? 'No ended stockouts in ' + esc(categoryFilter) : 'No confirmed stockouts ended yesterday') + '</div>';
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

  // Count by category
  var counts = {};
  for (var i = 0; i < data.length; ++i) {
    var cat = data[i].category || 'Unknown';
    counts[cat] = (counts[cat] || 0) + 1;
  }

  var pieData = [];
  for (var key in counts) {
    pieData.push({ name: key, value: counts[key] });
  }
  pieData.sort(function (a, b) { return b.value - a.value; });

  if (!categoryPieInstance || categoryPieInstance.isDisposed()) {
    categoryPieInstance = echarts.init(el, THEME_NAME, { renderer: 'canvas' });
    categoryPieInstance.on('click', function (params) {
      if (params.name === endedCategoryFilter) {
        endedCategoryFilter = null; // toggle off
      } else {
        endedCategoryFilter = params.name;
      }
      renderEndedYesterdayTable(endedYesterdayData, endedCategoryFilter);
      // Re-render pie to show selection
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
          name: d.name,
          value: d.value,
          selected: selected,
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

async function refreshStockoutTable() {
  if (!runtimes['cf-store']) {
    document.getElementById('panel-stockout-table').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    return;
  }
  try {
    // Fetch store data + warning trending data in parallel
    var storeFields = [
      'product', 'product_category', 'supplier', 'risk_score',
      'avg_duration_days', 'median_duration_days', 'stddev_duration_days',
      'total_expected_lost_sales', 'trend_signal', 'severity_trend',
      'is_currently_active', 'dow_pattern', 'highest_risk_day',
      'stockouts_per_month', 'total_stockouts', 'confirmed_stockouts',
      'avg_days_between_stockouts', 'days_since_last',
    ];
    var warningFields = [
      'product', 'avg_duration_recent_half', 'avg_duration_older_half',
      'frequency_recent_per_month', 'frequency_older_per_month',
      'avg_impact_recent_half', 'avg_impact_older_half',
    ];

    var promises = [
      runtimes['cf-store'].rows({ fields: storeFields, limit: 200, sortBy: 'risk_score', direction: 'top', columnar: true }),
    ];
    if (runtimes['cf-warning']) {
      promises.push(runtimes['cf-warning'].rows({ fields: warningFields, limit: 500, sortBy: 'risk_score', direction: 'top', columnar: true }));
    }

    var results = await Promise.all(promises);
    renderStockoutTable(results[0], results[1] || null);
  } catch (err) {
    console.error('Stockout table query failed:', err);
    document.getElementById('panel-stockout-table').innerHTML = '<div class="panel-error">Failed to load</div>';
  }
}

async function refreshForecast() {
  if (!runtimes['cf-store']) {
    document.getElementById('panel-forecast-table').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    return;
  }
  try {
    var forecastFields = [
      'product', 'product_category', 'supplier', 'forecast_stockout_probability',
      'days_since_last', 'stockouts_per_month', 'highest_risk_day',
      'is_currently_active', 'forecast_warning', 'risk_score',
      'avg_duration_days', 'trend_signal', 'dow_pattern',
    ];
    var result = await runtimes['cf-store'].rows({
      fields: forecastFields,
      limit: 200,
      sortBy: 'forecast_stockout_probability',
      direction: 'top',
      columnar: true,
    });
    renderForecast(result);
  } catch (err) {
    console.error('Forecast query failed:', err);
    document.getElementById('panel-forecast-table').innerHTML = '<div class="panel-error">Failed to load</div>';
  }
}

async function refreshRiskChart() {
  if (!runtimes['cf-store']) {
    document.getElementById('panel-risk').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    return;
  }
  try {
    var riskFields = [
      'product', 'risk_score', 'is_currently_active',
      'forecast_stockout_probability', 'forecast_warning',
      'stockouts_per_month', 'avg_duration_days', 'median_duration_days',
      'stddev_duration_days', 'days_since_last', 'confirmed_stockouts',
      'dow_pattern', 'highest_risk_day', 'trend_signal',
    ];
    var promises = [
      runtimes['cf-store'].rows({ fields: riskFields, limit: 50, sortBy: 'risk_score', direction: 'top', columnar: true }),
    ];
    if (runtimes['cf-warning']) {
      promises.push(runtimes['cf-warning'].rows({
        fields: ['product', 'avg_duration_recent_half', 'avg_duration_older_half',
          'frequency_recent_per_month', 'frequency_older_per_month'],
        limit: 500, sortBy: 'risk_score', direction: 'top', columnar: true,
      }));
    }
    var results = await Promise.all(promises);
    renderRiskChart(results[0], results[1] || null);
  } catch (err) {
    console.error('Risk table query failed:', err);
    document.getElementById('panel-risk').innerHTML = '<div class="panel-error">Failed to load</div>';
  }
}

async function refreshEarlyWarning() {
  if (!runtimes['cf-warning']) {
    document.getElementById('panel-early-warning').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    return;
  }
  try {
    var result = await runtimes['cf-warning'].rows({
      fields: [
        'product', 'product_category', 'supplier',
        'trend_signal', 'severity_trend', 'is_currently_active',
        'risk_score', 'forecast_stockout_probability', 'forecast_warning',
        'avg_duration_recent_half', 'avg_duration_older_half',
        'frequency_recent_per_month', 'frequency_older_per_month',
        'avg_impact_recent_half', 'avg_impact_older_half',
      ],
      limit: 500,
      sortBy: 'risk_score',
      direction: 'top',
      columnar: true,
    });
    renderEarlyWarning(result);
  } catch (err) {
    console.error('Early warning query failed:', err);
    document.getElementById('panel-early-warning').innerHTML = '<div class="panel-error">Failed to load</div>';
  }
}

async function refreshDow() {
  if (!runtimes['cf-dow']) {
    document.getElementById('panel-dow').innerHTML = '<div class="panel-empty">Data unavailable</div>';
    return;
  }
  try {
    var result = await runtimes['cf-dow'].rows({
      fields: [
        'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
        'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
        'dow_mon_probability', 'dow_tue_probability', 'dow_wed_probability',
        'dow_thu_probability', 'dow_fri_probability', 'dow_sat_probability', 'dow_sun_probability',
        'weekday_stockout_rate', 'weekend_stockout_rate', 'dow_pattern', 'highest_risk_day',
      ],
      limit: 5000,
      columnar: true,
    });
    renderDowPattern(result, echarts, THEME_NAME);
  } catch (err) {
    console.error('DOW query failed:', err);
    document.getElementById('panel-dow').innerHTML = '<div class="panel-error">Failed to load</div>';
  }
}

// ---- State Change Handler ----

onStateChange(async function (newState, prevState) {
  // Store change -> full reload
  if (newState.store !== (prevState && prevState.store)) {
    if (!newState.store) {
      // No store -> show picker
      await disposeAll();
      runtimes = {};
      dom.dashboard.setAttribute('hidden', '');
      showStorePicker();
      return;
    }
    // New store -> dispose and reload
    if (categoryPieInstance) { categoryPieInstance.dispose(); categoryPieInstance = null; }
    disposeDow();
    endedCategoryFilter = null;
    await disposeAll();
    runtimes = {};
    await loadDashboard(newState.store);
    return;
  }

  // Filter change -> dispatch to runtimes
  await dispatchFilters(newState);
  await refreshAllPanels();
});

// Wire panel refresh callback from filter-router
onPanelRefresh(function () {
  // Already handled by refreshAllPanels in state change handler
});

// Resize handler for ECharts
window.addEventListener('resize', function () {
  var dowEl = document.getElementById('panel-dow');
  var catEl = document.getElementById('panel-category');

  [dowEl, catEl].forEach(function (el) {
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
    // Load store list in background for the selector dropdown
    fetchStoreList().then(function (stores) {
      storeList = stores;
      populateStoreSelector();
    }).catch(function (err) {
      console.warn('Failed to load store list for dropdown:', err);
    });

    await loadDashboard(state.store);
  }
})();
