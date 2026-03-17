// demo-stockout/cube-registry.js
//
// Cube configurations for multi-crossfilter stockout dashboard.
// ALL stores loaded at once — sold_location is a crossfilter dimension
// for instant client-side store switching via unified filter dispatch.

var CUBE_API = '/api/cube';
var PARTITION = 'bonus.is';

var WORKER_ASSETS = {
  arrowRuntimeUrl: '../node_modules/apache-arrow/Arrow.es2015.min.js',
  crossfilterUrl: '../crossfilter.js',
};

export var ALL_CUBE_IDS = ['cf-store', 'cf-warning', 'cf-dow'];

function cf(cube, field) { return cube + '.' + field; }
function af(cube, field) { return cube + '__' + field; }

var CONFIGS = {
  'cf-store': {
    cubeName: 'stockout_store_dashboard',
    cubeQueryDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'is_currently_active', 'risk_tier', 'risk_score',
      'forecast_stockout_probability', 'trend_signal', 'forecast_warning',
      'avg_duration_days',
      'total_expected_lost_sales', 'days_since_last', 'stockouts_per_month',
      'highest_risk_day', 'signal_quality',
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
      'is_currently_active', 'risk_tier', 'risk_score', 'forecast_stockout_probability',
    ],
    workerKpis: [
      { id: 'avgAvail', field: 'avg_availability', op: 'avg' },
      { id: 'totalActive', field: 'sum_active', op: 'sum' },
      { id: 'worsening', field: 'worsening_count', op: 'sum' },
      { id: 'confirmed', field: 'sum_confirmed_stockouts', op: 'sum' },
      { id: 'suspect', field: 'sum_suspect_stockouts', op: 'sum' },
      { id: 'lostSales', field: 'sum_expected_lost_sales', op: 'sum' },
      { id: 'count', field: 'count', op: 'sum' },
    ],
    workerGroups: [
      {
        id: 'byCategory',
        field: 'product_category',
        metrics: [{ id: 'avgAvail', field: 'avg_availability', op: 'avg' }],
      },
    ],
  },
  'cf-warning': {
    cubeName: 'stockout_early_warning',
    cubeQueryDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'trend_signal', 'severity_trend', 'risk_tier', 'risk_score',
      'availability', 'avg_duration_recent_half', 'avg_duration_older_half',
      'frequency_recent_per_month', 'frequency_older_per_month',
      'avg_impact_recent_half', 'avg_impact_older_half',
      'forecast_stockout_probability', 'forecast_warning',
      'is_currently_active',
    ],
    cubeQueryMeasures: [
      'count', 'worsening_count', 'critical_risk_count',
      'avg_risk_score', 'sum_expected_lost_sales',
    ],
    numberFields: ['count', 'worsening_count', 'critical_risk_count'],
    workerDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'trend_signal', 'severity_trend', 'risk_tier', 'risk_score',
    ],
    workerKpis: [
      { id: 'worsening', field: 'worsening_count', op: 'sum' },
      { id: 'critical', field: 'critical_risk_count', op: 'sum' },
    ],
    workerGroups: [],
  },
  'cf-dow': {
    cubeName: 'stockout_dow_analysis',
    cubeQueryDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'dow_pattern', 'highest_risk_day',
      'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
      'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
      'dow_mon_probability', 'dow_tue_probability', 'dow_wed_probability',
      'dow_thu_probability', 'dow_fri_probability', 'dow_sat_probability', 'dow_sun_probability',
      'weekday_stockout_rate', 'weekend_stockout_rate',
    ],
    cubeQueryMeasures: ['count'],
    numberFields: [
      'count',
      'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
      'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
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

function buildRenameMap(cubeName, dimensions, measures) {
  var rename = {};
  for (var i = 0; i < dimensions.length; ++i) {
    var dim = dimensions[i];
    rename[cf(cubeName, dim)] = dim;
    rename[af(cubeName, dim)] = dim;
  }
  for (var j = 0; j < measures.length; ++j) {
    var meas = measures[j];
    rename[cf(cubeName, meas)] = meas;
    rename[af(cubeName, meas)] = meas;
  }
  return rename;
}

// Build Cube.dev query — partition-only filter, no store filter, no limit
export function buildCubeQuery(cubeId) {
  var config = CONFIGS[cubeId];
  if (!config) throw new Error('Unknown cube: ' + cubeId);

  var cubeName = config.cubeName;
  return {
    format: 'arrow',
    query: {
      dimensions: config.cubeQueryDimensions.map(function (d) { return cf(cubeName, d); }),
      measures: config.cubeQueryMeasures.map(function (m) { return cf(cubeName, m); }),
      filters: [
        { member: cf(cubeName, 'partition'), operator: 'equals', values: [PARTITION] },
      ],
      limit: 1000000,
    },
  };
}

// Build worker options — no store parameter, all data loaded
export function buildWorkerOptions(cubeId) {
  var config = CONFIGS[cubeId];
  if (!config) throw new Error('Unknown cube: ' + cubeId);

  var cubeQuery = buildCubeQuery(cubeId);
  var rename = buildRenameMap(config.cubeName, config.cubeQueryDimensions, config.cubeQueryMeasures);

  var transforms = {};
  if (config.numberFields) {
    for (var n = 0; n < config.numberFields.length; ++n) {
      transforms[config.numberFields[n]] = 'number';
    }
  }

  var snapshotGroups = {};
  for (var g = 0; g < config.workerGroups.length; ++g) {
    var group = config.workerGroups[g];
    snapshotGroups[group.id] = { includeTotals: true, nonEmptyKeys: true, sort: 'desc', limit: 50 };
  }

  return Object.assign({}, WORKER_ASSETS, {
    batchCoalesceRows: 65536,
    dimensions: config.workerDimensions,
    emitSnapshots: true,
    kpis: config.workerKpis,
    groups: config.workerGroups,
    snapshotGroups: snapshotGroups,
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

// Fetch store list (lightweight JSON query)
export function fetchStoreList() {
  return fetch(CUBE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: {
        dimensions: ['stockout_store_dashboard.sold_location'],
        measures: ['stockout_store_dashboard.count'],
        filters: [{ member: 'stockout_store_dashboard.partition', operator: 'equals', values: [PARTITION] }],
        limit: 1000,
        timeDimensions: [],
      },
    }),
  }).then(function (res) {
    if (!res.ok) throw new Error('Store list fetch failed: ' + res.status);
    return res.json();
  }).then(function (json) {
    return (json.data || []).map(function (row) {
      return {
        name: row['stockout_store_dashboard.sold_location'],
        count: row['stockout_store_dashboard.count'] || 0,
      };
    }).filter(function (s) { return s.name; }).sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  });
}

// Fetch confirmed stockout events for yesterday — ALL stores
function fetchEventsByDate(dateField, label) {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var dateStr = yesterday.toISOString().slice(0, 10);

  return fetch(CUBE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: {
        dimensions: [
          'stockout_events.sold_location',
          'stockout_events.product',
          'stockout_events.product_category',
          'stockout_events.supplier',
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

export function fetchEndedYesterday() {
  return fetchEventsByDate('stockout_events.to_date', 'Ended yesterday');
}

export function fetchStartedYesterday() {
  return fetchEventsByDate('stockout_events.from_date', 'Started yesterday');
}
