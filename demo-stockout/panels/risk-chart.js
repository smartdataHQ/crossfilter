// demo-stockout/panels/risk-chart.js

import { columnarToRows, esc, isActive, scoreBar, fieldBadge, deltaCell, fmtDaysAgo } from './helpers.js';

var onProductClick = null;
var selectedProduct = null;

export function setProductClickHandler(fn) { onProductClick = fn; }

export function renderRiskChart(storeResult) {
  var el = document.getElementById('panel-risk');
  if (!el) return;

  var rows = columnarToRows(storeResult);
  rows = rows.filter(function (r) { return !isActive(r.is_currently_active); });

  if (!rows.length) {
    el.innerHTML = '<div class="panel-empty">No at-risk products</div>';
    return;
  }

  rows.sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); });
  rows = rows.slice(0, 10);

  var html = '<table class="tbl"><thead><tr>' +
    '<th title="Product name">Product</th>' +
    '<th title="Composite risk score">Risk Score</th>' +
    '<th title="3-day stockout probability"><abbr title="3-Day Probability">3-Day Prob</abbr></th>' +
    '<th title="Stockout character from Cube model">Pattern</th>' +
    '<th title="Days since last stockout ended">Last</th>' +
    '<th title="Are stockouts more frequent? Recent vs older half"><abbr title="Frequency Delta">Freq \u0394</abbr></th>' +
    '<th title="Overall status from Cube model">Status</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < rows.length; ++i) {
    var r = rows[i];
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

  el.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-product]');
    if (!tr) return;
    var product = tr.dataset.product;
    selectedProduct = product === selectedProduct ? null : product;
    var allTr = el.querySelectorAll('tr.risk-row');
    for (var j = 0; j < allTr.length; ++j) {
      allTr[j].classList.toggle('risk-selected', allTr[j].dataset.product === selectedProduct);
    }
    if (onProductClick) onProductClick(selectedProduct);
  });
}
