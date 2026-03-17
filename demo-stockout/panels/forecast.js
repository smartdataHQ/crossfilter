// demo-stockout/panels/forecast.js

import { columnarToRows, countedOptions, esc, isActive, scoreBar, fieldBadge, fmtDaysAgo, fmtFreq } from './helpers.js';
import { colorFor } from '../config.js';

var allRows = [];
var dayBtnsEl = null;
var catSelect = null;
var supSelect = null;
var selectedDay = '';

var NEXT_DAYS = (function () {
  var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var result = [];
  for (var i = 1; i <= 3; ++i) {
    var d = new Date();
    d.setDate(d.getDate() + i);
    result.push(names[d.getDay()]);
  }
  return result;
})();

export function renderForecast(rowsResult) {
  var cardsEl = document.getElementById('panel-forecast-cards');
  var tableEl = document.getElementById('panel-forecast-table');
  if (!tableEl) return;

  dayBtnsEl = dayBtnsEl || document.getElementById('forecast-day-btns');
  catSelect = catSelect || document.getElementById('forecast-cat-filter');
  supSelect = supSelect || document.getElementById('forecast-sup-filter');

  var rows = columnarToRows(rowsResult);
  // Use forecast_tier from Cube instead of hardcoded threshold
  allRows = rows.filter(function (r) {
    if (isActive(r.is_currently_active)) return false;
    var tier = String(r.forecast_tier || '').toUpperCase();
    return tier === 'CRITICAL' || tier === 'HIGH' || tier === 'MODERATE';
  });
  allRows.sort(function (a, b) {
    return (Number(b.forecast_stockout_probability) || 0) - (Number(a.forecast_stockout_probability) || 0);
  });

  renderDayButtons();
  populateSelects(allRows);
  renderFiltered();

  if (cardsEl) {
    cardsEl.innerHTML = allRows.slice(0, 4).map(function (r) {
      var prob = Number(r.forecast_stockout_probability) || 0;
      var color = colorFor('forecast_stockout_probability', prob);
      return '<div class="forecast-card">' +
        '<div class="forecast-card-title">' + esc(r.product) + '</div>' +
        '<div style="text-align:center;margin-top:8px">' +
        '<div style="font-family:var(--font-mono);font-size:24px;font-weight:700;color:' + color + '">' +
        Math.round(prob * 100) + '%</div>' +
        '<div style="font-family:var(--font-mono);font-size:9px;color:#4a5a6e;margin-top:4px">' +
        '<abbr title="3-day stockout probability">3-day prob</abbr></div>' +
        '</div></div>';
    }).join('');
  }
}

function renderDayButtons() {
  if (!dayBtnsEl) return;
  var html = '<button class="day-btn' + (!selectedDay ? ' day-active' : '') + '" data-day="">All</button>';
  for (var i = 0; i < NEXT_DAYS.length; ++i) {
    var day = NEXT_DAYS[i];
    var count = allRows.filter(function (r) { return r.highest_risk_day === day; }).length;
    html += '<button class="day-btn' + (selectedDay === day ? ' day-active' : '') +
      '" data-day="' + day + '">' + day + ' (' + count + ')</button>';
  }
  dayBtnsEl.innerHTML = html;
  dayBtnsEl.onclick = function (e) {
    var btn = e.target.closest('.day-btn');
    if (!btn) return;
    selectedDay = btn.dataset.day;
    renderDayButtons();
    renderFiltered();
  };
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
  var tableEl = document.getElementById('panel-forecast-table');
  var countEl = document.getElementById('forecast-count');
  if (!tableEl) return;

  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';
  var filtered = allRows;
  if (selectedDay) filtered = filtered.filter(function (r) { return r.highest_risk_day === selectedDay; });
  if (catVal) filtered = filtered.filter(function (r) { return r.product_category === catVal; });
  if (supVal) filtered = filtered.filter(function (r) { return r.supplier === supVal; });
  if (countEl) countEl.textContent = filtered.length + ' at risk';

  if (!filtered.length) {
    tableEl.innerHTML = '<div class="panel-empty">No at-risk products' +
      (selectedDay || catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var html = '<table class="tbl"><thead><tr>' +
    '<th title="Product name">Product</th>' +
    '<th title="3-day stockout probability from Cube forecast model"><abbr title="3-Day Probability">3-Day Prob</abbr></th>' +
    '<th title="Composite risk score">Risk Score</th>' +
    '<th title="Day with highest stockout probability">Worst Day</th>' +
    '<th title="Overall status from Cube model">Status</th>' +
    '<th title="Days since last stockout ended">Last</th>' +
    '<th title="Historical stockout frequency"><abbr title="Frequency per Month">Freq/Mo</abbr></th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + scoreBar(Number(r.forecast_stockout_probability) || 0, 'forecast_stockout_probability') + '</td>' +
      '<td>' + scoreBar(Number(r.risk_score) || 0, 'risk_score') + '</td>' +
      '<td>' + esc(r.highest_risk_day) + '</td>' +
      '<td>' + fieldBadge('trend_signal', r.trend_signal) + '</td>' +
      '<td>' + fmtDaysAgo(r.days_since_last) + '</td>' +
      '<td>' + fmtFreq(r.stockouts_per_month) + '</td>' +
      '</tr>';
  }

  tableEl.innerHTML = html + '</tbody></table>';
}
