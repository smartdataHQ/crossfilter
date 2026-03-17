// demo-stockout/panels/forecast.js
//
// At-risk products for the next 3 days.
// Filterable by day name, category, and supplier via compact dropdowns.

var allRows = [];
var daySelect = null;
var catSelect = null;
var supSelect = null;

// Next 3 day names from tomorrow
var NEXT_DAYS = (function () {
  var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var result = [];
  for (var i = 1; i <= 3; ++i) {
    var d = new Date();
    d.setDate(d.getDate() + i);
    result.push(days[d.getDay()]);
  }
  return result;
})();

export function renderForecast(rowsResult) {
  var cardsEl = document.getElementById('panel-forecast-cards');
  var tableEl = document.getElementById('panel-forecast-table');
  if (!tableEl) return;

  daySelect = daySelect || document.getElementById('forecast-day-filter');
  catSelect = catSelect || document.getElementById('forecast-cat-filter');
  supSelect = supSelect || document.getElementById('forecast-sup-filter');

  var rows = columnarToRows(rowsResult);
  // Not currently active AND forecast probability >= 0.3
  allRows = rows.filter(function (r) {
    var v = r.is_currently_active;
    return (v !== 1 && v !== true && v !== 'true' && v !== '1') &&
      Number(r.forecast_stockout_probability) >= 0.3;
  });
  allRows.sort(function (a, b) {
    return (Number(b.forecast_stockout_probability) || 0) - (Number(a.forecast_stockout_probability) || 0);
  });

  populateSelects(allRows);
  renderFiltered();

  // Summary cards (always show top 4, unfiltered)
  if (cardsEl) {
    var top = allRows.slice(0, 4);
    cardsEl.innerHTML = top.map(function (r) {
      var prob = Number(r.forecast_stockout_probability) || 0;
      var color = probColor(prob);
      return '<div class="forecast-card">' +
        '<div class="forecast-card-title">' + esc(r.product) + '</div>' +
        '<div style="text-align:center;margin-top:8px">' +
        '<div style="font-family:var(--font-mono);font-size:24px;font-weight:700;color:' + color + '">' +
        Math.round(prob * 100) + '%</div>' +
        '<div style="font-family:var(--font-mono);font-size:9px;color:#4a5a6e;margin-top:4px">stockout probability</div>' +
        '</div></div>';
    }).join('');
  }
}

function populateSelects(rows) {
  if (!daySelect || !catSelect || !supSelect) return;

  var prevDay = daySelect.value;
  var prevCat = catSelect.value;
  var prevSup = supSelect.value;

  // Day filter: next 3 day names + count of products where highest_risk_day matches
  daySelect.innerHTML = '<option value="">All Days (' + rows.length + ')</option>' +
    NEXT_DAYS.map(function (day) {
      var count = rows.filter(function (r) { return r.highest_risk_day === day; }).length;
      return '<option value="' + day + '">' + day + ' (' + count + ')</option>';
    }).join('');

  catSelect.innerHTML = '<option value="">All Categories (' + rows.length + ')</option>' +
    countedOptions(rows, 'product_category');
  supSelect.innerHTML = '<option value="">All Suppliers (' + rows.length + ')</option>' +
    countedOptions(rows, 'supplier');

  daySelect.value = prevDay;
  catSelect.value = prevCat;
  supSelect.value = prevSup;

  daySelect.onchange = renderFiltered;
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

  var dayVal = daySelect ? daySelect.value : '';
  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';

  var filtered = allRows;
  if (dayVal) filtered = filtered.filter(function (r) { return r.highest_risk_day === dayVal; });
  if (catVal) filtered = filtered.filter(function (r) { return r.product_category === catVal; });
  if (supVal) filtered = filtered.filter(function (r) { return r.supplier === supVal; });

  if (countEl) countEl.textContent = filtered.length + ' at risk';

  if (!filtered.length) {
    tableEl.innerHTML = '<div class="panel-empty">No at-risk products' +
      (dayVal || catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var html = '<table class="tbl"><thead><tr>' +
    '<th title="Product name">Product</th>' +
    '<th title="Combined 3-day stockout probability">Prob</th>' +
    '<th title="Warning level: Critical, Warning, Watch, Low Risk">Warning</th>' +
    '<th title="Day of the week with highest stockout probability">Risk Day</th>' +
    '<th title="Days since this product last had a stockout">Last</th>' +
    '<th title="Average stockout frequency per month">Freq</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    var prob = Number(r.forecast_stockout_probability) || 0;
    var color = probColor(prob);

    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td><span style="color:' + color + ';font-weight:600">' + Math.round(prob * 100) + '%</span></td>' +
      '<td>' + forecastBadge(r.forecast_warning) + '</td>' +
      '<td>' + esc(r.highest_risk_day) + '</td>' +
      '<td>' + fmtDays(r.days_since_last) + '</td>' +
      '<td>' + fmtFreq(r.stockouts_per_month) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  tableEl.innerHTML = html;
}

function probColor(prob) {
  if (prob == null) return '#4a5a6e';
  if (prob >= 0.7) return '#ff4d6a';
  if (prob >= 0.4) return '#ffb84d';
  return '#00e68a';
}

function forecastBadge(warning) {
  if (!warning) return '\u2014';
  var w = String(warning).toLowerCase();
  var cls = w.indexOf('critical') >= 0 ? 'b-critical' : w.indexOf('warning') >= 0 ? 'b-high' : w.indexOf('watch') >= 0 ? 'b-medium' : 'b-low';
  return '<span class="badge ' + cls + '">' + esc(warning) + '</span>';
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
