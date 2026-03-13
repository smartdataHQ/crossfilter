/* ============================================================
   Crossfilter2 Interactive Demo — Main Logic
   ============================================================ */

// ---------------------------------------------------------------------------
// 1. Globals & Constants
// ---------------------------------------------------------------------------
const ARROW_FILE = '../test/data/query-result.arrow';

const FIELDS = {
  event:            'semantic_events__event',
  customer_country: 'semantic_events__dimensions_customer_country',
  location_label:   'semantic_events__location_label',
  location_country: 'semantic_events__location_country',
  region:           'semantic_events__location_region',
  division:         'semantic_events__location_division',
  municipality:     'semantic_events__location_municipality',
  locality:         'semantic_events__location_locality',
  postal_code:      'semantic_events__location_postal_code',
  postal_name:      'semantic_events__location_postal_name',
  location_code:    'semantic_events__location_code',
  time:             'semantic_events__timestamp_minute',
  latitude:         'semantic_events__location_latitude',
};

const FIELD_LABELS = {
  event: 'Event',
  customer_country: 'Customer Country',
  location_label: 'Location',
  location_country: 'Location Country',
  region: 'Region',
  division: 'Division',
  municipality: 'Municipality',
  locality: 'Locality',
  postal_code: 'Postal Code',
  postal_name: 'Postal Name',
  location_code: 'Location Code',
  time: 'Time',
  latitude: 'Latitude',
};

const TABLE_COLUMNS = [
  'event', 'customer_country', 'location_country', 'region',
  'division', 'municipality', 'locality', 'location_label',
  'postal_code', 'postal_name', 'location_code', 'latitude', 'time',
];

const MODES = {
  row_baseline: {
    id: 'row_baseline', label: 'Row (baseline)',
    source: 'row', wasm: false, filterStrategy: 'function', kpiStrategy: 'separate',
  },
  row_native: {
    id: 'row_native', label: 'Row (native)',
    source: 'row', wasm: false, filterStrategy: 'native', kpiStrategy: 'combined',
  },
  arrow_js: {
    id: 'arrow_js', label: 'Arrow + JS',
    source: 'arrow', wasm: false, filterStrategy: 'native', kpiStrategy: 'combined',
  },
  arrow_wasm: {
    id: 'arrow_wasm', label: 'Arrow + WASM',
    source: 'arrow', wasm: true, filterStrategy: 'native', kpiStrategy: 'combined',
  },
};

const TABLE_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// 2. State
// ---------------------------------------------------------------------------
const state = {
  arrowTable: null,
  materializedRows: null,
  cf: null,
  mode: MODES.arrow_wasm,
  dimensions: {},
  groups: {},
  kpis: null,
  filterValues: {
    event: [],
    customer_country: null,
    location_country: null,
    region: [],
    time: null,
    latitude: null,
  },
  tableSort: 'top', // 'top' = most recent, 'bottom' = oldest
  tableOffset: 0,
  charts: {},
  dirty: false,
  rafId: null,
  onChangeCb: null,
  allFieldNames: [],
  timeBounds: { min: 0, max: 0 },
};

// ---------------------------------------------------------------------------
// 3. DOM Cache
// ---------------------------------------------------------------------------
let dom = {};

function cacheDom() {
  dom = {
    errorBanner: document.getElementById('error-banner'),
    header: document.getElementById('header'),
    modeSelector: document.getElementById('mode-selector'),
    runtimeBadge: document.getElementById('runtime-badge'),
    latencyDisplay: document.getElementById('latency-display'),
    loadTime: document.getElementById('load-time'),
    eventPills: document.getElementById('event-pills'),
    customerCountrySelect: document.getElementById('customer-country-select'),
    locationCountrySelect: document.getElementById('location-country-select'),
    regionSearch: document.getElementById('region-search'),
    regionCheckboxes: document.getElementById('region-checkboxes'),
    timeMin: document.getElementById('time-min'),
    timeMax: document.getElementById('time-max'),
    timeRangeLabel: document.getElementById('time-range-label'),
    latMin: document.getElementById('lat-min'),
    latMax: document.getElementById('lat-max'),
    clearAllBtn: document.getElementById('clear-all-btn'),
    filterChips: document.getElementById('filter-chips'),
    kpiTotal: document.getElementById('kpi-total'),
    kpiLocations: document.getElementById('kpi-locations'),
    kpiLatitude: document.getElementById('kpi-latitude'),
    kpiTimespan: document.getElementById('kpi-timespan'),
    chartEvent: document.getElementById('chart-event'),
    chartTimeline: document.getElementById('chart-timeline'),
    chartRegion: document.getElementById('chart-region'),
    chartDivision: document.getElementById('chart-division'),
    listCustomerCountry: document.getElementById('list-customer-country'),
    listLocationCountry: document.getElementById('list-location-country'),
    listMunicipality: document.getElementById('list-municipality'),
    listLocality: document.getElementById('list-locality'),
    listPostal: document.getElementById('list-postal'),
    tableSortToggle: document.getElementById('table-sort-toggle'),
    tablePrev: document.getElementById('table-prev'),
    tableNext: document.getElementById('table-next'),
    tablePageInfo: document.getElementById('table-page-info'),
    tableHead: document.getElementById('table-head'),
    tableBody: document.getElementById('table-body'),
    addRowsBtn: document.getElementById('add-rows-btn'),
    removeFilteredBtn: document.getElementById('remove-filtered-btn'),
    perfLog: document.getElementById('perf-log'),
    loadingOverlay: document.getElementById('loading-overlay'),
    eventGroupSize: document.getElementById('event-group-size'),
    ccGroupSize: document.getElementById('cc-group-size'),
    lcGroupSize: document.getElementById('lc-group-size'),
    regionGroupSize: document.getElementById('region-group-size'),
    divisionGroupSize: document.getElementById('division-group-size'),
    muniGroupSize: document.getElementById('muni-group-size'),
    locGroupSize: document.getElementById('loc-group-size'),
    postalGroupSize: document.getElementById('postal-group-size'),
  };
}

// ---------------------------------------------------------------------------
// 4. Utilities
// ---------------------------------------------------------------------------
function showError(msg) {
  dom.errorBanner.textContent = msg;
  dom.errorBanner.hidden = false;
}

function hideError() {
  dom.errorBanner.hidden = true;
}

function appendLog(msg) {
  const ts = new Date().toLocaleTimeString();
  dom.perfLog.textContent += `[${ts}] ${msg}\n`;
  dom.perfLog.scrollTop = dom.perfLog.scrollHeight;
}

function timedOp(label, fn) {
  const t0 = performance.now();
  const result = fn();
  const elapsed = performance.now() - t0;
  appendLog(`${label}: ${elapsed.toFixed(1)} ms`);
  return { result, elapsed };
}

function formatTimestamp(val) {
  if (val == null) return '—';
  try {
    const d = new Date(typeof val === 'number' ? val : Number(val));
    if (isNaN(d.getTime())) return String(val);
    return d.toISOString().slice(0, 16).replace('T', ' ');
  } catch (_) {
    return String(val);
  }
}

function formatNumber(n) {
  if (n == null || isNaN(n)) return '—';
  return Number(n).toLocaleString();
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------------------------------------------------------------------------
// 5. Arrow helpers
// ---------------------------------------------------------------------------
function getTableFromIPC(arrowModule) {
  return (arrowModule && arrowModule.tableFromIPC)
    || (arrowModule && arrowModule.default && arrowModule.default.tableFromIPC)
    || null;
}

function getFieldNames(table) {
  if (table && table.schema && Array.isArray(table.schema.fields)) {
    return table.schema.fields.map(function(f) { return f.name; });
  }
  if (table && Array.isArray(table.columnNames)) {
    return table.columnNames.slice();
  }
  return [];
}

function getColumn(table, name, index) {
  if (!table) return undefined;
  if (typeof table.getChild === 'function') {
    const c = table.getChild(name);
    if (c != null) return c;
  }
  if (typeof table.getColumn === 'function') {
    const c = table.getColumn(name);
    if (c != null) return c;
  }
  if (typeof table.getChildAt === 'function') {
    return table.getChildAt(index);
  }
  return table[name];
}

function getValue(col, idx) {
  if (col == null) return undefined;
  if (typeof col.get === 'function') return col.get(idx);
  if (typeof col.at === 'function') return col.at(idx);
  return col[idx];
}

function materializeRows(table) {
  const fields = getFieldNames(table);
  const columns = fields.map((f, i) => getColumn(table, f, i));
  const rows = new Array(table.numRows);
  for (let r = 0; r < table.numRows; r++) {
    const row = {};
    for (let c = 0; c < fields.length; c++) {
      row[fields[c]] = getValue(columns[c], r);
    }
    rows[r] = row;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 6. Data loading
// ---------------------------------------------------------------------------
async function loadData() {
  const t0 = performance.now();
  const resp = await fetch(ARROW_FILE);
  if (!resp.ok) throw new Error(`Failed to load ${ARROW_FILE}: ${resp.status}`);
  const buffer = await resp.arrayBuffer();

  const Arrow = window.Arrow;
  const tableFromIPC = getTableFromIPC(Arrow);
  if (!tableFromIPC) throw new Error('Arrow.tableFromIPC not available');

  state.arrowTable = tableFromIPC(new Uint8Array(buffer));
  state.allFieldNames = getFieldNames(state.arrowTable);

  // Validate required fields
  const missing = Object.values(FIELDS).filter(f => !state.allFieldNames.includes(f));
  if (missing.length) {
    const msg = `Missing fields in Arrow data: ${missing.join(', ')}`;
    appendLog(`Warning: ${msg}`);
    showError(msg);
  }

  // Pre-materialize rows for row-based modes
  const { elapsed: matElapsed } = timedOp('Materialize rows', () => {
    state.materializedRows = materializeRows(state.arrowTable);
  });

  const totalElapsed = performance.now() - t0;
  dom.loadTime.textContent = `Load: ${totalElapsed.toFixed(0)} ms`;
  appendLog(`Loaded ${state.arrowTable.numRows} rows in ${totalElapsed.toFixed(0)} ms`);
  return state.arrowTable;
}

// ---------------------------------------------------------------------------
// 7. Environment build
// ---------------------------------------------------------------------------
function buildEnvironment() {
  const mode = state.mode;

  // Configure WASM runtime
  if (typeof crossfilter.configureRuntime === 'function') {
    crossfilter.configureRuntime({ wasm: mode.wasm });
  }

  const { result: cf, elapsed } = timedOp(`Build crossfilter [${mode.id}]`, () => {
    if (mode.source === 'arrow') {
      return crossfilter.fromArrowTable(state.arrowTable);
    }
    return crossfilter(state.materializedRows.slice());
  });

  state.cf = cf;
  appendLog(`crossfilter size: ${cf.size()}`);

  // Build dimensions
  const dims = {};
  const stringDimKeys = [
    'event', 'customer_country', 'location_country', 'region',
    'division', 'municipality', 'locality', 'postal_code',
  ];

  timedOp('Build dimensions', () => {
    for (const key of stringDimKeys) {
      dims[key] = cf.dimension(FIELDS[key]);
    }
    // Time dimension: use the field name directly
    dims.time = cf.dimension(FIELDS.time);
    // Latitude as function dimension
    dims.latitude = cf.dimension(function(row) {
      const v = row[FIELDS.latitude];
      return isFiniteNumber(v) ? v : -999;
    });
  });
  state.dimensions = dims;

  // Build groups
  const groups = {};
  timedOp('Build groups', () => {
    groups.event = dims.event.group().reduceCount();
    groups.customer_country = dims.customer_country.group().reduceCount();
    groups.location_country = dims.location_country.group().reduceCount();
    // Region group with reduceSum on latitude
    groups.region = dims.region.group().reduceSum(function(row) {
      const v = row[FIELDS.latitude];
      return isFiniteNumber(v) ? v : 0;
    });
    groups.division = dims.division.group().reduceCount();
    groups.municipality = dims.municipality.group().reduceCount();
    // Locality group with order descending (least frequent)
    groups.locality = dims.locality.group().reduceCount();
    groups.locality.order(function(v) { return -v; });
    groups.postal_code = dims.postal_code.group().reduceCount();
    // Time group bucketed by hour
    groups.time = dims.time.group(timeBucketFn).reduceCount();
  });
  state.groups = groups;

  // Build KPIs based on mode strategy
  if (mode.kpiStrategy === 'combined') {
    state.kpis = buildCombinedKpi(cf);
  } else {
    state.kpis = buildSeparateKpis(cf);
  }

  // onChange
  if (state.onChangeCb) {
    // previous callback reference not needed; new cf instance
  }
  state.onChangeCb = cf.onChange(function() {
    scheduleRender();
  });

  // Update runtime badge
  updateRuntimeBadge();

  // Populate filter controls
  populateFilterControls();

  appendLog(`Environment built [${mode.id}] in ${elapsed.toFixed(0)} ms`);
}

// ---------------------------------------------------------------------------
// 8. Time bucket function
// ---------------------------------------------------------------------------
function timeBucketFn(v) {
  if (!isFiniteNumber(v) && typeof v !== 'number') {
    const n = Number(v);
    if (!isFiniteNumber(n)) return 0;
    return Math.floor(n / 3600000) * 3600000;
  }
  return Math.floor(v / 3600000) * 3600000;
}

// ---------------------------------------------------------------------------
// 9. Combined KPI reducer
// ---------------------------------------------------------------------------
function buildCombinedKpi(cf) {
  const latField = FIELDS.latitude;
  const locField = FIELDS.location_label;
  const timeField = FIELDS.time;

  const ga = cf.groupAll().reduce(
    function add(p, row) {
      p.totalRows++;
      const loc = row[locField];
      if (loc != null && loc !== '') {
        p.locationSet.set(loc, (p.locationSet.get(loc) || 0) + 1);
      }
      const lat = row[latField];
      if (isFiniteNumber(lat) && lat !== 0) {
        p.latSum += lat;
        p.latCount++;
      }
      const t = row[timeField];
      const tn = typeof t === 'number' ? t : Number(t);
      if (isFiniteNumber(tn)) {
        if (tn < p.minTime) p.minTime = tn;
        if (tn > p.maxTime) p.maxTime = tn;
        p.timeStale = true;
      }
      return p;
    },
    function remove(p, row) {
      p.totalRows--;
      const loc = row[locField];
      if (loc != null && loc !== '') {
        const c = (p.locationSet.get(loc) || 0) - 1;
        if (c <= 0) p.locationSet.delete(loc);
        else p.locationSet.set(loc, c);
      }
      const lat = row[latField];
      if (isFiniteNumber(lat) && lat !== 0) {
        p.latSum -= lat;
        p.latCount--;
      }
      p.timeStale = true;
      return p;
    },
    function initial() {
      return {
        totalRows: 0,
        locationSet: new Map(),
        latSum: 0,
        latCount: 0,
        minTime: Infinity,
        maxTime: -Infinity,
        timeStale: true,
      };
    }
  );

  return { type: 'combined', ga };
}

// ---------------------------------------------------------------------------
// 10. Separate KPI reducers
// ---------------------------------------------------------------------------
function buildSeparateKpis(cf) {
  const latField = FIELDS.latitude;
  const timeField = FIELDS.time;

  const totalRows = cf.groupAll().reduceCount();
  const latSum = cf.groupAll().reduceSum(function(row) {
    const v = row[latField];
    return (isFiniteNumber(v) && v !== 0) ? v : 0;
  });
  const latCount = cf.groupAll().reduceSum(function(row) {
    const v = row[latField];
    return (isFiniteNumber(v) && v !== 0) ? 1 : 0;
  });
  const locations = cf.groupAll().reduce(
    function(p, row) {
      const loc = row[FIELDS.location_label];
      if (loc != null && loc !== '') {
        p.set(loc, (p.get(loc) || 0) + 1);
      }
      return p;
    },
    function(p, row) {
      const loc = row[FIELDS.location_label];
      if (loc != null && loc !== '') {
        const c = (p.get(loc) || 0) - 1;
        if (c <= 0) p.delete(loc);
        else p.set(loc, c);
      }
      return p;
    },
    function() { return new Map(); }
  );
  const timeSpan = cf.groupAll().reduce(
    function(p, row) {
      const t = typeof row[timeField] === 'number' ? row[timeField] : Number(row[timeField]);
      if (isFiniteNumber(t)) {
        if (t < p.min) p.min = t;
        if (t > p.max) p.max = t;
        p.stale = true;
      }
      return p;
    },
    function(p) {
      p.stale = true;
      return p;
    },
    function() { return { min: Infinity, max: -Infinity, stale: true }; }
  );

  return { type: 'separate', totalRows, latSum, latCount, locations, timeSpan };
}

// ---------------------------------------------------------------------------
// 11. Read KPIs
// ---------------------------------------------------------------------------
function readKpis() {
  if (state.kpis.type === 'combined') {
    const v = state.kpis.ga.value();
    if (v.timeStale) {
      recomputeTimeBounds(v);
      v.timeStale = false;
    }
    return {
      totalRows: v.totalRows,
      uniqueLocations: v.locationSet.size,
      avgLat: v.latCount > 0 ? v.latSum / v.latCount : null,
      minTime: v.minTime,
      maxTime: v.maxTime,
    };
  }
  // separate
  const kp = state.kpis;
  const tsVal = kp.timeSpan.value();
  if (tsVal.stale) {
    recomputeTimeBounds(tsVal);
    tsVal.stale = false;
  }
  return {
    totalRows: kp.totalRows.value(),
    uniqueLocations: kp.locations.value().size,
    avgLat: kp.latCount.value() > 0 ? kp.latSum.value() / kp.latCount.value() : null,
    minTime: tsVal.min,
    maxTime: tsVal.max,
  };
}

// ---------------------------------------------------------------------------
// 12. Recompute time bounds
// ---------------------------------------------------------------------------
function recomputeTimeBounds(obj) {
  let min = Infinity, max = -Infinity;
  const filtered = state.cf.allFiltered();
  const timeField = FIELDS.time;
  for (let i = 0; i < filtered.length; i++) {
    const t = filtered[i][timeField];
    const tn = typeof t === 'number' ? t : Number(t);
    if (isFiniteNumber(tn)) {
      if (tn < min) min = tn;
      if (tn > max) max = tn;
    }
  }
  if (obj.minTime !== undefined) {
    obj.minTime = min;
    obj.maxTime = max;
  } else {
    obj.min = min;
    obj.max = max;
  }
}

// ---------------------------------------------------------------------------
// 13. Mode switching
// ---------------------------------------------------------------------------
function saveFilterState() {
  return JSON.parse(JSON.stringify(state.filterValues));
}

function destroyEnvironment() {
  // Dispose groups before dimensions
  if (state.groups) {
    for (const key of Object.keys(state.groups)) {
      try { state.groups[key].dispose(); } catch (_) {}
    }
  }
  if (state.kpis) {
    if (state.kpis.type === 'combined') {
      try { state.kpis.ga.dispose(); } catch (_) {}
    } else {
      for (const key of ['totalRows', 'latSum', 'latCount', 'locations', 'timeSpan']) {
        try { state.kpis[key].dispose(); } catch (_) {}
      }
    }
  }
  if (state.dimensions) {
    for (const key of Object.keys(state.dimensions)) {
      try { state.dimensions[key].dispose(); } catch (_) {}
    }
  }
  state.cf = null;
  state.dimensions = {};
  state.groups = {};
  state.kpis = null;
}

function restoreFilterState(saved) {
  state.filterValues = saved;
  // Re-apply each filter
  for (const key of Object.keys(saved)) {
    const val = saved[key];
    if (val === null || (Array.isArray(val) && val.length === 0)) continue;
    applyFilter(key, val);
  }
}

function switchMode(modeId) {
  if (!MODES[modeId]) return;
  const previousMode = state.mode;
  const saved = saveFilterState();
  try {
    destroyEnvironment();
    state.mode = MODES[modeId];
    buildEnvironment();
    restoreFilterState(saved);
    updateModeButtons();
    renderAll();
    hideError();
  } catch (err) {
    // Revert to previous working mode
    showError('Mode switch failed: ' + err.message + '. Reverting to ' + previousMode.id);
    console.error(err);
    try {
      destroyEnvironment();
      state.mode = previousMode;
      buildEnvironment();
      restoreFilterState(saved);
      updateModeButtons();
      renderAll();
    } catch (revertErr) {
      showError('Fatal: could not revert mode. ' + revertErr.message);
      console.error(revertErr);
    }
  }
}

function updateModeButtons() {
  const btns = dom.modeSelector.querySelectorAll('.mode-btn');
  btns.forEach(btn => {
    btn.classList.toggle('mode-btn--active', btn.dataset.mode === state.mode.id);
  });
}

// ---------------------------------------------------------------------------
// 14. Render pipeline
// ---------------------------------------------------------------------------
function scheduleRender() {
  if (state.rafId) return;
  state.rafId = requestAnimationFrame(() => {
    state.rafId = null;
    renderAll();
  });
}

function renderAll() {
  const t0 = performance.now();

  renderKpis();
  renderEventChart();
  renderTimelineChart();
  renderBarChart('chart-region', state.groups.region, 'region', 'regionGroupSize', 'Lat Sum');
  renderBarChart('chart-division', state.groups.division, 'division', 'divisionGroupSize', 'Count');
  renderListChart(dom.listCustomerCountry, state.groups.customer_country, 'customer_country', dom.ccGroupSize);
  renderListChart(dom.listLocationCountry, state.groups.location_country, 'location_country', dom.lcGroupSize);
  renderTopList(dom.listMunicipality, state.groups.municipality, 20, 'municipality', dom.muniGroupSize);
  renderTopList(dom.listLocality, state.groups.locality, 15, 'locality', dom.locGroupSize);
  renderTopList(dom.listPostal, state.groups.postal_code, 10, 'postal_code', dom.postalGroupSize);
  renderDataTable();
  renderFilterChips();

  const elapsed = performance.now() - t0;
  dom.latencyDisplay.textContent = `${elapsed.toFixed(1)} ms`;
}

function updateRuntimeBadge() {
  if (typeof crossfilter.runtimeInfo === 'function') {
    const info = crossfilter.runtimeInfo();
    let text = `${info.active.toUpperCase()} | ${state.cf ? state.cf.size().toLocaleString() + ' rows' : ''}`;
    if (state.mode.wasm && info.active !== 'wasm') {
      text += ' (WASM unavailable)';
    }
    dom.runtimeBadge.textContent = text;
    dom.runtimeBadge.style.background = info.active === 'wasm' ? '#2e7d32' : '';
    dom.runtimeBadge.style.color = info.active === 'wasm' ? '#fff' : '';
  } else {
    dom.runtimeBadge.textContent = 'JS';
  }
}

// ---------------------------------------------------------------------------
// 15. Filter controls population
// ---------------------------------------------------------------------------
function populateFilterControls() {
  // Event pills
  const eventGroup = state.groups.event.all();
  dom.eventPills.innerHTML = '';
  eventGroup.forEach(g => {
    if (g.key == null || g.key === '') return;
    const btn = document.createElement('button');
    btn.className = 'pill';
    btn.textContent = g.key;
    btn.dataset.value = g.key;
    btn.addEventListener('click', () => {
      const val = btn.dataset.value;
      const idx = state.filterValues.event.indexOf(val);
      if (idx >= 0) {
        state.filterValues.event.splice(idx, 1);
      } else {
        state.filterValues.event.push(val);
      }
      applyFilter('event', state.filterValues.event);
      updatePillStates();
    });
    dom.eventPills.appendChild(btn);
  });
  updatePillStates();

  // Customer country select
  populateSelect(dom.customerCountrySelect, state.groups.customer_country.all(), 'customer_country');

  // Location country select
  populateSelect(dom.locationCountrySelect, state.groups.location_country.all(), 'location_country');

  // Region checkboxes
  const regionData = state.groups.region.all();
  dom.regionCheckboxes.innerHTML = '';
  regionData.forEach(g => {
    if (g.key == null || g.key === '') return;
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = g.key;
    cb.addEventListener('change', () => {
      const checked = Array.from(dom.regionCheckboxes.querySelectorAll('input:checked'))
        .map(c => c.value);
      state.filterValues.region = checked;
      applyFilter('region', checked);
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + g.key));
    dom.regionCheckboxes.appendChild(label);
  });

  // One-time event listeners (guarded to avoid stacking on mode switch)
  if (!populateFilterControls._listenersAttached) {
    populateFilterControls._listenersAttached = true;

    dom.regionSearch.addEventListener('input', () => {
      const q = dom.regionSearch.value.toLowerCase();
      dom.regionCheckboxes.querySelectorAll('label').forEach(lbl => {
        lbl.style.display = lbl.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    dom.latMin.addEventListener('change', applyLatFilter);
    dom.latMax.addEventListener('change', applyLatFilter);

    dom.timeMin.addEventListener('input', applyTimeFilter);
    dom.timeMax.addEventListener('input', applyTimeFilter);
  }

  // Time range slider (bounds may change on mode switch)
  computeTimeBoundsForSliders();
}

function populateSelect(selectEl, groupData, filterKey) {
  // Clear existing options except first "All"
  while (selectEl.options.length > 1) selectEl.remove(1);
  groupData.forEach(g => {
    if (g.key == null || g.key === '') return;
    const opt = document.createElement('option');
    opt.value = g.key;
    opt.textContent = `${g.key} (${g.value})`;
    selectEl.appendChild(opt);
  });
  // Only attach listener once
  if (!selectEl._listenerAttached) {
    selectEl._listenerAttached = true;
    selectEl.addEventListener('change', () => {
      const val = selectEl.value || null;
      state.filterValues[filterKey] = val;
      applyFilter(filterKey, val);
    });
  }
}

function updatePillStates() {
  dom.eventPills.querySelectorAll('.pill').forEach(btn => {
    btn.classList.toggle('pill--active', state.filterValues.event.includes(btn.dataset.value));
  });
}

function computeTimeBoundsForSliders() {
  // Scan time dimension for range
  const timeGroup = state.groups.time.all();
  let minT = Infinity, maxT = -Infinity;
  timeGroup.forEach(g => {
    const t = Number(g.key);
    if (isFiniteNumber(t) && t > 0) {
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
  });
  if (!isFiniteNumber(minT) || !isFiniteNumber(maxT) || minT >= maxT) {
    dom.timeMin.disabled = true;
    dom.timeMax.disabled = true;
    return;
  }
  state.timeBounds = { min: minT, max: maxT };
  dom.timeMin.min = dom.timeMax.min = minT;
  dom.timeMin.max = dom.timeMax.max = maxT;
  dom.timeMin.value = minT;
  dom.timeMax.value = maxT;
  dom.timeRangeLabel.textContent = `${formatTimestamp(minT)} — ${formatTimestamp(maxT)}`;

}

function applyTimeFilter() {
  const lo = Number(dom.timeMin.value);
  const hi = Number(dom.timeMax.value);
  if (lo >= hi) return;
  state.filterValues.time = [lo, hi];
  dom.timeRangeLabel.textContent = `${formatTimestamp(lo)} — ${formatTimestamp(hi)}`;
  applyFilter('time', [lo, hi]);
}

function applyLatFilter() {
  const lo = dom.latMin.value !== '' ? Number(dom.latMin.value) : null;
  const hi = dom.latMax.value !== '' ? Number(dom.latMax.value) : null;
  if (lo != null && hi != null && isFiniteNumber(lo) && isFiniteNumber(hi)) {
    state.filterValues.latitude = [lo, hi];
    applyFilter('latitude', [lo, hi]);
  } else if (lo == null && hi == null) {
    state.filterValues.latitude = null;
    state.dimensions.latitude.filterAll();
    scheduleRender();
  }
}

// ---------------------------------------------------------------------------
// 16. Apply filter
// ---------------------------------------------------------------------------
function applyFilter(key, value) {
  const dim = state.dimensions[key];
  if (!dim) return;

  const isBaseline = state.mode.filterStrategy === 'function';

  if (value === null || (Array.isArray(value) && value.length === 0)) {
    dim.filterAll();
    scheduleRender();
    return;
  }

  // Range filter for time and latitude
  if (key === 'time' && Array.isArray(value) && value.length === 2) {
    dim.filterRange(value);
    scheduleRender();
    return;
  }

  if (key === 'latitude' && Array.isArray(value) && value.length === 2) {
    dim.filterFunction(function(v) {
      return v >= value[0] && v <= value[1];
    });
    scheduleRender();
    return;
  }

  // Discrete filters
  if (Array.isArray(value)) {
    if (value.length === 1) {
      if (isBaseline) {
        dim.filterFunction(function(v) { return v === value[0]; });
      } else {
        dim.filterExact(value[0]);
      }
    } else {
      if (isBaseline) {
        const set = new Set(value);
        dim.filterFunction(function(v) { return set.has(v); });
      } else {
        dim.filterIn(value);
      }
    }
  } else {
    // Single value (from dropdown)
    if (isBaseline) {
      dim.filterFunction(function(v) { return v === value; });
    } else {
      dim.filterExact(value);
    }
  }

  scheduleRender();
}

// ---------------------------------------------------------------------------
// 17. Clear all filters
// ---------------------------------------------------------------------------
function clearAllFilters() {
  for (const key of Object.keys(state.dimensions)) {
    state.dimensions[key].filterAll();
  }
  state.filterValues = {
    event: [],
    customer_country: null,
    location_country: null,
    region: [],
    time: null,
    latitude: null,
  };

  // Demonstrate orderNatural then re-apply order
  try {
    state.groups.locality.orderNatural();
    state.groups.locality.order(function(v) { return -v; });
  } catch (_) {}

  // Reset UI controls
  resetFilterControl('event');
  resetFilterControl('customer_country');
  resetFilterControl('location_country');
  resetFilterControl('region');
  resetFilterControl('time');
  resetFilterControl('latitude');

  state.tableOffset = 0;
  scheduleRender();
}

// ---------------------------------------------------------------------------
// 18. Filter chips
// ---------------------------------------------------------------------------
function renderFilterChips() {
  dom.filterChips.innerHTML = '';

  // Use dimension.hasCurrentFilter() and dimension.currentFilter() to detect active filters
  for (const key of Object.keys(state.dimensions)) {
    const dim = state.dimensions[key];
    if (typeof dim.hasCurrentFilter !== 'function' || !dim.hasCurrentFilter()) continue;

    const label = FIELD_LABELS[key] || key;
    const currentFilter = typeof dim.currentFilter === 'function' ? dim.currentFilter() : null;
    let display;
    if (Array.isArray(currentFilter)) {
      display = key === 'time'
        ? `${formatTimestamp(currentFilter[0])} — ${formatTimestamp(currentFilter[1])}`
        : currentFilter.length + ' selected';
    } else if (currentFilter != null) {
      display = String(currentFilter);
    } else {
      display = 'active';
    }

    addChip(`${label}: ${display}`, () => {
      state.filterValues[key] = Array.isArray(state.filterValues[key]) ? [] : null;
      applyFilter(key, null);
      resetFilterControl(key);
    });
  }
}

function addChip(text, onDismiss) {
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.innerHTML = `${escapeHtml(text)} <button class="chip-dismiss">&times;</button>`;
  chip.querySelector('.chip-dismiss').addEventListener('click', onDismiss);
  dom.filterChips.appendChild(chip);
}

// ---------------------------------------------------------------------------
// 19. Reset filter control
// ---------------------------------------------------------------------------
function resetFilterControl(key) {
  switch (key) {
    case 'event':
      updatePillStates();
      break;
    case 'customer_country':
      dom.customerCountrySelect.value = '';
      break;
    case 'location_country':
      dom.locationCountrySelect.value = '';
      break;
    case 'region':
      dom.regionCheckboxes.querySelectorAll('input').forEach(cb => cb.checked = false);
      dom.regionSearch.value = '';
      dom.regionCheckboxes.querySelectorAll('label').forEach(lbl => lbl.style.display = '');
      break;
    case 'time':
      dom.timeMin.value = state.timeBounds.min;
      dom.timeMax.value = state.timeBounds.max;
      dom.timeRangeLabel.textContent = `${formatTimestamp(state.timeBounds.min)} — ${formatTimestamp(state.timeBounds.max)}`;
      break;
    case 'latitude':
      dom.latMin.value = '';
      dom.latMax.value = '';
      break;
  }
}

// ---------------------------------------------------------------------------
// 20. Render KPIs
// ---------------------------------------------------------------------------
function renderKpis() {
  const k = readKpis();
  const total = state.cf.size();
  const pct = total > 0 ? ((k.totalRows / total) * 100).toFixed(1) : '0';

  dom.kpiTotal.querySelector('.kpi-value').innerHTML =
    `${formatNumber(k.totalRows)} <span class="kpi-pct">(${pct}%)</span>`;
  dom.kpiLocations.querySelector('.kpi-value').textContent = formatNumber(k.uniqueLocations);
  dom.kpiLatitude.querySelector('.kpi-value').textContent =
    k.avgLat != null ? k.avgLat.toFixed(4) : '—';
  dom.kpiTimespan.querySelector('.kpi-value').textContent =
    (isFiniteNumber(k.minTime) && isFiniteNumber(k.maxTime) && k.maxTime > k.minTime)
      ? `${formatTimestamp(k.minTime)} — ${formatTimestamp(k.maxTime)}`
      : '—';
}

// ---------------------------------------------------------------------------
// 21. Event chart (horizontal bar)
// ---------------------------------------------------------------------------
function renderEventChart() {
  if (!state.charts.event) {
    state.charts.event = echarts.init(dom.chartEvent);
    state.charts.event.on('click', function(params) {
      if (params.name) {
        const idx = state.filterValues.event.indexOf(params.name);
        if (idx >= 0) {
          state.filterValues.event.splice(idx, 1);
        } else {
          state.filterValues.event.push(params.name);
        }
        applyFilter('event', state.filterValues.event);
        updatePillStates();
      }
    });
  }

  const data = state.groups.event.all().filter(g => g.key != null && g.key !== '');
  data.sort((a, b) => b.value - a.value);

  dom.eventGroupSize.textContent = `${data.length} groups`;

  state.charts.event.setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 100, right: 20, top: 10, bottom: 20 },
    xAxis: { type: 'value', axisLabel: { color: '#333333', fontSize: 11 } },
    yAxis: {
      type: 'category',
      data: data.map(g => g.key),
      inverse: true,
      axisLabel: { color: '#333333', fontSize: 11 },
    },
    series: [{
      type: 'bar',
      data: data.map(g => ({
        value: g.value,
        itemStyle: {
          color: state.filterValues.event.includes(g.key) ? '#000e4a' : '#3f6587',
        },
      })),
      barMaxWidth: 24,
    }],
    animation: false,
  });
}

// ---------------------------------------------------------------------------
// 22. Timeline chart (line/area with dataZoom)
// ---------------------------------------------------------------------------
function renderTimelineChart() {
  if (!state.charts.timeline) {
    state.charts.timeline = echarts.init(dom.chartTimeline);
    state.charts.timeline.on('datazoom', function(params) {
      // Map dataZoom percentage to time range filter
      const opt = state.charts.timeline.getOption();
      if (!opt || !opt.xAxis || !opt.xAxis[0]) return;
      const data = opt.series[0].data;
      if (!data || !data.length) return;
      const start = params.start != null ? params.start : (params.batch && params.batch[0] && params.batch[0].start);
      const end = params.end != null ? params.end : (params.batch && params.batch[0] && params.batch[0].end);
      if (start == null || end == null) return;
      const startIdx = Math.floor((start / 100) * (data.length - 1));
      const endIdx = Math.ceil((end / 100) * (data.length - 1));
      if (startIdx >= 0 && endIdx < data.length && startIdx < endIdx) {
        const lo = data[startIdx][0];
        const hi = data[endIdx][0];
        if (start <= 0.01 && end >= 99.99) {
          // Zoomed all the way out, clear time filter
          state.filterValues.time = null;
          state.dimensions.time.filterAll();
        } else {
          state.filterValues.time = [lo, hi];
          applyFilter('time', [lo, hi]);
        }
      }
    });
  }

  const data = state.groups.time.all()
    .filter(g => {
      const k = Number(g.key);
      return isFiniteNumber(k) && k > 0;
    })
    .map(g => [Number(g.key), g.value])
    .sort((a, b) => a[0] - b[0]);

  state.charts.timeline.setOption({
    tooltip: {
      trigger: 'axis',
      formatter: function(params) {
        const p = params[0];
        return `${formatTimestamp(p.value[0])}<br/>Count: ${formatNumber(p.value[1])}`;
      },
    },
    grid: { left: 60, right: 20, top: 10, bottom: 60 },
    xAxis: {
      type: 'time',
      axisLabel: { color: '#333333', fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#333333', fontSize: 11 },
    },
    dataZoom: [{
      type: 'slider',
      xAxisIndex: 0,
      bottom: 10,
      height: 24,
    }],
    series: [{
      type: 'line',
      data: data,
      areaStyle: { color: 'rgba(63, 101, 135, 0.15)' },
      lineStyle: { color: '#3f6587', width: 1.5 },
      itemStyle: { color: '#3f6587' },
      symbol: 'none',
      smooth: true,
    }],
    animation: false,
  });
}

// ---------------------------------------------------------------------------
// 23. Reusable bar chart (vertical) for region and division
// ---------------------------------------------------------------------------
function renderBarChart(containerId, group, filterKey, sizeId, valueLabel) {
  const container = document.getElementById(containerId);
  const sizeBadge = document.getElementById(sizeId);

  if (!state.charts[containerId]) {
    state.charts[containerId] = echarts.init(container);
  }

  const data = group.all()
    .filter(g => g.key != null && g.key !== '')
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);

  if (sizeBadge) sizeBadge.textContent = `${group.size()} groups`;

  state.charts[containerId].setOption({
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: function(params) {
        const p = params[0];
        return `${escapeHtml(String(p.name))}<br/>${valueLabel}: ${formatNumber(p.value)}`;
      },
    },
    grid: { left: 10, right: 10, top: 10, bottom: 60 },
    xAxis: {
      type: 'category',
      data: data.map(g => g.key),
      axisLabel: { color: '#333333', fontSize: 10, rotate: 45 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#333333', fontSize: 10 },
    },
    series: [{
      type: 'bar',
      data: data.map(g => g.value),
      itemStyle: { color: '#3f6587' },
      barMaxWidth: 20,
    }],
    animation: false,
  });
}

// ---------------------------------------------------------------------------
// 24. List chart (full sorted with proportional bars)
// ---------------------------------------------------------------------------
function renderListChart(container, group, filterKey, sizeBadge) {
  const data = group.all()
    .filter(g => g.key != null && g.key !== '')
    .sort((a, b) => b.value - a.value);

  const maxVal = data.length ? data[0].value : 1;

  if (sizeBadge) sizeBadge.textContent = `${group.size()} groups`;

  container.innerHTML = data.map(g => {
    const pct = maxVal > 0 ? ((g.value / maxVal) * 100).toFixed(1) : 0;
    const selected = state.filterValues[filterKey] === g.key ? ' list-item--selected' : '';
    return `<div class="list-item${selected}" data-key="${filterKey}" data-value="${escapeHtml(String(g.key))}">
      <div class="list-item-bar" style="width:${pct}%"></div>
      <span class="list-item-label">${escapeHtml(String(g.key))}</span>
      <span class="list-item-count">${formatNumber(g.value)}</span>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// 25. Top-K list (using group.top)
// ---------------------------------------------------------------------------
function renderTopList(container, group, k, filterKey, sizeBadge) {
  const data = group.top(k).filter(g => g.key != null && g.key !== '' && g.value > 0);
  const maxVal = data.length ? data[0].value : 1;

  if (sizeBadge) sizeBadge.textContent = `${group.size()} groups`;

  container.innerHTML = data.map(g => {
    const pct = maxVal > 0 ? ((Math.abs(g.value) / Math.abs(maxVal)) * 100).toFixed(1) : 0;
    return `<div class="list-item" data-key="${filterKey}" data-value="${escapeHtml(String(g.key))}">
      <div class="list-item-bar" style="width:${pct}%"></div>
      <span class="list-item-label">${escapeHtml(String(g.key))}</span>
      <span class="list-item-count">${formatNumber(g.value)}</span>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// 26. Data table (paginated)
// ---------------------------------------------------------------------------
function renderDataTable() {
  // Build header
  if (!dom.tableHead.children.length) {
    dom.tableHead.innerHTML = TABLE_COLUMNS.map(key =>
      `<th>${escapeHtml(FIELD_LABELS[key] || key)}</th>`
    ).join('');
  }

  const dim = state.dimensions.time;
  if (!dim) return;

  const size = state.cf.size();
  const pageSize = TABLE_PAGE_SIZE;
  const offset = state.tableOffset;

  let rows;
  if (state.tableSort === 'top') {
    rows = dim.top(pageSize, offset);
  } else {
    rows = dim.bottom(pageSize, offset);
  }

  // Build row index map for isElementFiltered — use Map for O(1) lookups
  const allData = state.cf.all();
  const rowIndexMap = new Map();
  for (let i = 0; i < allData.length; i++) {
    rowIndexMap.set(allData[i], i);
  }

  dom.tableBody.innerHTML = rows.map(row => {
    const idx = rowIndexMap.get(row);
    const muted = (idx != null && typeof state.cf.isElementFiltered === 'function' && !state.cf.isElementFiltered(idx))
      ? ' class="row-muted"' : '';

    return `<tr${muted}>${TABLE_COLUMNS.map(key => {
      const field = FIELDS[key];
      let val = row[field];
      if (key === 'time') val = formatTimestamp(val);
      else if (key === 'latitude' && isFiniteNumber(val)) val = val.toFixed(4);
      else if (val == null) val = '';
      else val = String(val);
      return `<td>${escapeHtml(val)}</td>`;
    }).join('')}</tr>`;
  }).join('');

  // Page info
  const page = Math.floor(offset / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(size / pageSize));
  dom.tablePageInfo.textContent = `Page ${page} of ${totalPages}`;
  dom.tablePrev.disabled = offset === 0;
  dom.tableNext.disabled = offset + pageSize >= size;
}

// ---------------------------------------------------------------------------
// 27. Demo controls — add rows and remove
// ---------------------------------------------------------------------------
function generateSyntheticRows(count) {
  const allRows = state.cf.all();
  if (!allRows.length) return [];

  const newRows = [];
  for (let i = 0; i < count; i++) {
    const src = allRows[Math.floor(Math.random() * allRows.length)];
    const row = {};
    for (const field of Object.values(FIELDS)) {
      row[field] = src[field];
    }
    // Jitter timestamp
    const t = row[FIELDS.time];
    if (isFiniteNumber(t)) {
      row[FIELDS.time] = t + Math.floor((Math.random() - 0.5) * 3600000 * 48);
    }
    // Jitter latitude
    const lat = row[FIELDS.latitude];
    if (isFiniteNumber(lat)) {
      row[FIELDS.latitude] = lat + (Math.random() - 0.5) * 2;
    }
    newRows.push(row);
  }
  return newRows;
}

function onAddRows() {
  const rows = generateSyntheticRows(1000);
  const { elapsed } = timedOp('Add 1000 rows', () => {
    state.cf.add(rows);
  });
  appendLog(`New size: ${state.cf.size()}`);
  scheduleRender();
}

function onRemoveFiltered() {
  const before = state.cf.size();
  const { elapsed } = timedOp('Remove excluded rows', () => {
    state.cf.remove(function(row, idx) {
      return typeof state.cf.isElementFiltered === 'function'
        ? !state.cf.isElementFiltered(idx)
        : false;
    });
  });
  const after = state.cf.size();
  appendLog(`Removed ${before - after} rows, new size: ${after}`);
  scheduleRender();
}

// ---------------------------------------------------------------------------
// 28. Init
// ---------------------------------------------------------------------------
async function init() {
  cacheDom();

  try {
    await loadData();
    buildEnvironment();

    // Initialize ECharts instances (guarded)
    // Charts are lazily initialized in their render functions via the
    // `if (!state.charts.xxx)` pattern already in place.

    renderAll();

    // Wire up mode switcher
    dom.modeSelector.addEventListener('click', (e) => {
      const btn = e.target.closest('.mode-btn');
      if (btn && btn.dataset.mode) {
        switchMode(btn.dataset.mode);
      }
    });

    // Clear all
    dom.clearAllBtn.addEventListener('click', clearAllFilters);

    // Table controls
    dom.tableSortToggle.addEventListener('click', () => {
      state.tableSort = state.tableSort === 'top' ? 'bottom' : 'top';
      state.tableOffset = 0;
      dom.tableSortToggle.textContent = state.tableSort === 'top' ? 'Showing: Most Recent' : 'Showing: Oldest First';
      renderDataTable();
    });

    dom.tablePrev.addEventListener('click', () => {
      state.tableOffset = Math.max(0, state.tableOffset - TABLE_PAGE_SIZE);
      renderDataTable();
    });

    dom.tableNext.addEventListener('click', () => {
      state.tableOffset += TABLE_PAGE_SIZE;
      renderDataTable();
    });

    // Demo controls
    dom.addRowsBtn.addEventListener('click', onAddRows);
    dom.removeFilteredBtn.addEventListener('click', onRemoveFiltered);

    // List click delegation for chart-grid (ctrl/meta for multi-select)
    document.querySelector('.chart-grid').addEventListener('click', (e) => {
      const item = e.target.closest('.list-item');
      if (!item) return;
      const key = item.dataset.key;
      const value = item.dataset.value;
      if (!key || !value || !state.dimensions[key]) return;

      if (e.ctrlKey || e.metaKey) {
        // Multi-select: accumulate into filterIn
        let current = state.filterValues[key];
        if (!Array.isArray(current)) current = current ? [current] : [];
        const idx = current.indexOf(value);
        if (idx >= 0) {
          current = current.filter(v => v !== value);
        } else {
          current = current.concat([value]);
        }
        state.filterValues[key] = current.length > 0 ? current : (Array.isArray(state.filterValues[key]) ? [] : null);
        applyFilter(key, current.length > 0 ? current : null);
      } else {
        // Single-select toggle
        const currentVal = state.filterValues[key];
        const isActive = currentVal === value || (Array.isArray(currentVal) && currentVal.length === 1 && currentVal[0] === value);
        if (isActive) {
          state.filterValues[key] = Array.isArray(state.filterValues[key]) ? [] : null;
          applyFilter(key, null);
        } else {
          state.filterValues[key] = Array.isArray(state.filterValues[key]) ? [value] : value;
          applyFilter(key, Array.isArray(state.filterValues[key]) ? [value] : value);
        }
      }
      // Sync dropdown if applicable
      if (key === 'customer_country') dom.customerCountrySelect.value = state.filterValues[key] || '';
      if (key === 'location_country') dom.locationCountrySelect.value = state.filterValues[key] || '';
    });

    // Resize ECharts on window resize
    window.addEventListener('resize', () => {
      for (const chart of Object.values(state.charts)) {
        if (chart && typeof chart.resize === 'function') {
          chart.resize();
        }
      }
    });

    // Hide loading overlay
    dom.loadingOverlay.hidden = true;
    appendLog('Dashboard ready.');
  } catch (err) {
    showError(err.message);
    dom.loadingOverlay.hidden = true;
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// 29. Start
// ---------------------------------------------------------------------------
init();
