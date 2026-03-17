// demo-stockout/panels/risk-chart.js

var chartInstance = null;

export function disposeRiskChart() {
  if (chartInstance) {
    chartInstance.dispose();
    chartInstance = null;
  }
}

export function renderRiskChart(rowsResult, echarts, themeName) {
  var el = document.getElementById('panel-risk');
  if (!el) return;

  var rows = columnarToRows(rowsResult);
  // Exclude products already stocked out — they're not "at risk", they're active
  rows = rows.filter(function (r) {
    var v = r.is_currently_active;
    return v !== 1 && v !== true && v !== 'true' && v !== '1';
  });
  if (!rows.length) {
    el.innerHTML = '<div class="panel-empty">No at-risk products (not currently stocked out)</div>';
    return;
  }

  rows.sort(function (a, b) { return (b.risk_score || 0) - (a.risk_score || 0); });
  rows = rows.slice(0, 10);
  rows.reverse(); // For horizontal bar (bottom = highest)

  var names = [];
  var scores = [];
  var colors = [];

  for (var i = 0; i < rows.length; ++i) {
    var r = rows[i];
    var score = Number(r.risk_score) || 0;
    names.push(truncate(String(r.product || 'Unknown'), 25));
    scores.push(Number(score.toFixed(3)));

    if (score >= 0.75) colors.push('#ff4d6a');
    else if (score >= 0.5) colors.push('#ff8c4d');
    else if (score >= 0.25) colors.push('#ffb84d');
    else colors.push('#00e68a');
  }

  if (!chartInstance || chartInstance.isDisposed()) {
    chartInstance = echarts.init(el, themeName, { renderer: 'canvas' });
  }

  chartInstance.setOption({
    grid: { left: 140, right: 40, top: 10, bottom: 20, containLabel: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
    },
    xAxis: {
      type: 'value',
      max: 1,
      axisLabel: { formatter: function (v) { return (v * 100).toFixed(0) + '%'; } },
    },
    yAxis: {
      type: 'category',
      data: names,
      axisLabel: { fontSize: 10, width: 130, overflow: 'truncate' },
    },
    series: [{
      type: 'bar',
      data: scores.map(function (v, idx) {
        return { value: v, itemStyle: { color: colors[idx] } };
      }),
      barMaxWidth: 14,
      label: {
        show: true,
        position: 'right',
        formatter: function (p) { return (p.value * 100).toFixed(0) + '%'; },
        fontSize: 10,
        color: '#7a8a9e',
      },
    }],
  }, true);
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

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}
