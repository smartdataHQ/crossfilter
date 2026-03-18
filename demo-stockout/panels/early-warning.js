// demo-stockout/panels/early-warning.js
//
// Products NOT stocked out, NOT high risk, but deteriorating.
// Sortable column headers. Uses Cube meta for all colors/labels.

import { getColumns, filterIndices, sortIndices, countsToOptions, esc, isActive, scoreBar, fieldBadge, deltaCell, sortableHeader, attachSortHandlers } from './helpers.js';

var columns = null;
var allIndices = [];
var sevSelect = null;
var catSelect = null;
var supSelect = null;
var sortField = 'risk_score';
var sortDir = -1;

var HIGH_RISK_TIER = { CRITICAL: 1, Critical: 1, HIGH: 1, High: 1 };
var WORSENING_SIGNAL = { WORSENING: 1, Worsening: 1, 'ACTIVE & WORSENING': 1, 'Active & Worsening': 1 };
var ESCALATING_SEVERITY = { ESCALATING: 1, Escalating: 1, WORSENING: 1, Worsening: 1 };

var COLUMNS = [
  { key: 'product', label: 'Product', title: 'Product name', type: 'string' },
  { key: 'trend_signal', label: 'Status', title: 'Overall status from Cube model', type: 'field', field: 'trend_signal' },
  { key: 'severity_trend', label: 'Escalation', title: 'Is each stockout getting more severe?', type: 'field', field: 'severity_trend' },
  { key: 'risk_score', label: 'Risk Score', title: 'Composite risk score', type: 'bar', barField: 'risk_score' },
  { key: '_dur_delta', label: '<abbr title="Duration Delta">Dur \u0394</abbr>', title: 'Are stockouts lasting longer?', type: 'delta', recent: 'avg_duration_recent_half', older: 'avg_duration_older_half' },
  { key: '_freq_delta', label: '<abbr title="Frequency Delta">Freq \u0394</abbr>', title: 'Are stockouts more frequent?', type: 'delta', recent: 'frequency_recent_per_month', older: 'frequency_older_per_month' },
  { key: '_impact_delta', label: '<abbr title="Impact Delta">Impact \u0394</abbr>', title: 'Is each stockout costlier?', type: 'delta', recent: 'avg_impact_recent_half', older: 'avg_impact_older_half' },
  { key: 'forecast_stockout_probability', label: '<abbr title="3-Day Probability">3-Day Prob</abbr>', title: '3-day stockout probability', type: 'bar', barField: 'forecast_stockout_probability' },
];

// Pre-built O(1) lookup for sort column config
var COLUMN_MAP = {};
for (var ci = 0; ci < COLUMNS.length; ++ci) COLUMN_MAP[COLUMNS[ci].key] = COLUMNS[ci];

export function renderEarlyWarning(rowsResult) {
  var el = document.getElementById('panel-early-warning');
  if (!el) return;
  if (!rowsResult) { el.innerHTML = '<div class="panel-empty">Data unavailable</div>'; return; }

  sevSelect = sevSelect || document.getElementById('warning-severity-filter');
  catSelect = catSelect || document.getElementById('warning-cat-filter');
  supSelect = supSelect || document.getElementById('warning-sup-filter');

  var data = getColumns(rowsResult);
  columns = data.columns;
  allIndices = filterIndices(columns, data.length, function (cols, i) {
    if (isActive(cols.is_currently_active ? cols.is_currently_active[i] : null)) return false;
    if (HIGH_RISK_TIER[(cols.risk_tier ? cols.risk_tier[i] : '') || ''] === 1) return false;
    var trend = (cols.trend_signal ? cols.trend_signal[i] : '') || '';
    var severity = (cols.severity_trend ? cols.severity_trend[i] : '') || '';
    return WORSENING_SIGNAL[trend] === 1 || ESCALATING_SEVERITY[severity] === 1;
  });

  sortCurrentField();
  populateSelects();
  renderFiltered();
}

function sortCurrentField() {
  var col = COLUMN_MAP[sortField];
  if (col && col.type === 'delta') {
    var recentCol = columns[col.recent];
    var olderCol = columns[col.older];
    allIndices.sort(function (a, b) {
      var ra = Number(recentCol ? recentCol[a] : 0) || 0;
      var oa = Number(olderCol ? olderCol[a] : 0) || 0;
      var av = oa > 0 ? ra / oa : (ra > 0 ? 2 : 1);
      var rb = Number(recentCol ? recentCol[b] : 0) || 0;
      var ob = Number(olderCol ? olderCol[b] : 0) || 0;
      var bv = ob > 0 ? rb / ob : (rb > 0 ? 2 : 1);
      return (av - bv) * sortDir;
    });
  } else {
    sortIndices(allIndices, columns, sortField, sortDir);
  }
}

function onHeaderClick(field) {
  if (sortField === field) { sortDir *= -1; }
  else { sortField = field; sortDir = -1; }
  sortCurrentField();
  renderFiltered();
}

function populateSelects() {
  if (!sevSelect || !catSelect || !supSelect || !columns) return;
  var prevSev = sevSelect.value, prevCat = catSelect.value, prevSup = supSelect.value;
  // Single pass counts all three filter fields simultaneously
  var sevCol = columns.severity_trend;
  var catCol = columns.product_category;
  var supCol = columns.supplier;
  var sevCounts = {}, catCounts = {}, supCounts = {};
  for (var i = 0; i < allIndices.length; ++i) {
    var idx = allIndices[i];
    var sv = sevCol ? sevCol[idx] : null;
    var cv = catCol ? catCol[idx] : null;
    var uv = supCol ? supCol[idx] : null;
    if (sv != null && sv !== '') sevCounts[sv] = (sevCounts[sv] || 0) + 1;
    if (cv != null && cv !== '') catCounts[cv] = (catCounts[cv] || 0) + 1;
    if (uv != null && uv !== '') supCounts[uv] = (supCounts[uv] || 0) + 1;
  }
  sevSelect.innerHTML = '<option value="">All Severity (' + allIndices.length + ')</option>' + countsToOptions(sevCounts);
  catSelect.innerHTML = '<option value="">All Categories (' + allIndices.length + ')</option>' + countsToOptions(catCounts);
  supSelect.innerHTML = '<option value="">All Suppliers (' + allIndices.length + ')</option>' + countsToOptions(supCounts);
  sevSelect.value = prevSev; catSelect.value = prevCat; supSelect.value = prevSup;
  sevSelect.onchange = renderFiltered; catSelect.onchange = renderFiltered; supSelect.onchange = renderFiltered;
}

var panelEl = null;
var countEl = null;

function renderFiltered() {
  panelEl = panelEl || document.getElementById('panel-early-warning');
  countEl = countEl || document.getElementById('warning-count');
  var el = panelEl;
  if (!el || !columns) return;

  var sevVal = sevSelect ? sevSelect.value : '';
  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';
  var filtered = allIndices;
  if (sevVal || catVal || supVal) {
    var sevCol = columns.severity_trend;
    var catCol = columns.product_category;
    var supCol = columns.supplier;
    filtered = [];
    for (var f = 0; f < allIndices.length; ++f) {
      var idx = allIndices[f];
      if (sevVal && sevCol && sevCol[idx] !== sevVal) continue;
      if (catVal && catCol && catCol[idx] !== catVal) continue;
      if (supVal && supCol && supCol[idx] !== supVal) continue;
      filtered.push(idx);
    }
  }
  if (countEl) countEl.textContent = filtered.length + ' deteriorating';

  if (!filtered.length) {
    el.innerHTML = '<div class="panel-empty">No deteriorating products' +
      (sevVal || catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var header = '<table class="tbl">' + sortableHeader(COLUMNS, sortField, sortDir) + '<tbody>';

  var body = '';
  for (var i = 0; i < filtered.length; ++i) {
    var idx = filtered[i];
    body += '<tr>';
    for (var j = 0; j < COLUMNS.length; ++j) body += renderCell(idx, COLUMNS[j]);
    body += '</tr>';
  }

  el.innerHTML = header + body + '</tbody></table>';

  attachSortHandlers(el, onHeaderClick);
}

function renderCell(idx, col) {
  var v = columns[col.key] ? columns[col.key][idx] : null;
  switch (col.type) {
    case 'string': return '<td class="val">' + esc(v) + '</td>';
    case 'field': return '<td>' + fieldBadge(col.field, v) + '</td>';
    case 'bar': return '<td>' + scoreBar(+v || 0, col.barField) + '</td>';
    case 'delta': return '<td>' + deltaCell(columns[col.recent] ? columns[col.recent][idx] : null, columns[col.older] ? columns[col.older][idx] : null) + '</td>';
    default: return '<td>' + esc(v) + '</td>';
  }
}
