// demo/dashboard-engine.js
// Core engine: reads config, fetches metadata, generates DOM, wires crossfilter.
// All first principles applied to wireframe structure.

import { BLUECAR_STAYS_CONFIG } from './dashboard-config.js';
import {
  fetchCubeMeta,
  buildCubeRegistry,
  inferChartType,
  inferLabel,
  inferFilterMode,
  inferLimit,
  inferSearchable,
  discoverBooleanDimensions,
  discoverFacetDimensions,
  discoverNotableMeasures,
} from './dashboard-meta.js';
import {
  registerDemoEChartsTheme,
  getDemoEChartsThemeName,
} from './echarts-theme.js';

var echarts = globalThis.echarts;
var crossfilter = globalThis.crossfilter;

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

var filterState = {};
var filterListeners = [];

function setFilter(dimension, values) {
  if (!values || (Array.isArray(values) && values.length === 0)) {
    delete filterState[dimension];
  } else {
    filterState[dimension] = values;
  }
  writeUrlState(filterState);
  renderFilterChips();
  notifyFilterChange();
}

function clearAllFilters() {
  filterState = {};
  writeUrlState(filterState);
  renderFilterChips();
  notifyFilterChange();
  // Deselect all active pills/buttons
  var actives = document.querySelectorAll('.mode-btn.active, .dim-item--selected');
  for (var i = 0; i < actives.length; ++i) actives[i].classList.remove('active', 'dim-item--selected');
}

function notifyFilterChange() {
  for (var i = 0; i < filterListeners.length; ++i) filterListeners[i](filterState);
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

    resolved.push({
      id: p.id || (fieldName ? fieldName : 'panel-' + i),
      dimension: p.dimension || null,
      measure: p.measure || null,
      chart: chartType,
      label: p.label || (fieldName ? inferLabel(fieldName, registry) : chartType),
      limit: p.limit || (fieldName ? inferLimit(fieldName, registry) : 50),
      sort: p.sort || 'value',
      filter: p.filter || (fieldName ? inferFilterMode(fieldName, registry) : 'none'),
      granularity: p.granularity || null,
      op: p.op || 'count',
      field: p.field || null,
      columns: p.columns || null,
      section: p.section || '_default',
      width: p.width || null,
      collapsed: p.collapsed != null ? p.collapsed : false,
      searchable: p.searchable != null ? p.searchable : (fieldName ? inferSearchable(fieldName, registry) : false),
      worker: p.worker || null,
    });
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

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatCount(n) {
  if (n == null) return '\u2014';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ── Principle 8: Filter Chips (visible, removable) ────────────────────

function renderFilterChips() {
  var container = document.getElementById('filter-chips');
  if (!container) return;
  container.innerHTML = '';
  var clearBtn = document.getElementById('clear-all-btn');

  var keys = Object.keys(filterState);
  if (keys.length === 0) {
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (clearBtn) clearBtn.style.display = '';

  for (var i = 0; i < keys.length; ++i) {
    var dim = keys[i];
    var val = filterState[dim];
    var label = Array.isArray(val) ? val.join(', ') : String(val);
    var chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = '<span class="filter-chip-label">' + escapeHtml(dim) + ': ' + escapeHtml(label) + '</span>' +
      '<button class="filter-chip-remove" data-dim="' + escapeHtml(dim) + '">&times;</button>';
    container.appendChild(chip);
  }

  container.addEventListener('click', function (e) {
    var removeBtn = e.target.closest('.filter-chip-remove');
    if (removeBtn) setFilter(removeBtn.dataset.dim, null);
  });
}

// ── Principle 2: Info tooltip (i) ─────────────────────────────────────

function infoIcon(text) {
  if (!text) return '';
  return ' <span class="info-icon" title="' + escapeHtml(text) + '">&#9432;</span>';
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
      '<button id="clear-all-btn" class="btn btn-ghost" style="display:none">Clear All</button>' +
    '</div>';
  // Wire clear all (Principle 8)
  header.querySelector('#clear-all-btn').addEventListener('click', clearAllFilters);
  return header;
}

// ── Model Intelligence Bar ────────────────────────────────────────────
// Principle 2: description tucked behind (i), clean surface

function buildModelBar(config, registry) {
  var modelBarConfig = config.modelBar;
  if (modelBarConfig === false) return null;
  modelBarConfig = modelBarConfig || {};

  var segments = registry.segments || [];
  var booleans = discoverBooleanDimensions(registry);
  var facets = discoverFacetDimensions(registry);

  // Filter out booleans already in panels
  var panelDims = {};
  var panels = config.panels || [];
  for (var p = 0; p < panels.length; ++p) {
    if (panels[p].dimension) panelDims[panels[p].dimension] = true;
  }
  var extraBooleans = booleans.filter(function (b) { return !panelDims[b.name]; });

  var hasSegments = modelBarConfig.segments !== false && segments.length > 0;
  var hasPresets = modelBarConfig.presets !== false && extraBooleans.length > 0;
  var hasFacets = facets.length > 0;

  if (!hasSegments && !hasPresets && !hasFacets && !registry.description) return null;

  var bar = document.createElement('section');
  bar.className = 'card model-bar anim d1';
  var html = '';

  // Cube identity — user-facing, with (i) for full description (Principle 2)
  html += '<div class="model-bar-header">';
  html += '<div class="model-bar-identity">';
  html += '<span class="model-bar-title">' + escapeHtml(registry.title) + '</span>';
  if (registry.description) {
    html += infoIcon(registry.description);
  }
  html += '</div>';
  html += '</div>';

  // Segments
  if (hasSegments) {
    html += '<div class="model-bar-group">';
    html += '<span class="model-bar-label">Segments</span>';
    html += '<div class="pill-group">';
    for (var s = 0; s < segments.length; ++s) {
      var seg = segments[s];
      html += '<button class="mode-btn" data-segment="' + escapeHtml(seg.name) + '">' +
        escapeHtml(seg.title) +
        (seg.description ? infoIcon(seg.description) : '') +
      '</button>';
    }
    html += '</div></div>';
  }

  // Boolean presets
  if (hasPresets) {
    html += '<div class="model-bar-group">';
    html += '<span class="model-bar-label">Quick Filters</span>';
    html += '<div class="pill-group">';
    for (var b = 0; b < extraBooleans.length; ++b) {
      var bool = extraBooleans[b];
      html += '<button class="mode-btn" data-boolean="' + escapeHtml(bool.name) + '">' +
        escapeHtml(bool.label) + '</button>';
    }
    html += '</div></div>';
  }

  // Facets
  if (hasFacets) {
    for (var f = 0; f < facets.length; ++f) {
      var facet = facets[f];
      if (Array.isArray(modelBarConfig.facets) && modelBarConfig.facets.indexOf(facet.name) < 0) continue;
      html += '<div class="model-bar-group">';
      html += '<span class="model-bar-label">' + escapeHtml(facet.label) + '</span>';
      html += '<div class="pill-group">';
      for (var v = 0; v < facet.values.length; ++v) {
        html += '<button class="mode-btn" data-facet="' + escapeHtml(facet.name) + '" data-value="' + escapeHtml(facet.values[v]) + '">' +
          escapeHtml(facet.values[v]) + '</button>';
      }
      html += '</div></div>';
    }
  }

  bar.innerHTML = html;

  // Wire interactions — Principle 7: clear selection state
  bar.addEventListener('click', function (e) {
    var btn = e.target.closest('.mode-btn');
    if (!btn) return;

    // Segment toggle
    if (btn.dataset.segment) {
      btn.classList.toggle('active');
      var activeSegs = bar.querySelectorAll('[data-segment].active');
      var segVals = [];
      for (var i = 0; i < activeSegs.length; ++i) segVals.push(activeSegs[i].dataset.segment);
      setFilter('_segment', segVals);
      return;
    }

    // Boolean toggle (3-state: true → false → all)
    if (btn.dataset.boolean) {
      var siblings = btn.parentNode.querySelectorAll('[data-boolean="' + btn.dataset.boolean + '"]');
      // This is a single button — cycle through states
      var current = btn.dataset.state || 'all';
      var next = current === 'all' ? 'true' : current === 'true' ? 'false' : 'all';
      btn.dataset.state = next;
      btn.classList.toggle('active', next !== 'all');
      btn.classList.toggle('active-neg', next === 'false');
      setFilter(btn.dataset.boolean, next === 'all' ? null : next);
      return;
    }

    // Facet multi-select
    if (btn.dataset.facet) {
      btn.classList.toggle('active');
      var activeFacets = bar.querySelectorAll('[data-facet="' + btn.dataset.facet + '"].active');
      var vals = [];
      for (var j = 0; j < activeFacets.length; ++j) vals.push(activeFacets[j].dataset.value);
      setFilter(btn.dataset.facet, vals);
    }
  });

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
    card.className = 'kpi kpi-' + color;
    card.id = 'panel-' + panel.id;
    // Principle 2: (i) for measure description
    var measMeta = registry.measures[panel.measure];
    var measDesc = measMeta && measMeta.description ? measMeta.description : null;
    card.innerHTML =
      '<div class="kpi-label">' + escapeHtml(panel.label) + (measDesc ? infoIcon(measDesc) : '') + '</div>' +
      '<div class="kpi-value">\u2014</div>';
    return card;
  }

  card.className = 'card chart-card';
  card.id = 'panel-' + panel.id;

  // Dimension description for (i)
  var dimMeta = registry.dimensions[panel.dimension];
  var dimDesc = dimMeta && dimMeta.description ? dimMeta.description : null;

  // Card head — Principle 4/5: Top X badge + Show All toggle
  var headRight = '';
  if (panel.chart === 'bar' || panel.chart === 'pie') {
    headRight += '<span class="group-size-badge">Top ' + panel.limit + '</span>';
    headRight += '<button class="btn btn-ghost btn-tiny show-all-toggle" data-panel="' + panel.id + '">Show All</button>';
  }
  if (panel.chart === 'bar' && panel.searchable) {
    headRight += '<button class="btn btn-ghost btn-tiny dim-list-toggle" data-panel="' + panel.id + '">List</button>';
  }
  if (panel.chart === 'list') {
    headRight += '<span class="group-size-badge" id="count-' + panel.id + '"></span>';
  }

  var head = '<div class="card-head">' +
    '<span class="card-t">' + escapeHtml(panel.label) + (dimDesc ? infoIcon(dimDesc) : '') + '</span>' +
    '<div class="card-filters">' + headRight + '</div>' +
  '</div>';

  var body = '';

  if (panel.chart === 'table') {
    // Principle 6: table with row count + sort
    var colHeaders = '';
    if (panel.columns) {
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
      '<span class="group-size-badge" id="table-count-' + panel.id + '">0 rows</span>' +
      '<button class="btn btn-ghost btn-tiny" id="table-sort-' + panel.id + '">Most Recent</button>' +
    '</div>' +
    '<div class="table-scroll" id="table-scroll-' + panel.id + '">' +
      '<table class="tbl"><thead><tr>' + colHeaders + '</tr></thead>' +
      '<tbody id="table-body-' + panel.id + '"></tbody></table>' +
    '</div>';

  } else if (panel.chart === 'toggle') {
    // Principle 7: clear active state
    body = '<div class="toggle-wrap" id="toggle-' + panel.id + '">' +
      '<div class="pill-group">' +
        '<button class="mode-btn" data-val="true">Yes</button>' +
        '<button class="mode-btn" data-val="false">No</button>' +
        '<button class="mode-btn active" data-val="all">All</button>' +
      '</div>' +
      '<span class="toggle-count" id="toggle-count-' + panel.id + '"></span>' +
    '</div>';

  } else if (panel.chart === 'range') {
    body = '<div class="range-wrap" id="range-' + panel.id + '">' +
      '<div class="range-header">' +
        '<span class="range-min" id="range-min-' + panel.id + '">0</span>' +
        '<span class="range-current" id="range-val-' + panel.id + '">\u2014</span>' +
        '<span class="range-max" id="range-max-' + panel.id + '">100</span>' +
      '</div>' +
      '<input type="range" class="range-slider" min="0" max="100" value="0" id="range-input-' + panel.id + '">' +
    '</div>';

  } else if (panel.chart === 'list') {
    // Principle 1: informative (counts next to items)
    // Principle 6: infinite scroll + search
    body = '<div class="dim-list-panel dim-list-panel--open">' +
      '<input type="text" class="dim-search" id="search-' + panel.id + '" placeholder="Search ' + escapeHtml(panel.label.toLowerCase()) + '...">' +
      '<div class="dim-list-scroll" id="list-' + panel.id + '">' +
        buildPlaceholderListItems(5) +
      '</div>' +
    '</div>';

  } else if (panel.chart === 'line') {
    // Time series with granularity toggle
    var granBtns = '';
    var grans = ['minute', 'hour', 'day', 'week', 'month'];
    for (var g = 0; g < grans.length; ++g) {
      var isActive = panel.granularity === grans[g] ? ' active' : '';
      granBtns += '<button class="gran-btn' + isActive + '" data-gran="' + grans[g] + '">' +
        grans[g].charAt(0).toUpperCase() + grans[g].slice(1) + '</button>';
    }
    body = '<div class="card-head card-head--sub">' +
      '<span class="group-size-badge" id="time-badge-' + panel.id + '"></span>' +
      '<div class="gran-btns">' + granBtns + '</div>' +
    '</div>' +
    '<div id="chart-' + panel.id + '" class="chart-wrap chart-wrap-timeline"></div>';

  } else {
    // ECharts chart — Principle 4: placeholder showing Top X + Other pattern
    body = '<div id="chart-' + panel.id + '" class="chart-wrap"></div>';
  }

  card.innerHTML = head + body;

  // Wire panel-level interactions
  wireCardInteractions(card, panel);

  return card;
}

function buildPlaceholderListItems(count) {
  // Principle 1: list items show count bar alongside label
  var html = '';
  for (var i = 0; i < count; ++i) {
    html += '<div class="dim-item">' +
      '<span class="dim-label dim-label--placeholder"></span>' +
      '<span class="dim-count dim-count--placeholder"></span>' +
      '<div class="dim-bar"><div class="dim-bar-fill" style="width:' + (80 - i * 15) + '%"></div></div>' +
    '</div>';
  }
  return html;
}

function wireCardInteractions(card, panel) {
  // Principle 5: Show All toggle
  var showAllBtn = card.querySelector('.show-all-toggle');
  if (showAllBtn) {
    showAllBtn.addEventListener('click', function () {
      var expanded = showAllBtn.dataset.expanded === 'true';
      showAllBtn.dataset.expanded = expanded ? 'false' : 'true';
      showAllBtn.textContent = expanded ? 'Show All' : 'Top ' + panel.limit;
      // TODO: re-render chart with all vs top-N
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

  // Toggle interactions — Principle 7: clear selection state
  var toggleWrap = card.querySelector('.toggle-wrap');
  if (toggleWrap) {
    toggleWrap.addEventListener('click', function (e) {
      var btn = e.target.closest('.mode-btn');
      if (!btn) return;
      var siblings = toggleWrap.querySelectorAll('.mode-btn');
      for (var i = 0; i < siblings.length; ++i) siblings[i].classList.remove('active');
      btn.classList.add('active');
      var val = btn.dataset.val;
      setFilter(panel.dimension, val === 'all' ? null : val);
    });
  }
}

// ── Dashboard DOM Assembly ────────────────────────────────────────────

function buildDashboardDOM(container, config, sections, registry) {
  container.innerHTML = '';
  container.appendChild(buildHeader(config));

  var modelBar = buildModelBar(config, registry);
  if (modelBar) container.appendChild(modelBar);

  var animDelay = 2;
  var kpiAccent = 0;

  for (var s = 0; s < sections.length; ++s) {
    var section = sections[s];
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

async function main() {
  var container = document.getElementById('dashboard');
  var config = BLUECAR_STAYS_CONFIG;

  // Principle: meaningful progress steps
  var progressEl = document.createElement('div');
  progressEl.className = 'card progress-steps';
  progressEl.style.maxWidth = '480px';
  progressEl.style.margin = '60px auto';
  container.innerHTML = '';
  container.appendChild(progressEl);

  var steps = [
    { id: 'meta', label: 'Connecting to data source' },
    { id: 'registry', label: 'Reading model definition' },
    { id: 'layout', label: 'Preparing dashboard layout' },
    { id: 'render', label: 'Rendering components' },
  ];

  function updateProgress(activeIdx, summary) {
    var html = '';
    for (var i = 0; i < steps.length; ++i) {
      var cls = i < activeIdx ? 'progress-step--done' : i === activeIdx ? 'progress-step--active' : '';
      var icon = i < activeIdx ? '&#10003;' : '';
      html += '<div class="progress-step ' + cls + '">' +
        '<span class="progress-dot"></span>' +
        '<span>' + steps[i].label + (icon ? ' ' + icon : '') + '</span>' +
      '</div>';
    }
    if (summary) {
      html += '<div class="progress-summary">' + escapeHtml(summary) + '</div>';
    }
    progressEl.innerHTML = html;
  }

  try {
    registerDemoEChartsTheme(echarts);

    updateProgress(0);
    var metaResponse = await fetchCubeMeta();

    updateProgress(1);
    var registry = buildCubeRegistry(metaResponse, config.cube);
    var dimCount = Object.keys(registry.dimensions).length;
    var measCount = Object.keys(registry.measures).length;
    var segCount = registry.segments.length;
    console.log('[dashboard] Cube registry:', registry.name, '\u2014', dimCount, 'dims,', measCount, 'measures');

    updateProgress(2, registry.title + ' \u2014 ' +
      segCount + ' analysis segments available');
    var resolvedPanels = resolvePanels(config, registry);
    var sections = resolveSections(config, resolvedPanels);
    console.log('[dashboard] Resolved', resolvedPanels.length, 'panels in', sections.length, 'sections');

    // Principle 3: restore state from URL
    filterState = readUrlState();

    updateProgress(3, resolvedPanels.length + ' panels in ' + sections.length + ' sections');
    // Small delay so user sees the final step
    await new Promise(function (r) { setTimeout(r, 300); });

    buildDashboardDOM(container, config, sections, registry);
    renderFilterChips();
    console.log('[dashboard] Wireframe rendered with first principles applied');

  } catch (err) {
    container.innerHTML = '<div class="error-banner" style="display:block">' +
      'Dashboard error: ' + escapeHtml(err.message) + '</div>';
    console.error('[dashboard]', err);
  }
}

main();
