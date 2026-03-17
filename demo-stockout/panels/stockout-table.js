// demo-stockout/panels/stockout-table.js
//
// Currently stocked out products table.
// Category/Supplier filtered via compact dropdowns (not visible columns).
// Labels column: Longer, Typical, Seasonal, Rare.
// Trending columns from cf-warning half-comparisons.

var allRows = [];
var catSelect = null;
var supSelect = null;

export function renderStockoutTable(storeResult) {
  var el = document.getElementById('panel-stockout-table');
  if (!el) return;

  catSelect = catSelect || document.getElementById('stockout-cat-filter');
  supSelect = supSelect || document.getElementById('stockout-sup-filter');

  var rows = columnarToRows(storeResult);
  allRows = rows.filter(function (r) {
    var v = r.is_currently_active;
    return v === 1 || v === true || v === 'true' || v === '1';
  });
  allRows.sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); });

  populateSelects(allRows);
  renderFiltered();
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
    el.innerHTML = '<div class="panel-empty">No active stockouts' +
      (catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var html = '<table class="tbl"><thead><tr>' +
    '<th title="Product name">Product</th>' +
    '<th title="Stockout character: Longer, Typical, or Rare">Pattern</th>' +
    '<th title="Average stockout duration for this product">Avg Duration</th>' +
    '<th title="Total estimated lost sales">Total Lost</th>' +
    '<th title="Overall status: Active, Worsening, Improving, or Stable">Status</th>' +
    '<th title="Historical stockout frequency">Freq/Mo</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + labelBadge(r) + '</td>' +
      '<td>' + fmtDur(r.avg_duration_days) + '</td>' +
      '<td>' + fmtISK(r.total_expected_lost_sales) + '</td>' +
      '<td>' + trendBadge(r.trend_signal) + '</td>' +
      '<td>' + fmtFreq(r.stockouts_per_month) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

// --- Label logic ---
// Longer:  avg_duration >= 3 days
// Rare:    stockouts_per_month < 0.5
// Typical: none of the above

function labelBadge(r) {
  var avg = Number(r.avg_duration_days) || 0;
  var freq = Number(r.stockouts_per_month) || 0;

  if (avg >= 3) return '<span class="badge b-critical">Longer</span>';
  if (freq < 0.5) return '<span class="badge b-low">Rare</span>';
  return '<span class="badge b-medium">Typical</span>';
}

function fmtFreq(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1) + '/mo';
}

// --- Helpers ---
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

function trendBadge(signal) {
  if (!signal) return '\u2014';
  var s = String(signal).toLowerCase();
  var cls = s.indexOf('worsening') >= 0 ? 'b-worsening' : s === 'improving' ? 'b-improving' : 'b-stable';
  return '<span class="badge ' + cls + '">' + esc(signal) + '</span>';
}

function fmtDur(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1) + 'd';
}

function fmtISK(v) {
  if (v == null || isNaN(v)) return '\u2014';
  v = Number(v);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return Math.round(v) + '';
}

function fmtNum(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1);
}
