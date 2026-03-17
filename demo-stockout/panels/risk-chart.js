// demo-stockout/panels/risk-chart.js
//
// Top 10 highest risk products NOT currently stocked out.
// Table with inline risk bar, forecast, pattern label, and trending deltas.

export function renderRiskChart(storeResult, warningResult) {
  var el = document.getElementById('panel-risk');
  if (!el) return;

  // Build warning lookup
  var wMap = {};
  if (warningResult) {
    var wRows = columnarToRows(warningResult);
    for (var w = 0; w < wRows.length; ++w) wMap[wRows[w].product] = wRows[w];
  }

  var rows = columnarToRows(storeResult);
  // Exclude active stockouts
  rows = rows.filter(function (r) {
    var v = r.is_currently_active;
    return v !== 1 && v !== true && v !== 'true' && v !== '1';
  });

  if (!rows.length) {
    el.innerHTML = '<div class="panel-empty">No at-risk products</div>';
    return;
  }

  rows.sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); });
  rows = rows.slice(0, 10);

  var html = '<table class="tbl"><thead><tr>' +
    '<th title="Product name">Product</th>' +
    '<th title="Composite risk score (0-100%) based on frequency, duration, impact, and trend">Risk</th>' +
    '<th title="3-day stockout probability from DOW-based forecast model">Forecast</th>' +
    '<th title="Stockout pattern: Longer, Typical, Seasonal, or Rare">Pattern</th>' +
    '<th title="Days since last stockout ended">Last</th>' +
    '<th title="Frequency trend: recent vs older half. Arrow up = more frequent">Freq</th>' +
    '<th title="Current trend signal">Signal</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < rows.length; ++i) {
    var r = rows[i];
    var w = wMap[r.product] || {};
    var score = Number(r.risk_score) || 0;
    var forecast = Number(r.forecast_stockout_probability) || 0;

    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + riskBar(score) + '</td>' +
      '<td>' + forecastCell(forecast, r.forecast_warning) + '</td>' +
      '<td>' + labelBadge(r) + '</td>' +
      '<td>' + fmtDays(r.days_since_last) + '</td>' +
      '<td>' + deltaCell(Number(w.frequency_recent_per_month), Number(w.frequency_older_per_month)) + '</td>' +
      '<td>' + trendBadge(r.trend_signal) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  el.innerHTML = html;
}

// Inline horizontal bar for risk score
function riskBar(score) {
  var pct = Math.round(score * 100);
  var color = score >= 0.75 ? '#ff4d6a' : score >= 0.5 ? '#ff8c4d' : score >= 0.25 ? '#ffb84d' : '#00e68a';
  return '<div style="display:flex;align-items:center;gap:6px;min-width:90px">' +
    '<div style="flex:1;height:4px;background:#1e2a3a;border-radius:2px;overflow:hidden">' +
    '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:2px"></div>' +
    '</div>' +
    '<span style="font-size:10px;color:' + color + ';font-weight:600;min-width:28px">' + pct + '%</span>' +
    '</div>';
}

function forecastCell(prob, warning) {
  if (!prob) return '<span style="color:#4a5a6e">\u2014</span>';
  var pct = Math.round(prob * 100);
  var color = prob >= 0.7 ? '#ff4d6a' : prob >= 0.4 ? '#ffb84d' : '#00e68a';
  return '<span style="color:' + color + ';font-weight:600">' + pct + '%</span>';
}

function labelBadge(r) {
  var avg = Number(r.avg_duration_days) || 0;
  var median = Number(r.median_duration_days) || 0;
  var confirmed = Number(r.confirmed_stockouts) || 0;
  var freq = Number(r.stockouts_per_month) || 0;
  var pattern = r.dow_pattern;

  if (avg >= 3 || (median > 0 && avg > median * 2))
    return '<span class="badge b-critical">Longer</span>';
  if (confirmed >= 3 && pattern && pattern !== 'NO PATTERN')
    return '<span class="badge b-stable">Seasonal</span>';
  if (confirmed >= 3 && freq < 0.5)
    return '<span class="badge b-low">Rare</span>';
  return '<span class="badge b-medium">Typical</span>';
}

function deltaCell(recent, older) {
  if (!recent || !older) return '<span style="color:#4a5a6e">\u2014</span>';
  var ratio = older > 0 ? recent / older : (recent > 0 ? 2 : 1);
  var arrow, cls;
  if (ratio > 1.2) { arrow = '\u2191'; cls = 'delta-up'; }
  else if (ratio < 0.8) { arrow = '\u2193'; cls = 'delta-down'; }
  else { arrow = '\u2192'; cls = 'delta-flat'; }
  return '<span class="' + cls + '">' + arrow + ' ' + recent.toFixed(1) + '/mo</span>';
}

function trendBadge(signal) {
  if (!signal) return '\u2014';
  var s = String(signal).toLowerCase();
  var cls = s.indexOf('worsening') >= 0 ? 'b-worsening' : s === 'improving' ? 'b-improving' : 'b-stable';
  return '<span class="badge ' + cls + '">' + esc(signal) + '</span>';
}

function fmtDays(v) {
  if (v == null || isNaN(v)) return '\u2014';
  var d = Number(v);
  return d + 'd ago';
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
