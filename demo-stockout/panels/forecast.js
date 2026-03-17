// demo-stockout/panels/forecast.js

export function renderForecast(rowsResult) {
  var cardsEl = document.getElementById('panel-forecast-cards');
  var tableEl = document.getElementById('panel-forecast-table');
  var countEl = document.getElementById('forecast-count');
  if (!tableEl) return;

  var rows = columnarToRows(rowsResult);
  // Filter: not currently active AND forecast probability >= 0.3
  rows = rows.filter(function (r) {
    var active = r.is_currently_active;
    return (active !== 1 && active !== true && active !== 'true' && active !== '1') &&
      Number(r.forecast_stockout_probability) >= 0.3;
  });
  // Sort by forecast probability desc
  rows.sort(function (a, b) {
    return (Number(b.forecast_stockout_probability) || 0) - (Number(a.forecast_stockout_probability) || 0);
  });

  if (countEl) countEl.textContent = rows.length + ' at risk';

  // Render forecast summary cards (top 4)
  if (cardsEl) {
    var topProducts = rows.slice(0, 4);
    if (!topProducts.length) {
      cardsEl.innerHTML = '';
    } else {
      var cardsHtml = '';
      for (var c = 0; c < topProducts.length; ++c) {
        cardsHtml += renderForecastCard(topProducts[c]);
      }
      cardsEl.innerHTML = cardsHtml;
    }
  }

  // Render table
  if (!rows.length) {
    tableEl.innerHTML = '<div class="panel-empty">No at-risk products</div>';
    return;
  }

  var html = '<table class="tbl"><thead><tr>' +
    '<th>Product</th><th>Category</th><th>Supplier</th>' +
    '<th>Prob</th><th>Warning</th>' +
    '<th>Days Since</th><th>Freq/Mo</th><th>Risk Day</th>' +
    '</tr></thead><tbody>';

  for (var i = 0; i < rows.length; ++i) {
    var r = rows[i];
    html += '<tr>' +
      '<td class="val">' + esc(r.product) + '</td>' +
      '<td>' + esc(r.product_category) + '</td>' +
      '<td>' + esc(r.supplier) + '</td>' +
      '<td class="val">' + formatPct(r.forecast_stockout_probability) + '</td>' +
      '<td>' + forecastBadge(r.forecast_warning) + '</td>' +
      '<td>' + formatNum(r.days_since_last) + '</td>' +
      '<td>' + formatNum(r.stockouts_per_month) + '/mo</td>' +
      '<td>' + esc(r.highest_risk_day) + '</td>' +
      '</tr>';
  }

  html += '</tbody></table>';
  tableEl.innerHTML = html;
}

function renderForecastCard(r) {
  var prob = Number(r.forecast_stockout_probability) || 0;
  var color = probColor(prob);
  var pctStr = (prob * 100).toFixed(0) + '%';

  return '<div class="forecast-card">' +
    '<div class="forecast-card-title">' + esc(r.product) + '</div>' +
    '<div style="text-align:center;margin-top:8px;">' +
    '<div class="forecast-day-prob" style="color:' + color + ';font-size:24px;">' + pctStr + '</div>' +
    '<div style="font-family:var(--font-mono);font-size:9px;color:#4a5a6e;margin-top:4px;">stockout probability</div>' +
    '</div>' +
    '</div>';
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
  var cls = w.indexOf('high') >= 0 ? 'b-critical' : w.indexOf('moderate') >= 0 ? 'b-medium' : 'b-low';
  return '<span class="badge ' + cls + '">' + esc(warning) + '</span>';
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

function formatPct(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return (Number(v) * 100).toFixed(0) + '%';
}

function formatNum(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1);
}
