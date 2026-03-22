// demo/chart-types.js
//
// Static registry of supported chart types, their variants, and data slot
// requirements. Used by the schema generator to constrain LLM output and
// by the engine to know how to wire data to ECharts options.
//
// Each entry defines:
//   type       — the compound type name (e.g. "bar", "bar.stacked")
//   ecType     — the ECharts series type (e.g. "bar", "line", "scatter")
//   family     — grouping for UI/docs (category, time, numeric, single, hierarchy, relation, specialized)
//   slots      — ordered data encoding slots, each with:
//                  name     — slot identifier (x, y, value, name, size, color, etc.)
//                  accepts  — what kind of field fills this slot: "dimension", "measure", or "any"
//                  required — whether the slot must be filled
//                  array    — if true, slot accepts multiple fields (e.g. hierarchy levels)
//   ecOptions  — static ECharts series options the engine sets for this variant

var CHART_TYPES = [

  // ── Category → Value ──────────────────────────────────────────────

  {
    type: 'bar',
    ecType: 'bar',
    family: 'category',
    slots: [
      { name: 'category', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'bar.horizontal',
    ecType: 'bar',
    family: 'category',
    slots: [
      { name: 'category', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { _horizontal: true },
  },
  {
    type: 'bar.stacked',
    ecType: 'bar',
    family: 'category',
    slots: [
      { name: 'category', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
      { name: 'stack', accepts: 'dimension', required: true },
    ],
    ecOptions: {},
  },
  {
    type: 'pie',
    ecType: 'pie',
    family: 'category',
    slots: [
      { name: 'name', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'pie.donut',
    ecType: 'pie',
    family: 'category',
    slots: [
      { name: 'name', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { radius: ['40%', '70%'] },
  },
  {
    type: 'pie.rose',
    ecType: 'pie',
    family: 'category',
    slots: [
      { name: 'name', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { roseType: 'radius' },
  },
  {
    type: 'bar.waterfall',
    ecType: 'bar',
    family: 'category',
    slots: [
      { name: 'category', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: true },
    ],
    ecOptions: { _waterfall: true },
  },
  {
    type: 'bar.normalized',
    ecType: 'bar',
    family: 'category',
    slots: [
      { name: 'category', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
      { name: 'stack', accepts: 'dimension', required: true },
    ],
    ecOptions: { _normalized: true },
  },
  {
    type: 'pie.half',
    ecType: 'pie',
    family: 'category',
    slots: [
      { name: 'name', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { startAngle: 180, endAngle: 360, radius: ['40%', '70%'] },
  },
  {
    type: 'pie.nested',
    ecType: 'pie',
    family: 'category',
    slots: [
      { name: 'name', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
      { name: 'innerName', accepts: 'dimension', required: true },
    ],
    ecOptions: { _nested: true },
  },
  {
    type: 'funnel',
    ecType: 'funnel',
    family: 'category',
    slots: [
      { name: 'name', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { sort: 'descending' },
  },
  {
    type: 'funnel.ascending',
    ecType: 'funnel',
    family: 'category',
    slots: [
      { name: 'name', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { sort: 'ascending' },
  },
  {
    type: 'pictorialBar',
    ecType: 'pictorialBar',
    family: 'category',
    slots: [
      { name: 'category', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },

  // ── Time / Sequence → Value ───────────────────────────────────────

  {
    type: 'line',
    ecType: 'line',
    family: 'time',
    slots: [
      { name: 'x', accepts: 'dimension', required: true },
      { name: 'y', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'line.smooth',
    ecType: 'line',
    family: 'time',
    slots: [
      { name: 'x', accepts: 'dimension', required: true },
      { name: 'y', accepts: 'measure', required: false },
    ],
    ecOptions: { smooth: true },
  },
  {
    type: 'line.step',
    ecType: 'line',
    family: 'time',
    slots: [
      { name: 'x', accepts: 'dimension', required: true },
      { name: 'y', accepts: 'measure', required: false },
    ],
    ecOptions: { step: 'middle' },
  },
  {
    type: 'line.area',
    ecType: 'line',
    family: 'time',
    slots: [
      { name: 'x', accepts: 'dimension', required: true },
      { name: 'y', accepts: 'measure', required: false },
    ],
    ecOptions: { areaStyle: {} },
  },
  {
    type: 'line.bump',
    ecType: 'line',
    family: 'time',
    slots: [
      { name: 'x', accepts: 'dimension', required: true },
      { name: 'y', accepts: 'measure', required: true },
      { name: 'stack', accepts: 'dimension', required: true },
    ],
    ecOptions: { smooth: true, _bump: true },
  },
  {
    type: 'line.area.stacked',
    ecType: 'line',
    family: 'time',
    slots: [
      { name: 'x', accepts: 'dimension', required: true },
      { name: 'y', accepts: 'measure', required: false },
      { name: 'stack', accepts: 'dimension', required: true },
    ],
    ecOptions: { areaStyle: {} },
  },
  {
    type: 'line.area.normalized',
    ecType: 'line',
    family: 'time',
    slots: [
      { name: 'x', accepts: 'dimension', required: true },
      { name: 'y', accepts: 'measure', required: false },
      { name: 'stack', accepts: 'dimension', required: true },
    ],
    ecOptions: { areaStyle: {}, _normalized: true },
  },

  // ── Two-Axis Numeric ──────────────────────────────────────────────

  {
    type: 'scatter',
    ecType: 'scatter',
    family: 'numeric',
    slots: [
      { name: 'x', accepts: 'any', required: true },
      { name: 'y', accepts: 'measure', required: true },
    ],
    ecOptions: {},
  },
  {
    type: 'scatter.bubble',
    ecType: 'scatter',
    family: 'numeric',
    slots: [
      { name: 'x', accepts: 'any', required: true },
      { name: 'y', accepts: 'measure', required: true },
      { name: 'size', accepts: 'measure', required: true },
      { name: 'color', accepts: 'dimension', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'scatter.effect',
    ecType: 'effectScatter',
    family: 'numeric',
    slots: [
      { name: 'x', accepts: 'any', required: true },
      { name: 'y', accepts: 'measure', required: true },
    ],
    ecOptions: { effectType: 'ripple' },
  },
  {
    type: 'heatmap',
    ecType: 'heatmap',
    family: 'numeric',
    slots: [
      { name: 'x', accepts: 'dimension', required: true },
      { name: 'y', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'heatmap.calendar',
    ecType: 'heatmap',
    family: 'numeric',
    slots: [
      { name: 'date', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { coordinateSystem: 'calendar' },
  },

  // ── Geographic ─────────────────────────────────────────────────────

  {
    type: 'map',
    ecType: 'map',
    family: 'geo',
    slots: [
      { name: 'region', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'map.scatter',
    ecType: 'scatter',
    family: 'geo',
    slots: [
      { name: 'lng', accepts: 'dimension', required: true },
      { name: 'lat', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
      { name: 'pointLabel', accepts: 'dimension', required: false },
    ],
    ecOptions: { coordinateSystem: 'geo' },
  },
  {
    type: 'map.bubble',
    ecType: 'scatter',
    family: 'geo',
    slots: [
      { name: 'lng', accepts: 'dimension', required: true },
      { name: 'lat', accepts: 'dimension', required: true },
      { name: 'size', accepts: 'measure', required: true },
      { name: 'color', accepts: 'dimension', required: false },
      { name: 'pointLabel', accepts: 'dimension', required: false },
    ],
    ecOptions: { coordinateSystem: 'geo' },
  },
  {
    type: 'map.heatmap',
    ecType: 'heatmap',
    family: 'geo',
    slots: [
      { name: 'lng', accepts: 'dimension', required: true },
      { name: 'lat', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { coordinateSystem: 'geo' },
  },
  {
    type: 'map.lines',
    ecType: 'lines',
    family: 'geo',
    slots: [
      { name: 'sourceLng', accepts: 'dimension', required: true },
      { name: 'sourceLat', accepts: 'dimension', required: true },
      { name: 'targetLng', accepts: 'dimension', required: true },
      { name: 'targetLat', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { coordinateSystem: 'geo' },
  },
  {
    type: 'map.effect',
    ecType: 'effectScatter',
    family: 'geo',
    slots: [
      { name: 'lng', accepts: 'dimension', required: true },
      { name: 'lat', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
      { name: 'pointLabel', accepts: 'dimension', required: false },
    ],
    ecOptions: { coordinateSystem: 'geo', effectType: 'ripple' },
  },

  // ── Single Value ──────────────────────────────────────────────────

  {
    type: 'gauge',
    ecType: 'gauge',
    family: 'single',
    slots: [
      { name: 'value', accepts: 'measure', required: true },
    ],
    ecOptions: {},
  },
  {
    type: 'gauge.progress',
    ecType: 'gauge',
    family: 'single',
    slots: [
      { name: 'value', accepts: 'measure', required: true },
    ],
    ecOptions: { progress: { show: true }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false } },
  },
  {
    type: 'gauge.ring',
    ecType: 'gauge',
    family: 'single',
    slots: [
      { name: 'value', accepts: 'measure', required: true },
    ],
    ecOptions: { startAngle: 90, endAngle: -270, progress: { show: true, width: 18 }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, pointer: { show: false } },
  },
  {
    type: 'kpi',
    ecType: null,
    family: 'single',
    slots: [
      { name: 'value', accepts: 'measure', required: true },
    ],
    ecOptions: null,
  },

  // ── Hierarchy ─────────────────────────────────────────────────────

  {
    type: 'treemap',
    ecType: 'treemap',
    family: 'hierarchy',
    slots: [
      { name: 'levels', accepts: 'dimension', required: true, array: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'sunburst',
    ecType: 'sunburst',
    family: 'hierarchy',
    slots: [
      { name: 'levels', accepts: 'dimension', required: true, array: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'tree',
    ecType: 'tree',
    family: 'hierarchy',
    slots: [
      { name: 'levels', accepts: 'dimension', required: true, array: true },
    ],
    ecOptions: { layout: 'orthogonal' },
  },
  {
    type: 'tree.radial',
    ecType: 'tree',
    family: 'hierarchy',
    slots: [
      { name: 'levels', accepts: 'dimension', required: true, array: true },
    ],
    ecOptions: { layout: 'radial' },
  },

  // ── Relational ────────────────────────────────────────────────────

  {
    type: 'sankey',
    ecType: 'sankey',
    family: 'relation',
    slots: [
      { name: 'source', accepts: 'dimension', required: true },
      { name: 'target', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: {},
  },
  {
    type: 'sankey.vertical',
    ecType: 'sankey',
    family: 'relation',
    slots: [
      { name: 'source', accepts: 'dimension', required: true },
      { name: 'target', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { orient: 'vertical' },
  },
  {
    type: 'graph',
    ecType: 'graph',
    family: 'relation',
    slots: [
      { name: 'source', accepts: 'dimension', required: true },
      { name: 'target', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { layout: 'force' },
  },
  {
    type: 'graph.circular',
    ecType: 'graph',
    family: 'relation',
    slots: [
      { name: 'source', accepts: 'dimension', required: true },
      { name: 'target', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { layout: 'circular' },
  },

  {
    type: 'chord',
    ecType: 'custom',
    family: 'relation',
    slots: [
      { name: 'source', accepts: 'dimension', required: true },
      { name: 'target', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: { _chord: true },
  },

  // ── Specialized ───────────────────────────────────────────────────

  {
    type: 'radar',
    ecType: 'radar',
    family: 'specialized',
    slots: [
      { name: 'axes', accepts: 'dimension', required: true, array: true },
      { name: 'values', accepts: 'measure', required: true, array: true },
    ],
    ecOptions: {},
  },
  {
    type: 'candlestick',
    ecType: 'candlestick',
    family: 'specialized',
    slots: [
      { name: 'date', accepts: 'dimension', required: true },
      { name: 'open', accepts: 'measure', required: true },
      { name: 'close', accepts: 'measure', required: true },
      { name: 'low', accepts: 'measure', required: true },
      { name: 'high', accepts: 'measure', required: true },
    ],
    ecOptions: {},
  },
  {
    type: 'candlestick.ohlc',
    ecType: 'custom',
    family: 'specialized',
    slots: [
      { name: 'date', accepts: 'dimension', required: true },
      { name: 'open', accepts: 'measure', required: true },
      { name: 'close', accepts: 'measure', required: true },
      { name: 'low', accepts: 'measure', required: true },
      { name: 'high', accepts: 'measure', required: true },
    ],
    ecOptions: { _ohlc: true },
  },
  {
    type: 'boxplot',
    ecType: 'boxplot',
    family: 'specialized',
    slots: [
      { name: 'category', accepts: 'dimension', required: true },
      { name: 'min', accepts: 'measure', required: true },
      { name: 'q1', accepts: 'measure', required: true },
      { name: 'median', accepts: 'measure', required: true },
      { name: 'q3', accepts: 'measure', required: true },
      { name: 'max', accepts: 'measure', required: true },
    ],
    ecOptions: {},
  },
  {
    type: 'themeRiver',
    ecType: 'themeRiver',
    family: 'specialized',
    slots: [
      { name: 'date', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
      { name: 'stream', accepts: 'dimension', required: true },
    ],
    ecOptions: {},
  },
  {
    type: 'parallel',
    ecType: 'parallel',
    family: 'specialized',
    slots: [
      { name: 'axes', accepts: 'any', required: true, array: true },
    ],
    ecOptions: {},
  },

  // ── Data panel (engine-native) ──────────────────────────────────────

  {
    type: 'table',
    ecType: null,
    family: 'tabular',
    slots: [
      { name: 'columns', accepts: 'any', required: true, array: true },
    ],
    ecOptions: null,
  },

  // ── Controls (engine-native, non-visual) ──────────────────────────
  // These are compact UI components for browsing/filtering dimensions.
  // No chart, no visualization — just the dimension values with
  // minimalistic indicators.
  //
  // NOTE: all chart panels (bar, pie, scatter, etc.) are also
  // click-to-filter capable. That is a universal engine behavior,
  // not a chart type. Controls below are for cases where you want
  // a dedicated filter UI without a chart.

  {
    type: 'selector',
    ecType: null,
    family: 'control',
    slots: [
      { name: 'dimension', accepts: 'dimension', required: true },
      { name: 'value', accepts: 'measure', required: false },
    ],
    ecOptions: null,
  },
  {
    type: 'toggle',
    ecType: null,
    family: 'control',
    slots: [
      { name: 'dimension', accepts: 'dimension', required: true },
    ],
    ecOptions: null,
  },
  {
    type: 'range',
    ecType: null,
    family: 'control',
    slots: [
      { name: 'dimension', accepts: 'dimension', required: true },
    ],
    ecOptions: null,
  },
  {
    type: 'dropdown',
    ecType: null,
    family: 'control',
    slots: [
      { name: 'dimension', accepts: 'dimension', required: true },
    ],
    ecOptions: null,
  },
];

// ── Cached lookups ──────────────────────────────────────────────────

var _byType = null;
var _byFamily = null;
var _typeNames = null;
var _ecTypes = null;

function ensureCache() {
  if (_byType) return;
  _byType = {};
  _byFamily = {};
  _typeNames = [];
  _ecTypes = [];
  for (var i = 0; i < CHART_TYPES.length; ++i) {
    var entry = CHART_TYPES[i];
    _byType[entry.type] = entry;
    _typeNames.push(entry.type);
    if (!_byFamily[entry.family]) _byFamily[entry.family] = [];
    _byFamily[entry.family].push(entry);
    if (entry.ecType && _ecTypes.indexOf(entry.ecType) < 0) {
      _ecTypes.push(entry.ecType);
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────

// Get a chart type definition by compound name (e.g. "scatter.bubble")
export function getChartType(typeName) {
  ensureCache();
  return _byType[typeName] || null;
}

// All registered compound type names (the enum for the schema)
export function allTypeNames() {
  ensureCache();
  return _typeNames.slice();
}

// All chart types in a family (e.g. "category", "time", "numeric")
export function typesByFamily(family) {
  ensureCache();
  return (_byFamily[family] || []).slice();
}

// All family names
export function allFamilies() {
  ensureCache();
  return Object.keys(_byFamily);
}

// All distinct ECharts series types used
export function allEcTypes() {
  ensureCache();
  return _ecTypes.slice();
}

// Get the required data slots for a chart type
export function requiredSlots(typeName) {
  var entry = getChartType(typeName);
  if (!entry) return [];
  return entry.slots.filter(function (s) { return s.required; });
}

// Get all data slots (required + optional) for a chart type
export function allSlots(typeName) {
  var entry = getChartType(typeName);
  if (!entry) return [];
  return entry.slots.slice();
}

// Validate that a set of field assignments satisfies a chart type's requirements.
// fieldMap: { slotName: fieldName | fieldName[] }
// Returns { valid: boolean, errors: string[] }
export function validateSlots(typeName, fieldMap) {
  var entry = getChartType(typeName);
  if (!entry) return { valid: false, errors: ['Unknown chart type: ' + typeName] };

  var errors = [];
  for (var i = 0; i < entry.slots.length; ++i) {
    var slot = entry.slots[i];
    var val = fieldMap[slot.name];
    if (slot.required && (val == null || val === '' || (Array.isArray(val) && val.length === 0))) {
      errors.push('Missing required slot "' + slot.name + '" for chart type "' + typeName + '"');
    }
    if (slot.array && val != null && !Array.isArray(val)) {
      errors.push('Slot "' + slot.name + '" expects an array for chart type "' + typeName + '"');
    }
  }
  return { valid: errors.length === 0, errors: errors };
}

// Build a JSON Schema enum constraint for chart types, optionally filtered by family
export function chartTypeEnum(family) {
  ensureCache();
  if (family) {
    return (_byFamily[family] || []).map(function (e) { return e.type; });
  }
  return _typeNames.slice();
}

// Full introspection: returns the entire registry as a plain array (for debugging/docs)
export function introspect() {
  return CHART_TYPES.slice();
}
