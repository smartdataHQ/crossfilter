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
  var r = +recent;
  var o = +older;
  if (r !== r || o !== o) return '<span style="color:' + namedColor('muted') + '">\u2014</span>';
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
  if (v == null || v !== v) return '\u2014';
  return (+v).toFixed(1) + '<abbr title="days">d</abbr>';
}

export function fmtFreq(v) {
  if (v == null || v !== v) return '\u2014';
  return (+v).toFixed(1) + '<abbr title="per month">/mo</abbr>';
}

export function fmtDaysAgo(v) {
  if (v == null || v !== v) return '\u2014';
  return (+v) + '<abbr title="days ago">d ago</abbr>';
}

export function fmtISK(v) {
  if (v == null || v !== v) return '\u2014';
  v = +v;
  var abs = v < 0 ? -v : v;
  if (abs >= 1e6) return (v / 1e6).toFixed(1) + '<abbr title="million ISK">M</abbr>';
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + '<abbr title="thousand ISK">K</abbr>';
  return Math.round(v) + '';
}

// ---- Columnar utilities ----

export function getColumns(result) {
  if (!result || typeof result !== 'object') return { columns: {}, length: 0 };
  var cols = result.columns && typeof result.columns === 'object' ? result.columns : result;
  var keys = Object.keys(cols);
  if (!keys.length) return { columns: cols, length: 0 };
  var len = result.length != null ? result.length : 0;
  if (!len) {
    for (var k = 0; k < keys.length; ++k) {
      var arr = cols[keys[k]];
      if (Array.isArray(arr) || (arr && arr.length != null)) {
        len = arr.length;
        break;
      }
    }
  }
  return { columns: cols, length: len };
}

export function filterIndices(columns, length, predicate) {
  var out = new Array(length);
  var count = 0;
  for (var i = 0; i < length; ++i) {
    if (predicate(columns, i)) out[count++] = i;
  }
  out.length = count;
  return out;
}

export function sortIndices(indices, columns, field, direction) {
  var col = columns[field];
  if (!col || !indices.length) return indices;
  // Detect type from first non-null value
  var isStr = false;
  for (var s = 0; s < indices.length; ++s) {
    var sample = col[indices[s]];
    if (sample != null) { isStr = typeof sample === 'string'; break; }
  }
  if (isStr) {
    // Pre-compute lowercase keys to avoid N*log(N) toLowerCase calls
    var lower = new Array(col.length);
    for (var p = 0; p < indices.length; ++p) {
      var pi = indices[p];
      var pv = col[pi];
      lower[pi] = pv == null ? '' : String(pv).toLowerCase();
    }
    indices.sort(function (a, b) {
      var av = lower[a], bv = lower[b];
      if (av < bv) return -1 * direction;
      if (av > bv) return 1 * direction;
      return 0;
    });
  } else {
    // Pre-compute numeric keys to avoid N*log(N) Number() + isNaN calls
    var nums = new Float64Array(col.length);
    for (var q = 0; q < indices.length; ++q) {
      var qi = indices[q];
      var qv = +col[qi];
      nums[qi] = qv === qv ? qv : -Infinity;
    }
    indices.sort(function (a, b) {
      return (nums[a] - nums[b]) * direction;
    });
  }
  return indices;
}

export function materializeRows(columns, indices, fields) {
  var keys = fields || Object.keys(columns);
  var isRange = typeof indices === 'number';
  var len = isRange ? indices : indices.length;
  // Hoist column array references outside the row loop
  var colArrays = new Array(keys.length);
  for (var c = 0; c < keys.length; ++c) colArrays[c] = columns[keys[c]];
  var out = new Array(len);
  for (var i = 0; i < len; ++i) {
    var row = {};
    var idx = isRange ? i : indices[i];
    for (var k = 0; k < keys.length; ++k) {
      var ca = colArrays[k];
      row[keys[k]] = ca ? ca[idx] : undefined;
    }
    out[i] = row;
  }
  return out;
}

export function countByColumn(columns, indices, field) {
  var col = columns[field];
  if (!col) return {};
  var counts = {};
  for (var i = 0; i < indices.length; ++i) {
    var v = col[indices[i]];
    if (v != null && v !== '') counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

export function sumColumn(columns, indices, field) {
  var col = columns[field];
  if (!col) return 0;
  var sum = 0;
  for (var i = 0; i < indices.length; ++i) {
    var v = +col[indices[i]];
    if (v === v) sum += v; // v !== v only for NaN
  }
  return sum;
}

export function countsToOptions(counts) {
  var entries = [];
  for (var key in counts) entries.push({ name: key, count: counts[key] });
  entries.sort(function (a, b) { return b.count - a.count; });
  var html = '';
  for (var i = 0; i < entries.length; ++i) {
    var name = esc(entries[i].name);
    html += '<option value="' + name + '">' + name + ' (' + entries[i].count + ')</option>';
  }
  return html;
}

// ---- Columnar to rows (backward compat) ----

export function columnarToRows(result) {
  var data = getColumns(result);
  if (!data.length) return [];
  return materializeRows(data.columns, data.length);
}

// ---- Counted options for filter dropdowns ----

export function countedOptions(rows, field) {
  var counts = {};
  for (var i = 0; i < rows.length; ++i) {
    var v = rows[i][field];
    if (v) counts[v] = (counts[v] || 0) + 1;
  }
  return countsToOptions(counts);
}

// ---- Sortable table header ----

export function sortableHeader(columns, sortField, sortDir) {
  var html = '<thead><tr>';
  for (var c = 0; c < columns.length; ++c) {
    var col = columns[c];
    var arrow = sortField === col.key ? (sortDir < 0 ? ' \u25bc' : ' \u25b2') : '';
    html += '<th title="' + esc(col.title || '') + '" data-sort="' + col.key + '" class="sortable">' +
      col.label + arrow + '</th>';
  }
  return html + '</tr></thead>';
}

export function attachSortHandlers(el, callback) {
  var thead = el.querySelector('thead');
  if (thead) {
    thead.onclick = function (e) {
      var th = e.target.closest('th.sortable');
      if (th) callback(th.dataset.sort);
    };
  }
}

// ---- Escape HTML ----

var escRe = /[&<>]/g;
var escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

export function esc(v) {
  if (v == null) return '\u2014';
  return String(v).replace(escRe, function (ch) { return escMap[ch]; });
}

// ---- Active check (Uint8 / boolean / string) ----

export function isActive(v) {
  return v === 1 || v === true || v === 'true' || v === '1';
}
