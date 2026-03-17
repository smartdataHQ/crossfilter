// demo-stockout/panels/forecast.js
//
// At-risk products for the next 3 days.
// Day buttons, category/supplier dropdowns, no category/supplier columns.

var allRows = [];
var dayBtnsEl = null;
var catSelect = null;
var supSelect = null;
var selectedDay = '';

// Next 3 day names from tomorrow
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
  allRows = rows.filter(function (r) {
    var v = r.is_currently_active;
    return (v !== 1 && v !== true && v !== 'true' && v !== '1') &&
      Number(r.forecast_stockout_probability) >= 0.3;
  });
  allRows.sort(function (a, b) {
    return (Number(b.forecast_stockout_probability) || 0) - (Number(a.forecast_stockout_probability) || 0);
  });

  renderDayButtons();
  populateSelects(allRows);
  renderFiltered();

  // Summary cards (top 4, unfiltered)
  if (cardsEl) {
    cardsEl.innerHTML = allRows.slice(0, 4).map(function (r) {
      var prob = Number(r.forecast_stockout_probability) || 0;
      var color = probColor(prob);
      return '<div class="forecast-card">' +
        '<div class="forecast-card-title">' + esc(r.product) + '</div>' +
        '<div style="text-align:center;margin-top:8px">' +
        '<div style="font-family:var(--font-mono);font-size:24px;font-weight:700;color:' + color + '">' +
        Math.round(prob * 100) + '%</div>' +
        '<div style="font-family:var(--font-mono);font-size:9px;color:#4a5a6e;margin-top:4px">3-day probability</div>' +
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
  var prevCat = catSelect.value;
  var prevSup = supSelect.value;

  catSelect.innerHTML = '<option value="">All Categories (' + rows.length + ')</option>' +
    countedOptions(rows, 'product_category');
  supSelect.innerHTML = '<option value="">All Suppliers (' + rows.length + ')</option>' +
    countedOptions(rows, 'supplier');

  catSelect.value = prevCat;
  supSelect.value = prevSup;
  catSelect.onchange = renderFiltered;
  supSelect.onchange = renderFiltered;
}

function countedOptions(rows, field) {
  var counts = {};
  for (var i = 0; i < rows.length; ++i) {
    var v = rows[i][field];
    if (v) counts[v] = (counts[v] || 0) + 1;
  }
  var entries = [];
  for (var key in counts) entries.push({ name: key, count: counts[key] });
  entries.sort(function (a, b) { return b.count - a.count; });
  return entries.map(function (e) {
    return '<option value="' + esc(e.name) + '">' + esc(e.name) + ' (' + e.count + ')</option>';
  }).join('');
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
    '<th title="3-day stockout probability from DOW-based forecast">3-Day Prob</th>' +
    '<th title="Composite risk score based on frequency, duration, impact, and trend">Risk Score</th>' +
    '<th title="Day of the week with highest stockout probability">Risk Day</th>' +
    '<th title="Current trend signal">Signal</th>' +
    '<th title="Days since last stockout ended">Last</th>' +
    '<th title="Average stockout frequency per month">Freq</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + scoreBar(Number(r.forecast_stockout_probability) || 0, 'prob') + '</td>' +
      '<td>' + scoreBar(Number(r.risk_score) || 0, 'risk') + '</td>' +
      '<td>' + esc(r.highest_risk_day) + '</td>' +
      '<td>' + trendBadge(r.trend_signal) + '</td>' +
      '<td>' + fmtDays(r.days_since_last) + '</td>' +
      '<td>' + fmtFreq(r.stockouts_per_month) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  tableEl.innerHTML = html;
}

// Unified inline bar for both probability and risk score (0-1)
function scoreBar(value, type) {
  var pct = Math.round(value * 100);
  var color;
  if (type === 'prob') {
    color = value >= 0.7 ? '#ff4d6a' : value >= 0.4 ? '#ffb84d' : '#00e68a';
  } else {
    color = value >= 0.75 ? '#ff4d6a' : value >= 0.5 ? '#ff8c4d' : value >= 0.25 ? '#ffb84d' : '#00e68a';
  }
  return '<div style="display:flex;align-items:center;gap:4px;min-width:80px">' +
    '<div style="flex:1;height:4px;background:#1e2a3a;border-radius:2px;overflow:hidden">' +
    '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:2px"></div>' +
    '</div>' +
    '<span style="font-size:10px;color:' + color + ';font-weight:600;min-width:28px">' + pct + '%</span>' +
    '</div>';
}

function probColor(prob) {
  if (prob >= 0.7) return '#ff4d6a';
  if (prob >= 0.4) return '#ffb84d';
  return '#00e68a';
}

function trendBadge(signal) {
  if (!signal) return '\u2014';
  var s = String(signal).toUpperCase();
  if (s.indexOf('WORSENING') >= 0) return '<span class="badge b-worsening">' + esc(signal) + '</span>';
  if (s === 'IMPROVING') return '<span class="badge b-improving">' + esc(signal) + '</span>';
  return '<span class="badge b-stable">' + esc(signal) + '</span>';
}

function fmtDays(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v) + 'd ago';
}

function fmtFreq(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1) + '/mo';
}

function columnarToRows(result) {
  if (!result || typeof result !== 'object') return [];
  if (result.columns && typeof result.columns === 'object') result = result.columns;
  var keys = Object.keys(result);
  if (!keys.length) return [];
  var len = Array.isArray(result[keys[0]]) ? result[keys[0]].length : 0;
  var rows = [];
  for (var i = 0; i < len; ++i) {
    var row = {};
    for (var k = 0; k < keys.length; ++k) row[keys[k]] = result[keys[k]][i];
    rows.push(row);
  }
  return rows;
}

function esc(v) {
  if (v == null) return '\u2014';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
