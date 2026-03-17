// demo-stockout/panels/stockout-table.js
//
// Currently stocked out products table.
// Category/Supplier filtered via compact dropdowns (not visible columns).
// Labels column: Longer, Typical, Seasonal, Rare.
// Trending columns from cf-warning half-comparisons.

var allRows = [];
var catSelect = null;
var supSelect = null;

export function renderStockoutTable(storeResult, warningResult) {
  var el = document.getElementById('panel-stockout-table');
  if (!el) return;

  catSelect = catSelect || document.getElementById('stockout-cat-filter');
  supSelect = supSelect || document.getElementById('stockout-sup-filter');

  // Build warning lookup by product name
  var warningMap = {};
  if (warningResult) {
    var wRows = columnarToRows(warningResult);
    for (var w = 0; w < wRows.length; ++w) {
      warningMap[wRows[w].product] = wRows[w];
    }
  }

  var rows = columnarToRows(storeResult);
  allRows = rows.filter(function (r) {
    var v = r.is_currently_active;
    return v === 1 || v === true || v === 'true' || v === '1';
  }).map(function (r) {
    // Merge warning trending data
    var w = warningMap[r.product] || {};
    r.dur_recent = Number(w.avg_duration_recent_half) || null;
    r.dur_older = Number(w.avg_duration_older_half) || null;
    r.freq_recent = Number(w.frequency_recent_per_month) || null;
    r.freq_older = Number(w.frequency_older_per_month) || null;
    r.impact_recent = Number(w.avg_impact_recent_half) || null;
    r.impact_older = Number(w.avg_impact_older_half) || null;
    return r;
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
    '<th title="Stockout pattern: Longer than usual, Typical, Seasonal (DOW pattern), or Rare occurrence">Pattern</th>' +
    '<th title="Average stockout duration for this product at this store">Avg Duration</th>' +
    '<th title="Total estimated lost sales across all stockout events">Total Lost</th>' +
    '<th title="Composite trend: Active, Worsening, Improving, or Stable based on duration, frequency, and severity changes">Signal</th>' +
    '<th title="Duration trend: recent-half avg vs older-half avg. Arrow up = stockouts getting longer">Duration Trend</th>' +
    '<th title="Frequency trend: recent stockouts/month vs older. Arrow up = happening more often">Frequency Trend</th>' +
    '<th title="Impact trend: recent lost-sales/day vs older. Arrow up = each stockout costs more">Impact Trend</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + labelBadge(r) + '</td>' +
      '<td>' + fmtDur(r.avg_duration_days) + '</td>' +
      '<td>' + fmtISK(r.total_expected_lost_sales) + '</td>' +
      '<td>' + trendBadge(r.trend_signal) + '</td>' +
      '<td>' + deltaCell(r.dur_recent, r.dur_older) + '</td>' +
      '<td>' + deltaCell(r.freq_recent, r.freq_older) + '</td>' +
      '<td>' + deltaCell(r.impact_recent, r.impact_older) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

// --- Label logic ---
//
// Longer:   This product's stockouts tend to drag on. Triggered when:
//           - avg_duration >= 3 days (absolute: these don't resolve quickly), OR
//           - avg_duration > median * 2 (relative: some events are much longer than typical)
//
// Seasonal: Stockouts cluster on specific days of the week.
//           Only from dow_pattern = WEEKEND-PRONE or WEEKDAY-PRONE,
//           and only when there's enough history (confirmed >= 3).
//
// Rare:     This product rarely stocks out: < 0.5 times per month,
//           with at least 3 confirmed events in history (otherwise insufficient data).
//
// Typical:  None of the above — normal duration, normal frequency, no DOW pattern.

function labelBadge(r) {
  var labels = [];

  var avg = Number(r.avg_duration_days) || 0;
  var median = Number(r.median_duration_days) || 0;
  var confirmed = Number(r.confirmed_stockouts) || 0;

  // Longer: stockouts that don't resolve quickly
  if (avg >= 3 || (median > 0 && avg > median * 2)) {
    labels.push('<span class="badge b-critical">Longer</span>');
  }

  // Seasonal: day-of-week clustering (need enough history to be meaningful)
  var pattern = r.dow_pattern;
  if (confirmed >= 3 && pattern && pattern !== 'NO PATTERN') {
    labels.push('<span class="badge b-stable">Seasonal</span>');
  }

  // Rare: infrequent stockouts (need enough history to distinguish from "new")
  var freq = Number(r.stockouts_per_month) || 0;
  if (confirmed >= 3 && freq < 0.5) {
    labels.push('<span class="badge b-low">Rare</span>');
  }

  if (!labels.length) {
    labels.push('<span class="badge b-medium">Typical</span>');
  }

  return labels.join(' ');
}

// --- Delta cell: recent vs older half comparison ---
function deltaCell(recent, older) {
  if (recent == null || older == null) return '<span style="color:#4a5a6e">\u2014</span>';
  var ratio = older > 0 ? recent / older : (recent > 0 ? 2 : 1);
  var arrow, cls;
  if (ratio > 1.2) {
    arrow = '\u2191'; cls = 'delta-up';  // worsening (up = bad)
  } else if (ratio < 0.8) {
    arrow = '\u2193'; cls = 'delta-down'; // improving
  } else {
    arrow = '\u2192'; cls = 'delta-flat';
  }
  return '<span class="' + cls + '">' + arrow + ' ' + fmtNum(recent) + '</span>';
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
