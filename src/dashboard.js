function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function uniqueFields(values) {
  var seen = new Set(),
      result = [];

  for (var i = 0; i < values.length; ++i) {
    if (!values[i] || seen.has(values[i])) {
      continue;
    }
    seen.add(values[i]);
    result.push(values[i]);
  }

  return result;
}

var TIME_BUCKET_MS = {
  minute: 60000,
  hour: 3600000,
  day: 86400000
};

function normalizeMetrics(metrics, prefix) {
  var normalized = (metrics && metrics.length ? metrics : [{ op: "count" }]).map(function(metric, metricIndex) {
    var id = metric.id || prefix + "_" + metricIndex;
    if (metric.op !== "count" && !metric.field) {
      throw new Error("Dashboard metric `" + id + "` requires a field.");
    }
    if (metric.op !== "count" && metric.op !== "sum" && metric.op !== "avg" && metric.op !== "avgNonZero") {
      throw new Error("Unsupported dashboard metric op: " + metric.op);
    }

    return {
      field: metric.field,
      id: id,
      op: metric.op || "count"
    };
  });

  return normalized;
}

function normalizeTimeBucketValue(value) {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  var numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  var parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function bucketTimestampValue(value, granularity) {
  var numeric = normalizeTimeBucketValue(value);
  if (numeric == null) {
    return null;
  }

  if (granularity === "month") {
    var monthDate = new Date(numeric);
    return Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1);
  }

  if (granularity === "week") {
    var weekDate = new Date(numeric);
    var day = weekDate.getUTCDay();
    var monday = new Date(Date.UTC(
      weekDate.getUTCFullYear(),
      weekDate.getUTCMonth(),
      weekDate.getUTCDate() - ((day + 6) % 7)
    ));
    return monday.getTime();
  }

  var step = TIME_BUCKET_MS[granularity];
  if (!step) {
    throw new Error("Unsupported dashboard time bucket granularity: " + granularity);
  }

  return Math.floor(numeric / step) * step;
}

function resolveGroupAccessor(spec) {
  if (!spec || !spec.bucket) {
    return null;
  }

  if (spec.bucket.type !== "timeBucket") {
    throw new Error("Unsupported dashboard group bucket type: " + spec.bucket.type);
  }

  var granularity = spec.bucket.granularity || "day";
  return function(value) {
    return bucketTimestampValue(value, granularity);
  };
}

function buildMetricReducer(metrics) {
  function initial() {
    var state = {};

    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      if (metric.op === "avg" || metric.op === "avgNonZero") {
        state[metric.id] = { count: 0, sum: 0 };
      } else {
        state[metric.id] = 0;
      }
    }

    Object.defineProperties(state, {
      __cache: {
        configurable: true,
        enumerable: false,
        value: null,
        writable: true
      },
      __cacheVersion: {
        configurable: true,
        enumerable: false,
        value: -1,
        writable: true
      },
      __version: {
        configurable: true,
        enumerable: false,
        value: 0,
        writable: true
      }
    });

    return state;
  }

  function add(state, row) {
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value;

      switch (metric.op) {
        case "count":
          state[metric.id] += 1;
          break;
        case "sum":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            state[metric.id] += value;
          }
          break;
        case "avg":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            state[metric.id].sum += value;
            state[metric.id].count += 1;
          }
          break;
        case "avgNonZero":
          value = row[metric.field];
          if (isFiniteNumber(value) && value !== 0) {
            state[metric.id].sum += value;
            state[metric.id].count += 1;
          }
          break;
      }
    }

    state.__version += 1;
    return state;
  }

  function remove(state, row) {
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value;

      switch (metric.op) {
        case "count":
          state[metric.id] -= 1;
          break;
        case "sum":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            state[metric.id] -= value;
          }
          break;
        case "avg":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            state[metric.id].sum -= value;
            state[metric.id].count -= 1;
          }
          break;
        case "avgNonZero":
          value = row[metric.field];
          if (isFiniteNumber(value) && value !== 0) {
            state[metric.id].sum -= value;
            state[metric.id].count -= 1;
          }
          break;
      }
    }

    state.__version += 1;
    return state;
  }

  function finalize(state) {
    if (state.__cacheVersion === state.__version && state.__cache) {
      return state.__cache;
    }

    var result = {};

    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value = state[metric.id];

      if (metric.op === "avg" || metric.op === "avgNonZero") {
        result[metric.id] = value.count ? value.sum / value.count : null;
      } else {
        result[metric.id] = value;
      }
    }

    state.__cache = result;
    state.__cacheVersion = state.__version;
    return result;
  }

  return {
    add: add,
    finalize: finalize,
    initial: initial,
    remove: remove
  };
}

function normalizeFilter(filter) {
  if (!filter || filter.type === "all") {
    return null;
  }

  if (filter.type === "exact") {
    return {
      type: "exact",
      value: filter.value
    };
  }

  if (filter.type === "in") {
    return {
      type: "in",
      values: Array.isArray(filter.values) ? filter.values.slice() : []
    };
  }

  if (filter.type === "range") {
    return {
      range: Array.isArray(filter.range) ? filter.range.slice() : [],
      type: "range"
    };
  }

  throw new Error("Unsupported dashboard filter type: " + filter.type);
}

function normalizeFilterState(filters) {
  var normalized = {};

  if (!filters) {
    return normalized;
  }

  for (var field in filters) {
    normalized[field] = normalizeFilter(filters[field]);
  }

  return normalized;
}

function sameFilter(left, right) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return !left && !right;
  }
  if (left.type !== right.type) {
    return false;
  }

  if (left.type === "exact") {
    return left.value === right.value;
  }

  var leftValues = left.type === "range" ? left.range : left.values;
  var rightValues = right.type === "range" ? right.range : right.values;

  if (!leftValues || !rightValues || leftValues.length !== rightValues.length) {
    return false;
  }

  for (var valueIndex = 0; valueIndex < leftValues.length; ++valueIndex) {
    if (leftValues[valueIndex] !== rightValues[valueIndex]) {
      return false;
    }
  }

  return true;
}

function applyFilter(dimension, filter) {
  if (!filter) {
    dimension.filterAll();
    return;
  }

  switch (filter.type) {
    case "exact":
      dimension.filterExact(filter.value);
      return;
    case "in":
      dimension.filterIn(filter.values);
      return;
    case "range":
      dimension.filterRange(filter.range);
      return;
  }
}

function createKpiRuntime(cf, metrics) {
  var reducer = buildMetricReducer(metrics);
  var group = cf.groupAll().reduce(reducer.add, reducer.remove, reducer.initial);

  return {
    dispose: function() {
      group.dispose();
    },
    read: function() {
      return reducer.finalize(group.value());
    }
  };
}

function createGroupRuntime(dimension, spec, index) {
  var metrics = normalizeMetrics(spec.metrics, spec.id || "group_" + index);
  var reducer = buildMetricReducer(metrics);
  var groupAccessor = resolveGroupAccessor(spec);
  var group = groupAccessor ? dimension.group(groupAccessor) : dimension.group();
  group.reduce(reducer.add, reducer.remove, reducer.initial);

  return {
    dispose: function() {
      group.dispose();
    },
    id: spec.id || "group_" + index,
    read: function() {
      return group.all().map(function(entry) {
        return {
          key: entry.key,
          value: reducer.finalize(entry.value)
        };
      });
    }
  };
}

function createCrossfilterInstance(crossfilter, options) {
  if (options.table) {
    return crossfilter.fromArrowTable(options.table, options.columnarOptions);
  }
  if (options.columns) {
    return crossfilter.fromColumns(options.columns, options.columnarOptions);
  }
  return crossfilter(options.records || []);
}

function appendColumns(crossfilter, cf, columns, options) {
  cf.add(crossfilter.rowsFromColumns(columns || {}, options || {}));
  return cf.size();
}

function appendArrowTable(crossfilter, cf, table, options) {
  cf.add(crossfilter.rowsFromArrowTable(table, options || {}));
  return cf.size();
}

function normalizeRowQuery(query) {
  query = query || {};

  return {
    direction: query.direction === "bottom" ? "bottom" : "top",
    fields: Array.isArray(query.fields) && query.fields.length ? query.fields.slice() : null,
    limit: typeof query.limit === "number" && query.limit >= 0 ? Math.floor(query.limit) : 50,
    offset: typeof query.offset === "number" && query.offset >= 0 ? Math.floor(query.offset) : 0,
    sortBy: query.sortBy || null
  };
}

function projectRows(rows, fields) {
  if (!fields) {
    return rows.slice();
  }

  return rows.map(function(row) {
    var projected = {};
    for (var fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
      projected[fields[fieldIndex]] = row[fields[fieldIndex]];
    }
    return projected;
  });
}

function ensureDimension(dimensions, dimensionFields, cf, field) {
  if (!dimensions[field]) {
    dimensions[field] = cf.dimension(field);
    dimensionFields.push(field);
  }
  return dimensions[field];
}

export function createDashboardRuntime(crossfilter, options) {
  options = options || {};

  var sourceCount = (options.table ? 1 : 0) + (options.columns ? 1 : 0) + (options.records ? 1 : 0);
  if (sourceCount > 1) {
    throw new Error("createDashboardRuntime expects at most one of `table`, `columns` or `records`.");
  }

  var cf = createCrossfilterInstance(crossfilter, options);

  if (typeof cf.configureRuntime === "function") {
    cf.configureRuntime({ wasm: options.wasm !== false });
  } else {
    crossfilter.configureRuntime({ wasm: options.wasm !== false });
  }

  var groupSpecs = options.groups || [];
  var dimensionFields = uniqueFields((options.dimensions || []).concat(groupSpecs.map(function(group) {
    return group.field;
  })));
  var dimensions = {};
  var currentFilters = {};
  var groupRuntimes = {};
  var kpiRuntime = createKpiRuntime(cf, normalizeMetrics(options.kpis, "kpi"));

  for (var fieldIndex = 0; fieldIndex < dimensionFields.length; ++fieldIndex) {
    dimensions[dimensionFields[fieldIndex]] = cf.dimension(dimensionFields[fieldIndex]);
  }

  for (var groupIndex = 0; groupIndex < groupSpecs.length; ++groupIndex) {
    var groupSpec = groupSpecs[groupIndex];
    var groupDimension = ensureDimension(dimensions, dimensionFields, cf, groupSpec.field);
    var groupRuntime = createGroupRuntime(groupDimension, groupSpec, groupIndex);
    groupRuntimes[groupRuntime.id] = groupRuntime;
  }

  function updateFilters(filters) {
    var nextFilters = normalizeFilterState(filters);
    var seen = new Set();

    for (var field in nextFilters) {
      if (!dimensions[field]) {
        throw new Error("Unknown dashboard filter dimension: " + field);
      }
      seen.add(field);
      if (!sameFilter(currentFilters[field], nextFilters[field])) {
        applyFilter(dimensions[field], nextFilters[field]);
      }
    }

    for (field in currentFilters) {
      if (seen.has(field)) {
        continue;
      }
      if (dimensions[field]) {
        dimensions[field].filterAll();
      }
    }

    currentFilters = nextFilters;
    return typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo();
  }

  function readSnapshot() {
    var groups = {};

    for (var groupId in groupRuntimes) {
      groups[groupId] = groupRuntimes[groupId].read();
    }

    return {
      groups: groups,
      kpis: kpiRuntime.read(),
      runtime: typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo()
    };
  }

  function readRows(query) {
    var normalized = normalizeRowQuery(query);
    var rows;

    if (normalized.sortBy) {
      var dimension = ensureDimension(dimensions, dimensionFields, cf, normalized.sortBy);
      rows = normalized.direction === "bottom"
        ? dimension.bottom(normalized.limit, normalized.offset)
        : dimension.top(normalized.limit, normalized.offset);
    } else {
      var allRows = typeof cf.allFiltered === "function" ? cf.allFiltered() : cf.all();
      rows = allRows.slice(normalized.offset, normalized.offset + normalized.limit);
    }

    return projectRows(rows, normalized.fields);
  }

  function queryRuntime(request) {
    request = request || {};
    if (request.filters) {
      updateFilters(request.filters);
    }

    return {
      rows: request.rows ? readRows(request.rows) : [],
      snapshot: readSnapshot()
    };
  }

  function removeFiltered(selection) {
    if (selection === "excluded") {
      cf.remove(function(_, index) {
        return typeof cf.isElementFiltered === "function" ? !cf.isElementFiltered(index) : false;
      });
    } else {
      cf.remove();
    }
    return cf.size();
  }

  return {
    append: function(records) {
      cf.add(records || []);
      return cf.size();
    },
    appendArrowTable: function(table, columnarOptions) {
      return appendArrowTable(crossfilter, cf, table, columnarOptions);
    },
    appendColumns: function(columns, columnarOptions) {
      return appendColumns(crossfilter, cf, columns, columnarOptions);
    },
    dispose: function() {
      this.reset();
      for (var groupId in groupRuntimes) {
        groupRuntimes[groupId].dispose();
      }
      kpiRuntime.dispose();
      for (var dimensionIndex = 0; dimensionIndex < dimensionFields.length; ++dimensionIndex) {
        dimensions[dimensionFields[dimensionIndex]].dispose();
      }
    },
    query: function(request) {
      return queryRuntime(request);
    },
    removeFiltered: function(selection) {
      return removeFiltered(selection);
    },
    reset: function() {
      return updateFilters({});
    },
    rows: function(query) {
      return readRows(query);
    },
    runtimeInfo: function() {
      return typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo();
    },
    size: function() {
      return cf.size();
    },
    snapshot: function(filters) {
      if (filters) {
        updateFilters(filters);
      }
      return readSnapshot();
    },
    updateFilters: updateFilters
  };
}
