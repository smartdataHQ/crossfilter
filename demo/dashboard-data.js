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
        // Time dims → timeDimensions in Cube query + crossfilter group for line/brush
        if (timeDims.indexOf(panel._dimField) < 0) timeDims.push(panel._dimField);
        // Also add as a worker dimension so crossfilter can filter on it (brush)
        groupByDims.add(panel._dimField);

        // Create a group for time-series panels (line, area, etc.)
        if (family === 'time') {
          var timeMeasField = panel._measField;
          var timeOp = timeMeasField ? inferReduceOp(timeMeasField, registry) : 'count';
          groups.push({
            id: panel.id,
            field: panel._dimField,
            metrics: [{ id: 'value', field: timeOp === 'count' ? null : timeMeasField, op: timeOp }],
          });
          panel._groupId = panel.id;
          panel._isTimeSeries = true;
        }
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

    // KPI/gauge → classify as local (crossfilter) or remote (Cube query)
    // count and sum can be reduced locally; countDistinct and computed need Cube
    if (family === 'single' && panel._measField) {
      var kpiMeta = registry.measures[panel._measField];
      var kpiAgg = kpiMeta ? kpiMeta.aggType : '';
      var isLocalReducible = (kpiAgg === 'count' || kpiAgg === 'sum' ||
        panel._measField === 'count');

      if (isLocalReducible) {
        var localOp = inferReduceOp(panel._measField, registry);
        kpis.push({
          id: panel.id, measure: panel._measField, local: true,
          op: localOp, field: localOp === 'count' ? null : panel._measField,
        });
      } else {
        kpis.push({ id: panel.id, measure: panel._measField, local: false });
      }
      panel._kpiId = panel.id;
      panel._kpiLocal = isLocalReducible;
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

  // Active segments — Cube.dev uses a dedicated segments array
  var activeSegments = serverState.segments || [];
  var querySegments = [];
  for (var si = 0; si < activeSegments.length; ++si) {
    querySegments.push(cubeName + '.' + activeSegments[si]);
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

  // Exclude time dims from query.dimensions — they're in timeDimensions
  var timeSet = new Set(scanResult.timeDims);
  var queryDims = Array.from(scanResult.groupByDims).filter(function(d) {
    return !timeSet.has(d);
  }).map(function(d) {
    return cubeName + '.' + d;
  });

  return {
    format: 'arrow',
    query: {
      dimensions: queryDims,
      measures: Array.from(scanResult.measures).map(function(m) { return cubeName + '.' + m; }),
      timeDimensions: timeDimensions,
      segments: querySegments.length ? querySegments : undefined,
      filters: filters,
      limit: 1000000,
    },
  };
}

// ── Build Arrow field rename + type transform projection ──────────────
// Only includes group-by dims + measures (server filter dims are not in the result)

function buildProjection(cubeName, scanResult, registry, serverState) {
  var rename = {};
  var transforms = {};
  var granularity = (serverState && serverState.granularity) ||
    (registry._cubeMeta.granularity && registry._cubeMeta.granularity.default) || 'week';

  function addField(field) {
    rename[cubeName + '.' + field] = field;
    rename[cubeName + '__' + field] = field;
  }

  scanResult.groupByDims.forEach(function(d) { addField(d); });
  // Time dims appear in Arrow result with granularity suffix.
  // From the x-synmetrix-arrow-field-mapping header:
  //   Arrow column: bluecar_stays__stay_started_at_week
  //   Maps to:      bluecar_stays.stay_started_at.week
  // So we need: cubeName__field_granularity → field (single underscore before granularity)
  // and:        cubeName.field.granularity → field (dot before granularity)
  for (var t = 0; t < scanResult.timeDims.length; ++t) {
    var td = scanResult.timeDims[t];
    addField(td);
    rename[cubeName + '.' + td + '.' + granularity] = td;
    rename[cubeName + '__' + td + '_' + granularity] = td;
  }
  scanResult.measures.forEach(function(m) { addField(m); });

  scanResult.groupByDims.forEach(function(d) {
    var meta = registry.dimensions[d];
    if (meta && meta.type === 'time') {
      transforms[d] = 'timestampMs';
    } else if (meta && (meta.type === 'number' || meta.type === 'boolean')) {
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
    // Time-series panels need all entries (no limit), sorted by key (time)
    if (p._isTimeSeries) {
      queries[p._groupId] = {
        limit: null,
        sort: 'natural',
        includeTotals: false,
        visibleOnly: false,
      };
    } else {
      queries[p._groupId] = {
        limit: p._expanded ? null : p.limit,
        sort: 'desc',
        sortMetric: 'value',
        includeTotals: true,
        visibleOnly: true,
      };
    }
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
  var projection = buildProjection(cubeName, scanResult, registry, serverState);
  var workerDims = Array.from(scanResult.groupByDims);

  console.log('[dashboard-data] Cube query:', JSON.stringify(cubeQuery, null, 2));
  console.log('[dashboard-data] Worker dims:', workerDims.join(', '));
  console.log('[dashboard-data] Groups:', scanResult.groups.length,
    '| KPIs (Cube query):', scanResult.kpis.length);

  return crossfilter.createStreamingDashboardWorker({
    crossfilterUrl: '/crossfilter.js',
    arrowRuntimeUrl: '/node_modules/apache-arrow/Arrow.es2015.min.js',
    batchCoalesceRows: 65536,
    wasm: true,
    emitSnapshots: false,
    progressThrottleMs: 100,
    dimensions: workerDims,
    groups: scanResult.groups,
    // Only local-reducible KPIs go into the worker (count, sum)
    kpis: scanResult.kpis.filter(function(k) { return k.local; }).map(function(k) {
      return { id: k.id, field: k.field, op: k.op };
    }),
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

// ── KPI direct Cube query (no crossfilter) ────────────────────────────
// KPIs with countDistinct, computed ratios, etc. can't be reduced
// client-side. Query Cube directly with no dimensions — returns one row.

function buildKpiCubeQuery(cubeName, kpiMeasures, scanResult, registry, serverState) {
  serverState = serverState || {};

  var partition = registry._cubeMeta.partition;
  var filters = [];
  if (partition) {
    filters.push({ member: cubeName + '.partition', operator: 'equals', values: [partition] });
  }

  // Server-side filters (same as main query)
  var activeFilters = serverState.filters || {};
  for (var dim in activeFilters) {
    var f = activeFilters[dim];
    if (!f) continue;
    if (Array.isArray(f)) {
      for (var fi = 0; fi < f.length; ++fi) {
        filters.push({ member: cubeName + '.' + dim, operator: f[fi].operator, values: f[fi].values });
      }
    } else {
      filters.push({ member: cubeName + '.' + dim, operator: f.operator || 'equals', values: f.values });
    }
  }

  // Segments
  var querySegments = [];
  var activeSegments = serverState.segments || [];
  for (var si = 0; si < activeSegments.length; ++si) {
    querySegments.push(cubeName + '.' + activeSegments[si]);
  }

  // Time dimensions — NO granularity for KPIs (we want one aggregated row, not per-bucket)
  // Only apply dateRange if set, to constrain the time window
  var timeDimensions = [];
  for (var t = 0; t < scanResult.timeDims.length; ++t) {
    var td = { dimension: cubeName + '.' + scanResult.timeDims[t] };
    if (serverState.dateRange) td.dateRange = serverState.dateRange;
    timeDimensions.push(td);
  }

  // Client-side filters also apply to KPIs (user clicked a bar → KPIs should reflect that)
  var timeSet = new Set(scanResult.timeDims);
  var clientFilters = serverState._clientFilters || {};
  for (var cdim in clientFilters) {
    var cv = clientFilters[cdim];
    if (!cv) continue;

    // Time dim filters → override timeDimensions dateRange (not a regular filter)
    if (timeSet.has(cdim)) {
      var tsVals = Array.isArray(cv) ? cv : [cv];
      // Convert timestamps to ISO dates for Cube dateRange
      var fromDate, toDate;
      if (tsVals.length === 2) {
        // Range: [startTs, endTs]
        fromDate = new Date(Number(tsVals[0])).toISOString().slice(0, 10);
        toDate = new Date(Number(tsVals[1])).toISOString().slice(0, 10);
      } else {
        // Single time-slice: from = bucket start, to = bucket start (Cube handles as inclusive)
        fromDate = new Date(Number(tsVals[0])).toISOString().slice(0, 10);
        toDate = fromDate;
      }
      // Apply to existing timeDimension or add new one
      var found = false;
      for (var tdi = 0; tdi < timeDimensions.length; ++tdi) {
        if (timeDimensions[tdi].dimension === cubeName + '.' + cdim) {
          timeDimensions[tdi].dateRange = [fromDate, toDate];
          found = true;
          break;
        }
      }
      if (!found) {
        timeDimensions.push({ dimension: cubeName + '.' + cdim, dateRange: [fromDate, toDate] });
      }
      continue;
    }

    var cvals = Array.isArray(cv) ? cv : [cv];
    filters.push({ member: cubeName + '.' + cdim, operator: 'equals', values: cvals.map(String) });
  }

  return {
    query: {
      measures: kpiMeasures.map(function(m) { return cubeName + '.' + m; }),
      timeDimensions: timeDimensions,
      segments: querySegments.length ? querySegments : undefined,
      filters: filters,
    },
  };
}

function fetchKpis(cubeName, kpis, scanResult, registry, serverState) {
  // Only query remote (non-local) KPIs — local ones come from crossfilter
  var remoteKpis = kpis.filter(function(k) { return !k.local; });
  if (!remoteKpis.length) return Promise.resolve({});

  // Multiple panels may use the same measure — collect all panel IDs per measure
  var kpiMeasures = [];
  var kpiIdsByMeasure = {};
  for (var i = 0; i < remoteKpis.length; ++i) {
    var meas = remoteKpis[i].measure;
    if (!kpiIdsByMeasure[meas]) {
      kpiIdsByMeasure[meas] = [];
      kpiMeasures.push(meas);
    }
    kpiIdsByMeasure[meas].push(remoteKpis[i].id);
  }

  var cubeQuery = buildKpiCubeQuery(cubeName, kpiMeasures, scanResult, registry, serverState);
  console.log('[dashboard-data] KPI query:', JSON.stringify(cubeQuery, null, 2));

  return fetch('/api/cube', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cubeQuery),
  }).then(function(res) {
    if (!res.ok) throw new Error('KPI query failed: ' + res.status);
    return res.json();
  }).then(function(json) {
    var row = json.data && json.data[0] ? json.data[0] : {};
    var result = {};
    for (var measure in kpiIdsByMeasure) {
      var fullName = cubeName + '.' + measure;
      var val = row[fullName];
      if (val != null) val = Number(val);
      // Assign to all panel IDs that use this measure
      var ids = kpiIdsByMeasure[measure];
      for (var j = 0; j < ids.length; ++j) result[ids[j]] = val;
    }
    console.log('[dashboard-data] KPI values:', JSON.stringify(result));
    return result;
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

    // KPI query: direct Cube REST call (no crossfilter)
    // clientFilters are included so KPIs reflect bar/pie click-to-filter state
    queryKpis: function(clientFilterState) {
      var ss = Object.assign({}, serverState || {});
      ss._clientFilters = clientFilterState || {};
      return fetchKpis(cubeName, scanResult.kpis, scanResult, registry, ss);
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

    // Dynamic group management for breakdown — no worker re-creation needed
    setBreakdown: function(breakdownDimField) {
      // Find the time-series panel and its current group
      var timePanel = null;
      var timeGroupSpec = null;
      for (var p = 0; p < resolvedPanels.length; ++p) {
        if (resolvedPanels[p]._isTimeSeries) { timePanel = resolvedPanels[p]; break; }
      }
      if (!timePanel) return Promise.resolve();

      for (var g = 0; g < scanResult.groups.length; ++g) {
        if (scanResult.groups[g].id === timePanel._groupId) {
          timeGroupSpec = scanResult.groups[g];
          break;
        }
      }
      if (!timeGroupSpec) return Promise.resolve();

      // Dispose the old time-series group
      var oldGroupId = timePanel._groupId;
      return workerHandle.disposeGroup(oldGroupId).then(function() {
        // Build new group spec with or without splitField
        var newSpec = {
          id: oldGroupId,
          field: timeGroupSpec.field,
          metrics: timeGroupSpec.metrics,
        };
        if (breakdownDimField) {
          newSpec.splitField = breakdownDimField;
        }
        // Update the stored spec for future reference
        timeGroupSpec.splitField = breakdownDimField || undefined;

        return workerHandle.createGroup(newSpec);
      });
    },

    dispose: function() {
      return workerHandle.dispose();
    },
  };
}
