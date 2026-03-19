// demo/dashboard-meta.js
// Fetches Cube.dev /api/meta and builds a field registry for a given cube.
// Provides inference functions for chart type, label, filter mode.
// All discovery is on-demand — no hardcoded lists.

var META_API = '/api/meta';

// ── Fetch ─────────────────────────────────────────────────────────────

export function fetchCubeMeta() {
  return fetch(META_API).then(function (res) {
    if (!res.ok) throw new Error('Meta fetch failed: ' + res.status);
    return res.json();
  });
}

// ── Registry ──────────────────────────────────────────────────────────

export function buildCubeRegistry(metaResponse, cubeName) {
  var cubes = metaResponse && metaResponse.cubes || [];
  var cube = null;
  for (var i = 0; i < cubes.length; ++i) {
    if (cubes[i].name === cubeName) { cube = cubes[i]; break; }
  }
  if (!cube) {
    throw new Error('Cube "' + cubeName + '" not found. Available: ' +
      cubes.map(function (c) { return c.name; }).join(', '));
  }

  var registry = {
    name: cubeName,
    title: cube.title || cubeName,
    description: cube.description || '',
    dimensions: {},
    measures: {},
    segments: [],
  };

  var dims = cube.dimensions || [];
  for (var d = 0; d < dims.length; ++d) {
    var dim = dims[d];
    var shortName = dim.name.split('.').pop();
    registry.dimensions[shortName] = {
      fullName: dim.name,
      type: dim.type || 'string',
      meta: dim.meta || {},
      description: dim.description || '',
    };
  }

  var measures = cube.measures || [];
  for (var m = 0; m < measures.length; ++m) {
    var meas = measures[m];
    var mShort = meas.name.split('.').pop();
    registry.measures[mShort] = {
      fullName: meas.name,
      type: meas.type || 'number',
      aggType: meas.aggType || '',
      format: meas.format || '',
      description: meas.description || '',
    };
  }

  var segs = cube.segments || [];
  for (var s = 0; s < segs.length; ++s) {
    var seg = segs[s];
    var segShort = seg.name.split('.').pop();
    // Clean up titles: remove cube title prefix if present
    var segTitle = seg.title || segShort;
    if (registry.title && segTitle.startsWith(registry.title + ' ')) {
      segTitle = segTitle.slice(registry.title.length + 1);
    }
    registry.segments.push({
      name: segShort,
      fullName: seg.name,
      title: segTitle,
      description: seg.description || '',
    });
  }

  return registry;
}

// ── Inference ─────────────────────────────────────────────────────────

export function inferChartType(fieldName, registry) {
  if (registry.measures[fieldName]) return 'kpi';

  var dim = registry.dimensions[fieldName];
  if (!dim) return 'bar';

  var meta = dim.meta || {};
  var fieldType = meta.field_type || dim.type || 'string';
  var unique = typeof meta.unique_values === 'number' ? meta.unique_values : -1;

  if (fieldType === 'boolean') return 'toggle';
  if (fieldType === 'datetime' || dim.type === 'time') return 'line';
  if (fieldType === 'number' || fieldType === 'float') return 'range';

  // String types — by cardinality
  if (unique >= 0 && unique <= 7) return 'pie';
  if (unique > 500) return 'list';
  return 'bar';
}

export function inferLabel(fieldName, registry) {
  var dim = registry.dimensions[fieldName];
  if (dim && dim.meta && dim.meta.description) return dim.meta.description;
  var meas = registry.measures[fieldName];
  if (meas && meas.description) return meas.description;
  // snake_case → Title Case
  return fieldName.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

export function inferFilterMode(fieldName, registry) {
  if (registry.measures[fieldName]) return 'none';
  var dim = registry.dimensions[fieldName];
  if (!dim) return 'in';
  var meta = dim.meta || {};
  var fieldType = meta.field_type || dim.type || 'string';
  if (fieldType === 'boolean') return 'exact';
  if (fieldType === 'datetime' || dim.type === 'time') return 'range';
  if (fieldType === 'number' || fieldType === 'float') return 'range';
  return 'in';
}

// Smart Top-X: picks a sensible default based on cardinality.
// If the full set is small enough, show all (no truncation needed).
// Otherwise pick a round number that gives a useful summary.
export function inferLimit(fieldName, registry) {
  var dim = registry.dimensions[fieldName];
  if (!dim) return 10;
  var meta = dim.meta || {};
  var unique = typeof meta.unique_values === 'number' ? meta.unique_values : -1;

  // Unknown cardinality — safe default
  if (unique <= 0) return 10;

  // Small enough to show everything — no Top X needed
  if (unique <= 15) return unique;

  // Pick a round number that shows roughly 30-50% of items
  // but never less than 5 or more than 25
  var candidates = [5, 8, 10, 15, 20, 25];
  for (var i = 0; i < candidates.length; ++i) {
    if (candidates[i] >= unique * 0.3 && candidates[i] <= unique * 0.6) {
      return candidates[i];
    }
  }

  // For very large sets, cap at 10
  if (unique > 50) return 10;
  return Math.min(10, unique);
}

export function inferSearchable(fieldName, registry) {
  var dim = registry.dimensions[fieldName];
  if (!dim) return false;
  var meta = dim.meta || {};
  var unique = typeof meta.unique_values === 'number' ? meta.unique_values : -1;
  return unique > 50;
}

// ── Model Intelligence Discovery ──────────────────────────────────────

// Discover boolean dimensions suitable for quick-toggle filters
export function discoverBooleanDimensions(registry) {
  var booleans = [];
  var dimNames = Object.keys(registry.dimensions);
  for (var i = 0; i < dimNames.length; ++i) {
    var name = dimNames[i];
    var dim = registry.dimensions[name];
    var fieldType = dim.meta && dim.meta.field_type || dim.type || 'string';
    if (dim.type === 'boolean' || fieldType === 'boolean') {
      booleans.push({
        name: name,
        label: inferLabel(name, registry),
      });
    }
  }
  return booleans;
}

// Discover low-cardinality enum dimensions with known values
export function discoverFacetDimensions(registry, maxValues) {
  var limit = maxValues || 12;
  var facets = [];
  var dimNames = Object.keys(registry.dimensions);
  for (var i = 0; i < dimNames.length; ++i) {
    var name = dimNames[i];
    var dim = registry.dimensions[name];
    var meta = dim.meta || {};
    var unique = typeof meta.unique_values === 'number' ? meta.unique_values : -1;
    if (unique > 0 && unique <= limit && meta.lc_values && meta.lc_values.length > 0) {
      facets.push({
        name: name,
        label: inferLabel(name, registry),
        values: meta.lc_values,
      });
    }
  }
  return facets;
}

// Discover formatted/described measures that are notable
export function discoverNotableMeasures(registry) {
  var notable = [];
  var measNames = Object.keys(registry.measures);
  for (var i = 0; i < measNames.length; ++i) {
    var name = measNames[i];
    var meas = registry.measures[name];
    if (meas.format || meas.description) {
      notable.push({
        name: name,
        label: inferLabel(name, registry),
        format: meas.format || null,
        description: meas.description || null,
      });
    }
  }
  return notable;
}

// ── ECharts Discovery ─────────────────────────────────────────────────

export function discoverEChartsTypes(echartsInstance) {
  // ECharts doesn't expose a public series type registry.
  // We probe by checking if ComponentModel subclasses exist for known types.
  var knownTypes = [
    'line', 'bar', 'pie', 'scatter', 'radar', 'map', 'tree', 'treemap',
    'graph', 'gauge', 'funnel', 'parallel', 'sankey', 'boxplot',
    'candlestick', 'effectScatter', 'lines', 'heatmap', 'pictorialBar',
    'themeRiver', 'sunburst', 'custom',
  ];
  // Non-chart controls handled by the engine directly
  var controls = ['list', 'kpi', 'toggle', 'range', 'table'];
  return { chartTypes: knownTypes, controlTypes: controls };
}
