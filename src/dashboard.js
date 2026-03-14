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
  var metricSpec = metrics.map(function(metric) {
    return {
      field: metric.field || null,
      id: metric.id,
      op: metric.op
    };
  });

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

  add._xfilterMetricSpec = metricSpec;
  remove._xfilterMetricSpec = metricSpec;
  initial._xfilterMetricSpec = metricSpec;

  return {
    add: add,
    finalize: finalize,
    initial: initial,
    remove: remove
  };
}

function getNativeSumMetric(metrics) {
  return metrics && metrics.length === 1 && metrics[0].op === "sum"
    ? metrics[0]
    : null;
}

function createNativeSumAccessor(metric) {
  return function(row) {
    var value = row[metric.field];
    return isFiniteNumber(value) ? value : 0;
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

function normalizeGroupQuery(query) {
  if (query == null || query === true) {
    return null;
  }
  if (query === false) {
    return false;
  }

  return {
    includeKeys: Array.isArray(query.includeKeys) && query.includeKeys.length ? query.includeKeys.slice() : null,
    includeTotals: query.includeTotals !== false,
    keys: Array.isArray(query.keys) && query.keys.length ? query.keys.slice() : null,
    limit: typeof query.limit === "number" && query.limit >= 0 ? Math.floor(query.limit) : null,
    nonEmptyKeys: query.nonEmptyKeys === true,
    offset: typeof query.offset === "number" && query.offset >= 0 ? Math.floor(query.offset) : 0,
    search: typeof query.search === "string" && query.search ? query.search.toLowerCase() : null,
    sort: query.sort === "asc" || query.sort === "natural" ? query.sort : "desc",
    sortMetric: query.sortMetric || null,
    visibleOnly: query.visibleOnly !== false
  };
}

function metricComparableValue(metric, value) {
  if (!metric) {
    return 0;
  }

  if (metric.op === "avg" || metric.op === "avgNonZero") {
    return value && value.count ? value.sum / value.count : null;
  }

  return typeof value === "number" ? value : 0;
}

function metricHasVisibleValue(metric, value) {
  var comparable = metricComparableValue(metric, value);
  return comparable != null && comparable > 0;
}

function compareGroupKeys(left, right) {
  if (left === right) {
    return 0;
  }
  return String(left).localeCompare(String(right));
}

function insertSortedEntry(entries, entry, compare, maxSize) {
  var insertIndex = entries.length;

  if (maxSize != null && entries.length >= maxSize && compare(entry, entries[entries.length - 1]) >= 0) {
    return;
  }

  while (insertIndex > 0 && compare(entry, entries[insertIndex - 1]) < 0) {
    insertIndex -= 1;
  }

  entries.splice(insertIndex, 0, entry);
  if (maxSize != null && entries.length > maxSize) {
    entries.pop();
  }
}

function createKpiRuntime(cf, metrics) {
  var nativeSumMetric = getNativeSumMetric(metrics);
  var reducer = nativeSumMetric ? null : buildMetricReducer(metrics);
  var group = nativeSumMetric && typeof cf.groupAll === "function"
    ? cf.groupAll().reduceSum(createNativeSumAccessor(nativeSumMetric))
    : cf.groupAll().reduce(reducer.add, reducer.remove, reducer.initial);

  return {
    dispose: function() {
      group.dispose();
    },
    read: function() {
      if (nativeSumMetric) {
        var result = {};
        result[nativeSumMetric.id] = group.value();
        return result;
      }
      return reducer.finalize(group.value());
    }
  };
}

function createGroupRuntime(dimension, spec, index) {
  var metrics = normalizeMetrics(spec.metrics, spec.id || "group_" + index);
  var metricsById = {};
  var metricIndex;
  var nativeSumMetric = getNativeSumMetric(metrics);
  var reducer = nativeSumMetric ? null : buildMetricReducer(metrics);
  var groupAccessor = resolveGroupAccessor(spec);
  var group = groupAccessor ? dimension.group(groupAccessor) : dimension.group();
  var visibleMetric = null;
  var defaultSortMetric = null;
  var orderedMetricId = null;
  if (nativeSumMetric && typeof group.reduceSum === "function") {
    group.reduceSum(createNativeSumAccessor(nativeSumMetric));
  } else {
    group.reduce(reducer.add, reducer.remove, reducer.initial);
  }

  for (metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
    metricsById[metrics[metricIndex].id] = metrics[metricIndex];
    if (!visibleMetric && metrics[metricIndex].op === "count") {
      visibleMetric = metrics[metricIndex];
    }
  }

  if (!visibleMetric) {
    visibleMetric = metrics[0] || null;
  }
  defaultSortMetric = metricsById[spec.sortMetric] || metricsById.rows || metrics[0] || null;

  function metricStateValue(value, metric) {
    if (!metric) {
      return 0;
    }
    if (nativeSumMetric) {
      return metric.id === nativeSumMetric.id ? value : 0;
    }
    return value ? value[metric.id] : 0;
  }

  function entryMetricValue(entry, metric) {
    return entry ? metricStateValue(entry.value, metric) : 0;
  }

  function finalizeEntryValue(value) {
    if (!nativeSumMetric) {
      return reducer.finalize(value);
    }

    var result = {};
    result[nativeSumMetric.id] = value;
    return result;
  }

  function finalizeEntry(entry) {
    return {
      key: entry.key,
      value: finalizeEntryValue(entry.value)
    };
  }

  function readAll() {
    return group.all().map(finalizeEntry);
  }

  function matchesGroupKey(key, query, keySet, forceInclude) {
    if (!forceInclude && query.nonEmptyKeys && (key == null || key === "")) {
      return false;
    }
    if (!forceInclude && keySet && !keySet.has(key)) {
      return false;
    }
    if (!forceInclude && query.search && String(key).toLowerCase().indexOf(query.search) < 0) {
      return false;
    }
    return true;
  }

  function compareEntries(query, sortMetric, left, right) {
    var diff = metricComparableValue(sortMetric, entryMetricValue(left, sortMetric)) - metricComparableValue(sortMetric, entryMetricValue(right, sortMetric));
    if (!Number.isFinite(diff) || diff === 0) {
      return compareGroupKeys(left.key, right.key);
    }
    return query.sort === "asc" ? diff : -diff;
  }

  function topComparableValue(sortMetric, entry) {
    var comparable = metricComparableValue(sortMetric, entryMetricValue(entry, sortMetric));
    return comparable == null ? Number.NEGATIVE_INFINITY : comparable;
  }

  function ensureTopOrder(sortMetric) {
    if (!sortMetric || typeof group.order !== "function" || typeof group.top !== "function") {
      return false;
    }
    if (orderedMetricId === sortMetric.id) {
      return true;
    }
    group.order(function(value) {
      var comparable = metricComparableValue(sortMetric, metricStateValue(value, sortMetric));
      return comparable == null ? Number.NEGATIVE_INFINITY : comparable;
    });
    orderedMetricId = sortMetric.id;
    return true;
  }

  function canUseTopQuery(normalized, sortMetric) {
    return !!(
      normalized
      && normalized.sort === "desc"
      && sortMetric
      && normalized.includeTotals === false
      && !normalized.includeKeys
      && !normalized.keys
      && !normalized.search
      && typeof group.size === "function"
      && ensureTopOrder(sortMetric)
    );
  }

  function readTopQuery(normalized, sortMetric) {
    var limitWindow = normalized.limit == null ? null : normalized.offset + normalized.limit;
    var groupSize = group.size();
    var requested = limitWindow == null
      ? groupSize
      : Math.min(groupSize, Math.max(limitWindow + 1, 32));
    var rawEntries;
    var filteredEntries;

    do {
      rawEntries = group.top(requested);
      filteredEntries = [];

      for (var rawIndex = 0; rawIndex < rawEntries.length; ++rawIndex) {
        var rawEntry = rawEntries[rawIndex];
        var visible = !normalized.visibleOnly || metricHasVisibleValue(visibleMetric, entryMetricValue(rawEntry, visibleMetric));
        if (visible && matchesGroupKey(rawEntry.key, normalized, null, false)) {
          filteredEntries.push(rawEntry);
        }
      }

      filteredEntries.sort(function(left, right) {
        return compareEntries(normalized, sortMetric, left, right);
      });

      if (limitWindow == null || requested >= groupSize) {
        break;
      }

      var shouldExpand = filteredEntries.length < limitWindow;
      if (!shouldExpand) {
        var boundaryEntry = filteredEntries[limitWindow - 1];
        shouldExpand = !!boundaryEntry
          && topComparableValue(sortMetric, rawEntries[rawEntries.length - 1]) >= topComparableValue(sortMetric, boundaryEntry);
      }

      if (!shouldExpand) {
        break;
      }

      requested = Math.min(groupSize, Math.max(requested + 32, requested * 2));
    } while (true);

    return {
      entries: (normalized.limit == null
        ? filteredEntries.slice(normalized.offset)
        : filteredEntries.slice(normalized.offset, normalized.offset + normalized.limit)).map(finalizeEntry),
      limit: normalized.limit,
      offset: normalized.offset,
      sort: normalized.sort,
      sortMetric: sortMetric ? sortMetric.id : null
    };
  }

  function readQuery(query) {
    var normalized = normalizeGroupQuery(query);
    var allEntries;
    var includeKeySet;
    var keySet;
    var matchedEntries = [];
    var forcedEntries = [];
    var sortMetric = metricsById[normalized && normalized.sortMetric] || defaultSortMetric;
    var limitWindow = null;
    var useBoundedSort = false;
    var compareMatchedEntries = null;
    var entryIndex;
    var total = 0;

    if (!normalized) {
      return readAll();
    }

    if (canUseTopQuery(normalized, sortMetric)) {
      return readTopQuery(normalized, sortMetric);
    }

    allEntries = group.all();
    includeKeySet = normalized.includeKeys ? new Set(normalized.includeKeys) : null;
    keySet = normalized.keys ? new Set(normalized.keys) : null;
    limitWindow = normalized.limit == null ? null : normalized.offset + normalized.limit;
    useBoundedSort = limitWindow != null && normalized.sort !== "natural" && !!sortMetric;
    if (normalized.sort !== "natural" && sortMetric) {
      compareMatchedEntries = function(left, right) {
        return compareEntries(normalized, sortMetric, left, right);
      };
    }

    for (entryIndex = 0; entryIndex < allEntries.length; ++entryIndex) {
      var entry = allEntries[entryIndex];
      var forceInclude = includeKeySet && includeKeySet.has(entry.key);
      var visible = !normalized.visibleOnly || metricHasVisibleValue(visibleMetric, entryMetricValue(entry, visibleMetric));
      var matchesBaseQuery = visible && matchesGroupKey(entry.key, normalized, keySet, false);

      if (matchesBaseQuery) {
        total += 1;
        if (useBoundedSort) {
          insertSortedEntry(matchedEntries, entry, compareMatchedEntries, limitWindow);
        } else {
          matchedEntries.push(entry);
        }
      }

      if (forceInclude) {
        forcedEntries.push(entry);
      }
    }

    if (normalized.sort !== "natural" && sortMetric && !useBoundedSort) {
      matchedEntries.sort(function(left, right) {
        return compareEntries(normalized, sortMetric, left, right);
      });
    }

    if (normalized.sort !== "natural" && sortMetric) {
      forcedEntries.sort(function(left, right) {
        return compareEntries(normalized, sortMetric, left, right);
      });
    }

    var pagedEntries = normalized.limit == null
      ? matchedEntries.slice(normalized.offset)
      : matchedEntries.slice(normalized.offset, normalized.offset + normalized.limit);
    var seenKeys = new Set();
    var mergedEntries = [];

    for (entryIndex = 0; entryIndex < pagedEntries.length; ++entryIndex) {
      mergedEntries.push(pagedEntries[entryIndex]);
      seenKeys.add(pagedEntries[entryIndex].key);
    }

    for (entryIndex = 0; entryIndex < forcedEntries.length; ++entryIndex) {
      if (seenKeys.has(forcedEntries[entryIndex].key)) {
        continue;
      }
      mergedEntries.push(forcedEntries[entryIndex]);
      seenKeys.add(forcedEntries[entryIndex].key);
    }

    if (normalized.sort !== "natural" && sortMetric && forcedEntries.length) {
      mergedEntries.sort(function(left, right) {
        return compareEntries(normalized, sortMetric, left, right);
      });
    }

    var result = {
      entries: mergedEntries.map(finalizeEntry),
      limit: normalized.limit,
      offset: normalized.offset,
      sort: normalized.sort,
      sortMetric: sortMetric ? sortMetric.id : null
    };

    if (normalized.includeTotals) {
      result.total = total;
    }

    return result;
  }

  return {
    dispose: function() {
      group.dispose();
    },
    id: spec.id || "group_" + index,
    read: function(query) {
      return readQuery(query);
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
    columnar: query.columnar === true,
    direction: query.direction === "bottom" ? "bottom" : "top",
    fields: Array.isArray(query.fields) && query.fields.length ? query.fields.slice() : null,
    limit: typeof query.limit === "number" && query.limit >= 0 ? Math.floor(query.limit) : 50,
    offset: typeof query.offset === "number" && query.offset >= 0 ? Math.floor(query.offset) : 0,
    sortBy: query.sortBy || null
  };
}

function normalizeBoundsQuery(query) {
  query = query || {};

  return {
    fields: Array.isArray(query.fields) && query.fields.length ? uniqueFields(query.fields) : []
  };
}

function readColumnarFirstValue(result, field) {
  if (!result || !result.columns || !result.length) {
    return null;
  }

  var column = result.columns[field];
  if (!column || !column.length) {
    return null;
  }

  return column[0];
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

function rowIndexesToColumns(cf, rowIndexes, fields) {
  if (typeof cf.takeColumns === "function") {
    return cf.takeColumns(rowIndexes, fields);
  }

  var allRows = cf.all();
  var columns = {};
  var fieldIndex;
  var rowIndex;

  for (fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
    columns[fields[fieldIndex]] = new Array(rowIndexes.length);
  }

  for (rowIndex = 0; rowIndex < rowIndexes.length; ++rowIndex) {
    var row = allRows[rowIndexes[rowIndex]];
    for (fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
      columns[fields[fieldIndex]][rowIndex] = row ? row[fields[fieldIndex]] : undefined;
    }
  }

  return {
    columns: columns,
    fields: fields ? fields.slice() : [],
    length: rowIndexes.length
  };
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
  var rowCountGroup = cf.groupAll().reduceCount();

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
    var operations = [];
    var clearFields = [];
    var changedCount = 0;

    for (var field in nextFilters) {
      if (!dimensions[field]) {
        throw new Error("Unknown dashboard filter dimension: " + field);
      }
      seen.add(field);
      if (!sameFilter(currentFilters[field], nextFilters[field])) {
        operations.push({
          dimension: dimensions[field],
          filter: nextFilters[field]
        });
        changedCount += 1;
      }
    }

    for (field in currentFilters) {
      if (seen.has(field)) {
        continue;
      }
      if (dimensions[field]) {
        clearFields.push(field);
        changedCount += 1;
      }
    }

    var applyOperations = function() {
      var operationIndex;
      for (operationIndex = 0; operationIndex < operations.length; ++operationIndex) {
        applyFilter(operations[operationIndex].dimension, operations[operationIndex].filter);
      }
      for (operationIndex = 0; operationIndex < clearFields.length; ++operationIndex) {
        dimensions[clearFields[operationIndex]].filterAll();
      }
    };

    if (changedCount > 1 && typeof cf.batch === "function") {
      cf.batch(applyOperations);
    } else {
      applyOperations();
    }

    currentFilters = nextFilters;
    return typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo();
  }

  function readGroups(groupQueries) {
    var groups = {};

    if (!groupQueries) {
      for (var groupId in groupRuntimes) {
        groups[groupId] = groupRuntimes[groupId].read();
      }
      return groups;
    }

    for (var requestedGroupId in groupQueries) {
      if (!groupRuntimes[requestedGroupId]) {
        throw new Error("Unknown dashboard group: " + requestedGroupId);
      }
      if (groupQueries[requestedGroupId] === false) {
        continue;
      }
      groups[requestedGroupId] = groupRuntimes[requestedGroupId].read(groupQueries[requestedGroupId]);
    }

    return groups;
  }

  function readSnapshot(options) {
    var groups = {};

    if (!options || options.groups !== false) {
      groups = readGroups(options && options.groups ? options.groups : null);
    }

    return {
      groups: groups,
      kpis: kpiRuntime.read(),
      runtime: typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo()
    };
  }

  function readRowCount() {
    return rowCountGroup.value();
  }

  function readRows(query) {
    var normalized = normalizeRowQuery(query);
    var rowIndexes;
    var rows;

    if (normalized.columnar) {
      if (!normalized.fields) {
        throw new Error("Columnar row queries require `fields`.");
      }
      if (normalized.sortBy) {
        var columnDimension = ensureDimension(dimensions, dimensionFields, cf, normalized.sortBy);
        rowIndexes = normalized.direction === "bottom" && typeof columnDimension.bottomIndex === "function"
          ? columnDimension.bottomIndex(normalized.limit, normalized.offset)
          : typeof columnDimension.topIndex === "function"
            ? columnDimension.topIndex(normalized.limit, normalized.offset)
            : null;
      } else if (typeof cf.allFilteredIndexes === "function") {
        rowIndexes = cf.allFilteredIndexes().slice(normalized.offset, normalized.offset + normalized.limit);
      }

      if (rowIndexes) {
        return rowIndexesToColumns(cf, rowIndexes, normalized.fields);
      }
    }

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

  function readBounds(query) {
    var normalized = normalizeBoundsQuery(query);
    var bounds = {};
    var fieldIndex;

    for (fieldIndex = 0; fieldIndex < normalized.fields.length; ++fieldIndex) {
      var field = normalized.fields[fieldIndex];
      var dimension = ensureDimension(dimensions, dimensionFields, cf, field);
      var lowerIndexes = typeof dimension.bottomIndex === "function" ? dimension.bottomIndex(1) : null;
      var upperIndexes = typeof dimension.topIndex === "function" ? dimension.topIndex(1) : null;
      var minValue = null;
      var maxValue = null;

      if (lowerIndexes && lowerIndexes.length) {
        minValue = readColumnarFirstValue(rowIndexesToColumns(cf, [lowerIndexes[0]], [field]), field);
      } else {
        var lowerRows = dimension.bottom(1);
        minValue = lowerRows.length ? lowerRows[0][field] : null;
      }

      if (upperIndexes && upperIndexes.length) {
        maxValue = readColumnarFirstValue(rowIndexesToColumns(cf, [upperIndexes[0]], [field]), field);
      } else {
        var upperRows = dimension.top(1);
        maxValue = upperRows.length ? upperRows[0][field] : null;
      }

      bounds[field] = {
        max: maxValue == null ? null : maxValue,
        min: minValue == null ? null : minValue
      };
    }

    return bounds;
  }

  function readRowSets(rowSetQueries) {
    var rowSets = {};

    if (!rowSetQueries) {
      return rowSets;
    }

    for (var rowSetId in rowSetQueries) {
      if (rowSetQueries[rowSetId] === false) {
        continue;
      }
      rowSets[rowSetId] = readRows(rowSetQueries[rowSetId]);
    }

    return rowSets;
  }

  function queryRuntime(request) {
    request = request || {};
    if (request.filters) {
      updateFilters(request.filters);
    }

    var response = {
      rows: request.rows ? readRows(request.rows) : [],
      snapshot: request.snapshot === false ? null : readSnapshot(request.snapshot)
    };

    if (request.rowCount) {
      response.rowCount = readRowCount();
    }

    if (request.groups) {
      response.groups = readGroups(request.groups);
    }

    if (request.bounds) {
      response.bounds = readBounds(request.bounds);
    }

    if (request.rowSets) {
      response.rowSets = readRowSets(request.rowSets);
    }

    return response;
  }

  function queryGroups(request) {
    request = request || {};
    if (request.filters) {
      updateFilters(request.filters);
    }
    return readGroups(request.groups || null);
  }

  function queryBounds(request) {
    request = request || {};
    if (request.filters) {
      updateFilters(request.filters);
    }
    return readBounds(request.bounds || request);
  }

  function queryRowSets(request) {
    request = request || {};
    if (request.filters) {
      updateFilters(request.filters);
    }
    return readRowSets(request.rowSets || request);
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
    bounds: function(request) {
      return queryBounds(request);
    },
    dispose: function() {
      this.reset();
      for (var groupId in groupRuntimes) {
        groupRuntimes[groupId].dispose();
      }
      kpiRuntime.dispose();
      rowCountGroup.dispose();
      for (var dimensionIndex = 0; dimensionIndex < dimensionFields.length; ++dimensionIndex) {
        dimensions[dimensionFields[dimensionIndex]].dispose();
      }
    },
    query: function(request) {
      return queryRuntime(request);
    },
    groups: function(request) {
      return queryGroups(request);
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
    rowSets: function(request) {
      return queryRowSets(request);
    },
    rowCount: function(request) {
      request = request || {};
      if (request.filters) {
        updateFilters(request.filters);
      }
      return readRowCount();
    },
    runtimeInfo: function() {
      return typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo();
    },
    size: function() {
      return cf.size();
    },
    snapshot: function(filters, snapshotOptions) {
      if (filters) {
        updateFilters(filters);
      }
      return readSnapshot(snapshotOptions);
    },
    updateFilters: updateFilters
  };
}
