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
    _cubeMeta: cube.meta || {},
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


// ── Cube Model Metadata Extraction ────────────────────────────────────
//
// The cube model can declare its data characteristics in `meta`:
//
//   meta:
//     grain: stay_event
//     grain_description: One row per car stay
//     time_dimension: stay_ended_at
//     time_zone: Atlantic/Reykjavik
//     partition: bluecar.is
//     period:
//       earliest: "2025-01-01"
//       latest: now                    # "now" resolves to today's date
//       typical_range: last_12_months  # used as default date picker range
//     refresh:
//       cadence: hourly
//       delay: ~30 minutes behind real-time
//       incremental_window: 7 days
//     granularity:
//       available: [hour, day, week, month, quarter, year]
//       default: week
//       notes: "explanation for users"
//
// The engine reads these from the cube-level meta (not dimension meta)
// to configure time pickers, granularity options, and refresh indicators.

// Extract cube-level model metadata (grain, period, granularity, refresh)
export function extractModelMeta(registry) {
  var cubeMeta = registry._cubeMeta || {};
  return {
    grain: cubeMeta.grain || null,
    grainDescription: cubeMeta.grain_description || null,
    timeDimension: cubeMeta.time_dimension || null,
    timeZone: cubeMeta.time_zone || null,
    partition: cubeMeta.partition || null,
    eventType: cubeMeta.event_type || null,
    period: cubeMeta.period || null,
    refresh: cubeMeta.refresh || null,
    granularity: cubeMeta.granularity || null,
  };
}

// Resolve the period range from model meta.
// Handles "now" as latest, and typical_range for default selection.
export function resolveModelPeriod(modelMeta) {
  var period = modelMeta && modelMeta.period;
  if (!period) return null;

  var earliest = period.earliest || null;
  var latest = period.latest;
  if (latest === 'now' || !latest) {
    latest = new Date().toISOString().slice(0, 10);
  }

  return {
    earliest: earliest,
    latest: latest,
    typicalRange: period.typical_range || null,
  };
}

// Resolve typical_range string to a from-date relative to latest.
// Supports: last_7_days, last_30_days, last_90_days, last_6_months,
//           last_12_months, year_to_date, all
export function resolveTypicalRange(typicalRange, earliest, latest) {
  if (!typicalRange || typicalRange === 'all') {
    return { from: earliest, to: latest };
  }
  var latestDate = new Date(latest);
  var match = typicalRange.match(/^last_(\d+)_(days|months|years)$/);
  if (match) {
    var n = parseInt(match[1]);
    var unit = match[2];
    var from = new Date(latestDate);
    if (unit === 'days') from.setUTCDate(from.getUTCDate() - n);
    else if (unit === 'months') from.setUTCMonth(from.getUTCMonth() - n);
    else if (unit === 'years') from.setUTCFullYear(from.getUTCFullYear() - n);
    var fromStr = from.toISOString().slice(0, 10);
    return { from: fromStr < earliest ? earliest : fromStr, to: latest };
  }
  if (typicalRange === 'year_to_date') {
    var ytd = new Date(Date.UTC(latestDate.getUTCFullYear(), 0, 1));
    return { from: ytd.toISOString().slice(0, 10), to: latest };
  }
  return { from: earliest, to: latest };
}

// Get granularity options from model meta, or fall back to Cube defaults.
export function getGranularityOptions(modelMeta) {
  var gran = modelMeta && modelMeta.granularity;
  if (gran && gran.available && gran.available.length > 0) {
    return gran.available;
  }
  // Cube.dev standard granularities as fallback
  return ['hour', 'day', 'week', 'month', 'quarter', 'year'];
}

// Get the default granularity from model meta, or pick a sensible one.
export function getDefaultGranularity(modelMeta) {
  var gran = modelMeta && modelMeta.granularity;
  if (gran && gran.default) return gran.default;
  return 'week';
}

// Get the granularity notes (explanation for the user)
export function getGranularityNotes(modelMeta) {
  var gran = modelMeta && modelMeta.granularity;
  return gran && gran.notes ? gran.notes : null;
}

// User-facing label for a granularity id
var GRAN_LABELS = {
  second: 'Second', minute: 'Minute', hour: 'Hourly',
  day: 'Daily', week: 'Weekly', month: 'Monthly',
  quarter: 'Quarterly', year: 'Yearly',
};

export function granularityLabel(id) {
  if (GRAN_LABELS[id]) return GRAN_LABELS[id];
  return id.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

// Generate smart period presets based on the data range
export function inferPeriodPresets(minDate, maxDate) {
  if (!minDate || !maxDate) return [];

  var max = new Date(maxDate);
  var min = new Date(minDate);
  var spanDays = (max.getTime() - min.getTime()) / 86400000;
  var presets = [];

  if (spanDays > 7) presets.push({ label: 'Last 7 days', days: 7 });
  if (spanDays > 30) presets.push({ label: 'Last 30 days', days: 30 });
  if (spanDays > 90) presets.push({ label: 'Last 90 days', days: 90 });
  if (spanDays > 180) {
    // Year to date
    var ytdStart = new Date(Date.UTC(max.getUTCFullYear(), 0, 1));
    presets.push({ label: 'Year to date', from: ytdStart.toISOString().slice(0, 10) });
  }
  if (spanDays > 365) presets.push({ label: 'Last 12 months', days: 365 });
  presets.push({ label: 'All time', from: null, to: null });

  return presets;
}

