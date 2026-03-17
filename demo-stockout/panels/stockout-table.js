// demo-stockout/panels/stockout-table.js

import { columnarToRows, countedOptions, esc, isActive, fieldBadge, fmtDur, fmtISK, fmtFreq } from './helpers.js';

var allRows = [];
var catSelect = null;
var supSelect = null;

export function renderStockoutTable(storeResult) {
  var el = document.getElementById('panel-stockout-table');
  if (!el) return;

  catSelect = catSelect || document.getElementById('stockout-cat-filter');
  supSelect = supSelect || document.getElementById('stockout-sup-filter');

  var rows = columnarToRows(storeResult);
  allRows = rows.filter(function (r) { return isActive(r.is_currently_active); });
  allRows.sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); });

  populateSelects(allRows);
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

  var html = '<table class="tbl"><thead><tr>' +
    '<th title="Product name">Product</th>' +
    '<th title="Stockout character from Cube model: Longer, Typical, or Rare">Pattern</th>' +
    '<th title="Average stockout duration"><abbr title="Average Duration">Avg Dur</abbr></th>' +
    '<th title="Total estimated lost sales"><abbr title="Total Lost Sales">Total Lost</abbr></th>' +
    '<th title="Overall status from Cube model">Status</th>' +
    '<th title="Historical stockout frequency"><abbr title="Frequency per Month">Freq/Mo</abbr></th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + fieldBadge('stockout_pattern', r.stockout_pattern) + '</td>' +
      '<td>' + fmtDur(r.avg_duration_days) + '</td>' +
      '<td>' + fmtISK(r.total_expected_lost_sales) + '</td>' +
      '<td>' + fieldBadge('trend_signal', r.trend_signal) + '</td>' +
      '<td>' + fmtFreq(r.stockouts_per_month) + '</td>' +
      '</tr>';
  }

  el.innerHTML = html + '</tbody></table>';
}
