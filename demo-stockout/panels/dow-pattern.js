// demo-stockout/panels/dow-pattern.js

import { getColumns, esc } from './helpers.js';
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
var TOTAL_FIELDS = [
  'dow_mon_total', 'dow_tue_total', 'dow_wed_total',
  'dow_thu_total', 'dow_fri_total', 'dow_sat_total', 'dow_sun_total',
];

var dowEl = null;
var dowBadgesEl = null;

export function renderDowPattern(rowsResult, echarts, themeName) {
  dowEl = dowEl || document.getElementById('panel-dow');
  dowBadgesEl = dowBadgesEl || document.getElementById('panel-dow-badges');
  var el = dowEl;
  var badgesEl = dowBadgesEl;
  if (!el) return;

  var data = getColumns(rowsResult);
  var cols = data.columns;
  var len = data.length;
  if (!len) {
    el.innerHTML = '<div class="panel-empty">No <abbr title="Day of Week">DOW</abbr> data</div>';
    if (badgesEl) badgesEl.innerHTML = '';
    return;
  }

  var confirmedTotals = [0, 0, 0, 0, 0, 0, 0];
  var observedTotals = [0, 0, 0, 0, 0, 0, 0];
  var weekdayRateSum = 0, weekendRateSum = 0;
  var patternCounts = {}, riskDayCounts = {};
  var count = len;

  var weekdayCol = cols.weekday_stockout_rate;
  var weekendCol = cols.weekend_stockout_rate;
  var patternCol = cols.dow_pattern;
  var riskDayCol = cols.highest_risk_day;

  var confCols = new Array(7), totCols = new Array(7);
  for (var d = 0; d < 7; ++d) {
    confCols[d] = cols[CONFIRMED_FIELDS[d]];
    totCols[d] = cols[TOTAL_FIELDS[d]];
  }
  for (var i = 0; i < len; ++i) {
    for (var dd = 0; dd < 7; ++dd) {
      confirmedTotals[dd] += +(confCols[dd] ? confCols[dd][i] : 0) || 0;
      observedTotals[dd] += +(totCols[dd] ? totCols[dd][i] : 0) || 0;
    }
  }
  for (var j = 0; j < len; ++j) {
    weekdayRateSum += Number(weekdayCol ? weekdayCol[j] : 0) || 0;
    weekendRateSum += Number(weekendCol ? weekendCol[j] : 0) || 0;
    var pat = patternCol ? patternCol[j] : null;
    var rday = riskDayCol ? riskDayCol[j] : null;
    if (pat) patternCounts[pat] = (patternCounts[pat] || 0) + 1;
    if (rday) riskDayCounts[rday] = (riskDayCounts[rday] || 0) + 1;
  }

  // Weighted probability: total confirmed / total observed (not avg of per-product probs)
  var probAvgs = confirmedTotals.map(function (c, idx) {
    return observedTotals[idx] > 0 ? c / observedTotals[idx] : 0;
  });
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
