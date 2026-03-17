// demo-stockout/panels/helpers.js
//
// Shared helpers for all panels. Single source of truth for:
// - Color thresholds (Principle 9: consistent colors)
// - Score bars and badges (Principle 5: consistent terminology)
// - Formatters and abbr tags (Principle 5: abbr for short labels)
// - Columnar-to-rows conversion
//
// NOTE: Color thresholds here mirror Cube-defined tiers.
// When Cube adds explicit tier dimensions, replace these lookups
// with direct field display. (Principle 6: no business logic)

// ---- Color thresholds (must match across all panels) ----

export var COLORS = {
  green: '#00e68a',
  amber: '#ffb84d',
  orange: '#ff8c4d',
  red: '#ff4d6a',
  blue: '#4da6ff',
  muted: '#4a5a6e',
};

// Risk score tiers (from Cube risk_tier dimension)
export function riskColor(score) {
  if (score >= 0.75) return COLORS.red;
  if (score >= 0.5) return COLORS.orange;
  if (score >= 0.25) return COLORS.amber;
  return COLORS.green;
}

// Probability tiers
export function probColor(prob) {
  if (prob >= 0.7) return COLORS.red;
  if (prob >= 0.4) return COLORS.amber;
  return COLORS.green;
}

// Delta direction
export function deltaColor(ratio) {
  if (ratio > 1.2) return COLORS.red;
  if (ratio < 0.8) return COLORS.green;
  return COLORS.muted;
}

// ---- Score bar (unified inline bar for risk and probability) ----

export function scoreBar(value, type) {
  var pct = Math.round(value * 100);
  var color = type === 'prob' ? probColor(value) : riskColor(value);
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
  if (isNaN(r) || isNaN(o)) return '<span style="color:' + COLORS.muted + '">\u2014</span>';
  var ratio = o > 0 ? r / o : (r > 0 ? 2 : 1);
  var arrow, cls;
  if (ratio > 1.2) { arrow = '\u2191'; cls = 'delta-up'; }
  else if (ratio < 0.8) { arrow = '\u2193'; cls = 'delta-down'; }
  else { arrow = '\u2192'; cls = 'delta-flat'; }
  return '<span class="' + cls + '">' + arrow + ' ' + r.toFixed(1) + '</span>';
}

// ---- Badges ----

export function trendBadge(signal) {
  if (!signal) return '\u2014';
  var s = String(signal).toUpperCase();
  if (s.indexOf('WORSENING') >= 0) return '<span class="badge b-worsening">' + esc(signal) + '</span>';
  if (s === 'IMPROVING') return '<span class="badge b-improving">' + esc(signal) + '</span>';
  return '<span class="badge b-stable">' + esc(signal) + '</span>';
}

export function severityBadge(severity) {
  if (!severity) return '\u2014';
  var s = String(severity).toUpperCase();
  if (s === 'ESCALATING' || s === 'WORSENING') return '<span class="badge b-critical">' + esc(severity) + '</span>';
  if (s === 'IMPROVING') return '<span class="badge b-improving">' + esc(severity) + '</span>';
  return '<span class="badge b-stable">' + esc(severity) + '</span>';
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

export function fmtPct(v) {
  if (v == null || isNaN(v)) return '\u2014';
  return Math.round(Number(v) * 100) + '%';
}

// ---- Abbr-wrapped column header ----

export function th(label, title, opts) {
  var cls = opts && opts.sortable ? ' class="sortable"' : '';
  var sort = opts && opts.sortKey ? ' data-sort="' + opts.sortKey + '"' : '';
  var arrow = opts && opts.sortArrow || '';
  return '<th title="' + esc(title) + '"' + cls + sort + '>' + label + arrow + '</th>';
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
