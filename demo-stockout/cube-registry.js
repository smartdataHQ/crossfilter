// demo-stockout/cube-registry.js
//
// Two crossfilter workers, both from stockout_analysis:
//   cf-main: all panels (KPIs, stockout table, forecast, risk, early warning)
//   cf-dow:  DOW chart (independent product click filter)

var CUBE_API = '/api/cube';
var META_API = '/api/meta';
var PARTITION = 'bonus.is';
var CUBE_NAME = 'stockout_analysis';

var WORKER_ASSETS = {
  arrowRuntimeUrl: '../node_modules/apache-arrow/Arrow.es2015.min.js',
  crossfilterUrl: '../crossfilter.js',
};

export var ALL_CUBE_IDS = ['cf-main', 'cf-dow'];

function cf(field) { return CUBE_NAME + '.' + field; }
function af(field) { return CUBE_NAME + '__' + field; }

var CONFIGS = {
  'cf-main': {
    cubeQueryDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'is_currently_active', 'risk_tier', 'risk_score',
      'forecast_stockout_probability', 'forecast_tier',
      'trend_signal', 'severity_trend', 'stockout_pattern',
      'forecast_warning',
      'avg_duration_days',
      'total_expected_lost_sales', 'days_since_last', 'stockouts_per_month',
      'highest_risk_day', 'signal_quality',
      // Trending half-comparisons
      'avg_duration_recent_half', 'avg_duration_older_half',
      'frequency_recent_per_month', 'frequency_older_per_month',
      'avg_impact_recent_half', 'avg_impact_older_half',
    ],
    cubeQueryMeasures: [
      'avg_availability', 'sum_active', 'worsening_count',
      'sum_confirmed_stockouts', 'sum_suspect_stockouts',
      'sum_expected_lost_sales', 'count', 'avg_risk_score', 'critical_risk_count',
    ],
    numberFields: [
      'is_currently_active', 'days_since_last',
      'sum_active', 'worsening_count', 'sum_confirmed_stockouts',
      'sum_suspect_stockouts', 'count', 'critical_risk_count',
    ],
    workerDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'is_currently_active', 'risk_tier', 'risk_score',
      'forecast_stockout_probability', 'forecast_tier',
      'trend_signal', 'severity_trend', 'stockout_pattern',
    ],
    workerKpis: [
      { id: 'avgAvail', field: 'avg_availability', op: 'avg' },
      { id: 'totalActive', field: 'is_currently_active', op: 'sum' },
      { id: 'worsening', field: 'worsening_count', op: 'sum' },
      { id: 'confirmed', field: 'sum_confirmed_stockouts', op: 'sum' },
      { id: 'suspect', field: 'sum_suspect_stockouts', op: 'sum' },
      { id: 'lostSales', field: 'sum_expected_lost_sales', op: 'sum' },
      { id: 'count', field: 'count', op: 'sum' },
    ],
    workerGroups: [],
  },
  'cf-dow': {
    cubeQueryDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'dow_pattern', 'highest_risk_day',
      'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
      'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
      'dow_mon_total', 'dow_tue_total', 'dow_wed_total',
      'dow_thu_total', 'dow_fri_total', 'dow_sat_total', 'dow_sun_total',
      'dow_mon_probability', 'dow_tue_probability', 'dow_wed_probability',
      'dow_thu_probability', 'dow_fri_probability', 'dow_sat_probability', 'dow_sun_probability',
      'weekday_stockout_rate', 'weekend_stockout_rate',
    ],
    cubeQueryMeasures: ['count'],
    numberFields: [
      'count',
      'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
      'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
      'dow_mon_total', 'dow_tue_total', 'dow_wed_total',
      'dow_thu_total', 'dow_fri_total', 'dow_sat_total', 'dow_sun_total',
    ],
    workerDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'dow_pattern', 'highest_risk_day',
    ],
    workerKpis: [],
    workerGroups: [],
  },
};

export function getCubeConfig(cubeId) {
  return CONFIGS[cubeId] || null;
}

export function fetchMeta() {
  return fetch(META_API).then(function (res) {
    if (!res.ok) throw new Error('Meta fetch failed: ' + res.status);
    return res.json();
  });
}

function buildRenameMap(dimensions, measures) {
  var rename = {};
  for (var i = 0; i < dimensions.length; ++i) {
    rename[cf(dimensions[i])] = dimensions[i];
    rename[af(dimensions[i])] = dimensions[i];
  }
  for (var j = 0; j < measures.length; ++j) {
    rename[cf(measures[j])] = measures[j];
    rename[af(measures[j])] = measures[j];
  }
  return rename;
}

export function buildCubeQuery(cubeId) {
  var config = CONFIGS[cubeId];
  if (!config) throw new Error('Unknown cube: ' + cubeId);
  return {
    format: 'arrow',
    query: {
      dimensions: config.cubeQueryDimensions.map(cf),
      measures: config.cubeQueryMeasures.map(cf),
      filters: [{ member: cf('partition'), operator: 'equals', values: [PARTITION] }],
      limit: 1000000,
    },
  };
}

export function buildWorkerOptions(cubeId) {
  var config = CONFIGS[cubeId];
  if (!config) throw new Error('Unknown cube: ' + cubeId);

  var cubeQuery = buildCubeQuery(cubeId);
  var rename = buildRenameMap(config.cubeQueryDimensions, config.cubeQueryMeasures);

  var transforms = {};
  if (config.numberFields) {
    for (var n = 0; n < config.numberFields.length; ++n) {
      transforms[config.numberFields[n]] = 'number';
    }
  }

  return Object.assign({}, WORKER_ASSETS, {
    batchCoalesceRows: 65536,
    dimensions: config.workerDimensions,
    emitSnapshots: true,
    kpis: config.workerKpis,
    groups: config.workerGroups,
    snapshotGroups: {},
    progressThrottleMs: 100,
    snapshotThrottleMs: 300,
    wasm: true,
    sources: [{
      dataUrl: CUBE_API,
      id: cubeId,
      role: 'base',
      dataFetchInit: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cubeQuery),
      },
      projection: { rename: rename, transforms: transforms },
    }],
  });
}

export function fetchStoreList() {
  return fetch(CUBE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: {
        dimensions: [cf('sold_location')],
        measures: [cf('count')],
        filters: [{ member: cf('partition'), operator: 'equals', values: [PARTITION] }],
        limit: 1000,
        timeDimensions: [],
      },
    }),
  }).then(function (res) {
    if (!res.ok) throw new Error('Store list fetch failed: ' + res.status);
    return res.json();
  }).then(function (json) {
    return (json.data || []).map(function (row) {
      return { name: row[cf('sold_location')], count: row[cf('count')] || 0 };
    }).filter(function (s) { return s.name; }).sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  });
}

function fetchEventsByDate(dateField, daysAgo, label) {
  // Use UTC to avoid browser-timezone off-by-one (Cube data is UTC-based)
  var now = Date.now();
  var d = new Date(now - daysAgo * 86400000);
  var dateStr = d.toISOString().slice(0, 10);

  return fetch(CUBE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: {
        dimensions: [
          'stockout_events.sold_location', 'stockout_events.product',
          'stockout_events.product_category', 'stockout_events.supplier',
          'stockout_events.duration_days',
        ],
        measures: ['stockout_events.total_expected_lost_sales'],
        filters: [
          { member: 'stockout_events.partition', operator: 'equals', values: [PARTITION] },
          { member: dateField, operator: 'inDateRange', values: [dateStr, dateStr] },
          { member: 'stockout_events.is_confirmed', operator: 'equals', values: ['1'] },
        ],
        limit: 50000,
      },
    }),
  }).then(function (res) {
    if (!res.ok) throw new Error(label + ' fetch failed: ' + res.status);
    return res.json();
  }).then(function (json) {
    return (json.data || []).map(function (row) {
      return {
        store: row['stockout_events.sold_location'],
        product: row['stockout_events.product'],
        category: row['stockout_events.product_category'],
        supplier: row['stockout_events.supplier'],
        durationDays: Number(row['stockout_events.duration_days']) || 0,
        lostSales: Number(row['stockout_events.total_expected_lost_sales']) || 0,
      };
    });
  });
}

// Yesterday (day -1)
export function fetchEndedYesterday() { return fetchEventsByDate('stockout_events.to_date', 1, 'Ended yesterday'); }
export function fetchStartedYesterday() { return fetchEventsByDate('stockout_events.from_date', 1, 'Started yesterday'); }
// Day before yesterday (day -2) — for KPI trend comparison
export function fetchEndedDayBefore() { return fetchEventsByDate('stockout_events.to_date', 2, 'Ended day before'); }
export function fetchStartedDayBefore() { return fetchEventsByDate('stockout_events.from_date', 2, 'Started day before'); }
