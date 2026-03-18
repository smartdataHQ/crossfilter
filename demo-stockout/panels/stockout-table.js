// demo-stockout/panels/stockout-table.js

import { columnarToRows, countedOptions, esc, isActive, fieldBadge, fmtDur, fmtISK, fmtFreq, sortableHeader, attachSortHandlers } from './helpers.js';

var allRows = [];
var catSelect = null;
var supSelect = null;
var sortField = 'risk_score';
var sortDir = -1;
var productClickCallback = null;

export function onProductClick(callback) {
  productClickCallback = callback;
}

var COLUMNS = [
  { key: 'product', label: 'Product', title: 'Product name' },
  { key: 'stockout_pattern', label: 'Pattern', title: 'Stockout character from Cube model' },
  { key: 'avg_duration_days', label: '<abbr title="Average Duration">Avg Dur</abbr>', title: 'Average stockout duration' },
  { key: 'total_expected_lost_sales', label: '<abbr title="Total Lost Sales">Total Lost</abbr>', title: 'Total estimated lost sales' },
  { key: 'trend_signal', label: 'Status', title: 'Overall status from Cube model' },
  { key: 'stockouts_per_month', label: '<abbr title="Frequency per Month">Freq/Mo</abbr>', title: 'Historical stockout frequency' },
];

export function renderStockoutTable(storeResult) {
  var el = document.getElementById('panel-stockout-table');
  if (!el) return;

  catSelect = catSelect || document.getElementById('stockout-cat-filter');
  supSelect = supSelect || document.getElementById('stockout-sup-filter');

  var rows = columnarToRows(storeResult);
  allRows = rows.filter(function (r) { return isActive(r.is_currently_active); });
  sortRows();

  populateSelects(allRows);
  renderFiltered();
}

function sortRows() {
  var field = sortField;
  var dir = sortDir;
  allRows.sort(function (a, b) {
    var av = a[field], bv = b[field];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    av = av == null ? '' : av;
    bv = bv == null ? '' : bv;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function onSort(field) {
  if (sortField === field) sortDir *= -1;
  else { sortField = field; sortDir = -1; }
  sortRows();
  renderFiltered();
}

function populateSelects(rows) {
  if (!catSelect || !supSelect) return;
  var prevCat = catSelect.value, prevSup = supSelect.value;
  catSelect.innerHTML = '<option value="">All Categories (' + rows.length + ')</option>' + countedOptions(rows, 'product_category');
  supSelect.innerHTML = '<option value="">All Suppliers (' + rows.length + ')</option>' + countedOptions(rows, 'supplier');
  catSelect.value = prevCat; supSelect.value = prevSup;
  catSelect.onchange = renderFiltered; supSelect.onchange = renderFiltered;
}

function renderFiltered() {
  var el = document.getElementById('panel-stockout-table');
  var countEl = document.getElementById('stockout-count');
  if (!el) return;

  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';
  var filtered = allRows;
  if (catVal) filtered = filtered.filter(function (r) { return r.product_category === catVal; });
  if (supVal) filtered = filtered.filter(function (r) { return r.supplier === supVal; });
  if (countEl) countEl.textContent = filtered.length + ' products';

  if (!filtered.length) {
    el.innerHTML = '<div class="panel-empty">No active stockouts' + (catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var html = '<table class="tbl">' + sortableHeader(COLUMNS, sortField, sortDir) + '<tbody>';
  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    html += '<tr data-product="' + esc(r.product) + '" style="cursor:pointer">' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + fieldBadge('stockout_pattern', r.stockout_pattern) + '</td>' +
      '<td>' + fmtDur(r.avg_duration_days) + '</td>' +
      '<td>' + fmtISK(r.total_expected_lost_sales) + '</td>' +
      '<td>' + fieldBadge('trend_signal', r.trend_signal) + '</td>' +
      '<td>' + fmtFreq(r.stockouts_per_month) + '</td>' +
      '</tr>';
  }
  el.innerHTML = html + '</tbody></table>';
  attachSortHandlers(el, onSort);
  ensureProductClickHandler(el);
}

var productClickBound = false;

function ensureProductClickHandler(el) {
  if (productClickBound) return;
  productClickBound = true;
  el.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-product]');
    if (!tr) return;
    if (productClickCallback) productClickCallback(tr.dataset.product);
  });
}
