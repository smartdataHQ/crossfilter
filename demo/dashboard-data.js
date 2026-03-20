// demo/dashboard-data.js
// Data layer for the config-driven dashboard engine.
// Two-tier filtering:
//   Tier 1 (client, instant): crossfilter dims for bar/pie/selector click-to-filter
//   Tier 2 (server, reload):  Cube query.filters for toggles/ranges/segments/period/granularity
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

// ── Scan resolved panels → classify fields into tiers ─────────────────
//
// Group-by dims:      bar/pie/selector category fields → query.dimensions + worker dims
// Server filter dims: toggle/range fields → query.filters when active (NOT in query.dimensions)
// Time dims:          time-type fields → query.timeDimensions with granularity
// Measures:           KPI/gauge value fields → query.measures + worker KPIs

function scanPanels(panels, registry) {
  var groupByDims = new Set();
  var serverFilterDims = [];
  var timeDims = [];
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
          if (!panelDimField) panelDimField = fname;
        } else if (slot.accepts === 'measure') {
          measures.add(fname);
          if (!panelMeasField) panelMeasField = fname;
        } else if (slot.accepts === 'any') {
          if (registry.dimensions[fname]) {
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
    var chartType = panel.chart;

    // Classify the dimension field by panel type
    if (panel._dimField) {
      var dimMeta = registry.dimensions[panel._dimField];
      var isTime = dimMeta && dimMeta.type === 'time';

      if (isTime) {
        // Time dims → timeDimensions (not query.dimensions)
        timeDims.push(panel._dimField);
      } else if (chartType === 'toggle' || chartType === 'range') {
        // Toggle/range → server-side filter (not query.dimensions)
        serverFilterDims.push({ field: panel._dimField, chart: chartType });
      } else if (family === 'category' || family === 'control') {
        // Bar/pie/selector/dropdown → group-by dimension
        groupByDims.add(panel._dimField);

        var measField = panel._measField;
        var op = measField ? inferReduceOp(measField, registry) : 'count';
        groups.push({
          id: panel.id,
          field: panel._dimField,
          metrics: [{ id: 'value', field: op === 'count' ? null : measField, op: op }],
        });
        panel._groupId = panel.id;
      }
    }

    // KPI/gauge → groupAll reducer
    if (family === 'single' && panel._measField) {
      var kpiOp = inferReduceOp(panel._measField, registry);
      kpis.push({ id: panel.id, field: kpiOp === 'count' ? null : panel._measField, op: kpiOp });
      panel._kpiId = panel.id;
    }
  }

  measures.add('count');

  return {
    groupByDims: groupByDims,
    serverFilterDims: serverFilterDims,
    timeDims: timeDims,
    measures: measures,
    groups: groups,
    kpis: kpis,
  };
}

// ── Build Cube.dev POST query body ────────────────────────────────────
// query.dimensions = group-by dims only (determines result grain)
// query.filters = partition + active server-side filters
// query.timeDimensions = time dims with granularity + optional dateRange

function buildCubeQuery(cubeName, scanResult, registry, serverState) {
  serverState = serverState || {};

  var partition = registry._cubeMeta.partition;
  var filters = [];
  if (partition) {
    filters.push({ member: cubeName + '.partition', operator: 'equals', values: [partition] });
  }

  // Server-side filters from active toggles/ranges
  var activeFilters = serverState.filters || {};
  for (var dim in activeFilters) {
    var f = activeFilters[dim];
    if (!f) continue;
    if (Array.isArray(f)) {
      // Multiple filters on same dimension (e.g., range: gte + lte)
      for (var fi = 0; fi < f.length; ++fi) {
        filters.push({
          member: cubeName + '.' + dim,
          operator: f[fi].operator,
          values: f[fi].values,
        });
      }
    } else {
      filters.push({
        member: cubeName + '.' + dim,
        operator: f.operator || 'equals',
        values: f.values,
      });
    }
  }

  // Active segments
  var activeSegments = serverState.segments || [];
  for (var si = 0; si < activeSegments.length; ++si) {
    filters.push({
      member: cubeName + '.' + activeSegments[si],
      operator: 'equals',
      values: ['true'],
    });
  }

  // Time dimensions with granularity and optional date range
  var granularity = serverState.granularity ||
    (registry._cubeMeta.granularity && registry._cubeMeta.granularity.default) || 'week';
  var timeDimensions = [];
  for (var t = 0; t < scanResult.timeDims.length; ++t) {
    var td = { dimension: cubeName + '.' + scanResult.timeDims[t], granularity: granularity };
    if (serverState.dateRange) {
      td.dateRange = serverState.dateRange;
    }
    timeDimensions.push(td);
  }

  var queryDims = Array.from(scanResult.groupByDims).map(function(d) {
    return cubeName + '.' + d;
  });

  return {
    format: 'arrow',
    query: {
      dimensions: queryDims,
      measures: Array.from(scanResult.measures).map(function(m) { return cubeName + '.' + m; }),
      timeDimensions: timeDimensions,
      filters: filters,
      limit: 1000000,
    },
  };
}

// ── Build Arrow field rename + type transform projection ──────────────
// Only includes group-by dims + measures (server filter dims are not in the result)

function buildProjection(cubeName, scanResult, registry) {
  var rename = {};
  var transforms = {};

  function addField(field) {
    rename[cubeName + '.' + field] = field;
    rename[cubeName + '__' + field] = field;
  }

  scanResult.groupByDims.forEach(function(d) { addField(d); });
  // Time dims appear in Arrow result with granularity suffix — add both forms
  for (var t = 0; t < scanResult.timeDims.length; ++t) {
    addField(scanResult.timeDims[t]);
  }
  scanResult.measures.forEach(function(m) { addField(m); });

  scanResult.groupByDims.forEach(function(d) {
    var meta = registry.dimensions[d];
    if (meta && (meta.type === 'number' || meta.type === 'boolean')) {
      transforms[d] = 'number';
    }
  });
  scanResult.measures.forEach(function(m) {
    transforms[m] = 'number';
  });

  return { rename: rename, transforms: transforms };
}

// ── Convert engine filterState to typed crossfilter filters ───────────
// Only applies to group-by dims (client-side tier 1)

function buildClientFilters(filterState, workerDimensions) {
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

// ── Create streaming worker ───────────────────────────────────────────

function createWorker(cubeName, scanResult, registry, serverState) {
  var cubeQuery = buildCubeQuery(cubeName, scanResult, registry, serverState);
  var projection = buildProjection(cubeName, scanResult, registry);
  var workerDims = Array.from(scanResult.groupByDims);

  console.log('[dashboard-data] Cube query:', JSON.stringify(cubeQuery, null, 2));
  console.log('[dashboard-data] Worker dims:', workerDims.join(', '));
  console.log('[dashboard-data] Groups:', scanResult.groups.length, '| KPIs:', scanResult.kpis.length);

  return crossfilter.createStreamingDashboardWorker({
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
}

// ── Public API ────────────────────────────────────────────────────────

export async function createDashboardData(config, registry, resolvedPanels, serverState) {
  var cubeName = config.cube;
  var scanResult = scanPanels(resolvedPanels, registry);

  console.log('[dashboard-data] Scanned', resolvedPanels.length, 'panels →',
    scanResult.groupByDims.size, 'group-by dims,',
    scanResult.serverFilterDims.length, 'server filter dims,',
    scanResult.timeDims.length, 'time dims,',
    scanResult.measures.size, 'measures');

  var workerDims = Array.from(scanResult.groupByDims);
  var workerHandle = await createWorker(cubeName, scanResult, registry, serverState);

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

    // Tier 1: client-side query (instant, no server round-trip)
    query: function(filterState) {
      var filters = buildClientFilters(filterState || {}, workerDims);
      var groupQueries = buildGroupQueries(resolvedPanels);
      return workerHandle.query({
        filters: filters,
        snapshot: { groups: groupQueries },
      }).then(function(response) {
        return mergeResponses([response]);
      });
    },

    // Tier 2: server-side reload (new Cube query, new worker)
    // Returns a new data handle — caller should replace the old one.
    reload: function(newServerState) {
      workerHandle.dispose();
      return createDashboardData(config, registry, resolvedPanels, newServerState);
    },

    // Check if a dimension is server-side (not in the worker)
    isServerDim: function(dim) {
      return workerDims.indexOf(dim) < 0;
    },

    // Expose scan result for introspection
    serverFilterDims: scanResult.serverFilterDims,
    timeDims: scanResult.timeDims,

    dispose: function() {
      return workerHandle.dispose();
    },
  };
}
