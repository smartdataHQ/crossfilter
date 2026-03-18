// demo-stockout/panels/stockout-table.js

import { getColumns, filterIndices, sortIndices, countsToOptions, esc, isActive, fieldBadge, fmtDur, fmtISK, fmtFreq, sortableHeader, attachSortHandlers } from './helpers.js';

var columns = null;
var allIndices = [];
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

  var data = getColumns(storeResult);
  columns = data.columns;
  allIndices = filterIndices(columns, data.length, function (cols, i) {
    return isActive(cols.is_currently_active ? cols.is_currently_active[i] : null);
  });
  sortIndices(allIndices, columns, sortField, sortDir);

  populateSelects();
  renderFiltered();
}

function onSort(field) {
  if (sortField === field) sortDir *= -1;
  else { sortField = field; sortDir = -1; }
  sortIndices(allIndices, columns, sortField, sortDir);
  renderFiltered();
}

function populateSelects() {
  if (!catSelect || !supSelect || !columns) return;
  var prevCat = catSelect.value, prevSup = supSelect.value;
  var catCol = columns.product_category, supCol = columns.supplier;
  var catCounts = {}, supCounts = {};
  for (var i = 0; i < allIndices.length; ++i) {
    var idx = allIndices[i];
    var cv = catCol ? catCol[idx] : null;
    var sv = supCol ? supCol[idx] : null;
    if (cv != null && cv !== '') catCounts[cv] = (catCounts[cv] || 0) + 1;
    if (sv != null && sv !== '') supCounts[sv] = (supCounts[sv] || 0) + 1;
  }
  catSelect.innerHTML = '<option value="">All Categories (' + allIndices.length + ')</option>' + countsToOptions(catCounts);
  supSelect.innerHTML = '<option value="">All Suppliers (' + allIndices.length + ')</option>' + countsToOptions(supCounts);
  catSelect.value = prevCat; supSelect.value = prevSup;
  catSelect.onchange = renderFiltered; supSelect.onchange = renderFiltered;
}

var panelEl = null;
var stockoutCountEl = null;

function renderFiltered() {
  panelEl = panelEl || document.getElementById('panel-stockout-table');
  stockoutCountEl = stockoutCountEl || document.getElementById('stockout-count');
  var el = panelEl;
  var countEl = stockoutCountEl;
  if (!el || !columns) return;

  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';
  var filtered = allIndices;
  if (catVal || supVal) {
    var catCol = columns.product_category;
    var supCol = columns.supplier;
    filtered = [];
    for (var f = 0; f < allIndices.length; ++f) {
      var idx = allIndices[f];
      if (catVal && catCol && catCol[idx] !== catVal) continue;
      if (supVal && supCol && supCol[idx] !== supVal) continue;
      filtered.push(idx);
    }
  }
  if (countEl) countEl.textContent = filtered.length + ' products';

  if (!filtered.length) {
    el.innerHTML = '<div class="panel-empty">No active stockouts' + (catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var cProduct = columns.product, cPattern = columns.stockout_pattern;
  var cDur = columns.avg_duration_days, cLost = columns.total_expected_lost_sales;
  var cTrend = columns.trend_signal, cFreq = columns.stockouts_per_month;
  var html = '<table class="tbl">' + sortableHeader(COLUMNS, sortField, sortDir) + '<tbody>';
  for (var i = 0; i < filtered.length; ++i) {
    var idx = filtered[i];
    html += '<tr data-product="' + esc(cProduct[idx]) + '" style="cursor:pointer">' +
      '<td class="val">' + esc(cProduct[idx]) + '</td>' +
      '<td>' + fieldBadge('stockout_pattern', cPattern[idx]) + '</td>' +
      '<td>' + fmtDur(cDur[idx]) + '</td>' +
      '<td>' + fmtISK(cLost[idx]) + '</td>' +
      '<td>' + fieldBadge('trend_signal', cTrend[idx]) + '</td>' +
      '<td>' + fmtFreq(cFreq[idx]) + '</td>' +
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
