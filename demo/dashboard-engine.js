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

// ── Shared Helpers ────────────────────────────────────────────────────

function titleCase(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function afterUpdate(el, fn) {
  if (el.updateComplete) el.updateComplete.then(fn);
  else setTimeout(fn, 100);
}

function buildToggleHtml(dimension) {
  return '<sl-button-group>' +
    '<sl-button size="small" data-toggle="' + escapeHtml(dimension) + '" data-val="true">Yes</sl-button>' +
    '<sl-button size="small" data-toggle="' + escapeHtml(dimension) + '" data-val="false">No</sl-button>' +
    '<sl-button size="small" variant="primary" data-toggle="' + escapeHtml(dimension) + '" data-val="all">All</sl-button>' +
  '</sl-button-group>';
}

function wireToggleClicks(container) {
  container.addEventListener('click', function (e) {
    var btn = e.target.closest('sl-button[data-toggle]');
    if (!btn) return;
    var dim = btn.dataset.toggle;
    var group = btn.closest('sl-button-group');
    if (group) {
      var siblings = group.querySelectorAll('sl-button[data-toggle="' + dim + '"]');
      for (var i = 0; i < siblings.length; ++i) siblings[i].variant = 'default';
    }
    btn.variant = 'primary';
    setFilter(dim, btn.dataset.val === 'all' ? null : btn.dataset.val);
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

var _escapeEl = null;
function escapeHtml(str) {
  if (!_escapeEl) _escapeEl = document.createElement('div');
  _escapeEl.textContent = str;
  return _escapeEl.innerHTML;
}



// ── Principle 8: Filter Chips (visible, removable) ────────────────────

// Resolve raw filter value to human label by looking up sl-option text
function resolveFilterLabel(dim, rawValue) {
  var select = document.querySelector('sl-select[data-dropdown-id="' + dim + '"]');
  if (select) {
    var option = select.querySelector('sl-option[value="' + rawValue + '"]');
    if (option) return option.textContent.trim();
  }
  // Fallback: title-case the raw value
  return titleCase(rawValue);
}

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

  var cubeInfo = registry.cube || {};
  var title = (config.title || cubeInfo.title || cubeInfo.name || '').toUpperCase();

  var periodHtml = '';
  if (timePanelInfo) {
    periodHtml = '<button class="period-trigger" id="mobile-period-trigger"></button>';
  }

  var granMeta = (cubeInfo.meta && cubeInfo.meta.granularity) || {};
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
      var clearAll = document.getElementById('clear-all');
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
  var boolDims = registry.booleanDimensions || [];
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

function buildDropdown(id, label, placeholder, items, multiSelect) {
  // max-options-visible="0" hides selected tags from the trigger —
  // selected state is shown in the filter chips bar instead (Principle 8)
  var html = '<sl-select' +
    ' data-dropdown-id="' + escapeHtml(id) + '"' +
    ' placeholder="' + escapeHtml(placeholder) + '"' +
    (label ? ' label="' + escapeHtml(label) + '"' : '') +
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
        html += buildToggleHtml(p.dimension);
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
    headRight += '<sl-button size="small" variant="text" class="show-all-toggle" data-panel="' + panel.id + '" data-limit="' + panel.limit + '">Top ' + panel.limit + '</sl-button>';
  }
  if (panel.chart === 'bar' && panel.searchable) {
    headRight += '<sl-button size="small" variant="text" class="dim-list-toggle" data-panel="' + panel.id + '">List</sl-button>';
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
    body = '<div class="toggle-wrap" id="toggle-' + panel.id + '">' +
      buildToggleHtml(panel.dimension) +
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
  html += buildDropdown('_granularity', '', granularityLabel(defaultGran), granItems, false);
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
      html += '<div class="pill-group pill-group--compact">';
      html += '<sl-button-group>';
      html += '<sl-button size="small" data-toggle="' + escapeHtml(panel.dimension) + '" data-val="true">Yes</sl-button>';
      html += '<sl-button size="small" data-toggle="' + escapeHtml(panel.dimension) + '" data-val="false">No</sl-button>';
      html += '<sl-button size="small" variant="primary" data-toggle="' + escapeHtml(panel.dimension) + '" data-val="all">All</sl-button>';
      html += '</sl-button-group>';
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
    console.log('[dashboard] Dashboard rendered, loading data...');

    updateProgress(3, 'Streaming data into dashboard...');
    // TODO: wire crossfilter worker here — as data streams in,
    // charts update live under the overlay. Once complete, dismiss.
    // For now, simulate with a brief delay then dismiss.
    await new Promise(function (r) { setTimeout(r, 800); });
    dismissProgress();
    wireChartResize();

  } catch (err) {
    container.innerHTML = '<div class="error-banner" style="display:block">' +
      'Dashboard error: ' + escapeHtml(err.message) + '</div>';
    console.error('[dashboard]', err);
  }
}

main();
