// demo-stockout/panels/helpers.js
//
// Shared helpers for all panels.
// Colors come from config.js which reads Cube meta (Principle 6).

import { colorFor, namedColor } from '../config.js';

// ---- Score bar (unified for risk_score and forecast probability) ----

export function scoreBar(value, field) {
  var pct = Math.round(value * 100);
  var color = colorFor(field, value);
  return '<div style="display:flex;align-items:center;gap:4px;min-width:80px">' +
    '<div style="flex:1;height:4px;background:#1e2a3a;border-radius:2px;overflow:hidden">' +
    '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:2px"></div>' +
    '</div>' +
    '<span style="font-size:10px;color:' + color + ';font-weight:600;min-width:28px">' + pct + '%</span>' +
    '</div>';
}

// ---- Delta cell (recent vs older half comparison) ----

export function deltaCell(recent, older) {
  var r = Number(recent);
  var o = Number(older);
  if (isNaN(r) || isNaN(o)) return '<span style="color:' + namedColor('muted') + '">\u2014</span>';
  var ratio = o > 0 ? r / o : (r > 0 ? 2 : 1);
  var arrow, cls;
  if (ratio > 1.2) { arrow = '\u2191'; cls = 'delta-up'; }
  else if (ratio < 0.8) { arrow = '\u2193'; cls = 'delta-down'; }
  else { arrow = '\u2192'; cls = 'delta-flat'; }
  return '<span class="' + cls + '">' + arrow + ' ' + r.toFixed(1) + '</span>';
}

// ---- Badges (use Cube meta for colors) ----

export function fieldBadge(field, value) {
  if (!value) return '\u2014';
  var color = colorFor(field, value);
  var dimColor = color + '22';
  return '<span class="badge" style="background:' + dimColor + ';color:' + color + '">' + esc(value) + '</span>';
}

// ---- Formatters with abbr tags ----

export function fmtDur(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1) + '<abbr title="days">d</abbr>';
}

export function fmtFreq(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v).toFixed(1) + '<abbr title="per month">/mo</abbr>';
}

export function fmtDaysAgo(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Number(v) + '<abbr title="days ago">d ago</abbr>';
}

export function fmtISK(v) {
  if (v == null || isNaN(v)) return '\u2014';
  v = Number(v);
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + '<abbr title="million ISK">M</abbr>';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + '<abbr title="thousand ISK">K</abbr>';
  return Math.round(v) + '';
}

// ---- Columnar to rows ----

export function columnarToRows(result) {
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

// ---- Counted options for filter dropdowns ----

export function countedOptions(rows, field) {
  var counts = {};
  for (var i = 0; i < rows.length; ++i) {
    var v = rows[i][field];
    if (v) counts[v] = (counts[v] || 0) + 1;
  }
  var entries = [];
  for (var key in counts) entries.push({ name: key, count: counts[key] });
  entries.sort(function (a, b) { return b.count - a.count; });
  return entries.map(function (e) {
    return '<option value="' + esc(e.name) + '">' + esc(e.name) + ' (' + e.count + ')</option>';
  }).join('');
}

// ---- Escape HTML ----

export function esc(v) {
  if (v == null) return '\u2014';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Active check (Uint8 / boolean / string) ----

export function isActive(v) {
  return v === 1 || v === true || v === 'true' || v === '1';
}
