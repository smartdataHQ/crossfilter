// demo/dashboard-engine.js
// Core engine: reads config, fetches metadata, generates DOM, wires crossfilter.
// Phase 1: DOM wireframe with placeholder cards.

import { BLUECAR_STAYS_CONFIG } from './dashboard-config.js';
import {
  fetchCubeMeta,
  buildCubeRegistry,
  inferChartType,
  inferLabel,
  inferFilterMode,
  inferLimit,
  inferSearchable,
} from './dashboard-meta.js';
import {
  registerDemoEChartsTheme,
  getDemoEChartsThemeName,
} from './echarts-theme.js';

var echarts = globalThis.echarts;
var crossfilter = globalThis.crossfilter;

// ── Resolve panel defaults from metadata ──────────────────────────────

function resolvePanels(config, registry) {
  var panels = config.panels || [];
  var resolved = [];
  for (var i = 0; i < panels.length; ++i) {
    var p = panels[i];
    var fieldName = p.dimension || p.measure || null;
    var chartType = p.chart || (fieldName ? inferChartType(fieldName, registry) : 'table');

    // Validate field exists in registry (skip if not found)
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

  // Assign panels to sections
  for (var i = 0; i < resolvedPanels.length; ++i) {
    var p = resolvedPanels[i];
    if (!sectionMap[p.section]) {
      sectionMap[p.section] = { id: p.section, label: p.section, columns: 3, collapsed: false, panels: [] };
    }
    sectionMap[p.section].panels.push(p);
  }

  // Return sections in layout order, then any extras
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

// ── DOM Generation ────────────────────────────────────────────────────

var ACCENT_COLORS = ['green', 'blue', 'amber', 'red', 'purple'];

function escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function buildHeader(config) {
  var header = document.createElement('header');
  header.className = 'header anim d1';
  header.innerHTML =
    '<div class="header-left">' +
      '<h1>' + escapeHtml(config.title || 'Dashboard') + '</h1>' +
    '</div>' +
    '<div class="header-right">' +
      '<div id="filter-chips" class="filter-chips"></div>' +
      '<button id="clear-all-btn" class="btn btn-ghost">Clear All</button>' +
    '</div>';
  return header;
}

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

function buildPanelCard(panel, accentIdx) {
  var isKpi = panel.chart === 'kpi';
  var card = document.createElement('div');

  if (isKpi) {
    var color = ACCENT_COLORS[accentIdx % ACCENT_COLORS.length];
    card.className = 'kpi kpi-' + color;
    card.id = 'panel-' + panel.id;
    card.innerHTML =
      '<div class="kpi-label">' + escapeHtml(panel.label) + '</div>' +
      '<div class="kpi-value">\u2014</div>';
    return card;
  }

  card.className = 'card chart-card';
  card.id = 'panel-' + panel.id;

  var head = '<div class="card-head">' +
    '<span class="card-t">' + escapeHtml(panel.label) + '</span>' +
    '<div class="card-filters">' +
      '<span class="group-size-badge chart-type-badge">' + panel.chart + '</span>' +
    '</div>' +
  '</div>';

  var body = '';
  if (panel.chart === 'table') {
    body = '<div class="table-scroll"><table class="tbl">' +
      '<thead><tr id="table-head-' + panel.id + '"></tr></thead>' +
      '<tbody id="table-body-' + panel.id + '"></tbody>' +
    '</table></div>';
  } else if (panel.chart === 'toggle') {
    body = '<div class="pill-group" id="toggle-' + panel.id + '">' +
      '<button class="mode-btn">True</button>' +
      '<button class="mode-btn">False</button>' +
      '<button class="mode-btn active">All</button>' +
    '</div>';
  } else if (panel.chart === 'range') {
    body = '<div style="padding: 12px 16px">' +
      '<input type="range" style="width:100%" min="0" max="100" value="50">' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted)">' +
        '<span>0</span><span>\u2014</span><span>100</span>' +
      '</div>' +
    '</div>';
  } else if (panel.chart === 'list') {
    body = '<div class="dim-list-panel" style="display:block">' +
      '<input type="text" class="dim-search" placeholder="Search ' + escapeHtml(panel.label.toLowerCase()) + '...">' +
      '<div class="dim-list-scroll" id="list-' + panel.id + '">' +
        '<div class="dim-item"><span class="dim-label">Loading...</span></div>' +
      '</div>' +
    '</div>';
  } else {
    // ECharts chart container
    body = '<div id="chart-' + panel.id + '" class="chart-wrap' +
      (panel.chart === 'line' ? ' chart-wrap-timeline' : '') + '"></div>';
  }

  card.innerHTML = head + body;
  return card;
}

function buildDashboardDOM(container, config, sections) {
  container.innerHTML = '';
  container.appendChild(buildHeader(config));

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
      var card = buildPanelCard(panel, kpiAccent);
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

  container.innerHTML =
    '<div class="loading-popover" style="position:static;display:block;margin:40px auto">' +
    '<div class="loading-pop-header"><span class="loading-pop-title">Fetching model metadata...</span></div>' +
    '<div class="loading-pop-bar"><div class="loading-pop-bar-fill" style="width:30%"></div></div></div>';

  try {
    registerDemoEChartsTheme(echarts);

    var metaResponse = await fetchCubeMeta();
    var registry = buildCubeRegistry(metaResponse, config.cube);
    console.log('[dashboard] Cube registry:', registry.name, '\u2014',
      Object.keys(registry.dimensions).length, 'dims,',
      Object.keys(registry.measures).length, 'measures');

    var resolvedPanels = resolvePanels(config, registry);
    var sections = resolveSections(config, resolvedPanels);
    console.log('[dashboard] Resolved', resolvedPanels.length, 'panels in', sections.length, 'sections');

    buildDashboardDOM(container, config, sections);
    console.log('[dashboard] DOM wireframe rendered');

  } catch (err) {
    container.innerHTML = '<div class="error-banner" style="display:block">' +
      'Dashboard error: ' + escapeHtml(err.message) + '</div>';
    console.error('[dashboard]', err);
  }
}

main();
