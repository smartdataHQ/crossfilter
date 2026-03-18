// demo-stockout/panels/forecast.js

import { getColumns, filterIndices, sortIndices, countByColumn, countsToOptions, esc, isActive, scoreBar, fieldBadge, fmtDaysAgo, fmtFreq, sortableHeader, attachSortHandlers } from './helpers.js';
import { colorFor } from '../config.js';

var columns = null;
var allIndices = [];
var dayBtnsEl = null;
var catSelect = null;
var supSelect = null;
var selectedDay = '';
var sortField = 'forecast_stockout_probability';
var sortDir = -1;

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

var FORECAST_TIERS = { CRITICAL: 1, Critical: 1, HIGH: 1, High: 1, MODERATE: 1, Moderate: 1 };

var COLUMNS = [
  { key: 'product', label: 'Product', title: 'Product name' },
  { key: 'forecast_stockout_probability', label: '<abbr title="3-Day Probability">3-Day Prob</abbr>', title: '3-day stockout probability' },
  { key: 'risk_score', label: 'Risk Score', title: 'Composite risk score' },
  { key: 'highest_risk_day', label: 'Worst Day', title: 'Day with highest stockout probability' },
  { key: 'trend_signal', label: 'Status', title: 'Overall status from Cube model' },
  { key: 'days_since_last', label: 'Last', title: 'Days since last stockout ended' },
  { key: 'stockouts_per_month', label: '<abbr title="Frequency per Month">Freq/Mo</abbr>', title: 'Historical stockout frequency' },
];

export function renderForecast(rowsResult) {
  var cardsEl = document.getElementById('panel-forecast-cards');
  var tableEl = document.getElementById('panel-forecast-table');
  if (!tableEl) return;

  dayBtnsEl = dayBtnsEl || document.getElementById('forecast-day-btns');
  catSelect = catSelect || document.getElementById('forecast-cat-filter');
  supSelect = supSelect || document.getElementById('forecast-sup-filter');

  var data = getColumns(rowsResult);
  columns = data.columns;
  allIndices = filterIndices(columns, data.length, function (cols, i) {
    if (isActive(cols.is_currently_active ? cols.is_currently_active[i] : null)) return false;
    return FORECAST_TIERS[(cols.forecast_tier ? cols.forecast_tier[i] : '') || ''] === 1;
  });
  sortIndices(allIndices, columns, sortField, sortDir);

  renderDayButtons();
  populateSelects();
  renderFiltered();

  if (cardsEl) {
    var cProd = columns.product, cProb = columns.forecast_stockout_probability;
    var cardsHtml = '';
    var topN = allIndices.length < 4 ? allIndices.length : 4;
    for (var ci = 0; ci < topN; ++ci) {
      var tidx = allIndices[ci];
      var prob = +(cProb ? cProb[tidx] : 0) || 0;
      var color = colorFor('forecast_stockout_probability', prob);
      cardsHtml += '<div class="forecast-card">' +
        '<div class="forecast-card-title">' + esc(cProd[tidx]) + '</div>' +
        '<div style="text-align:center;margin-top:8px">' +
        '<div style="font-family:var(--font-mono);font-size:24px;font-weight:700;color:' + color + '">' +
        Math.round(prob * 100) + '%</div>' +
        '<div style="font-family:var(--font-mono);font-size:9px;color:#4a5a6e;margin-top:4px">' +
        '<abbr title="3-day stockout probability">3-day prob</abbr></div>' +
        '</div></div>';
    }
    cardsEl.innerHTML = cardsHtml;
  }
}

function onSort(field) {
  if (sortField === field) sortDir *= -1;
  else { sortField = field; sortDir = -1; }
  sortIndices(allIndices, columns, sortField, sortDir);
  renderFiltered();
}

var dayBtnsBuilt = false;

function renderDayButtons() {
  if (!dayBtnsEl || !columns) return;
  var dayCounts = countByColumn(columns, allIndices, 'highest_risk_day');
  var html = '<button class="day-btn' + (!selectedDay ? ' day-active' : '') + '" data-day="">All</button>';
  for (var i = 0; i < NEXT_DAYS.length; ++i) {
    var day = NEXT_DAYS[i];
    var count = dayCounts[day] || 0;
    html += '<button class="day-btn' + (selectedDay === day ? ' day-active' : '') +
      '" data-day="' + day + '">' + day + ' (' + count + ')</button>';
  }
  dayBtnsEl.innerHTML = html;
  if (!dayBtnsBuilt) {
    dayBtnsBuilt = true;
    dayBtnsEl.onclick = function (e) {
      var btn = e.target.closest('.day-btn');
      if (!btn) return;
      selectedDay = btn.dataset.day;
      var btns = dayBtnsEl.querySelectorAll('.day-btn');
      for (var j = 0; j < btns.length; ++j) {
        if (btns[j].dataset.day === selectedDay) btns[j].classList.add('day-active');
        else btns[j].classList.remove('day-active');
      }
      renderFiltered();
    };
  }
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

var forecastTableEl = null;
var forecastCountEl = null;

function renderFiltered() {
  forecastTableEl = forecastTableEl || document.getElementById('panel-forecast-table');
  forecastCountEl = forecastCountEl || document.getElementById('forecast-count');
  var tableEl = forecastTableEl;
  var countEl = forecastCountEl;
  if (!tableEl || !columns) return;

  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';
  var filtered = allIndices;
  if (selectedDay || catVal || supVal) {
    var dayCol = columns.highest_risk_day;
    var catCol = columns.product_category;
    var supCol = columns.supplier;
    filtered = [];
    for (var f = 0; f < allIndices.length; ++f) {
      var idx = allIndices[f];
      if (selectedDay && dayCol && dayCol[idx] !== selectedDay) continue;
      if (catVal && catCol && catCol[idx] !== catVal) continue;
      if (supVal && supCol && supCol[idx] !== supVal) continue;
      filtered.push(idx);
    }
  }
  if (countEl) countEl.textContent = filtered.length + ' at risk';

  if (!filtered.length) {
    tableEl.innerHTML = '<div class="panel-empty">No at-risk products' +
      (selectedDay || catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var cProduct = columns.product, cProb = columns.forecast_stockout_probability;
  var cRisk = columns.risk_score, cDay = columns.highest_risk_day;
  var cTrend = columns.trend_signal, cLast = columns.days_since_last;
  var cFreq = columns.stockouts_per_month;
  var html = '<table class="tbl">' + sortableHeader(COLUMNS, sortField, sortDir) + '<tbody>';
  for (var i = 0; i < filtered.length; ++i) {
    var idx = filtered[i];
    html += '<tr>' +
      '<td class="val">' + esc(cProduct[idx]) + '</td>' +
      '<td>' + scoreBar(+(cProb[idx]) || 0, 'forecast_stockout_probability') + '</td>' +
      '<td>' + scoreBar(+(cRisk[idx]) || 0, 'risk_score') + '</td>' +
      '<td>' + esc(cDay[idx]) + '</td>' +
      '<td>' + fieldBadge('trend_signal', cTrend[idx]) + '</td>' +
      '<td>' + fmtDaysAgo(cLast[idx]) + '</td>' +
      '<td>' + fmtFreq(cFreq[idx]) + '</td>' +
      '</tr>';
  }

  tableEl.innerHTML = html + '</tbody></table>';
  attachSortHandlers(tableEl, onSort);
}
