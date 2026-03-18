// demo-stockout/config.js
//
// Dashboard config layer (Principle 6).
// Reads color_scale and color_map from Cube /api/meta.
// Provides colorFor(fieldName, value) for all panels.
// Falls back to named color defaults if meta isn't loaded yet.

var NAMED_COLORS = {
  red: '#ff4d6a',
  orange: '#ff8c4d',
  amber: '#ffb84d',
  green: '#00e68a',
  blue: '#4da6ff',
  purple: '#b366ff',
  muted: '#4a5a6e',
};

// Loaded from /api/meta — keyed by short field name
var fieldMeta = {};
var colorCache = {};

// Load meta from Cube API and extract color rules
export function loadMeta(metaResponse) {
  if (!metaResponse || !metaResponse.cubes) return;
  colorCache = {};
  for (var i = 0; i < metaResponse.cubes.length; ++i) {
    var cube = metaResponse.cubes[i];
    var dims = cube.dimensions || [];
    for (var j = 0; j < dims.length; ++j) {
      var dim = dims[j];
      if (!dim.meta) continue;
      var shortName = dim.name.split('.').pop();
      fieldMeta[shortName] = dim.meta;
    }
  }
}

// Get the color for a field value using meta rules (memoized)
export function colorFor(field, value) {
  var key = field + '\0' + value;
  if (key in colorCache) return colorCache[key];
  var result = _colorForUncached(field, value);
  colorCache[key] = result;
  return result;
}

function _colorForUncached(field, value) {
  var meta = fieldMeta[field];
  if (!meta) return NAMED_COLORS.muted;

  // color_map: exact string match (for categorical fields)
  if (meta.color_map) {
    var mapped = meta.color_map[value] || meta.color_map['default'];
    return mapped ? (NAMED_COLORS[mapped] || mapped) : NAMED_COLORS.muted;
  }

  // color_scale: threshold match (for numeric fields)
  if (meta.color_scale) {
    var num = Number(value);
    if (isNaN(num)) return NAMED_COLORS.muted;
    for (var k = 0; k < meta.color_scale.length; ++k) {
      var rule = meta.color_scale[k];
      if (rule.default) return NAMED_COLORS[rule.color] || rule.color;
      if (rule.gte != null && num >= rule.gte) return NAMED_COLORS[rule.color] || rule.color;
    }
    return NAMED_COLORS.muted;
  }

  return NAMED_COLORS.muted;
}

// Get the named color constant
export function namedColor(name) {
  return NAMED_COLORS[name] || name;
}

// Check if meta is loaded for a field
export function hasMeta(field) {
  return !!fieldMeta[field];
}

export { NAMED_COLORS };
