import {
  HORIZONTAL_BAR_AXIS_LABEL_WIDTH,
  resolveHorizontalBarChartHeight,
  truncateHorizontalBarLabel,
} from './chart-utils.js';
import {
  getDemoEChartsThemeName,
  registerDemoEChartsTheme,
} from './echarts-theme.js';
import {
  parseDemoPreferences,
  sanitizeStoredGranularity,
  serializeDemoPreferences,
  shouldFallbackToLocalFromLiveErrorMessage,
} from './source-utils.js';

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
const DEMO_PREFERENCES_KEY = 'crossfilter-demo-preferences-v1';
const LIVE_UNAVAILABLE_SESSION_KEY = 'crossfilter-demo-live-unavailable-v1';

const CUBE_TIME_DIMENSION = 'semantic_events.timestamp';

function cubeTimeField(granularity) {
  return 'semantic_events__timestamp_' + granularity;
}

function cubeTimeDotField(granularity) {
  return 'semantic_events.timestamp.' + granularity;
}
const CUBE_DIMENSIONS_LIVE = [
  'semantic_events.event',
  'semantic_events.dimensions_customer_country',
  'semantic_events.location_region',
  'semantic_events.location_division',
  'semantic_events.location_municipality',
  'semantic_events.location_locality',
  'semantic_events.location_postal_code',
];
const CUBE_MEASURES_LIVE = ['semantic_events.count'];
const COUNT_METRIC_ID = 'count';

const FIELDS = {
  count: 'semantic_events__count',
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
  count: 'Count',
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

const LIVE_TABLE_FIELDS = [
  FIELDS.event,
  FIELDS.customer_country,
  FIELDS.region,
  FIELDS.division,
  FIELDS.municipality,
  FIELDS.locality,
  FIELDS.postal_code,
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
  municipalities: 'municipalities',
  postalCodes: 'postalCodes',
  regions: 'regions',
  timelines: Object.fromEntries(TIME_GRANULARITIES.map((granularity) => [granularity.id, `timeline_${granularity.id}`])),
};

const FILTERABLE_FIELDS = [
  FIELDS.event,
  FIELDS.customer_country,
  FIELDS.region,
  FIELDS.division,
  FIELDS.municipality,
  FIELDS.locality,
  FIELDS.postal_code,
  FIELDS.time,
  FIELDS.latitude,
];

const GROUP_FILTER_FIELDS = {
  [GROUP_IDS.customerCountries]: FIELDS.customer_country,
  [GROUP_IDS.regions]: FIELDS.region,
  [GROUP_IDS.divisions]: FIELDS.division,
  [GROUP_IDS.events]: FIELDS.event,
  [GROUP_IDS.localities]: FIELDS.locality,
  [GROUP_IDS.municipalities]: FIELDS.municipality,
  [GROUP_IDS.postalCodes]: FIELDS.postal_code,
};

const GROUP_OPTION_LIMITS = {
  [GROUP_IDS.customerCountries]: 160,
  [GROUP_IDS.regions]: 180,
};

const state = {
  baseTimeBounds: null,
  controlGroups: {},
  currentLoadedCount: 0,
  currentRows: [],
  currentRowCount: 0,
  currentSnapshot: null,
  dataSource: 'live',
  filterControlsRafId: 0,
  firstSnapshotMs: null,
  groupQueryCache: {},
  groupQueryInflight: {},
  groupQueryTimers: {},
  groupQueryTokens: {},
  pendingGroupRefreshes: new Map(),
  pendingGroupFlushTimer: 0,
  lastInteractionMs: null,
  latestRequestId: 0,
  liveApiAvailable: null,
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
    customerCountry: null,
    division: null,
    event: null,
    locality: null,
    municipality: null,
    postal: null,
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
    [FIELDS.municipality]: [],
    [FIELDS.postal_code]: [],
    [FIELDS.region]: [],
    [FIELDS.time]: null,
  };
}

function cacheDom() {
  dom = {
    addRowsBtn: document.getElementById('add-rows-btn'),
    burstAppendBtn: document.getElementById('burst-append-btn'),
    chartDivision: document.getElementById('chart-division'),
    chartCustomerCountry: document.getElementById('chart-customer-country'),
    chartEvent: document.getElementById('chart-event'),
    chartLocality: document.getElementById('chart-locality'),
    chartMunicipality: document.getElementById('chart-municipality'),
    chartPostal: document.getElementById('chart-postal'),
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
    kpiLocations: document.getElementById('kpi-locations'),
    kpiRows: document.getElementById('kpi-rows'),
    kpiTimespan: document.getElementById('kpi-timespan'),
    kpiTotal: document.getElementById('kpi-total'),
    latencyDisplay: document.getElementById('latency-display'),
    loadTime: document.getElementById('load-time'),
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingText: document.querySelector('.loading-text'),
    localitySortLabel: document.getElementById('locality-sort-label'),
    localitySortToggle: document.getElementById('locality-sort-toggle'),
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
    latitudeFilterGroup: document.getElementById('latitude-filter-group'),
  };
}

function readStoredDemoPreferences() {
  if (!globalThis.localStorage) {
    return {};
  }

  return parseDemoPreferences(globalThis.localStorage.getItem(DEMO_PREFERENCES_KEY));
}

function applyStoredDemoPreferences() {
  const stored = readStoredDemoPreferences();
  const allowedGranularities = TIME_GRANULARITIES.map((item) => item.id);
  const storedGranularity = sanitizeStoredGranularity(stored.timeGranularity, allowedGranularities);

  if (storedGranularity) {
    state.timeGranularity = storedGranularity;
  }
  if (stored.localitySort === 'most' || stored.localitySort === 'least') {
    state.localitySort = stored.localitySort;
  }
  if (stored.tableSort === 'bottom' || stored.tableSort === 'top') {
    state.tableSort = stored.tableSort;
  }
}

function persistDemoPreferences() {
  if (!globalThis.localStorage) {
    return;
  }

  globalThis.localStorage.setItem(DEMO_PREFERENCES_KEY, serializeDemoPreferences({
    localitySort: state.localitySort,
    tableSort: state.tableSort,
    timeGranularity: state.timeGranularity,
  }));
}

function readSessionLiveUnavailable() {
  if (!globalThis.sessionStorage) {
    return false;
  }
  return globalThis.sessionStorage.getItem(LIVE_UNAVAILABLE_SESSION_KEY) === '1';
}

function writeSessionLiveUnavailable(value) {
  if (!globalThis.sessionStorage) {
    return;
  }
  if (value) {
    globalThis.sessionStorage.setItem(LIVE_UNAVAILABLE_SESSION_KEY, '1');
  } else {
    globalThis.sessionStorage.removeItem(LIVE_UNAVAILABLE_SESSION_KEY);
  }
}

function renderSourceButtons() {
  dom.sourceButtons.forEach((button) => {
    const source = button.dataset.source;
    const isLiveButton = source === 'live';
    button.classList.toggle('mode-btn--active', source === state.dataSource);
    button.classList.toggle('mode-btn--disabled', false);
    button.title = isLiveButton && state.liveApiAvailable === false
      ? 'Live API mode hit `/api/cube` unsuccessfully in this session. Reload after restoring the proxy/backend to retry the server path.'
      : (isLiveButton ? 'Live API mode uses the local `/api/cube` proxy when available.' : '');
  });
}

async function hydrateInitialDataSource() {
  applyStoredDemoPreferences();
  state.liveApiAvailable = readSessionLiveUnavailable() ? false : null;
  state.dataSource = state.liveApiAvailable === false ? 'file' : 'live';
  persistDemoPreferences();
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

function formatCompactNumber(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return '—';
  }
  return new Intl.NumberFormat('en', {
    maximumFractionDigits: 1,
    notation: 'compact',
  }).format(Number(value));
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

function normalizeCountValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function metricCountValue(metrics) {
  if (!metrics) {
    return 0;
  }
  if (metrics[COUNT_METRIC_ID] != null) {
    return normalizeCountValue(metrics[COUNT_METRIC_ID]);
  }
  return 0;
}

function groupEntryCount(entry) {
  return entry && entry.value ? metricCountValue(entry.value) : 0;
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
    if (field === FIELDS.latitude && !supportsLatitudeFeatures()) {
      continue;
    }
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
  if (supportsLatitudeFeatures() && Array.isArray(state.filters[FIELDS.latitude]) && state.filters[FIELDS.latitude].length === 2) {
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

function supportsLatitudeFeatures() {
  return state.dataSource !== 'live';
}

function getActiveTableFields() {
  return state.dataSource === 'live' ? LIVE_TABLE_FIELDS : TABLE_FIELDS;
}

function getActiveTableQueryFields() {
  const fields = getActiveTableFields().slice();
  if (!fields.includes(FIELDS.count)) {
    fields.push(FIELDS.count);
  }
  return fields;
}

function createCountMetric() {
  return {
    field: FIELDS.count,
    id: COUNT_METRIC_ID,
    op: 'sum',
  };
}

function getActiveRuntimeDimensions() {
  return supportsLatitudeFeatures()
    ? [
      FIELDS.event,
      FIELDS.customer_country,
      FIELDS.region,
      FIELDS.division,
      FIELDS.municipality,
      FIELDS.locality,
      FIELDS.postal_code,
      FIELDS.time,
      FIELDS.latitude,
    ]
    : [
      FIELDS.event,
      FIELDS.customer_country,
      FIELDS.region,
      FIELDS.division,
      FIELDS.municipality,
      FIELDS.locality,
      FIELDS.postal_code,
      FIELDS.time,
    ];
}

function getActiveKpiSpecs() {
  return [
    createCountMetric(),
  ];
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

function buildGroupSpecs(options) {
  const timelineGranularities = options && Array.isArray(options.timelineGranularities) && options.timelineGranularities.length
    ? options.timelineGranularities
    : TIME_GRANULARITIES.map((granularity) => granularity.id);
  const countMetric = [createCountMetric()];
  return [
    { field: FIELDS.event, id: GROUP_IDS.events, metrics: countMetric },
    { field: FIELDS.customer_country, id: GROUP_IDS.customerCountries, metrics: countMetric },
    { field: FIELDS.region, id: GROUP_IDS.regions, metrics: countMetric },
    { field: FIELDS.division, id: GROUP_IDS.divisions, metrics: countMetric },
    { field: FIELDS.municipality, id: GROUP_IDS.municipalities, metrics: countMetric },
    { field: FIELDS.locality, id: GROUP_IDS.localities, metrics: countMetric },
    { field: FIELDS.postal_code, id: GROUP_IDS.postalCodes, metrics: countMetric },
  ].concat(timelineGranularities.map((granularityId) => ({
    bucket: { type: 'timeBucket', granularity: granularityId },
    field: FIELDS.time,
    id: GROUP_IDS.timelines[granularityId],
    metrics: countMetric,
  })));
}

function buildRuntimeDimensions() {
  return getActiveRuntimeDimensions();
}

function buildCommonWorkerOptions() {
  return Object.assign({}, WORKER_ASSETS, {
    batchCoalesceRows: 65536,
    dimensions: buildRuntimeDimensions(),
    emitSnapshots: true,
    kpis: getActiveKpiSpecs(),
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
      dimensions: CUBE_DIMENSIONS_LIVE,
      filters: [poiFilter],
      limit: 1000000,
      measures: CUBE_MEASURES_LIVE,
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
            'semantic_events.count': FIELDS.count,
            semantic_events__count: FIELDS.count,
            [cubeTimeField(granularity)]: FIELDS.time,
            [cubeTimeField('minute')]: FIELDS.time,
            [cubeTimeField('hour')]: FIELDS.time,
            [cubeTimeField('day')]: FIELDS.time,
            [cubeTimeField('week')]: FIELDS.time,
            [cubeTimeField('month')]: FIELDS.time,
          },
          transforms: {
            [FIELDS.count]: 'number',
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
      groups: buildGroupSpecs({ timelineGranularities: [state.timeGranularity] }),
      snapshotGroups: buildSnapshotGroupQueries(),
      sources: live.sources,
    });
  }

  hideQueries();
  return Object.assign({}, common, {
    groups: buildGroupSpecs(),
    snapshotGroups: buildSnapshotGroupQueries(),
    sources: [{
      dataUrl: ARROW_FILE,
      id: 'local',
      projection: {
        extraFields: [FIELDS.count],
        rename: {
          [cubeTimeField('minute')]: FIELDS.time,
        },
        transforms: {
          [FIELDS.count]: 'constantOne',
          [FIELDS.time]: 'timestampMs',
        },
      },
      role: 'base',
    }],
  });
}

function selectedGroupKeys(groupId) {
  const field = GROUP_FILTER_FIELDS[groupId];
  return field && Array.isArray(state.filters[field]) ? state.filters[field] : [];
}

function buildSnapshotGroupQueries() {
  return {
    [GROUP_IDS.customerCountries]: {
      includeKeys: selectedGroupKeys(GROUP_IDS.customerCountries),
      includeTotals: true,
      limit: 25,
      nonEmptyKeys: true,
      sort: 'desc',
      sortMetric: COUNT_METRIC_ID,
    },
    [GROUP_IDS.divisions]: {
      includeKeys: selectedGroupKeys(GROUP_IDS.divisions),
      includeTotals: true,
      limit: 20,
      nonEmptyKeys: true,
      sort: 'desc',
      sortMetric: COUNT_METRIC_ID,
    },
    [GROUP_IDS.events]: {
      includeKeys: selectedGroupKeys(GROUP_IDS.events),
      includeTotals: true,
      limit: 20,
      nonEmptyKeys: true,
      sort: 'desc',
      sortMetric: COUNT_METRIC_ID,
    },
    [GROUP_IDS.localities]: {
      includeKeys: selectedGroupKeys(GROUP_IDS.localities),
      includeTotals: true,
      limit: 20,
      nonEmptyKeys: true,
      sort: state.localitySort === 'least' ? 'asc' : 'desc',
      sortMetric: COUNT_METRIC_ID,
    },
    [GROUP_IDS.municipalities]: {
      includeKeys: selectedGroupKeys(GROUP_IDS.municipalities),
      includeTotals: true,
      limit: 20,
      nonEmptyKeys: true,
      sort: 'desc',
      sortMetric: COUNT_METRIC_ID,
    },
    [GROUP_IDS.postalCodes]: {
      includeKeys: selectedGroupKeys(GROUP_IDS.postalCodes),
      includeTotals: true,
      limit: 20,
      nonEmptyKeys: true,
      sort: 'desc',
      sortMetric: COUNT_METRIC_ID,
    },
    [GROUP_IDS.regions]: {
      includeKeys: selectedGroupKeys(GROUP_IDS.regions),
      includeTotals: true,
      limit: GROUP_OPTION_LIMITS[GROUP_IDS.regions],
      nonEmptyKeys: true,
      sort: 'desc',
      sortMetric: COUNT_METRIC_ID,
    },
    [GROUP_IDS.timelines[state.timeGranularity]]: {
      includeTotals: true,
      nonEmptyKeys: true,
      sort: 'natural',
      sortMetric: COUNT_METRIC_ID,
    },
  };
}

function buildOptionGroupQuery(groupId, search) {
  return {
    includeKeys: selectedGroupKeys(groupId),
    includeTotals: false,
    limit: GROUP_OPTION_LIMITS[groupId] || 160,
    nonEmptyKeys: true,
    search: search ? search.trim() : '',
    sort: 'desc',
    sortMetric: COUNT_METRIC_ID,
  };
}

function groupEntries(groupResult) {
  if (Array.isArray(groupResult)) {
    return groupResult;
  }
  return groupResult && Array.isArray(groupResult.entries) ? groupResult.entries : [];
}

function getTimeGroupEntries(snapshot) {
  if (!snapshot) {
    return [];
  }
  const groupId = GROUP_IDS.timelines[state.timeGranularity];
  return groupEntries(snapshot.groups[groupId]).filter((entry) => entry.key != null && groupEntryCount(entry) > 0);
}

function isVisibleGroupEntry(entry) {
  return entry && entry.key != null && entry.key !== '' && groupEntryCount(entry) > 0;
}

function countVisibleGroupRows(groupResult) {
  if (groupResult && !Array.isArray(groupResult) && typeof groupResult.total === 'number') {
    return groupResult.total;
  }

  let count = 0;
  for (const entry of groupEntries(groupResult)) {
    if (isVisibleGroupEntry(entry)) {
      count += 1;
    }
  }
  return count;
}

function sortedGroupRows(groupResult, options) {
  const max = options && options.limit ? options.limit : Infinity;
  const sort = options && options.sort ? options.sort : 'desc';
  const entries = groupEntries(groupResult);
  if (!Array.isArray(groupResult) && groupResult && groupResult.sort === sort && groupResult.offset === 0) {
    return entries.slice(0, max);
  }
  const filtered = entries.filter(isVisibleGroupEntry);
  filtered.sort((left, right) => {
    const diff = groupEntryCount(left) - groupEntryCount(right);
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
  const totalCount = metricCountValue(snapshot.kpis);
  const rowCount = typeof snapshot.rowCount === 'number' ? snapshot.rowCount : null;
  const timeRange = Array.isArray(state.filters[FIELDS.time]) ? state.filters[FIELDS.time] : state.baseTimeBounds;

  setKpiCard(dom.kpiTotal, formatNumber(totalCount), 'Total Count');
  setKpiCard(dom.kpiLocations, formatNumber(regions), 'Visible Regions');
  setKpiCard(dom.kpiRows, formatNumber(rowCount), 'Row Numbers');
  setKpiCard(dom.kpiTimespan, timeRange ? currentTimeRangeLabel() : '—', 'Time Window');
}

function ensureChart(existing, element, initialize) {
  if (existing) {
    return existing;
  }
  registerDemoEChartsTheme(echarts);
  const chart = echarts.init(element, getDemoEChartsThemeName(), {
    renderer: 'canvas',
    useDirtyRect: true,
  });
  if (initialize) {
    initialize(chart);
  }
  return chart;
}

const CHART_COLOR_ACTIVE = '#163f73';
const CHART_COLOR_BASE = '#0b7285';
const CHART_COLOR_SOFT = '#d96f32';
const CHART_COLOR_GRID = 'rgba(22, 47, 67, 0.08)';
const CHART_COLOR_SUBTLE = 'rgba(22, 47, 67, 0.14)';

function syncHorizontalBarChartHeight(element, chart, itemCount) {
  const height = resolveHorizontalBarChartHeight(itemCount);
  const nextHeight = `${height}px`;

  if (element.style.height === nextHeight) {
    return;
  }

  element.style.height = nextHeight;
  if (chart && typeof chart.resize === 'function') {
    chart.resize();
  }
}

function formatHorizontalBarTooltip(params) {
  const point = Array.isArray(params) ? params[0] : params;
  if (!point) {
    return '';
  }

  const row = point.data || point.value || {};
  const value = typeof row === 'object' && row && row.count != null
    ? row.count
    : (typeof point.value === 'object' && point.value && point.value.value != null ? point.value.value : point.value);
  const label = typeof row === 'object' && row && row.fullName != null ? row.fullName : point.name;
  return `${label}<br><strong>${formatNumber(value)} count</strong>`;
}

function initHorizontalBarChart(chart) {
  chart.setOption({
    animation: true,
    animationDuration: 320,
    animationDurationUpdate: 260,
    animationEasingUpdate: 'cubicOut',
    grid: {
      left: HORIZONTAL_BAR_AXIS_LABEL_WIDTH + 18,
      right: 60,
      top: 18,
      bottom: 24,
    },
    tooltip: {
      trigger: 'item',
      confine: true,
      formatter: formatHorizontalBarTooltip,
    },
    xAxis: {
      type: 'value',
      minInterval: 1,
      axisLine: {
        show: false,
      },
      axisTick: {
        show: false,
      },
      splitLine: {
        lineStyle: {
          color: CHART_COLOR_GRID,
        },
      },
      axisLabel: {
        formatter: formatCompactNumber,
        margin: 10,
      },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: [],
      axisLine: {
        show: false,
      },
      axisTick: {
        show: false,
      },
      axisLabel: {
        width: HORIZONTAL_BAR_AXIS_LABEL_WIDTH,
        interval: 0,
        margin: 12,
        lineHeight: 16,
        color: '#17314d',
        fontSize: 11,
      },
    },
    series: [{
      type: 'bar',
      data: [],
      barMaxWidth: 24,
      barMinHeight: 8,
      barCategoryGap: '34%',
      showBackground: true,
      backgroundStyle: {
        color: 'rgba(22, 47, 67, 0.04)',
        borderRadius: [0, 8, 8, 0],
      },
      itemStyle: { borderRadius: [0, 8, 8, 0] },
      emphasis: {
        focus: 'self',
        itemStyle: {
          shadowBlur: 14,
          shadowColor: 'rgba(11, 114, 133, 0.18)',
        },
      },
      label: {
        show: true,
        position: 'right',
        distance: 10,
        align: 'left',
        color: '#17314d',
        fontFamily: 'IBM Plex Sans, sans-serif',
        fontSize: 10,
        fontWeight: 600,
        formatter: (params) => formatCompactNumber(params.data && params.data.count),
      },
      universalTransition: true,
    }],
  });
}

function initTimelineChart(chart) {
  chart.setOption({
    animation: true,
    animationDuration: 380,
    animationDurationUpdate: 260,
    animationEasingUpdate: 'quarticOut',
    grid: { left: 26, right: 24, top: 22, bottom: 54, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      valueFormatter: (value) => formatNumber(value),
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: [],
      axisLabel: {
        rotate: 32,
        hideOverlap: true,
      },
      axisPointer: {
        snap: true,
      },
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: {
        lineStyle: {
          color: CHART_COLOR_GRID,
        },
      },
      axisLabel: {
        formatter: formatCompactNumber,
      },
    },
    dataZoom: [{
      type: 'inside',
      filterMode: 'none',
      moveOnMouseMove: true,
      zoomOnMouseWheel: true,
    }, {
      type: 'slider',
      height: 14,
      bottom: 6,
      brushSelect: false,
      fillerColor: 'rgba(11, 114, 133, 0.12)',
      borderColor: 'transparent',
      backgroundColor: 'rgba(22, 47, 67, 0.06)',
      handleStyle: {
        color: '#ffffff',
        borderColor: CHART_COLOR_SOFT,
      },
      moveHandleStyle: {
        color: CHART_COLOR_SOFT,
      },
    }],
    series: [{
      type: 'line',
      data: [],
      smooth: 0.24,
      symbol: 'circle',
      symbolSize: 6,
      sampling: 'lttb',
      lineStyle: {
        color: CHART_COLOR_SOFT,
        width: 3,
      },
      itemStyle: {
        color: '#ffffff',
        borderColor: CHART_COLOR_SOFT,
        borderWidth: 2,
      },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(217, 111, 50, 0.28)' },
          { offset: 1, color: 'rgba(217, 111, 50, 0.02)' },
        ]),
      },
      emphasis: {
        focus: 'series',
      },
      universalTransition: true,
    }],
  });
}

function ensureChartClickHandler(chart, marker, handler) {
  if (!chart || chart[marker]) {
    return;
  }
  chart[marker] = true;
  chart.on('click', handler);
}

function createRankedSeriesData(entries, activeValues) {
  const activeSet = new Set(activeValues || []);

  return entries.map((entry) => ({
    active: activeSet.has(entry.key),
    count: groupEntryCount(entry),
    fullName: String(entry.key),
    key: entry.key,
    name: truncateHorizontalBarLabel(entry.key),
    value: groupEntryCount(entry),
    itemStyle: {
      color: activeSet.has(entry.key) ? CHART_COLOR_ACTIVE : CHART_COLOR_BASE,
    },
  }));
}

function renderRankedChart(chartKey, element, entries, filterField, activeValues, badgeEl, options) {
  const data = sortedGroupRows(entries, options);
  const seriesData = createRankedSeriesData(data, activeValues);

  syncHorizontalBarChartHeight(element, state.charts[chartKey], data.length);
  state.charts[chartKey] = ensureChart(state.charts[chartKey], element, initHorizontalBarChart);
  state.charts[chartKey].setOption({
    yAxis: {
      data: seriesData.map((entry) => entry.name),
    },
    series: [{
      data: seriesData,
      label: {
        formatter: (params) => formatCompactNumber(params.data && params.data.count),
      },
    }],
  });

  badgeEl.textContent = `${countVisibleGroupRows(entries)}`;

  ensureChartClickHandler(state.charts[chartKey], `__filter_${filterField}`, (params) => {
    if (!params || !params.data || params.data.key == null) {
      return;
    }
    toggleArrayFilterValue(filterField, params.data.key);
    scheduleRefresh(true);
  });
}

function renderTimelineChart(snapshot) {
  const entries = getTimeGroupEntries(snapshot).slice().sort((left, right) => Number(left.key) - Number(right.key));
  state.charts.timeline = ensureChart(state.charts.timeline, dom.chartTimeline, initTimelineChart);
  state.charts.timeline.setOption({
    xAxis: {
      data: entries.map((entry) => formatTimestamp(entry.key, state.timeGranularity)),
    },
    series: [{
      data: entries.map((entry) => ({
        count: groupEntryCount(entry),
        key: entry.key,
        name: formatTimestamp(entry.key, state.timeGranularity),
        value: groupEntryCount(entry),
      })),
    }],
  });
  var granLabel = getGranularityMeta(state.timeGranularity).label;
  var badgeText = state.serverGranularity
    ? granLabel + ' (server) • ' + entries.length
    : granLabel + ' • ' + entries.length;
  dom.timeGranularityBadge.textContent = badgeText;
}

function updateGroupBadges(snapshot) {
  dom.ccGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.customerCountries])}`;
  dom.regionGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.regions])}`;
  dom.divisionGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.divisions])}`;
  dom.muniGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.municipalities])}`;
  dom.locGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.localities])}`;
  dom.postalGroupSize.textContent = `${countVisibleGroupRows(snapshot.groups[GROUP_IDS.postalCodes])}`;
}

function renderCharts(snapshot) {
  renderRankedChart('event', dom.chartEvent, snapshot.groups[GROUP_IDS.events], FIELDS.event, state.filters[FIELDS.event] || [], dom.eventGroupSize, { limit: 10, sort: 'desc' });
  renderTimelineChart(snapshot);
  renderRankedChart('customerCountry', dom.chartCustomerCountry, snapshot.groups[GROUP_IDS.customerCountries], FIELDS.customer_country, state.filters[FIELDS.customer_country] || [], dom.ccGroupSize, { limit: 12, sort: 'desc' });
  renderRankedChart('region', dom.chartRegion, snapshot.groups[GROUP_IDS.regions], FIELDS.region, state.filters[FIELDS.region] || [], dom.regionGroupSize, { limit: 8, sort: 'desc' });
  renderRankedChart('division', dom.chartDivision, snapshot.groups[GROUP_IDS.divisions], FIELDS.division, state.filters[FIELDS.division] || [], dom.divisionGroupSize, { limit: 8, sort: 'desc' });
  renderRankedChart('municipality', dom.chartMunicipality, snapshot.groups[GROUP_IDS.municipalities], FIELDS.municipality, state.filters[FIELDS.municipality] || [], dom.muniGroupSize, { limit: 12, sort: 'desc' });
  renderRankedChart('locality', dom.chartLocality, snapshot.groups[GROUP_IDS.localities], FIELDS.locality, state.filters[FIELDS.locality] || [], dom.locGroupSize, { limit: 12, sort: state.localitySort === 'least' ? 'asc' : 'desc' });
  renderRankedChart('postal', dom.chartPostal, snapshot.groups[GROUP_IDS.postalCodes], FIELDS.postal_code, state.filters[FIELDS.postal_code] || [], dom.postalGroupSize, { limit: 12, sort: 'desc' });
  updateGroupBadges(snapshot);
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

function updateDataSourceUi() {
  const showLatitude = supportsLatitudeFeatures();
  if (dom.latitudeFilterGroup) {
    dom.latitudeFilterGroup.hidden = !showLatitude;
  }
}

function renderPickerOptions(container, searchInput, filterField, entries) {
  const search = (searchInput.value || '').trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  const selectedValues = new Set(state.filters[filterField] || []);
  const data = sortedGroupRows(entries, { limit: Infinity, sort: 'desc' }).filter((entry) => String(entry.key).toLowerCase().includes(search));

  for (const entry of data) {
    const option = document.createElement('label');
    option.className = 'picker-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedValues.has(entry.key);
    checkbox.dataset.filterField = filterField;
    checkbox.dataset.filterValue = String(entry.key);

    const text = document.createElement('span');
    text.textContent = `${entry.key} (${formatNumber(groupEntryCount(entry))})`;

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
  const selectedValues = new Set(state.filters[FIELDS.region] || []);
  const data = sortedGroupRows(entries, { limit: Infinity, sort: 'desc' }).filter((entry) => String(entry.key).toLowerCase().includes(search));

  for (const entry of data) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedValues.has(entry.key);
    checkbox.dataset.filterField = FIELDS.region;
    checkbox.dataset.filterValue = String(entry.key);
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(` ${entry.key} (${formatNumber(groupEntryCount(entry))})`));
    fragment.appendChild(label);
  }

  dom.regionCheckboxes.replaceChildren(fragment);
}

function isPickerQueryActive(dropdown, searchInput) {
  return !dropdown.hidden || !!(searchInput.value || '').trim();
}

function buildControlGroupRequestKey(groupId, request) {
  return JSON.stringify({
    filters: buildDashboardFilters(),
    groupId,
    request,
  });
}

function renderControlGroupResult(groupId) {
  if (groupId === GROUP_IDS.customerCountries) {
    renderPickerOptions(dom.customerCountryOptions, dom.customerCountrySearch, FIELDS.customer_country, state.controlGroups[groupId]);
  } else if (groupId === GROUP_IDS.regions) {
    renderRegionOptions(state.controlGroups[groupId]);
  }
}

async function flushPendingGroupRefreshes() {
  state.pendingGroupFlushTimer = 0;
  const pending = new Map(state.pendingGroupRefreshes);
  state.pendingGroupRefreshes.clear();

  if (!pending.size || !state.runtime || !state.ready) return;

  const groupsRequest = {};
  const requestKeys = {};
  const tokens = {};

  for (const [groupId, entry] of pending) {
    const cached = state.groupQueryCache[groupId];
    if (cached && cached.key === entry.requestKey) {
      state.controlGroups[groupId] = cached.value;
      renderControlGroupResult(groupId);
      continue;
    }
    if (state.groupQueryInflight[groupId] === entry.requestKey) continue;

    const token = (state.groupQueryTokens[groupId] || 0) + 1;
    state.groupQueryTokens[groupId] = token;
    state.groupQueryInflight[groupId] = entry.requestKey;
    tokens[groupId] = token;
    requestKeys[groupId] = entry.requestKey;
    groupsRequest[groupId] = entry.query;
  }

  if (!Object.keys(groupsRequest).length) return;

  try {
    const groups = await state.runtime.groups({ groups: groupsRequest });
    for (const groupId in groupsRequest) {
      if (state.groupQueryTokens[groupId] !== tokens[groupId]) continue;
      state.controlGroups[groupId] = groups[groupId] || null;
      state.groupQueryCache[groupId] = { key: requestKeys[groupId], value: state.controlGroups[groupId] };
      state.groupQueryInflight[groupId] = null;
      renderControlGroupResult(groupId);
    }
  } catch (error) {
    for (const groupId in groupsRequest) {
      if (state.groupQueryInflight[groupId] === requestKeys[groupId]) {
        state.groupQueryInflight[groupId] = null;
      }
    }
    if (state.runtime) {
      appendLog(`Batched control query failed: ${error.message || error}`);
    }
  }
}

function refreshControlGroup(groupId) {
  if (!state.runtime || !state.ready || typeof state.runtime.groups !== 'function') return;

  const search = groupId === GROUP_IDS.customerCountries
    ? dom.customerCountrySearch.value
    : dom.regionSearch.value;
  const query = buildOptionGroupQuery(groupId, search);
  const requestKey = buildControlGroupRequestKey(groupId, query);

  state.pendingGroupRefreshes.set(groupId, { query, requestKey });

  if (!state.pendingGroupFlushTimer) {
    state.pendingGroupFlushTimer = setTimeout(flushPendingGroupRefreshes, 0);
  }
}

function scheduleControlGroupRefresh(groupId, delayMs) {
  if (state.groupQueryTimers[groupId]) {
    clearTimeout(state.groupQueryTimers[groupId]);
  }
  state.groupQueryTimers[groupId] = setTimeout(() => {
    state.groupQueryTimers[groupId] = 0;
    refreshControlGroup(groupId);
  }, delayMs || 0);
}

function renderFilterControls(snapshot) {
  const regionSearchActive = !!(dom.regionSearch.value || '').trim();

  renderSelectedPills(dom.customerCountryPills, dom.customerCountryTrigger, FIELDS.customer_country, 'Select countries...');
  dom.customerCountryCount.textContent = `${(state.filters[FIELDS.customer_country] || []).length} selected`;
  if (isPickerQueryActive(dom.customerCountryDropdown, dom.customerCountrySearch)) {
    renderPickerOptions(
      dom.customerCountryOptions,
      dom.customerCountrySearch,
      FIELDS.customer_country,
      state.controlGroups[GROUP_IDS.customerCountries] || snapshot.groups[GROUP_IDS.customerCountries]
    );
    scheduleControlGroupRefresh(GROUP_IDS.customerCountries, 80);
  } else {
    dom.customerCountryOptions.replaceChildren();
  }

  if (!regionSearchActive) {
    state.controlGroups[GROUP_IDS.regions] = null;
  }
  renderRegionOptions(state.controlGroups[GROUP_IDS.regions] || snapshot.groups[GROUP_IDS.regions]);
  dom.regionCount.textContent = `${(state.filters[FIELDS.region] || []).length} selected`;
  if (regionSearchActive) {
    scheduleControlGroupRefresh(GROUP_IDS.regions, 80);
  }

  const eventFragment = document.createDocumentFragment();
  sortedGroupRows(snapshot.groups[GROUP_IDS.events], { limit: 20, sort: 'desc' }).forEach((entry) => {
    const button = document.createElement('button');
    button.className = 'pill';
    button.type = 'button';
    button.dataset.filterField = FIELDS.event;
    button.dataset.filterValue = String(entry.key);
    button.textContent = `${entry.key} (${formatNumber(groupEntryCount(entry))})`;
    button.classList.toggle('pill--active', (state.filters[FIELDS.event] || []).includes(entry.key));
    eventFragment.appendChild(button);
  });
  dom.eventPills.replaceChildren(eventFragment);

  syncTimeControls();
  if (supportsLatitudeFeatures()) {
    syncLatitudeControls();
  } else {
    state.filters[FIELDS.latitude] = null;
  }

  dom.clearButtons.forEach((button) => {
    const clearKey = button.dataset.clear;
    const field = clearKey && FIELDS[clearKey];
    button.hidden = !field || !hasActiveFilter(field);
  });
}

function updateTableRowCount() {
  dom.tableRowCount.textContent = state.currentSnapshot
    ? `${formatNumber(state.currentLoadedCount)} of ${formatNumber(metricCountValue(state.currentSnapshot.kpis))} count loaded`
    : '—';
}

function formatTableCellValue(field, value) {
  if (field === FIELDS.time) {
    return formatTimestamp(value, state.timeGranularity);
  }
  if (field === FIELDS.latitude) {
    return formatFloat(value, 4);
  }
  return value == null ? '—' : String(value);
}

function createTableRow(row) {
  const tr = document.createElement('tr');
  for (const field of getActiveTableFields()) {
    const td = document.createElement('td');
    td.textContent = formatTableCellValue(field, row[field]);
    tr.appendChild(td);
  }
  return tr;
}

function createTableRowFromColumns(columns, rowIndex) {
  const tr = document.createElement('tr');
  for (const field of getActiveTableFields()) {
    const td = document.createElement('td');
    const column = columns[field];
    td.textContent = formatTableCellValue(field, column ? column[rowIndex] : undefined);
    tr.appendChild(td);
  }
  return tr;
}

function appendTableRows(rows) {
  if (!rows || !rows.length) {
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    fragment.appendChild(createTableRow(row));
  }
  dom.tableBody.appendChild(fragment);
}

function rowCountFromResult(result) {
  if (isColumnarRowResult(result)) {
    return result.length;
  }
  return Array.isArray(result) ? result.length : 0;
}

function countSumFromResult(result) {
  let total = 0;
  if (isColumnarRowResult(result)) {
    const column = result.columns && result.columns[FIELDS.count];
    if (!column) {
      return 0;
    }
    for (let rowIndex = 0; rowIndex < result.length; ++rowIndex) {
      total += normalizeCountValue(column[rowIndex]);
    }
    return total;
  }

  if (!Array.isArray(result)) {
    return 0;
  }

  for (const row of result) {
    total += normalizeCountValue(row && row[FIELDS.count]);
  }
  return total;
}

function appendTableResult(result) {
  if (!result) {
    return;
  }
  if (!isColumnarRowResult(result)) {
    appendTableRows(Array.isArray(result) ? result : []);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (let rowIndex = 0; rowIndex < result.length; ++rowIndex) {
    fragment.appendChild(createTableRowFromColumns(result.columns || {}, rowIndex));
  }
  dom.tableBody.appendChild(fragment);
}

function isColumnarRowResult(result) {
  return !!(result && typeof result === 'object' && !Array.isArray(result) && result.columns && typeof result.length === 'number');
}

function rowsFromColumnarResult(result) {
  if (!isColumnarRowResult(result)) {
    return Array.isArray(result) ? result : [];
  }

  const fields = Array.isArray(result.fields) ? result.fields : Object.keys(result.columns || {});
  const rows = new Array(result.length);
  for (let rowIndex = 0; rowIndex < result.length; ++rowIndex) {
    const row = {};
    for (const field of fields) {
      const column = result.columns[field];
      row[field] = column ? column[rowIndex] : undefined;
    }
    rows[rowIndex] = row;
  }
  return rows;
}

function renderTable() {
  updateTableRowCount();
}

function renderTableHeader() {
  const fragment = document.createDocumentFragment();
  for (const field of getActiveTableFields()) {
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
    dom.addRowsBtn.disabled = !state.ready;
  }
  if (dom.burstAppendBtn) {
    dom.burstAppendBtn.disabled = !state.ready;
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
  if (state.filterControlsRafId) {
    cancelAnimationFrame(state.filterControlsRafId);
    state.filterControlsRafId = 0;
  }
  if (!options || !options.skipControls) {
    if (options && options.deferControls) {
      state.filterControlsRafId = requestAnimationFrame(() => {
        state.filterControlsRafId = 0;
        if (snapshot !== state.currentSnapshot) {
          return;
        }
        renderFilterControls(snapshot);
        renderFilterChips();
      });
    } else {
      renderFilterControls(snapshot);
      renderFilterChips();
    }
  }
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
  if (state.filterControlsRafId) {
    cancelAnimationFrame(state.filterControlsRafId);
    state.filterControlsRafId = 0;
  }
  Object.keys(state.groupQueryTimers).forEach((groupId) => {
    clearTimeout(state.groupQueryTimers[groupId]);
    state.groupQueryTimers[groupId] = 0;
  });
  state.controlGroups = {};
  state.groupQueryCache = {};
  state.groupQueryInflight = {};

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
  state.groupQueryCache = {};
  state.groupQueryInflight = {};
  state.groupQueryTokens = {};
  updateDemoButtons();
}

async function readBaseTimeBounds(runtime, filters) {
  const readBounds = async () => {
    const boundsResult = typeof runtime.bounds === 'function'
      ? await runtime.bounds({ fields: [FIELDS.time] })
      : (await runtime.query({
          bounds: { fields: [FIELDS.time] },
          snapshot: false,
        })).bounds;
    const timeBounds = boundsResult ? boundsResult[FIELDS.time] : null;
    const max = timeBounds ? Number(timeBounds.max) : null;
    const min = timeBounds ? Number(timeBounds.min) : null;
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
  const fields = getActiveTableQueryFields();
  return withTemporaryFilters(runtime, {}, async () => {
    const rowSets = typeof runtime.rowSets === 'function'
      ? await runtime.rowSets({
          latest: { columnar: true, fields, limit: 500, sortBy: FIELDS.time },
          oldest: { columnar: true, direction: 'bottom', fields, limit: 500, sortBy: FIELDS.time },
        })
      : (await runtime.query({
          rowSets: {
            latest: { columnar: true, fields, limit: 500, sortBy: FIELDS.time },
            oldest: { columnar: true, direction: 'bottom', fields, limit: 500, sortBy: FIELDS.time },
          },
          snapshot: false,
        })).rowSets;
    return rowsFromColumnarResult(rowSets.latest).concat(rowsFromColumnarResult(rowSets.oldest));
  });
}

function generateSyntheticRows(count) {
  const sourceRows = state.seedRows;
  const fields = getActiveTableQueryFields();
  if (!sourceRows.length) {
    return [];
  }

  const rows = [];
  for (let index = 0; index < count; ++index) {
    const source = sourceRows[Math.floor(Math.random() * sourceRows.length)];
    const row = {};

    for (const field of fields) {
      row[field] = source[field];
    }
    row[FIELDS.count] = 1;

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

function describeActiveFilterPaths() {
  const filters = buildDashboardFilters();
  const activeFields = Object.keys(filters);
  if (!activeFields.length) {
    return 'no active filters';
  }
  const descriptions = activeFields.map(function (field) {
    var filter = filters[field];
    if (filter.type === 'range') return fieldLabel(field) + ' range';
    if (filter.type === 'in') return fieldLabel(field) + ' in(' + filter.values.length + ')';
    return fieldLabel(field) + ' ' + filter.type;
  });
  return descriptions.join(', ');
}

async function ensureSeedRows() {
  if (state.seedRows.length) {
    return true;
  }
  hideError();
  setLoading(true, 'Loading seed rows for synthetic append...');
  try {
    state.seedRows = await loadSeedRows(state.runtime);
  } catch (error) {
    setLoading(false);
    showError(error.message || String(error));
    appendLog(`Seed row load failed: ${error.message || error}`);
    return false;
  }
  setLoading(false);
  return true;
}

async function onAddRows() {
  if (!(await ensureSeedRows())) return;

  const rows = generateSyntheticRows(1000);
  if (!rows.length) {
    appendLog('Add 1000 rows skipped: no seed rows are available yet.');
    return;
  }

  const filterDesc = describeActiveFilterPaths();
  appendLog(`Appending 1,000 rows (${filterDesc})`);
  await runRuntimeMutation('Add 1000 rows', 'Appending 1,000 synthetic rows...', () => state.runtime.append(rows));
}

async function onBurstAppend() {
  if (!state.runtime || !state.ready) return;
  if (!(await ensureSeedRows())) return;

  const batchCount = 10;
  const batchSize = 1000;
  const filterDesc = describeActiveFilterPaths();
  const hasActiveFilters = Object.keys(buildDashboardFilters()).length > 0;
  appendLog(`Burst append: ${batchCount} x ${formatNumber(batchSize)} rows (${filterDesc})`);
  if (hasActiveFilters) {
    appendLog('  groupAll skips full rebuild, filterRange codes cached, selected buffer reused');
  } else {
    appendLog('  groupAll skips full rebuild (no active filters — try filtering first for full optimization demo)');
  }

  hideError();
  setLoading(true, `Burst appending ${batchCount} batches of ${formatNumber(batchSize)} rows...`);
  const totalStart = performance.now();
  var batchTimes = [];

  try {
    for (var batch = 0; batch < batchCount; ++batch) {
      var rows = generateSyntheticRows(batchSize);
      if (!rows.length) break;
      var batchStart = performance.now();
      await state.runtime.append(rows);
      batchTimes.push(performance.now() - batchStart);
    }

    var totalMs = performance.now() - totalStart;
    var avgMs = batchTimes.reduce(function (sum, t) { return sum + t; }, 0) / batchTimes.length;
    var minMs = Math.min.apply(null, batchTimes);
    var maxMs = Math.max.apply(null, batchTimes);
    appendLog(`Burst complete: ${totalMs.toFixed(1)} ms total, ${avgMs.toFixed(1)} ms avg/batch (min ${minMs.toFixed(1)}, max ${maxMs.toFixed(1)})`);
    appendLog(`  ${formatNumber(batchCount * batchSize)} rows appended in ${batchTimes.length} batches`);

    state.baseTimeBounds = await readBaseTimeBounds(state.runtime, {});
    await refreshView(true);
  } catch (error) {
    showError(error.message || String(error));
    appendLog(`Burst append failed at batch ${batchTimes.length + 1}: ${error.message || error}`);
  } finally {
    setLoading(false);
  }
}

async function onRemoveFiltered() {
  if (Object.keys(buildDashboardFilters()).length === 0) {
    appendLog('Remove excluded skipped: no active filters.');
    return;
  }

  const filterDesc = describeActiveFilterPaths();
  appendLog(`Removing excluded rows (${filterDesc})`);
  appendLog('  codeCounts will be rebuilt after compaction for correct re-filter');
  await runRuntimeMutation('Remove excluded rows', 'Removing excluded rows...', () => state.runtime.removeFiltered('excluded'));
}

async function refreshRows(replace) {
  if (!state.runtime || !state.ready) {
    return null;
  }

  const fields = getActiveTableQueryFields();
  state.tableLoading = true;
  const rowsResult = await state.runtime.rows({
    columnar: true,
    direction: state.tableSort === 'bottom' ? 'bottom' : 'top',
    fields,
    limit: TABLE_PAGE_SIZE,
    offset: replace ? 0 : state.tableOffset,
    sortBy: FIELDS.time,
  });
  const rowCount = rowCountFromResult(rowsResult);
  const countTotal = countSumFromResult(rowsResult);

  if (replace) {
    state.currentLoadedCount = countTotal;
    state.currentRowCount = rowCount;
    state.tableOffset = rowCount;
  } else {
    state.currentLoadedCount += countTotal;
    state.currentRowCount += rowCount;
    state.tableOffset += rowCount;
  }
  state.tableHasMore = rowCount === TABLE_PAGE_SIZE;
  state.tableLoading = false;
  return rowsResult;
}

async function refreshView(resetTable) {
  try {
    if (!state.runtime || !state.ready) {
      return;
    }

    const fields = getActiveTableQueryFields();
    const requestId = ++state.latestRequestId;
    const filters = buildDashboardFilters();
    const startedAt = performance.now();
    state.tableLoading = true;
    if (resetTable) {
      state.currentLoadedCount = 0;
      state.currentRowCount = 0;
      state.tableOffset = 0;
      dom.tableScroll.scrollTop = 0;
    }

    const result = await state.runtime.query({
      filters,
      rowCount: true,
      snapshot: {
        groups: buildSnapshotGroupQueries(),
      },
      rows: {
        columnar: true,
        direction: state.tableSort === 'bottom' ? 'bottom' : 'top',
        fields,
        limit: TABLE_PAGE_SIZE,
        offset: resetTable ? 0 : state.tableOffset,
        sortBy: FIELDS.time,
      },
    });
    if (requestId !== state.latestRequestId) {
      return;
    }

    if (result.snapshot) {
      result.snapshot.rowCount = result.rowCount;
    }

    const rowCount = rowCountFromResult(result.rows);
    const countTotal = countSumFromResult(result.rows);
    if (resetTable) {
      state.currentRowCount = 0;
      state.tableOffset = rowCount;
      dom.tableBody.replaceChildren();
    } else {
      state.tableOffset += rowCount;
    }
    state.controlGroups = {};
    appendTableResult(result.rows);
    state.currentLoadedCount += countTotal;
    state.currentRowCount += rowCount;
    state.tableHasMore = rowCount === TABLE_PAGE_SIZE;
    state.tableLoading = false;

    state.lastInteractionMs = performance.now() - startedAt;
    dom.latencyDisplay.textContent = `${state.lastInteractionMs.toFixed(1)} ms`;
    renderSnapshot(result.snapshot, { deferControls: true, skipTable: true });
    updateTableRowCount();
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
    renderSnapshot(snapshot, { skipControls: true, skipTable: true });
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
  const fields = getActiveTableQueryFields();
  const loadToken = ++state.loadToken;
  hideError();
  updateDataSourceUi();
  state.currentSnapshot = null;
  state.controlGroups = {};
  state.currentLoadedCount = 0;
  state.currentRowCount = 0;
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
  renderTableHeader();
  dom.tableBody.replaceChildren();
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
  if (state.dataSource === 'live') {
    state.liveApiAvailable = true;
    writeSessionLiveUnavailable(false);
  }
  updateProgressBadge(readyPayload);
  dom.loadTime.textContent = `Load: ${(performance.now() - loadStartedAt).toFixed(0)} ms`;
  appendLog(`Worker ready in ${(performance.now() - loadStartedAt).toFixed(1)} ms`);
  appendLog(`Stream loaded ${formatNumber(readyPayload.load.rowsLoaded)} rows in ${formatNumber(readyPayload.load.batchesLoaded)} batches (${readyPayload.runtime && readyPayload.runtime.active === 'wasm' ? 'WASM' : 'JS'} worker)`);
  if (state.dataSource === 'live') {
    appendArrowMetadataLog(readyPayload);
  }

  state.tableLoading = true;
  const [baseTimeBounds, initialResult] = await Promise.all([
    readBaseTimeBounds(runtime, {}),
    runtime.query({
      filters: buildDashboardFilters(),
      rowCount: true,
      snapshot: {
        groups: buildSnapshotGroupQueries(),
      },
      rows: {
        columnar: true,
        direction: state.tableSort === 'bottom' ? 'bottom' : 'top',
        fields,
        limit: TABLE_PAGE_SIZE,
        offset: 0,
        sortBy: FIELDS.time,
      },
    }),
  ]);
  state.baseTimeBounds = baseTimeBounds;
  if (initialResult.snapshot) {
    initialResult.snapshot.rowCount = initialResult.rowCount;
  }
  state.currentLoadedCount = countSumFromResult(initialResult.rows);
  state.currentRowCount = rowCountFromResult(initialResult.rows);
  state.tableOffset = state.currentRowCount;
  state.tableHasMore = state.currentRowCount === TABLE_PAGE_SIZE;
  state.tableLoading = false;
  appendTableResult(initialResult.rows);
  syncTimeControls();
  updateDemoButtons();
  setLoading(false);
  renderSnapshot(initialResult.snapshot, { deferControls: true, skipTable: true });
  updateTableRowCount();
}

async function handleLoadFailure(error, label) {
  const message = error && error.message ? error.message : String(error);

  if (state.dataSource === 'live' && shouldFallbackToLocalFromLiveErrorMessage(message)) {
    state.liveApiAvailable = false;
    writeSessionLiveUnavailable(true);
    state.dataSource = 'file';
    state.filters[FIELDS.latitude] = null;
    renderSourceButtons();
    updateDataSourceUi();
    renderTableHeader();
    persistDemoPreferences();
    appendLog('Live API unavailable on this server. Falling back to the bundled Arrow file.');

    try {
      await loadSource();
      return;
    } catch (fallbackError) {
      const fallbackMessage = fallbackError && fallbackError.message ? fallbackError.message : String(fallbackError);
      showError(fallbackMessage);
      appendLog(`Fallback load failed: ${fallbackMessage}`);
      setLoading(false);
      return;
    }
  }

  showError(message);
  appendLog(`${label}: ${message}`);
  setLoading(false);
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
      if (nextSource === 'live') {
        state.liveApiAvailable = null;
        writeSessionLiveUnavailable(false);
      } else {
        state.filters[FIELDS.latitude] = null;
      }
      state.filters = createEmptyFilterState();
      renderSourceButtons();
      updateDataSourceUi();
      renderTableHeader();
      persistDemoPreferences();
      loadSource().catch((error) => handleLoadFailure(error, 'Load failed'));
    });
  });

  dom.tableSortToggle.addEventListener('click', () => {
    state.tableSort = state.tableSort === 'top' ? 'bottom' : 'top';
    dom.tableSortToggle.textContent = state.tableSort === 'top' ? 'Showing: Most Recent' : 'Showing: Oldest';
    persistDemoPreferences();
    scheduleRefresh(true);
  });

  dom.localitySortToggle.addEventListener('click', () => {
    state.localitySort = state.localitySort === 'least' ? 'most' : 'least';
    persistDemoPreferences();
    scheduleRefresh(true);
  });

  dom.clearAllBtn.addEventListener('click', clearAllFilters);
  if (dom.addRowsBtn) {
    dom.addRowsBtn.addEventListener('click', () => {
      onAddRows();
    });
  }
  if (dom.burstAppendBtn) {
    dom.burstAppendBtn.addEventListener('click', () => {
      onBurstAppend();
    });
  }
  if (dom.removeFilteredBtn) {
    dom.removeFilteredBtn.addEventListener('click', () => {
      onRemoveFiltered();
    });
  }
  dom.timeMin.addEventListener('change', applyTimeRangeFromControls);
  dom.timeMax.addEventListener('change', applyTimeRangeFromControls);
  dom.latMin.addEventListener('change', () => {
    if (supportsLatitudeFeatures()) {
      applyLatitudeRangeFromControls();
    }
  });
  dom.latMax.addEventListener('change', () => {
    if (supportsLatitudeFeatures()) {
      applyLatitudeRangeFromControls();
    }
  });
  dom.regionSearch.addEventListener('input', () => {
    if (!(dom.regionSearch.value || '').trim()) {
      state.controlGroups[GROUP_IDS.regions] = null;
      if (state.currentSnapshot) {
        renderRegionOptions(state.currentSnapshot.groups[GROUP_IDS.regions]);
      }
      return;
    }
    if (state.currentSnapshot && (!state.runtime || typeof state.runtime.groups !== 'function')) {
      renderRegionOptions(state.currentSnapshot.groups[GROUP_IDS.regions]);
      return;
    }
    scheduleControlGroupRefresh(GROUP_IDS.regions, 80);
  });
  dom.customerCountrySearch.addEventListener('input', () => {
    if (!(dom.customerCountrySearch.value || '').trim()) {
      state.controlGroups[GROUP_IDS.customerCountries] = null;
      if (state.currentSnapshot) {
        renderPickerOptions(dom.customerCountryOptions, dom.customerCountrySearch, FIELDS.customer_country, state.currentSnapshot.groups[GROUP_IDS.customerCountries]);
      }
    }
    if (state.currentSnapshot && (!state.runtime || typeof state.runtime.groups !== 'function')) {
      renderPickerOptions(dom.customerCountryOptions, dom.customerCountrySearch, FIELDS.customer_country, state.currentSnapshot.groups[GROUP_IDS.customerCountries]);
      return;
    }
    scheduleControlGroupRefresh(GROUP_IDS.customerCountries, 80);
  });

  dom.eventPills.addEventListener('click', (event) => {
    const button = event.target.closest('.pill[data-filter-field]');
    if (!button) {
      return;
    }
    toggleArrayFilterValue(button.dataset.filterField, button.dataset.filterValue);
    scheduleRefresh(true);
  });

  [dom.customerCountryOptions, dom.regionCheckboxes].forEach((container) => {
    container.addEventListener('change', (event) => {
      const input = event.target;
      if (!input || input.tagName !== 'INPUT' || !input.dataset.filterField) {
        return;
      }
      toggleArrayFilterValue(input.dataset.filterField, input.dataset.filterValue);
      scheduleRefresh(true);
    });
  });

  [dom.customerCountryPills].forEach((container) => {
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

  dom.customerCountryTrigger.addEventListener('click', () => {
    const willOpen = dom.customerCountryDropdown.hidden;
    togglePicker(dom.customerCountryDropdown, dom.customerCountryTrigger);
    if (willOpen) {
      if (state.currentSnapshot) {
        renderPickerOptions(dom.customerCountryOptions, dom.customerCountrySearch, FIELDS.customer_country, state.currentSnapshot.groups[GROUP_IDS.customerCountries]);
      }
      scheduleControlGroupRefresh(GROUP_IDS.customerCountries, 0);
    }
  });

  document.addEventListener('click', (event) => {
    if (!dom.customerCountryPicker.contains(event.target)) {
      closePicker(dom.customerCountryDropdown, dom.customerCountryTrigger);
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
    const rows = await refreshRows(false);
    appendTableResult(rows);
    updateTableRowCount();
  });

  dom.granularityButtons.forEach((button) => {
    button.addEventListener('click', () => {
      var nextGran = button.dataset.gran;
      if (nextGran === state.timeGranularity) {
        return;
      }
      state.timeGranularity = nextGran;
      persistDemoPreferences();
      if (state.dataSource === 'live' && nextGran !== state.serverGranularity) {
        loadSource().catch(function (error) {
          handleLoadFailure(error, 'Granularity reload failed');
        });
      } else if (state.currentSnapshot) {
        scheduleRefresh(true);
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
  if (dom.burstAppendBtn) {
    dom.burstAppendBtn.textContent = 'Burst Append 10k';
    dom.burstAppendBtn.title = 'Append 10 batches of 1,000 rows sequentially — exercises groupAll fast path, filterRange target cache, and buffer reuse';
  }
  if (dom.removeFilteredBtn) {
    dom.removeFilteredBtn.textContent = 'Remove Excluded';
    dom.removeFilteredBtn.title = 'Delete rows currently excluded by the active filters';
  }
  if (dom.headerSubtitle) {
    dom.headerSubtitle.textContent = 'Interactive Demo';
  }
  updateProgressBadge(null);
  setKpiCard(dom.kpiTotal, '—', 'Total Count');
  setKpiCard(dom.kpiLocations, '—', 'Visible Regions');
  setKpiCard(dom.kpiRows, '—', 'Row Numbers');
  setKpiCard(dom.kpiTimespan, '—', 'Time Window');
  updateDataSourceUi();
  renderTableHeader();
  renderLocalitySortState();
  renderGranularityButtons();
  dom.tableSortToggle.textContent = state.tableSort === 'top' ? 'Showing: Most Recent' : 'Showing: Oldest';
  renderSourceButtons();
  updateDemoButtons();
}

async function start() {
  cacheDom();
  await hydrateInitialDataSource();
  initStaticUi();
  attachControlListeners();
  if (state.dataSource === 'live') {
    appendLog(`Configured live proxy detected. Loading server-aggregated ${state.timeGranularity} Arrow data.`);
  } else {
    appendLog('Loading bundled Arrow data. Enable the configured live proxy to default to server-backed mode.');
  }
  loadSource().catch((error) => handleLoadFailure(error, 'Initial load failed'));
}

start();
