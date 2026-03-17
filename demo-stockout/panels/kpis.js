// demo-stockout/panels/kpis.js

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

  // Update ended count badge
  var endedCountEl = document.getElementById('ended-count');
  if (endedCountEl) endedCountEl.textContent = endedCount + ' products';

  el.innerHTML = [
    kpiCard('Active Stockouts', formatCount(active), active > 0 ? 'kpi-red' : 'kpi-green', null, active > 0 ? 'v-red' : 'v-green'),
    kpiCard('Ended Yesterday', formatCount(endedCount), endedCount > 0 ? 'kpi-green' : '', null, endedCount > 0 ? 'v-green' : ''),
    kpiCard('Started Yesterday', formatCount(startedCount), startedCount > 0 ? 'kpi-red' : 'kpi-green', null, startedCount > 0 ? 'v-red' : 'v-green'),
    kpiCard('Lost Sales Yesterday', formatISK(lostSalesYesterday), 'kpi-amber', null, 'v-amber'),
  ].join('');
}

function kpiCard(label, value, cardClass, sub, valueClass) {
  return '<div class="kpi ' + (cardClass || '') + '">' +
    '<div class="kpi-label">' + label + '</div>' +
    '<div class="kpi-value ' + (valueClass || '') + '">' + value + '</div>' +
    (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') +
    '</div>';
}

function formatISK(v) {
  if (v == null || isNaN(v)) return '\u2014';
  v = Number(v);
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B ISK';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M ISK';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K ISK';
  return Math.round(v) + ' ISK';
}

function formatCount(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Math.round(v).toLocaleString();
}
