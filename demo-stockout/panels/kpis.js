// demo-stockout/panels/kpis.js
//
// Principle 11: Every KPI has a trend indicator vs previous period.

import { esc } from './helpers.js';
import { namedColor } from '../config.js';

export function renderKpis(storeSnapshot, ended, started, endedPrev, startedPrev) {
  var el = document.getElementById('kpi-row');
  if (!el) return;

  var kpis = storeSnapshot ? storeSnapshot.kpis : {};
  var active = kpis.totalActive != null ? kpis.totalActive : 0;
  var endedCount = ended ? ended.length : 0;
  var startedCount = started ? started.length : 0;
  var endedPrevCount = endedPrev ? endedPrev.length : 0;
  var startedPrevCount = startedPrev ? startedPrev.length : 0;

  var lostYesterday = sumField(ended, 'lostSales');
  var lostDayBefore = sumField(endedPrev, 'lostSales');

  var endedCountEl = document.getElementById('ended-count');
  if (endedCountEl) endedCountEl.textContent = endedCount + ' products';

  el.innerHTML = [
    kpiCard('Active Stockouts', fmtCount(active),
      active > 0 ? 'kpi-red' : 'kpi-green',
      null, // no previous-period active count available without time-travel query
      active > 0 ? 'v-red' : 'v-green'),
    kpiCard('Ended Yesterday', fmtCount(endedCount),
      endedCount > 0 ? 'kpi-green' : '',
      trendIndicator(endedCount, endedPrevCount, true),
      endedCount > 0 ? 'v-green' : ''),
    kpiCard('Started Yesterday', fmtCount(startedCount),
      startedCount > 0 ? 'kpi-red' : 'kpi-green',
      trendIndicator(startedCount, startedPrevCount, false),
      startedCount > 0 ? 'v-red' : 'v-green'),
    kpiCard('Lost Sales Yesterday', fmtISK(lostYesterday),
      'kpi-amber',
      trendIndicator(lostYesterday, lostDayBefore, false),
      'v-amber'),
  ].join('');
}

// Trend indicator: compare current to previous period.
// invertGood=true means higher is better (more ended = good).
// invertGood=false means lower is better (fewer started = good).
function trendIndicator(current, previous, invertGood) {
  if (previous == null || isNaN(previous)) return '';
  var diff = current - previous;
  if (diff === 0) return '<span class="kpi-trend" style="color:' + namedColor('muted') + '">\u2192 same as day before</span>';

  var isUp = diff > 0;
  var isGood = invertGood ? isUp : !isUp;
  var color = isGood ? namedColor('green') : namedColor('red');
  var arrow = isUp ? '\u2191' : '\u2193';
  var absDiff = Math.abs(diff);
  var label = absDiff >= 1000 ? (absDiff / 1000).toFixed(1) + 'K' : Math.round(absDiff);

  return '<span class="kpi-trend" style="color:' + color + '">' +
    arrow + ' ' + label + ' vs day before</span>';
}

function sumField(arr, field) {
  if (!arr) return 0;
  var sum = 0;
  for (var i = 0; i < arr.length; ++i) sum += arr[i][field] || 0;
  return sum;
}

function kpiCard(label, value, cardClass, trend, valueClass) {
  return '<div class="kpi ' + (cardClass || '') + '">' +
    '<div class="kpi-label">' + label + '</div>' +
    '<div class="kpi-value ' + (valueClass || '') + '">' + value + '</div>' +
    (trend ? '<div class="kpi-sub">' + trend + '</div>' : '') +
    '</div>';
}

function fmtISK(v) {
  if (v == null || isNaN(v)) return '\u2014';
  v = Number(v);
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B <abbr title="Icelandic Krona">ISK</abbr>';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M <abbr title="Icelandic Krona">ISK</abbr>';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K <abbr title="Icelandic Krona">ISK</abbr>';
  return Math.round(v) + ' <abbr title="Icelandic Krona">ISK</abbr>';
}

function fmtCount(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Math.round(v).toLocaleString();
}
