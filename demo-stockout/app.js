// demo-stockout/app.js
//
// Multi-crossfilter stockout dashboard.
//
// Architecture:
//   - 2 crossfilter workers from stockout_analysis, load ALL stores at startup
//   - sold_location is a crossfilter dimension — store switching is instant
//   - Color/label config loaded from Cube /api/meta (Principle 6)
//
// Query batching (2 postMessage round-trips per refresh):
//   - cf-main: query({ snapshot, rowSets: { stockout, forecast, risk, warning } })
//   - cf-dow:  rows({ fields, columnar: true })

import { registerTheme, THEME_NAME } from './theme.js';
import { getState, setState, onStateChange, PARAM_TO_DIMENSION } from './router.js';
import { ALL_CUBE_IDS, buildWorkerOptions, fetchStoreList, fetchEndedYesterday, fetchStartedYesterday, fetchEndedDayBefore, fetchStartedDayBefore, fetchMeta, getCubeConfig } from './cube-registry.js';
import { loadMeta } from './config.js';
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
var allEndedYesterday = [];
var allStartedYesterday = [];
var allEndedDayBefore = [];   // for KPI trend comparison
var allStartedDayBefore = [];
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

// ---- Store Selector ----

function populateStoreSelector() {
  var list = document.getElementById('store-list');
  if (!list) return;
  list.innerHTML = '';
  for (var i = 0; i < storeList.length; ++i) {
    var name = storeList[i].name;
    var f = storeFacets[name] || { active: 0, ended: 0, started: 0 };
    var opt = document.createElement('option');
    opt.value = name;
    opt.label = name + ' (' + f.active + '/' + f.ended + '/' + f.started + ')';
    list.appendChild(opt);
  }
  dom.storeSelector.value = currentStore || '';
}

// Search-as-you-type store selection (Principle 4: searchable high-cardinality)
dom.storeSelector.addEventListener('change', onStoreSearch);
dom.storeSelector.addEventListener('input', onStoreSearch);

function onStoreSearch() {
  var val = dom.storeSelector.value;
  // Only navigate if the value exactly matches a store name
  var match = storeList.some(function (s) { return s.name === val; });
  if (match && val !== currentStore) {
    var patch = { store: val };
    for (var param in PARAM_TO_DIMENSION) patch[param] = null;
    setState(patch);
  }
}

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
  setOverlay(true, 'Starting...');

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
          stockout: { fields: MAIN_FIELDS, sortBy: 'risk_score', direction: 'top', columnar: true },
          forecast: { fields: MAIN_FIELDS, sortBy: 'forecast_stockout_probability', direction: 'top', columnar: true },
          risk:     { fields: MAIN_FIELDS, sortBy: 'risk_score', direction: 'top', columnar: true },
          warning:  { fields: MAIN_FIELDS, sortBy: 'risk_score', direction: 'top', columnar: true },
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
    var result = await runtimes['cf-dow'].rows({ fields: DOW_FIELDS, columnar: true });
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
