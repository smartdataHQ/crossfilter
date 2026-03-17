// demo-stockout/panels/dow-pattern.js

import { columnarToRows, esc } from './helpers.js';
import { colorFor } from '../config.js';

var chartInstance = null;

export function disposeDow() {
  if (chartInstance) { chartInstance.dispose(); chartInstance = null; }
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
    el.innerHTML = '<div class="panel-empty">No <abbr title="Day of Week">DOW</abbr> data</div>';
    if (badgesEl) badgesEl.innerHTML = '';
    return;
  }

  var confirmedTotals = [0, 0, 0, 0, 0, 0, 0];
  var probSums = [0, 0, 0, 0, 0, 0, 0];
  var weekdayRateSum = 0, weekendRateSum = 0;
  var patternCounts = {}, riskDayCounts = {};
  var count = rows.length;

  for (var i = 0; i < rows.length; ++i) {
    var r = rows[i];
    for (var d = 0; d < 7; ++d) {
      confirmedTotals[d] += Number(r[CONFIRMED_FIELDS[d]]) || 0;
      probSums[d] += Number(r[PROB_FIELDS[d]]) || 0;
    }
    weekdayRateSum += Number(r.weekday_stockout_rate) || 0;
    weekendRateSum += Number(r.weekend_stockout_rate) || 0;
    if (r.dow_pattern) patternCounts[r.dow_pattern] = (patternCounts[r.dow_pattern] || 0) + 1;
    if (r.highest_risk_day) riskDayCounts[r.highest_risk_day] = (riskDayCounts[r.highest_risk_day] || 0) + 1;
  }

  var probAvgs = probSums.map(function (s) { return count > 0 ? s / count : 0; });
  var barColors = probAvgs.map(function (p) { return colorFor('forecast_stockout_probability', p); });

  if (!chartInstance || chartInstance.isDisposed()) {
    chartInstance = echarts.init(el, themeName, { renderer: 'canvas' });
  }

  chartInstance.setOption({
    grid: { left: 50, right: 20, top: 10, bottom: 30, containLabel: false },
    tooltip: {
      trigger: 'axis',
      formatter: function (params) {
        var idx = params[0].dataIndex;
        return DAY_NAMES[idx] + '<br>Confirmed: ' + confirmedTotals[idx] +
          '<br><abbr title="Average Probability">Avg Prob</abbr>: ' + (probAvgs[idx] * 100).toFixed(1) + '%';
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
  var best = null, bestCount = 0;
  for (var key in counts) {
    if (counts[key] > bestCount) { bestCount = counts[key]; best = key; }
  }
  return best || '\u2014';
}
