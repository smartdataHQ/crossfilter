// demo-stockout/panels/early-warning.js
//
// Products NOT currently stocked out but showing deteriorating trends.
// Filtered by severity trend, category, supplier.

var allRows = [];
var sevSelect = null;
var catSelect = null;
var supSelect = null;

export function renderEarlyWarning(rowsResult) {
  var el = document.getElementById('panel-early-warning');
  if (!el) return;

  sevSelect = sevSelect || document.getElementById('warning-severity-filter');
  catSelect = catSelect || document.getElementById('warning-cat-filter');
  supSelect = supSelect || document.getElementById('warning-sup-filter');

  var rows = columnarToRows(rowsResult);

  // Only products NOT currently stocked out AND with worsening trend
  allRows = rows.filter(function (r) {
    var active = r.is_currently_active;
    if (active === 1 || active === true || active === 'true' || active === '1') return false;
    var trend = String(r.trend_signal || '').toUpperCase();
    var severity = String(r.severity_trend || '').toUpperCase();
    return trend === 'WORSENING' || severity === 'ESCALATING' || severity === 'WORSENING';
  });
  allRows.sort(function (a, b) { return (Number(b.risk_score) || 0) - (Number(a.risk_score) || 0); });

  populateSelects(allRows);
  renderFiltered();
}

function populateSelects(rows) {
  if (!sevSelect || !catSelect || !supSelect) return;

  var prevSev = sevSelect.value;
  var prevCat = catSelect.value;
  var prevSup = supSelect.value;

  sevSelect.innerHTML = '<option value="">All Severity (' + rows.length + ')</option>' +
    countedOptions(rows, 'severity_trend');
  catSelect.innerHTML = '<option value="">All Categories (' + rows.length + ')</option>' +
    countedOptions(rows, 'product_category');
  supSelect.innerHTML = '<option value="">All Suppliers (' + rows.length + ')</option>' +
    countedOptions(rows, 'supplier');

  sevSelect.value = prevSev;
  catSelect.value = prevCat;
  supSelect.value = prevSup;
  sevSelect.onchange = renderFiltered;
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
  var el = document.getElementById('panel-early-warning');
  var countEl = document.getElementById('warning-count');
  if (!el) return;

  var sevVal = sevSelect ? sevSelect.value : '';
  var catVal = catSelect ? catSelect.value : '';
  var supVal = supSelect ? supSelect.value : '';

  var filtered = allRows;
  if (sevVal) filtered = filtered.filter(function (r) { return r.severity_trend === sevVal; });
  if (catVal) filtered = filtered.filter(function (r) { return r.product_category === catVal; });
  if (supVal) filtered = filtered.filter(function (r) { return r.supplier === supVal; });

  if (countEl) countEl.textContent = filtered.length + ' deteriorating';

  if (!filtered.length) {
    el.innerHTML = '<div class="panel-empty">No deteriorating products' +
      (sevVal || catVal || supVal ? ' matching filter' : '') + '</div>';
    return;
  }

  var html = '<table class="tbl"><thead><tr>' +
    '<th title="Product name">Product</th>' +
    '<th title="Frequency trend: worsening = stockouts becoming more frequent">Trend</th>' +
    '<th title="Severity trend: escalating = each stockout getting worse (longer, costlier)">Severity</th>' +
    '<th title="Composite risk score">Risk</th>' +
    '<th title="Duration trend: recent-half avg vs older-half avg">Dur \u0394</th>' +
    '<th title="Frequency trend: recent stockouts/month vs older">Freq \u0394</th>' +
    '<th title="Impact trend: recent lost-sales/day vs older">Impact \u0394</th>' +
    '<th title="3-day forecast stockout probability">Forecast</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + trendBadge(r.trend_signal) + '</td>' +
      '<td>' + severityBadge(r.severity_trend) + '</td>' +
      '<td>' + riskBar(Number(r.risk_score) || 0) + '</td>' +
      '<td>' + deltaCell(r.avg_duration_recent_half, r.avg_duration_older_half) + '</td>' +
      '<td>' + deltaCell(r.frequency_recent_per_month, r.frequency_older_per_month) + '</td>' +
      '<td>' + deltaCell(r.avg_impact_recent_half, r.avg_impact_older_half) + '</td>' +
      '<td>' + forecastCell(r.forecast_stockout_probability) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

function riskBar(score) {
  var pct = Math.round(score * 100);
  var color = score >= 0.5 ? '#ff4d6a' : score >= 0.3 ? '#ffb84d' : '#4da6ff';
  return '<div style="display:flex;align-items:center;gap:4px;min-width:70px">' +
    '<div style="flex:1;height:3px;background:#1e2a3a;border-radius:2px;overflow:hidden">' +
    '<div style="width:' + pct + '%;height:100%;background:' + color + '"></div>' +
    '</div>' +
    '<span style="font-size:9px;color:' + color + '">' + pct + '%</span>' +
    '</div>';
}

function deltaCell(recent, older) {
  var r = Number(recent);
  var o = Number(older);
  if (isNaN(r) || isNaN(o)) return '<span style="color:#4a5a6e">\u2014</span>';
  var ratio = o > 0 ? r / o : (r > 0 ? 2 : 1);
  var arrow, cls;
  if (ratio > 1.2) { arrow = '\u2191'; cls = 'delta-up'; }
  else if (ratio < 0.8) { arrow = '\u2193'; cls = 'delta-down'; }
  else { arrow = '\u2192'; cls = 'delta-flat'; }
  return '<span class="' + cls + '">' + arrow + ' ' + r.toFixed(1) + '</span>';
}

function forecastCell(prob) {
  var p = Number(prob);
  if (isNaN(p) || p === 0) return '<span style="color:#4a5a6e">\u2014</span>';
  var color = p >= 0.7 ? '#ff4d6a' : p >= 0.4 ? '#ffb84d' : '#00e68a';
  return '<span style="color:' + color + ';font-weight:600">' + Math.round(p * 100) + '%</span>';
}

function trendBadge(signal) {
  if (!signal) return '\u2014';
  var s = String(signal).toUpperCase();
  if (s.indexOf('WORSENING') >= 0) return '<span class="badge b-worsening">' + esc(signal) + '</span>';
  if (s === 'IMPROVING') return '<span class="badge b-improving">' + esc(signal) + '</span>';
  return '<span class="badge b-stable">' + esc(signal) + '</span>';
}

function severityBadge(severity) {
  if (!severity) return '\u2014';
  var s = String(severity).toUpperCase();
  if (s === 'ESCALATING' || s === 'WORSENING') return '<span class="badge b-critical">' + esc(severity) + '</span>';
  if (s === 'IMPROVING') return '<span class="badge b-improving">' + esc(severity) + '</span>';
  return '<span class="badge b-stable">' + esc(severity) + '</span>';
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
