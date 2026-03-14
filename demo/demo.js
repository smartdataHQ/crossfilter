const crossfilter = globalThis.crossfilter;

if (!crossfilter) {
  throw new Error('Expected `window.crossfilter` from ../crossfilter.js before loading the demo.');
}

const ARROW_FILE = '../test/data/query-result.arrow';
const CUBE_API = '/api/cube';
const TABLE_PAGE_SIZE = 50;
const WORKER_ASSETS = {
  arrowRuntimeUrl: '../node_modules/apache-arrow/Arrow.es2015.min.js',
  crossfilterUrl: '../crossfilter.js',
};

const CUBE_TIME_DIMENSION = 'semantic_events.timestamp';

function cubeTimeField(granularity) {
  return 'semantic_events__timestamp_' + granularity;
}

function cubeTimeDotField(granularity) {
  return 'semantic_events.timestamp.' + granularity;
}
const CUBE_DIMENSIONS_PRIMARY = [
  'semantic_events.event',
  'semantic_events.dimensions_customer_country',
  'semantic_events.location_label',
  'semantic_events.location_country',
  'semantic_events.location_region',
  'semantic_events.location_division',
  'semantic_events.location_municipality',
  'semantic_events.location_locality',
  'semantic_events.location_postal_code',
  'semantic_events.location_postal_name',
  'semantic_events.location_code',
  'semantic_events.location_latitude',
];

const FIELDS = {
  customer_country: 'semantic_events__dimensions_customer_country',
  event: 'semantic_events__event',
  latitude: 'semantic_events__location_latitude',
  locality: 'semantic_events__location_locality',
  location_code: 'semantic_events__location_code',
  location_country: 'semantic_events__location_country',
  location_label: 'semantic_events__location_label',
  municipality: 'semantic_events__location_municipality',
  postal_code: 'semantic_events__location_postal_code',
  postal_name: 'semantic_events__location_postal_name',
  region: 'semantic_events__location_region',
  division: 'semantic_events__location_division',
  time: 'semantic_events__timestamp',
};

const FIELD_LABELS = {
  customer_country: 'Customer Country',
  event: 'Event',
  latitude: 'Latitude',
  locality: 'Locality',
  location_code: 'Location Code',
  location_country: 'Location Country',
  location_label: 'Location',
  municipality: 'Municipality',
  postal_code: 'Postal Code',
  postal_name: 'Postal Name',
  region: 'Region',
  division: 'Division',
  time: 'Time',
};

const FIELD_KEY_BY_NAME = Object.fromEntries(Object.entries(FIELDS).map(([key, value]) => [value, key]));

const TABLE_FIELDS = [
  FIELDS.event,
  FIELDS.customer_country,
  FIELDS.location_label,
  FIELDS.location_country,
  FIELDS.region,
  FIELDS.division,
  FIELDS.municipality,
  FIELDS.locality,
  FIELDS.postal_code,
  FIELDS.postal_name,
  FIELDS.location_code,
  FIELDS.latitude,
  FIELDS.time,
];

const TIME_GRANULARITIES = [
  { id: 'minute', label: 'Minute', ms: 60000 },
  { id: 'hour', label: 'Hour', ms: 3600000 },
  { id: 'day', label: 'Day', ms: 86400000 },
  { id: 'week', label: 'Week', ms: 7 * 86400000 },
  { id: 'month', label: 'Month', ms: null },
];

const GROUP_IDS = {
  customerCountries: 'customerCountries',
  divisions: 'divisions',
  events: 'events',
  localities: 'localities',
  locationCountries: 'locationCountries',
  municipalities: 'municipalities',
  postalCodes: 'postalCodes',
  regions: 'regions',
  timelines: Object.fromEntries(TIME_GRANULARITIES.map((granularity) => [granularity.id, `timeline_${granularity.id}`])),
};

const FILTERABLE_FIELDS = [
  FIELDS.event,
  FIELDS.customer_country,
  FIELDS.location_country,
  FIELDS.region,
  FIELDS.division,
  FIELDS.municipality,
  FIELDS.locality,
  FIELDS.postal_code,
  FIELDS.time,
  FIELDS.latitude,
];

const state = {
  baseTimeBounds: null,
  currentRows: [],
  currentSnapshot: null,
  dataSource: 'live',
  firstSnapshotMs: null,
  lastInteractionMs: null,
  latestRequestId: 0,
  loadStartedAt: 0,
  loadToken: 0,
  localitySort: 'least',
  serverGranularity: null,
  logLines: [],
  pendingRefreshResetTable: false,
  progress: null,
  ready: false,
  refreshInFlight: false,
  refreshQueued: false,
  refreshRafId: 0,
  resizeRafId: 0,
  runtime: null,
  runtimeListeners: [],
  seedRows: [],
  tableHasMore: false,
  tableLoading: false,
  tableOffset: 0,
  tableSort: 'top',
  timeGranularity: 'month',
  filters: createEmptyFilterState(),
  charts: {
    division: null,
    event: null,
    region: null,
    timeline: null,
  },
};

let dom = {};

function createEmptyFilterState() {
  return {
    [FIELDS.customer_country]: [],
    [FIELDS.division]: [],
    [FIELDS.event]: [],
    [FIELDS.latitude]: null,
    [FIELDS.locality]: [],
    [FIELDS.location_country]: [],
    [FIELDS.municipality]: [],
    [FIELDS.postal_code]: [],
    [FIELDS.region]: [],
    [FIELDS.time]: null,
  };
}

function cacheDom() {
  dom = {
    addRowsBtn: document.getElementById('add-rows-btn'),
    chartDivision: document.getElementById('chart-division'),
    chartEvent: document.getElementById('chart-event'),
    chartRegion: document.getElementById('chart-region'),
    chartTimeline: document.getElementById('chart-timeline'),
    chartGrid: document.querySelector('.chart-grid'),
    clearAllBtn: document.getElementById('clear-all-btn'),
    clearButtons: Array.from(document.querySelectorAll('.filter-clear-btn')),
    customerCountryCount: document.getElementById('customer-country-count'),
    customerCountryDropdown: document.getElementById('customer-country-dropdown'),
    customerCountryOptions: document.getElementById('customer-country-options'),
    customerCountryPills: document.getElementById('customer-country-pills'),
    customerCountryPicker: document.getElementById('customer-country-picker'),
    customerCountrySearch: document.getElementById('customer-country-search'),
    customerCountryTrigger: document.getElementById('customer-country-trigger'),
    ccGroupSize: document.getElementById('cc-group-size'),
    divisionGroupSize: document.getElementById('division-group-size'),
    errorBanner: document.getElementById('error-banner'),
    eventGroupSize: document.getElementById('event-group-size'),
    eventPills: document.getElementById('event-pills'),
    filterChips: document.getElementById('filter-chips'),
    granularityButtons: Array.from(document.querySelectorAll('#granularity-selector .gran-btn')),
    headerSubtitle: document.querySelector('.header-subtitle'),
    kpiLatitude: document.getElementById('kpi-latitude'),
    kpiLocations: document.getElementById('kpi-locations'),
    kpiTimespan: document.getElementById('kpi-timespan'),
    kpiTotal: document.getElementById('kpi-total'),
    latencyDisplay: document.getElementById('latency-display'),
    listCustomerCountry: document.getElementById('list-customer-country'),
    listLocationCountry: document.getElementById('list-location-country'),
    listLocality: document.getElementById('list-locality'),
    listMunicipality: document.getElementById('list-municipality'),
    listPostal: document.getElementById('list-postal'),
    loadTime: document.getElementById('load-time'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.querySelector('.loading-text'),
    lcGroupSize: document.getElementById('lc-group-size'),
    localitySortLabel: document.getElementById('locality-sort-label'),
    localitySortToggle: document.getElementById('locality-sort-toggle'),
    locationCountryCount: document.getElementById('location-country-count'),
    locationCountryDropdown: document.getElementById('location-country-dropdown'),
    locationCountryOptions: document.getElementById('location-country-options'),
    locationCountryPills: document.getElementById('location-country-pills'),
    locationCountryPicker: document.getElementById('location-country-picker'),
    locationCountrySearch: document.getElementById('location-country-search'),
    locationCountryTrigger: document.getElementById('location-country-trigger'),
    modeSelector: document.getElementById('mode-selector'),
    locGroupSize: document.getElementById('loc-group-size'),
    muniGroupSize: document.getElementById('muni-group-size'),
    perfLog: document.getElementById('perf-log'),
    postalGroupSize: document.getElementById('postal-group-size'),
    queryDetails: document.getElementById('query-details'),
    queryDisplay: document.getElementById('query-display'),
    regionCheckboxes: document.getElementById('region-checkboxes'),
    regionCount: document.getElementById('region-count'),
    regionGroupSize: document.getElementById('region-group-size'),
    regionSearch: document.getElementById('region-search'),
    removeFilteredBtn: document.getElementById('remove-filtered-btn'),
    runtimeBadge: document.getElementById('runtime-badge'),
    sourceButtons: Array.from(document.querySelectorAll('#source-selector .mode-btn')),
    streamStatus: document.getElementById('stream-status'),
    tableBody: document.getElementById('table-body'),
    tableHead: document.getElementById('table-head'),
    tableRowCount: document.getElementById('table-row-count'),
    tableScroll: document.querySelector('.table-scroll'),
    tableSortToggle: document.getElementById('table-sort-toggle'),
    timeGranularityBadge: document.getElementById('time-granularity-badge'),
    timeMax: document.getElementById('time-max'),
    timeMin: document.getElementById('time-min'),
    timeRangeLabel: document.getElementById('time-range-label'),
    latMax: document.getElementById('lat-max'),
    latMin: document.getElementById('lat-min'),
  };
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  state.logLines.push(`[${timestamp}] ${message}`);
  if (state.logLines.length > 200) {
    state.logLines = state.logLines.slice(-200);
  }
  dom.perfLog.textContent = state.logLines.join('\n') + '\n';
  dom.perfLog.scrollTop = dom.perfLog.scrollHeight;
}

function showError(message) {
  dom.errorBanner.textContent = message;
  dom.errorBanner.hidden = false;
}

function hideError() {
  dom.errorBanner.hidden = true;
}

function setKpiCard(card, value, label) {
  const valueEl = card.querySelector('.kpi-value');
  const labelEl = card.querySelector('.kpi-label');
  if (valueEl) valueEl.textContent = value;
  if (labelEl) labelEl.textContent = label;
}

function setLoading(visible, text) {
  dom.loadingOverlay.style.display = visible ? 'flex' : 'none';
  if (text) {
    dom.loadingText.textContent = text;
  }
}

function formatNumber(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return '—';
  }
  return Number(value).toLocaleString();
}

function formatFloat(value, digits) {
  if (value == null || Number.isNaN(Number(value))) {
    return '—';
  }
  return Number(value).toFixed(digits);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 100 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatTimestamp(value, granularityId) {
  if (value == null) {
    return '—';
  }
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  switch (granularityId) {
    case 'month':
      return date.toISOString().slice(0, 7);
    case 'week':
    case 'day':
      return date.toISOString().slice(0, 10);
    case 'hour':
      return date.toISOString().slice(0, 13).replace('T', ' ') + 'h';
    default:
      return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

function getGranularityMeta(granularityId) {
  return TIME_GRANULARITIES.find((item) => item.id === granularityId) || TIME_GRANULARITIES[TIME_GRANULARITIES.length - 1];
}

function toggleArrayFilterValue(field, value) {
  const current = Array.isArray(state.filters[field]) ? state.filters[field].slice() : [];
  const next = current.includes(value)
    ? current.filter((item) => item !== value)
    : current.concat([value]);
  state.filters[field] = next;
  return next;
}

function hasActiveFilter(field) {
  const value = state.filters[field];
  return Array.isArray(value) ? value.length > 0 : !!value;
}

function buildDashboardFilters() {
  const filters = {};

  for (const field of FILTERABLE_FIELDS) {
    const value = state.filters[field];
    if (Array.isArray(value) && value.length) {
      filters[field] = { type: 'in', values: value.slice() };
      continue;
    }
    if (value && Array.isArray(value) && value.length === 2) {
      filters[field] = { type: 'range', range: value.slice() };
      continue;
    }
    if (!Array.isArray(value) && value && value.type) {
      filters[field] = value;
    }
  }

  if (Array.isArray(state.filters[FIELDS.time]) && state.filters[FIELDS.time].length === 2) {
    filters[FIELDS.time] = { type: 'range', range: state.filters[FIELDS.time].slice() };
  }
  if (Array.isArray(state.filters[FIELDS.latitude]) && state.filters[FIELDS.latitude].length === 2) {
    filters[FIELDS.latitude] = { type: 'range', range: state.filters[FIELDS.latitude].slice() };
  }

  return filters;
}

function cloneDashboardFilters(filters) {
  return JSON.parse(JSON.stringify(filters || {}));
}

async function withTemporaryFilters(runtime, filters, operation) {
  const originalFilters = cloneDashboardFilters(buildDashboardFilters());
  const nextFilters = cloneDashboardFilters(filters || {});
  const originalKey = JSON.stringify(originalFilters);
  const nextKey = JSON.stringify(nextFilters);

  if (originalKey !== nextKey) {
    await runtime.updateFilters(nextFilters);
  }

  try {
    return await operation();
  } finally {
    if (originalKey !== nextKey) {
      await runtime.updateFilters(originalFilters);
    }
  }
}

function currentTimeRangeLabel() {
  const range = Array.isArray(state.filters[FIELDS.time]) ? state.filters[FIELDS.time] : state.baseTimeBounds;
  if (!range || range.length !== 2) {
    return '—';
  }
  return `${formatTimestamp(range[0], state.timeGranularity)} → ${formatTimestamp(range[1], state.timeGranularity)}`;
}

function formatProgress(progress) {
  if (!progress) {
    return 'Starting worker...';
  }

  const sourceParts = Object.entries(progress.sources || {}).map(([id, source]) => {
    const totalText = source.totalBytes == null ? '?' : formatBytes(source.totalBytes);
    return `${id}:${source.status} ${formatBytes(source.bytesLoaded)}/${totalText} ${formatNumber(source.rowsLoaded)} rows`;
  });

  const fetchPercent = progress.fetch.percent == null
    ? '—'
    : `${(progress.fetch.percent * 100).toFixed(1)}%`;

  return [
    `status=${progress.status}`,
    `fetch=${fetchPercent}`,
    `rows=${formatNumber(progress.load.rowsLoaded)}`,
    `batches=${formatNumber(progress.load.batchesLoaded)}`,
    sourceParts.join(' | '),
  ].filter(Boolean).join(' • ');
}

function fieldLabel(field) {
  const key = FIELD_KEY_BY_NAME[field];
  return key ? FIELD_LABELS[key] : field;
}

function formatStreamStatus(progress) {
  if (!progress) {
    return 'Worker: starting';
  }

  const runtimeKind = progress.runtime && progress.runtime.active === 'wasm' ? 'WASM' : 'JS';
  const sourceStates = Object.entries(progress.sources || {}).map(([id, source]) => `${id}:${source.status}`);
  const leading = `${runtimeKind} • ${formatNumber(progress.load.rowsLoaded)} rows • ${formatNumber(progress.load.batchesLoaded)} batches`;
  return sourceStates.length ? `${leading} • ${sourceStates.join(' • ')}` : `${leading} • ${progress.status}`;
}

function updateProgressBadge(progress) {
  if (!dom.streamStatus) {
    return;
  }
  dom.streamStatus.textContent = formatStreamStatus(progress);
  dom.streamStatus.title = formatProgress(progress);
}

function decodeBase64UrlJson(value) {
  if (!value) {
    return null;
  }

  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(globalThis.atob(padded));
  } catch (_) {
    return null;
  }
}

function appendArrowMetadataLog(progress) {
  const primarySource = progress && progress.sources && (progress.sources.primary || progress.sources.source_0);
  const response = primarySource && primarySource.response;
  if (!response) {
    return;
  }

  const details = [];
  if (response.contentType) {
    details.push(`content-type=${response.contentType}`);
  }
  if (response.arrowFieldMappingEncoding) {
    details.push(`mapping-encoding=${response.arrowFieldMappingEncoding}`);
  }

  const decodedMapping = decodeBase64UrlJson(response.arrowFieldMapping);
  if (decodedMapping && Object.keys(decodedMapping).length) {
    details.push(`mapping-fields=${Object.keys(decodedMapping).length}`);
    appendLog(`Arrow passthrough metadata: ${details.join(' • ')}`);
    appendLog(`Arrow field mapping keys: ${Object.keys(decodedMapping).join(', ')}`);
    return;
  }

  if (response.arrowFieldMapping) {
    details.push('mapping=present');
  }

  if (details.length) {
    appendLog(`Arrow stream metadata: ${details.join(' • ')}`);
  }
}

function scheduleRefresh(resetTable) {
  state.pendingRefreshResetTable = state.pendingRefreshResetTable || !!resetTable;
  state.refreshQueued = true;
  if (state.refreshRafId || state.refreshInFlight) {
    return;
  }

  state.refreshRafId = requestAnimationFrame(async () => {
    state.refreshRafId = 0;
    if (!state.refreshQueued) {
      return;
    }

    const nextReset = state.pendingRefreshResetTable;
    state.pendingRefreshResetTable = false;
    state.refreshQueued = false;
    state.refreshInFlight = true;

    try {
      await refreshView(nextReset);
    } finally {
      state.refreshInFlight = false;
      if (state.refreshQueued) {
        scheduleRefresh(state.pendingRefreshResetTable);
      }
    }
  });
}

function showQueries(primaryQuery) {
  if (!dom.queryDetails) {
    return;
  }

  if (!primaryQuery) {
    dom.queryDetails.style.display = 'none';
    return;
  }

  dom.queryDetails.style.display = '';
  dom.queryDetails.open = true;
  dom.queryDisplay.textContent = '// Live /api/v1/load query\n' + JSON.stringify(primaryQuery, null, 2);
}

function hideQueries() {
  if (dom.queryDetails) {
    dom.queryDetails.style.display = 'none';
  }
}

function buildGroupSpecs() {
  const rowMetric = [{ id: 'rows', op: 'count' }];
  return [
    { field: FIELDS.event, id: GROUP_IDS.events, metrics: rowMetric },
    { field: FIELDS.customer_country, id: GROUP_IDS.customerCountries, metrics: rowMetric },
    { field: FIELDS.location_country, id: GROUP_IDS.locationCountries, metrics: rowMetric },
    { field: FIELDS.region, id: GROUP_IDS.regions, metrics: rowMetric },
    { field: FIELDS.division, id: GROUP_IDS.divisions, metrics: rowMetric },
    { field: FIELDS.municipality, id: GROUP_IDS.municipalities, metrics: rowMetric },
    { field: FIELDS.locality, id: GROUP_IDS.localities, metrics: rowMetric },
    { field: FIELDS.postal_code, id: GROUP_IDS.postalCodes, metrics: rowMetric },
  ].concat(TIME_GRANULARITIES.map((granularity) => ({
    bucket: { type: 'timeBucket', granularity: granularity.id },
    field: FIELDS.time,
    id: GROUP_IDS.timelines[granularity.id],
    metrics: rowMetric,
  })));
}

function buildRuntimeDimensions() {
  return [
    FIELDS.event,
    FIELDS.customer_country,
    FIELDS.location_country,
    FIELDS.region,
    FIELDS.division,
    FIELDS.municipality,
    FIELDS.locality,
    FIELDS.postal_code,
    FIELDS.time,
    FIELDS.latitude,
  ];
}

function buildCommonWorkerOptions() {
  return Object.assign({}, WORKER_ASSETS, {
    batchCoalesceRows: 65536,
    dimensions: buildRuntimeDimensions(),
    emitSnapshots: true,
    groups: buildGroupSpecs(),
    kpis: [
      { id: 'rows', op: 'count' },
      { field: FIELDS.latitude, id: 'avgLatitude', op: 'avgNonZero' },
    ],
    progressThrottleMs: 100,
    snapshotThrottleMs: 300,
    wasm: true,
  });
}

function buildLiveSources() {
  const poiFilter = {
    dimension: 'semantic_events.location_type',
    operator: 'equals',
    values: ['POI'],
  };

  var granularity = state.timeGranularity;

  var primaryQuery = {
    format: 'arrow',
    query: {
      dimensions: CUBE_DIMENSIONS_PRIMARY,
      filters: [poiFilter],
      limit: 1000000,
      timeDimensions: [{ dimension: CUBE_TIME_DIMENSION, granularity: granularity }],
      timezone: 'UTC',
    },
  };

  return {
    primaryQuery,
    sources: [
      {
        dataFetchInit: {
          body: JSON.stringify(primaryQuery),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
        dataUrl: CUBE_API,
        id: 'primary',
        projection: {
          rename: {
            [cubeTimeField(granularity)]: FIELDS.time,
            [cubeTimeField('minute')]: FIELDS.time,
            [cubeTimeField('hour')]: FIELDS.time,
            [cubeTimeField('day')]: FIELDS.time,
            [cubeTimeField('week')]: FIELDS.time,
            [cubeTimeField('month')]: FIELDS.time,
          },
          transforms: {
            [FIELDS.time]: 'timestampMs',
          },
        },
        role: 'base',
      },
    ],
  };
}

function buildWorkerOptions() {
  const common = buildCommonWorkerOptions();
  if (state.dataSource === 'live') {
    const live = buildLiveSources();
    showQueries(live.primaryQuery);
    return Object.assign({}, common, {
      sources: live.sources,
    });
  }

  hideQueries();
  return Object.assign({}, common, {
    sources: [{
      dataUrl: ARROW_FILE,
      id: 'local',
      projection: {
        rename: {
          [cubeTimeField('minute')]: FIELDS.time,
        },
        transforms: {
          [FIELDS.time]: 'timestampMs',
        },
      },
      role: 'base',
    }],
  });
}

function getTimeGroupEntries(snapshot) {
  if (!snapshot) {
    return [];
  }
  const groupId = GROUP_IDS.timelines[state.timeGranularity];
  return (snapshot.groups[groupId] || []).filter((entry) => entry.key != null && entry.value && entry.value.rows > 0);
}

function isVisibleGroupEntry(entry) {
  return entry && entry.key != null && entry.key !== '' && entry.value && entry.value.rows > 0;
}

function countVisibleGroupRows(entries) {
  let count = 0;
  for (const entry of entries || []) {
    if (isVisibleGroupEntry(entry)) {
      count += 1;
    }
  }
  return count;
}

function sortedGroupRows(entries, options) {
  const max = options && options.limit ? options.limit : Infinity;
  const sort = options && options.sort ? options.sort : 'desc';
  const filtered = (entries || []).filter(isVisibleGroupEntry);
  filtered.sort((left, right) => {
    const diff = left.value.rows - right.value.rows;
    if (diff !== 0) {
      return sort === 'asc' ? diff : -diff;
    }
    return String(left.key).localeCompare(String(right.key));
  });
  return filtered.slice(0, max);
}

function updateRuntimeBadge(runtimeInfo) {
  if (!runtimeInfo) {
    dom.runtimeBadge.textContent = '—';
    return;
  }
  const active = runtimeInfo.active === 'wasm' ? 'WASM' : 'JS';
  dom.runtimeBadge.textContent = `${active} worker`;
  dom.runtimeBadge.style.background = runtimeInfo.active === 'wasm' ? '#2e7d32' : '';
  dom.runtimeBadge.style.color = runtimeInfo.active === 'wasm' ? '#fff' : '';
}

function renderKpis(snapshot) {
  const regions = countVisibleGroupRows(snapshot.groups[GROUP_IDS.regions]);
  const avgLatitude = snapshot.kpis.avgLatitude;
  const rows = snapshot.kpis.rows;
  const timeRange = Array.isArray(state.filters[FIELDS.time]) ? state.filters[FIELDS.time] : state.baseTimeBounds;

  setKpiCard(dom.kpiTotal, formatNumber(rows), 'Rows');
  setKpiCard(dom.kpiLocations, formatNumber(regions), 'Visible Regions');
  setKpiCard(dom.kpiLatitude, formatFloat(avgLatitude, 3), 'Avg Latitude');
  setKpiCard(dom.kpiTimespan, timeRange ? currentTimeRangeLabel() : '—', 'Time Window');
}

function ensureChart(existing, element, initialize) {
  if (existing) {
    return existing;
  }
  const chart = echarts.init(element);
  if (initialize) {
    initialize(chart);
  }
  return chart;
}

function initHorizontalBarChart(chart) {
  chart.setOption({
    animation: false,
    grid: { left: 140, right: 20, top: 10, bottom: 20 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'value' },
    yAxis: { type: 'category', data: [] },
    series: [{ type: 'bar', data: [] }],
  });
}

function initTimelineChart(chart) {
  chart.setOption({
    animation: false,
    grid: { left: 50, right: 20, top: 20, bottom: 60 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: [], axisLabel: { rotate: 40 } },
    yAxis: { type: 'value' },
    series: [{ type: 'line', data: [], smooth: false, symbol: 'none', areaStyle: { opacity: 0.1 } }],
  });
}

function ensureChartClickHandler(chart, marker, handler) {
  if (!chart || chart[marker]) {
    return;
  }
  chart[marker] = true;
  chart.on('click', handler);
}

function renderEventChart(snapshot) {
  const data = sortedGroupRows(snapshot.groups[GROUP_IDS.events], { limit: 20, sort: 'desc' });
  const categories = data.map((entry) => entry.key);
  const values = data.map((entry) => entry.value.rows);
  state.charts.event = ensureChart(state.charts.event, dom.chartEvent, initHorizontalBarChart);

  state.charts.event.setOption({
    yAxis: { data: categories },
    series: [{
      data: data.map((entry) => ({
        itemStyle: { color: (state.filters[FIELDS.event] || []).includes(entry.key) ? '#000e4a' : '#3f6587' },
        value: entry.value.rows,
      })),
    }],
  });

  dom.eventGroupSize.textContent = `${categories.length}`;
}

function renderTimelineChart(snapshot) {
  const entries = getTimeGroupEntries(snapshot).slice().sort((left, right) => Number(left.key) - Number(right.key));
  const categories = entries.map((entry) => formatTimestamp(entry.key, state.timeGranularity));
  const values = entries.map((entry) => entry.value.rows);
  state.charts.timeline = ensureChart(state.charts.timeline, dom.chartTimeline, initTimelineChart);
  state.charts.timeline.setOption({
    xAxis: { data: categories, axisLabel: { rotate: 40 } },
    series: [{ data: values }],
  });
  var granLabel = getGranularityMeta(state.timeGranularity).label;
  var badgeText = state.serverGranularity
    ? granLabel + ' (server) • ' + entries.length
    : granLabel + ' • ' + entries.length;
  dom.timeGranularityBadge.textContent = badgeText;
}

function renderBarChart(chartKey, element, entries, activeValues, badgeEl) {
  const data = sortedGroupRows(entries, { limit: 20, sort: 'desc' });
  const categories = data.map((entry) => entry.key);
  state.charts[chartKey] = ensureChart(state.charts[chartKey], element, initHorizontalBarChart);
  state.charts[chartKey].setOption({
    yAxis: { data: categories },
    series: [{
      data: data.map((entry) => ({
        itemStyle: { color: activeValues.includes(entry.key) ? '#000e4a' : '#3f6587' },
        value: entry.value.rows,
      })),
    }],
  });
  badgeEl.textContent = `${categories.length}`;
}

function renderList(container, entries, filterField, options) {
  const data = sortedGroupRows(entries, options);
  const maxValue = data.length ? Math.max.apply(null, data.map((entry) => entry.value.rows)) : 0;
  const fragment = document.createDocumentFragment();

  for (const entry of data) {
    const item = document.createElement('button');
    item.className = 'list-item';
    item.type = 'button';
    item.dataset.key = filterField;
    item.dataset.value = String(entry.key);
    if ((state.filters[filterField] || []).includes(entry.key)) {
      item.classList.add('list-item--active');
    }

    const bar = document.createElement('div');
    bar.className = 'list-item-bar';
    bar.style.width = maxValue > 0 ? `${(entry.value.rows / maxValue) * 100}%` : '0%';

    const label = document.createElement('span');
    label.className = 'list-item-label';
    label.textContent = String(entry.key);

    const count = document.createElement('span');
    count.className = 'list-item-count';
    count.textContent = formatNumber(entry.value.rows);

    item.appendChild(bar);
    item.appendChild(label);
    item.appendChild(count);
    fragment.appendChild(item);
  }

  container.replaceChildren(fragment);
}

function updateGroupBadges(snapshot) {
  dom.ccGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.customerCountries])}`;
  dom.lcGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.locationCountries])}`;
  dom.regionGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.regions])}`;
  dom.divisionGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.divisions])}`;
  dom.muniGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.municipalities])}`;
  dom.locGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.localities])}`;
  dom.postalGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.postalCodes])}`;
}

function renderCharts(snapshot) {
  renderEventChart(snapshot);
  renderTimelineChart(snapshot);
  renderBarChart('region', dom.chartRegion, snapshot.groups[GROUP_IDS.regions], state.filters[FIELDS.region] || [], dom.regionGroupSize);
  renderBarChart('division', dom.chartDivision, snapshot.groups[GROUP_IDS.divisions], state.filters[FIELDS.division] || [], dom.divisionGroupSize);
  renderList(dom.listCustomerCountry, snapshot.groups[GROUP_IDS.customerCountries], FIELDS.customer_country, { limit: 25, sort: 'desc' });
  renderList(dom.listLocationCountry, snapshot.groups[GROUP_IDS.locationCountries], FIELDS.location_country, { limit: 25, sort: 'desc' });
  renderList(dom.listMunicipality, snapshot.groups[GROUP_IDS.municipalities], FIELDS.municipality, { limit: 20, sort: 'desc' });
  renderList(dom.listLocality, snapshot.groups[GROUP_IDS.localities], FIELDS.locality, { limit: 20, sort: state.localitySort === 'least' ? 'asc' : 'desc' });
  renderList(dom.listPostal, snapshot.groups[GROUP_IDS.postalCodes], FIELDS.postal_code, { limit: 20, sort: 'desc' });
  updateGroupBadges(snapshot);

  ensureChartClickHandler(state.charts.event, '__filterHandler', (params) => {
    if (!params || params.name == null) {
      return;
    }
    toggleArrayFilterValue(FIELDS.event, params.name);
    scheduleRefresh(true);
  });
  ensureChartClickHandler(state.charts.region, '__filterHandler', (params) => {
    if (!params || params.name == null) {
      return;
    }
    toggleArrayFilterValue(FIELDS.region, params.name);
    scheduleRefresh(true);
  });
  ensureChartClickHandler(state.charts.division, '__filterHandler', (params) => {
    if (!params || params.name == null) {
      return;
    }
    toggleArrayFilterValue(FIELDS.division, params.name);
    scheduleRefresh(true);
  });
  ensureChartClickHandler(state.charts.timeline, '__filterHandler', (params) => {
    const entries = getTimeGroupEntries(state.currentSnapshot).slice().sort((left, right) => Number(left.key) - Number(right.key));
    const entry = entries[params.dataIndex];
    if (!entry) {
      return;
    }
    const granularity = getGranularityMeta(state.timeGranularity);
    let end = granularity.ms ? entry.key + granularity.ms : Number(entry.key);
    if (granularity.id === 'month') {
      const date = new Date(Number(entry.key));
      end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
    state.filters[FIELDS.time] = [Number(entry.key), end];
    scheduleRefresh(true);
  });
}

function renderFilterChips() {
  const fragment = document.createDocumentFragment();
  const filters = buildDashboardFilters();
  const entries = Object.entries(filters);

  if (!entries.length) {
    dom.filterChips.textContent = 'No active filters';
    return;
  }

  for (const [field, filter] of entries) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    const name = fieldLabel(field);
    let valueText = 'All';
    if (filter.type === 'in') {
      valueText = filter.values.join(', ');
    } else if (filter.type === 'range') {
      valueText = filter.range.map((value) => field === FIELDS.time ? formatTimestamp(value, state.timeGranularity) : String(value)).join(' → ');
    } else if (filter.type === 'exact') {
      valueText = String(filter.value);
    }
    chip.textContent = `${name}: ${valueText}`;
    fragment.appendChild(chip);
  }

  dom.filterChips.replaceChildren(fragment);
}

function syncTimeControls() {
  const bounds = state.baseTimeBounds;
  if (!bounds) {
    dom.timeMin.disabled = true;
    dom.timeMax.disabled = true;
    dom.timeRangeLabel.textContent = '—';
    return;
  }

  dom.timeMin.disabled = false;
  dom.timeMax.disabled = false;
  dom.timeMin.min = String(bounds[0]);
  dom.timeMin.max = String(bounds[1]);
  dom.timeMax.min = String(bounds[0]);
  dom.timeMax.max = String(bounds[1]);
  dom.timeMin.step = '60000';
  dom.timeMax.step = '60000';

  const selected = Array.isArray(state.filters[FIELDS.time]) ? state.filters[FIELDS.time] : bounds;
  dom.timeMin.value = String(selected[0]);
  dom.timeMax.value = String(selected[1]);
  dom.timeRangeLabel.textContent = currentTimeRangeLabel();
}

function syncLatitudeControls() {
  const selected = Array.isArray(state.filters[FIELDS.latitude]) ? state.filters[FIELDS.latitude] : [null, null];
  dom.latMin.value = selected[0] == null ? '' : String(selected[0]);
  dom.latMax.value = selected[1] == null ? '' : String(selected[1]);
}

function renderPickerOptions(container, searchInput, filterField, entries) {
  const search = (searchInput.value || '').trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  const data = sortedGroupRows(entries, { limit: Infinity, sort: 'desc' }).filter((entry) => String(entry.key).toLowerCase().includes(search));

  for (const entry of data) {
    const option = document.createElement('label');
    option.className = 'picker-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = (state.filters[filterField] || []).includes(entry.key);
    checkbox.dataset.filterField = filterField;
    checkbox.dataset.filterValue = String(entry.key);

    const text = document.createElement('span');
    text.textContent = `${entry.key} (${formatNumber(entry.value.rows)})`;

    option.appendChild(checkbox);
    option.appendChild(text);
    fragment.appendChild(option);
  }

  container.replaceChildren(fragment);
}

function renderSelectedPills(container, trigger, filterField, placeholder) {
  const values = state.filters[filterField] || [];
  const fragment = document.createDocumentFragment();

  for (const value of values) {
    const pill = document.createElement('span');
    pill.className = 'picker-pill';
    pill.textContent = value;
    const button = document.createElement('button');
    button.className = 'picker-pill-dismiss';
    button.type = 'button';
    button.textContent = '×';
    button.dataset.filterField = filterField;
    button.dataset.filterValue = String(value);
    pill.appendChild(document.createTextNode(' '));
    pill.appendChild(button);
    fragment.appendChild(pill);
  }

  container.replaceChildren(fragment);
  const placeholderEl = trigger.querySelector('.picker-placeholder');
  placeholderEl.textContent = values.length ? `${values.length} selected` : placeholder;
  trigger.classList.toggle('picker-trigger--has-selection', values.length > 0);
}

function renderRegionOptions(entries) {
  const search = (dom.regionSearch.value || '').trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  const data = sortedGroupRows(entries, { limit: Infinity, sort: 'desc' }).filter((entry) => String(entry.key).toLowerCase().includes(search));

  for (const entry of data) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = (state.filters[FIELDS.region] || []).includes(entry.key);
    checkbox.dataset.filterField = FIELDS.region;
    checkbox.dataset.filterValue = String(entry.key);
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${entry.key} (${formatNumber(entry.value.rows)})`));
    fragment.appendChild(label);
  }

  dom.regionCheckboxes.replaceChildren(fragment);
}

function renderFilterControls(snapshot) {
  renderPickerOptions(dom.customerCountryOptions, dom.customerCountrySearch, FIELDS.customer_country, snapshot.groups[GROUP_IDS.customerCountries]);
  renderSelectedPills(dom.customerCountryPills, dom.customerCountryTrigger, FIELDS.customer_country, 'Select countries...');
  dom.customerCountryCount.textContent = `${(state.filters[FIELDS.customer_country] || []).length} selected`;

  renderPickerOptions(dom.locationCountryOptions, dom.locationCountrySearch, FIELDS.location_country, snapshot.groups[GROUP_IDS.locationCountries]);
  renderSelectedPills(dom.locationCountryPills, dom.locationCountryTrigger, FIELDS.location_country, 'Select countries...');
  dom.locationCountryCount.textContent = `${(state.filters[FIELDS.location_country] || []).length} selected`;

  renderRegionOptions(snapshot.groups[GROUP_IDS.regions]);
  dom.regionCount.textContent = `${(state.filters[FIELDS.region] || []).length} selected`;

  const eventFragment = document.createDocumentFragment();
  sortedGroupRows(snapshot.groups[GROUP_IDS.events], { limit: 20, sort: 'desc' }).forEach((entry) => {
    const button = document.createElement('button');
    button.className = 'pill';
    button.type = 'button';
    button.dataset.filterField = FIELDS.event;
    button.dataset.filterValue = String(entry.key);
    button.textContent = `${entry.key} (${formatNumber(entry.value.rows)})`;
    button.classList.toggle('pill--active', (state.filters[FIELDS.event] || []).includes(entry.key));
    eventFragment.appendChild(button);
  });
  dom.eventPills.replaceChildren(eventFragment);

  syncTimeControls();
  syncLatitudeControls();

  dom.clearButtons.forEach((button) => {
    const clearKey = button.dataset.clear;
    const field = clearKey && FIELDS[clearKey];
    button.hidden = !field || !hasActiveFilter(field);
  });
}

function renderTable() {
  dom.tableRowCount.textContent = state.currentSnapshot
    ? `${formatNumber(state.currentRows.length)} of ${formatNumber(state.currentSnapshot.kpis.rows)} loaded`
    : '—';

  const fragment = document.createDocumentFragment();
  for (const row of state.currentRows) {
    const tr = document.createElement('tr');
    for (const field of TABLE_FIELDS) {
      const td = document.createElement('td');
      td.textContent = field === FIELDS.time
        ? formatTimestamp(row[field], state.timeGranularity)
        : field === FIELDS.latitude
          ? formatFloat(row[field], 4)
          : row[field] == null
            ? '—'
            : String(row[field]);
      tr.appendChild(td);
    }
    fragment.appendChild(tr);
  }
  dom.tableBody.replaceChildren(fragment);
}

function renderTableHeader() {
  const fragment = document.createDocumentFragment();
  for (const field of TABLE_FIELDS) {
    const th = document.createElement('th');
    th.textContent = fieldLabel(field);
    fragment.appendChild(th);
  }
  dom.tableHead.replaceChildren(fragment);
}

function renderLocalitySortState() {
  dom.localitySortLabel.textContent = state.localitySort === 'least' ? 'Least Frequent' : 'Most Frequent';
}

function renderGranularityButtons() {
  for (const button of dom.granularityButtons) {
    button.classList.toggle('gran-btn--active', button.dataset.gran === state.timeGranularity);
  }
}

function updateDemoButtons() {
  if (dom.addRowsBtn) {
    dom.addRowsBtn.disabled = !state.ready || !state.seedRows.length;
  }
  if (dom.removeFilteredBtn) {
    dom.removeFilteredBtn.disabled = !state.ready || Object.keys(buildDashboardFilters()).length === 0;
  }
}

function renderSnapshot(snapshot, options) {
  if (!snapshot) {
    return;
  }

  state.currentSnapshot = snapshot;
  updateRuntimeBadge(snapshot.runtime);
  renderKpis(snapshot);
  renderCharts(snapshot);
  renderFilterControls(snapshot);
  renderFilterChips();
  renderGranularityButtons();
  renderLocalitySortState();
  updateDemoButtons();
  if (!options || !options.skipTable) {
    renderTable();
  }
}

async function disposeRuntime() {
  for (const unsubscribe of state.runtimeListeners) {
    try {
      unsubscribe();
    } catch (_) {}
  }
  state.runtimeListeners = [];

  if (state.runtime) {
    try {
      await state.runtime.dispose();
    } catch (error) {
      appendLog(`Worker dispose failed: ${error.message || error}`);
    }
  }

  state.runtime = null;
  state.ready = false;
  state.seedRows = [];
  updateDemoButtons();
}

async function readBaseTimeBounds(runtime, filters) {
  const readBounds = async () => {
    const [topRows, bottomRows] = await Promise.all([
      runtime.rows({ fields: [FIELDS.time], limit: 1, sortBy: FIELDS.time }),
      runtime.rows({ direction: 'bottom', fields: [FIELDS.time], limit: 1, sortBy: FIELDS.time }),
    ]);

    const max = topRows.length ? Number(topRows[0][FIELDS.time]) : null;
    const min = bottomRows.length ? Number(bottomRows[0][FIELDS.time]) : null;
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null;
    }
    return [min, max];
  };

  if (filters) {
    return withTemporaryFilters(runtime, filters, readBounds);
  }
  return readBounds();
}

async function loadSeedRows(runtime) {
  return withTemporaryFilters(runtime, {}, async () => {
    const [latestRows, oldestRows] = await Promise.all([
      runtime.rows({ fields: TABLE_FIELDS, limit: 500, sortBy: FIELDS.time }),
      runtime.rows({ direction: 'bottom', fields: TABLE_FIELDS, limit: 500, sortBy: FIELDS.time }),
    ]);
    return latestRows.concat(oldestRows);
  });
}

function generateSyntheticRows(count) {
  const sourceRows = state.seedRows.length ? state.seedRows : state.currentRows;
  if (!sourceRows.length) {
    return [];
  }

  const rows = [];
  for (let index = 0; index < count; ++index) {
    const source = sourceRows[Math.floor(Math.random() * sourceRows.length)];
    const row = {};

    for (const field of TABLE_FIELDS) {
      row[field] = source[field];
    }

    const timestamp = Number(row[FIELDS.time]);
    if (Number.isFinite(timestamp)) {
      row[FIELDS.time] = timestamp + Math.floor((Math.random() - 0.5) * 3600000 * 48);
    }

    const latitude = Number(row[FIELDS.latitude]);
    if (Number.isFinite(latitude)) {
      row[FIELDS.latitude] = latitude + (Math.random() - 0.5) * 2;
    }

    rows.push(row);
  }

  return rows;
}

async function runRuntimeMutation(logLabel, loadingText, operation) {
  if (!state.runtime || !state.ready) {
    return;
  }

  hideError();
  setLoading(true, loadingText);
  const startedAt = performance.now();

  try {
    const size = await operation();
    appendLog(`${logLabel}: ${(performance.now() - startedAt).toFixed(1)} ms`);
    appendLog(`Dataset size: ${formatNumber(size)} rows`);
    state.baseTimeBounds = await readBaseTimeBounds(state.runtime, {});
    await refreshView(true);
  } catch (error) {
    showError(error.message || String(error));
    appendLog(`${logLabel} failed: ${error.message || error}`);
  } finally {
    setLoading(false);
  }
}

async function onAddRows() {
  const rows = generateSyntheticRows(1000);
  if (!rows.length) {
    appendLog('Add 1000 rows skipped: no seed rows are available yet.');
    return;
  }

  await runRuntimeMutation('Add 1000 rows', 'Appending 1,000 synthetic rows...', () => state.runtime.append(rows));
}

async function onRemoveFiltered() {
  if (Object.keys(buildDashboardFilters()).length === 0) {
    appendLog('Remove excluded skipped: no active filters.');
    return;
  }

  await runRuntimeMutation('Remove excluded rows', 'Removing excluded rows...', () => state.runtime.removeFiltered('excluded'));
}

async function refreshRows(replace) {
  if (!state.runtime || !state.ready) {
    return;
  }

  state.tableLoading = true;
  const rows = await state.runtime.rows({
    direction: state.tableSort === 'bottom' ? 'bottom' : 'top',
    fields: TABLE_FIELDS,
    limit: TABLE_PAGE_SIZE,
    offset: replace ? 0 : state.tableOffset,
    sortBy: FIELDS.time,
  });

  if (replace) {
    state.currentRows = rows;
    state.tableOffset = rows.length;
  } else {
    state.currentRows.push.apply(state.currentRows, rows);
    state.tableOffset += rows.length;
  }
  state.tableHasMore = rows.length === TABLE_PAGE_SIZE;
  state.tableLoading = false;
}

async function refreshView(resetTable) {
  try {
    if (!state.runtime || !state.ready) {
      return;
    }

    const requestId = ++state.latestRequestId;
    const filters = buildDashboardFilters();
    const startedAt = performance.now();
    state.tableLoading = true;
    if (resetTable) {
      state.currentRows = [];
      state.tableOffset = 0;
      dom.tableScroll.scrollTop = 0;
    }

    const result = await state.runtime.query({
      filters,
      rows: {
        direction: state.tableSort === 'bottom' ? 'bottom' : 'top',
        fields: TABLE_FIELDS,
        limit: TABLE_PAGE_SIZE,
        offset: resetTable ? 0 : state.tableOffset,
        sortBy: FIELDS.time,
      },
    });
    if (requestId !== state.latestRequestId) {
      return;
    }

    const rows = result.rows || [];
    if (resetTable) {
      state.currentRows = rows;
      state.tableOffset = rows.length;
    } else {
      state.currentRows.push.apply(state.currentRows, rows);
      state.tableOffset += rows.length;
    }
    state.tableHasMore = rows.length === TABLE_PAGE_SIZE;
    state.tableLoading = false;

    state.lastInteractionMs = performance.now() - startedAt;
    dom.latencyDisplay.textContent = `${state.lastInteractionMs.toFixed(1)} ms`;
    renderSnapshot(result.snapshot);
  } catch (error) {
    state.tableLoading = false;
    showError(error.message || String(error));
    appendLog(`View refresh failed: ${error.message || error}`);
  }
}

function attachRuntimeListeners(runtime, loadToken) {
  const unsubscribers = [];

  unsubscribers.push(runtime.on('progress', (progress) => {
    if (loadToken !== state.loadToken) {
      return;
    }
    state.progress = progress;
    dom.loadingText.textContent = formatProgress(progress);
    updateRuntimeBadge(progress.runtime);
    updateProgressBadge(progress);
  }));

  unsubscribers.push(runtime.on('snapshot', ({ progress, snapshot }) => {
    if (loadToken !== state.loadToken || state.ready) {
      return;
    }
    state.progress = progress;
    if (state.firstSnapshotMs == null && state.loadStartedAt) {
      state.firstSnapshotMs = performance.now() - state.loadStartedAt;
      appendLog(`First streamed snapshot in ${state.firstSnapshotMs.toFixed(1)} ms`);
    }
    updateProgressBadge(progress);
    renderSnapshot(snapshot, { skipTable: true });
  }));

  unsubscribers.push(runtime.on('error', (payload) => {
    if (loadToken !== state.loadToken) {
      return;
    }
    showError(payload.message || 'Worker error');
    appendLog(`Worker error: ${payload.message || 'unknown error'}`);
  }));

  state.runtimeListeners = unsubscribers;
}

async function loadSource() {
  const loadToken = ++state.loadToken;
  hideError();
  state.currentSnapshot = null;
  state.currentRows = [];
  state.baseTimeBounds = null;
  state.firstSnapshotMs = null;
  state.loadStartedAt = performance.now();
  state.progress = null;
  state.ready = false;
  state.seedRows = [];
  state.serverGranularity = null;
  state.tableHasMore = false;
  state.tableOffset = 0;
  state.lastInteractionMs = null;
  dom.latencyDisplay.textContent = '— ms';
  setLoading(true, 'Starting streaming worker...');
  appendLog(`Loading ${state.dataSource === 'live' ? 'live' : 'local'} data with createStreamingDashboardWorker(...)`);

  await disposeRuntime();

  const workerOptions = buildWorkerOptions();
  const loadStartedAt = state.loadStartedAt;
  const runtime = await crossfilter.createStreamingDashboardWorker(workerOptions);
  if (loadToken !== state.loadToken) {
    await runtime.dispose();
    return;
  }

  state.runtime = runtime;
  attachRuntimeListeners(runtime, loadToken);

  const readyPayload = await runtime.ready;
  if (loadToken !== state.loadToken) {
    await runtime.dispose();
    return;
  }

  state.progress = readyPayload;
  state.ready = true;
  state.serverGranularity = state.dataSource === 'live' ? state.timeGranularity : null;
  updateProgressBadge(readyPayload);
  dom.loadTime.textContent = `Load: ${(performance.now() - loadStartedAt).toFixed(0)} ms`;
  appendLog(`Worker ready in ${(performance.now() - loadStartedAt).toFixed(1)} ms`);
  appendLog(`Stream loaded ${formatNumber(readyPayload.load.rowsLoaded)} rows in ${formatNumber(readyPayload.load.batchesLoaded)} batches (${readyPayload.runtime && readyPayload.runtime.active === 'wasm' ? 'WASM' : 'JS'} worker)`);
  if (state.dataSource === 'live') {
    appendArrowMetadataLog(readyPayload);
  }

  const [seedRows, baseTimeBounds] = await Promise.all([
    loadSeedRows(runtime),
    readBaseTimeBounds(runtime, {}),
  ]);
  state.seedRows = seedRows;
  state.baseTimeBounds = baseTimeBounds;
  syncTimeControls();
  updateDemoButtons();
  setLoading(false);
  await refreshView(true);
}

function clearAllFilters() {
  state.filters = createEmptyFilterState();
  scheduleRefresh(true);
}

function applyTimeRangeFromControls() {
  if (!state.baseTimeBounds) {
    return;
  }

  let min = Number(dom.timeMin.value);
  let max = Number(dom.timeMax.value);
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    state.filters[FIELDS.time] = null;
    scheduleRefresh(true);
    return;
  }

  if (min > max) {
    const swap = min;
    min = max;
    max = swap;
  }

  if (min <= state.baseTimeBounds[0] && max >= state.baseTimeBounds[1]) {
    state.filters[FIELDS.time] = null;
  } else {
    state.filters[FIELDS.time] = [min, max];
  }
  scheduleRefresh(true);
}

function applyLatitudeRangeFromControls() {
  const min = dom.latMin.value === '' ? null : Number(dom.latMin.value);
  const max = dom.latMax.value === '' ? null : Number(dom.latMax.value);
  if (min == null && max == null) {
    state.filters[FIELDS.latitude] = null;
    scheduleRefresh(true);
    return;
  }
  state.filters[FIELDS.latitude] = [
    min == null ? Number.NEGATIVE_INFINITY : min,
    max == null ? Number.POSITIVE_INFINITY : max,
  ];
  scheduleRefresh(true);
}

function togglePicker(dropdown, trigger) {
  const isOpen = !dropdown.hidden;
  dropdown.hidden = isOpen;
  trigger.classList.toggle('picker-trigger--open', !isOpen);
}

function closePicker(dropdown, trigger) {
  dropdown.hidden = true;
  trigger.classList.remove('picker-trigger--open');
}

function attachControlListeners() {
  dom.sourceButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextSource = button.dataset.source;
      if (nextSource === state.dataSource) {
        return;
      }
      state.dataSource = nextSource;
      state.filters = createEmptyFilterState();
      dom.sourceButtons.forEach((item) => item.classList.toggle('mode-btn--active', item === button));
      loadSource().catch((error) => {
        showError(error.message || String(error));
        appendLog(`Load failed: ${error.message || error}`);
        setLoading(false);
      });
    });
  });

  dom.tableSortToggle.addEventListener('click', () => {
    state.tableSort = state.tableSort === 'top' ? 'bottom' : 'top';
    dom.tableSortToggle.textContent = state.tableSort === 'top' ? 'Showing: Most Recent' : 'Showing: Oldest';
    scheduleRefresh(true);
  });

  dom.localitySortToggle.addEventListener('click', () => {
    state.localitySort = state.localitySort === 'least' ? 'most' : 'least';
    if (state.currentSnapshot) {
      renderSnapshot(state.currentSnapshot);
    }
  });

  dom.clearAllBtn.addEventListener('click', clearAllFilters);
  if (dom.addRowsBtn) {
    dom.addRowsBtn.addEventListener('click', () => {
      onAddRows();
    });
  }
  if (dom.removeFilteredBtn) {
    dom.removeFilteredBtn.addEventListener('click', () => {
      onRemoveFiltered();
    });
  }
  dom.timeMin.addEventListener('change', applyTimeRangeFromControls);
  dom.timeMax.addEventListener('change', applyTimeRangeFromControls);
  dom.latMin.addEventListener('change', applyLatitudeRangeFromControls);
  dom.latMax.addEventListener('change', applyLatitudeRangeFromControls);
  dom.regionSearch.addEventListener('input', () => {
    if (state.currentSnapshot) {
      renderRegionOptions(state.currentSnapshot.groups[GROUP_IDS.regions]);
    }
  });
  dom.customerCountrySearch.addEventListener('input', () => {
    if (state.currentSnapshot) {
      renderPickerOptions(dom.customerCountryOptions, dom.customerCountrySearch, FIELDS.customer_country, state.currentSnapshot.groups[GROUP_IDS.customerCountries]);
    }
  });
  dom.locationCountrySearch.addEventListener('input', () => {
    if (state.currentSnapshot) {
      renderPickerOptions(dom.locationCountryOptions, dom.locationCountrySearch, FIELDS.location_country, state.currentSnapshot.groups[GROUP_IDS.locationCountries]);
    }
  });

  dom.eventPills.addEventListener('click', (event) => {
    const button = event.target.closest('.pill[data-filter-field]');
    if (!button) {
      return;
    }
    toggleArrayFilterValue(button.dataset.filterField, button.dataset.filterValue);
    scheduleRefresh(true);
  });

  [dom.customerCountryOptions, dom.locationCountryOptions, dom.regionCheckboxes].forEach((container) => {
    container.addEventListener('change', (event) => {
      const input = event.target;
      if (!input || input.tagName !== 'INPUT' || !input.dataset.filterField) {
        return;
      }
      toggleArrayFilterValue(input.dataset.filterField, input.dataset.filterValue);
      scheduleRefresh(true);
    });
  });

  [dom.customerCountryPills, dom.locationCountryPills].forEach((container) => {
    container.addEventListener('click', (event) => {
      const button = event.target.closest('.picker-pill-dismiss');
      if (!button) {
        return;
      }
      event.stopPropagation();
      const field = button.dataset.filterField;
      const value = button.dataset.filterValue;
      state.filters[field] = (state.filters[field] || []).filter((item) => item !== value);
      scheduleRefresh(true);
    });
  });

  if (dom.chartGrid) {
    dom.chartGrid.addEventListener('click', (event) => {
      const item = event.target.closest('.list-item');
      if (!item) {
        return;
      }
      const field = item.dataset.key;
      const value = item.dataset.value;
      if (!field || value == null) {
        return;
      }
      toggleArrayFilterValue(field, value);
      scheduleRefresh(true);
    });
  }

  dom.customerCountryTrigger.addEventListener('click', () => togglePicker(dom.customerCountryDropdown, dom.customerCountryTrigger));
  dom.locationCountryTrigger.addEventListener('click', () => togglePicker(dom.locationCountryDropdown, dom.locationCountryTrigger));

  document.addEventListener('click', (event) => {
    if (!dom.customerCountryPicker.contains(event.target)) {
      closePicker(dom.customerCountryDropdown, dom.customerCountryTrigger);
    }
    if (!dom.locationCountryPicker.contains(event.target)) {
      closePicker(dom.locationCountryDropdown, dom.locationCountryTrigger);
    }
  });

  dom.clearButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.clear;
      const field = key && FIELDS[key];
      if (!field) {
        return;
      }
      state.filters[field] = Array.isArray(state.filters[field]) ? [] : null;
      scheduleRefresh(true);
    });
  });

  dom.tableScroll.addEventListener('scroll', async () => {
    if (!state.ready || state.tableLoading || !state.tableHasMore) {
      return;
    }
    if (dom.tableScroll.scrollTop + dom.tableScroll.clientHeight < dom.tableScroll.scrollHeight - 60) {
      return;
    }
    await refreshRows(false);
    renderTable();
  });

  dom.granularityButtons.forEach((button) => {
    button.addEventListener('click', () => {
      var nextGran = button.dataset.gran;
      if (nextGran === state.timeGranularity) {
        return;
      }
      state.timeGranularity = nextGran;
      if (state.dataSource === 'live' && nextGran !== state.serverGranularity) {
        loadSource().catch(function (error) {
          showError(error.message || String(error));
          appendLog('Granularity reload failed: ' + (error.message || error));
          setLoading(false);
        });
      } else if (state.currentSnapshot) {
        renderSnapshot(state.currentSnapshot);
      }
    });
  });

  window.addEventListener('resize', () => {
    if (state.resizeRafId) {
      return;
    }
    state.resizeRafId = requestAnimationFrame(() => {
      state.resizeRafId = 0;
      for (const chart of Object.values(state.charts)) {
        if (chart && typeof chart.resize === 'function') {
          chart.resize();
        }
      }
    });
  });
}

function initStaticUi() {
  if (dom.modeSelector) {
    dom.modeSelector.innerHTML = [
      '<button class="mode-btn mode-btn--active" type="button" title="Arrow IPC is streamed into the worker runtime">Streaming Arrow</button>',
      '<button class="mode-btn mode-btn--active" type="button" title="Filters, groups, and KPI reducers stay off the main thread">Worker Runtime</button>',
      '<button class="mode-btn mode-btn--active" type="button" title="Dense encoded discrete filters use the WASM path when supported">WASM Filters</button>',
    ].join('');
  }
  if (dom.addRowsBtn) {
    dom.addRowsBtn.textContent = 'Add 1000 Rows';
    dom.addRowsBtn.title = 'Append 1,000 synthetic rows without rebuilding the worker runtime';
  }
  if (dom.removeFilteredBtn) {
    dom.removeFilteredBtn.textContent = 'Remove Excluded';
    dom.removeFilteredBtn.title = 'Delete rows currently excluded by the active filters';
  }
  if (dom.headerSubtitle) {
    dom.headerSubtitle.textContent = 'Interactive Demo';
  }
  updateProgressBadge(null);
  setKpiCard(dom.kpiTotal, '—', 'Rows');
  setKpiCard(dom.kpiLocations, '—', 'Visible Regions');
  setKpiCard(dom.kpiLatitude, '—', 'Avg Latitude');
  setKpiCard(dom.kpiTimespan, '—', 'Time Window');
  renderTableHeader();
  renderLocalitySortState();
  renderGranularityButtons();
  dom.tableSortToggle.textContent = 'Showing: Most Recent';
  dom.sourceButtons.forEach((button) => button.classList.toggle('mode-btn--active', button.dataset.source === state.dataSource));
  updateDemoButtons();
}

async function start() {
  cacheDom();
  initStaticUi();
  attachControlListeners();
  loadSource().catch((error) => {
    showError(error.message || String(error));
    appendLog(`Initial load failed: ${error.message || error}`);
    setLoading(false);
  });
}

start();
