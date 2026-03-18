// demo-stockout/panels/risk-chart.js

import { getColumns, filterIndices, sortIndices, materializeRows, esc, isActive, scoreBar, fieldBadge, deltaCell, fmtDaysAgo, sortableHeader, attachSortHandlers } from './helpers.js';

var onProductClick = null;
var selectedProduct = null;
var columns = null;
var allIndices = [];
var allRows = [];
var sortField = 'risk_score';
var sortDir = -1;

export function setProductClickHandler(fn) { onProductClick = fn; }

var COLUMNS = [
  { key: 'product', label: 'Product', title: 'Product name' },
  { key: 'risk_score', label: 'Risk Score', title: 'Composite risk score' },
  { key: 'forecast_stockout_probability', label: '<abbr title="3-Day Probability">3-Day Prob</abbr>', title: '3-day stockout probability' },
  { key: 'stockout_pattern', label: 'Pattern', title: 'Stockout character from Cube model' },
  { key: 'days_since_last', label: 'Last', title: 'Days since last stockout ended' },
  { key: '_freq_delta', label: '<abbr title="Frequency Delta">Freq \u0394</abbr>', title: 'Are stockouts more frequent? Recent vs older half' },
  { key: 'trend_signal', label: 'Status', title: 'Overall status from Cube model' },
];

export function renderRiskChart(storeResult) {
  var el = document.getElementById('panel-risk');
  if (!el) return;

  var data = getColumns(storeResult);
  columns = data.columns;
  allIndices = filterIndices(columns, data.length, function (cols, i) {
    return !isActive(cols.is_currently_active ? cols.is_currently_active[i] : null);
  });
  sortCurrentField();
  allIndices = allIndices.slice(0, 10);
  allRows = materializeRows(columns, allIndices);

  renderTable();
}

function sortCurrentField() {
  if (sortField === '_freq_delta') {
    var recentCol = columns.frequency_recent_per_month;
    var olderCol = columns.frequency_older_per_month;
    allIndices.sort(function (a, b) {
      var ar = Number(recentCol ? recentCol[a] : 0) || 0;
      var ao = Number(olderCol ? olderCol[a] : 0) || 0;
      var av = ao > 0 ? ar / ao : (ar > 0 ? 2 : 1);
      var br = Number(recentCol ? recentCol[b] : 0) || 0;
      var bo = Number(olderCol ? olderCol[b] : 0) || 0;
      var bv = bo > 0 ? br / bo : (br > 0 ? 2 : 1);
      return (av - bv) * sortDir;
    });
  } else {
    sortIndices(allIndices, columns, sortField, sortDir);
  }
}

function onSort(field) {
  if (sortField === field) sortDir *= -1;
  else { sortField = field; sortDir = -1; }
  sortCurrentField();
  allRows = materializeRows(columns, allIndices);
  renderTable();
}

function renderTable() {
  var el = document.getElementById('panel-risk');
  if (!el) return;

  if (!allRows.length) {
    el.innerHTML = '<div class="panel-empty">No at-risk products</div>';
    return;
  }

  var html = '<table class="tbl">' + sortableHeader(COLUMNS, sortField, sortDir) + '<tbody>';
  for (var i = 0; i < allRows.length; ++i) {
    var r = allRows[i];
    var sel = r.product === selectedProduct;

    html += '<tr data-product="' + esc(r.product) + '" class="risk-row' + (sel ? ' risk-selected' : '') + '" style="cursor:pointer">' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + scoreBar(Number(r.risk_score) || 0, 'risk_score') + '</td>' +
      '<td>' + scoreBar(Number(r.forecast_stockout_probability) || 0, 'forecast_stockout_probability') + '</td>' +
      '<td>' + fieldBadge('stockout_pattern', r.stockout_pattern) + '</td>' +
      '<td>' + fmtDaysAgo(r.days_since_last) + '</td>' +
      '<td>' + deltaCell(Number(r.frequency_recent_per_month), Number(r.frequency_older_per_month)) + '</td>' +
      '<td>' + fieldBadge('trend_signal', r.trend_signal) + '</td>' +
      '</tr>';
  }

  el.innerHTML = html + '</tbody></table>';
  attachSortHandlers(el, onSort);

  // Use onclick assignment (not addEventListener) to avoid stacking handlers on re-render
  el.onclick = function (e) {
    // Ignore sort header clicks
    if (e.target.closest('th')) return;
    var tr = e.target.closest('tr[data-product]');
    if (!tr) return;
    var product = tr.dataset.product;
    selectedProduct = product === selectedProduct ? null : product;
    var trs = el.querySelectorAll('tr.risk-row');
    for (var j = 0; j < trs.length; ++j) {
      trs[j].classList.toggle('risk-selected', trs[j].dataset.product === selectedProduct);
    }
    if (onProductClick) onProductClick(selectedProduct);
  };
}
