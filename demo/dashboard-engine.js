// demo/dashboard-engine.js
// Core engine: reads config JSON, fetches cube metadata, generates DOM,
// wires crossfilter. Dashboard name comes from the URL path:
//   /demo/dashboards/bluecar-stays → fetches dashboards/bluecar-stays.json

import {
  fetchCubeMeta,
  buildCubeRegistry,
  inferChartType,
  inferLabel,
  inferFilterMode,
  discoverBooleanDimensions,
  extractModelMeta,
  resolveModelPeriod,
  resolveTypicalRange,
  inferPeriodPresets,
  getGranularityOptions,
  getDefaultGranularity,
  getGranularityNotes,
  granularityLabel,
} from './dashboard-meta.js';
import {
  registerDemoEChartsTheme,
  getDemoEChartsThemeName,
} from './echarts-theme.js';
import { createDashboardData } from './dashboard-data.js';
import { getChartType, typesByFamily } from './chart-types.js';

var echarts = globalThis.echarts;
var crossfilter = globalThis.crossfilter;

// ── Shared Helpers ────────────────────────────────────────────────────

function titleCase(str) {
  str = String(str || '');
  return str.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function afterUpdate(el, fn) {
  if (el.updateComplete) el.updateComplete.then(fn);
  else setTimeout(fn, 100);
}

function buildToggleHtml(dimension) {
  var dim = escapeHtml(dimension);
  return '<div class="toggle-component" data-dim="' + dim + '">' +
    // Expanded view: full 3-button group (shown when container is wide)
    '<sl-button-group class="toggle-expanded">' +
      '<sl-button size="small" data-toggle="' + dim + '" data-val="true">Yes</sl-button>' +
      '<sl-button size="small" data-toggle="' + dim + '" data-val="false">No</sl-button>' +
      '<sl-button size="small" variant="primary" data-toggle="' + dim + '" data-val="all">All</sl-button>' +
    '</sl-button-group>' +
    // Compact view: single button showing active value + chevron (shown when container is narrow)
    '<div class="toggle-compact">' +
      '<button class="toggle-compact-trigger" data-dim="' + dim + '">' +
        '<span class="toggle-compact-value">All</span>' +
        '<span class="toggle-compact-chevron">&#9662;</span>' +
      '</button>' +
      '<div class="toggle-compact-menu">' +
        '<button class="toggle-compact-option" data-toggle="' + dim + '" data-val="true">Yes</button>' +
        '<button class="toggle-compact-option" data-toggle="' + dim + '" data-val="false">No</button>' +
        '<button class="toggle-compact-option toggle-compact-option--active" data-toggle="' + dim + '" data-val="all">All</button>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function syncToggleCompact(component, activeVal) {
  var trigger = component.querySelector('.toggle-compact-value');
  if (trigger) {
    var labels = { 'true': 'Yes', 'false': 'No', 'all': 'All' };
    trigger.textContent = labels[activeVal] || activeVal;
  }
  var opts = component.querySelectorAll('.toggle-compact-option');
  for (var i = 0; i < opts.length; ++i) {
    if (opts[i].dataset.val === activeVal) {
      opts[i].classList.add('toggle-compact-option--active');
    } else {
      opts[i].classList.remove('toggle-compact-option--active');
    }
  }
}

function wireToggleClicks(container) {
  // Expanded view: sl-button clicks
  container.addEventListener('click', function (e) {
    var btn = e.target.closest('sl-button[data-toggle]');
    if (btn) {
      var dim = btn.dataset.toggle;
      var group = btn.closest('sl-button-group');
      if (group) {
        var siblings = group.querySelectorAll('sl-button[data-toggle="' + dim + '"]');
        for (var i = 0; i < siblings.length; ++i) siblings[i].variant = 'default';
      }
      btn.variant = 'primary';
      var component = btn.closest('.toggle-component');
      if (component) syncToggleCompact(component, btn.dataset.val);
      setFilter(dim, btn.dataset.val === 'all' ? null : btn.dataset.val);
      return;
    }

    // Compact view: trigger click opens/closes menu
    var trigger = e.target.closest('.toggle-compact-trigger');
    if (trigger) {
      var menu = trigger.nextElementSibling;
      if (menu) menu.classList.toggle('toggle-compact-menu--open');
      return;
    }

    // Compact view: option click selects value
    var opt = e.target.closest('.toggle-compact-option');
    if (opt) {
      var dim2 = opt.dataset.toggle;
      var val = opt.dataset.val;
      // Sync expanded view
      var comp = opt.closest('.toggle-component');
      if (comp) {
        var expBtns = comp.querySelectorAll('sl-button[data-toggle="' + dim2 + '"]');
        for (var j = 0; j < expBtns.length; ++j) {
          expBtns[j].variant = expBtns[j].dataset.val === val ? 'primary' : 'default';
        }
        syncToggleCompact(comp, val);
      }
      // Close menu
      var menu2 = opt.closest('.toggle-compact-menu');
      if (menu2) menu2.classList.remove('toggle-compact-menu--open');
      setFilter(dim2, val === 'all' ? null : val);
    }
  });

  // Close compact menus on outside click
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.toggle-compact')) {
      var openMenus = document.querySelectorAll('.toggle-compact-menu--open');
      for (var k = 0; k < openMenus.length; ++k) {
        openMenus[k].classList.remove('toggle-compact-menu--open');
      }
    }
  });
}

function resetToggleGroup(dim) {
  var firstBtn = document.querySelector('sl-button[data-toggle="' + dim + '"]');
  if (!firstBtn) return;
  var group = firstBtn.closest('sl-button-group');
  if (!group) return;
  var btns = group.querySelectorAll('sl-button[data-toggle="' + dim + '"]');
  for (var i = 0; i < btns.length; ++i) {
    btns[i].variant = btns[i].dataset.val === 'all' ? 'primary' : 'default';
  }
  var component = firstBtn.closest('.toggle-component');
  if (component) syncToggleCompact(component, 'all');
}

function getDimDescription(registry, name) {
  var dim = registry.dimensions[name];
  return dim && dim.description ? dim.description : null;
}

// ── URL State (Principle 3: bookmarkable) ─────────────────────────────

function readUrlState() {
  var params = new URLSearchParams(window.location.search);
  var state = {};
  params.forEach(function (value, key) {
    if (state[key]) {
      if (!Array.isArray(state[key])) state[key] = [state[key]];
      state[key].push(value);
    } else {
      state[key] = value;
    }
  });
  return state;
}

function writeUrlState(state) {
  var params = new URLSearchParams();
  var keys = Object.keys(state);
  for (var i = 0; i < keys.length; ++i) {
    var key = keys[i];
    var val = state[key];
    if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) continue;
    if (Array.isArray(val)) {
      for (var j = 0; j < val.length; ++j) params.append(key, val[j]);
    } else {
      params.set(key, val);
    }
  }
  var qs = params.toString();
  var newUrl = window.location.pathname + (qs ? '?' + qs : '');
  window.history.replaceState(null, '', newUrl);
}

// ── Filter State ──────────────────────────────────────────────────────
// Two-tier filtering:
//   Tier 1 (client): dimension is in the crossfilter worker → instant filter
//   Tier 2 (server): dimension is NOT in the worker → reload with Cube query.filters

var filterState = {};
var filterListeners = [];
var _dashboardData = null;        // set by main() after worker creation
var _dashboardRegistry = null;    // set by main() for re-render after reload
var _dashboardPanels = null;      // set by main() for re-render after reload

function setFilter(dimension, values) {
  if (!values || (Array.isArray(values) && values.length === 0)) {
    delete filterState[dimension];
  } else {
    filterState[dimension] = values;
  }
  writeUrlState(filterState);
  renderFilterChips();

  // Route to correct tier
  if (dimension === '_breakdown') {
    triggerBreakdownChange();
  } else if (dimension === '_timeChart') {
    notifyFilterChange();  // viz change is render-only, no data change
  } else if (isServerTrigger(dimension)) {
    triggerServerReload();
  } else {
    notifyFilterChange();
  }
}

function clearAllFilters() {
  var hadServerDims = false;
  var hadBreakdown = !!filterState['_breakdown'];
  var keys = Object.keys(filterState);
  for (var k = 0; k < keys.length; ++k) {
    if (isServerTrigger(keys[k])) { hadServerDims = true; break; }
  }

  filterState = {};
  writeUrlState(filterState);
  renderFilterChips();
  // Reset Shoelace selects
  var selects = document.querySelectorAll('sl-select[data-dropdown-id]');
  for (var i = 0; i < selects.length; ++i) {
    selects[i].value = selects[i].multiple ? [] : '';
  }
  // Reset all toggle buttons
  var allToggleBtns = document.querySelectorAll('sl-button[data-toggle]');
  var resetDims = {};
  for (var j = 0; j < allToggleBtns.length; ++j) {
    var d = allToggleBtns[j].dataset.toggle;
    if (!resetDims[d]) { resetToggleGroup(d); resetDims[d] = true; }
  }

  if (hadBreakdown) triggerBreakdownChange();
  if (hadServerDims) {
    triggerServerReload();
  } else {
    notifyFilterChange();
  }
}

function notifyFilterChange() {
  for (var i = 0; i < filterListeners.length; ++i) filterListeners[i](filterState);
}

// ── Tier 2: Server-side reload ────────────────────────────────────────
// Collects active server-side filter values from filterState,
// disposes the old worker, creates a new one with updated Cube query.
//
// Special filter keys (internal UI IDs, not cube dimensions):
//   _focus       → segments (cube segment activation)
//   _include     → boolean presets (filter boolean dims to true)
//   _granularity → time bucketing granularity
//   time dims    → period date range

// All keys that are internal UI controls, not cube dimension names
var SERVER_CONTROL_KEYS = { _focus: true, _include: true, _granularity: true, _period: true };

function isServerTrigger(dim) {
  if (SERVER_CONTROL_KEYS[dim]) return true;
  if (_dashboardData && _dashboardData.isServerDim(dim)) return true;
  // Time dimensions are in the worker now (for brush filtering).
  // Period picker uses _period key to trigger reload, not the dim name.
  return false;
}

function buildServerState() {
  var serverFilters = {};
  var segments = [];
  var granularity = null;
  var dateRange = null;
  var timeDims = _dashboardData ? _dashboardData.timeDims : [];
  var keys = Object.keys(filterState);

  for (var i = 0; i < keys.length; ++i) {
    var dim = keys[i];
    var val = filterState[dim];

    // Segments: _focus contains selected segment names
    if (dim === '_focus') {
      var segVals = Array.isArray(val) ? val : [val];
      for (var sv = 0; sv < segVals.length; ++sv) segments.push(segVals[sv]);
      continue;
    }

    // Boolean presets: _include contains boolean dim names to filter as true
    if (dim === '_include') {
      var inclVals = Array.isArray(val) ? val : [val];
      for (var iv = 0; iv < inclVals.length; ++iv) {
        serverFilters[inclVals[iv]] = { operator: 'equals', values: ['true'] };
      }
      continue;
    }

    // Granularity: _granularity contains the selected granularity id
    if (dim === '_granularity') {
      granularity = val;
      continue;
    }

    // Period: _period contains date range [from, to] for timeDimensions
    if (dim === '_period' && Array.isArray(val) && val.length === 2) {
      dateRange = val;
      continue;
    }

    // UI-only state keys — not Cube filters
    if (dim === '_timeChart' || dim === '_breakdown') continue;

    // Regular server-side dimension filter
    if (!_dashboardData || !_dashboardData.isServerDim(dim)) continue;

    if (val === 'true' || val === true) {
      serverFilters[dim] = { operator: 'equals', values: ['true'] };
    } else if (val === 'false' || val === false) {
      serverFilters[dim] = { operator: 'equals', values: ['false'] };
    } else if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number') {
      serverFilters[dim] = [
        { operator: 'gte', values: [String(val[0])] },
        { operator: 'lte', values: [String(val[1])] },
      ];
    } else {
      var values = Array.isArray(val) ? val : [val];
      serverFilters[dim] = { operator: 'equals', values: values.map(String) };
    }
  }

  var state = { filters: serverFilters };
  if (segments.length) state.segments = segments;
  if (granularity) state.granularity = granularity;
  if (dateRange) state.dateRange = dateRange;
  return state;
}

var _reloadSeq = 0;
var _reloadDebounce = 0;
var _progressOverlay = null;  // set by main()
var _progressCard = null;     // set by main()

function showReloadProgress(status) {
  if (!_progressOverlay) return;
  _progressOverlay.classList.remove('progress-overlay--done');
  if (!_progressOverlay.parentNode) document.body.appendChild(_progressOverlay);
  _progressCard.innerHTML =
    '<div class="progress-step progress-step--active">' +
      '<span class="progress-dot"></span>' +
      '<span>' + escapeHtml(status) + '</span>' +
    '</div>';
}

function hideReloadProgress() {
  if (!_progressOverlay) return;
  _progressOverlay.classList.add('progress-overlay--done');
  setTimeout(function () { if (_progressOverlay.parentNode) _progressOverlay.remove(); }, 600);
}

function triggerServerReload() {
  if (!_dashboardData) return;

  // Debounce: range sliders and rapid changes get 300ms settle time
  clearTimeout(_reloadDebounce);
  _reloadDebounce = setTimeout(function () {
    executeServerReload();
  }, 300);
}

function executeServerReload() {
  var seq = ++_reloadSeq;
  var serverState = buildServerState();
  console.log('[dashboard] Server reload triggered:', JSON.stringify(serverState));

  showReloadProgress('Reloading data...');

  _dashboardData.reload(serverState).then(function(newData) {
    if (seq !== _reloadSeq) return;
    _dashboardData = newData;

    newData.on('progress', function(payload) {
      if (seq !== _reloadSeq) return;
      if (payload.status === 'downloading') {
        var pct = payload.fetch.percent;
        showReloadProgress(pct != null ? Math.round(pct * 100) + '% downloaded' : 'Downloading...');
      } else if (payload.status === 'streaming') {
        showReloadProgress(payload.load.rowsLoaded.toLocaleString() + ' rows loaded');
      }
    });

    newData.on('error', function(payload) {
      var msg = payload && payload.message ? payload.message : 'Reload failed';
      showReloadProgress(msg);
    });

    return newData.ready.then(function() {
      if (seq !== _reloadSeq) return;
      var clientFilters = {};
      var keys = Object.keys(filterState);
      for (var i = 0; i < keys.length; ++i) {
        var dim = keys[i];
        if (!SERVER_CONTROL_KEYS[dim] && !newData.isServerDim(dim)) {
          clientFilters[dim] = filterState[dim];
        }
      }
      return newData.query(clientFilters);
    });
  }).then(function(response) {
    if (seq !== _reloadSeq || !response) return;
    renderAllPanels(_dashboardPanels, response, _dashboardRegistry);
    hideReloadProgress();
  }).catch(function(err) {
    console.error('[dashboard] Server reload failed:', err);
    showReloadProgress('Reload failed: ' + err.message);
  });
}

// ── Breakdown: re-create worker with splitField ──────────────────────

function triggerBreakdownChange() {
  if (!_dashboardData) return;
  var breakdownId = filterState['_breakdown'];
  var breakdownDim = null;

  if (breakdownId) {
    for (var i = 0; i < _dashboardPanels.length; ++i) {
      if (_dashboardPanels[i].id === breakdownId) {
        breakdownDim = _dashboardPanels[i]._dimField;
        break;
      }
    }
  }

  console.log('[dashboard] Breakdown change:', breakdownDim || '(none)');

  _dashboardData.setBreakdown(breakdownDim).then(function() {
    // Build client filters (exclude server control keys)
    var clientFilters = {};
    var keys = Object.keys(filterState);
    for (var k = 0; k < keys.length; ++k) {
      var dim = keys[k];
      if (!SERVER_CONTROL_KEYS[dim] && !_dashboardData.isServerDim(dim)) {
        clientFilters[dim] = filterState[dim];
      }
    }
    return _dashboardData.query(clientFilters);
  }).then(function(response) {
    renderAllPanels(_dashboardPanels, response, _dashboardRegistry);
  }).catch(function(err) {
    console.error('[dashboard] Breakdown change failed:', err);
  });
}

// ── Normalize config format ───────────────────────────────────────────
// Accepts both the old flat format (panels[] + layout.sections[]) and
// the new nested format (sections[].panels[]) from the schema generator.
// Outputs the old flat format that the engine rendering pipeline expects.

function normalizeConfig(config) {
  // Already old format — has top-level panels[]
  if (config.panels && Array.isArray(config.panels)) return config;

  // New format — sections contain panels
  if (!config.sections || !Array.isArray(config.sections)) return config;

  // Check if sections have inline panels
  var hasInlinePanels = false;
  for (var i = 0; i < config.sections.length; ++i) {
    if (config.sections[i].panels && config.sections[i].panels.length > 0) {
      hasInlinePanels = true;
      break;
    }
  }
  if (!hasInlinePanels) return config;

  // Convert: extract panels from sections, add section reference
  var panels = [];
  var layoutSections = [];

  for (var s = 0; s < config.sections.length; ++s) {
    var section = config.sections[s];
    layoutSections.push({
      id: section.id,
      label: section.label || null,
      columns: section.columns || 3,
      collapsed: section.collapsed || false,
      location: section.location || null,
    });

    var sectionPanels = section.panels || [];
    for (var p = 0; p < sectionPanels.length; ++p) {
      var panel = Object.assign({}, sectionPanels[p]);
      panel.section = section.id;

      // Map chart-type slot fields to the engine's dimension/measure fields.
      // The new schema uses slot names (category, name, x, source, date,
      // region, lng, etc.) but the engine expects dimension/measure as the
      // primary field references. All slot fields are preserved on the panel
      // for chart-type-specific rendering.
      if (!panel.dimension) {
        panel.dimension = panel.category || panel.name || panel.x ||
          panel.source || panel.date || panel.region || panel.lng || null;
      }
      if (!panel.measure) {
        panel.measure = panel.value || panel.y || panel.size || null;
      }

      panels.push(panel);
    }
  }

  // Handle cube/cubes normalization
  var cube = config.cube;
  if (!cube && config.cubes && config.cubes.length > 0) {
    cube = config.cubes[0];
  }

  return {
    cube: cube || null,
    title: config.title || null,
    panels: panels,
    layout: { sections: layoutSections },
    modelBar: config.modelBar,
  };
}

// ── Resolve panel defaults from metadata ──────────────────────────────

function resolvePanels(config, registry) {
  var panels = config.panels || [];
  var resolved = [];
  for (var i = 0; i < panels.length; ++i) {
    var p = panels[i];
    var fieldName = p.dimension || p.measure || null;
    var chartType = p.chart || (fieldName ? inferChartType(fieldName, registry) : 'table');

    if (fieldName && !registry.dimensions[fieldName] && !registry.measures[fieldName]) {
      console.warn('[dashboard] Skipping panel — field "' + fieldName + '" not found in cube "' + registry.name + '"');
      continue;
    }

    // Copy all panel properties (preserves slot fields like source, target,
    // size, color, lng, lat, levels, axes, etc.) then apply defaults.
    var panel = {};
    var keys = Object.keys(p);
    for (var k = 0; k < keys.length; ++k) {
      if (p[keys[k]] != null) panel[keys[k]] = p[keys[k]];
    }

    // Apply defaults for core fields
    panel.id = p.id || (fieldName ? fieldName + '-' + i : 'panel-' + i);
    panel.dimension = p.dimension || null;
    panel.measure = p.measure || null;
    panel.chart = chartType;
    panel.label = p.label || (fieldName ? inferLabel(fieldName, registry) : chartType);
    panel.limit = p.limit || 10;
    panel.sort = p.sort || 'value';
    panel.filter = p.filter || (fieldName ? inferFilterMode(fieldName, registry) : 'none');
    panel.granularity = p.granularity || null;
    panel.op = p.op || 'count';
    panel.columns = p.columns || null;
    panel.section = p.section || '_default';
    panel.width = p.width || null;
    panel.collapsed = p.collapsed != null ? p.collapsed : false;
    panel.searchable = p.searchable || false;

    resolved.push(panel);
  }
  return resolved;
}

// ── Resolve layout sections ───────────────────────────────────────────

function resolveSections(config, resolvedPanels) {
  var layoutSections = config.layout && config.layout.sections || [];
  var sectionMap = {};
  for (var s = 0; s < layoutSections.length; ++s) {
    var sec = layoutSections[s];
    sectionMap[sec.id] = {
      id: sec.id,
      label: sec.label || null,
      columns: sec.columns || 3,
      collapsed: sec.collapsed || false,
      panels: [],
    };
  }

  for (var i = 0; i < resolvedPanels.length; ++i) {
    var p = resolvedPanels[i];
    if (!sectionMap[p.section]) {
      sectionMap[p.section] = { id: p.section, label: p.section, columns: 3, collapsed: false, panels: [] };
    }
    sectionMap[p.section].panels.push(p);
  }

  var ordered = [];
  var seen = {};
  for (var j = 0; j < layoutSections.length; ++j) {
    var id = layoutSections[j].id;
    if (sectionMap[id] && sectionMap[id].panels.length > 0) {
      ordered.push(sectionMap[id]);
      seen[id] = true;
    }
  }
  var keys = Object.keys(sectionMap);
  for (var k = 0; k < keys.length; ++k) {
    if (!seen[keys[k]] && sectionMap[keys[k]].panels.length > 0) {
      ordered.push(sectionMap[keys[k]]);
    }
  }
  return ordered;
}

// ── DOM Helpers ───────────────────────────────────────────────────────

var ACCENT_COLORS = ['green', 'blue', 'amber', 'red', 'purple'];

var _escapeEl = null;
function escapeHtml(str) {
  if (!_escapeEl) _escapeEl = document.createElement('div');
  _escapeEl.textContent = str;
  return _escapeEl.innerHTML;
}

// ── Measure value formatting (metadata-driven) ───────────────────────

function formatMeasureValue(value, meta) {
  if (value == null || value !== value) return '\u2014';
  if (!meta) return typeof value === 'number' ? value.toLocaleString() : String(value);
  if (meta.format === 'percent' || (meta.aggType === 'number' && /rate|percent/i.test(meta.description || ''))) {
    return (value * 100).toFixed(1) + '%';
  }
  if (/hours?/i.test(meta.description || '') || /duration.*hours/i.test(meta.fullName || '')) {
    return value.toFixed(1) + 'h';
  }
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(1);
}

// ── Chart Rendering (group data → ECharts) ───────────────────────────

var THEME_NAME = getDemoEChartsThemeName();

function renderBarChart(panelEl, panel, groupData) {
  var entries = groupData.entries || [];
  if (!entries.length) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  // Check if this dimension has an active filter
  var dim = panel._dimField;
  var activeFilter = dim ? filterState[dim] : null;
  var selectedSet = null;
  if (activeFilter) {
    var selectedArr = Array.isArray(activeFilter) ? activeFilter : [activeFilter];
    selectedSet = {};
    for (var sa = 0; sa < selectedArr.length; ++sa) selectedSet[String(selectedArr[sa])] = true;
  }

  var categories = [];
  var barData = [];
  for (var i = 0; i < entries.length; ++i) {
    var key = String(entries[i].key);
    categories.push(key);
    var item = { value: entries[i].value.value };
    if (selectedSet && !selectedSet[key]) {
      item.itemStyle = { opacity: 0.25 };
    }
    barData.push(item);
  }

  var chartDef = getChartType(panel.chart);
  var isHorizontal = chartDef && chartDef.ecOptions && chartDef.ecOptions._horizontal;

  var catAxis = {
    type: 'category',
    data: isHorizontal ? categories.slice().reverse() : categories,
    axisLabel: { interval: 0, rotate: !isHorizontal && categories.length > 6 ? 30 : 0 },
  };
  var valAxis = { type: 'value' };

  var option = {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
    },
    grid: { left: 10, right: 10, top: 10, bottom: 10, containLabel: true },
    xAxis: isHorizontal ? valAxis : catAxis,
    yAxis: isHorizontal ? catAxis : valAxis,
    series: [{
      type: 'bar',
      data: isHorizontal ? barData.slice().reverse() : barData,
      barMaxWidth: 40,
    }],
  };

  var instance = echarts.getInstanceByDom(panelEl);
  if (!instance) {
    instance = echarts.init(panelEl, THEME_NAME, { renderer: 'canvas' });
  }
  instance.setOption(option, true);
  return instance;
}

function renderPieChart(panelEl, panel, groupData) {
  var entries = groupData.entries || [];
  if (!entries.length) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  // Check if this dimension has an active filter
  var dim = panel._dimField;
  var activeFilter = dim ? filterState[dim] : null;
  var selectedSet = null;
  if (activeFilter) {
    var selectedArr = Array.isArray(activeFilter) ? activeFilter : [activeFilter];
    selectedSet = {};
    for (var sa = 0; sa < selectedArr.length; ++sa) selectedSet[String(selectedArr[sa])] = true;
  }

  var pieData = [];
  for (var i = 0; i < entries.length; ++i) {
    var key = String(entries[i].key);
    var item = { name: key, value: entries[i].value.value };
    if (selectedSet && !selectedSet[key]) {
      item.itemStyle = { opacity: 0.25 };
    }
    pieData.push(item);
  }

  var chartDef = getChartType(panel.chart);
  var ecSeriesType = chartDef ? chartDef.ecType : 'pie';
  var seriesOpts = {
    type: ecSeriesType,
    data: pieData,
    label: { fontSize: 11, formatter: '{b}\n{d}%' },
    emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,21,88,0.15)' } },
  };

  if (chartDef && chartDef.ecOptions) {
    var ec = chartDef.ecOptions;
    if (ec.radius) seriesOpts.radius = ec.radius;
    if (ec.roseType) seriesOpts.roseType = ec.roseType;
    if (ec.startAngle != null) seriesOpts.startAngle = ec.startAngle;
    if (ec.endAngle != null) seriesOpts.endAngle = ec.endAngle;
    if (ec.sort) seriesOpts.sort = ec.sort;
  }

  var option = {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [seriesOpts],
  };

  var instance = echarts.getInstanceByDom(panelEl);
  if (!instance) {
    instance = echarts.init(panelEl, THEME_NAME, { renderer: 'canvas' });
  }
  instance.setOption(option, true);
  return instance;
}

function renderGaugeChart(panelEl, panel, kpiValue, registry) {
  if (kpiValue == null || kpiValue !== kpiValue) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  var chartDef = getChartType(panel.chart);
  var meta = registry.measures[panel._measField];
  var isPercent = meta && (meta.format === 'percent' ||
    (meta.aggType === 'number' && /rate|percent/i.test(meta.description || '')));

  var displayValue = isPercent ? +(kpiValue * 100).toFixed(1) : kpiValue;
  var maxValue = isPercent ? 100 : undefined;
  var formatter = isPercent ? '{value}%' : undefined;

  var seriesOpts = {
    type: 'gauge',
    data: [{ value: displayValue, name: panel.label }],
    detail: { formatter: formatter, fontSize: 14 },
    title: { fontSize: 12 },
  };

  if (maxValue != null) seriesOpts.max = maxValue;

  // Apply chart-type-specific options (progress, ring, etc.)
  if (chartDef && chartDef.ecOptions) {
    var ec = chartDef.ecOptions;
    var ecKeys = Object.keys(ec);
    for (var k = 0; k < ecKeys.length; ++k) {
      seriesOpts[ecKeys[k]] = ec[ecKeys[k]];
    }
  }

  var option = {
    series: [seriesOpts],
  };

  var instance = echarts.getInstanceByDom(panelEl);
  if (!instance) {
    instance = echarts.init(panelEl, THEME_NAME, { renderer: 'canvas' });
  }
  instance.setOption(option, true);
  return instance;
}

function renderLineChart(panelEl, panel, groupData) {
  var entries = groupData.entries || [];
  if (!entries.length) {
    panelEl.innerHTML = '<div class="panel-empty">No data</div>';
    return null;
  }

  // Sort by time key (ascending)
  entries.sort(function(a, b) { return a.key - b.key; });

  // Build [timestamp, value] pairs for ECharts time axis
  var seriesData = [];
  var xData = [];  // keep for dataZoom range calculations
  for (var i = 0; i < entries.length; ++i) {
    var ts = entries[i].key;
    var val = entries[i].value.value;
    seriesData.push([ts, val]);
    xData.push(ts);
  }

  var activeViz = filterState['_timeChart'] || panel.chart;
  var chartDef = getChartType(activeViz) || getChartType(panel.chart);
  var isBarViz = activeViz === 'bar' || activeViz === 'bar.stacked';

  var seriesOpts = {
    type: isBarViz ? 'bar' : 'line',
    data: seriesData,
    showSymbol: false,
  };

  // Default area fill for single-line (non-bar) views
  if (!isBarViz) {
    seriesOpts.areaStyle = { opacity: 0.15 };
  }

  // Apply chart-type-specific options (smooth, step, area, etc.)
  if (chartDef && chartDef.ecOptions) {
    var ec = chartDef.ecOptions;
    if (ec.smooth) seriesOpts.smooth = ec.smooth;
    if (ec.step) seriesOpts.step = ec.step;
    if (ec.areaStyle) seriesOpts.areaStyle = ec.areaStyle;
  }
  // Stacked bar/area
  if (activeViz === 'bar.stacked' || activeViz === 'bar.normalized' ||
      activeViz === 'line.area.stacked' || activeViz === 'line.area.normalized') {
    seriesOpts.stack = 'timeline';
  }

  var dim = panel._dimField;
  var currentFilter = dim ? filterState[dim] : null;
  var selectedTimestamp = null;
  var rangeStart = null;
  var rangeEnd = null;

  if (currentFilter != null) {
    if (Array.isArray(currentFilter) && currentFilter.length === 2) {
      rangeStart = Number(currentFilter[0]);
      rangeEnd = Number(currentFilter[1]);
    } else {
      selectedTimestamp = Number(Array.isArray(currentFilter) ? currentFilter[0] : currentFilter);
    }
  }

  // Store time data on panel for brush range detection and click snapping
  panel._timeData = xData;
  if (xData.length) {
    panel._timeRange = { min: xData[0], max: xData[xData.length - 1] };
  }

  // Make the line itself clickable (not just symbols)
  seriesOpts.triggerLineEvent = true;

  // Vertical marker line on selected time slice
  if (selectedTimestamp != null) {
    seriesOpts.markLine = {
      silent: true,
      symbol: ['none', 'none'],
      lineStyle: { type: 'dashed', color: '#3d8bfd', width: 2 },
      label: {
        formatter: function() {
          var d = new Date(selectedTimestamp);
          var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          return months[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
        },
        position: 'insideEndTop',
        fontSize: 11,
        fontWeight: 600,
        color: '#3d8bfd',
        backgroundColor: 'rgba(255,255,255,0.85)',
        padding: [2, 6],
        borderRadius: 3,
      },
      data: [{ xAxis: selectedTimestamp }],
    };
  }

  var option = {
    tooltip: {
      trigger: 'axis',
      formatter: function(params) {
        var p = params[0];
        var ts = Array.isArray(p.value) ? p.value[0] : p.axisValue;
        var d = new Date(ts);
        var dateStr = d.toISOString().slice(0, 10);
        var count = Array.isArray(p.value) ? p.value[1] : p.value;
        return dateStr + '<br>' + (count != null ? Number(count).toLocaleString() : '\u2014');
      },
    },
    grid: { left: 50, right: 20, top: 20, bottom: 80, containLabel: false },
    xAxis: {
      type: 'time',
      axisLabel: {
        formatter: function(val) {
          var d = new Date(val);
          var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          return months[d.getUTCMonth()] + ' ' + d.getUTCDate();
        },
      },
    },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(63,101,135,0.06)' } } },
    series: [seriesOpts],
    dataZoom: [
      {
        type: 'slider',
        xAxisIndex: 0,
        filterMode: 'none',
        height: 30,
        bottom: 10,
        startValue: rangeStart,
        endValue: rangeEnd,
        start: rangeStart == null ? 0 : undefined,
        end: rangeEnd == null ? 100 : undefined,
        labelFormatter: function(val) {
          var d = new Date(val);
          return d.toISOString().slice(0, 10);
        },
      },
      {
        type: 'inside',
        xAxisIndex: 0,
        filterMode: 'none',
      },
    ],
  };

  // Detect split group data (breakdown active)
  var firstEntry = entries[0];
  var isSplit = firstEntry && firstEntry.value && typeof firstEntry.value.value === 'undefined';

  if (isSplit) {
    // Collect all split keys
    var splitKeys = {};
    for (var si = 0; si < entries.length; ++si) {
      for (var sk in entries[si].value) splitKeys[sk] = true;
    }
    var keyNames = Object.keys(splitKeys);

    // If breakdown dimension has active filter, only show filtered values
    var breakdownId = filterState['_breakdown'];
    var breakdownDim = null;
    if (breakdownId && _dashboardPanels) {
      for (var bp = 0; bp < _dashboardPanels.length; ++bp) {
        if (_dashboardPanels[bp].id === breakdownId) {
          breakdownDim = _dashboardPanels[bp]._dimField;
          break;
        }
      }
    }
    var dimFilter = breakdownDim ? filterState[breakdownDim] : null;
    if (dimFilter) {
      var filterVals = Array.isArray(dimFilter) ? dimFilter : [dimFilter];
      keyNames = keyNames.filter(function(k) { return filterVals.indexOf(k) >= 0; });
    } else {
      // No filter: top 8 by total
      var keyTotals = {};
      for (var ki = 0; ki < keyNames.length; ++ki) keyTotals[keyNames[ki]] = 0;
      for (var ei = 0; ei < entries.length; ++ei) {
        for (var ek in entries[ei].value) {
          var ekv = entries[ei].value[ek];
          if (ekv && ekv.value) keyTotals[ek] = (keyTotals[ek] || 0) + ekv.value;
        }
      }
      keyNames.sort(function(a, b) { return (keyTotals[b] || 0) - (keyTotals[a] || 0); });
      keyNames = keyNames.slice(0, 8);
    }

    // Build one series per split key
    var activeChartType = filterState['_timeChart'] || panel.chart;
    var vizDef = getChartType(activeChartType);
    var isBarSplit = activeChartType === 'bar' || activeChartType === 'bar.stacked';
    var seriesList = [];
    for (var li = 0; li < keyNames.length; ++li) {
      var lineKey = keyNames[li];
      var lineData = [];
      for (var le = 0; le < entries.length; ++le) {
        var lv = entries[le].value[lineKey];
        lineData.push([entries[le].key, lv ? lv.value : 0]);
      }
      var lineSeries = {
        type: isBarSplit ? 'bar' : 'line',
        name: lineKey,
        data: lineData,
        showSymbol: false,
        triggerLineEvent: !isBarSplit,
      };
      if (!isBarSplit && vizDef && vizDef.ecOptions) {
        if (vizDef.ecOptions.smooth) lineSeries.smooth = true;
        if (vizDef.ecOptions.step) lineSeries.step = vizDef.ecOptions.step;
        if (vizDef.ecOptions.areaStyle) lineSeries.areaStyle = vizDef.ecOptions.areaStyle;
      }
      // Stacked / normalized
      var isStacked = activeChartType === 'bar.stacked' || activeChartType === 'bar.normalized' ||
        activeChartType === 'line.area.stacked' || activeChartType === 'line.area.normalized' ||
        activeChartType === 'line.bump';
      if (isStacked) {
        lineSeries.stack = 'breakdown';
        if (!isBarSplit) lineSeries.areaStyle = lineSeries.areaStyle || {};
      }
      seriesList.push(lineSeries);
    }

    // Normalize to 100% if requested
    var isNormalized = activeChartType === 'bar.normalized' || activeChartType === 'line.area.normalized';
    if (isNormalized && seriesList.length > 0) {
      // Compute total per time bucket
      var bucketTotals = {};
      for (var ns = 0; ns < seriesList.length; ++ns) {
        var nsData = seriesList[ns].data;
        for (var nd = 0; nd < nsData.length; ++nd) {
          var nk = nsData[nd][0];
          bucketTotals[nk] = (bucketTotals[nk] || 0) + nsData[nd][1];
        }
      }
      // Normalize each value to percentage
      for (var ns2 = 0; ns2 < seriesList.length; ++ns2) {
        var nsData2 = seriesList[ns2].data;
        for (var nd2 = 0; nd2 < nsData2.length; ++nd2) {
          var nk2 = nsData2[nd2][0];
          var total = bucketTotals[nk2] || 1;
          nsData2[nd2] = [nk2, +(nsData2[nd2][1] / total * 100).toFixed(2)];
        }
      }
      // Set y-axis to percentage
      option.yAxis.max = 100;
      option.yAxis.axisLabel = { formatter: '{value}%' };
      option.tooltip.formatter = function(params) {
        var ts = params[0] ? (Array.isArray(params[0].value) ? params[0].value[0] : params[0].axisValue) : '';
        var d = new Date(ts);
        var html = d.toISOString().slice(0, 10);
        for (var tp = 0; tp < params.length; ++tp) {
          var pv = Array.isArray(params[tp].value) ? params[tp].value[1] : params[tp].value;
          html += '<br>' + params[tp].marker + ' ' + params[tp].seriesName + ': ' + pv + '%';
        }
        return html;
      };
    }

    option.series = seriesList;
    option.legend = { show: true, top: 0, textStyle: { fontSize: 10 } };
    option.grid.top = 30;  // Make room for legend
  }

  var instance = echarts.getInstanceByDom(panelEl);
  if (!instance) {
    instance = echarts.init(panelEl, THEME_NAME, { renderer: 'canvas' });
  }
  // Suppress datazoom events from programmatic setOption to prevent feedback loop
  if (panel._suppressZoom) panel._suppressZoom();
  instance.setOption(option, true);

  return instance;
}

function wireLineBrush(instance, panel) {
  if (!instance || !panel._dimField) return;

  var dim = panel._dimField;
  var debounceTimer = 0;
  var suppressZoom = false;  // Suppress datazoom events from programmatic setOption

  // Flag to suppress — set before setOption, cleared after
  panel._suppressZoom = function() { suppressZoom = true; setTimeout(function() { suppressZoom = false; }, 50); };

  // Range brush via dataZoom
  instance.on('datazoom', function() {
    if (suppressZoom) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function() {
      var option = instance.getOption();
      var zoom = option.dataZoom && option.dataZoom[0];
      if (!zoom) return;

      var startVal = zoom.startValue;
      var endVal = zoom.endValue;

      // If we have percentage-based values, convert using the time range
      if (startVal == null && panel._timeRange) {
        var range = panel._timeRange;
        var span = range.max - range.min;
        startVal = range.min + (zoom.start / 100) * span;
        endVal = range.min + (zoom.end / 100) * span;
      }

      if (startVal == null || endVal == null) return;

      // Detect full range — clear filter
      var tr = panel._timeRange;
      if (tr && startVal <= tr.min && endVal >= tr.max) {
        setFilter(dim, null);
      } else {
        setFilter(dim, [Math.round(startVal), Math.round(endVal)]);
      }
    }, 200);
  });

  // Single time-slice click — snap to nearest time bucket
  instance.on('click', function(params) {
    var ts = Array.isArray(params.value) ? params.value[0] : params.value;
    if (ts == null) return;
    ts = Number(ts);

    // Snap to nearest bucket in xData
    if (panel._timeData && panel._timeData.length) {
      var bestIdx = 0;
      var bestDist = Math.abs(panel._timeData[0] - ts);
      for (var si = 1; si < panel._timeData.length; ++si) {
        var dist = Math.abs(panel._timeData[si] - ts);
        if (dist < bestDist) { bestDist = dist; bestIdx = si; }
      }
      ts = panel._timeData[bestIdx];
    }

    var current = filterState[dim];
    var isSame = false;
    if (!Array.isArray(current)) {
      isSame = Number(current) === ts;
    }
    setFilter(dim, isSame ? null : ts);
  });
}

function renderSelectorList(panel, groupData) {
  var listEl = document.getElementById('list-' + panel.id);
  if (!listEl) return;

  var entries = groupData.entries || [];
  if (!entries.length) {
    listEl.innerHTML = '<div class="panel-empty">No data</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < entries.length; ++i) {
    var entry = entries[i];
    var key = String(entry.key);
    var count = entry.value.value;
    var maxCount = entries[0].value.value || 1;
    var pct = Math.round((count / maxCount) * 100);

    html += '<div class="dim-item" data-value="' + escapeHtml(key) + '">' +
      '<span class="dim-label">' + escapeHtml(key) + '</span>' +
      '<span class="dim-count">' + count.toLocaleString() + '</span>' +
      '<div class="dim-bar"><div class="dim-bar-fill" style="width:' + pct + '%"></div></div>' +
    '</div>';
  }
  listEl.innerHTML = html;

  // Update count badge
  if (groupData.total != null) {
    var countEl = document.getElementById('count-' + panel.id);
    if (countEl) countEl.textContent = groupData.total + ' values';
  }

  // Wire click-to-filter on list items
  listEl.onclick = function(e) {
    var item = e.target.closest('.dim-item');
    if (!item) return;
    var dim = panel._dimField;
    var val = item.dataset.value;
    if (!dim || !val) return;

    var isMulti = e.metaKey || e.ctrlKey;
    var current = filterState[dim];

    if (isMulti) {
      var arr = current ? (Array.isArray(current) ? current.slice() : [current]) : [];
      var idx = arr.indexOf(val);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(val);
      setFilter(dim, arr.length ? arr : null);
    } else {
      var isSame = current === val ||
        (Array.isArray(current) && current.length === 1 && current[0] === val);
      setFilter(dim, isSame ? null : val);
    }
  };

  // Wire search input
  var searchEl = document.getElementById('search-' + panel.id);
  if (searchEl && !searchEl._wired) {
    searchEl._wired = true;
    searchEl.addEventListener('input', function() {
      var query = searchEl.value.toLowerCase();
      var items = listEl.querySelectorAll('.dim-item');
      for (var j = 0; j < items.length; ++j) {
        var label = items[j].querySelector('.dim-label');
        var text = label ? label.textContent.toLowerCase() : '';
        items[j].style.display = !query || text.indexOf(query) >= 0 ? '' : 'none';
      }
    });
  }
}

function renderKpi(panel, kpiValue, registry) {
  var el = document.querySelector('#panel-' + panel.id + ' .kpi-value');
  if (!el) return;
  var raw = kpiValue;
  if (raw == null || raw !== raw) { el.textContent = '\u2014'; return; }
  var meta = registry.measures[panel._measField];
  el.textContent = formatMeasureValue(raw, meta);
}

function wireChartClick(instance, panel) {
  if (!instance || !panel._dimField) return;
  instance.on('click', function(params) {
    var dim = panel._dimField;
    var clickedValue = params.name || (params.data && params.data.name);
    if (!clickedValue) return;

    var current = filterState[dim];
    var isMulti = params.event && params.event.event &&
      (params.event.event.metaKey || params.event.event.ctrlKey);

    if (isMulti) {
      // Cmd/Ctrl+click: toggle value in multi-select array
      var arr = current ? (Array.isArray(current) ? current.slice() : [current]) : [];
      var idx = arr.indexOf(clickedValue);
      if (idx >= 0) {
        arr.splice(idx, 1);
      } else {
        arr.push(clickedValue);
      }
      setFilter(dim, arr.length ? arr : null);
    } else {
      // Normal click: radio toggle (select one or deselect)
      var isSame = current === clickedValue ||
        (Array.isArray(current) && current.length === 1 && current[0] === clickedValue);
      setFilter(dim, isSame ? null : clickedValue);
    }
  });
}

var _chartInstances = {};

function renderAllPanels(panels, response, registry) {
  for (var i = 0; i < panels.length; ++i) {
    var panel = panels[i];

    // Local KPIs (count, sum) come from crossfilter snapshot
    if (panel._kpiId && panel.chart === 'kpi' && response.kpis && response.kpis[panel._kpiId] != null) {
      renderKpi(panel, response.kpis[panel._kpiId], registry);
      continue;
    }

    // Skip remote text KPIs here — they're handled by refreshRemoteKpis
    if (panel._kpiId && panel.chart === 'kpi') continue;

    // Gauge panels: KPI value rendered as ECharts gauge
    if (panel._kpiId && (panel.chart === 'gauge' || panel.chart === 'gauge.progress' || panel.chart === 'gauge.ring')) {
      // Gauge gets its value from remote KPIs (handled by refreshRemoteKpis)
      // but we also try local KPIs here
      var gaugeKpiVal = response.kpis ? response.kpis[panel._kpiId] : null;
      if (gaugeKpiVal != null) {
        var gaugeEl = document.getElementById('chart-' + panel.id);
        if (gaugeEl) renderGaugeChart(gaugeEl, panel, gaugeKpiVal, registry);
      }
      continue;
    }

    if (panel._groupId && response.groups) {
      var groupData = response.groups[panel._groupId];
      if (!groupData) continue;

      // Selector/list panels — DOM-based, no ECharts, no chart-wrap
      var chartDef = getChartType(panel.chart);
      var ecType = chartDef ? chartDef.ecType : null;

      if (!ecType && (panel.chart === 'selector' || panel.chart === 'dropdown')) {
        renderSelectorList(panel, groupData);
        continue;
      }

      var chartEl = document.getElementById('chart-' + panel.id);
      if (!chartEl) continue;

      var instance = null;

      if (ecType === 'line') {
        instance = renderLineChart(chartEl, panel, groupData);
        // Wire brush (only once)
        if (instance && !_chartInstances[panel.id]) {
          wireLineBrush(instance, panel);
        }
      } else if (ecType === 'bar' || ecType === 'pictorialBar') {
        instance = renderBarChart(chartEl, panel, groupData);
      } else if (ecType === 'pie' || ecType === 'funnel') {
        instance = renderPieChart(chartEl, panel, groupData);
      }

      if (instance && !_chartInstances[panel.id]) {
        wireChartClick(instance, panel);
        _chartInstances[panel.id] = instance;
      } else if (instance) {
        _chartInstances[panel.id] = instance;
      }

      if (groupData.total != null) {
        var countEl = document.getElementById('count-' + panel.id);
        if (countEl) countEl.textContent = groupData.total + ' values';
      }
    }
  }

  // Update breakdown visual indicators
  var breakdownId = filterState['_breakdown'];
  var allCards = document.querySelectorAll('.chart-card');
  for (var ci = 0; ci < allCards.length; ++ci) {
    allCards[ci].classList.toggle('chart-card--breakdown', allCards[ci].id === 'panel-' + breakdownId);
  }

  // Trigger debounced remote KPI refresh
  scheduleKpiRefresh();
}

// ── Remote KPI refresh (debounced Cube query) ─────────────────────────
// Slightly delayed so rapid filter clicks don't spam the server.
// Shows a subtle loading state on KPI cards while querying.

var _kpiRefreshTimer = 0;
var _kpiRefreshSeq = 0;

function scheduleKpiRefresh() {
  clearTimeout(_kpiRefreshTimer);
  _kpiRefreshTimer = setTimeout(function() { executeKpiRefresh(); }, 150);
}

function executeKpiRefresh() {
  if (!_dashboardData || !_dashboardData.queryKpis) return;
  var seq = ++_kpiRefreshSeq;

  // Show loading state only on remote KPI cards (local ones update instantly)
  var panels = _dashboardPanels || [];
  for (var i = 0; i < panels.length; ++i) {
    if (!panels[i]._kpiId || panels[i]._kpiLocal) continue;
    var el = document.querySelector('#panel-' + panels[i].id + ' .kpi-value');
    if (el && el.textContent !== '\u2014') {
      el.style.opacity = '0.4';
    }
  }

  // Build client-side filter state (only dims in the worker)
  var clientFilters = {};
  var keys = Object.keys(filterState);
  for (var k = 0; k < keys.length; ++k) {
    if (!isServerTrigger(keys[k])) {
      clientFilters[keys[k]] = filterState[keys[k]];
    }
  }

  _dashboardData.queryKpis(clientFilters).then(function(kpiValues) {
    if (seq !== _kpiRefreshSeq) return;
    var registry = _dashboardRegistry;
    for (var j = 0; j < panels.length; ++j) {
      var panel = panels[j];
      if (!panel._kpiId) continue;
      var val = kpiValues[panel._kpiId];
      if (val != null) {
        if (panel.chart === 'kpi') {
          renderKpi(panel, val, registry);
        } else if (panel.chart === 'gauge' || panel.chart === 'gauge.progress' || panel.chart === 'gauge.ring') {
          var gaugeEl = document.getElementById('chart-' + panel.id);
          if (gaugeEl) renderGaugeChart(gaugeEl, panel, val, registry);
        }
      }
      var kpiEl = document.querySelector('#panel-' + panel.id + ' .kpi-value');
      if (kpiEl) kpiEl.style.opacity = '';
    }
  }).catch(function(err) {
    console.error('[dashboard] KPI refresh failed:', err);
    // Restore opacity
    for (var j = 0; j < panels.length; ++j) {
      if (!panels[j]._kpiId) continue;
      var kpiEl = document.querySelector('#panel-' + panels[j].id + ' .kpi-value');
      if (kpiEl) kpiEl.style.opacity = '';
    }
  });
}

// ── Principle 8: Filter Chips (visible, removable) ────────────────────

// Resolve raw filter value to human label by looking up sl-option text
function resolveFilterLabel(dim, rawValue) {
  var select = document.querySelector('sl-select[data-dropdown-id="' + dim + '"]');
  if (select) {
    var option = select.querySelector('sl-option[value="' + rawValue + '"]');
    if (option) return option.textContent.trim();
  }
  // Timestamps: format as date
  var num = Number(rawValue);
  if (num > 1e12) {
    return new Date(num).toISOString().slice(0, 10);
  }
  // Fallback: title-case the raw value
  return titleCase(rawValue);
}

function renderFilterChips() {
  var container = document.getElementById('filter-chips');
  if (!container) return;
  container.innerHTML = '';
  var clearBtn = document.getElementById('clear-all-btn');

  // UI state keys that are not data filters — skip in chips
  var UI_STATE_KEYS = { _breakdown: true, _timeChart: true, _granularity: true, _period: true };

  var keys = Object.keys(filterState);
  var filterKeys = [];
  for (var fi = 0; fi < keys.length; ++fi) {
    if (!UI_STATE_KEYS[keys[fi]]) filterKeys.push(keys[fi]);
  }

  if (filterKeys.length === 0) {
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (clearBtn) clearBtn.style.display = '';

  for (var i = 0; i < filterKeys.length; ++i) {
    var dim = filterKeys[i];
    var val = filterState[dim];
    var vals = Array.isArray(val) ? val : [val];
    var displayDim = titleCase(dim.replace(/^_/, ''));

    if (vals.length === 1) {
      var chipLabel = resolveFilterLabel(dim, vals[0]);
      var tag = document.createElement('sl-tag');
      tag.setAttribute('size', 'small');
      tag.setAttribute('removable', '');
      tag.setAttribute('variant', 'primary');
      tag.textContent = displayDim + ': ' + chipLabel;
      tag.dataset.dim = dim;
      tag.addEventListener('sl-remove', function (e) {
        var d = e.target.dataset.dim;
        setFilter(d, null);
        syncDropdownAfterRemove(d);
      });
      container.appendChild(tag);
    } else {
      // Multiple values — consolidated group tag with tooltip listing all values
      var allLabels = [];
      for (var v = 0; v < vals.length; ++v) {
        allLabels.push(resolveFilterLabel(dim, vals[v]));
      }
      var groupTag = document.createElement('sl-tooltip');
      groupTag.setAttribute('content', allLabels.join(', '));
      groupTag.setAttribute('hoist', '');
      var innerTag = document.createElement('sl-tag');
      innerTag.setAttribute('size', 'small');
      innerTag.setAttribute('removable', '');
      innerTag.setAttribute('variant', 'primary');
      innerTag.textContent = displayDim + ' (' + vals.length + ')';
      innerTag.dataset.dim = dim;
      innerTag.addEventListener('sl-remove', function (e) {
        var d = e.target.dataset.dim;
        setFilter(d, null);
        syncDropdownAfterRemove(d);
      });
      groupTag.appendChild(innerTag);
      container.appendChild(groupTag);
    }
  }
  updateFilterCount();
}

function syncDropdownAfterRemove(dim, singleVal) {
  // Shoelace selects
  var select = document.querySelector('sl-select[data-dropdown-id="' + dim + '"]');
  if (select) {
    if (singleVal && select.multiple) {
      var current = Array.isArray(select.value) ? select.value.slice() : [];
      var idx = current.indexOf(singleVal);
      if (idx >= 0) current.splice(idx, 1);
      select.value = current;
    } else {
      select.value = select.multiple ? [] : '';
    }
    afterUpdate(select, function () { updateSelectDisplay(select); });
    return;
  }

  // Toggle buttons — reset to "All"
  if (document.querySelector('sl-button[data-toggle="' + dim + '"]')) {
    resetToggleGroup(dim);
    return;
  }
}

// ── Principle 2: Info tooltip (i) ─────────────────────────────────────

function infoIcon(text) {
  if (!text || !text.trim()) return '';
  return ' <sl-tooltip content="' + escapeHtml(text.trim()) + '" hoist><span class="info-icon">i</span></sl-tooltip>';
}

// ── Header ────────────────────────────────────────────────────────────

function buildHeader(config) {
  var header = document.createElement('header');
  header.className = 'header anim d1';
  header.innerHTML =
    '<div class="header-left">' +
      '<h1>' + escapeHtml(config.title || 'Dashboard') + '</h1>' +
    '</div>' +
    '<div class="header-right">' +
      '<div id="filter-chips" class="filter-chips"></div>' +
      '<sl-button id="clear-all-btn" size="small" variant="text" style="display:none">Clear All</sl-button>' +
    '</div>';
  // Wire clear all (Principle 8)
  header.querySelector('#clear-all-btn').addEventListener('click', clearAllFilters);
  return header;
}

// ── Mobile Header + Bottom Sheet ──────────────────────────────────────

function buildMobileHeader(config, registry, timePanelInfo) {
  var el = document.createElement('div');
  el.className = 'mobile-header';

  var title = (config.title || registry.title || registry.name || '').toUpperCase();

  var periodHtml = '';
  if (timePanelInfo) {
    periodHtml = '<button class="period-trigger" id="mobile-period-trigger"></button>';
  }

  var granMeta = (registry.meta && registry.meta.granularity) || {};
  var granList = granMeta.available || ['day','week','month','quarter','year'];
  var granDefault = granMeta.default || 'week';
  var granOpts = '';
  granList.forEach(function(g) {
    granOpts += '<sl-option value="' + g + '"' + (g === granDefault ? ' selected' : '') + '>' +
      g.charAt(0).toUpperCase() + g.slice(1) + '</sl-option>';
  });

  el.innerHTML =
    '<div class="mobile-header-title">' + title + '</div>' +
    '<div class="mobile-header-controls">' +
      periodHtml +
      '<sl-select class="ds-select" size="small" value="' + granDefault + '" id="mobile-gran-select">' +
        granOpts +
      '</sl-select>' +
      '<button class="filter-trigger" id="filter-trigger">' +
        'Filters <sl-badge pill variant="primary" id="filter-count-badge">0</sl-badge>' +
      '</button>' +
    '</div>';

  return el;
}

function buildFilterSheet() {
  var backdrop = document.createElement('div');
  backdrop.className = 'filter-sheet-backdrop';
  backdrop.id = 'filter-sheet-backdrop';

  var sheet = document.createElement('div');
  sheet.className = 'filter-sheet';
  sheet.id = 'filter-sheet';
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('role', 'dialog');

  sheet.innerHTML =
    '<div class="filter-sheet-handle"></div>' +
    '<div class="filter-sheet-header">' +
      '<span class="filter-sheet-title">Filters</span>' +
      '<span class="filter-sheet-count" id="filter-sheet-count"></span>' +
      '<button class="filter-sheet-close" id="filter-sheet-close" aria-label="Close">&times;</button>' +
    '</div>' +
    '<div class="filter-sheet-body" id="filter-sheet-body"></div>' +
    '<div class="filter-sheet-footer">' +
      '<sl-button variant="primary" size="small" id="filter-sheet-close-btn">Close</sl-button>' +
      '<sl-button variant="text" size="small" id="filter-sheet-clear">Clear All</sl-button>' +
    '</div>';

  return { backdrop: backdrop, sheet: sheet };
}

function wireFilterSheet() {
  var backdrop = document.getElementById('filter-sheet-backdrop');
  var sheet = document.getElementById('filter-sheet');
  var trigger = document.getElementById('filter-trigger');
  if (!backdrop || !sheet || !trigger) return;

  function openSheet() {
    backdrop.classList.add('open');
    sheet.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeSheet() {
    backdrop.classList.remove('open');
    sheet.classList.remove('open');
    document.body.style.overflow = '';
  }

  trigger.addEventListener('click', openSheet);
  backdrop.addEventListener('click', closeSheet);

  var closeBtn = document.getElementById('filter-sheet-close');
  var closeBtnFooter = document.getElementById('filter-sheet-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', closeSheet);
  if (closeBtnFooter) closeBtnFooter.addEventListener('click', closeSheet);

  var clearBtn = document.getElementById('filter-sheet-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      var clearAll = document.getElementById('clear-all-btn');
      if (clearAll) clearAll.click();
    });
  }
}

function wireChartResize() {
  var chartWraps = document.querySelectorAll('.chart-wrap');
  if (!chartWraps.length || typeof ResizeObserver === 'undefined') return;

  var ro = new ResizeObserver(function(entries) {
    entries.forEach(function(entry) {
      var instance = echarts.getInstanceByDom(entry.target);
      if (instance) {
        instance.resize();
      }
    });
  });

  chartWraps.forEach(function(wrap) {
    ro.observe(wrap);
  });
}

function populateFilterSheet(registry, inlinePanels) {
  var body = document.getElementById('filter-sheet-body');
  if (!body) return;
  body.innerHTML = '';

  // Segments
  if (registry.segments && registry.segments.length > 0) {
    body.insertAdjacentHTML('beforeend',
      '<sl-details summary="Segments" open>' +
        '<div class="filter-sheet-section-body">' +
        buildDropdown('sheet-segments', '', 'All Data', registry.segments, true) +
        '</div>' +
      '</sl-details>');
  }

  // Boolean dimensions
  var boolDims = discoverBooleanDimensions(registry);
  if (boolDims.length > 0) {
    var boolOpts = boolDims.map(function(d) {
      return { value: d.name, label: titleCase(d.name.replace(/_/g, ' ')) };
    });
    body.insertAdjacentHTML('beforeend',
      '<sl-details summary="Include">' +
        '<div class="filter-sheet-section-body">' +
        buildDropdown('sheet-booleans', '', 'No filter', boolOpts, true) +
        '</div>' +
      '</sl-details>');
  }

  // Inline panels (toggles, ranges, facets from modelbar section)
  if (inlinePanels && inlinePanels.length > 0) {
    inlinePanels.forEach(function(panel) {
      var label = panel.label || titleCase((panel.dimension || '').replace(/_/g, ' '));
      var content = '';

      if (panel.chart === 'toggle') {
        content = '<div class="filter-sheet-section-body">' +
          '<div class="pill-group" data-dim="' + panel.dimension + '">' +
          buildToggleHtml(panel.dimension) + '</div></div>';
      } else if (panel.chart === 'range') {
        content = '<div class="filter-sheet-section-body">' +
          buildRangeSelector('sheet-range-' + panel.dimension, label, false) +
          '</div>';
      } else {
        content = '<div class="filter-sheet-section-body">' +
          buildDropdown('sheet-' + (panel.dimension || panel.measure || 'unknown'), '', label, [], true) +
          '</div>';
      }

      body.insertAdjacentHTML('beforeend',
        '<sl-details summary="' + label + '">' + content + '</sl-details>');
    });
  }
}

function updateFilterCount() {
  var chips = document.querySelectorAll('#filter-chips sl-tag');
  var count = chips.length;
  var badge = document.getElementById('filter-count-badge');
  var sheetCount = document.getElementById('filter-sheet-count');
  if (badge) badge.textContent = count;
  if (sheetCount) sheetCount.textContent = count > 0 ? count + ' active' : '';
}

// ── Dropdowns — Shoelace <sl-select> (Principle 1 + 14) ───────────────

function buildDropdown(id, label, placeholder, items, multiSelect, defaultValue) {
  // max-options-visible="0" hides selected tags from the trigger —
  // selected state is shown in the filter chips bar instead (Principle 8)
  var html = '<sl-select' +
    ' data-dropdown-id="' + escapeHtml(id) + '"' +
    ' placeholder="' + escapeHtml(placeholder) + '"' +
    (label ? ' label="' + escapeHtml(label) + '"' : '') +
    (defaultValue ? ' value="' + escapeHtml(defaultValue) + '"' : '') +
    ' size="small"' +
    ' hoist' +
    ' class="ds-select"' +
    (multiSelect ? ' multiple max-options-visible="0"' : '') +
    (multiSelect ? ' clearable' : '') +
    '>';
  for (var i = 0; i < items.length; ++i) {
    var item = items[i];
    var selected = (!multiSelect && item.label === placeholder) ? ' checked' : '';
    html += '<sl-option value="' + escapeHtml(item.value) + '"' + selected + '>' +
      escapeHtml(item.label) +
    '</sl-option>';
  }
  html += '</sl-select>';
  return html;
}

// ── Wire Shoelace selects ─────────────────────────────────────────────

function wireDropdowns(container) {
  var selects = container.querySelectorAll('sl-select[data-dropdown-id]');
  for (var i = 0; i < selects.length; ++i) {
    wireOneSelect(selects[i]);
  }
}

function updateSelectDisplay(select) {
  if (!select.hasAttribute('multiple')) return;
  var val = select.value;
  var count = Array.isArray(val) ? val.length : 0;
  var placeholder = select.getAttribute('placeholder') || 'All';
  // Shoelace's display-input is inside shadow DOM
  var displayInput = select.shadowRoot && select.shadowRoot.querySelector('.select__display-input');
  if (displayInput) {
    displayInput.placeholder = count > 0 ? count + ' selected' : placeholder;
    displayInput.value = '';
  }
}

function wireOneSelect(select) {
  var id = select.dataset.dropdownId;
  var isMulti = select.hasAttribute('multiple');

  select.addEventListener('sl-change', function () {
    var val = select.value;
    if (isMulti) {
      updateSelectDisplay(select);
      var count = Array.isArray(val) ? val.length : 0;
      setFilter(id, count > 0 ? val : null);
    } else {
      setFilter(id, val || null);
    }
  });

  afterUpdate(select, function () { updateSelectDisplay(select); });
}

// Restore all input states from URL filter state
function restoreStateFromUrl() {
  // Shoelace selects
  var selects = document.querySelectorAll('sl-select[data-dropdown-id]');
  for (var i = 0; i < selects.length; ++i) {
    var select = selects[i];
    var id = select.dataset.dropdownId;
    var vals = filterState[id];
    if (!vals) continue;
    select.value = Array.isArray(vals) ? vals : [vals];
    (function (sel) { afterUpdate(sel, function () { updateSelectDisplay(sel); }); })(select);
  }

  // Toggle buttons (Yes/No/All) — match by data-toggle or data-val
  var keys = Object.keys(filterState);
  for (var k = 0; k < keys.length; ++k) {
    var dim = keys[k];
    var val = filterState[dim];
    // Find toggle buttons for this specific dimension only
    var firstToggle = document.querySelector('sl-button[data-toggle="' + dim + '"]');
    if (!firstToggle) continue;
    var group = firstToggle.closest('sl-button-group');
    if (!group) continue;
    var btns = group.querySelectorAll('sl-button[data-toggle="' + dim + '"]');
    for (var b = 0; b < btns.length; ++b) {
      btns[b].variant = btns[b].dataset.val === String(val) ? 'primary' : 'default';
    }
  }

  // Range sliders — set noUiSlider values
  var sliders = document.querySelectorAll('[data-range-id]');
  for (var s = 0; s < sliders.length; ++s) {
    var rangeId = sliders[s].dataset.rangeId;
    var rangeVal = filterState[rangeId];
    if (!rangeVal) continue;
    var rangeVals = Array.isArray(rangeVal) ? rangeVal : [rangeVal];
    var sliderEl = sliders[s].querySelector('.noUi-target');
    if (sliderEl && sliderEl.noUiSlider && rangeVals.length === 2) {
      sliderEl.noUiSlider.set([parseFloat(rangeVals[0]), parseFloat(rangeVals[1])]);
    }
  }
}

// ── Model Intelligence Bar ────────────────────────────────────────────
// Principle 2: description tucked behind (i), clean surface

function buildModelBar(config, registry, inlinePanels, timePanelInfo) {
  var modelBarConfig = config.modelBar;
  if (modelBarConfig === false) return null;
  modelBarConfig = modelBarConfig || {};

  var segments = registry.segments || [];
  var booleans = discoverBooleanDimensions(registry);

  // Filter out booleans already in panels
  var panelDims = {};
  var panels = config.panels || [];
  for (var p = 0; p < panels.length; ++p) {
    if (panels[p].dimension) panelDims[panels[p].dimension] = true;
  }
  var extraBooleans = booleans.filter(function (b) { return !panelDims[b.name]; });

  var hasSegments = modelBarConfig.segments !== false && segments.length > 0;
  var hasPresets = modelBarConfig.presets !== false && extraBooleans.length > 0;

  var hasInline = inlinePanels && inlinePanels.length > 0;
  if (!hasSegments && !hasPresets && !registry.description && !hasInline) return null;

  var bar = document.createElement('section');
  bar.className = 'model-bar anim d1';
  var html = '';

  // Title line with period control right-aligned
  html += '<div class="model-bar-header">';
  html += '<div class="model-bar-identity">';
  html += '<span class="model-bar-title">' + escapeHtml(registry.title) + '</span>';
  if (registry.description) {
    html += infoIcon(registry.description);
  }
  html += '</div>';
  // Period control in the title line
  if (timePanelInfo) {
    html += buildPeriodControl(timePanelInfo);
  }
  html += '</div>';

  html += '<div class="model-bar-controls">';

  // Segments — compact dropdown
  if (hasSegments) {
    var segItems = [];
    for (var s = 0; s < segments.length; ++s) {
      segItems.push({ value: segments[s].name, label: segments[s].title, description: segments[s].description });
    }
    html += buildDropdown('_focus', '', 'All Data', segItems, true);
  }

  // Boolean presets — compact dropdown
  if (hasPresets) {
    var boolItems = [];
    for (var b = 0; b < extraBooleans.length; ++b) {
      boolItems.push({ value: extraBooleans[b].name, label: extraBooleans[b].label });
    }
    html += buildDropdown('_include', '', 'No filter', boolItems, true);
  }

  // Inline panels (toggles, ranges assigned to modelbar via config)
  if (inlinePanels && inlinePanels.length > 0) {
    for (var ip = 0; ip < inlinePanels.length; ++ip) {
      var p = inlinePanels[ip];
      var pDimMeta = registry.dimensions[p.dimension];
      var pDesc = pDimMeta && pDimMeta.description ? pDimMeta.description : null;

      if (p.chart === 'toggle') {
        html += '<div class="model-bar-inline control-container" id="panel-' + p.id + '">';
        html += '<span class="model-bar-inline-label">' + escapeHtml(p.label) + (pDesc ? infoIcon(pDesc) : '') + '</span>';
        html += buildToggleHtml(p.dimension);
        html += '</div>';
      } else if (p.chart === 'range') {
        html += '<div class="model-bar-inline model-bar-inline--range control-container" id="panel-' + p.id + '">';
        html += '<span class="model-bar-inline-label">' + escapeHtml(p.label) + (pDesc ? infoIcon(pDesc) : '') + '</span>';
        html += buildRangeSelector(p.id, p.label, true);
        html += '</div>';
      }
    }
  }

  html += '</div>';

  bar.innerHTML = html;
  wireDropdowns(bar);

  wireToggleClicks(bar);

  // Wire inline range selectors
  if (inlinePanels) {
    for (var rp = 0; rp < inlinePanels.length; ++rp) {
      if (inlinePanels[rp].chart === 'range') {
        wireRangeSelector(bar, inlinePanels[rp].id, inlinePanels[rp].dimension);
      }
    }
  }

  return bar;
}

// ── Section Builder ───────────────────────────────────────────────────

function buildSectionEl(section, animDelay) {
  var wrapper;

  if (section.collapsed) {
    wrapper = document.createElement('details');
    wrapper.className = 'card anim d' + animDelay;
    var summary = document.createElement('summary');
    summary.className = 'card-head card-head--toggle';
    summary.innerHTML =
      '<span class="card-t">' + escapeHtml(section.label || section.id) + '</span>' +
      '<div class="card-filters"><span class="group-size-badge">Expand to browse</span></div>';
    wrapper.appendChild(summary);
  } else {
    wrapper = document.createElement('section');
    wrapper.className = 'anim d' + animDelay;
  }

  wrapper.dataset.sectionId = section.id;
  return wrapper;
}

// ── Panel Card Builder ────────────────────────────────────────────────
// Applies: Principle 1 (informative), 4 (Top-X + Other), 5 (Show All),
// 6 (infinite scroll + search), 7 (selection state), 9 (group drill-down)

function buildPanelCard(panel, accentIdx, registry) {
  var isKpi = panel.chart === 'kpi';
  var card = document.createElement('div');

  if (isKpi) {
    var color = ACCENT_COLORS[accentIdx % ACCENT_COLORS.length];
    // Container wrapper — grid cell is the container, .kpi is the component.
    // A container can only style descendants, not itself. The grid track
    // gives the cell its width; @container kpicard queries adapt .kpi inside.
    card.className = 'kpi-cell';
    card.id = 'panel-' + panel.id;
    var measMeta = registry.measures[panel.measure];
    var measDesc = measMeta && measMeta.description ? measMeta.description : null;
    card.innerHTML =
      '<div class="kpi kpi-' + color + '">' +
        '<div class="kpi-label">' + escapeHtml(panel.label) + (measDesc ? infoIcon(measDesc) : '') + '</div>' +
        '<div class="kpi-value">\u2014</div>' +
      '</div>';
    return card;
  }

  // Container wrapper — chart-cell is the container query context.
  // Grid track gives chart-cell its width; @container chartcard
  // queries on chart-cell style .chart-card (descendant) inside.
  var cell = document.createElement('div');
  cell.className = 'chart-cell';

  card.className = 'card chart-card';
  card.id = 'panel-' + panel.id;

  // Dimension description for (i)
  var dimMeta = registry.dimensions[panel.dimension];
  var dimDesc = dimMeta && dimMeta.description ? dimMeta.description : null;

  // Card head — Principle 4/5: adaptive Top X toggle
  // Only show if there are more items than the limit (otherwise we're showing all already)
  var headRight = '';
  if (panel.chart === 'bar' || panel.chart === 'pie') {
    headRight += '<sl-button size="small" variant="text" class="show-all-toggle" data-panel="' + panel.id + '" data-limit="' + panel.limit + '">Top ' + panel.limit + '</sl-button>';
  }
  if (panel.chart === 'bar' && panel.searchable) {
    headRight += '<sl-button size="small" variant="text" class="dim-list-toggle" data-panel="' + panel.id + '">List</sl-button>';
  }
  if (panel.chart === 'line' || panel._isTimeSeries) {
    var currentViz = filterState['_timeChart'] || panel.chart;
    // Inline SVG icons for each viz type (16×12 viewBox)
    var vizIcons = [
      { value: 'line', label: 'Line',
        svg: '<path d="M1,10 L4,6 L7,8 L10,3 L13,5 L15,2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
      { value: 'line.smooth', label: 'Smooth',
        svg: '<path d="M1,10 C3,6 5,4 8,6 C11,8 13,2 15,2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' },
      { value: 'line.area', label: 'Area',
        svg: '<path d="M1,10 L4,6 L7,8 L10,3 L13,5 L15,2 L15,11 L1,11Z" fill="currentColor" opacity="0.25"/><path d="M1,10 L4,6 L7,8 L10,3 L13,5 L15,2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
      { value: 'line.area.stacked', label: 'Stacked Area',
        svg: '<path d="M1,11 L1,8 L5,5 L9,7 L13,4 L15,3 L15,11Z" fill="currentColor" opacity="0.3"/><path d="M1,11 L1,10 L5,8 L9,9 L13,7 L15,6 L15,11Z" fill="currentColor" opacity="0.2"/>' },
      { value: 'line.area.normalized', label: '100% Area',
        svg: '<rect x="1" y="1" width="14" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="0.7" opacity="0.3"/><path d="M1,11 L1,4 L5,3 L9,5 L13,2 L15,1 L15,11Z" fill="currentColor" opacity="0.3"/><path d="M1,11 L1,7 L5,6 L9,8 L13,5 L15,4 L15,11Z" fill="currentColor" opacity="0.25"/>' },
      { value: 'line.step', label: 'Step',
        svg: '<path d="M1,10 L4,10 L4,6 L7,6 L7,8 L10,8 L10,3 L13,3 L13,5 L15,5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
      { value: 'bar', label: 'Bar',
        svg: '<rect x="1" y="6" width="2.5" height="5" rx="0.5" fill="currentColor" opacity="0.7"/><rect x="4.5" y="3" width="2.5" height="8" rx="0.5" fill="currentColor" opacity="0.7"/><rect x="8" y="5" width="2.5" height="6" rx="0.5" fill="currentColor" opacity="0.7"/><rect x="11.5" y="2" width="2.5" height="9" rx="0.5" fill="currentColor" opacity="0.7"/>' },
      { value: 'bar.stacked', label: 'Stacked Bar',
        svg: '<rect x="1" y="4" width="2.5" height="3" rx="0.3" fill="currentColor" opacity="0.5"/><rect x="1" y="7.5" width="2.5" height="3" rx="0.3" fill="currentColor" opacity="0.3"/><rect x="5" y="2" width="2.5" height="4" rx="0.3" fill="currentColor" opacity="0.5"/><rect x="5" y="6.5" width="2.5" height="4" rx="0.3" fill="currentColor" opacity="0.3"/><rect x="9" y="3" width="2.5" height="3.5" rx="0.3" fill="currentColor" opacity="0.5"/><rect x="9" y="7" width="2.5" height="4" rx="0.3" fill="currentColor" opacity="0.3"/><rect x="12.5" y="1" width="2.5" height="5" rx="0.3" fill="currentColor" opacity="0.5"/><rect x="12.5" y="6.5" width="2.5" height="4.5" rx="0.3" fill="currentColor" opacity="0.3"/>' },
      { value: 'bar.normalized', label: '100% Bar',
        svg: '<rect x="1" y="1" width="2.5" height="4" rx="0.3" fill="currentColor" opacity="0.5"/><rect x="1" y="5.5" width="2.5" height="5.5" rx="0.3" fill="currentColor" opacity="0.25"/><rect x="5" y="1" width="2.5" height="6" rx="0.3" fill="currentColor" opacity="0.5"/><rect x="5" y="7.5" width="2.5" height="3.5" rx="0.3" fill="currentColor" opacity="0.25"/><rect x="9" y="1" width="2.5" height="5" rx="0.3" fill="currentColor" opacity="0.5"/><rect x="9" y="6.5" width="2.5" height="4.5" rx="0.3" fill="currentColor" opacity="0.25"/><rect x="12.5" y="1" width="2.5" height="3" rx="0.3" fill="currentColor" opacity="0.5"/><rect x="12.5" y="4.5" width="2.5" height="6.5" rx="0.3" fill="currentColor" opacity="0.25"/>' },
      { value: 'line.bump', label: 'Bump',
        svg: '<path d="M1,3 C4,3 5,8 8,8 C11,8 12,5 15,5" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.6"/><path d="M1,8 C4,8 5,3 8,3 C11,3 12,9 15,9" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.4"/>' },
    ];
    headRight += '<div class="viz-icon-bar">';
    for (var ti = 0; ti < vizIcons.length; ++ti) {
      var vi = vizIcons[ti];
      var viActive = vi.value === currentViz ? ' viz-icon--active' : '';
      headRight += '<button class="viz-icon' + viActive + '" data-viz="' + vi.value + '" title="' + escapeHtml(vi.label) + '">' +
        '<svg viewBox="0 0 16 12" width="20" height="15">' + vi.svg + '</svg></button>';
    }
    headRight += '</div>';
  }
  if (panel.chart === 'selector' || panel.chart === 'list') {
    headRight += '<span class="group-size-badge" id="count-' + panel.id + '"></span>';
  }
  // Breakdown: double-click on card title activates breakdown
  var panelChartDef = getChartType(panel.chart);
  var panelFamily = panelChartDef ? panelChartDef.family : null;
  var canBreakdown = panel.dimension && (panelFamily === 'category' || panelFamily === 'control') && panel.chart !== 'toggle' && panel.chart !== 'range';
  var breakdownAttr = canBreakdown ? ' data-breakdown-panel="' + panel.id + '" data-breakdown-dim="' + escapeHtml(panel.dimension) + '"' : '';

  var head = '<div class="card-head"' + breakdownAttr + '>' +
    '<span class="card-t"' + (canBreakdown ? ' style="cursor:pointer" title="Double-click to break down time chart"' : '') + '>' + escapeHtml(panel.label) + (dimDesc ? infoIcon(dimDesc) : '') + '</span>' +
    '<div class="card-filters">' + headRight + '</div>' +
  '</div>';

  var body = '';

  if (panel.chart === 'table') {
    var colHeaders = '';
    var colCount = 4;
    if (panel.columns) {
      colCount = panel.columns.length;
      for (var c = 0; c < panel.columns.length; ++c) {
        var colName = panel.columns[c];
        var colLabel = inferLabel(colName, registry);
        var colDesc = '';
        if (registry.dimensions[colName] && registry.dimensions[colName].description) {
          colDesc = registry.dimensions[colName].description;
        }
        colHeaders += '<th>' + escapeHtml(colLabel) + (colDesc ? infoIcon(colDesc) : '') + '</th>';
      }
    }
    body = '<div class="card-head card-head--sub">' +
      '<span class="group-size-badge" id="table-count-' + panel.id + '">Loading\u2026</span>' +
      '<sl-button size="small" variant="text" id="table-sort-' + panel.id + '">Most Recent</sl-button>' +
    '</div>' +
    '<div class="table-scroll" id="table-scroll-' + panel.id + '">' +
      '<table class="tbl"><thead><tr>' + colHeaders + '</tr></thead>' +
      '<tbody id="table-body-' + panel.id + '">' +
        '<tr><td colspan="' + colCount + '">' + buildSkeletonTable(colCount) + '</td></tr>' +
      '</tbody></table>' +
    '</div>';

  } else if (panel.chart === 'toggle') {
    // Principle 7: clear active state
    body = '<div class="toggle-wrap control-container" id="toggle-' + panel.id + '">' +
      buildToggleHtml(panel.dimension) +
      '<span class="toggle-count" id="toggle-count-' + panel.id + '"></span>' +
    '</div>';

  } else if (panel.chart === 'range') {
    body = '<div class="range-wrap">' + buildRangeSelector(panel.id, panel.label, false) + '</div>';

  } else if (panel.chart === 'selector' || panel.chart === 'list') {
    // Principle 1: informative (counts next to items)
    // Principle 6: infinite scroll + search
    body = '<div class="dim-list-panel dim-list-panel--open">' +
      '<input type="text" class="dim-search" id="search-' + panel.id + '" placeholder="Search ' + escapeHtml(panel.label.toLowerCase()) + '...">' +
      '<div class="dim-list-scroll" id="list-' + panel.id + '">' +
        buildPlaceholderListItems(5) +
      '</div>' +
    '</div>';

  } else if (panel.chart === 'line' || panel._isTimeSeries) {
    // Period/granularity controls are in the model bar title line
    body = '<div id="chart-' + panel.id + '" class="chart-wrap chart-wrap-timeline">' +
      buildSkeletonLine() +
    '</div>';

  } else if (panel.chart === 'pie') {
    body = '<div id="chart-' + panel.id + '" class="chart-wrap">' +
      buildSkeletonPie() +
    '</div>';

  } else if (panel.chart === 'bar') {
    body = '<div id="chart-' + panel.id + '" class="chart-wrap">' +
      buildSkeletonBars(Math.min(panel.limit, 8)) +
    '</div>';
    // Searchable list panel (hidden by default, toggled via List button)
    if (panel.searchable) {
      body += '<div class="dim-list-panel" id="list-panel-' + panel.id + '" style="display:none">' +
        '<input type="text" class="dim-search" placeholder="Search ' + escapeHtml(panel.label.toLowerCase()) + '...">' +
        '<div class="dim-list-scroll" id="list-' + panel.id + '">' +
          buildPlaceholderListItems(5) +
        '</div>' +
      '</div>';
    }

  } else {
    // Generic ECharts fallback
    body = '<div id="chart-' + panel.id + '" class="chart-wrap">' +
      buildSkeletonBars(6) +
    '</div>';
  }

  card.innerHTML = head + body;

  // Wire panel-level interactions
  wireCardInteractions(card, panel);

  cell.appendChild(card);
  return cell;
}

// ── Range selector — noUiSlider (Principle 13 + 14) ──────────────────

function buildRangeSelector(id, label, compact) {
  var cls = compact ? 'range-sel range-sel--compact' : 'range-sel';
  return '<div class="' + cls + '" data-range-id="' + id + '">' +
    '<span class="range-sel-val range-sel-lo-val" id="range-lo-val-' + id + '">0</span>' +
    '<div class="range-sel-slider" id="range-slider-' + id + '"></div>' +
    '<span class="range-sel-val range-sel-hi-val" id="range-hi-val-' + id + '">100</span>' +
  '</div>';
}

function wireRangeSelector(container, panelId, dimension) {
  var sliderEl = container.querySelector('#range-slider-' + panelId);
  if (!sliderEl) return;
  var loVal = container.querySelector('#range-lo-val-' + panelId);
  var hiVal = container.querySelector('#range-hi-val-' + panelId);
  var noUiSlider = globalThis.noUiSlider;
  if (!noUiSlider) return;

  noUiSlider.create(sliderEl, {
    start: [0, 100],
    connect: true,
    range: { min: 0, max: 100 },
    step: 1,
    behaviour: 'drag',
  });

  sliderEl.noUiSlider.on('update', function (values) {
    loVal.textContent = Math.round(values[0]);
    hiVal.textContent = Math.round(values[1]);
  });

  sliderEl.noUiSlider.on('change', function (values) {
    if (dimension) setFilter(dimension, [Math.round(values[0]), Math.round(values[1])]);
  });
}

// ── Period Selector (flatpickr range + smart granularity) ─────────────

// granularityLabel imported from dashboard-meta.js

function formatDateRange(from, to) {
  if (!from && !to) return 'All time';
  var a = new Date(from);
  var b = new Date(to);
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  var sameMonth = sameYear && a.getUTCMonth() === b.getUTCMonth();

  if (sameMonth) {
    // "Mar 1–19, 2026"
    return months[a.getUTCMonth()] + ' ' + a.getUTCDate() + '\u2013' + b.getUTCDate() + ', ' + a.getUTCFullYear();
  }
  if (sameYear) {
    // "Jan 15 – Mar 19, 2026"
    return months[a.getUTCMonth()] + ' ' + a.getUTCDate() + ' \u2013 ' + months[b.getUTCMonth()] + ' ' + b.getUTCDate() + ', ' + a.getUTCFullYear();
  }
  // "Sep 2023 – Mar 2026"
  return months[a.getUTCMonth()] + ' ' + a.getUTCFullYear() + ' \u2013 ' + months[b.getUTCMonth()] + ' ' + b.getUTCFullYear();
}

function buildPeriodControl(tpi) {
  var timeBounds = tpi.timeBounds || {};
  var min = timeBounds.min ? timeBounds.min.slice(0, 10) : '';
  var max = timeBounds.max ? timeBounds.max.slice(0, 10) : '';
  var grans = tpi.granOptions || ['day', 'week', 'month'];
  var defaultGran = tpi.granularity || 'week';
  var granNotes = tpi.granNotes || null;
  // Show typical range if available, otherwise full range
  var defaultRange = tpi.defaultRange || {};
  var displayMin = defaultRange.from || min;
  var displayMax = defaultRange.to || max;
  var rangeLabel = formatDateRange(displayMin, displayMax);

  var html = '<div class="period-control" id="period-control">';

  // Date range trigger — flatpickr will attach here
  html += '<input type="text" class="period-trigger" id="period-trigger" value="' + escapeHtml(rangeLabel) + '" readonly>';

  // Granularity — dropdown selector (single-select / radio behavior)
  var granItems = [];
  for (var g = 0; g < grans.length; ++g) {
    granItems.push({ value: grans[g], label: granularityLabel(grans[g]) });
  }
  html += buildDropdown('_granularity', '', granularityLabel(defaultGran), granItems, false, defaultGran);
  if (granNotes) html += infoIcon(granNotes);

  html += '</div>';
  return html;
}

function wirePeriodControl(container, tpi) {
  var trigger = container.querySelector('#period-trigger');
  if (!trigger) return;

  var dimension = tpi.dimension;
  var timeBounds = tpi.timeBounds || {};
  var min = timeBounds.min ? timeBounds.min.slice(0, 10) : null;
  var max = timeBounds.max ? timeBounds.max.slice(0, 10) : null;
  var presets = inferPeriodPresets(min, max);
  var flatpickr = globalThis.flatpickr;

  if (flatpickr) {
    var fp = flatpickr(trigger, {
      mode: 'range',
      dateFormat: 'Y-m-d',
      minDate: min || undefined,
      maxDate: max || undefined,
      defaultDate: [min, max],
      showMonths: 2,
      animate: true,
      onChange: function (dates) {
        if (dates.length === 2) {
          var from = dates[0].toISOString().slice(0, 10);
          var to = dates[1].toISOString().slice(0, 10);
          trigger.value = formatDateRange(from, to);
          setFilter('_period', [from, to]);
        }
      },
      onReady: function (selectedDates, dateStr, instance) {
        // Add preset buttons to the flatpickr calendar
        if (presets.length > 0) {
          var presetBar = document.createElement('div');
          presetBar.className = 'flatpickr-presets';
          for (var p = 0; p < presets.length; ++p) {
            var btn = document.createElement('button');
            btn.className = 'period-preset-btn';
            btn.textContent = presets[p].label;
            btn.type = 'button';
            (function (preset) {
              btn.addEventListener('click', function () {
                var to = max ? new Date(max) : new Date();
                var from;
                if (preset.days) {
                  from = new Date(to.getTime() - preset.days * 86400000);
                } else if (preset.from) {
                  from = new Date(preset.from);
                } else {
                  from = min ? new Date(min) : new Date(to.getTime() - 365 * 86400000);
                }
                instance.setDate([from, to], true);
              });
            })(presets[p]);
            presetBar.appendChild(btn);
          }
          instance.calendarContainer.prepend(presetBar);
        }
      },
    });
  }

}

// ── Skeleton placeholders ─────────────────────────────────────────────

function buildPlaceholderListItems(count) {
  var html = '';
  for (var i = 0; i < count; ++i) {
    html += '<div class="dim-item">' +
      '<span class="dim-label dim-label--placeholder"></span>' +
      '<span class="dim-count dim-count--placeholder"></span>' +
      '<div class="dim-bar"><div class="dim-bar-fill" style="width:' + (85 - i * 14) + '%"></div></div>' +
    '</div>';
  }
  return html;
}

function buildSkeletonBars(count) {
  var html = '<div class="skeleton-bars">';
  for (var i = 0; i < count; ++i) {
    var w = 90 - i * (60 / count);
    html += '<div class="skeleton-bar">' +
      '<span class="skeleton-label"></span>' +
      '<div class="skeleton-bar-track"><div class="skeleton-bar-fill" style="width:' + w + '%"></div></div>' +
      '<span class="skeleton-value"></span>' +
    '</div>';
  }
  html += '</div>';
  return html;
}

function buildSkeletonLine() {
  return '<div class="skeleton-line-chart">' +
    '<svg viewBox="0 0 400 120" preserveAspectRatio="none" class="skeleton-svg">' +
      '<path d="M0,100 C40,90 80,60 120,65 C160,70 200,30 240,35 C280,40 320,50 360,20 L400,25" ' +
        'fill="none" stroke="currentColor" stroke-width="2" class="skeleton-path"/>' +
      '<path d="M0,100 C40,90 80,60 120,65 C160,70 200,30 240,35 C280,40 320,50 360,20 L400,25 L400,120 L0,120 Z" ' +
        'fill="currentColor" opacity="0.05"/>' +
    '</svg>' +
  '</div>';
}

function buildSkeletonPie() {
  return '<div class="skeleton-pie">' +
    '<svg viewBox="0 0 120 120" class="skeleton-svg">' +
      '<circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" stroke-width="20" ' +
        'stroke-dasharray="80 235" class="skeleton-arc"/>' +
      '<circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" stroke-width="20" ' +
        'stroke-dasharray="50 265" stroke-dashoffset="-80" opacity="0.5" class="skeleton-arc"/>' +
      '<circle cx="60" cy="60" r="50" fill="none" stroke="currentColor" stroke-width="20" ' +
        'stroke-dasharray="105 210" stroke-dashoffset="-130" opacity="0.25" class="skeleton-arc"/>' +
    '</svg>' +
  '</div>';
}

function buildSkeletonTable(columns) {
  var cols = columns || 4;
  var html = '<div class="skeleton-table">';
  for (var r = 0; r < 5; ++r) {
    html += '<div class="skeleton-table-row">';
    for (var c = 0; c < cols; ++c) {
      html += '<span class="skeleton-cell"></span>';
    }
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function wireCardInteractions(card, panel) {
  // Principle 5: single button toggles between "Top X" ↔ "All"
  var showAllBtn = card.querySelector('.show-all-toggle');
  if (showAllBtn) {
    showAllBtn.addEventListener('click', function () {
      var expanded = showAllBtn.dataset.expanded === 'true';
      showAllBtn.dataset.expanded = expanded ? 'false' : 'true';
      showAllBtn.textContent = expanded ? 'Top ' + showAllBtn.dataset.limit : 'All';
      panel._expanded = !expanded;
      notifyFilterChange();
    });
  }

  // Principle 5: List toggle on bar charts
  var listToggle = card.querySelector('.dim-list-toggle');
  if (listToggle) {
    listToggle.addEventListener('click', function () {
      var listPanel = card.querySelector('.dim-list-panel');
      var chartWrap = card.querySelector('.chart-wrap');
      if (listPanel) {
        var showing = listPanel.style.display !== 'none';
        listPanel.style.display = showing ? 'none' : 'block';
        if (chartWrap) chartWrap.style.display = showing ? '' : 'none';
        listToggle.textContent = showing ? 'List' : 'Chart';
      }
    });
  }

  // Toggle interactions
  var toggleWrap = card.querySelector('.toggle-wrap');
  if (toggleWrap) wireToggleClicks(toggleWrap);

}

// ── Dashboard DOM Assembly ────────────────────────────────────────────

function isFilterOnlySection(section) {
  for (var i = 0; i < section.panels.length; ++i) {
    var chart = section.panels[i].chart;
    if (chart !== 'toggle' && chart !== 'range') return false;
  }
  return section.panels.length > 0;
}

function buildFilterBar(section, registry) {
  // Render toggle and range panels as compact inline controls in a single card
  var bar = document.createElement('section');
  bar.className = 'filter-bar anim d6';
  bar.dataset.sectionId = section.id;

  var html = '';
  if (section.label) {
    html += '<div class="filter-bar-header">' +
      '<span class="filter-bar-title">' + escapeHtml(section.label) + '</span>' +
    '</div>';
  }
  html += '<div class="filter-bar-controls">';

  for (var i = 0; i < section.panels.length; ++i) {
    var panel = section.panels[i];
    var dimMeta = registry.dimensions[panel.dimension];
    var dimDesc = dimMeta && dimMeta.description ? dimMeta.description : null;

    if (panel.chart === 'toggle') {
      html += '<div class="filter-bar-item" id="panel-' + panel.id + '">';
      html += '<span class="filter-bar-label">' + escapeHtml(panel.label) + (dimDesc ? infoIcon(dimDesc) : '') + '</span>';
      html += buildToggleHtml(panel.dimension);
      html += '<span class="filter-bar-count" id="toggle-count-' + panel.id + '"></span>';
      html += '</div>';
    } else if (panel.chart === 'range') {
      html += '<div class="filter-bar-item filter-bar-item--range" id="panel-' + panel.id + '">';
      html += '<span class="filter-bar-label">' + escapeHtml(panel.label) + (dimDesc ? infoIcon(dimDesc) : '') + '</span>';
      html += buildRangeSelector(panel.id, panel.label, true);
      html += '</div>';
    }
  }

  html += '</div>';
  bar.innerHTML = html;

  wireToggleClicks(bar);

  return bar;
}

function buildDashboardDOM(container, config, sections, registry) {
  container.innerHTML = '';
  container.appendChild(buildHeader(config));

  // Collect panels assigned to modelbar via layout location
  var modelbarPanels = [];
  var layoutSections = config.layout && config.layout.sections || [];
  var modelbarSectionIds = {};
  for (var ls = 0; ls < layoutSections.length; ++ls) {
    if (layoutSections[ls].location === 'modelbar') {
      modelbarSectionIds[layoutSections[ls].id] = true;
    }
  }

  var filteredSections = [];
  for (var fs = 0; fs < sections.length; ++fs) {
    if (modelbarSectionIds[sections[fs].id]) {
      for (var mp = 0; mp < sections[fs].panels.length; ++mp) {
        modelbarPanels.push(sections[fs].panels[mp]);
      }
    } else {
      filteredSections.push(sections[fs]);
    }
  }

  // Find the first time-series panel for the period control
  var timePanelInfo = null;
  for (var tpi = 0; tpi < filteredSections.length; ++tpi) {
    for (var tpj = 0; tpj < filteredSections[tpi].panels.length; ++tpj) {
      var tp = filteredSections[tpi].panels[tpj];
      if (tp.chart === 'line' && tp._timeBounds) {
        timePanelInfo = {
          dimension: tp.dimension,
          timeBounds: tp._timeBounds,
          defaultRange: tp._defaultRange,
          granularity: tp.granularity,
          granOptions: tp._granOptions,
          granNotes: tp._granNotes,
        };
        break;
      }
    }
    if (timePanelInfo) break;
  }

  var modelBar = buildModelBar(config, registry, modelbarPanels, timePanelInfo);
  if (modelBar) {
    container.appendChild(modelBar);
    // Wire the period control after DOM insertion
    if (timePanelInfo) {
      wirePeriodControl(modelBar, timePanelInfo);
    }
  }

  // Mobile header + filter sheet
  var mobileHeader = buildMobileHeader(config, registry, timePanelInfo);
  container.insertBefore(mobileHeader, container.children[1]);

  var filterSheetParts = buildFilterSheet();
  document.body.appendChild(filterSheetParts.backdrop);
  document.body.appendChild(filterSheetParts.sheet);
  populateFilterSheet(registry, modelbarPanels);

  var animDelay = 2;
  var kpiAccent = 0;

  for (var s = 0; s < filteredSections.length; ++s) {
    var section = filteredSections[s];

    // Filter-only sections render as a compact inline bar
    if (isFilterOnlySection(section)) {
      container.appendChild(buildFilterBar(section, registry));
      animDelay++;
      continue;
    }

    var sectionEl = buildSectionEl(section, Math.min(animDelay, 8));
    var isKpiSection = section.panels.length > 0 && section.panels[0].chart === 'kpi';

    var gridEl;
    if (isKpiSection) {
      gridEl = document.createElement('section');
      gridEl.className = 'kpi-row';
    } else if (section.columns > 1 && section.panels.length > 1) {
      gridEl = document.createElement('div');
      gridEl.className = 'chart-grid';
      if (section.columns !== 3) {
        gridEl.style.gridTemplateColumns = 'repeat(' + section.columns + ', 1fr)';
      }
    } else {
      gridEl = document.createDocumentFragment();
    }

    for (var p = 0; p < section.panels.length; ++p) {
      var panel = section.panels[p];
      var card = buildPanelCard(panel, kpiAccent, registry);
      if (panel.chart === 'kpi') kpiAccent++;
      if (panel.width === 'full' && gridEl.style) {
        card.style.gridColumn = '1 / -1';
      }
      gridEl.appendChild(card);
    }

    if (section.collapsed) {
      var body = document.createElement('div');
      body.className = 'location-body';
      if (section.columns > 1) {
        var innerGrid = document.createElement('div');
        innerGrid.className = 'location-grid';
        if (section.columns !== 4) {
          innerGrid.style.gridTemplateColumns = 'repeat(' + section.columns + ', 1fr)';
        }
        while (gridEl.firstChild) innerGrid.appendChild(gridEl.firstChild);
        body.appendChild(innerGrid);
      } else {
        while (gridEl.firstChild) body.appendChild(gridEl.firstChild);
      }
      sectionEl.appendChild(body);
    } else {
      sectionEl.appendChild(gridEl);
    }

    container.appendChild(sectionEl);
    animDelay++;
  }
}

// ── Main Entry ────────────────────────────────────────────────────────

function getDashboardName() {
  // /demo/dashboards/bluecar-stays → bluecar-stays
  var segments = window.location.pathname.replace(/\/+$/, '').split('/');
  var name = segments[segments.length - 1];
  return name && name !== 'dashboard.html' ? name : 'bluecar-stays';
}

async function fetchConfig(name) {
  var url = 'dashboards/' + name + '.json';
  var res = await fetch(url);
  if (!res.ok) throw new Error('Config not found: ' + url + ' (' + res.status + ')');
  return res.json();
}

async function main() {
  var container = document.getElementById('dashboard');
  var dashboardName = getDashboardName();
  var config = normalizeConfig(await fetchConfig(dashboardName));

  // Principle 11: progress overlay — dashboard renders underneath, updates live
  var overlay = document.createElement('div');
  overlay.className = 'progress-overlay';
  var progressCard = document.createElement('div');
  progressCard.className = 'card progress-steps';
  overlay.appendChild(progressCard);
  document.body.appendChild(overlay);
  _progressOverlay = overlay;
  _progressCard = progressCard;

  var steps = [
    { id: 'meta', label: 'Connecting to data source' },
    { id: 'registry', label: 'Reading model definition' },
    { id: 'layout', label: 'Preparing dashboard layout' },
    { id: 'data', label: 'Loading data' },
  ];

  function updateProgress(activeIdx, summary) {
    var html = '';
    for (var i = 0; i < steps.length; ++i) {
      var cls = i < activeIdx ? 'progress-step--done' : i === activeIdx ? 'progress-step--active' : '';
      html += '<div class="progress-step ' + cls + '">' +
        '<span class="progress-dot"></span>' +
        '<span>' + steps[i].label + (i < activeIdx ? ' &#10003;' : '') + '</span>' +
      '</div>';
    }
    if (summary) {
      html += '<div class="progress-summary">' + escapeHtml(summary) + '</div>';
    }
    progressCard.innerHTML = html;
  }

  function dismissProgress() {
    overlay.classList.add('progress-overlay--done');
    setTimeout(function () { overlay.remove(); }, 600);
  }

  try {
    registerDemoEChartsTheme(echarts);

    // Inject breakdown indicator style
    var breakdownStyle = document.createElement('style');
    breakdownStyle.textContent =
      '.chart-card--breakdown { box-shadow: 0 0 0 1.5px rgba(63,101,135,0.35); }' +
      '.chart-card--breakdown .card-t { color: #3f6587; }' +
      '.viz-icon-bar { display: flex; gap: 2px; align-items: center; }' +
      '.viz-icon { border: none; background: none; padding: 3px 4px; border-radius: 4px; cursor: pointer; color: #8da4b8; line-height: 0; }' +
      '.viz-icon:hover { color: #3f6587; background: rgba(63,101,135,0.08); }' +
      '.viz-icon--active { color: #3d8bfd; background: rgba(61,139,253,0.1); }' +
      '.viz-icon--active:hover { color: #3d8bfd; background: rgba(61,139,253,0.15); }';
    document.head.appendChild(breakdownStyle);

    filterState = readUrlState(); // Principle 3: read URL state early (no network needed)

    updateProgress(0);
    var metaResponse = await fetchCubeMeta();

    updateProgress(1);
    var registry = buildCubeRegistry(metaResponse, config.cube);
    console.log('[dashboard] Cube registry:', registry.name, '\u2014',
      Object.keys(registry.dimensions).length, 'dims,',
      Object.keys(registry.measures).length, 'measures');

    updateProgress(2, registry.title);

    // Extract model-level metadata (grain, period, granularity, refresh)
    var modelMeta = extractModelMeta(registry);
    var modelPeriod = resolveModelPeriod(modelMeta);
    var granOptions = getGranularityOptions(modelMeta);
    var granDefault = getDefaultGranularity(modelMeta);
    var granNotes = getGranularityNotes(modelMeta);

    console.log('[dashboard] Model meta:', modelMeta.grain || 'unknown grain',
      '| period:', modelPeriod ? modelPeriod.earliest + ' \u2013 ' + modelPeriod.latest : 'not declared',
      '| granularity:', granOptions.join(', '), '(default:', granDefault + ')');

    var resolvedPanels = resolvePanels(config, registry);

    // Attach model period and granularity to time-series panels
    for (var rp = 0; rp < resolvedPanels.length; ++rp) {
      var rpanel = resolvedPanels[rp];
      if (rpanel.chart === 'line' && rpanel.dimension) {
        if (modelPeriod) {
          // Use typical_range for the default view, full range for date picker bounds
          var typicalRange = resolveTypicalRange(
            modelPeriod.typicalRange, modelPeriod.earliest, modelPeriod.latest
          );
          rpanel._timeBounds = { min: modelPeriod.earliest, max: modelPeriod.latest };
          rpanel._defaultRange = typicalRange;
        }
        rpanel._granOptions = granOptions;
        rpanel._granNotes = granNotes;
        if (!rpanel.granularity) rpanel.granularity = granDefault;
      }
    }

    var sections = resolveSections(config, resolvedPanels);

    // Render dashboard immediately — visible under the overlay
    buildDashboardDOM(container, config, sections, registry);
    wireFilterSheet();
    restoreStateFromUrl();
    renderFilterChips();

    // Wire viz type icon buttons on time charts
    container.addEventListener('click', function(e) {
      var btn = e.target.closest('.viz-icon');
      if (!btn) return;
      var viz = btn.dataset.viz;
      if (!viz) return;
      filterState['_timeChart'] = viz;
      writeUrlState(filterState);
      // Update active state on all viz icons
      var allIcons = container.querySelectorAll('.viz-icon');
      for (var vi = 0; vi < allIcons.length; ++vi) {
        allIcons[vi].classList.toggle('viz-icon--active', allIcons[vi].dataset.viz === viz);
      }
      notifyFilterChange();
    });

    // Wire breakdown: double-click on card header activates breakdown
    container.addEventListener('dblclick', function(e) {
      var head = e.target.closest('[data-breakdown-panel]');
      if (!head) return;
      var panelId = head.dataset.breakdownPanel;
      var current = filterState['_breakdown'];
      if (current === panelId) {
        delete filterState['_breakdown'];
      } else {
        filterState['_breakdown'] = panelId;
      }
      writeUrlState(filterState);
      triggerBreakdownChange();
    });

    console.log('[dashboard] Dashboard rendered, loading data...');

    updateProgress(3, 'Connecting to data source...');

    var data = await createDashboardData(config, registry, resolvedPanels);
    _dashboardData = data;
    _dashboardRegistry = registry;
    _dashboardPanels = resolvedPanels;

    data.on('progress', function(payload) {
      if (payload.status === 'starting') {
        updateProgress(3, 'Connecting...');
      } else if (payload.status === 'downloading') {
        var pct = payload.fetch.percent;
        var label = pct != null ? Math.round(pct * 100) + '% downloaded' : 'Downloading...';
        updateProgress(3, label);
      } else if (payload.status === 'streaming') {
        updateProgress(3, payload.load.rowsLoaded.toLocaleString() + ' rows loaded');
      }
    });

    data.on('error', function(payload) {
      var msg = payload && payload.message ? payload.message : 'Data loading failed';
      progressCard.innerHTML = '<div class="progress-step progress-step--error">' +
        '<span class="progress-dot"></span>' +
        '<span>' + escapeHtml(msg) + '</span>' +
      '</div>';
    });

    await data.ready;
    console.log('[dashboard] Data loaded, rendering charts...');

    // Restore breakdown from URL state (must happen before initial query)
    if (filterState['_breakdown']) {
      var breakdownDim = null;
      for (var bi = 0; bi < resolvedPanels.length; ++bi) {
        if (resolvedPanels[bi].id === filterState['_breakdown']) {
          breakdownDim = resolvedPanels[bi]._dimField;
          break;
        }
      }
      if (breakdownDim) {
        await data.setBreakdown(breakdownDim);
        console.log('[dashboard] Restored breakdown from URL:', breakdownDim);
      }
    }

    // Use module-scoped _dashboardData so this listener survives reloads
    filterListeners.push(function(newFilterState) {
      _dashboardData.query(newFilterState).then(function(response) {
        renderAllPanels(_dashboardPanels, response, _dashboardRegistry);
      });
    });

    var initialResponse = await data.query(filterState);
    renderAllPanels(resolvedPanels, initialResponse, registry);

    dismissProgress();
    wireChartResize();

  } catch (err) {
    container.innerHTML = '<div class="error-banner" style="display:block">' +
      'Dashboard error: ' + escapeHtml(err.message) + '</div>';
    console.error('[dashboard]', err);
  }
}

main();
