// demo/dashboard-data.js
// Data layer for the config-driven dashboard engine.
// Scans panels → builds Cube query → creates streaming worker → queries → returns results.
// Zero hardcoded field names — everything from config + cube registry.

import { getChartType } from './chart-types.js';

var crossfilter = globalThis.crossfilter;

// ── Infer reduce op from measure metadata ─────────────────────────────

function inferReduceOp(measureName, registry) {
  if (measureName === 'count') return 'count';
  var meta = registry.measures[measureName];
  if (!meta) return 'sum';
  var agg = meta.aggType;
  if (agg === 'count' || agg === 'countDistinct') return 'count';
  if (agg === 'avg') return 'avg';
  return 'sum';
}

// ── Scan resolved panels → collect fields needed by worker ────────────

function scanPanels(panels, registry) {
  var dims = new Set();
  var measures = new Set();
  var groups = [];
  var kpis = [];

  for (var i = 0; i < panels.length; ++i) {
    var panel = panels[i];
    var chartDef = getChartType(panel.chart);
    if (!chartDef) continue;

    var panelDimField = null;
    var panelMeasField = null;

    for (var s = 0; s < chartDef.slots.length; ++s) {
      var slot = chartDef.slots[s];
      var field = panel[slot.name];
      if (!field) continue;

      var fields = slot.array ? (Array.isArray(field) ? field : [field]) : [field];
      for (var f = 0; f < fields.length; ++f) {
        var fname = fields[f];
        if (slot.accepts === 'dimension') {
          dims.add(fname);
          if (!panelDimField) panelDimField = fname;
        } else if (slot.accepts === 'measure') {
          measures.add(fname);
          if (!panelMeasField) panelMeasField = fname;
        } else if (slot.accepts === 'any') {
          if (registry.dimensions[fname]) {
            dims.add(fname);
            if (!panelDimField) panelDimField = fname;
          } else {
            measures.add(fname);
            if (!panelMeasField) panelMeasField = fname;
          }
        }
      }
    }

    panel._dimField = panelDimField || panel.dimension || null;
    panel._measField = panelMeasField || panel.measure || null;

    var family = chartDef.family;
    if (panel._dimField && (family === 'category' || family === 'control')) {
      var measField = panel._measField;
      var op = measField ? inferReduceOp(measField, registry) : 'count';
      groups.push({
        id: panel.id,
        field: panel._dimField,
        metrics: [{ id: 'value', field: op === 'count' ? null : measField, op: op }],
      });
      panel._groupId = panel.id;
    }

    if (family === 'single' && panel._measField) {
      var kpiOp = inferReduceOp(panel._measField, registry);
      kpis.push({ id: panel.id, field: kpiOp === 'count' ? null : panel._measField, op: kpiOp });
      panel._kpiId = panel.id;
    }
  }

  measures.add('count');

  return { dims: dims, measures: measures, groups: groups, kpis: kpis };
}

// ── Build Cube.dev POST query body ────────────────────────────────────

function buildCubeQuery(cubeName, dims, measures, registry) {
  var partition = registry._cubeMeta.partition;
  var filters = [];
  if (partition) {
    filters.push({ member: cubeName + '.partition', operator: 'equals', values: [partition] });
  }

  return {
    format: 'arrow',
    query: {
      dimensions: Array.from(dims).map(function(d) { return cubeName + '.' + d; }),
      measures: Array.from(measures).map(function(m) { return cubeName + '.' + m; }),
      filters: filters,
      limit: 1000000,
    },
  };
}

// ── Build Arrow field rename + type transform projection ──────────────

function buildProjection(cubeName, dims, measures, registry) {
  var rename = {};
  var transforms = {};

  function addField(field) {
    rename[cubeName + '.' + field] = field;
    rename[cubeName + '__' + field] = field;
  }

  dims.forEach(function(d) { addField(d); });
  measures.forEach(function(m) { addField(m); });

  dims.forEach(function(d) {
    var meta = registry.dimensions[d];
    if (meta && (meta.type === 'number' || meta.type === 'boolean')) {
      transforms[d] = 'number';
    }
  });
  measures.forEach(function(m) {
    transforms[m] = 'number';
  });

  return { rename: rename, transforms: transforms };
}

// ── Convert engine filterState to typed crossfilter filters ───────────

function buildFilters(filterState, workerDimensions) {
  var filters = {};
  for (var dim in filterState) {
    if (workerDimensions.indexOf(dim) < 0) continue;
    var val = filterState[dim];
    if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'number') {
      filters[dim] = { type: 'range', range: val };
    } else {
      filters[dim] = { type: 'in', values: Array.isArray(val) ? val : [val] };
    }
  }
  return filters;
}

// ── Build per-panel group query parameters ────────────────────────────

function buildGroupQueries(panels) {
  var queries = {};
  for (var i = 0; i < panels.length; ++i) {
    var p = panels[i];
    if (!p._groupId) continue;
    queries[p._groupId] = {
      limit: p._expanded ? null : p.limit,
      sort: 'desc',
      sortMetric: 'value',
      includeTotals: true,
      visibleOnly: true,
    };
  }
  return queries;
}

// ── Merge worker responses into unified result ────────────────────────

function mergeResponses(responses) {
  var merged = { kpis: {}, groups: {} };
  for (var i = 0; i < responses.length; ++i) {
    var r = responses[i];
    if (!r || !r.snapshot) continue;
    var kpis = r.snapshot.kpis || {};
    for (var k in kpis) merged.kpis[k] = kpis[k];
    var groups = r.snapshot.groups || {};
    for (var g in groups) merged.groups[g] = groups[g];
  }
  return merged;
}

// ── Public API ────────────────────────────────────────────────────────

export async function createDashboardData(config, registry, resolvedPanels) {
  var cubeName = config.cube;
  var scanResult = scanPanels(resolvedPanels, registry);

  console.log('[dashboard-data] Scanned', resolvedPanels.length, 'panels →',
    scanResult.dims.size, 'dims,', scanResult.measures.size, 'measures,',
    scanResult.groups.length, 'groups,', scanResult.kpis.length, 'kpis');

  var cubeQuery = buildCubeQuery(cubeName, scanResult.dims, scanResult.measures, registry);
  var projection = buildProjection(cubeName, scanResult.dims, scanResult.measures, registry);

  var workerDims = Array.from(scanResult.dims);

  var workerHandle = await crossfilter.createStreamingDashboardWorker({
    crossfilterUrl: '/crossfilter.js',
    arrowRuntimeUrl: '/node_modules/apache-arrow/Arrow.es2015.min.js',
    batchCoalesceRows: 65536,
    wasm: true,
    emitSnapshots: false,
    progressThrottleMs: 100,
    dimensions: workerDims,
    groups: scanResult.groups,
    kpis: scanResult.kpis,
    sources: [{
      dataUrl: '/api/cube',
      id: cubeName,
      role: 'base',
      dataFetchInit: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cubeQuery),
      },
      projection: projection,
    }],
  });

  var listeners = { progress: [], ready: [], error: [] };

  workerHandle.on('progress', function(payload) {
    for (var i = 0; i < listeners.progress.length; ++i) listeners.progress[i](payload);
  });

  workerHandle.on('ready', function(payload) {
    for (var i = 0; i < listeners.ready.length; ++i) listeners.ready[i](payload);
  });

  workerHandle.on('error', function(payload) {
    for (var i = 0; i < listeners.error.length; ++i) listeners.error[i](payload);
  });

  return {
    ready: workerHandle.ready,

    on: function(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
    },

    query: function(filterState) {
      var filters = buildFilters(filterState || {}, workerDims);
      var groupQueries = buildGroupQueries(resolvedPanels);
      return workerHandle.query({
        filters: filters,
        snapshot: { groups: groupQueries },
      }).then(function(response) {
        return mergeResponses([response]);
      });
    },

    dispose: function() {
      return workerHandle.dispose();
    },
  };
}
