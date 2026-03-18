// demo-stockout/cube-registry-ops.js
//
// Operator-focused stockout dashboard registry.
// Keeps the original dashboard isolated by using a separate worker config file.

var CUBE_API = '/api/cube';
var META_API = '/api/meta';
var PARTITION = 'bonus.is';

var WORKER_ASSETS = {
  arrowRuntimeUrl: '../node_modules/apache-arrow/Arrow.es2015.min.js',
  crossfilterUrl: '../crossfilter.js',
};

export var ALL_CUBE_IDS = ['cf-main', 'cf-dow', 'cf-trend'];

function member(cubeName, field) { return cubeName + '.' + field; }
function alias(cubeName, field) { return cubeName + '__' + field; }

var CONFIGS = {
  'cf-main': {
    cubeName: 'stockout_analysis',
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
      'avg_duration_recent_half', 'avg_duration_older_half',
      'frequency_recent_per_month', 'frequency_older_per_month',
      'avg_impact_recent_half', 'avg_impact_older_half',
    ],
    cubeQueryMeasures: [
      'avg_availability', 'worsening_count',
      'sum_confirmed_stockouts', 'sum_suspect_stockouts',
      'sum_expected_lost_sales', 'count',
    ],
    numberFields: [
      'is_currently_active',
      'risk_score',
      'forecast_stockout_probability',
      'avg_duration_days',
      'total_expected_lost_sales',
      'days_since_last',
      'stockouts_per_month',
      'avg_duration_recent_half', 'avg_duration_older_half',
      'frequency_recent_per_month', 'frequency_older_per_month',
      'avg_impact_recent_half', 'avg_impact_older_half',
      'avg_availability', 'worsening_count',
      'sum_confirmed_stockouts', 'sum_suspect_stockouts',
      'sum_expected_lost_sales', 'count',
    ],
    workerDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'is_currently_active', 'risk_tier', 'risk_score',
      'forecast_stockout_probability', 'forecast_tier',
      'trend_signal', 'severity_trend', 'stockout_pattern',
      'avg_impact_recent_half',
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
    workerGroups: [
      {
        id: 'byCategory',
        field: 'product_category',
        metrics: [
          { id: 'rows', op: 'count' },
          { id: 'active', field: 'is_currently_active', op: 'sum' },
          { id: 'worsening', field: 'worsening_count', op: 'sum' },
          { id: 'avgRisk', field: 'risk_score', op: 'avg' },
          { id: 'avgForecast', field: 'forecast_stockout_probability', op: 'avg' },
        ],
      },
    ],
  },
  'cf-dow': {
    cubeName: 'stockout_analysis',
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
      'dow_mon_probability', 'dow_tue_probability', 'dow_wed_probability',
      'dow_thu_probability', 'dow_fri_probability', 'dow_sat_probability', 'dow_sun_probability',
      'weekday_stockout_rate', 'weekend_stockout_rate',
    ],
    workerDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'dow_pattern', 'highest_risk_day',
    ],
    workerKpis: [],
    workerGroups: [],
  },
  'cf-trend': {
    cubeName: 'stockout_availability',
    dateRangeDays: 60,
    cubeQueryDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'observation_date',
    ],
    cubeQueryMeasures: [
      'stockout_events',
      'products_affected',
      'total_expected_lost_sales',
      'total_duration_ratio_delta',
    ],
    numberFields: [
      'observation_date',
      'stockout_events',
      'products_affected',
      'total_expected_lost_sales',
      'total_duration_ratio_delta',
    ],
    workerDimensions: [
      'sold_location',
      'product', 'product_category', 'product_sub_category', 'supplier',
      'observation_date',
    ],
    workerKpis: [],
    workerGroups: [
      {
        id: 'days',
        field: 'observation_date',
        bucket: { type: 'timeBucket', granularity: 'day' },
        metrics: [
          { id: 'events', field: 'stockout_events', op: 'sum' },
          { id: 'products', field: 'products_affected', op: 'sum' },
          { id: 'lostSales', field: 'total_expected_lost_sales', op: 'sum' },
          { id: 'lossRatio', field: 'total_duration_ratio_delta', op: 'sum' },
        ],
      },
    ],
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

function buildRenameMap(config) {
  var rename = {};
  for (var i = 0; i < config.cubeQueryDimensions.length; ++i) {
    rename[member(config.cubeName, config.cubeQueryDimensions[i])] = config.cubeQueryDimensions[i];
    rename[alias(config.cubeName, config.cubeQueryDimensions[i])] = config.cubeQueryDimensions[i];
  }
  for (var j = 0; j < config.cubeQueryMeasures.length; ++j) {
    rename[member(config.cubeName, config.cubeQueryMeasures[j])] = config.cubeQueryMeasures[j];
    rename[alias(config.cubeName, config.cubeQueryMeasures[j])] = config.cubeQueryMeasures[j];
  }
  return rename;
}

function rangeDaysUtc(days) {
  var now = new Date();
  var end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  var start = new Date(end.getTime() - (days - 1) * 86400000);
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

export function buildCubeQuery(cubeId) {
  var config = CONFIGS[cubeId];
  if (!config) throw new Error('Unknown cube: ' + cubeId);

  var filters = [
    { member: member(config.cubeName, 'partition'), operator: 'equals', values: [PARTITION] },
  ];

  if (config.dateRangeDays) {
    var range = rangeDaysUtc(config.dateRangeDays);
    filters.push({
      member: member(config.cubeName, 'observation_date'),
      operator: 'inDateRange',
      values: range,
    });
  }

  return {
    format: 'arrow',
    query: {
      dimensions: config.cubeQueryDimensions.map(function (field) {
        return member(config.cubeName, field);
      }),
      measures: config.cubeQueryMeasures.map(function (field) {
        return member(config.cubeName, field);
      }),
      filters: filters,
      limit: 1000000,
    },
  };
}

export function buildWorkerOptions(cubeId) {
  var config = CONFIGS[cubeId];
  if (!config) throw new Error('Unknown cube: ' + cubeId);

  var cubeQuery = buildCubeQuery(cubeId);
  var rename = buildRenameMap(config);
  var transforms = {};

  for (var i = 0; i < config.numberFields.length; ++i) {
    transforms[config.numberFields[i]] = 'number';
  }

  return Object.assign({}, WORKER_ASSETS, {
    batchCoalesceRows: 65536,
    dimensions: config.workerDimensions,
    emitSnapshots: true,
    groups: config.workerGroups,
    kpis: config.workerKpis,
    progressThrottleMs: 100,
    snapshotGroups: {},
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
        dimensions: [member('stockout_analysis', 'sold_location')],
        measures: [member('stockout_analysis', 'count')],
        filters: [{ member: member('stockout_analysis', 'partition'), operator: 'equals', values: [PARTITION] }],
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
        name: row[member('stockout_analysis', 'sold_location')],
        count: row[member('stockout_analysis', 'count')] || 0,
      };
    }).filter(function (store) {
      return store.name;
    }).sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });
  });
}

function fetchEventsByDate(dateField, daysAgo, label) {
  var d = new Date(Date.now() - daysAgo * 86400000);
  var dateStr = d.toISOString().slice(0, 10);

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
        measures: [
          'stockout_events.total_expected_lost_sales',
          'stockout_events.avg_expected_lost_sales_per_day',
        ],
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
        impactPerDay: Number(row['stockout_events.avg_expected_lost_sales_per_day']) || 0,
      };
    });
  });
}

export function fetchEndedYesterday() { return fetchEventsByDate('stockout_events.to_date', 1, 'Ended yesterday'); }
export function fetchStartedYesterday() { return fetchEventsByDate('stockout_events.from_date', 1, 'Started yesterday'); }
export function fetchEndedDayBefore() { return fetchEventsByDate('stockout_events.to_date', 2, 'Ended day before'); }
export function fetchStartedDayBefore() { return fetchEventsByDate('stockout_events.from_date', 2, 'Started day before'); }
