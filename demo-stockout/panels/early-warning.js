// demo-stockout/panels/early-warning.js

export function renderEarlyWarning(rowsResult) {
  var el = document.getElementById('panel-early-warning');
  var countEl = document.getElementById('warning-count');
  if (!el) return;

  var rows = columnarToRows(rowsResult);
  // Post-filter for worsening (OR across two dimensions)
  rows = rows.filter(function (r) {
    return r.trend_signal === 'worsening' || r.severity_trend === 'worsening';
  });
  // Sort by risk_score desc
  rows.sort(function (a, b) { return (Number(b.risk_score) || 0) - (Number(a.risk_score) || 0); });

  if (countEl) countEl.textContent = rows.length + ' worsening';

  if (!rows.length) {
    el.innerHTML = '<div class="panel-empty">No worsening products detected</div>';
    return;
  }

  var html = '<table class="tbl"><thead><tr>' +
    '<th>Product</th><th>Category</th><th>Trend</th><th>Severity</th>' +
    '<th>Risk</th><th>Dur Recent</th><th>Dur Older</th>' +
    '<th>Freq Recent</th><th>Freq Older</th>' +
    '<th>Impact Recent</th><th>Impact Older</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < rows.length; ++i) {
    var r = rows[i];
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + esc(r.product_category) + '</td>' +
      '<td>' + trendBadge(r.trend_signal) + '</td>' +
      '<td>' + trendBadge(r.severity_trend) + '</td>' +
      '<td class="val">' + formatScore(r.risk_score) + '</td>' +
      '<td>' + deltaCell(r.avg_duration_recent_half, r.avg_duration_older_half, 'd') + '</td>' +
      '<td>' + formatDur(r.avg_duration_older_half) + '</td>' +
      '<td>' + deltaCell(r.frequency_recent_per_month, r.frequency_older_per_month, '/mo') + '</td>' +
      '<td>' + formatFreq(r.frequency_older_per_month) + '</td>' +
      '<td>' + deltaCell(r.avg_impact_recent_half, r.avg_impact_older_half, '/d') + '</td>' +
      '<td>' + formatImpact(r.avg_impact_older_half) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

function deltaCell(recent, older, suffix) {
  var r = Number(recent);
  var o = Number(older);
  var formatted = formatVal(recent, suffix);
  if (isNaN(r) || isNaN(o) || o === 0) return formatted;

  var delta = r - o;
  var arrow;
  if (delta > 0.01) arrow = '<span class="delta-up"> \u2191</span>';
  else if (delta < -0.01) arrow = '<span class="delta-down"> \u2193</span>';
  else arrow = '<span class="delta-flat"> \u2192</span>';

  return formatted + arrow;
}

function formatVal(v, suffix) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1) + (suffix || '');
}

function formatDur(v) { return formatVal(v, 'd'); }
function formatFreq(v) { return formatVal(v, '/mo'); }
function formatImpact(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(0) + '/d';
}
function formatScore(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(2);
}

function trendBadge(signal) {
  if (!signal) return '\u2014';
  var s = String(signal).toLowerCase();
  var cls = s === 'worsening' ? 'b-worsening' : s === 'improving' ? 'b-improving' : 'b-stable';
  return '<span class="badge ' + cls + '">' + esc(signal) + '</span>';
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
    for (var k = 0; k < keys.length; ++k) {
      row[keys[k]] = result[keys[k]][i];
    }
    rows.push(row);
  }
  return rows;
}

function esc(v) {
  if (v == null) return '\u2014';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
