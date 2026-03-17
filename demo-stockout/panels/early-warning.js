// demo-stockout/panels/early-warning.js
//
// Products NOT stocked out, NOT high risk, but deteriorating.
// Sortable column headers. Filtered by severity, category, supplier.

var allRows = [];
var sevSelect = null;
var catSelect = null;
var supSelect = null;
var sortField = 'risk_score';
var sortDir = -1; // -1 = desc, 1 = asc

var COLUMNS = [
  { key: 'product', label: 'Product', title: 'Product name', type: 'string' },
  { key: 'trend_signal', label: 'Recurrence', title: 'Are stockouts recurring more often and lasting longer? Worsening = yes', type: 'badge' },
  { key: 'severity_trend', label: 'Escalation', title: 'Is each stockout event getting more severe (higher impact)? Escalating = yes', type: 'badge' },
  { key: 'risk_score', label: 'Risk Score', title: 'Composite risk score (0-100%) combining frequency, duration, impact, and trend', type: 'bar' },
  { key: '_dur_delta', label: 'Duration \u0394', title: 'Are stockouts lasting longer? Recent-half avg duration vs older-half. \u2191 = getting longer', type: 'delta', recent: 'avg_duration_recent_half', older: 'avg_duration_older_half' },
  { key: '_freq_delta', label: 'Frequency \u0394', title: 'Are stockouts more frequent? Recent stockouts/month vs older. \u2191 = more often', type: 'delta', recent: 'frequency_recent_per_month', older: 'frequency_older_per_month' },
  { key: '_impact_delta', label: 'Impact \u0394', title: 'Is each stockout costlier? Recent lost-sales/day vs older. \u2191 = higher impact', type: 'delta', recent: 'avg_impact_recent_half', older: 'avg_impact_older_half' },
  { key: 'forecast_stockout_probability', label: '3-Day Prob', title: 'Probability of stockout in the next 3 days based on day-of-week history', type: 'bar' },
];

export function renderEarlyWarning(rowsResult) {
  var el = document.getElementById('panel-early-warning');
  if (!el) return;

  sevSelect = sevSelect || document.getElementById('warning-severity-filter');
  catSelect = catSelect || document.getElementById('warning-cat-filter');
  supSelect = supSelect || document.getElementById('warning-sup-filter');

  var rows = columnarToRows(rowsResult);
  allRows = rows.filter(function (r) {
    var active = r.is_currently_active;
    if (active === 1 || active === true || active === 'true' || active === '1') return false;
    var score = Number(r.risk_score) || 0;
    if (score >= 0.5) return false;
    var trend = String(r.trend_signal || '').toUpperCase();
    var severity = String(r.severity_trend || '').toUpperCase();
    return trend === 'WORSENING' || severity === 'ESCALATING' || severity === 'WORSENING';
  });

  sortRows();
  populateSelects(allRows);
  renderFiltered();
}

function sortRows() {
  var field = sortField;
  var dir = sortDir;

  allRows.sort(function (a, b) {
    var av = sortValue(a, field);
    var bv = sortValue(b, field);
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function sortValue(row, field) {
  // Delta columns: sort by the ratio (recent/older)
  var col = COLUMNS.filter(function (c) { return c.key === field; })[0];
  if (col && col.type === 'delta') {
    var r = Number(row[col.recent]) || 0;
    var o = Number(row[col.older]) || 0;
    return o > 0 ? r / o : (r > 0 ? 2 : 1);
  }
  var v = row[field];
  if (v == null) return '';
  return typeof v === 'string' ? v.toLowerCase() : Number(v) || 0;
}

function onHeaderClick(field) {
  if (sortField === field) {
    sortDir = sortDir * -1; // toggle direction
  } else {
    sortField = field;
    sortDir = -1; // default desc for new field
  }
  sortRows();
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

  // Build header with sort indicators
  var header = '<table class="tbl"><thead><tr>';
  for (var c = 0; c < COLUMNS.length; ++c) {
    var col = COLUMNS[c];
    var arrow = '';
    if (sortField === col.key) arrow = sortDir < 0 ? ' \u25bc' : ' \u25b2';
    header += '<th title="' + col.title + '" data-sort="' + col.key + '" class="sortable">' +
      col.label + arrow + '</th>';
  }
  header += '</tr></thead><tbody>';

  var body = '';
  for (var i = 0; i < filtered.length; ++i) {
    var r = filtered[i];
    body += '<tr>';
    for (var j = 0; j < COLUMNS.length; ++j) {
      body += renderCell(r, COLUMNS[j]);
    }
    body += '</tr>';
  }

  el.innerHTML = header + body + '</tbody></table>';

  // Attach sort click handlers
  var ths = el.querySelectorAll('th.sortable');
  for (var t = 0; t < ths.length; ++t) {
    ths[t].addEventListener('click', function (e) {
      onHeaderClick(e.currentTarget.dataset.sort);
    });
  }
}

function renderCell(r, col) {
  switch (col.type) {
    case 'string':
      return '<td class="val">' + esc(r[col.key]) + '</td>';
    case 'badge':
      return '<td>' + (col.key === 'severity_trend' ? severityBadge(r[col.key]) : trendBadge(r[col.key])) + '</td>';
    case 'bar':
      return '<td>' + scoreBar(Number(r[col.key]) || 0) + '</td>';
    case 'delta':
      return '<td>' + deltaCell(r[col.recent], r[col.older]) + '</td>';
    default:
      return '<td>' + esc(r[col.key]) + '</td>';
  }
}

function scoreBar(value) {
  var pct = Math.round(value * 100);
  var color = value >= 0.5 ? '#ff4d6a' : value >= 0.3 ? '#ffb84d' : '#4da6ff';
  return '<div style="display:flex;align-items:center;gap:4px;min-width:70px">' +
    '<div style="flex:1;height:3px;background:#1e2a3a;border-radius:2px;overflow:hidden">' +
    '<div style="width:' + pct + '%;height:100%;background:' + color + '"></div>' +
    '</div>' +
    '<span style="font-size:9px;color:' + color + '">' + pct + '%</span></div>';
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
