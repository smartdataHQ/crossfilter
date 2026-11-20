import {
  OP_AVG,
  OP_AVG_NON_ZERO,
  OP_COUNT,
  OP_RATIO,
  OP_SUM,
  finalizeMetricSlot,
  slotHasAnyActivity
} from "./columnar-reduce.js";

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
    if (metric.op !== "count" && metric.op !== "sum" && metric.op !== "avg" && metric.op !== "avgNonZero" && metric.op !== "ratio") {
      throw new Error("Unsupported dashboard metric op: " + metric.op);
    }
    if (metric.op === "ratio" && !metric.denominator) {
      throw new Error("Dashboard metric `" + id + "` with op `ratio` requires a denominator.");
    }

    return {
      field: metric.field,
      id: id,
      op: metric.op || "count",
      denominator: metric.denominator || null
    };
  });

  return normalized;
}

var reusableMonthDate = new Date(0);

function normalizeTimeBucketValue(value) {
  if (typeof value === "number") {
    return value === value && value !== Infinity && value !== -Infinity ? value : null;
  }

  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    var time = value.getTime();
    return time === time ? time : null;
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

  if (granularity === "day") {
    return Math.floor(numeric / 86400000) * 86400000;
  }

  if (granularity === "hour") {
    return Math.floor(numeric / 3600000) * 3600000;
  }

  if (granularity === "minute") {
    return Math.floor(numeric / 60000) * 60000;
  }

  if (granularity === "week") {
    return Math.floor((numeric + 259200000) / 604800000) * 604800000 - 259200000;
  }

  if (granularity === "month") {
    reusableMonthDate.setTime(numeric);
    return Date.UTC(reusableMonthDate.getUTCFullYear(), reusableMonthDate.getUTCMonth(), 1);
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
  var accessor = function(value) {
    return bucketTimestampValue(value, granularity);
  };
  accessor._xfilterPureMonotonic = true;
  if (granularity === "day") {
    accessor._xfilterTimeStep = 86400000;
    accessor._xfilterTimeOffset = 0;
  } else if (granularity === "hour") {
    accessor._xfilterTimeStep = 3600000;
    accessor._xfilterTimeOffset = 0;
  } else if (granularity === "minute") {
    accessor._xfilterTimeStep = 60000;
    accessor._xfilterTimeOffset = 0;
  } else if (granularity === "week") {
    accessor._xfilterTimeStep = 604800000;
    accessor._xfilterTimeOffset = 259200000;
  }
  return accessor;
}

function buildMetricReducer(metrics, splitField) {
  var metricSpec = metrics.map(function(metric) {
    return {
      field: metric.field || null,
      denominator: metric.denominator || null,
      hidden: !!metric.hidden,
      id: metric.id,
      op: metric.op
    };
  });

  function initBucket() {
    var bucket = {};
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      if (metric.op === "avg" || metric.op === "avgNonZero") {
        bucket[metric.id] = { count: 0, sum: 0 };
      } else if (metric.op === "ratio") {
        bucket[metric.id] = { num: 0, den: 0 };
      } else {
        bucket[metric.id] = 0;
      }
    }
    return bucket;
  }

  function isBucketEmpty(bucket) {
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value = bucket[metric.id];
      if (metric.op === "avg" || metric.op === "avgNonZero") {
        if (value && value.count > 0) return false;
      } else if (metric.op === "ratio") {
        if (value && (value.num !== 0 || value.den !== 0)) return false;
      } else if (metric.op === "count") {
        if (value > 0) return false;
      } else {
        if (value !== 0) return false;
      }
    }
    return true;
  }

  function addToBucket(bucket, row) {
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value;

      switch (metric.op) {
        case "count":
          bucket[metric.id] += 1;
          break;
        case "sum":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id] += value;
          }
          break;
        case "avg":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id].sum += value;
            bucket[metric.id].count += 1;
          }
          break;
        case "avgNonZero":
          value = row[metric.field];
          if (isFiniteNumber(value) && value !== 0) {
            bucket[metric.id].sum += value;
            bucket[metric.id].count += 1;
          }
          break;
        case "ratio":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id].num += value;
          }
          value = row[metric.denominator];
          if (isFiniteNumber(value)) {
            bucket[metric.id].den += value;
          }
          break;
      }
    }
  }

  function removeFromBucket(bucket, row) {
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value;

      switch (metric.op) {
        case "count":
          bucket[metric.id] -= 1;
          break;
        case "sum":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id] -= value;
          }
          break;
        case "avg":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id].sum -= value;
            bucket[metric.id].count -= 1;
          }
          break;
        case "avgNonZero":
          value = row[metric.field];
          if (isFiniteNumber(value) && value !== 0) {
            bucket[metric.id].sum -= value;
            bucket[metric.id].count -= 1;
          }
          break;
        case "ratio":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id].num -= value;
          }
          value = row[metric.denominator];
          if (isFiniteNumber(value)) {
            bucket[metric.id].den -= value;
          }
          break;
      }
    }
  }

  function finalizeBucket(bucket) {
    var result = {};
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      if (metric.hidden) continue;
      var value = bucket[metric.id];
      if (metric.op === "avg" || metric.op === "avgNonZero") {
        result[metric.id] = value.count ? value.sum / value.count : null;
      } else if (metric.op === "ratio") {
        result[metric.id] = value.den !== 0 ? value.num / value.den : null;
      } else {
        result[metric.id] = value;
      }
    }
    return result;
  }

  // ---- Split-field path: nested aggregates keyed by splitField value ----

  if (splitField) {
    var splitInitial = function() {
      var state = {};
      Object.defineProperties(state, {
        __cache: { configurable: true, enumerable: false, value: null, writable: true },
        __cacheVersion: { configurable: true, enumerable: false, value: -1, writable: true },
        __version: { configurable: true, enumerable: false, value: 0, writable: true }
      });
      return state;
    };

    var splitAdd = function(state, row) {
      var splitKey = row[splitField];
      if (splitKey == null || splitKey === "") splitKey = "__unknown__";
      if (!state[splitKey]) state[splitKey] = initBucket();
      addToBucket(state[splitKey], row);
      state.__version += 1;
      return state;
    };

    var splitRemove = function(state, row) {
      var splitKey = row[splitField];
      if (splitKey == null || splitKey === "") splitKey = "__unknown__";
      if (state[splitKey]) removeFromBucket(state[splitKey], row);
      state.__version += 1;
      return state;
    };

    var splitFinalize = function(state) {
      if (state.__cacheVersion === state.__version && state.__cache) {
        return state.__cache;
      }
      var result = {};
      for (var key in state) {
        var bucket = state[key];
        // Skip buckets reduced to zero (filtered-out stores)
        if (isBucketEmpty(bucket)) continue;
        result[key] = finalizeBucket(bucket);
      }
      state.__cache = result;
      state.__cacheVersion = state.__version;
      return result;
    };

    splitAdd._xfilterMetricSpec = metricSpec;
    splitRemove._xfilterMetricSpec = metricSpec;
    splitInitial._xfilterMetricSpec = metricSpec;
    splitAdd._xfilterSplitField = splitField;
    splitRemove._xfilterSplitField = splitField;
    splitInitial._xfilterSplitField = splitField;

    return { add: splitAdd, finalize: splitFinalize, initial: splitInitial, remove: splitRemove };
  }

  // ---- Standard path: flat metrics ----

  function initial() {
    var state = initBucket();

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
    addToBucket(state, row);
    state.__version += 1;
    return state;
  }

  function remove(state, row) {
    removeFromBucket(state, row);
    state.__version += 1;
    return state;
  }

  function finalize(state) {
    if (state.__cacheVersion === state.__version && state.__cache) {
      return state.__cache;
    }

    var result = finalizeBucket(state);

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

function shallowCopy(obj) {
  var copy = {};
  for (var key in obj) {
    copy[key] = obj[key];
  }
  return copy;
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

function sameFilterState(left, right) {
  var field;
  for (field in left) {
    if (!sameFilter(left[field], right[field])) {
      return false;
    }
  }
  for (field in right) {
    if (!(field in left) && right[field] != null) {
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

  if (metric.op === "ratio") {
    return value && value.den !== 0 ? value.num / value.den : null;
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
  var reducer = buildMetricReducer(metrics);
  var group = cf.groupAll().reduce(reducer.add, reducer.remove, reducer.initial);

  return {
    dispose: function() {
      group.dispose();
    },
    read: function() {
      if (typeof group._readScalar === "function") {
        var fast = group._readScalar();
        if (fast) {
          return fast;
        }
      }
      return reducer.finalize(group.value());
    }
  };
}

function finalizeColumnarSlot(view, slot) {
  if (view.mode === "flat") {
    return finalizeMetricSlot(view.plan, view.buffers, slot);
  }

  var result = {};
  var splitKeys = view.splitKeys;
  var plan = view.plan;
  var buffers = view.buffers;

  if (view.mode === "splitDense") {
    var stride = view.splitStride;
    var base = slot * stride;
    for (var sc = 0; sc < stride; ++sc) {
      var cell = base + sc;
      if (slotHasAnyActivity(plan, buffers, cell)) {
        result[splitKeys[sc]] = finalizeMetricSlot(plan, buffers, cell);
      }
    }
    return result;
  }

  var activePairs = [];
  for (var pid = view.headBySlot[slot]; pid !== -1; pid = view.nextPair[pid]) {
    if (slotHasAnyActivity(plan, buffers, pid)) {
      activePairs.push(pid);
    }
  }
  if (activePairs.length > 1) {
    var pairSplitCode = view.pairSplitCode;
    activePairs.sort(function(a, b) {
      return pairSplitCode[a] - pairSplitCode[b];
    });
  }
  for (var pi = 0; pi < activePairs.length; ++pi) {
    var pairId = activePairs[pi];
    result[splitKeys[view.pairSplitCode[pairId]]] = finalizeMetricSlot(plan, buffers, pairId);
  }
  return result;
}

function createGroupRuntime(dimension, spec, index) {
  var metrics = normalizeMetrics(spec.metrics, spec.id || "group_" + index);
  // A category shows while rows contribute to it, as Cube's GROUP BY returns it, whatever
  // its value: a hidden row count proves that when no metric counts rows.
  if (!metrics.some(function(metric) { return metric.op === "count"; })) {
    metrics = metrics.concat([{ field: undefined, id: "__rows", op: "count", denominator: null, hidden: true }]);
  }
  var metricsById = {};
  var metricIndexById = {};
  var metricIndex;
  var splitField = spec.splitField || null;
  var reducer = buildMetricReducer(metrics, splitField);
  var groupAccessor = resolveGroupAccessor(spec);
  var group = groupAccessor ? dimension.group(groupAccessor) : dimension.group();
  var visibleMetric = null;
  var visibleMetricIndex = 0;
  var defaultSortMetric = null;
  var orderedMetricId = null;

  group.reduce(reducer.add, reducer.remove, reducer.initial);

  for (metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
    metricsById[metrics[metricIndex].id] = metrics[metricIndex];
    metricIndexById[metrics[metricIndex].id] = metricIndex;
    if (!visibleMetric && metrics[metricIndex].op === "count") {
      visibleMetric = metrics[metricIndex];
      visibleMetricIndex = metricIndex;
    }
  }

  if (!visibleMetric) {
    visibleMetric = metrics[0] || null;
    visibleMetricIndex = 0;
  }
  defaultSortMetric = metricsById[spec.sortMetric] || metricsById.rows || metrics[0] || null;

  function metricStateValue(value, metric) {
    if (!metric) {
      return 0;
    }
    if (splitField) {
      // Sum the metric across all split buckets for comparability
      var total = 0;
      for (var splitKey in value) {
        var bucket = value[splitKey];
        if (bucket && bucket[metric.id] != null) {
          var bv = bucket[metric.id];
          if (typeof bv === "object" && bv.count != null) {
            total += bv.sum || 0;
          } else if (typeof bv === "object" && bv.den != null) {
            total += bv.num || 0;
          } else {
            total += bv;
          }
        }
      }
      return total;
    }
    return value ? value[metric.id] : 0;
  }

  function entryMetricValue(entry, metric) {
    return entry ? metricStateValue(entry.value, metric) : 0;
  }

  function finalizeEntry(entry) {
    return {
      key: entry.key,
      value: reducer.finalize(entry.value)
    };
  }

  function readAllColumnar(view) {
    var count = view.count;
    var out = new Array(count);
    var slotOf = view.slotOf;
    var codeToValue = view.codeToValue;
    var keys = view.keys;
    var groupsRef = view.groups;
    var i, slot, key;

    for (i = 0; i < count; ++i) {
      if (slotOf) {
        slot = slotOf[i];
        key = codeToValue[slot];
      } else if (keys) {
        slot = i;
        key = keys[i];
      } else {
        slot = i;
        key = groupsRef[i].key;
      }
      out[i] = {
        key: key,
        value: finalizeColumnarSlot(view, slot)
      };
    }

    return out;
  }

  function readAll() {
    if (typeof group._readColumnar === "function") {
      var view = group._readColumnar();
      if (view) {
        return readAllColumnar(view);
      }
    }
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

  function readQueryColumnar(view, normalized, sortMetric) {
    var count = view.count;
    var mode = view.mode;
    var plan = view.plan;
    var buffers = view.buffers;
    var slotOf = view.slotOf;
    var codeToValue = view.codeToValue;
    var keys = view.keys;
    var groupsRef = view.groups;
    var stride = view.splitStride || 0;
    var headBySlot = view.headBySlot;
    var nextPair = view.nextPair;

    var includeKeySet = normalized.includeKeys ? new Set(normalized.includeKeys) : null;
    var keySet = normalized.keys ? new Set(normalized.keys) : null;
    var visibleOnly = normalized.visibleOnly;
    var nonEmptyKeys = normalized.nonEmptyKeys;
    var searchTerm = normalized.search;
    var sortDir = normalized.sort;
    var isAsc = sortDir === "asc";
    var isNatural = sortDir === "natural" || !sortMetric;
    var limitWindow = normalized.limit == null ? null : normalized.offset + normalized.limit;
    var useHeap = !isNatural && limitWindow != null && limitWindow > 0 && limitWindow < count;

    var visPrim = buffers ? buffers.primary[visibleMetricIndex] : null;
    var visSec = buffers ? buffers.secondary[visibleMetricIndex] : null;
    var visOp = plan.ops[visibleMetricIndex];

    var sortIdx = sortMetric ? metricIndexById[sortMetric.id] : -1;
    var sortPrim = (buffers && sortIdx >= 0) ? buffers.primary[sortIdx] : null;
    var sortSec = (buffers && sortIdx >= 0) ? buffers.secondary[sortIdx] : null;
    var sortOp = sortIdx >= 0 ? plan.ops[sortIdx] : OP_COUNT;
    var splitSortNumeric = sortOp === OP_COUNT || sortOp === OP_SUM;

    function isSlotVisible(slot) {
      if (!buffers) return false;
      if (mode === "flat") {
        if (visOp === OP_COUNT || visOp === OP_SUM) {
          return visPrim[slot] > 0;
        }
        if (visOp === OP_AVG || visOp === OP_AVG_NON_ZERO) {
          return visSec[slot] > 0 && (visPrim[slot] / visSec[slot]) > 0;
        }
        if (visOp === OP_RATIO) {
          return visSec[slot] !== 0 && (visPrim[slot] / visSec[slot]) > 0;
        }
        return false;
      }
      var sum = 0;
      if (mode === "splitDense") {
        var base = slot * stride;
        for (var sc = 0; sc < stride; ++sc) {
          sum += visPrim[base + sc];
        }
        return sum > 0;
      }
      for (var pid = headBySlot[slot]; pid !== -1; pid = nextPair[pid]) {
        sum += visPrim[pid];
      }
      return sum > 0;
    }

    function readSortComparable(slot) {
      if (!sortPrim) return 0;
      if (mode === "flat") {
        if (sortOp === OP_COUNT || sortOp === OP_SUM) {
          return sortPrim[slot];
        }
        if (sortOp === OP_AVG || sortOp === OP_AVG_NON_ZERO) {
          var c = sortSec[slot];
          return c ? sortPrim[slot] / c : 0;
        }
        if (sortOp === OP_RATIO) {
          var d = sortSec[slot];
          return d !== 0 ? sortPrim[slot] / d : 0;
        }
        return 0;
      }
      if (!splitSortNumeric) {
        return 0;
      }
      var sum = 0;
      if (mode === "splitDense") {
        var base = slot * stride;
        for (var sc = 0; sc < stride; ++sc) {
          sum += sortPrim[base + sc];
        }
        return sum;
      }
      for (var pid = headBySlot[slot]; pid !== -1; pid = nextPair[pid]) {
        sum += sortPrim[pid];
      }
      return sum;
    }

    var total = 0;
    var forcedItems = includeKeySet ? [] : null;
    var matchedItems = useHeap ? null : [];
    var heapVal = useHeap ? new Float64Array(limitWindow) : null;
    var heapSlot = useHeap ? new Uint32Array(limitWindow) : null;
    var heapKey = useHeap ? new Array(limitWindow) : null;
    var heapSize = 0;
    var canBreakNatural = isNatural && limitWindow != null && !normalized.includeTotals && !includeKeySet;

    function isHeapWorse(valA, keyA, valB, keyB) {
      var diff = valA - valB;
      if (!Number.isFinite(diff) || diff === 0) {
        return compareGroupKeys(keyA, keyB) > 0;
      }
      return isAsc ? diff > 0 : diff < 0;
    }

    var i, slot, key, visible, matchesKey, val, pos, parent, left, right, child;
    for (i = 0; i < count; ++i) {
      if (slotOf) {
        slot = slotOf[i];
        key = codeToValue[slot];
      } else if (keys) {
        slot = i;
        key = keys[i];
      } else {
        slot = i;
        key = groupsRef[i].key;
      }

      var forceInclude = includeKeySet !== null && includeKeySet.has(key);

      visible = !visibleOnly || isSlotVisible(slot);
      if (visible) {
        matchesKey = true;
        if (nonEmptyKeys && (key == null || key === "")) {
          matchesKey = false;
        } else if (keySet && !keySet.has(key)) {
          matchesKey = false;
        } else if (searchTerm && String(key).toLowerCase().indexOf(searchTerm) < 0) {
          matchesKey = false;
        }
      } else {
        matchesKey = false;
      }

      if (matchesKey) {
        total += 1;
        if (limitWindow === 0) {
          // Only counting total
        } else if (useHeap) {
          val = readSortComparable(slot);
          if (heapSize < limitWindow) {
            pos = heapSize++;
            while (pos > 0) {
              parent = (pos - 1) >>> 1;
              if (isHeapWorse(val, key, heapVal[parent], heapKey[parent])) {
                heapVal[pos] = heapVal[parent];
                heapSlot[pos] = heapSlot[parent];
                heapKey[pos] = heapKey[parent];
                pos = parent;
              } else {
                break;
              }
            }
            heapVal[pos] = val;
            heapSlot[pos] = slot;
            heapKey[pos] = key;
          } else {
            var rootVal = heapVal[0];
            var better = isAsc
              ? (val < rootVal || (val === rootVal && compareGroupKeys(key, heapKey[0]) < 0))
              : (val > rootVal || (val === rootVal && compareGroupKeys(key, heapKey[0]) < 0));
            if (better) {
              pos = 0;
              while ((left = (pos << 1) + 1) < heapSize) {
                child = left;
                right = left + 1;
                if (right < heapSize && isHeapWorse(heapVal[right], heapKey[right], heapVal[left], heapKey[left])) {
                  child = right;
                }
                if (isHeapWorse(heapVal[child], heapKey[child], val, key)) {
                  heapVal[pos] = heapVal[child];
                  heapSlot[pos] = heapSlot[child];
                  heapKey[pos] = heapKey[child];
                  pos = child;
                } else {
                  break;
                }
              }
              heapVal[pos] = val;
              heapSlot[pos] = slot;
              heapKey[pos] = key;
            }
          }
        } else if (isNatural) {
          if (limitWindow == null || (total > normalized.offset && matchedItems.length < normalized.limit)) {
            matchedItems.push({ key: key, slot: slot, val: 0 });
            if (canBreakNatural && matchedItems.length >= normalized.limit) {
              break;
            }
          }
        } else {
          matchedItems.push({ key: key, slot: slot, val: readSortComparable(slot) });
        }
      }

      if (forceInclude) {
        forcedItems.push({
          key: key,
          slot: slot,
          val: isNatural ? 0 : readSortComparable(slot)
        });
      }
    }

    var compareItems = function(leftItem, rightItem) {
      var diff = leftItem.val - rightItem.val;
      if (!Number.isFinite(diff) || diff === 0) {
        return compareGroupKeys(leftItem.key, rightItem.key);
      }
      return isAsc ? diff : -diff;
    };

    var pagedItems;
    if (useHeap) {
      var extracted = new Array(heapSize);
      for (i = 0; i < heapSize; ++i) {
        extracted[i] = { key: heapKey[i], slot: heapSlot[i], val: heapVal[i] };
      }
      extracted.sort(compareItems);
      pagedItems = normalized.offset > 0
        ? extracted.slice(normalized.offset, normalized.offset + normalized.limit)
        : (extracted.length > normalized.limit ? extracted.slice(0, normalized.limit) : extracted);
    } else if (isNatural) {
      pagedItems = limitWindow != null
        ? matchedItems
        : (normalized.offset > 0 ? matchedItems.slice(normalized.offset) : matchedItems);
    } else {
      matchedItems.sort(compareItems);
      pagedItems = normalized.limit == null
        ? matchedItems.slice(normalized.offset)
        : matchedItems.slice(normalized.offset, normalized.offset + normalized.limit);
    }

    var finalItems = pagedItems;
    if (forcedItems && forcedItems.length) {
      if (!isNatural) {
        forcedItems.sort(compareItems);
      }
      var seenKeys = new Set();
      var merged = [];
      for (i = 0; i < pagedItems.length; ++i) {
        merged.push(pagedItems[i]);
        seenKeys.add(pagedItems[i].key);
      }
      for (i = 0; i < forcedItems.length; ++i) {
        if (seenKeys.has(forcedItems[i].key)) continue;
        merged.push(forcedItems[i]);
        seenKeys.add(forcedItems[i].key);
      }
      if (!isNatural) {
        merged.sort(compareItems);
      }
      finalItems = merged;
    }

    var entries = new Array(finalItems.length);
    for (i = 0; i < finalItems.length; ++i) {
      entries[i] = {
        key: finalItems[i].key,
        value: finalizeColumnarSlot(view, finalItems[i].slot)
      };
    }

    var result = {
      entries: entries,
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

    if (typeof group._readColumnar === "function") {
      var view = group._readColumnar();
      if (view) {
        return readQueryColumnar(view, normalized, sortMetric);
      }
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
  var rowCountGroup = typeof cf._filteredCount === "function" ? null : cf.groupAll().reduceCount();

  for (var fieldIndex = 0; fieldIndex < dimensionFields.length; ++fieldIndex) {
    dimensions[dimensionFields[fieldIndex]] = cf.dimension(dimensionFields[fieldIndex]);
  }

  var nextGroupIndex = 0;
  for (nextGroupIndex = 0; nextGroupIndex < groupSpecs.length; ++nextGroupIndex) {
    var groupSpec = groupSpecs[nextGroupIndex];
    var groupDimension = ensureDimension(dimensions, dimensionFields, cf, groupSpec.field);
    var groupRuntime = createGroupRuntime(groupDimension, groupSpec, nextGroupIndex);
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
    if (typeof cf._filteredCount === "function") {
      return cf._filteredCount();
    }
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
      } else if (typeof cf._filteredIndexesSlice === "function") {
        rowIndexes = cf._filteredIndexesSlice(normalized.offset, normalized.limit);
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
      if (typeof dimension._bounds === "function") {
        var fastBounds = dimension._bounds();
        if (fastBounds) {
          bounds[field] = fastBounds;
          continue;
        }
      }
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

  function executeQueryReads(request) {
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

  function queryRuntime(request) {
    request = request || {};

    if (request.isolatedFilters) {
      var normalizedIsolated = normalizeFilterState(request.isolatedFilters);
      for (var isolatedField in normalizedIsolated) {
        if (!dimensions[isolatedField]) {
          throw new Error("Unknown dashboard filter dimension: " + isolatedField);
        }
      }
      if (sameFilterState(currentFilters, normalizedIsolated)) {
        return executeQueryReads(request);
      }
      var savedFilters = shallowCopy(currentFilters);
      var needsGroupState = request.snapshot !== false || !!request.groups;
      if (!needsGroupState && typeof cf._withTransientFilters === "function") {
        return cf._withTransientFilters(function() {
          updateFilters(normalizedIsolated);
          try {
            return executeQueryReads(request);
          } finally {
            updateFilters(savedFilters);
          }
        });
      }
      updateFilters(normalizedIsolated);
      try {
        return executeQueryReads(request);
      } finally {
        updateFilters(savedFilters);
      }
    }

    if (request.filters) {
      updateFilters(request.filters);
    }

    return executeQueryReads(request);
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
      if (rowCountGroup) rowCountGroup.dispose();
      for (var dimensionIndex = 0; dimensionIndex < dimensionFields.length; ++dimensionIndex) {
        dimensions[dimensionFields[dimensionIndex]].dispose();
      }
    },
    createGroup: function(spec) {
      var groupDimension = ensureDimension(dimensions, dimensionFields, cf, spec.field);
      var groupRuntime = createGroupRuntime(groupDimension, spec, nextGroupIndex++);
      // Replace only after construction succeeds; a failed definition keeps
      // the previous group usable, while successful replacement releases it.
      if (groupRuntimes[groupRuntime.id]) groupRuntimes[groupRuntime.id].dispose();
      groupRuntimes[groupRuntime.id] = groupRuntime;
      return groupRuntime.id;
    },
    disposeGroup: function(id) {
      if (groupRuntimes[id]) {
        groupRuntimes[id].dispose();
        delete groupRuntimes[id];
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
