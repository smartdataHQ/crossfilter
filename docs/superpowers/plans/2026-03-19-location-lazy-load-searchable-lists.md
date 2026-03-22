# Location Lazy-Load & Searchable Dimension Lists

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible Location section that lazy-loads a second crossfilter worker with location dimensions, and make all dimension groups (Countries, Regions, Divisions, plus location fields) navigable via searchable infinite-scrolling lists.

**Architecture:** Two crossfilter workers with different dimension sets share a single `state.filters` object. The **main worker** has event, customer_country, region, division, time. The **location worker** (live mode only, lazy-loaded) adds location_label, municipality, locality, postal_code plus the common dimensions for cross-filtering. A `buildFiltersForWorker(dimensionSet)` function ensures each worker only receives filter fields for dimensions it has — location-only fields are excluded from main worker queries and vice versa. In file mode, the main worker already has all dimensions, so the location section queries it directly (no second worker). Each chart card gains a toggleable searchable list panel. A unified `dimListStates` map tracks per-list offset, loading flag, and search token to support correct infinite scroll.

**Tech Stack:** Vanilla JS (ES module, `var`/ES5 style per codebase convention), ECharts, crossfilter2 `createStreamingDashboardWorker`

---

## File Structure

| File | Role | Changes |
|------|------|---------|
| `demo/index.html` | Layout | Add Location `<details>` section with 4 list containers; add search inputs + list containers inside each chart card |
| `demo/demo.css` | Styles | Searchable list panel styles (`.dim-list`, `.dim-list-item`, `.dim-search`), Location section styles |
| `demo/demo.js` | All logic | Location worker lifecycle, filter splitting, searchable list rendering, cross-filter sync, infinite scroll |

## Key Design Decisions

1. **Filter splitting:** `buildFiltersForWorker(dimensions)` filters `buildDashboardFilters()` output to only include fields present in the given dimension array. Main worker never sees municipality/locality/postal_code/location_label filters. Location worker never sees latitude filters.

2. **Unified dim list state:** `dimListStates[groupId] = { offset, loading, token, lastSearch }` — all per-list state lives here, not on ephemeral config objects.

3. **No double-sort:** `renderDimList()` trusts server-sorted results from `groups()` API. It renders entries directly without re-sorting.

4. **Popover isolation:** Location worker loading uses the `loc-status-badge` in the section header, not the shared loading popover — avoids contention with main worker loads.

5. **Granularity change:** `disposeRuntime()` disposes the location worker. After main reload completes, if `state.locationOpen` is true, `loadLocationWorker()` is re-triggered automatically.

6. **Scroll guard:** Each list has a `loading` flag in `dimListStates` that prevents duplicate concurrent requests during rapid scrolling.

7. **File-mode fallback:** In file mode, the main worker has all dimensions. `buildGroupSpecs()` conditionally includes location groups when `state.dataSource !== 'live'`. `refreshLocationLists()` queries `state.runtime` directly — no second worker.

---

### Task 1: HTML — Add searchable list panels to chart cards + Location section

**Files:**
- Modify: `demo/index.html`

- [ ] **Step 1: Add search + list container to each chart card**

Each of the 3 chart cards gets a toggle button in the header and a hidden list panel below the chart:

```html
<!-- Customer Countries card -->
<section class="card chart-card anim d4">
  <div class="card-head">
    <span class="card-t">Customer Countries</span>
    <div class="card-filters">
      <span class="group-size-badge" id="cc-group-size"></span>
      <button class="btn btn-ghost btn-tiny dim-list-toggle" data-target="cc-list-panel">List</button>
    </div>
  </div>
  <div id="chart-customer-country" class="chart-wrap"></div>
  <div id="cc-list-panel" class="dim-list-panel" hidden>
    <input type="text" class="dim-search" id="cc-search" placeholder="Search countries...">
    <div class="dim-list-scroll" id="cc-list"></div>
  </div>
</section>

<!-- Regions card -->
<section class="card chart-card anim d4">
  <div class="card-head">
    <span class="card-t">Regions</span>
    <div class="card-filters">
      <span class="group-size-badge" id="region-group-size"></span>
      <button class="btn btn-ghost btn-tiny dim-list-toggle" data-target="region-list-panel">List</button>
    </div>
  </div>
  <div id="chart-region" class="chart-wrap"></div>
  <div id="region-list-panel" class="dim-list-panel" hidden>
    <input type="text" class="dim-search" id="region-search" placeholder="Search regions...">
    <div class="dim-list-scroll" id="region-list"></div>
  </div>
</section>

<!-- Divisions card -->
<section class="card chart-card anim d4">
  <div class="card-head">
    <span class="card-t">Divisions</span>
    <div class="card-filters">
      <span class="group-size-badge" id="division-group-size"></span>
      <button class="btn btn-ghost btn-tiny dim-list-toggle" data-target="div-list-panel">List</button>
    </div>
  </div>
  <div id="chart-division" class="chart-wrap"></div>
  <div id="div-list-panel" class="dim-list-panel" hidden>
    <input type="text" class="dim-search" id="div-search" placeholder="Search divisions...">
    <div class="dim-list-scroll" id="div-list"></div>
  </div>
</section>
```

- [ ] **Step 2: Add the collapsible Location section**

Insert after the chart grid `</div>`, before the Data Table `<section>`:

```html
<details id="location-section" class="card anim d5">
  <summary class="card-head card-head--toggle">
    <span class="card-t">Location Details</span>
    <div class="card-filters">
      <span class="group-size-badge" id="loc-status-badge">Expand to load</span>
    </div>
  </summary>
  <div class="location-body">
    <div class="location-grid">
      <div class="dim-col">
        <label class="dim-col-label">Location</label>
        <input type="text" class="dim-search" id="loc-label-search" placeholder="Search locations...">
        <div class="dim-list-scroll" id="loc-label-list"></div>
      </div>
      <div class="dim-col">
        <label class="dim-col-label">Municipality</label>
        <input type="text" class="dim-search" id="loc-muni-search" placeholder="Search municipalities...">
        <div class="dim-list-scroll" id="loc-muni-list"></div>
      </div>
      <div class="dim-col">
        <label class="dim-col-label">Locality</label>
        <input type="text" class="dim-search" id="loc-locality-search" placeholder="Search localities...">
        <div class="dim-list-scroll" id="loc-locality-list"></div>
      </div>
      <div class="dim-col">
        <label class="dim-col-label">Postal Code</label>
        <input type="text" class="dim-search" id="loc-postal-search" placeholder="Search postal codes...">
        <div class="dim-list-scroll" id="loc-postal-list"></div>
      </div>
    </div>
  </div>
</details>
```

- [ ] **Step 3: Commit**

```bash
git add demo/index.html
git commit -m "feat(demo): add searchable list panels and location section HTML"
```

---

### Task 2: CSS — Searchable list and location section styles

**Files:**
- Modify: `demo/demo.css`

- [ ] **Step 1: Add all new styles**

Add after the `.chart-wrap-timeline` rule:

```css
/* Dimension search lists */
.dim-list-panel { border-top: 1px solid rgba(63, 101, 135, 0.08); }
.dim-list-panel[hidden] { display: none; }

.dim-search {
  width: 100%;
  padding: 8px 14px;
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 12px;
  outline: none;
}
.dim-search:focus { background: rgba(61, 139, 253, 0.03); }
.dim-search::placeholder { color: var(--text-muted); }

.dim-list-scroll {
  max-height: 320px;
  overflow-y: auto;
}

.dim-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  cursor: pointer;
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--text-secondary);
  border-bottom: 1px solid rgba(63, 101, 135, 0.04);
  transition: background 0.1s;
}
.dim-list-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.dim-list-item.dim-list-item--active {
  background: var(--accent-blue-dim);
  color: var(--accent-blue);
  font-weight: 600;
}

.dim-list-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.dim-list-item-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  margin-left: 8px;
  flex-shrink: 0;
}

.dim-list-item--active .dim-list-item-count { color: var(--accent-blue); }

.dim-list-toggle.btn-tiny { font-size: 9px; }

/* Location section */
.card-head--toggle {
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.card-head--toggle::-webkit-details-marker { display: none; }

.location-body { padding: 0; }

.location-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  border-top: 1px solid rgba(63, 101, 135, 0.08);
}

.dim-col { border-right: 1px solid rgba(63, 101, 135, 0.06); }
.dim-col:last-child { border-right: none; }

.dim-col-label {
  display: block;
  padding: 8px 14px 4px;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-muted);
}

.dim-col .dim-search { padding: 6px 14px; font-size: 11px; }
.dim-col .dim-list-scroll { max-height: 360px; }
```

- [ ] **Step 2: Commit**

```bash
git add demo/demo.css
git commit -m "feat(demo): add searchable list and location section styles"
```

---

### Task 3: JS — Core infrastructure: filter splitting, dim list state, renderDimList

**Files:**
- Modify: `demo/demo.js`

- [ ] **Step 1: Add location constants**

After `CUBE_DIMENSIONS_LIVE`, add:

```js
var CUBE_DIMENSIONS_LOCATION = [
  'semantic_events.event',
  'semantic_events.dimensions_customer_country',
  'semantic_events.location_region',
  'semantic_events.location_division',
  'semantic_events.location_label',
  'semantic_events.location_municipality',
  'semantic_events.location_locality',
  'semantic_events.location_postal_code',
];
```

Add to `GROUP_IDS`:

```js
locationLabels: 'locationLabels',
municipalities: 'municipalities',
localities: 'localities',
postalCodes: 'postalCodes',
```

Add to `FILTERABLE_FIELDS`: `FIELDS.municipality`, `FIELDS.locality`, `FIELDS.postal_code`, `FIELDS.location_label`.

Add to `createEmptyFilterState()`: `[FIELDS.municipality]: [], [FIELDS.locality]: [], [FIELDS.postal_code]: [], [FIELDS.location_label]: []`.

Add to `GROUP_FILTER_FIELDS`:

```js
[GROUP_IDS.locationLabels]: FIELDS.location_label,
[GROUP_IDS.municipalities]: FIELDS.municipality,
[GROUP_IDS.localities]: FIELDS.locality,
[GROUP_IDS.postalCodes]: FIELDS.postal_code,
```

- [ ] **Step 2: Add `buildFiltersForWorker(dimensions)`**

This is the critical filter-splitting function. It wraps `buildDashboardFilters()` and strips out fields the worker doesn't have:

```js
function buildFiltersForWorker(dimensions) {
  var allFilters = buildDashboardFilters();
  var result = {};
  var dimSet = new Set(dimensions);
  for (var field in allFilters) {
    if (dimSet.has(field)) {
      result[field] = allFilters[field];
    }
  }
  return result;
}
```

- [ ] **Step 3: Add location state to `state`**

```js
locationRuntime: null,
locationReady: false,
locationLoadToken: 0,
locationOpen: false,
```

- [ ] **Step 4: Add unified `dimListStates` map and `renderDimList()`**

```js
var DIM_LIST_PAGE = 80;
var dimListStates = {};

function getDimListState(groupId) {
  if (!dimListStates[groupId]) {
    dimListStates[groupId] = { offset: 0, loading: false, token: 0, lastSearch: '' };
  }
  return dimListStates[groupId];
}

function renderDimList(container, entries, filterField, options) {
  var activeSet = new Set(state.filters[filterField] || []);
  var append = options && options.append;
  var rows = groupEntries(entries);
  var fragment = document.createDocumentFragment();

  for (var i = 0; i < rows.length; i++) {
    var entry = rows[i];
    if (!isVisibleGroupEntry(entry)) continue;
    var item = document.createElement('div');
    item.className = 'dim-list-item' + (activeSet.has(entry.key) ? ' dim-list-item--active' : '');
    item.dataset.filterField = filterField;
    item.dataset.filterValue = String(entry.key);

    var label = document.createElement('span');
    label.className = 'dim-list-item-label';
    label.textContent = String(entry.key);

    var count = document.createElement('span');
    count.className = 'dim-list-item-count';
    count.textContent = formatCompactNumber(groupEntryCount(entry));

    item.appendChild(label);
    item.appendChild(count);
    fragment.appendChild(item);
  }

  if (append) {
    container.appendChild(fragment);
  } else {
    container.replaceChildren(fragment);
  }
  return rows.filter(isVisibleGroupEntry).length;
}
```

Note: NO re-sorting — trusts server sort order from the `groups()` API.

- [ ] **Step 5: Add DOM refs for list panels and location section**

In `cacheDom()`, add all new refs: `ccListPanel`, `ccSearch`, `ccList`, `regionListPanel`, `regionSearch`, `regionList`, `divListPanel`, `divSearch`, `divList`, `locStatusBadge`, `locLabelSearch`, `locLabelList`, `locMuniSearch`, `locMuniList`, `locLocalitySearch`, `locLocalityList`, `locPostalSearch`, `locPostalList`.

- [ ] **Step 6: Commit**

```bash
node -c demo/demo.js
git add demo/demo.js
git commit -m "feat(demo): filter splitting, dim list state, renderDimList infrastructure"
```

---

### Task 4: JS — Searchable lists for main worker chart cards

**Files:**
- Modify: `demo/demo.js`

- [ ] **Step 1: Add `searchDimList()` and `loadMoreDimList()` for main worker**

```js
var MAIN_DIM_LIST_CONFIGS = [
  { groupId: 'customerCountries', field: FIELDS.customer_country, listId: 'ccList', searchId: 'ccSearch', panelId: 'ccListPanel' },
  { groupId: 'regions', field: FIELDS.region, listId: 'regionList', searchId: 'regionSearch', panelId: 'regionListPanel' },
  { groupId: 'divisions', field: FIELDS.division, listId: 'divList', searchId: 'divSearch', panelId: 'divListPanel' },
];

function getMainDimListCfg(groupId) {
  for (var i = 0; i < MAIN_DIM_LIST_CONFIGS.length; i++) {
    if (MAIN_DIM_LIST_CONFIGS[i].groupId === groupId) return MAIN_DIM_LIST_CONFIGS[i];
  }
  return null;
}

async function searchMainDimList(groupId) {
  if (!state.runtime || !state.ready) return;
  var cfg = getMainDimListCfg(groupId);
  if (!cfg) return;
  var ls = getDimListState(groupId);
  var search = (dom[cfg.searchId].value || '').trim();
  var token = ++ls.token;
  ls.lastSearch = search;
  ls.loading = true;

  try {
    var result = await state.runtime.groups({
      groups: {
        [groupId]: {
          includeKeys: selectedGroupKeys(groupId),
          includeTotals: true,
          limit: DIM_LIST_PAGE,
          nonEmptyKeys: true,
          search: search,
          sort: 'desc',
          sortMetric: COUNT_METRIC_ID,
        },
      },
    });
    if (ls.token !== token) return;
    var rendered = renderDimList(dom[cfg.listId], result[groupId], cfg.field);
    ls.offset = rendered;
  } catch (err) {
    if (state.runtime) appendLog('List search failed: ' + (err.message || err));
  } finally {
    ls.loading = false;
  }
}

async function loadMoreMainDimList(groupId) {
  var ls = getDimListState(groupId);
  if (ls.loading || !state.runtime || !state.ready) return;
  var cfg = getMainDimListCfg(groupId);
  if (!cfg) return;
  ls.loading = true;

  try {
    var result = await state.runtime.groups({
      groups: {
        [groupId]: {
          includeKeys: selectedGroupKeys(groupId),
          includeTotals: false,
          limit: DIM_LIST_PAGE,
          offset: ls.offset,
          nonEmptyKeys: true,
          search: ls.lastSearch,
          sort: 'desc',
          sortMetric: COUNT_METRIC_ID,
        },
      },
    });
    var rendered = renderDimList(dom[cfg.listId], result[groupId], cfg.field, { append: true });
    ls.offset += rendered;
  } catch (err) {
    if (state.runtime) appendLog('List scroll load failed: ' + (err.message || err));
  } finally {
    ls.loading = false;
  }
}
```

- [ ] **Step 2: Add event listeners in `attachControlListeners()`**

```js
// List panel toggles
document.querySelectorAll('.dim-list-toggle').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var panel = dom[btn.dataset.target.replace(/-/g, '') + ''] || document.getElementById(btn.dataset.target);
    if (!panel) return;
    panel.hidden = !panel.hidden;
    btn.textContent = panel.hidden ? 'List' : 'Chart';
    if (!panel.hidden) {
      // Find which groupId this panel belongs to and refresh
      for (var i = 0; i < MAIN_DIM_LIST_CONFIGS.length; i++) {
        if (MAIN_DIM_LIST_CONFIGS[i].panelId === btn.dataset.target.replace(/-/g, '')) {
          searchMainDimList(MAIN_DIM_LIST_CONFIGS[i].groupId);
          break;
        }
      }
    }
  });
});

// Search inputs — debounced
MAIN_DIM_LIST_CONFIGS.forEach(function (cfg) {
  var timer = 0;
  dom[cfg.searchId].addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { searchMainDimList(cfg.groupId); }, 120);
  });
});

// Delegated click on dim list items (shared for main + location)
document.addEventListener('click', function (event) {
  var item = event.target.closest('.dim-list-item');
  if (!item || !item.dataset.filterField) return;
  toggleArrayFilterValue(item.dataset.filterField, item.dataset.filterValue);
  scheduleRefresh(true);
});

// Infinite scroll on main list panels
MAIN_DIM_LIST_CONFIGS.forEach(function (cfg) {
  dom[cfg.listId].addEventListener('scroll', function () {
    var el = dom[cfg.listId];
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 40) return;
    loadMoreMainDimList(cfg.groupId);
  });
});
```

Note: The delegated click handler on `document` handles BOTH main and location list items — any `.dim-list-item` with `data-filter-field` triggers `toggleArrayFilterValue` + `scheduleRefresh`.

- [ ] **Step 3: Refresh visible list panels after snapshot renders**

In `renderSnapshot()`, after charts render, add:

```js
// Refresh any open list panels
MAIN_DIM_LIST_CONFIGS.forEach(function (cfg) {
  if (dom[cfg.panelId] && !dom[cfg.panelId].hidden) {
    searchMainDimList(cfg.groupId);
  }
});
```

- [ ] **Step 4: Commit**

```bash
node -c demo/demo.js
git add demo/demo.js
git commit -m "feat(demo): searchable infinite-scroll lists for main dimension cards"
```

---

### Task 5: JS — Location worker lazy-load + cross-filter sync

**Files:**
- Modify: `demo/demo.js`

- [ ] **Step 1: Update `refreshView()` to use `buildFiltersForWorker()`**

Replace `filters: buildDashboardFilters()` in `refreshView()` with:

```js
var mainDims = getActiveRuntimeDimensions();
var filters = buildFiltersForWorker(mainDims);
```

Also, after the main result renders, sync to location worker:

```js
if (state.locationRuntime && state.locationReady) {
  var locDims = buildLocationDimensions();
  state.locationRuntime.updateFilters(buildFiltersForWorker(locDims)).then(function () {
    if (state.locationOpen) refreshLocationLists();
  });
}
```

- [ ] **Step 2: Add location worker build functions**

```js
function buildLocationLiveSources() {
  var poiFilter = { dimension: 'semantic_events.location_type', operator: 'equals', values: ['POI'] };
  var stayEndedFilter = { dimension: 'semantic_events.event', operator: 'equals', values: ['Stay Ended'] };
  var granularity = state.timeGranularity;
  var query = {
    format: 'arrow',
    query: {
      dimensions: CUBE_DIMENSIONS_LOCATION,
      filters: [poiFilter, stayEndedFilter],
      limit: 50000000,
      measures: CUBE_MEASURES_LIVE,
      timeDimensions: [{ dimension: CUBE_TIME_DIMENSION, granularity: granularity }],
      timezone: 'UTC',
    },
  };
  return {
    primaryQuery: query,
    sources: [{
      dataFetchInit: { body: JSON.stringify(query), headers: { 'Content-Type': 'application/json' }, method: 'POST' },
      dataUrl: CUBE_API,
      id: 'location',
      projection: {
        rename: {
          'semantic_events.count': FIELDS.count, semantic_events__count: FIELDS.count,
          [cubeTimeField(granularity)]: FIELDS.time,
          [cubeTimeField('minute')]: FIELDS.time, [cubeTimeField('hour')]: FIELDS.time,
          [cubeTimeField('day')]: FIELDS.time, [cubeTimeField('week')]: FIELDS.time,
          [cubeTimeField('month')]: FIELDS.time,
        },
        transforms: { [FIELDS.count]: 'number', [FIELDS.time]: 'timestampMs' },
      },
      role: 'base',
    }],
  };
}

function buildLocationDimensions() {
  return [
    FIELDS.event, FIELDS.customer_country, FIELDS.region, FIELDS.division,
    FIELDS.location_label, FIELDS.municipality, FIELDS.locality, FIELDS.postal_code,
    FIELDS.time,
  ];
}

function buildLocationGroupSpecs() {
  var countMetric = [createCountMetric()];
  return [
    { field: FIELDS.location_label, id: GROUP_IDS.locationLabels, metrics: countMetric },
    { field: FIELDS.municipality, id: GROUP_IDS.municipalities, metrics: countMetric },
    { field: FIELDS.locality, id: GROUP_IDS.localities, metrics: countMetric },
    { field: FIELDS.postal_code, id: GROUP_IDS.postalCodes, metrics: countMetric },
  ];
}

function buildLocationWorkerOptions() {
  var live = buildLocationLiveSources();
  return Object.assign({}, WORKER_ASSETS, {
    batchCoalesceRows: 65536,
    dimensions: buildLocationDimensions(),
    emitSnapshots: false,
    groups: buildLocationGroupSpecs(),
    kpis: [],
    progressThrottleMs: 100,
    sources: live.sources,
    wasm: true,
  });
}
```

- [ ] **Step 3: Add `loadLocationWorker()` and `disposeLocationRuntime()`**

Location worker uses `loc-status-badge` for progress — NOT the shared popover:

```js
async function loadLocationWorker() {
  if (state.locationRuntime) return;
  if (state.dataSource !== 'live') {
    // File mode: main worker has all dims, just refresh lists
    state.locationReady = true;
    dom.locStatusBadge.textContent = 'Using main worker';
    refreshLocationLists();
    return;
  }

  var loadToken = ++state.locationLoadToken;
  dom.locStatusBadge.textContent = 'Loading...';
  appendLog('Loading location worker...');

  try {
    var runtime = await crossfilter.createStreamingDashboardWorker(buildLocationWorkerOptions());
    if (loadToken !== state.locationLoadToken) { await runtime.dispose(); return; }
    state.locationRuntime = runtime;

    runtime.on('progress', function (p) {
      var rows = p.load ? p.load.rowsLoaded : 0;
      dom.locStatusBadge.textContent = rows > 0 ? formatNumber(rows) + ' rows...' : 'Loading...';
    });

    var ready = await runtime.ready;
    if (loadToken !== state.locationLoadToken) { await runtime.dispose(); return; }

    state.locationReady = true;
    var rows = ready.load ? ready.load.rowsLoaded : 0;
    dom.locStatusBadge.textContent = formatNumber(rows) + ' rows';
    appendLog('Location worker ready: ' + formatNumber(rows) + ' rows');

    // Apply current filters and render
    var locDims = buildLocationDimensions();
    await state.locationRuntime.updateFilters(buildFiltersForWorker(locDims));
    refreshLocationLists();
  } catch (err) {
    dom.locStatusBadge.textContent = 'Load failed';
    appendLog('Location worker failed: ' + (err.message || err));
  }
}

async function disposeLocationRuntime() {
  state.locationLoadToken++;
  state.locationReady = false;
  if (state.locationRuntime) {
    try { await state.locationRuntime.dispose(); } catch (_) {}
  }
  state.locationRuntime = null;
}
```

- [ ] **Step 4: Add `refreshLocationLists()` with search support**

```js
var LOC_LIST_CONFIGS = [
  { groupId: 'locationLabels', field: FIELDS.location_label, listId: 'locLabelList', searchId: 'locLabelSearch' },
  { groupId: 'municipalities', field: FIELDS.municipality, listId: 'locMuniList', searchId: 'locMuniSearch' },
  { groupId: 'localities', field: FIELDS.locality, listId: 'locLocalityList', searchId: 'locLocalitySearch' },
  { groupId: 'postalCodes', field: FIELDS.postal_code, listId: 'locPostalList', searchId: 'locPostalSearch' },
];

function getLocationRuntime() {
  // File mode: use main worker. Live mode: use dedicated location worker.
  return state.dataSource === 'live' ? state.locationRuntime : state.runtime;
}

async function refreshLocationLists() {
  var rt = getLocationRuntime();
  if (!rt || !state.locationReady) return;
  var groups = {};
  for (var i = 0; i < LOC_LIST_CONFIGS.length; i++) {
    var cfg = LOC_LIST_CONFIGS[i];
    var search = (dom[cfg.searchId].value || '').trim();
    var ls = getDimListState(cfg.groupId);
    ls.lastSearch = search;
    groups[cfg.groupId] = {
      includeTotals: true, limit: DIM_LIST_PAGE, nonEmptyKeys: true,
      search: search, sort: 'desc', sortMetric: COUNT_METRIC_ID,
    };
  }
  try {
    var result = await rt.groups({ groups: groups });
    for (var j = 0; j < LOC_LIST_CONFIGS.length; j++) {
      var c = LOC_LIST_CONFIGS[j];
      var ls2 = getDimListState(c.groupId);
      var rendered = renderDimList(dom[c.listId], result[c.groupId], c.field);
      ls2.offset = rendered;
    }
  } catch (err) {
    appendLog('Location list refresh failed: ' + (err.message || err));
  }
}

async function searchLocDimList(groupId) {
  var cfg = null;
  for (var i = 0; i < LOC_LIST_CONFIGS.length; i++) {
    if (LOC_LIST_CONFIGS[i].groupId === groupId) { cfg = LOC_LIST_CONFIGS[i]; break; }
  }
  if (!cfg) return;
  var rt = getLocationRuntime();
  if (!rt) return;
  var ls = getDimListState(groupId);
  var search = (dom[cfg.searchId].value || '').trim();
  var token = ++ls.token;
  ls.lastSearch = search;
  ls.loading = true;
  try {
    var result = await rt.groups({
      groups: { [groupId]: { includeTotals: true, limit: DIM_LIST_PAGE, nonEmptyKeys: true, search: search, sort: 'desc', sortMetric: COUNT_METRIC_ID } },
    });
    if (ls.token !== token) return;
    var rendered = renderDimList(dom[cfg.listId], result[groupId], cfg.field);
    ls.offset = rendered;
  } catch (err) {
    appendLog('Location search failed: ' + (err.message || err));
  } finally {
    ls.loading = false;
  }
}

async function loadMoreLocDimList(groupId) {
  var ls = getDimListState(groupId);
  if (ls.loading) return;
  var cfg = null;
  for (var i = 0; i < LOC_LIST_CONFIGS.length; i++) {
    if (LOC_LIST_CONFIGS[i].groupId === groupId) { cfg = LOC_LIST_CONFIGS[i]; break; }
  }
  if (!cfg) return;
  var rt = getLocationRuntime();
  if (!rt) return;
  ls.loading = true;
  try {
    var result = await rt.groups({
      groups: { [groupId]: { includeTotals: false, limit: DIM_LIST_PAGE, offset: ls.offset, nonEmptyKeys: true, search: ls.lastSearch, sort: 'desc', sortMetric: COUNT_METRIC_ID } },
    });
    var rendered = renderDimList(dom[cfg.listId], result[groupId], cfg.field, { append: true });
    ls.offset += rendered;
  } catch (err) {
    appendLog('Location scroll load failed: ' + (err.message || err));
  } finally {
    ls.loading = false;
  }
}
```

- [ ] **Step 5: Wire location section toggle + search + scroll listeners**

In `attachControlListeners()`:

```js
// Location section toggle
var locationSection = document.getElementById('location-section');
if (locationSection) {
  locationSection.addEventListener('toggle', function () {
    state.locationOpen = locationSection.open;
    if (locationSection.open && !state.locationReady) {
      loadLocationWorker();
    } else if (locationSection.open && state.locationReady) {
      refreshLocationLists();
    }
  });
}

// Location search inputs — debounced
LOC_LIST_CONFIGS.forEach(function (cfg) {
  var timer = 0;
  dom[cfg.searchId].addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(function () { searchLocDimList(cfg.groupId); }, 120);
  });
});

// Location infinite scroll
LOC_LIST_CONFIGS.forEach(function (cfg) {
  dom[cfg.listId].addEventListener('scroll', function () {
    var el = dom[cfg.listId];
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 40) return;
    loadMoreLocDimList(cfg.groupId);
  });
});
```

- [ ] **Step 6: Dispose location worker + re-trigger on granularity change**

In `disposeRuntime()`, add `await disposeLocationRuntime();`.

After `loadSource()` completes (at end of the function, after `setLoading(false)`), add:

```js
// Re-trigger location worker if section was open
if (state.locationOpen) {
  loadLocationWorker();
}
```

In the source-switch click handler, add:

```js
state.locationOpen = false;
var locSection = document.getElementById('location-section');
if (locSection) locSection.open = false;
dom.locStatusBadge.textContent = 'Expand to load';
```

- [ ] **Step 7: File-mode: include location groups in main worker's buildGroupSpecs**

In `buildGroupSpecs()`, conditionally include location groups for file mode:

```js
function buildGroupSpecs(options) {
  // ... existing code ...
  var specs = [
    { field: FIELDS.event, id: GROUP_IDS.events, metrics: countMetric },
    { field: FIELDS.customer_country, id: GROUP_IDS.customerCountries, metrics: countMetric },
    { field: FIELDS.region, id: GROUP_IDS.regions, metrics: countMetric },
    { field: FIELDS.division, id: GROUP_IDS.divisions, metrics: countMetric },
  ];
  // File mode includes location groups (main worker has all dims)
  if (state.dataSource !== 'live') {
    specs.push(
      { field: FIELDS.location_label, id: GROUP_IDS.locationLabels, metrics: countMetric },
      { field: FIELDS.municipality, id: GROUP_IDS.municipalities, metrics: countMetric },
      { field: FIELDS.locality, id: GROUP_IDS.localities, metrics: countMetric },
      { field: FIELDS.postal_code, id: GROUP_IDS.postalCodes, metrics: countMetric }
    );
  }
  return specs.concat(timelineGranularities.map(/* ... existing ... */));
}
```

- [ ] **Step 8: Verify syntax and commit**

```bash
node -c demo/demo.js
git add demo/demo.js demo/index.html demo/demo.css
git commit -m "feat(demo): lazy-load location worker with cross-filter sync and searchable lists"
```

---

## Verification

1. `node demo/proxy-server.mjs` → open `http://localhost:3333/demo/index.html`
2. Dashboard loads with Live API badge, 3 chart cards
3. Click "List" on Customer Countries → list panel opens with searchable infinite-scroll list
4. Type in search → list filters in real-time
5. Scroll to bottom → more items load (80 at a time)
6. Click a country in the list → filter chip appears, all charts + table update, list highlights active item
7. Open "Location Details" section → badge shows "Loading..." then row count
8. Location worker loads → 4 searchable lists appear (Location, Municipality, Locality, Postal Code)
9. Type in location search → filters list
10. Click a municipality → filter chip appears, main charts update, location lists update
11. Click a region bar in main chart → location lists update to show only locations in that region
12. Change granularity → main worker reloads, location worker disposed. If section was open, location worker reloads at new granularity
13. Switch to file mode → location section uses main worker directly, no second API call
14. "Clear All" resets all filters including location ones, keeps Stay Ended default
