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
  discoverTimeDimensions,
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
  // Reset all selection states
  var actives = document.querySelectorAll('.mode-btn.active, .dim-item--selected, .dropdown-item--selected, .pill--active, .pill--negative, .dropdown-value--active');
  for (var i = 0; i < actives.length; ++i) {
    actives[i].classList.remove('active', 'dim-item--selected', 'dropdown-item--selected', 'pill--active', 'pill--negative', 'dropdown-value--active');
  }
  // Reset dropdown trigger labels
  var ddValues = document.querySelectorAll('.dropdown-value');
  for (var j = 0; j < ddValues.length; ++j) {
    if (ddValues[j].dataset.placeholder) ddValues[j].textContent = ddValues[j].dataset.placeholder;
  }
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

var _chipListenerWired = false;

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
    var vals = Array.isArray(val) ? val : [val];
    var displayDim = dim.replace(/^_/, '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });

    if (vals.length === 1) {
      // Single value — simple chip with × to remove
      var chip = document.createElement('span');
      chip.className = 'filter-chip';
      chip.innerHTML = '<span class="filter-chip-label">' + escapeHtml(displayDim) + ': ' + escapeHtml(vals[0]) + '</span>' +
        '<button class="filter-chip-remove" data-dim="' + escapeHtml(dim) + '">&times;</button>';
      container.appendChild(chip);
    } else {
      // Multiple values — expandable chip group
      var group = document.createElement('span');
      group.className = 'filter-chip-group';

      var summary = document.createElement('button');
      summary.className = 'filter-chip filter-chip--expandable';
      summary.type = 'button';
      summary.innerHTML = '<span class="filter-chip-label">' + escapeHtml(displayDim) + ' (' + vals.length + ')</span>' +
        '<button class="filter-chip-remove" data-dim="' + escapeHtml(dim) + '">&times;</button>';
      group.appendChild(summary);

      var expandPanel = document.createElement('div');
      expandPanel.className = 'filter-chip-expand';
      for (var v = 0; v < vals.length; ++v) {
        var subChip = document.createElement('span');
        subChip.className = 'filter-chip filter-chip--sub';
        subChip.innerHTML = '<span class="filter-chip-label">' + escapeHtml(vals[v]) + '</span>' +
          '<button class="filter-chip-remove-one" data-dim="' + escapeHtml(dim) + '" data-val="' + escapeHtml(vals[v]) + '">&times;</button>';
        expandPanel.appendChild(subChip);
      }
      group.appendChild(expandPanel);
      container.appendChild(group);
    }
  }

  if (!_chipListenerWired) {
    _chipListenerWired = true;
    container.addEventListener('click', function (e) {
      // Remove entire filter
      var removeAll = e.target.closest('.filter-chip-remove');
      if (removeAll && !e.target.closest('.filter-chip-remove-one')) {
        var dim = removeAll.dataset.dim;
        setFilter(dim, null);
        syncDropdownAfterRemove(dim);
        return;
      }

      // Remove single value from multi-select
      var removeOne = e.target.closest('.filter-chip-remove-one');
      if (removeOne) {
        var dim2 = removeOne.dataset.dim;
        var val = removeOne.dataset.val;
        var current = filterState[dim2];
        if (Array.isArray(current)) {
          var updated = current.filter(function (v) { return v !== val; });
          setFilter(dim2, updated);
        }
        syncDropdownAfterRemove(dim2, val);
        return;
      }

      // Toggle expand on group chip
      var expandable = e.target.closest('.filter-chip--expandable');
      if (expandable) {
        var group = expandable.closest('.filter-chip-group');
        if (group) group.classList.toggle('filter-chip-group--open');
      }
    });
  }
}

function syncDropdownAfterRemove(dim, singleVal) {
  var dd = document.querySelector('[data-dropdown-id="' + dim + '"]');
  if (!dd) return;

  if (singleVal) {
    // Deselect just this one
    var items = dd.querySelectorAll('.dropdown-item--selected');
    for (var i = 0; i < items.length; ++i) {
      if (items[i].dataset.value === singleVal) items[i].classList.remove('dropdown-item--selected');
    }
  } else {
    // Deselect all
    var selected = dd.querySelectorAll('.dropdown-item--selected');
    for (var j = 0; j < selected.length; ++j) selected[j].classList.remove('dropdown-item--selected');
  }

  // Update trigger label
  var remaining = dd.querySelectorAll('.dropdown-item--selected');
  var valueEl = dd.querySelector('.dropdown-value');
  if (!valueEl) return;
  if (remaining.length === 0) {
    valueEl.textContent = valueEl.dataset.placeholder || 'All';
    valueEl.classList.remove('dropdown-value--active');
  } else if (remaining.length === 1) {
    var label = remaining[0].querySelector('.dropdown-item-label');
    valueEl.textContent = label ? label.textContent : '';
    valueEl.classList.add('dropdown-value--active');
  } else {
    valueEl.textContent = remaining.length + ' selected';
    valueEl.classList.add('dropdown-value--active');
  }
}

// ── Principle 2: Info tooltip (i) ─────────────────────────────────────

function infoIcon(text) {
  if (!text || !text.trim()) return '';
  return ' <span class="info-tip"><span class="info-icon">i</span><span class="info-tip-content">' + escapeHtml(text.trim()) + '</span></span>';
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

// ── Custom Dropdown (Principle 1: informative, searchable selectors) ──

function buildDropdown(id, label, placeholder, items, multiSelect) {
  var btnLabel = placeholder;
  var html = '<div class="dropdown" data-dropdown-id="' + escapeHtml(id) + '"' +
    (multiSelect ? '' : ' data-single-select="true"') + '>';
  html += '<button class="dropdown-trigger" type="button">';
  html += '<span class="dropdown-label">' + escapeHtml(label) + '</span>';
  html += '<span class="dropdown-value" id="dd-val-' + escapeHtml(id) + '">' + escapeHtml(btnLabel) + '</span>';
  html += '<span class="dropdown-arrow">&#9662;</span>';
  html += '</button>';
  html += '<div class="dropdown-panel">';
  if (items.length > 6) {
    html += '<input type="text" class="dropdown-search" placeholder="Search\u2026">';
  }
  html += '<div class="dropdown-items">';
  for (var i = 0; i < items.length; ++i) {
    var item = items[i];
    // Pre-select if the label matches the placeholder (for single-select defaults)
    var preSelected = (!multiSelect && item.label === placeholder) ? ' dropdown-item--selected' : '';
    html += '<div class="dropdown-item' + preSelected + '" data-value="' + escapeHtml(item.value) + '">';
    html += '<span class="dropdown-item-label">' + escapeHtml(item.label) + '</span>';
    html += '<span class="dropdown-item-count"></span>';
    if (item.description) {
      html += infoIcon(item.description);
    }
    html += '</div>';
  }
  html += '</div></div></div>';
  return html;
}

var _dropdownCloseWired = false;

function wireDropdowns(container) {
  var dropdowns = container.querySelectorAll('.dropdown');
  for (var i = 0; i < dropdowns.length; ++i) {
    wireOneDropdown(dropdowns[i]);
  }

  // Close all dropdowns when clicking outside — wire once globally
  if (!_dropdownCloseWired) {
    _dropdownCloseWired = true;
    document.addEventListener('mousedown', function (e) {
      if (!e.target.closest('.dropdown')) {
        var allPanels = document.querySelectorAll('.dropdown-panel--open');
        for (var j = 0; j < allPanels.length; ++j) allPanels[j].classList.remove('dropdown-panel--open');
      }
    });
  }
}

function wireOneDropdown(dropdown) {
  var trigger = dropdown.querySelector('.dropdown-trigger');
  var panel = dropdown.querySelector('.dropdown-panel');
  var search = dropdown.querySelector('.dropdown-search');
  var id = dropdown.dataset.dropdownId;
  var valueEl = dropdown.querySelector('.dropdown-value');

  // Move panel to <body> so it escapes all containment contexts
  // (backdrop-filter, transform, contain all break position:fixed)
  document.body.appendChild(panel);

  // Toggle panel
  trigger.addEventListener('mousedown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    var wasOpen = panel.classList.contains('dropdown-panel--open');
    // Close all dropdowns first
    var allPanels = document.querySelectorAll('.dropdown-panel--open');
    for (var i = 0; i < allPanels.length; ++i) allPanels[i].classList.remove('dropdown-panel--open');
    // Toggle this one
    if (!wasOpen) {
      var rect = trigger.getBoundingClientRect();
      panel.style.top = (rect.bottom + 4) + 'px';
      var spaceRight = window.innerWidth - rect.right;
      if (spaceRight < 200) {
        panel.style.left = '';
        panel.style.right = (window.innerWidth - rect.right) + 'px';
      } else {
        panel.style.left = rect.left + 'px';
        panel.style.right = '';
      }
      panel.classList.add('dropdown-panel--open');
      if (search) {
        search.value = '';
        setTimeout(function () { search.focus(); }, 0);
        filterDropdownItems(panel, '');
      }
    }
  });

  // Search
  if (search) {
    search.addEventListener('input', function () {
      filterDropdownItems(panel, search.value);
    });
    search.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  // Item selection — single-select (radio) or multi-select
  var singleSelect = dropdown.dataset.singleSelect === 'true';

  panel.addEventListener('click', function (e) {
    var item = e.target.closest('.dropdown-item');
    if (!item) return;
    e.stopPropagation();

    if (singleSelect) {
      // Radio: deselect all, select this one
      var allItems = panel.querySelectorAll('.dropdown-item--selected');
      for (var j = 0; j < allItems.length; ++j) allItems[j].classList.remove('dropdown-item--selected');
      item.classList.add('dropdown-item--selected');
      // Close immediately
      panel.classList.remove('dropdown-panel--open');
    } else {
      item.classList.toggle('dropdown-item--selected');
    }

    // Collect selected values
    var selected = panel.querySelectorAll('.dropdown-item--selected');
    var vals = [];
    for (var i = 0; i < selected.length; ++i) {
      vals.push(selected[i].dataset.value);
    }

    // Update trigger label
    if (vals.length === 0) {
      valueEl.textContent = valueEl.dataset.placeholder || 'All';
      valueEl.classList.remove('dropdown-value--active');
    } else if (vals.length === 1) {
      var selLabel = selected[0].querySelector('.dropdown-item-label');
      valueEl.textContent = selLabel ? selLabel.textContent : vals[0];
      valueEl.classList.add('dropdown-value--active');
    } else {
      valueEl.textContent = vals.length + ' selected';
      valueEl.classList.add('dropdown-value--active');
    }

    setFilter(id, singleSelect ? vals[0] : vals);
  });

  // Store placeholder on the value element
  valueEl.dataset.placeholder = valueEl.textContent;
}

function filterDropdownItems(panel, query) {
  var items = panel.querySelectorAll('.dropdown-item');
  var q = query.toLowerCase();
  for (var i = 0; i < items.length; ++i) {
    var label = items[i].querySelector('.dropdown-item-label');
    var text = label ? label.textContent.toLowerCase() : '';
    items[i].style.display = (!q || text.indexOf(q) >= 0) ? '' : 'none';
  }
}

// Restore dropdown selections from URL filter state
function restoreDropdownsFromState() {
  var dropdowns = document.querySelectorAll('.dropdown');
  for (var i = 0; i < dropdowns.length; ++i) {
    var dd = dropdowns[i];
    var id = dd.dataset.dropdownId;
    var vals = filterState[id];
    if (!vals) continue;
    if (!Array.isArray(vals)) vals = [vals];

    var items = dd.querySelectorAll('.dropdown-item');
    var selectedCount = 0;
    for (var j = 0; j < items.length; ++j) {
      if (vals.indexOf(items[j].dataset.value) >= 0) {
        items[j].classList.add('dropdown-item--selected');
        selectedCount++;
      }
    }

    // Update trigger label
    var valueEl = dd.querySelector('.dropdown-value');
    if (valueEl && selectedCount > 0) {
      if (selectedCount === 1) {
        var sel = dd.querySelector('.dropdown-item--selected .dropdown-item-label');
        valueEl.textContent = sel ? sel.textContent : vals[0];
      } else {
        valueEl.textContent = selectedCount + ' selected';
      }
      valueEl.classList.add('dropdown-value--active');
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

  var hasInline = inlinePanels && inlinePanels.length > 0;
  if (!hasSegments && !hasPresets && !hasFacets && !registry.description && !hasInline) return null;

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
    html += buildDropdown('_focus', 'Focus', 'All Data', segItems, true);
  }

  // Boolean presets — compact dropdown
  if (hasPresets) {
    var boolItems = [];
    for (var b = 0; b < extraBooleans.length; ++b) {
      boolItems.push({ value: extraBooleans[b].name, label: extraBooleans[b].label });
    }
    html += buildDropdown('_include', 'Include', 'No filter', boolItems, true);
  }

  // Facets — one dropdown per facet
  if (hasFacets) {
    for (var f = 0; f < facets.length; ++f) {
      var facet = facets[f];
      if (Array.isArray(modelBarConfig.facets) && modelBarConfig.facets.indexOf(facet.name) < 0) continue;
      var facetItems = [];
      for (var v = 0; v < facet.values.length; ++v) {
        facetItems.push({ value: facet.values[v], label: facet.values[v] });
      }
      html += buildDropdown(facet.name, facet.label, 'All', facetItems, true);
    }
  }

  // Inline panels (toggles, ranges assigned to modelbar via config)
  if (inlinePanels && inlinePanels.length > 0) {
    for (var ip = 0; ip < inlinePanels.length; ++ip) {
      var p = inlinePanels[ip];
      var pDimMeta = registry.dimensions[p.dimension];
      var pDesc = pDimMeta && pDimMeta.description ? pDimMeta.description : null;

      if (p.chart === 'toggle') {
        html += '<div class="model-bar-inline" id="panel-' + p.id + '">';
        html += '<span class="model-bar-inline-label">' + escapeHtml(p.label) + (pDesc ? infoIcon(pDesc) : '') + '</span>';
        html += '<div class="pill-group pill-group--compact">';
        html += '<button class="mode-btn mode-btn--sm" data-toggle="' + escapeHtml(p.dimension) + '" data-val="true">Yes</button>';
        html += '<button class="mode-btn mode-btn--sm" data-toggle="' + escapeHtml(p.dimension) + '" data-val="false">No</button>';
        html += '<button class="mode-btn mode-btn--sm active" data-toggle="' + escapeHtml(p.dimension) + '" data-val="all">All</button>';
        html += '</div>';
        html += '</div>';
      } else if (p.chart === 'range') {
        html += '<div class="model-bar-inline model-bar-inline--range" id="panel-' + p.id + '">';
        html += '<span class="model-bar-inline-label">' + escapeHtml(p.label) + (pDesc ? infoIcon(pDesc) : '') + '</span>';
        html += buildRangeSelector(p.id, p.label, true);
        html += '</div>';
      }
    }
  }

  html += '</div>';

  bar.innerHTML = html;
  wireDropdowns(bar);

  // Wire inline toggle clicks
  bar.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    var dim = btn.dataset.toggle;
    var siblings = bar.querySelectorAll('[data-toggle="' + dim + '"]');
    for (var j = 0; j < siblings.length; ++j) siblings[j].classList.remove('active');
    btn.classList.add('active');
    var val = btn.dataset.val;
    setFilter(dim, val === 'all' ? null : val);
  });

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

  // Card head — Principle 4/5: adaptive Top X toggle
  // Only show if there are more items than the limit (otherwise we're showing all already)
  var headRight = '';
  var dimUnique = dimMeta && dimMeta.meta && typeof dimMeta.meta.unique_values === 'number' ? dimMeta.meta.unique_values : -1;
  var showingAll = dimUnique > 0 && panel.limit >= dimUnique;
  if ((panel.chart === 'bar' || panel.chart === 'pie') && !showingAll) {
    headRight += '<button class="btn btn-ghost btn-tiny show-all-toggle" data-panel="' + panel.id + '" data-limit="' + panel.limit + '">Top ' + panel.limit + '</button>';
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
      '<button class="btn btn-ghost btn-tiny" id="table-sort-' + panel.id + '">Most Recent</button>' +
    '</div>' +
    '<div class="table-scroll" id="table-scroll-' + panel.id + '">' +
      '<table class="tbl"><thead><tr>' + colHeaders + '</tr></thead>' +
      '<tbody id="table-body-' + panel.id + '">' +
        '<tr><td colspan="' + colCount + '">' + buildSkeletonTable(colCount) + '</td></tr>' +
      '</tbody></table>' +
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
    body = '<div class="range-wrap">' + buildRangeSelector(panel.id, panel.label, false) + '</div>';

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

  return card;
}

// ── Principle 13: Range selector with visible values ──────────────────

function buildRangeSelector(id, label, compact) {
  var cls = compact ? 'range-sel range-sel--compact' : 'range-sel';
  return '<div class="' + cls + '" data-range-id="' + id + '">' +
    '<span class="range-sel-val range-sel-lo-val" id="range-lo-val-' + id + '">0</span>' +
    '<div class="range-sel-track">' +
      '<div class="range-sel-fill" id="range-fill-' + id + '"></div>' +
      '<input type="range" class="range-sel-input range-sel-lo" id="range-lo-' + id + '" min="0" max="100" value="0">' +
      '<input type="range" class="range-sel-input range-sel-hi" id="range-hi-' + id + '" min="0" max="100" value="100">' +
    '</div>' +
    '<span class="range-sel-val range-sel-hi-val" id="range-hi-val-' + id + '">100</span>' +
  '</div>';
}

function wireRangeSelector(container, panelId, dimension) {
  var el = container.querySelector('[data-range-id="' + panelId + '"]');
  if (!el) return;
  var lo = el.querySelector('.range-sel-lo');
  var hi = el.querySelector('.range-sel-hi');
  var fill = el.querySelector('.range-sel-fill');
  var loVal = el.querySelector('.range-sel-lo-val');
  var hiVal = el.querySelector('.range-sel-hi-val');
  var track = el.querySelector('.range-sel-track');

  function updateFill() {
    var min = parseInt(lo.min);
    var max = parseInt(lo.max);
    var range = max - min || 1;
    var loP = ((parseInt(lo.value) - min) / range) * 100;
    var hiP = ((parseInt(hi.value) - min) / range) * 100;
    fill.style.left = loP + '%';
    fill.style.width = (hiP - loP) + '%';
    loVal.textContent = lo.value;
    hiVal.textContent = hi.value;
  }

  lo.addEventListener('input', function () {
    if (parseInt(lo.value) > parseInt(hi.value)) lo.value = hi.value;
    updateFill();
    if (dimension) setFilter(dimension, [lo.value, hi.value]);
  });

  hi.addEventListener('input', function () {
    if (parseInt(hi.value) < parseInt(lo.value)) hi.value = lo.value;
    updateFill();
    if (dimension) setFilter(dimension, [lo.value, hi.value]);
  });

  // Drag the fill to shift the entire range
  var dragging = false;
  var dragStartX = 0;
  var dragLoStart = 0;
  var dragHiStart = 0;

  fill.style.cursor = 'grab';
  fill.addEventListener('mousedown', function (e) {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    fill.style.cursor = 'grabbing';
    dragStartX = e.clientX;
    dragLoStart = parseInt(lo.value);
    dragHiStart = parseInt(hi.value);
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var trackRect = track.getBoundingClientRect();
    var pxPerUnit = trackRect.width / (parseInt(lo.max) - parseInt(lo.min));
    var delta = Math.round((e.clientX - dragStartX) / pxPerUnit);
    var min = parseInt(lo.min);
    var max = parseInt(lo.max);
    var span = dragHiStart - dragLoStart;

    var newLo = dragLoStart + delta;
    var newHi = dragHiStart + delta;
    if (newLo < min) { newLo = min; newHi = min + span; }
    if (newHi > max) { newHi = max; newLo = max - span; }

    lo.value = newLo;
    hi.value = newHi;
    updateFill();
    if (dimension) setFilter(dimension, [lo.value, hi.value]);
  });

  document.addEventListener('mouseup', function () {
    if (dragging) {
      dragging = false;
      fill.style.cursor = 'grab';
    }
  });

  updateFill();
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
  html += buildDropdown('_granularity', 'View by', granularityLabel(defaultGran), granItems, false);
  if (granNotes) html += infoIcon(granNotes);

  html += '</div>';
  return html;
}

function wirePeriodControl(container, tpi) {
  var trigger = container.querySelector('#period-trigger');
  var gransEl = container.querySelector('#period-grans');
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
          setFilter(dimension, [from, to]);
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

  // Granularity clicks
  if (gransEl) {
    gransEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.gran-btn');
      if (!btn) return;
      var siblings = gransEl.querySelectorAll('.gran-btn');
      for (var i = 0; i < siblings.length; ++i) siblings[i].classList.remove('active');
      btn.classList.add('active');
      setFilter('_granularity', btn.dataset.gran);
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
      html += '<div class="pill-group pill-group--compact">';
      html += '<button class="mode-btn mode-btn--sm" data-toggle="' + escapeHtml(panel.dimension) + '" data-val="true">Yes</button>';
      html += '<button class="mode-btn mode-btn--sm" data-toggle="' + escapeHtml(panel.dimension) + '" data-val="false">No</button>';
      html += '<button class="mode-btn mode-btn--sm active" data-toggle="' + escapeHtml(panel.dimension) + '" data-val="all">All</button>';
      html += '</div>';
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

  // Wire toggle clicks
  bar.addEventListener('click', function (e) {
    var btn = e.target.closest('.mode-btn');
    if (!btn || !btn.dataset.toggle) return;
    var dim = btn.dataset.toggle;
    var siblings = bar.querySelectorAll('[data-toggle="' + dim + '"]');
    for (var j = 0; j < siblings.length; ++j) siblings[j].classList.remove('active');
    btn.classList.add('active');
    var val = btn.dataset.val;
    setFilter(dim, val === 'all' ? null : val);
  });

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

async function main() {
  var container = document.getElementById('dashboard');
  var config = BLUECAR_STAYS_CONFIG;

  // Principle 11: progress overlay — dashboard renders underneath, updates live
  var overlay = document.createElement('div');
  overlay.className = 'progress-overlay';
  var progressCard = document.createElement('div');
  progressCard.className = 'card progress-steps';
  overlay.appendChild(progressCard);
  document.body.appendChild(overlay);

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

    // Principle 3: restore state from URL
    filterState = readUrlState();

    // Render dashboard immediately — visible under the overlay
    buildDashboardDOM(container, config, sections, registry);
    restoreDropdownsFromState();
    renderFilterChips();
    console.log('[dashboard] Dashboard rendered, loading data...');

    updateProgress(3, 'Streaming data into dashboard...');
    // TODO: wire crossfilter worker here — as data streams in,
    // charts update live under the overlay. Once complete, dismiss.
    // For now, simulate with a brief delay then dismiss.
    await new Promise(function (r) { setTimeout(r, 800); });
    dismissProgress();

  } catch (err) {
    container.innerHTML = '<div class="error-banner" style="display:block">' +
      'Dashboard error: ' + escapeHtml(err.message) + '</div>';
    console.error('[dashboard]', err);
  }
}

main();
