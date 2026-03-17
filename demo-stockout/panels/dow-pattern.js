// demo-stockout/panels/dow-pattern.js

var chartInstance = null;

export function disposeDow() {
  if (chartInstance) {
    chartInstance.dispose();
    chartInstance = null;
  }
}

var DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var CONFIRMED_FIELDS = [
  'dow_mon_confirmed', 'dow_tue_confirmed', 'dow_wed_confirmed',
  'dow_thu_confirmed', 'dow_fri_confirmed', 'dow_sat_confirmed', 'dow_sun_confirmed',
];
var PROB_FIELDS = [
  'dow_mon_probability', 'dow_tue_probability', 'dow_wed_probability',
  'dow_thu_probability', 'dow_fri_probability', 'dow_sat_probability', 'dow_sun_probability',
];

export function renderDowPattern(rowsResult, echarts, themeName) {
  var el = document.getElementById('panel-dow');
  var badgesEl = document.getElementById('panel-dow-badges');
  if (!el) return;

  var rows = columnarToRows(rowsResult);
  if (!rows.length) {
    el.innerHTML = '<div class="panel-empty">No DOW data</div>';
    if (badgesEl) badgesEl.innerHTML = '';
    return;
  }

  // Aggregate across all rows
  var confirmedTotals = [0, 0, 0, 0, 0, 0, 0];
  var probSums = [0, 0, 0, 0, 0, 0, 0];
  var weekdayRateSum = 0;
  var weekendRateSum = 0;
  var patternCounts = {};
  var riskDayCounts = {};
  var count = rows.length;

  for (var i = 0; i < rows.length; ++i) {
    var r = rows[i];
    for (var d = 0; d < 7; ++d) {
      confirmedTotals[d] += Number(r[CONFIRMED_FIELDS[d]]) || 0;
      probSums[d] += Number(r[PROB_FIELDS[d]]) || 0;
    }
    weekdayRateSum += Number(r.weekday_stockout_rate) || 0;
    weekendRateSum += Number(r.weekend_stockout_rate) || 0;

    var pattern = r.dow_pattern;
    if (pattern) patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
    var riskDay = r.highest_risk_day;
    if (riskDay) riskDayCounts[riskDay] = (riskDayCounts[riskDay] || 0) + 1;
  }

  var probAvgs = probSums.map(function (s) { return count > 0 ? s / count : 0; });

  // Color bars by probability
  var barColors = probAvgs.map(function (p) {
    if (p >= 0.5) return '#ff4d6a';
    if (p >= 0.3) return '#ffb84d';
    return '#00e68a';
  });

  if (!chartInstance || chartInstance.isDisposed()) {
    chartInstance = echarts.init(el, themeName, { renderer: 'canvas' });
  }

  chartInstance.setOption({
    grid: { left: 50, right: 20, top: 10, bottom: 30, containLabel: false },
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        var idx = params[0].dataIndex;
        return DAY_NAMES[idx] + '<br>' +
          'Confirmed: ' + confirmedTotals[idx] + '<br>' +
          'Avg Probability: ' + (probAvgs[idx] * 100).toFixed(1) + '%';
      },
    },
    xAxis: { type: 'category', data: DAY_NAMES },
    yAxis: { type: 'value', name: 'Confirmed' },
    series: [{
      type: 'bar',
      data: confirmedTotals.map(function (v, idx) {
        return { value: v, itemStyle: { color: barColors[idx] } };
      }),
      barMaxWidth: 32,
    }],
  }, true);

  // Render badges
  if (badgesEl) {
    var topPattern = mode(patternCounts);
    var topRiskDay = mode(riskDayCounts);
    var avgWeekdayRate = count > 0 ? (weekdayRateSum / count * 100).toFixed(1) : '0.0';
    var avgWeekendRate = count > 0 ? (weekendRateSum / count * 100).toFixed(1) : '0.0';

    badgesEl.innerHTML =
      '<div class="dow-badge">Pattern: <strong>' + esc(topPattern) + '</strong></div>' +
      '<div class="dow-badge">Highest Risk Day: <strong>' + esc(topRiskDay) + '</strong></div>' +
      '<div class="dow-badge">Weekday Rate: <strong>' + avgWeekdayRate + '%</strong></div>' +
      '<div class="dow-badge">Weekend Rate: <strong>' + avgWeekendRate + '%</strong></div>';
  }
}

function mode(counts) {
  var best = null;
  var bestCount = 0;
  for (var key in counts) {
    if (counts[key] > bestCount) {
      bestCount = counts[key];
      best = key;
    }
  }
  return best || '\u2014';
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
