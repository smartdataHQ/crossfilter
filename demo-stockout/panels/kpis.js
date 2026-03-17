// demo-stockout/panels/kpis.js

import { esc } from './helpers.js';

export function renderKpis(storeSnapshot, endedYesterdayData, startedYesterdayData) {
  var el = document.getElementById('kpi-row');
  if (!el) return;

  var kpis = storeSnapshot ? storeSnapshot.kpis : {};
  var active = kpis.totalActive != null ? kpis.totalActive : 0;
  var endedCount = endedYesterdayData ? endedYesterdayData.length : 0;
  var startedCount = startedYesterdayData ? startedYesterdayData.length : 0;

  var lostSalesYesterday = 0;
  if (endedYesterdayData) {
    for (var i = 0; i < endedYesterdayData.length; ++i) {
      lostSalesYesterday += endedYesterdayData[i].lostSales || 0;
    }
  }

  var endedCountEl = document.getElementById('ended-count');
  if (endedCountEl) endedCountEl.textContent = endedCount + ' products';

  el.innerHTML = [
    kpiCard('Active Stockouts', fmtCount(active), active > 0 ? 'kpi-red' : 'kpi-green', null, active > 0 ? 'v-red' : 'v-green'),
    kpiCard('Ended Yesterday', fmtCount(endedCount), endedCount > 0 ? 'kpi-green' : '', null, endedCount > 0 ? 'v-green' : ''),
    kpiCard('Started Yesterday', fmtCount(startedCount), startedCount > 0 ? 'kpi-red' : 'kpi-green', null, startedCount > 0 ? 'v-red' : 'v-green'),
    kpiCard('Lost Sales Yesterday', fmtISK(lostSalesYesterday), 'kpi-amber', null, 'v-amber'),
  ].join('');
}

function kpiCard(label, value, cardClass, sub, valueClass) {
  return '<div class="kpi ' + (cardClass || '') + '">' +
    '<div class="kpi-label">' + label + '</div>' +
    '<div class="kpi-value ' + (valueClass || '') + '">' + value + '</div>' +
    (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') +
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
