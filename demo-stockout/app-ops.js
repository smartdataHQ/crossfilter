// demo-stockout/app-ops.js
//
// Operator-focused stockout dashboard.

import { registerTheme, THEME_NAME } from './theme.js';
import { getState, setState, onStateChange, PARAM_TO_DIMENSION } from './router.js';
import {
  ALL_CUBE_IDS,
  buildWorkerOptions,
  fetchStoreList,
  fetchEndedYesterday,
  fetchStartedYesterday,
  fetchEndedDayBefore,
  fetchStartedDayBefore,
  fetchMeta,
  getCubeConfig,
} from './cube-registry-ops.js';
import { loadMeta, colorFor, namedColor } from './config.js';
import { registerRuntime, dispatchFilters } from './filter-router.js';
import { columnarToRows, esc, isActive, fieldBadge, fmtDur, fmtFreq, fmtISK, scoreBar } from './panels/helpers.js';

var crossfilter = globalThis.crossfilter;
var echarts = globalThis.echarts;

if (!crossfilter) throw new Error('crossfilter not loaded');
if (!echarts) throw new Error('echarts not loaded');

registerTheme(echarts);

var runtimes = {};
var storeList = [];
var currentStore = null;
var workersReady = false;
var allEndedYesterday = [];
var allStartedYesterday = [];
var allEndedDayBefore = [];
var allStartedDayBefore = [];
var storeFacets = {};
var actionNowChart = null;
var actionNextChart = null;
var actionWatchChart = null;
var trendChart = null;
var categoryChart = null;
var dowChart = null;
var localState = {
  focusProduct: null,
  queueView: 'all',
};
var latestViewModel = null;

var MAIN_FIELDS = [
  'product', 'product_category', 'supplier',
  'risk_score', 'risk_tier',
  'avg_duration_days',
  'days_since_last',
  'stockouts_per_month',
  'forecast_stockout_probability', 'forecast_tier', 'forecast_warning',
  'trend_signal', 'severity_trend', 'stockout_pattern',
  'is_currently_active', 'highest_risk_day', 'signal_quality',
  'avg_duration_recent_half', 'avg_duration_older_half',
  'frequency_recent_per_month', 'frequency_older_per_month',
  'avg_impact_recent_half', 'avg_impact_older_half',
  'total_expected_lost_sales',
];

var DOW_FIELDS = [
  'product',
  'dow_pattern', 'highest_risk_day',
  'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
  'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
  'dow_mon_total', 'dow_tue_total', 'dow_wed_total',
  'dow_thu_total', 'dow_fri_total', 'dow_sat_total', 'dow_sun_total',
  'dow_mon_probability', 'dow_tue_probability', 'dow_wed_probability',
  'dow_thu_probability', 'dow_fri_probability', 'dow_sat_probability', 'dow_sun_probability',
  'weekday_stockout_rate', 'weekend_stockout_rate',
];

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
  queueTabs: document.getElementById('queue-tabs'),
};

function setOverlay(show, text) {
  if (text) dom.overlayText.textContent = text;
  if (show) dom.overlay.removeAttribute('hidden');
  else dom.overlay.setAttribute('hidden', '');
}

function showShimmer(elId, minHeight) {
  var el = document.getElementById(elId);
  if (el) {
    el.innerHTML = '<div class="shimmer" style="margin:12px;min-height:' + (minHeight || 120) + 'px;"></div>';
  }
}

function fmtCount(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Math.round(v).toLocaleString();
}

function fmtPercent(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Math.round(Number(v) * 100) + '%';
}

function fmtISKPlain(v) {
  if (v == null || isNaN(v)) return '\u2014';
  v = Number(v);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M ISK';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K ISK';
  return Math.round(v) + ' ISK';
}

function fmtSignedCount(v) {
  if (v == null || isNaN(v)) return '\u2014';
  var n = Math.round(v);
  if (n > 0) return '+' + n;
  return String(n);
}

function pctChange(current, previous) {
  if (!previous) return null;
  return (current - previous) / previous;
}

function trendIndicator(current, previous, invertGood) {
  if (previous == null || isNaN(previous)) {
    return '<span class="kpi-trend" style="color:' + namedColor('muted') + '">\u2014</span>';
  }
  var diff = current - previous;
  if (diff === 0) {
    return '<span class="kpi-trend" style="color:' + namedColor('muted') + '">\u2192 flat vs day before</span>';
  }
  var isUp = diff > 0;
  var isGood = invertGood ? isUp : !isUp;
  var arrow = isUp ? '\u2191' : '\u2193';
  var color = isGood ? namedColor('green') : namedColor('red');
  return '<span class="kpi-trend" style="color:' + color + '">' + arrow + ' ' + Math.abs(diff) + ' vs day before</span>';
}

function endedForStore() {
  if (!currentStore) return allEndedYesterday;
  return allEndedYesterday.filter(function (row) { return row.store === currentStore; });
}

function startedForStore() {
  if (!currentStore) return allStartedYesterday;
  return allStartedYesterday.filter(function (row) { return row.store === currentStore; });
}

function endedDayBeforeForStore() {
  if (!currentStore) return allEndedDayBefore;
  return allEndedDayBefore.filter(function (row) { return row.store === currentStore; });
}

function startedDayBeforeForStore() {
  if (!currentStore) return allStartedDayBefore;
  return allStartedDayBefore.filter(function (row) { return row.store === currentStore; });
}

function buildStoreFacets() {
  var facets = {};
  for (var i = 0; i < storeList.length; ++i) {
    facets[storeList[i].name] = { active: 0, ended: 0, started: 0 };
  }
  for (var e = 0; e < allEndedYesterday.length; ++e) {
    if (facets[allEndedYesterday[e].store]) facets[allEndedYesterday[e].store].ended++;
  }
  for (var s = 0; s < allStartedYesterday.length; ++s) {
    if (facets[allStartedYesterday[s].store]) facets[allStartedYesterday[s].store].started++;
  }
  return facets;
}

async function updateActiveFacets(facets) {
  if (!runtimes['cf-main']) return facets;
  try {
    await runtimes['cf-main'].updateFilters({});
    var result = await runtimes['cf-main'].rows({
      fields: ['sold_location', 'is_currently_active'],
      limit: 100000,
      columnar: true,
    });
    var cols = result && result.columns ? result.columns : result;
    if (cols && cols.sold_location) {
      for (var i = 0; i < cols.sold_location.length; ++i) {
        if (facets[cols.sold_location[i]] && isActive(cols.is_currently_active[i])) {
          facets[cols.sold_location[i]].active++;
        }
      }
    }
    if (currentStore) {
      await runtimes['cf-main'].updateFilters({ sold_location: { type: 'in', values: [currentStore] } });
    }
  } catch (err) {
    console.error('Active facet query failed:', err);
  }
  return facets;
}

function showStorePicker() {
  if (!storeList.length) {
    dom.storeGrid.innerHTML = '<div class="panel-error">No stores loaded</div>';
    dom.picker.removeAttribute('hidden');
    return;
  }

  dom.storeGrid.innerHTML = '';
  for (var i = 0; i < storeList.length; ++i) {
    var store = storeList[i];
    var facet = storeFacets[store.name] || { active: 0, ended: 0, started: 0 };
    var btn = document.createElement('button');
    btn.className = 'store-btn';
    btn.dataset.store = store.name;
    btn.innerHTML = store.name +
      '<span class="store-btn-facets">' +
      '<span class="facet facet-red" title="Active stockouts">' + facet.active + '</span>' +
      '<span class="facet facet-green" title="Resolved yesterday">' + facet.ended + '</span>' +
      '<span class="facet facet-amber" title="Started yesterday">' + facet.started + '</span>' +
      '</span>';
    btn.addEventListener('click', function (e) {
      setState({ store: e.currentTarget.dataset.store });
    });
    dom.storeGrid.appendChild(btn);
  }

  dom.picker.removeAttribute('hidden');
}

function populateStoreSelector() {
  var list = document.getElementById('store-list');
  if (!list) return;
  list.innerHTML = '';
  for (var i = 0; i < storeList.length; ++i) {
    var name = storeList[i].name;
    var facet = storeFacets[name] || { active: 0, ended: 0, started: 0 };
    var opt = document.createElement('option');
    opt.value = name;
    opt.label = name + ' (' + facet.active + '/' + facet.ended + '/' + facet.started + ')';
    list.appendChild(opt);
  }
  dom.storeSelector.value = currentStore || '';
}

function onStoreSearch() {
  var val = dom.storeSelector.value;
  var match = storeList.some(function (store) { return store.name === val; });
  if (match && val !== currentStore) {
    var patch = { store: val };
    for (var param in PARAM_TO_DIMENSION) patch[param] = null;
    setState(patch);
  }
}

dom.storeSelector.addEventListener('change', onStoreSearch);
dom.storeSelector.addEventListener('input', onStoreSearch);

function renderFilterChips() {
  var state = getState();
  var chips = [];
  for (var param in PARAM_TO_DIMENSION) {
    if (state[param]) {
      chips.push({
        param: param,
        label: param.charAt(0).toUpperCase() + param.slice(1) + ': ' + state[param],
      });
    }
  }

  dom.filterChips.innerHTML = '';
  for (var i = 0; i < chips.length; ++i) {
    var chip = document.createElement('button');
    chip.className = 'filter-chip';
    chip.dataset.param = chips[i].param;
    chip.innerHTML = esc(chips[i].label) + ' <span class="chip-x">&times;</span>';
    chip.addEventListener('click', function (e) {
      var patch = {};
      patch[e.currentTarget.dataset.param] = null;
      setState(patch);
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

if (dom.queueTabs) {
  dom.queueTabs.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-view]');
    if (!btn) return;
    localState.queueView = btn.dataset.view || 'all';
    rerenderLocalPanels();
  });
}

async function createWorkers() {
  setOverlay(true, 'Starting...');

  showShimmer('panel-act-now', 260);
  showShimmer('panel-likely-next', 260);
  showShimmer('panel-watch-list', 260);
  showShimmer('panel-trend-chart', 320);
  showShimmer('panel-category-bars', 320);
  showShimmer('panel-focus', 260);
  showShimmer('panel-yesterday', 260);
  showShimmer('panel-dow', 220);
  showShimmer('panel-queue', 320);
  dom.kpiRow.innerHTML = '<div class="shimmer" style="grid-column:1/-1;min-height:96px;"></div>';

  var progress = { workers: 0, extras: 0, total: ALL_CUBE_IDS.length + 6 };
  function updateProgress(label) {
    var done = progress.workers + progress.extras;
    var pct = Math.round(done / progress.total * 100);
    setOverlay(true, label + ' (' + pct + '%)');
  }

  var results = await Promise.allSettled(
    ALL_CUBE_IDS.map(function (cubeId) {
      var opts = buildWorkerOptions(cubeId);
      updateProgress('Connecting to ' + cubeId);
      return crossfilter.createStreamingDashboardWorker(opts).then(function (runtime) {
        return runtime.ready.then(function (readyPayload) {
          progress.workers++;
          var rows = readyPayload && readyPayload.load ? readyPayload.load.rowsLoaded : '?';
          updateProgress(cubeId + ': ' + rows + ' rows loaded');
          runtimes[cubeId] = runtime;
          registerRuntime(cubeId, runtime, getCubeConfig(cubeId).workerDimensions);
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
        updateProgress('Resolved yesterday: ' + data.length + ' events');
      }),
      fetchStartedYesterday().then(function (data) {
        allStartedYesterday = data;
        progress.extras++;
        updateProgress('Started yesterday: ' + data.length + ' events');
      }),
      fetchEndedDayBefore().then(function (data) {
        allEndedDayBefore = data;
        progress.extras++;
        updateProgress('Resolved day before: ' + data.length + ' events');
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

  var failed = [];
  for (var i = 0; i < ALL_CUBE_IDS.length; ++i) {
    if (results[i].status === 'rejected' || !results[i].value) {
      failed.push(ALL_CUBE_IDS[i]);
      console.error('Worker failed:', ALL_CUBE_IDS[i], results[i].reason || 'null');
    }
  }

  if (failed.length === ALL_CUBE_IDS.length) {
    setOverlay(false);
    dom.kpiRow.innerHTML = '<div class="panel-error" style="grid-column:1/-1;">Failed to load dashboard data.</div>';
    return;
  }

  workersReady = true;
  storeFacets = buildStoreFacets();
  await updateActiveFacets(storeFacets);
  populateStoreSelector();
  setOverlay(false);
}

function isLikelyNext(row) {
  if (isActive(row.is_currently_active)) return false;
  var tier = String(row.forecast_tier || '').toUpperCase();
  return tier === 'CRITICAL' || tier === 'HIGH';
}

function isWatch(row) {
  if (isActive(row.is_currently_active)) return false;
  var trend = String(row.trend_signal || '').toUpperCase();
  var severity = String(row.severity_trend || '').toUpperCase();
  return trend === 'WORSENING' || trend === 'ACTIVE & WORSENING' || severity === 'ESCALATING' || severity === 'WORSENING';
}

function compareDesc(a, b, field) {
  return (Number(b[field]) || 0) - (Number(a[field]) || 0);
}

function takeMatching(primaryRows, fallbackRows, predicate, limit) {
  var out = [];
  var seen = {};

  function addRows(rows) {
    for (var i = 0; i < rows.length && out.length < limit; ++i) {
      var row = rows[i];
      var key = row.product || ('row-' + i);
      if (seen[key] || !predicate(row)) continue;
      seen[key] = true;
      out.push(row);
    }
  }

  addRows(primaryRows || []);
  addRows(fallbackRows || []);
  return out;
}

function collectMatching(rows, predicate, compareFn) {
  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length; ++i) {
    var row = rows[i];
    var key = row.product || ('row-' + i);
    if (seen[key] || !predicate(row)) continue;
    seen[key] = true;
    out.push(row);
  }
  if (compareFn) out.sort(compareFn);
  return out;
}

function uniqueCount(rows, predicate) {
  var seen = {};
  var count = 0;
  for (var i = 0; i < rows.length; ++i) {
    if (!predicate(rows[i])) continue;
    var key = rows[i].product || ('row-' + i);
    if (!seen[key]) {
      seen[key] = true;
      count++;
    }
  }
  return count;
}

function takeTop(rows, limit) {
  return rows.slice(0, Math.min(limit, rows.length));
}

function productLookup(rows) {
  var lookup = {};
  for (var i = 0; i < rows.length; ++i) {
    lookup[rows[i].product] = rows[i];
  }
  return lookup;
}

function queueRowsForView(viewModel, view) {
  if (!viewModel) return [];
  if (view === 'active') return viewModel.activeRows;
  if (view === 'next') return viewModel.nextRows;
  if (view === 'watch') return viewModel.watchRows;
  return viewModel.actionableRows;
}

function pickDefaultFocus(viewModel) {
  if (!viewModel) return null;
  var candidates = viewModel.actionableRows && viewModel.actionableRows.length
    ? viewModel.actionableRows
    : viewModel.allRows;
  return candidates && candidates.length ? candidates[0].product : null;
}

function ensureLocalFocus(viewModel) {
  var lookup = viewModel ? viewModel.byProduct : null;
  if (localState.focusProduct && lookup && lookup[localState.focusProduct]) return;
  localState.focusProduct = pickDefaultFocus(viewModel);
}

function setLocalFocus(product) {
  localState.focusProduct = product || null;
  rerenderLocalPanels();
}

function rerenderLocalPanels() {
  if (!latestViewModel) return;
  renderActionOverview(latestViewModel);
  renderFocusPanel(latestViewModel);
  renderDowGuidance(latestViewModel.dowRows);
  renderQueueTabs(latestViewModel);
  renderPriorityQueue(latestViewModel);
  renderYesterdayMovement(
    latestViewModel.ended,
    latestViewModel.started,
    latestViewModel.endedPrev,
    latestViewModel.startedPrev
  );
}

function movementDelta(current, previous, invertGood) {
  var trend = trendIndicator(current, previous, invertGood);
  return '<div class="movement-delta">' + trend + '</div>';
}

function kpiCard(label, value, cardClass, valueClass, sub, trend) {
  return '<div class="kpi ' + (cardClass || '') + '">' +
    '<div class="kpi-top">' +
      '<div class="kpi-label">' + label + '</div>' +
      '<div class="kpi-trend-wrap">' + (trend || '') + '</div>' +
    '</div>' +
    '<div class="kpi-main">' +
      '<div class="kpi-value ' + (valueClass || '') + '">' + value + '</div>' +
      '<div class="kpi-sub">' + sub + '</div>' +
    '</div>' +
    '</div>';
}

function renderOperatorKpis(snapshot, allRows, ended, started, endedPrev, startedPrev) {
  var activeCount = snapshot && snapshot.kpis ? Number(snapshot.kpis.totalActive) || 0 : uniqueCount(allRows, function (row) {
    return isActive(row.is_currently_active);
  });
  var nextCount = uniqueCount(allRows, isLikelyNext);
  var watchCount = uniqueCount(allRows, isWatch);
  var startedCount = started.length;
  var endedCount = ended.length;

  var activeTop = takeMatching(allRows.slice().sort(function (a, b) { return compareDesc(a, b, 'avg_impact_recent_half'); }), [], function (row) {
    return isActive(row.is_currently_active);
  }, 1)[0];
  var nextTop = takeMatching(allRows.slice().sort(function (a, b) { return compareDesc(a, b, 'forecast_stockout_probability'); }), [], isLikelyNext, 1)[0];
  var watchTop = takeMatching(allRows, [], isWatch, 1)[0];

  dom.kpiRow.innerHTML = [
    kpiCard(
      'Active Now',
      fmtCount(activeCount),
      activeCount > 0 ? 'kpi-red' : 'kpi-green',
      activeCount > 0 ? 'v-red' : 'v-green',
      activeTop ? 'Top: ' + esc(activeTop.product) : 'No active stockouts'
    ),
    kpiCard(
      'Likely Next 3 Days',
      fmtCount(nextCount),
      nextCount > 0 ? 'kpi-amber' : 'kpi-green',
      nextCount > 0 ? 'v-amber' : 'v-green',
      nextTop ? 'Risk: ' + esc(nextTop.product) : 'No high-probability near misses'
    ),
    kpiCard(
      'Getting Worse',
      fmtCount(watchCount),
      watchCount > 0 ? 'kpi-blue' : 'kpi-green',
      watchCount > 0 ? 'v-blue' : 'v-green',
      watchTop ? 'Watch: ' + esc(watchTop.product) : 'No worsening products in view'
    ),
    kpiCard(
      'Started Yesterday',
      fmtCount(startedCount),
      startedCount > 0 ? 'kpi-red' : 'kpi-green',
      startedCount > 0 ? 'v-red' : 'v-green',
      startedCount > 0 ? 'New issues opened' : 'No new starts',
      trendIndicator(startedCount, startedPrev.length, false)
    ),
    kpiCard(
      'Resolved Yesterday',
      fmtCount(endedCount),
      endedCount > 0 ? 'kpi-green' : 'kpi-blue',
      endedCount > 0 ? 'v-green' : 'v-blue',
      endedCount > 0 ? 'Issues closed' : 'No resolutions',
      trendIndicator(endedCount, endedPrev.length, true)
    ),
  ].join('');
}

function actionReason(row, type) {
  if (type === 'active') {
    return 'Active now, avg ' + stripTags(fmtDur(row.avg_duration_days)) +
      ', ' + stripTags(fmtFreq(row.stockouts_per_month)) + '.';
  }
  if (type === 'forecast') {
    return fmtPercent(row.forecast_stockout_probability) + ' chance in the next 3 days, highest on ' +
      esc(row.highest_risk_day || '\u2014') + '.';
  }
  var signals = [];
  if ((Number(row.frequency_recent_per_month) || 0) > (Number(row.frequency_older_per_month) || 0)) signals.push('frequency is up');
  if ((Number(row.avg_duration_recent_half) || 0) > (Number(row.avg_duration_older_half) || 0)) signals.push('duration is up');
  if ((Number(row.avg_impact_recent_half) || 0) > (Number(row.avg_impact_older_half) || 0)) signals.push('impact is up');
  if (!signals.length) signals.push('trend signal is worsening');
  return signals.slice(0, 2).join(', ') + '.';
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, '');
}

function confidenceText(row) {
  return row.signal_quality ? esc(row.signal_quality) : 'Signal quality unavailable';
}

function summaryPill(text, tone) {
  return '<span class="summary-pill summary-pill-' + tone + '">' + text + '</span>';
}

function fmtFreqPlain(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1) + '/mo';
}

function fmtDurPlain(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1) + 'd';
}

function trendState(recent, older) {
  var r = Number(recent) || 0;
  var o = Number(older) || 0;
  if (o <= 0 && r > 0) return { arrow: '\u2191', tone: 'bad' };
  if (r > o * 1.2) return { arrow: '\u2191', tone: 'bad' };
  if (r < o * 0.8) return { arrow: '\u2193', tone: 'good' };
  return { arrow: '\u2192', tone: 'flat' };
}

function summaryTrendValue(recent, older, formatter) {
  var state = trendState(recent, older);
  return '<span class="summary-trend summary-trend-' + state.tone + '">' + formatter(recent) + ' ' + state.arrow + '</span>';
}

function summaryConfig(type) {
  if (type === 'active') {
    return {
      headers: ['Product', 'Impact', 'Dur', 'Freq', 'Worst', 'Pattern'],
      render: function (row) {
        return [
          '<span class="summary-product">' + esc(row.product) + '</span>',
          summaryPill(fmtISKPlain(row.avg_impact_recent_half), 'red'),
          '<span class="summary-value">' + fmtDurPlain(row.avg_duration_days) + '</span>',
          '<span class="summary-value">' + fmtFreqPlain(row.stockouts_per_month) + '</span>',
          '<span class="summary-value">' + esc(row.highest_risk_day || '\u2014') + '</span>',
          '<span class="summary-value">' + esc(row.stockout_pattern || '\u2014') + '</span>',
        ];
      },
    };
  }
  if (type === 'forecast') {
    return {
      headers: ['Product', 'Prob', 'Impact', 'Peak', 'Pattern', 'Tier'],
      render: function (row) {
        return [
          '<span class="summary-product">' + esc(row.product) + '</span>',
          summaryPill(fmtPercent(row.forecast_stockout_probability), 'amber'),
          '<span class="summary-value">' + fmtISKPlain(row.avg_impact_recent_half) + '</span>',
          '<span class="summary-value">' + esc(row.highest_risk_day || '\u2014') + '</span>',
          '<span class="summary-value">' + esc(row.stockout_pattern || '\u2014') + '</span>',
          '<span class="summary-value">' + esc(row.forecast_tier || '\u2014') + '</span>',
        ];
      },
    };
  }
  return {
    headers: ['Product', 'Score', 'Freq', 'Dur', 'Impact', 'Signal'],
    render: function (row) {
      return [
        '<span class="summary-product">' + esc(row.product) + '</span>',
        summaryPill(fmtPercent(row.risk_score), 'blue'),
        summaryTrendValue(row.frequency_recent_per_month, row.frequency_older_per_month, fmtFreqPlain),
        summaryTrendValue(row.avg_duration_recent_half, row.avg_duration_older_half, fmtDurPlain),
        summaryTrendValue(row.avg_impact_recent_half, row.avg_impact_older_half, fmtISKPlain),
        '<span class="summary-value">' + esc(row.trend_signal || '\u2014') + '</span>',
      ];
    },
  };
}

function renderSummaryRow(row, type, config) {
  var selected = localState.focusProduct === row.product;
  var cells = config.render(row);
  var html = '<button class="summary-row summary-row-' + type + (selected ? ' summary-row-selected' : '') + '" data-product="' + esc(row.product) + '">';
  for (var i = 0; i < cells.length; ++i) {
    html += '<span class="summary-cell' + (i === 0 ? ' summary-cell-product' : '') + '">' + cells[i] + '</span>';
  }
  return html + '</button>';
}

function renderSummaryList(panelId, rows, type) {
  var el = document.getElementById(panelId);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="panel-empty">Nothing flagged in this view</div>';
    return;
  }
  var config = summaryConfig(type);
  var head = '<div class="summary-head">';
  for (var i = 0; i < config.headers.length; ++i) {
    head += '<span class="summary-head-cell' + (i === 0 ? ' summary-head-product' : '') + '">' + config.headers[i] + '</span>';
  }
  head += '</div>';
  el.innerHTML = head + rows.map(function (row) {
    return renderSummaryRow(row, type, config);
  }).join('');
  el.onclick = function (e) {
    var btn = e.target.closest('[data-product]');
    if (!btn) return;
    setLocalFocus(btn.dataset.product);
  };
}

function renderActionOverview(viewModel) {
  document.getElementById('active-lane-count').textContent = fmtCount(viewModel.activeRows.length);
  document.getElementById('next-lane-count').textContent = fmtCount(viewModel.nextRows.length);
  document.getElementById('watch-lane-count').textContent = fmtCount(viewModel.watchRows.length);

  renderSummaryList('panel-act-now', viewModel.activeRows, 'active');
  renderSummaryList('panel-likely-next', viewModel.nextRows, 'forecast');
  renderSummaryList('panel-watch-list', viewModel.watchRows, 'watch');
}

function renderTrendChart(dayGroup) {
  var el = document.getElementById('panel-trend-chart');
  var tag = document.getElementById('trend-summary');
  if (!el) return;

  var entries = dayGroup && dayGroup.entries ? dayGroup.entries : dayGroup || [];
  if (!entries.length) {
    if (trendChart && !trendChart.isDisposed()) trendChart.dispose();
    trendChart = null;
    el.innerHTML = '<div class="panel-empty">No time-series data</div>';
    if (tag) tag.textContent = 'No trend data';
    return;
  }

  if (!trendChart || trendChart.isDisposed()) {
    el.innerHTML = '';
    trendChart = echarts.init(el, THEME_NAME, { renderer: 'canvas' });
  }

  var labels = [];
  var products = [];
  var lostSales = [];
  var events = [];
  for (var i = 0; i < entries.length; ++i) {
    var key = Number(entries[i].key);
    var d = new Date(key);
    labels.push(String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0'));
    products.push(Number(entries[i].value.products) || 0);
    lostSales.push(Number(entries[i].value.lostSales) || 0);
    events.push(Number(entries[i].value.events) || 0);
  }

  var recentSales = sumTail(lostSales, 7);
  var previousSales = sumSlice(lostSales, Math.max(0, lostSales.length - 14), Math.max(0, lostSales.length - 7));
  if (tag) {
    var delta = pctChange(recentSales, previousSales);
    tag.textContent = delta == null
      ? '7d sales: ' + fmtISKPlain(recentSales)
      : '7d sales ' + (delta >= 0 ? '\u2191 ' : '\u2193 ') + Math.round(Math.abs(delta) * 100) + '%';
  }

  trendChart.setOption({
    animation: false,
    grid: { left: 50, right: 68, top: 16, bottom: 40 },
    legend: {
      top: 0,
      itemWidth: 10,
      itemHeight: 10,
      data: ['Products Affected', 'Expected Lost Sales'],
    },
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        var idx = params[0].dataIndex;
        return labels[idx] + '<br>' +
          'Products Affected: ' + products[idx] + '<br>' +
          'Stockout Events: ' + events[idx] + '<br>' +
          'Expected Lost Sales: ' + fmtISKPlain(lostSales[idx]);
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      boundaryGap: false,
    },
    yAxis: [
      {
        type: 'value',
        name: 'Products',
      },
      {
        type: 'value',
        name: 'ISK',
        axisLabel: {
          formatter: function (value) {
            return value >= 1000000 ? (value / 1000000).toFixed(1) + 'M' :
              value >= 1000 ? (value / 1000).toFixed(0) + 'K' : Math.round(value);
          },
        },
      },
    ],
    series: [
      {
        name: 'Products Affected',
        type: 'line',
        smooth: true,
        symbol: 'none',
        lineStyle: { width: 3, color: namedColor('blue') },
        areaStyle: { color: 'rgba(77,166,255,0.12)' },
        data: products,
      },
      {
        name: 'Expected Lost Sales',
        type: 'line',
        smooth: true,
        symbol: 'none',
        yAxisIndex: 1,
        lineStyle: { width: 2, color: namedColor('amber') },
        data: lostSales,
      },
    ],
  }, true);
}

function categoryBarItem(category, value, selected, baseColor) {
  return {
    value: value,
    itemStyle: selected ? {
      color: namedColor('blue'),
      borderColor: '#dbe8ff',
      borderWidth: 1,
      opacity: 1,
    } : {
      color: baseColor,
      opacity: 0.92,
    },
    name: category,
  };
}

function renderCategoryPressure(groupResult) {
  var el = document.getElementById('panel-category-bars');
  if (!el) return;

  var entries = groupResult && groupResult.entries ? groupResult.entries : [];
  entries = entries.filter(function (entry) {
    return entry.key && ((Number(entry.value.active) || 0) > 0 || (Number(entry.value.worsening) || 0) > 0);
  });

  if (!entries.length) {
    if (categoryChart && !categoryChart.isDisposed()) categoryChart.dispose();
    categoryChart = null;
    el.innerHTML = '<div class="panel-empty">No category pressure in this view</div>';
    return;
  }

  var focusRow = latestViewModel && latestViewModel.byProduct ? latestViewModel.byProduct[localState.focusProduct] : null;
  var selectedCategory = focusRow ? focusRow.product_category : null;
  var categories = entries.map(function (entry) { return entry.key; });
  var activeVals = entries.map(function (entry) {
    return categoryBarItem(entry.key, Number(entry.value.active) || 0, selectedCategory === entry.key, namedColor('red'));
  });
  var worseningVals = entries.map(function (entry) {
    return categoryBarItem(entry.key, Number(entry.value.worsening) || 0, selectedCategory === entry.key, namedColor('amber'));
  });

  if (!categoryChart || categoryChart.isDisposed()) {
    el.innerHTML = '';
    categoryChart = echarts.init(el, THEME_NAME, { renderer: 'canvas' });
  }
  categoryChart.off('click');

  categoryChart.setOption({
    animation: false,
    grid: { left: 120, right: 20, top: 16, bottom: 20 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: function (params) {
        var idx = params[0].dataIndex;
        var entry = entries[idx];
        return esc(entry.key) + '<br>' +
          'Active: ' + (Number(entry.value.active) || 0) + '<br>' +
          'Worsening: ' + (Number(entry.value.worsening) || 0) + '<br>' +
          'Avg Risk: ' + fmtPercent(entry.value.avgRisk) + '<br>' +
          'Avg 3-Day Prob: ' + fmtPercent(entry.value.avgForecast);
      },
    },
    legend: {
      top: 0,
      itemWidth: 10,
      itemHeight: 10,
      data: ['Active', 'Worsening'],
    },
    xAxis: { type: 'value' },
    yAxis: {
      type: 'category',
      inverse: true,
      data: categories,
    },
    series: [
      {
        name: 'Active',
        type: 'bar',
        data: activeVals,
        barMaxWidth: 14,
      },
      {
        name: 'Worsening',
        type: 'bar',
        data: worseningVals,
        barMaxWidth: 14,
      },
    ],
  }, true);
}

function focusFact(label, value, tone) {
  return '<div class="focus-fact' + (tone ? ' focus-fact-' + tone : '') + '">' +
    '<span class="focus-fact-label">' + label + '</span>' +
    '<strong class="focus-fact-value">' + value + '</strong>' +
  '</div>';
}

function focusDetail(label, value) {
  return '<div class="focus-detail">' +
    '<span class="focus-detail-label">' + label + '</span>' +
    '<span class="focus-detail-value">' + value + '</span>' +
  '</div>';
}

function renderFocusPanel(viewModel) {
  var el = document.getElementById('panel-focus');
  var tag = document.getElementById('focus-bucket');
  if (!el) return;

  var row = viewModel && viewModel.byProduct ? viewModel.byProduct[localState.focusProduct] : null;
  if (!row) {
    el.innerHTML = '<div class="focus-empty">Select a product to inspect why it is here.</div>';
    if (tag) {
      tag.textContent = 'Store View';
      tag.className = 'card-tag';
    }
    return;
  }

  var bucket = queueBucket(row);
  if (tag) {
    tag.textContent = bucket ? bucket.label : 'In View';
    tag.className = 'card-tag' + (bucket && bucket.id === 'active' ? ' tag-red' : bucket && bucket.id === 'next' ? ' tag-amber' : bucket && bucket.id === 'watch' ? '' : '');
  }

  var lastSeen = row.days_since_last == null ? '\u2014' : Math.round(Number(row.days_since_last)) + 'd ago';
  var bucketTone = bucket && bucket.id === 'active' ? 'red' : bucket && bucket.id === 'next' ? 'amber' : 'blue';

  el.innerHTML =
    '<div class="focus-title">' + esc(row.product) + '</div>' +
    '<div class="focus-meta">' +
      fieldBadge('trend_signal', row.trend_signal) +
      fieldBadge('stockout_pattern', row.stockout_pattern) +
      fieldBadge('forecast_tier', row.forecast_tier) +
    '</div>' +
    '<div class="focus-reason">' + queueReason(row, bucket || { id: 'watch' }) + ' ' + confidenceText(row) + '.</div>' +
    '<div class="focus-facts">' +
      focusFact('Impact/Day', fmtISKPlain(row.avg_impact_recent_half), bucketTone) +
      focusFact('3-Day Prob', fmtPercent(row.forecast_stockout_probability), 'amber') +
      focusFact('Avg Dur', stripTags(fmtDur(row.avg_duration_days))) +
      focusFact('Freq', stripTags(fmtFreq(row.stockouts_per_month))) +
      focusFact('Score', fmtPercent(row.risk_score), 'blue') +
      focusFact('Last Seen', lastSeen) +
    '</div>' +
    '<div class="focus-details">' +
      focusDetail('Category', esc(row.product_category || '\u2014')) +
      focusDetail('Supplier', esc(row.supplier || '\u2014')) +
      focusDetail('Worst Day', esc(row.highest_risk_day || '\u2014')) +
      focusDetail('Signal', esc(row.trend_signal || '\u2014')) +
      focusDetail('Pattern', esc(row.stockout_pattern || '\u2014')) +
      focusDetail('Confidence', esc(row.signal_quality || '\u2014')) +
    '</div>';
}

function movementBar(row, type, maxValue) {
  var value = Number(row.impactPerDay || row.lostSales) || 0;
  var width = maxValue > 0 ? Math.max(8, Math.round(value / maxValue * 100)) : 8;
  return '<button class="movement-bar-item movement-bar-item-' + type + '" data-product="' + esc(row.product) + '">' +
    '<div class="movement-bar-fill" style="width:' + width + '%"></div>' +
    '<div class="movement-bar-content">' +
      '<span class="movement-bar-label">' + esc(row.product) + '</span>' +
      '<span class="movement-bar-meta"><span>' + esc(row.category || '\u2014') + '</span><span class="movement-bar-value">' + fmtISKPlain(value) + '</span></span>' +
    '</div>' +
  '</button>';
}

function renderYesterdayMovement(ended, started, endedPrev, startedPrev) {
  var el = document.getElementById('panel-yesterday');
  var tag = document.getElementById('yesterday-net');
  if (!el) return;

  var endedSorted = ended.slice().sort(function (a, b) { return (b.impactPerDay || b.lostSales) - (a.impactPerDay || a.lostSales); });
  var startedSorted = started.slice().sort(function (a, b) { return (b.impactPerDay || b.lostSales) - (a.impactPerDay || a.lostSales); });
  var net = ended.length - started.length;

  if (tag) {
    tag.textContent = net > 0 ? 'Net +' + net + ' resolved' : net < 0 ? 'Net ' + net : 'Flat day';
    tag.className = 'card-tag ' + (net > 0 ? 'tag-green' : net < 0 ? 'tag-red' : '');
  }

  var maxValue = 0;
  for (var i = 0; i < endedSorted.length; ++i) maxValue = Math.max(maxValue, Number(endedSorted[i].impactPerDay || endedSorted[i].lostSales) || 0);
  for (var j = 0; j < startedSorted.length; ++j) maxValue = Math.max(maxValue, Number(startedSorted[j].impactPerDay || startedSorted[j].lostSales) || 0);

  el.innerHTML =
    '<div class="movement-summary">' +
      '<div class="movement-stat movement-good">' +
        '<span class="movement-label">Resolved</span>' +
        '<strong>' + ended.length + '</strong>' +
        movementDelta(ended.length, endedPrev.length, true) +
      '</div>' +
      '<div class="movement-stat movement-bad">' +
        '<span class="movement-label">Started</span>' +
        '<strong>' + started.length + '</strong>' +
        movementDelta(started.length, startedPrev.length, false) +
      '</div>' +
      '<div class="movement-stat">' +
        '<span class="movement-label">Net</span>' +
        '<strong>' + fmtSignedCount(net) + '</strong>' +
        '<div class="movement-delta">' + (net > 0 ? 'More problems closed than opened' : net < 0 ? 'More problems opened than closed' : 'Flat day') + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="movement-columns">' +
      '<div class="movement-column">' +
        '<div class="movement-column-head">Resolved Yesterday <strong>' + fmtCount(endedSorted.length) + '</strong></div>' +
        '<div class="movement-bar-list">' +
          (endedSorted.length ? endedSorted.map(function (row) { return movementBar(row, 'good', maxValue); }).join('') : '<div class="panel-empty panel-empty-short">No resolved products</div>') +
        '</div>' +
      '</div>' +
      '<div class="movement-column">' +
        '<div class="movement-column-head">Started Yesterday <strong>' + fmtCount(startedSorted.length) + '</strong></div>' +
        '<div class="movement-bar-list">' +
          (startedSorted.length ? startedSorted.map(function (row) { return movementBar(row, 'bad', maxValue); }).join('') : '<div class="panel-empty panel-empty-short">No new stockouts</div>') +
        '</div>' +
      '</div>' +
    '</div>';

  el.onclick = function (e) {
    var btn = e.target.closest('[data-product]');
    if (!btn) return;
    setLocalFocus(btn.dataset.product);
  };
}

function renderDowGuidance(rowsResult) {
  var el = document.getElementById('panel-dow');
  var badgesEl = document.getElementById('panel-dow-badges');
  var contextEl = document.getElementById('dow-context');
  if (!el) return;

  if (contextEl) {
    if (localState.focusProduct) {
      contextEl.textContent = localState.focusProduct;
      contextEl.removeAttribute('hidden');
    } else {
      contextEl.setAttribute('hidden', '');
    }
  }

  var rows = columnarToRows(rowsResult);
  if (localState.focusProduct) {
    rows = rows.filter(function (row) { return row.product === localState.focusProduct; });
  }
  if (!rows.length) rows = columnarToRows(rowsResult);

  if (!rows.length) {
    if (dowChart && !dowChart.isDisposed()) dowChart.dispose();
    dowChart = null;
    el.innerHTML = '<div class="panel-empty">No day-of-week guidance in this view</div>';
    if (badgesEl) badgesEl.innerHTML = '';
    return;
  }

  var dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var confirmedFields = [
    'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
    'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
  ];
  var totalFields = [
    'dow_mon_total', 'dow_tue_total', 'dow_wed_total',
    'dow_thu_total', 'dow_fri_total', 'dow_sat_total', 'dow_sun_total',
  ];

  var confirmed = [0, 0, 0, 0, 0, 0, 0];
  var totals = [0, 0, 0, 0, 0, 0, 0];
  var patternCounts = {};
  var topDayCounts = {};

  for (var i = 0; i < rows.length; ++i) {
    for (var d = 0; d < 7; ++d) {
      confirmed[d] += Number(rows[i][confirmedFields[d]]) || 0;
      totals[d] += Number(rows[i][totalFields[d]]) || 0;
    }
    if (rows[i].dow_pattern) patternCounts[rows[i].dow_pattern] = (patternCounts[rows[i].dow_pattern] || 0) + 1;
    if (rows[i].highest_risk_day) topDayCounts[rows[i].highest_risk_day] = (topDayCounts[rows[i].highest_risk_day] || 0) + 1;
  }

  var probabilities = confirmed.map(function (value, idx) {
    return totals[idx] > 0 ? value / totals[idx] : 0;
  });

  if (!dowChart || dowChart.isDisposed()) {
    el.innerHTML = '';
    dowChart = echarts.init(el, THEME_NAME, { renderer: 'canvas' });
  }

  dowChart.setOption({
    animation: false,
    grid: { left: 42, right: 18, top: 8, bottom: 32 },
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        var idx = params[0].dataIndex;
        return dayNames[idx] + '<br>' +
          'Probability: ' + fmtPercent(probabilities[idx]) + '<br>' +
          'Confirmed: ' + confirmed[idx] + '<br>' +
          'Observed: ' + totals[idx];
      },
    },
    xAxis: { type: 'category', data: dayNames },
    yAxis: {
      type: 'value',
      name: '%',
      min: 0,
      max: Math.max(100, Math.ceil(Math.max.apply(null, probabilities.map(function (p) { return p * 100; })) / 10) * 10),
      axisLabel: {
        formatter: function (value) { return value + '%'; },
      },
    },
    series: [{
      type: 'bar',
      barMaxWidth: 28,
      data: probabilities.map(function (prob, idx) {
        return {
          value: Math.round(prob * 1000) / 10,
          itemStyle: { color: colorFor('forecast_stockout_probability', prob) },
        };
      }),
    }],
  }, true);

  if (badgesEl) {
    badgesEl.innerHTML =
      '<div class="dow-badge">Pattern: <strong>' + esc(mode(patternCounts)) + '</strong></div>' +
      '<div class="dow-badge">Highest Risk Day: <strong>' + esc(mode(topDayCounts)) + '</strong></div>' +
      '<div class="dow-badge">Weekday Avg: <strong>' + fmtPercent(sumSlice(probabilities, 0, 5) / 5) + '</strong></div>' +
      '<div class="dow-badge">Weekend Avg: <strong>' + fmtPercent(sumSlice(probabilities, 5, 7) / 2) + '</strong></div>';
  }
}

function mode(counts) {
  var best = null;
  var bestCount = -1;
  for (var key in counts) {
    if (counts[key] > bestCount) {
      best = key;
      bestCount = counts[key];
    }
  }
  return best || '\u2014';
}

function queueBucket(row) {
  if (isActive(row.is_currently_active)) return { id: 'active', label: 'Act Now', order: 0 };
  if (isLikelyNext(row)) return { id: 'next', label: 'Likely Next', order: 1 };
  if (isWatch(row)) return { id: 'watch', label: 'Watch List', order: 2 };
  return null;
}

function queueReason(row, bucket) {
  if (bucket.id === 'active') {
    return 'Active now, ' + stripTags(fmtDur(row.avg_duration_days)) + ', ' + stripTags(fmtFreq(row.stockouts_per_month)) + '.';
  }
  if (bucket.id === 'next') {
    return 'Forecast ' + fmtPercent(row.forecast_stockout_probability) + ', peak risk on ' + esc(row.highest_risk_day || '\u2014') + '.';
  }
  return actionReason(row, 'watch');
}

function sortQueue(rows) {
  return rows.slice().sort(function (a, b) {
    var bucketA = queueBucket(a);
    var bucketB = queueBucket(b);
    if (bucketA.order !== bucketB.order) return bucketA.order - bucketB.order;
    if (bucketA.id === 'active') return compareDesc(a, b, 'avg_impact_recent_half') || compareDesc(a, b, 'risk_score');
    if (bucketA.id === 'next') return compareDesc(a, b, 'forecast_stockout_probability');
    return compareDesc(a, b, 'risk_score');
  });
}

function queueBucketBadge(bucket) {
  return '<span class="queue-bucket queue-bucket-' + bucket.id + '">' + bucket.label + '</span>';
}

function renderQueueTabs(viewModel) {
  if (!dom.queueTabs) return;
  var views = [
    { id: 'all', label: 'All', count: viewModel.actionableRows.length },
    { id: 'active', label: 'Act Now', count: viewModel.activeRows.length },
    { id: 'next', label: 'Likely Next', count: viewModel.nextRows.length },
    { id: 'watch', label: 'Watch List', count: viewModel.watchRows.length },
  ];
  dom.queueTabs.innerHTML = views.map(function (view) {
    return '<button class="queue-tab' + (localState.queueView === view.id ? ' queue-tab-active' : '') + '" data-view="' + view.id + '">' +
      view.label + ' (' + fmtCount(view.count) + ')' +
    '</button>';
  }).join('');
}

function renderPriorityQueue(viewModel) {
  var el = document.getElementById('panel-queue');
  var countEl = document.getElementById('queue-count');
  if (!el) return;

  var actionable = queueRowsForView(viewModel, localState.queueView);
  actionable = sortQueue(actionable);

  if (countEl) {
    countEl.textContent = fmtCount(actionable.length) + (localState.queueView === 'all' ? ' flagged' : ' in view');
  }

  if (!actionable.length) {
    el.innerHTML = '<div class="panel-empty">No priority queue in this view</div>';
    return;
  }

  var html = '<table class="tbl tbl-queue"><colgroup>' +
    '<col style="width:20%">' +
    '<col style="width:10%">' +
    '<col style="width:23%">' +
    '<col style="width:10%">' +
    '<col style="width:10%">' +
    '<col style="width:8%">' +
    '<col style="width:7%">' +
    '<col style="width:12%">' +
    '</colgroup><thead><tr>' +
    '<th>Product</th>' +
    '<th>Action</th>' +
    '<th>Why</th>' +
    '<th><abbr title="Average impact per day, recent half">Impact/Day</abbr></th>' +
    '<th><abbr title="3-Day Probability">3-Day Prob</abbr></th>' +
    '<th><abbr title="Average Duration">Avg Dur</abbr></th>' +
    '<th>Worst Day</th>' +
    '<th>Confidence</th>' +
    '</tr></thead><tbody>';

  for (var j = 0; j < actionable.length; ++j) {
    var row = actionable[j];
    var bucket = queueBucket(row);
    html += '<tr data-product="' + esc(row.product) + '" class="queue-row' + (localState.focusProduct === row.product ? ' queue-row-selected' : '') + '">' +
      '<td class="val">' + esc(row.product) + '</td>' +
      '<td>' + queueBucketBadge(bucket) + '</td>' +
      '<td class="queue-why">' + queueReason(row, bucket) + '</td>' +
      '<td>' + fmtISK(row.avg_impact_recent_half) + '</td>' +
      '<td>' + scoreBar(Number(row.forecast_stockout_probability) || 0, 'forecast_stockout_probability') + '</td>' +
      '<td>' + fmtDur(row.avg_duration_days) + '</td>' +
      '<td>' + esc(row.highest_risk_day || '\u2014') + '</td>' +
      '<td><span class="queue-confidence" title="' + esc(row.signal_quality || '\u2014') + '">' + esc(row.signal_quality || '\u2014') + '</span></td>' +
      '</tr>';
  }

  el.innerHTML = html + '</tbody></table>';
  el.onclick = function (e) {
    var tr = e.target.closest('tr[data-product]');
    if (!tr) return;
    setLocalFocus(tr.dataset.product);
  };
}

function sumTail(values, size) {
  return sumSlice(values, Math.max(0, values.length - size), values.length);
}

function sumSlice(values, start, end) {
  var sum = 0;
  for (var i = start; i < end; ++i) sum += Number(values[i]) || 0;
  return sum;
}

async function refreshAllPanels() {
  if (!workersReady) return;

  var results = await Promise.all([
    runtimes['cf-main']
      ? runtimes['cf-main'].query({
          snapshot: { groups: false },
          groups: {
            byCategory: {
              limit: 8,
              sort: 'desc',
              sortMetric: 'active',
              includeTotals: false,
            },
          },
          rowSets: {
            all: {
              fields: MAIN_FIELDS,
              limit: 50000,
              sortBy: 'risk_score',
              direction: 'top',
              columnar: true,
            },
          },
        }).catch(function (err) {
          console.error('cf-main query failed:', err);
          return null;
        })
      : Promise.resolve(null),
    runtimes['cf-dow']
      ? runtimes['cf-dow'].rows({
          fields: DOW_FIELDS,
          limit: 50000,
          columnar: true,
        }).catch(function (err) {
          console.error('cf-dow rows failed:', err);
          return null;
        })
      : Promise.resolve(null),
    runtimes['cf-trend']
      ? runtimes['cf-trend'].query({
          snapshot: false,
          groups: {
            days: {
              sort: 'natural',
              includeTotals: false,
            },
          },
        }).catch(function (err) {
          console.error('cf-trend query failed:', err);
          return null;
        })
      : Promise.resolve(null),
  ]);

  var mainResult = results[0];
  var dowResult = results[1];
  var trendResult = results[2];

  var ended = endedForStore();
  var started = startedForStore();
  var endedPrev = endedDayBeforeForStore();
  var startedPrev = startedDayBeforeForStore();

  var allRows = mainResult ? columnarToRows(mainResult.rowSets.all) : [];
  var activeRows = collectMatching(allRows, function (row) {
    return isActive(row.is_currently_active);
  }, function (a, b) {
    return compareDesc(a, b, 'avg_impact_recent_half') || compareDesc(a, b, 'risk_score');
  });
  var nextRows = collectMatching(allRows, isLikelyNext, function (a, b) {
    return compareDesc(a, b, 'forecast_stockout_probability') || compareDesc(a, b, 'avg_impact_recent_half');
  });
  var watchRows = collectMatching(allRows, isWatch, function (a, b) {
    return compareDesc(a, b, 'risk_score') || compareDesc(a, b, 'avg_impact_recent_half');
  });

  var actionableRows = sortQueue(collectMatching(allRows, function (row) {
    return !!queueBucket(row);
  }));

  latestViewModel = {
    snapshot: mainResult ? mainResult.snapshot : null,
    allRows: allRows,
    byProduct: productLookup(allRows),
    actionableRows: actionableRows,
    activeRows: activeRows,
    nextRows: nextRows,
    watchRows: watchRows,
    ended: ended,
    started: started,
    endedPrev: endedPrev,
    startedPrev: startedPrev,
    dowRows: dowResult,
    trendGroup: trendResult && trendResult.groups ? trendResult.groups.days : null,
    categoryGroup: mainResult && mainResult.groups ? mainResult.groups.byCategory : null,
  };

  ensureLocalFocus(latestViewModel);
  renderOperatorKpis(mainResult ? mainResult.snapshot : null, allRows, ended, started, endedPrev, startedPrev);
  renderActionOverview(latestViewModel);
  renderTrendChart(trendResult && trendResult.groups ? trendResult.groups.days : null);
  renderCategoryPressure(mainResult && mainResult.groups ? mainResult.groups.byCategory : null);
  renderFocusPanel(latestViewModel);
  renderDowGuidance(dowResult);
  renderQueueTabs(latestViewModel);
  renderPriorityQueue(latestViewModel);
  renderYesterdayMovement(ended, started, endedPrev, startedPrev);
  renderFilterChips();
}

onStateChange(async function (newState, prevState) {
  if (!newState.store) {
    latestViewModel = null;
    localState.focusProduct = null;
    dom.dashboard.setAttribute('hidden', '');
    dom.picker.removeAttribute('hidden');
    return;
  }

  dom.picker.setAttribute('hidden', '');
  dom.dashboard.removeAttribute('hidden');
  currentStore = newState.store;
  dom.storeName.textContent = currentStore;
  dom.storeSelector.value = currentStore;

  if (!workersReady) return;
  if (!prevState || prevState.store !== newState.store) {
    localState.focusProduct = null;
    localState.queueView = 'all';
  }

  await dispatchFilters(newState);
  await refreshAllPanels();
});

window.addEventListener('resize', function () {
  [actionNowChart, actionNextChart, actionWatchChart, trendChart, categoryChart, dowChart].forEach(function (chart) {
    if (chart && !chart.isDisposed()) chart.resize();
  });
});

(async function init() {
  await createWorkers();

  var state = getState();
  if (state.store) {
    currentStore = state.store;
    dom.storeName.textContent = currentStore;
    dom.storeSelector.value = currentStore;
    dom.picker.setAttribute('hidden', '');
    dom.dashboard.removeAttribute('hidden');
    populateStoreSelector();
    await dispatchFilters(state);
    await refreshAllPanels();
  } else {
    populateStoreSelector();
    showStorePicker();
  }
})();
