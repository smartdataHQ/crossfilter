// demo-stockout/panels/early-warning.js
//
// Products NOT stocked out, NOT high risk, but deteriorating.
// Sortable column headers. Uses Cube meta for all colors/labels.

import { columnarToRows, countedOptions, esc, isActive, scoreBar, fieldBadge, deltaCell } from './helpers.js';

var allRows = [];
var sevSelect = null;
var catSelect = null;
var supSelect = null;
var sortField = 'risk_score';
var sortDir = -1;

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

export function renderEarlyWarning(rowsResult) {
  var el = document.getElementById('panel-early-warning');
  if (!el) return;
  if (!rowsResult) { el.innerHTML = '<div class="panel-empty">Data unavailable</div>'; return; }

  sevSelect = sevSelect || document.getElementById('warning-severity-filter');
  catSelect = catSelect || document.getElementById('warning-cat-filter');
  supSelect = supSelect || document.getElementById('warning-sup-filter');

  var rows = columnarToRows(rowsResult);
  allRows = rows.filter(function (r) {
    if (isActive(r.is_currently_active)) return false;
    var score = Number(r.risk_score) || 0;
    if (score >= 0.5) return false;
    var trend = String(r.trend_signal || '').toUpperCase();
    var severity = String(r.severity_trend || '').toUpperCase();
    return trend === 'WORSENING' || severity === 'ESCALATING' || severity === 'WORSENING';
  });

  sortRows();
  populateSelects(allRows);
  renderFiltered();
}

function sortRows() {
  allRows.sort(function (a, b) {
    var av = sortValue(a, sortField);
    var bv = sortValue(b, sortField);
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });
}

function sortValue(row, field) {
  var col = COLUMNS.filter(function (c) { return c.key === field; })[0];
  if (col && col.type === 'delta') {
    var r = Number(row[col.recent]) || 0;
    var o = Number(row[col.older]) || 0;
    return o > 0 ? r / o : (r > 0 ? 2 : 1);
  }
  var v = row[field];
  if (v == null) return '';
  return typeof v === 'string' ? v.toLowerCase() : Number(v) || 0;
}

function onHeaderClick(field) {
  if (sortField === field) { sortDir *= -1; }
  else { sortField = field; sortDir = -1; }
  sortRows();
  renderFiltered();
}

function populateSelects(rows) {
  if (!sevSelect || !catSelect || !supSelect) return;
  var prevSev = sevSelect.value, prevCat = catSelect.value, prevSup = supSelect.value;
  sevSelect.innerHTML = '<option value="">All Severity (' + rows.length + ')</option>' + countedOptions(rows, 'severity_trend');
  catSelect.innerHTML = '<option value="">All Categories (' + rows.length + ')</option>' + countedOptions(rows, 'product_category');
  supSelect.innerHTML = '<option value="">All Suppliers (' + rows.length + ')</option>' + countedOptions(rows, 'supplier');
  sevSelect.value = prevSev; catSelect.value = prevCat; supSelect.value = prevSup;
  sevSelect.onchange = renderFiltered; catSelect.onchange = renderFiltered; supSelect.onchange = renderFiltered;
}

function renderFiltered() {
  var el = document.getElementById('panel-early-warning');
  var countEl = document.getElementById('warning-count');
  if (!el) return;

  var sevVal = sevSelect ? sevSelect.value : '';
  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';
  var filtered = allRows;
  if (sevVal) filtered = filtered.filter(function (r) { return r.severity_trend === sevVal; });
  if (catVal) filtered = filtered.filter(function (r) { return r.product_category === catVal; });
  if (supVal) filtered = filtered.filter(function (r) { return r.supplier === supVal; });
  if (countEl) countEl.textContent = filtered.length + ' deteriorating';

  if (!filtered.length) {
    el.innerHTML = '<div class="panel-empty">No deteriorating products' +
      (sevVal || catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var header = '<table class="tbl"><thead><tr>';
  for (var c = 0; c < COLUMNS.length; ++c) {
    var col = COLUMNS[c];
    var arrow = sortField === col.key ? (sortDir < 0 ? ' \u25bc' : ' \u25b2') : '';
    header += '<th title="' + esc(col.title) + '" data-sort="' + col.key + '" class="sortable">' + col.label + arrow + '</th>';
  }
  header += '</tr></thead><tbody>';

  var body = '';
  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    body += '<tr>';
    for (var j = 0; j < COLUMNS.length; ++j) body += renderCell(r, COLUMNS[j]);
    body += '</tr>';
  }

  el.innerHTML = header + body + '</tbody></table>';

  var ths = el.querySelectorAll('th.sortable');
  for (var t = 0; t < ths.length; ++t) {
    ths[t].addEventListener('click', function (e) { onHeaderClick(e.currentTarget.dataset.sort); });
  }
}

function renderCell(r, col) {
  switch (col.type) {
    case 'string': return '<td class="val">' + esc(r[col.key]) + '</td>';
    case 'field': return '<td>' + fieldBadge(col.field, r[col.key]) + '</td>';
    case 'bar': return '<td>' + scoreBar(Number(r[col.key]) || 0, col.barField) + '</td>';
    case 'delta': return '<td>' + deltaCell(r[col.recent], r[col.older]) + '</td>';
    default: return '<td>' + esc(r[col.key]) + '</td>';
  }
}
