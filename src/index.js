import xfilterArray from './array.js';
import xfilterFilter from './filter.js';
import { createFilterBitsetStore } from './filter-bitsets.js';
import { createFalconBrushCache } from './falcon-brush.js';
import cr_identity from './identity.js';
import cr_null from './null.js';
import cr_zero from './zero.js';
import xfilterHeapselect from './heapselect.js';
import xfilterHeap from './heap.js';
import bisect from './bisect.js';
import permute from './permute.js';
import xfilterReduce from './reduce.js';
import result from './result.js';
import { compareNaturalOrder, isNaturallyOrderable } from './natural-order.js';
import {
  getColumnValue,
  getColumnarBatch,
  materializeColumnarRow,
  rowsFromColumns,
  rowsFromArrowTable
} from './columnar.js';
import {
  configureWasmRuntime,
  createWasmRuntimeController,
  getWasmRuntimeInfo
} from './wasm.js';
import {
  canPlanUseComplement,
  cleanupComplementEmptySlots,
  compileMetricPlan,
  ensureMetricBuffers,
  finalizeMetricSlot,
  getExactCountOffset,
  reduceGroupedAll,
  reduceGroupedIndexed,
  reduceMultiGroupsAll,
  reduceMultiGroupsIndexed,
  reduceScalarAll,
  reduceScalarIndexed,
  reduceSplitDenseAll,
  reduceSplitDenseIndexed,
  slotHasAnyActivity,
  writeMetricSlotToState,
  zeroMetricBuffers
} from './columnar-reduce.js';
import { createDashboardRuntime as createDashboardRuntimeHelper } from './dashboard.js';
import { createDashboardWorker as createDashboardWorkerHelper } from './dashboard-worker.js';
import { createStreamingDashboardWorker as createStreamingDashboardWorkerHelper } from './dashboard-stream-worker.js';

// constants
var REMOVED_INDEX = -1;
var EMPTY_ARRAY = [];
var utf8FatalDecoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;
var utf8Decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;

crossfilter.heap = xfilterHeap;
crossfilter.heapselect = xfilterHeapselect;
crossfilter.bisect = bisect;
crossfilter.permute = permute;
crossfilter.rowsFromColumns = rowsFromColumns;
crossfilter.fromColumns = function(columns, options) {
  return crossfilter(rowsFromColumns(columns, options));
};
crossfilter.rowsFromArrowTable = rowsFromArrowTable;
crossfilter.fromArrowTable = function(table, options) {
  return crossfilter(rowsFromArrowTable(table, options));
};
crossfilter.configureRuntime = configureWasmRuntime;
crossfilter.runtimeInfo = getWasmRuntimeInfo;
crossfilter.createDashboardRuntime = function(options) {
  return createDashboardRuntimeHelper(crossfilter, options);
};
crossfilter.createDashboardWorker = function(options) {
  return createDashboardWorkerHelper(options);
};
crossfilter.createStreamingDashboardWorker = function(options) {
  return createStreamingDashboardWorkerHelper(options);
};
// Match simple property access patterns in function source:
//   d => d.prop, (d) => d['prop'], function(d) { return d.prop; }
var re_arrowAccessor = /^\(?(\w+)\)?\s*=>\s*\1(?:\.(\w+)|\[['"]([^'"]+)['"]\])\s*$/;
var re_functionAccessor = /^function\s*\w*\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+\1(?:\.(\w+)|\[['"]([^'"]+)['"]\])\s*;?\s*\}$/;

function tryExtractAccessorPath(fn) {
  try {
    var source = fn.toString().trim();
    var match = re_arrowAccessor.exec(source) || re_functionAccessor.exec(source);
    return match ? (match[2] || match[3]) : null;
  } catch (e) {
    return null;
  }
}

export default crossfilter;

function crossfilter() {
  var runtimeController = createWasmRuntimeController();
  var crossfilter = {
    add: add,
    allFilteredIndexes: allFilteredIndexes,
    batch: batch,
    remove: removeData,
    dimension: dimension,
    getFieldValue: getFieldValue,
    groupAll: groupAll,
    size: size,
    all: all,
    allFiltered: allFiltered,
    onChange: onChange,
    isElementFiltered: isElementFiltered,
    takeColumns: takeColumns,
    configureRuntime: runtimeController.configureRuntime,
    runtimeInfo: runtimeController.runtimeInfo,
    _filteredCount: filteredCount,
    _filteredIndexesSlice: filteredIndexesSlice,
    _flushGroups: flushGroups,
    _materializeRowsByIndex: materializeRowsByIndex,
    _withTransientFilters: withTransientFilters
  };

  var data = [], // the records
      n = 0, // the number of records; data.length
      filterStore = createFilterBitsetStore(), // per-dimension 1-bit filter bitsets
      filterListeners = [], // when the filters change
      dataListeners = [], // when data is added
      removeDataListeners = [], // when data is removed
      resetListeners = [],
      callbacks = [],
      columnarBatches = [],
      anyRowMaterialized = false,
      lazyDimensionsByField = Object.create(null),
      numericColumns = Object.create(null),
      splitColumns = Object.create(null),
      activeRowsDirty = true,
      activeCountDirty = true,
      activeCountCached = 0,
      activeRowsBuf = new Uint32Array(0),
      activeRowsLength = 0,
      excludedRowsBuf = new Uint32Array(0),
      dimActiveRowsBuf = new Uint32Array(0),
      deltaAddedBuf = new Uint32Array(0),
      deltaRemovedBuf = new Uint32Array(0),
      deltaWorkBuf = new Uint32Array(0),
      deltaBufInUse = false,
      batchedFilterDepth = 0,
      batchedFilterEventPending = false,
      batchedFilterResetPending = false,
      transientFilterDepth = 0,
      brushDimSlot = null,
      brushSameDimCount = 0,
      brushActive = false,
      brushQueryKind = null,
      brushLo = 0,
      brushHi = 0,
      brushDimSource = null,
      brushFalcon = null,
      brushBuildFailed = false;

  function invalidateBrushState() {
    brushDimSlot = null;
    brushSameDimCount = 0;
    brushActive = false;
    brushQueryKind = null;
    brushDimSource = null;
    brushFalcon = null;
    brushBuildFailed = false;
  }

  function ensureUint32Capacity(buf, required) {
    if (buf.length >= required) return buf;
    var nextSize = buf.length || 256;
    while (nextSize < required) nextSize <<= 1;
    return new Uint32Array(nextSize);
  }

  var objToString = Object.prototype.toString;

  function isGuaranteedFiniteTypedArray(col) {
    if (!ArrayBuffer.isView(col)) return false;
    var tag = objToString.call(col);
    return tag === '[object Int32Array]'
      || tag === '[object Uint32Array]'
      || tag === '[object Int16Array]'
      || tag === '[object Uint16Array]'
      || tag === '[object Int8Array]'
      || tag === '[object Uint8Array]'
      || tag === '[object Uint8ClampedArray]';
  }

  function isFloatTypedArray(col) {
    if (!ArrayBuffer.isView(col)) return false;
    var tag = objToString.call(col);
    return tag === '[object Float64Array]' || tag === '[object Float32Array]';
  }

  function hasValidArrowNullBitmap(chunk) {
    if (!chunk || chunk.nullCount === 0) return true;
    if (!chunk.nullBitmap || typeof chunk.nullBitmap.length !== 'number') return false;
    var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
    return chunk.nullBitmap.length >= ((chunkOff + chunk.length + 7) >>> 3);
  }

  function resolveArrowDictionaryChunks(col) {
    if (!col || !Array.isArray(col.data) || !col.data.length) return null;
    var chunks = col.data;
    var total = 0;
    for (var c = 0; c < chunks.length; ++c) {
      var chunk = chunks[c];
      if (
        !chunk
        || !chunk.dictionary
        || typeof chunk.dictionary.get !== 'function'
        || typeof chunk.dictionary.length !== 'number'
        || !isGuaranteedFiniteTypedArray(chunk.values)
        || chunk.values.length < chunk.length
        || !hasValidArrowNullBitmap(chunk)
      ) {
        return null;
      }
      total += chunk.length;
    }
    if (typeof col.length === 'number' && total !== col.length) return null;
    return chunks;
  }

  function resolveArrowNumericChunks(col) {
    if (!col || !Array.isArray(col.data) || !col.data.length) return null;
    var colType = col.type || col.data[0].type;
    if (!colType) return null;
    var typeId = colType.typeId;
    if (typeId === 2) {
      if (!(colType.bitWidth > 0 && colType.bitWidth <= 32)) return null;
    } else if (typeId === 3) {
      if (!(colType.precision >= 1)) return null;
    } else {
      return null;
    }
    var chunks = col.data;
    var total = 0;
    for (var c = 0; c < chunks.length; ++c) {
      var chunk = chunks[c];
      if (
        !chunk
        || chunk.dictionary
        || !(isGuaranteedFiniteTypedArray(chunk.values) || isFloatTypedArray(chunk.values))
        || chunk.values.length < chunk.length
        || !hasValidArrowNullBitmap(chunk)
      ) {
        return null;
      }
      total += chunk.length;
    }
    if (typeof col.length === 'number' && total !== col.length) return null;
    return chunks;
  }

  function isBigIntTypedArray(col) {
    if (!ArrayBuffer.isView(col)) return false;
    var tag = objToString.call(col);
    return tag === '[object BigInt64Array]' || tag === '[object BigUint64Array]';
  }

  function resolveArrowTemporalChunks(col) {
    if (!col || !Array.isArray(col.data) || !col.data.length) return null;
    var colType = col.type || col.data[0].type;
    if (!colType) return null;
    var typeId = colType.typeId;
    if (typeId !== 8 && typeId !== 10) return null;
    var unit = typeof colType.unit === 'number' ? colType.unit : -1;
    var scaleMul = 1;
    var scaleDiv = 1;
    if (typeId === 8) {
      if (unit === 0) scaleMul = 86400000;
      else if (unit !== 1) return null;
    } else {
      if (unit === 0) scaleMul = 1000;
      else if (unit === 1) scaleMul = 1;
      else if (unit === 2) scaleDiv = 1000;
      else if (unit === 3) scaleDiv = 1000000;
      else return null;
    }
    var chunks = col.data;
    var total = 0;
    for (var c = 0; c < chunks.length; ++c) {
      var chunk = chunks[c];
      if (!chunk || chunk.dictionary || chunk.values == null || chunk.values.length < chunk.length || !hasValidArrowNullBitmap(chunk)) {
        return null;
      }
      if (typeId === 8 && unit === 0) {
        if (!isGuaranteedFiniteTypedArray(chunk.values)) return null;
      } else if (!isBigIntTypedArray(chunk.values) && !isGuaranteedFiniteTypedArray(chunk.values) && !isFloatTypedArray(chunk.values)) {
        return null;
      }
      total += chunk.length;
    }
    if (typeof col.length === 'number' && total !== col.length) return null;
    return { chunks: chunks, scaleDiv: scaleDiv, scaleMul: scaleMul };
  }

  function resolveArrowUtf8Chunks(col) {
    if (!utf8Decoder || !col || !Array.isArray(col.data) || !col.data.length) return null;
    var colType = col.type || col.data[0].type;
    if (!colType || colType.typeId !== 5) return null;
    var chunks = col.data;
    var total = 0;
    for (var c = 0; c < chunks.length; ++c) {
      var chunk = chunks[c];
      if (
        !chunk
        || !ArrayBuffer.isView(chunk.values)
        || !ArrayBuffer.isView(chunk.valueOffsets)
        || chunk.valueOffsets.length <= chunk.length
        || !hasValidArrowNullBitmap(chunk)
      ) {
        return null;
      }
      total += chunk.length;
    }
    if (typeof col.length === 'number' && total !== col.length) return null;
    return chunks;
  }

  function extractArrowUtf8Range(chunks, startOffset, length) {
    var out = new Array(length);
    var localEnd = startOffset + length;
    var chunkStart = 0;
    var outIdx = 0;
    for (var c = 0; c < chunks.length && outIdx < length; ++c) {
      var chunk = chunks[c];
      var chunkEnd = chunkStart + chunk.length;
      if (chunkEnd <= startOffset) {
        chunkStart = chunkEnd;
        continue;
      }
      if (chunkStart >= localEnd) break;
      var subStart = startOffset > chunkStart ? startOffset - chunkStart : 0;
      var subEnd = localEnd < chunkEnd ? localEnd - chunkStart : chunk.length;
      var vo = chunk.valueOffsets;
      var bytes = chunk.values;
      var base = vo[subStart];
      var end = vo[subEnd];
      var byteLen = end - base;
      var nullBitmap = chunk.nullCount > 0 ? chunk.nullBitmap : null;
      var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
      var asciiStr = null;
      if (utf8FatalDecoder && byteLen >= 0) {
        try {
          var decoded = utf8FatalDecoder.decode(bytes.subarray(base, end));
          if (decoded.length === byteLen) asciiStr = decoded;
        } catch (e) { /* fall back to per-entry UTF-8 decode */ }
      }
      var j, bitIdx;
      if (asciiStr !== null) {
        if (!nullBitmap) {
          for (j = subStart; j < subEnd; ++j) {
            out[outIdx++] = asciiStr.slice(vo[j] - base, vo[j + 1] - base);
          }
        } else {
          for (j = subStart; j < subEnd; ++j) {
            bitIdx = chunkOff + j;
            out[outIdx++] = (nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))
              ? asciiStr.slice(vo[j] - base, vo[j + 1] - base)
              : null;
          }
        }
      } else if (!nullBitmap) {
        for (j = subStart; j < subEnd; ++j) {
          out[outIdx++] = utf8Decoder.decode(bytes.subarray(vo[j], vo[j + 1]));
        }
      } else {
        for (j = subStart; j < subEnd; ++j) {
          bitIdx = chunkOff + j;
          out[outIdx++] = (nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))
            ? utf8Decoder.decode(bytes.subarray(vo[j], vo[j + 1]))
            : null;
        }
      }
      chunkStart = chunkEnd;
    }
    return outIdx === length ? out : null;
  }

  function isPureNumericColumnSource(field) {
    if (!n || !columnarBatches.length) return false;
    var expectedStart = 0;
    for (var b = 0; b < columnarBatches.length; ++b) {
      var batch = columnarBatches[b];
      if (batch.start !== expectedStart) return false;
      expectedStart = batch.end;
      var col = batch.columns[field];
      if (isFloatTypedArray(col) || isGuaranteedFiniteTypedArray(col)) {
        continue;
      }
      var arrowChunks = resolveArrowNumericChunks(col);
      if (arrowChunks) {
        for (var c = 0; c < arrowChunks.length; ++c) {
          if (arrowChunks[c].nullCount !== 0) {
            return false;
          }
        }
        continue;
      }
      var temporal = resolveArrowTemporalChunks(col);
      if (temporal) {
        for (var tc = 0; tc < temporal.chunks.length; ++tc) {
          if (temporal.chunks[tc].nullCount !== 0) {
            return false;
          }
        }
        continue;
      }
      return false;
    }
    return expectedStart === n;
  }

  function getActiveRows() {
    if (!filterStore.hasAnyActive()) {
      return null;
    }
    if (activeRowsDirty) {
      activeRowsBuf = ensureUint32Capacity(activeRowsBuf, n);
      var count = filterStore.extractActive(activeRowsBuf, null);
      if (count < 0) {
        activeRowsLength = n;
        activeCountCached = n;
        activeCountDirty = false;
        activeRowsDirty = false;
        return null;
      }
      activeRowsLength = count;
      activeCountCached = count;
      activeCountDirty = false;
      activeRowsDirty = false;
    }
    return { indices: activeRowsBuf, length: activeRowsLength };
  }

  function getExcludedRows(ignoreSlot) {
    if (!filterStore.hasAnyActive()) {
      return { indices: excludedRowsBuf, length: 0 };
    }
    excludedRowsBuf = ensureUint32Capacity(excludedRowsBuf, n);
    var count = filterStore.extractExcluded(excludedRowsBuf, ignoreSlot || null);
    return { indices: excludedRowsBuf, length: count };
  }

  function filteredCount() {
    if (!filterStore.hasAnyActive()) {
      return n;
    }
    if (!activeRowsDirty) {
      return activeRowsLength;
    }
    if (activeCountDirty) {
      if (brushActive && brushFalcon && transientFilterDepth === 0) {
        activeCountCached = brushFalcon.queryCount(brushQueryKind, brushLo, brushHi);
      } else {
        activeCountCached = filterStore.countActive(null);
      }
      activeCountDirty = false;
    }
    return activeCountCached;
  }

  function filteredIndexesSlice(startOffset, limitCount) {
    var start = startOffset && startOffset > 0 ? startOffset : 0;
    var limit = limitCount == null ? n : limitCount;
    var end, len, out, i;
    if (limit <= 0) {
      return [];
    }
    if (!filterStore.hasAnyActive()) {
      if (start >= n) return [];
      end = Math.min(n, start + limit);
      len = end - start;
      out = new Array(len);
      for (i = 0; i < len; ++i) out[i] = start + i;
      return out;
    }
    var active = getActiveRows();
    if (!active) {
      if (start >= n) return [];
      end = Math.min(n, start + limit);
      len = end - start;
      out = new Array(len);
      for (i = 0; i < len; ++i) out[i] = start + i;
      return out;
    }
    if (start >= active.length) return [];
    end = Math.min(active.length, start + limit);
    len = end - start;
    out = new Array(len);
    var indices = active.indices;
    for (i = 0; i < len; ++i) out[i] = indices[start + i];
    return out;
  }

  function collectZeroExceptRows(dimSlot) {
    dimActiveRowsBuf = ensureUint32Capacity(dimActiveRowsBuf, n);
    var count = filterStore.extractActive(dimActiveRowsBuf, dimSlot);
    if (count < 0) {
      return null;
    }
    return { indices: dimActiveRowsBuf, length: count };
  }

  function flushGroups(rawGroups, kpiGroup) {
    if (!n) return;
    var gLen = rawGroups ? rawGroups.length : 0;
    if (!gLen && !kpiGroup) return;

    var kpiInfo = (kpiGroup && typeof kpiGroup._coScanInfo === 'function') ? kpiGroup._coScanInfo() : null;
    var kpiUsed = false;

    // Falcon prefix-sum brush fast path (handles all low/medium-card charts + KPI in O(slots)!)
    if (brushActive && brushDimSlot && transientFilterDepth === 0) {
      var falconTargets = [];
      for (var fgi = 0; fgi < gLen; ++fgi) {
        var fg = rawGroups[fgi];
        if (!fg || typeof fg._coScanInfo !== 'function') continue;
        var finfo = fg._coScanInfo();
        if (finfo && finfo.usesGlobalActive) {
          falconTargets.push(finfo);
        }
      }
      var falconKpi = (kpiInfo && !kpiInfo.unfiltered) ? kpiInfo : null;
      if (!brushFalcon && !brushBuildFailed && (falconTargets.length > 0 || falconKpi)) {
        var baseRows = filterStore.hasOtherActive(brushDimSlot) ? collectZeroExceptRows(brushDimSlot) : null;
        brushFalcon = createFalconBrushCache(brushDimSource(), baseRows, n, falconTargets, falconKpi, getNumericColumn);
        if (!brushFalcon) {
          brushBuildFailed = true;
          brushActive = false;
        }
      }
      if (brushFalcon && (falconTargets.length > 0 || falconKpi)) {
        var fRes = brushFalcon.applyQueryBatch(brushQueryKind, brushLo, brushHi, falconTargets, falconKpi);
        activeCountCached = fRes.totalCount;
        activeCountDirty = false;
        if (fRes.kpiApplied) kpiUsed = true;
        if (fRes.appliedCount === falconTargets.length && (!falconKpi || fRes.kpiApplied)) {
          // Check if any unfiltered or self-filtered dirty groups still remain
          var anyRemaining = false;
          for (var rci = 0; rci < gLen; ++rci) {
            var rg = rawGroups[rci];
            if (rg && typeof rg._coScanInfo === 'function' && rg._coScanInfo()) {
              anyRemaining = true;
              break;
            }
          }
          if (!anyRemaining) return;
        }
      }
    }

    var unfilteredByKey = Object.create(null);
    var unfilteredKeys = [];
    var filteredByKey = Object.create(null);
    var filteredKeys = [];
    var i, info, key, list;

    for (i = 0; i < gLen; ++i) {
      var g = rawGroups[i];
      if (!g || typeof g._coScanInfo !== 'function') continue;
      info = g._coScanInfo();
      if (!info) continue;
      if (info.unfiltered) {
        if (info.tryRestoreUnfiltered()) {
          info.commit(false);
          continue;
        }
        key = info.coScanKey;
        list = unfilteredByKey[key];
        if (!list) {
          list = [];
          unfilteredByKey[key] = list;
          unfilteredKeys.push(key);
        }
        list.push(info);
      } else if (info.usesGlobalActive) {
        key = info.coScanKey;
        list = filteredByKey[key];
        if (!list) {
          list = [];
          filteredByKey[key] = list;
          filteredKeys.push(key);
        }
        list.push(info);
      }
    }

    for (i = 0; i < unfilteredKeys.length; ++i) {
      var uKey = unfilteredKeys[i];
      list = unfilteredByKey[uKey];
      var matchKpiUnf = null;
      if (kpiInfo && !kpiUsed && kpiInfo.unfiltered && kpiInfo.coScanKey === uKey) {
        if (kpiInfo.tryRestoreUnfiltered()) {
          kpiInfo.commit(false);
          kpiUsed = true;
        } else {
          kpiInfo.prepareZero();
          matchKpiUnf = kpiInfo;
          kpiUsed = true;
        }
      }
      if (list.length >= 2 || matchKpiUnf) {
        for (var ui = 0; ui < list.length; ++ui) list[ui].prepareZero();
        reduceMultiGroupsAll(list, matchKpiUnf ? matchKpiUnf.buffers : null, list[0].plan, getNumericColumn, n);
        for (var uc = 0; uc < list.length; ++uc) list[uc].commit(true);
        if (matchKpiUnf) matchKpiUnf.commit(true);
      }
    }

    if (filteredKeys.length > 0) {
      var activeCnt = filteredCount();
      if (activeCnt === 0) {
        for (i = 0; i < filteredKeys.length; ++i) {
          list = filteredByKey[filteredKeys[i]];
          for (var zi = 0; zi < list.length; ++zi) {
            list[zi].prepareZero();
            list[zi].commit(false);
          }
        }
        if (kpiInfo && !kpiUsed && !kpiInfo.unfiltered) {
          kpiInfo.prepareZero();
          kpiInfo.commit(false);
          kpiUsed = true;
        }
        return;
      }

      var tryComp = activeCnt > (n >>> 1);
      var activeRows = null;
      var excludedRows = null;

      for (i = 0; i < filteredKeys.length; ++i) {
        var fKey = filteredKeys[i];
        list = filteredByKey[fKey];
        var plan = list[0].plan;
        var canCompPlan = tryComp && canPlanUseComplement(plan, getNumericColumn);

        var compList = null;
        var directList = null;
        if (canCompPlan) {
          compList = [];
          directList = [];
          for (var fi = 0; fi < list.length; ++fi) {
            if (list[fi].canComplement()) compList.push(list[fi]);
            else directList.push(list[fi]);
          }
        } else {
          directList = list;
        }

        if (compList && compList.length > 0) {
          if (activeCnt === n) {
            for (var ri = 0; ri < compList.length; ++ri) {
              compList[ri].tryRestoreUnfiltered();
              compList[ri].commit(false);
            }
            if (kpiInfo && !kpiUsed && !kpiInfo.unfiltered && kpiInfo.coScanKey === fKey && kpiInfo.canComplement()) {
              kpiInfo.tryRestoreUnfiltered();
              kpiInfo.commit(false);
              kpiUsed = true;
            }
          } else {
            var matchKpiComp = null;
            if (kpiInfo && !kpiUsed && !kpiInfo.unfiltered && kpiInfo.coScanKey === fKey && kpiInfo.canComplement()) {
              kpiInfo.tryRestoreUnfiltered(true);
              matchKpiComp = kpiInfo;
              kpiUsed = true;
            }
            if (compList.length >= 2 || matchKpiComp) {
              if (!excludedRows) excludedRows = getExcludedRows(null);
              for (var ci = 0; ci < compList.length; ++ci) compList[ci].tryRestoreUnfiltered(true);
              reduceMultiGroupsIndexed(compList, matchKpiComp ? matchKpiComp.buffers : null, plan, getNumericColumn, excludedRows.indices, excludedRows.length, -1);
              for (var cc = 0; cc < compList.length; ++cc) {
                compList[cc].cleanupComplement(excludedRows.indices, excludedRows.length);
                compList[cc].commit(false);
              }
              if (matchKpiComp) matchKpiComp.commit(false);
            }
          }
        }

        if (directList && directList.length > 0) {
          var matchKpiDir = null;
          if (kpiInfo && !kpiUsed && !kpiInfo.unfiltered && kpiInfo.coScanKey === fKey) {
            kpiInfo.prepareZero();
            matchKpiDir = kpiInfo;
            kpiUsed = true;
          }
          if (directList.length >= 2 || matchKpiDir) {
            if (!activeRows) activeRows = getActiveRows();
            if (activeRows) {
              for (var di = 0; di < directList.length; ++di) directList[di].prepareZero();
              reduceMultiGroupsIndexed(directList, matchKpiDir ? matchKpiDir.buffers : null, plan, getNumericColumn, activeRows.indices, activeRows.length, 1);
              for (var dc = 0; dc < directList.length; ++dc) directList[dc].commit(false);
              if (matchKpiDir) matchKpiDir.commit(false);
            }
          }
        }
      }
    }
  }

  function fillNumericFromRows(dest, entry, field, start, end) {
    var i, row, raw;
    for (i = start; i < end; ++i) {
      row = getRecord(i);
      raw = row ? row[field] : undefined;
      if (typeof raw === 'number' && raw === raw && raw !== Infinity && raw !== -Infinity) {
        dest[i] = raw;
        if (raw > 1e12 || raw < -1e12) entry.hasExtreme = true;
      } else {
        dest[i] = NaN;
        entry.hasNaN = true;
      }
    }
  }

  function getNumericColumn(field) {
    var entry = numericColumns[field];
    if (!entry) {
      if (n > 0 && columnarBatches.length === 1 && columnarBatches[0].start === 0 && columnarBatches[0].end === n) {
        var onlyCol = columnarBatches[0].columns[field];
        var directF64 = null;
        if (ArrayBuffer.isView(onlyCol) && objToString.call(onlyCol) === '[object Float64Array]') {
          directF64 = onlyCol;
        } else {
          var onlyArrow = resolveArrowNumericChunks(onlyCol);
          if (onlyArrow && onlyArrow.length === 1 && onlyArrow[0].nullCount === 0 && objToString.call(onlyArrow[0].values) === '[object Float64Array]') {
            directF64 = onlyArrow[0].values;
          }
        }
        if (directF64 && directF64.length >= n) {
          var nonFiniteFound = false;
          var extremeFound = false;
          for (var fi = 0; fi < n; ++fi) {
            var fv = directF64[fi];
            if (fv - fv !== 0) {
              nonFiniteFound = true;
              break;
            }
            if (fv > 1e12 || fv < -1e12) extremeFound = true;
          }
          if (!nonFiniteFound) {
            entry = { values: directF64, hasNaN: false, hasExtreme: extremeFound, length: n, shared: true };
            numericColumns[field] = entry;
            return entry;
          }
        }
      }
      var initCap = n < 64 ? 64 : n;
      entry = { values: new Float64Array(initCap), hasNaN: false, hasExtreme: false, length: 0, shared: false };
      numericColumns[field] = entry;
    }
    if (entry.length >= n) {
      return entry;
    }

    var values = entry.values;
    if (entry.shared || values.length < n) {
      var nextCap = values.length || 64;
      while (nextCap < n) nextCap <<= 1;
      var nextValues = new Float64Array(nextCap);
      if (entry.length > 0) {
        nextValues.set(values.subarray(0, entry.length));
      }
      values = entry.values = nextValues;
      entry.shared = false;
    }

    var cursor = entry.length;
    if (!columnarBatches.length) {
      fillNumericFromRows(values, entry, field, cursor, n);
      entry.length = n;
      return entry;
    }

    var batchIndex, batch, segStart, segEnd, localStart, localEnd, col, accessor, i, v, raw;
    for (batchIndex = 0; batchIndex < columnarBatches.length && cursor < n; ++batchIndex) {
      batch = columnarBatches[batchIndex];
      if (batch.end <= cursor) continue;
      if (batch.start >= n) break;
      if (cursor < batch.start) {
        var gapEnd = Math.min(batch.start, n);
        fillNumericFromRows(values, entry, field, cursor, gapEnd);
        cursor = gapEnd;
        if (cursor >= n) break;
      }

      segStart = Math.max(cursor, batch.start);
      segEnd = Math.min(batch.end, n);
      localStart = segStart - batch.start;
      localEnd = segEnd - batch.start;
      col = batch.columns[field];

      if (col != null && isGuaranteedFiniteTypedArray(col)) {
        values.set(col.subarray(localStart, localEnd), segStart);
      } else if (isFloatTypedArray(col)) {
        for (i = localStart; i < localEnd; ++i) {
          v = col[i];
          if (v - v === 0) {
            values[segStart + i - localStart] = v;
            if (v > 1e12 || v < -1e12) entry.hasExtreme = true;
          } else {
            values[segStart + i - localStart] = NaN;
            entry.hasNaN = true;
          }
        }
      } else if (Array.isArray(col)) {
        for (i = localStart; i < localEnd; ++i) {
          raw = col[i];
          if (typeof raw === 'number' && raw - raw === 0) {
            values[segStart + i - localStart] = raw;
            if (raw > 1e12 || raw < -1e12) entry.hasExtreme = true;
          } else {
            values[segStart + i - localStart] = NaN;
            entry.hasNaN = true;
          }
        }
      } else {
        var arrowNumChunks = resolveArrowNumericChunks(col);
        if (arrowNumChunks) {
          var chunkStart = 0;
          for (var cIdx = 0; cIdx < arrowNumChunks.length; ++cIdx) {
            var numChunk = arrowNumChunks[cIdx];
            var chunkEnd = chunkStart + numChunk.length;
            if (chunkEnd <= localStart) {
              chunkStart = chunkEnd;
              continue;
            }
            if (chunkStart >= localEnd) break;
            var subStart = localStart > chunkStart ? localStart - chunkStart : 0;
            var subEnd = localEnd < chunkEnd ? localEnd - chunkStart : numChunk.length;
            var dstBase = segStart + (chunkStart + subStart - localStart);
            var chunkVals = numChunk.values;
            if (numChunk.nullCount === 0) {
              if (isGuaranteedFiniteTypedArray(chunkVals)) {
                values.set(chunkVals.subarray(subStart, subEnd), dstBase);
              } else {
                for (i = subStart; i < subEnd; ++i) {
                  v = chunkVals[i];
                  if (v - v === 0) {
                    values[dstBase + i - subStart] = v;
                    if (v > 1e12 || v < -1e12) entry.hasExtreme = true;
                  } else {
                    values[dstBase + i - subStart] = NaN;
                    entry.hasNaN = true;
                  }
                }
              }
            } else {
              var numNullBitmap = numChunk.nullBitmap;
              var numChunkOff = typeof numChunk.offset === 'number' ? numChunk.offset : 0;
              var isIntChunk = isGuaranteedFiniteTypedArray(chunkVals);
              for (i = subStart; i < subEnd; ++i) {
                var numBitIdx = numChunkOff + i;
                if (!(numNullBitmap[numBitIdx >>> 3] & (1 << (numBitIdx & 7)))) {
                  values[dstBase + i - subStart] = NaN;
                  entry.hasNaN = true;
                } else {
                  v = chunkVals[i];
                  if (isIntChunk || v - v === 0) {
                    values[dstBase + i - subStart] = v;
                    if (!isIntChunk && (v > 1e12 || v < -1e12)) entry.hasExtreme = true;
                  } else {
                    values[dstBase + i - subStart] = NaN;
                    entry.hasNaN = true;
                  }
                }
              }
            }
            chunkStart = chunkEnd;
          }
        } else {
          var arrowTemporal = resolveArrowTemporalChunks(col);
          if (arrowTemporal) {
            var tChunks = arrowTemporal.chunks;
            var tMul = arrowTemporal.scaleMul;
            var tDiv = arrowTemporal.scaleDiv;
            var tChunkStart = 0;
            for (var tcIdx = 0; tcIdx < tChunks.length; ++tcIdx) {
              var tChunk = tChunks[tcIdx];
              var tChunkEnd = tChunkStart + tChunk.length;
              if (tChunkEnd <= localStart) {
                tChunkStart = tChunkEnd;
                continue;
              }
              if (tChunkStart >= localEnd) break;
              var tSubStart = localStart > tChunkStart ? localStart - tChunkStart : 0;
              var tSubEnd = localEnd < tChunkEnd ? localEnd - tChunkStart : tChunk.length;
              var tDstBase = segStart + (tChunkStart + tSubStart - localStart);
              var tVals = tChunk.values;
              var tIsBig = isBigIntTypedArray(tVals);
              if (tChunk.nullCount === 0) {
                for (i = tSubStart; i < tSubEnd; ++i) {
                  v = tIsBig ? Number(tVals[i]) : tVals[i];
                  if (tMul !== 1) v *= tMul;
                  else if (tDiv !== 1) v /= tDiv;
                  if (v - v === 0) {
                    values[tDstBase + i - tSubStart] = v;
                    if (v > 1e12 || v < -1e12) entry.hasExtreme = true;
                  } else {
                    values[tDstBase + i - tSubStart] = NaN;
                    entry.hasNaN = true;
                  }
                }
              } else {
                var tNullBitmap = tChunk.nullBitmap;
                var tChunkOff = typeof tChunk.offset === 'number' ? tChunk.offset : 0;
                for (i = tSubStart; i < tSubEnd; ++i) {
                  var tBitIdx = tChunkOff + i;
                  if (!(tNullBitmap[tBitIdx >>> 3] & (1 << (tBitIdx & 7)))) {
                    values[tDstBase + i - tSubStart] = NaN;
                    entry.hasNaN = true;
                  } else {
                    v = tIsBig ? Number(tVals[i]) : tVals[i];
                    if (tMul !== 1) v *= tMul;
                    else if (tDiv !== 1) v /= tDiv;
                    if (v - v === 0) {
                      values[tDstBase + i - tSubStart] = v;
                      if (v > 1e12 || v < -1e12) entry.hasExtreme = true;
                    } else {
                      values[tDstBase + i - tSubStart] = NaN;
                      entry.hasNaN = true;
                    }
                  }
                }
              }
              tChunkStart = tChunkEnd;
            }
          } else if (batch.accessors && batch.accessors[field]) {
            accessor = batch.accessors[field];
            for (i = localStart; i < localEnd; ++i) {
              raw = accessor(i);
              if (typeof raw === 'number' && raw - raw === 0) {
                values[segStart + i - localStart] = raw;
                if (raw > 1e12 || raw < -1e12) entry.hasExtreme = true;
              } else {
                values[segStart + i - localStart] = NaN;
                entry.hasNaN = true;
              }
            }
          } else if (col != null) {
            for (i = localStart; i < localEnd; ++i) {
              raw = getColumnValue(col, i);
              if (typeof raw === 'number' && raw - raw === 0) {
                values[segStart + i - localStart] = raw;
                if (raw > 1e12 || raw < -1e12) entry.hasExtreme = true;
              } else {
                values[segStart + i - localStart] = NaN;
                entry.hasNaN = true;
              }
            }
          } else {
            for (i = segStart; i < segEnd; ++i) {
              values[i] = NaN;
            }
            entry.hasNaN = true;
          }
        }
      }

      cursor = segEnd;
    }

    if (cursor < n) {
      fillNumericFromRows(values, entry, field, cursor, n);
    }

    entry.length = n;
    return entry;
  }

  function encodeSplitValue(entry, raw) {
    var key = (raw == null || raw === '') ? '__unknown__' : (typeof raw === 'string' ? raw : String(raw));
    var code = entry.valueToCode.get(key);
    if (code === undefined) {
      code = entry.codeToKey.length;
      entry.valueToCode.set(key, code);
      entry.codeToKey.push(key);
    }
    return code;
  }

  function fillSplitFromRows(dest, entry, field, start, end) {
    var i, row;
    for (i = start; i < end; ++i) {
      row = getRecord(i);
      dest[i] = encodeSplitValue(entry, row ? row[field] : undefined);
    }
  }

  function getSplitColumn(field) {
    var entry = splitColumns[field];
    if (!entry) {
      var initCap = n < 64 ? 64 : n;
      entry = {
        codes: new Uint32Array(initCap),
        codeToKey: [],
        dimCodeToSplit: null,
        dimState: null,
        length: 0,
        valueToCode: new Map()
      };
      splitColumns[field] = entry;
    }
    if (entry.length >= n) {
      return entry;
    }

    var codes = entry.codes;
    if (codes.length < n) {
      var nextCap = codes.length || 64;
      while (nextCap < n) nextCap <<= 1;
      var nextCodes = new Uint32Array(nextCap);
      if (entry.length > 0) {
        nextCodes.set(codes.subarray(0, entry.length));
      }
      codes = entry.codes = nextCodes;
    }

    var cursor = entry.length;

    // Item 5: Reuse an existing lazyEncodedState on `field` instead of re-hashing strings!
    var dimRefs = lazyDimensionsByField[field];
    if (dimRefs && dimRefs.length) {
      var dimState = null;
      for (var dri = 0; dri < dimRefs.length; ++dri) {
        var candidate = dimRefs[dri]();
        if (candidate && candidate.codesLength === n) {
          dimState = candidate;
          break;
        }
      }
      if (dimState) {
        var dimCodeToValue = dimState.codeToValue;
        var dimCodeLen = dimCodeToValue.length;
        var dimMap = entry.dimState === dimState ? entry.dimCodeToSplit : null;
        if (!dimMap || dimMap.length < dimCodeLen) {
          var nextMapCap = (dimMap && dimMap.length) ? dimMap.length : 64;
          while (nextMapCap < dimCodeLen) nextMapCap <<= 1;
          var nextDimMap = new Int32Array(nextMapCap);
          nextDimMap.fill(-1);
          if (dimMap) nextDimMap.set(dimMap);
          dimMap = entry.dimCodeToSplit = nextDimMap;
          entry.dimState = dimState;
        }
        var dimCodes = dimState.codes;
        var dc, scCode;
        for (var di = cursor; di < n; ++di) {
          dc = dimCodes[di];
          scCode = dimMap[dc];
          if (scCode < 0) {
            scCode = dimMap[dc] = encodeSplitValue(entry, dimCodeToValue[dc]);
          }
          codes[di] = scCode;
        }
        entry.length = n;
        return entry;
      }
    }

    if (!columnarBatches.length) {
      fillSplitFromRows(codes, entry, field, cursor, n);
      entry.length = n;
      return entry;
    }

    var batchIndex, batch, segStart, segEnd, localStart, localEnd, col, accessor, i;
    for (batchIndex = 0; batchIndex < columnarBatches.length && cursor < n; ++batchIndex) {
      batch = columnarBatches[batchIndex];
      if (batch.end <= cursor) continue;
      if (batch.start >= n) break;
      if (cursor < batch.start) {
        var gapEnd = Math.min(batch.start, n);
        fillSplitFromRows(codes, entry, field, cursor, gapEnd);
        cursor = gapEnd;
        if (cursor >= n) break;
      }

      segStart = Math.max(cursor, batch.start);
      segEnd = Math.min(batch.end, n);
      localStart = segStart - batch.start;
      localEnd = segEnd - batch.start;
      col = batch.columns[field];

      if (Array.isArray(col) || ArrayBuffer.isView(col)) {
        for (i = localStart; i < localEnd; ++i) {
          codes[segStart + i - localStart] = encodeSplitValue(entry, col[i]);
        }
      } else {
        var splitDictChunks = resolveArrowDictionaryChunks(col);
        if (splitDictChunks) {
          var sChunkStart = 0;
          for (var scIdx = 0; scIdx < splitDictChunks.length; ++scIdx) {
            var sChunk = splitDictChunks[scIdx];
            var sChunkEnd = sChunkStart + sChunk.length;
            if (sChunkEnd <= localStart) {
              sChunkStart = sChunkEnd;
              continue;
            }
            if (sChunkStart >= localEnd) break;
            var sSubStart = localStart > sChunkStart ? localStart - sChunkStart : 0;
            var sSubEnd = localEnd < sChunkEnd ? localEnd - sChunkStart : sChunk.length;
            var sDstBase = segStart + (sChunkStart + sSubStart - localStart);
            var sDict = sChunk.dictionary;
            var sDictToCode = new Int32Array(sDict.length);
            sDictToCode.fill(-1);
            var sIndices = sChunk.values;
            var sDIdx, sCode;
            if (sChunk.nullCount === 0) {
              for (i = sSubStart; i < sSubEnd; ++i) {
                sDIdx = sIndices[i];
                sCode = sDictToCode[sDIdx];
                if (sCode < 0) {
                  sCode = sDictToCode[sDIdx] = encodeSplitValue(entry, sDict.get(sDIdx));
                }
                codes[sDstBase + i - sSubStart] = sCode;
              }
            } else {
              var sNullBitmap = sChunk.nullBitmap;
              var sChunkOff = typeof sChunk.offset === 'number' ? sChunk.offset : 0;
              var sNullCode = -1;
              for (i = sSubStart; i < sSubEnd; ++i) {
                var sBitIdx = sChunkOff + i;
                if (!(sNullBitmap[sBitIdx >>> 3] & (1 << (sBitIdx & 7)))) {
                  if (sNullCode < 0) sNullCode = encodeSplitValue(entry, null);
                  codes[sDstBase + i - sSubStart] = sNullCode;
                } else {
                  sDIdx = sIndices[i];
                  sCode = sDictToCode[sDIdx];
                  if (sCode < 0) {
                    sCode = sDictToCode[sDIdx] = encodeSplitValue(entry, sDict.get(sDIdx));
                  }
                  codes[sDstBase + i - sSubStart] = sCode;
                }
              }
            }
            sChunkStart = sChunkEnd;
          }
        } else {
          var splitUtf8Chunks = resolveArrowUtf8Chunks(col);
          var splitUtf8Vals = splitUtf8Chunks ? extractArrowUtf8Range(splitUtf8Chunks, localStart, localEnd - localStart) : null;
          if (splitUtf8Vals) {
            for (i = 0; i < splitUtf8Vals.length; ++i) {
              codes[segStart + i] = encodeSplitValue(entry, splitUtf8Vals[i]);
            }
          } else if (batch.accessors && batch.accessors[field]) {
            accessor = batch.accessors[field];
            for (i = localStart; i < localEnd; ++i) {
              codes[segStart + i - localStart] = encodeSplitValue(entry, accessor(i));
            }
          } else if (col != null) {
            for (i = localStart; i < localEnd; ++i) {
              codes[segStart + i - localStart] = encodeSplitValue(entry, getColumnValue(col, i));
            }
          } else {
            var unknownCode = encodeSplitValue(entry, undefined);
            codes.fill(unknownCode, segStart, segEnd);
          }
        }
      }

      cursor = segEnd;
    }

    if (cursor < n) {
      fillSplitFromRows(codes, entry, field, cursor, n);
    }

    entry.length = n;
    return entry;
  }

  function appendData(newData) {
    var offset = data.length;
    data.length = offset + newData.length;
    var batch = getColumnarBatch(newData);
    if (batch) {
      for (var key in batch.rows) {
        if (Object.prototype.hasOwnProperty.call(batch.rows, key)) {
          data[offset + Number(key)] = batch.rows[key];
          anyRowMaterialized = true;
        }
      }
      return;
    }
    if (newData.length) {
      anyRowMaterialized = true;
    }
    for (var i = 0; i < newData.length; ++i) {
      data[offset + i] = newData[i];
    }
  }

  function rememberColumnarBatch(newData, n0, n1) {
    var batch = getColumnarBatch(newData);
    if (!batch) {
      return;
    }

    columnarBatches.push({
      batch: batch,
      accessors: batch.accessorsByField,
      columns: batch.columns,
      start: n0,
      end: n0 + n1
    });
  }

  function findColumnarBatch(rowIndex) {
    if (columnarBatches.length === 1) {
      var onlyBatch = columnarBatches[0];
      return rowIndex >= onlyBatch.start && rowIndex < onlyBatch.end
        ? onlyBatch
        : null;
    }

    var lo = 0,
        hi = columnarBatches.length;

    while (lo < hi) {
      var mid = lo + hi >>> 1,
          batch = columnarBatches[mid];
      if (rowIndex < batch.start) hi = mid;
      else if (rowIndex >= batch.end) lo = mid + 1;
      else return batch;
    }

    return null;
  }

  function hasAnyActiveDimensionFilters() {
    return filterStore.hasAnyActive();
  }

  function registerResetListener(listener) {
    resetListeners.push(listener);
    return listener;
  }

  function unregisterResetListener(listener) {
    var listenerIndex = resetListeners.indexOf(listener);
    if (listenerIndex >= 0) {
      resetListeners.splice(listenerIndex, 1);
    }
  }

  function markFilterListenersDirty() {
    if (batchedFilterResetPending) {
      return;
    }
    batchedFilterResetPending = true;
    for (var listenerIndex = 0; listenerIndex < resetListeners.length; ++listenerIndex) {
      resetListeners[listenerIndex]();
    }
  }

  // Returns:
  //   0 = no active filter listener outside dimSlot
  //   1 = at least one other listener exists, and ALL are built-in resettable groups
  //   2 = at least one other listener requires exact added/removed delta arrays
  function inspectOtherFilterListeners(dimSlot) {
    var hasResettable = false;
    for (var i = 0; i < filterListeners.length; ++i) {
      var l = filterListeners[i];
      if (l === cr_null) continue;
      if (l._xfilterDimSlot === dimSlot) continue;
      if (l._xfilterResettable === true) {
        hasResettable = true;
      } else {
        return 2;
      }
    }
    return hasResettable ? 1 : 0;
  }

  function notifyFilterListeners(filterSlot, added, removed, forceReset) {
    activeRowsDirty = true;
    activeCountDirty = true;
    if (filterSlot !== brushDimSlot) {
      invalidateBrushState();
    }
    if (transientFilterDepth > 0) {
      return;
    }
    if (batchedFilterDepth > 0) {
      batchedFilterEventPending = true;
      markFilterListenersDirty();
      return;
    }

    var li;
    if (forceReset) {
      for (li = 0; li < filterListeners.length; ++li) {
        filterListeners[li](filterSlot, added, removed, false, true);
      }
    } else {
      for (li = 0; li < filterListeners.length; ++li) {
        filterListeners[li](filterSlot, added, removed);
      }
    }
    triggerOnChange('filtered');
  }

  function flushBatchedFilterEvents() {
    if (!batchedFilterEventPending) {
      return;
    }
    batchedFilterEventPending = false;
    batchedFilterResetPending = false;
    triggerOnChange('filtered');
  }

  function batch(callback) {
    batchedFilterDepth += 1;
    try {
      return callback();
    } finally {
      batchedFilterDepth -= 1;
      if (!batchedFilterDepth) {
        flushBatchedFilterEvents();
      }
    }
  }

  function withTransientFilters(callback) {
    filterStore.ensureMaterialized(null);
    invalidateBrushState();
    transientFilterDepth += 1;
    try {
      return callback();
    } finally {
      transientFilterDepth -= 1;
      activeRowsDirty = true;
      activeCountDirty = true;
    }
  }

  function getRecord(rowIndex) {
    var row = data[rowIndex];
    if (row !== undefined) {
      return row;
    }

    if (!columnarBatches.length) {
      return rowIndex in data ? row : undefined;
    }

    var batch = findColumnarBatch(rowIndex);
    if (!batch) {
      return rowIndex in data ? row : undefined;
    }

    var batchRowIndex = rowIndex - batch.start;
    if (batch.batch.materialized && batch.batch.materialized[batchRowIndex]) {
      row = batch.batch.rows[batchRowIndex];
    } else {
      row = materializeColumnarRow(batch.batch, batchRowIndex);
    }
    data[rowIndex] = row;
    anyRowMaterialized = true;
    return row;
  }

  function materializeRowsByIndex(rowIndexes, fields) {
    var len = rowIndexes ? rowIndexes.length : 0;
    var out = new Array(len);
    var i, j, projected;
    if (!fields || !fields.length) {
      for (i = 0; i < len; ++i) {
        out[i] = getRecord(rowIndexes[i]);
      }
      return out;
    }
    var taken = takeColumns(rowIndexes, fields);
    var cols = taken.columns;
    var fieldCount = fields.length;
    var colList = new Array(fieldCount);
    for (j = 0; j < fieldCount; ++j) {
      colList[j] = cols[fields[j]];
    }
    for (i = 0; i < len; ++i) {
      projected = {};
      for (j = 0; j < fieldCount; ++j) {
        projected[fields[j]] = colList[j][i];
      }
      out[i] = projected;
    }
    return out;
  }

  function getFieldValue(rowIndex, field) {
    var row = data[rowIndex];
    if (row !== undefined) {
      return row ? row[field] : undefined;
    }

    if (columnarBatches.length) {
      var batch = findColumnarBatch(rowIndex);
      if (batch) {
        var batchRowIndex = rowIndex - batch.start;
        if (batch.accessors && batch.accessors[field]) {
          return batch.accessors[field](batchRowIndex);
        }
        if (Object.prototype.hasOwnProperty.call(batch.columns, field)) {
          return getColumnValue(batch.columns[field], batchRowIndex);
        }
      }
    }

    row = getRecord(rowIndex);
    return row ? row[field] : undefined;
  }

  function resolveReduceMetricSpec(add, remove, initial) {
    var metricSpec = add && add._xfilterMetricSpec;
    if (!metricSpec || metricSpec !== (remove && remove._xfilterMetricSpec) || metricSpec !== (initial && initial._xfilterMetricSpec)) {
      return null;
    }
    var splitField = add._xfilterSplitField || null;
    if (splitField && (splitField !== remove._xfilterSplitField || splitField !== initial._xfilterSplitField)) {
      return null;
    }
    return {
      metrics: metricSpec,
      splitField: splitField
    };
  }

  function materializeAllRecords() {
    if (!columnarBatches.length) {
      return;
    }
    for (var rowIndex = 0; rowIndex < n; ++rowIndex) {
      getRecord(rowIndex);
    }
  }

  function copyFieldValuesFromRows(target, targetOffset, field, start, end) {
    for (var i = start; i < end; ++i) {
      target[targetOffset++] = getRecord(i)[field];
    }
    return targetOffset;
  }

  function extractColumnValues(field, start, count) {
    if (!count) {
      return [];
    }

    var values = new Array(count),
        cursor = start,
        targetOffset = 0,
        end = start + count;

    if (!columnarBatches.length) {
      copyFieldValuesFromRows(values, 0, field, start, end);
      return values;
    }

    for (var batchIndex = 0; batchIndex < columnarBatches.length && cursor < end; ++batchIndex) {
      var batch = columnarBatches[batchIndex];

      if (batch.end <= cursor) {
        continue;
      }

      if (batch.start >= end) {
        break;
      }

      if (cursor < batch.start) {
        var gapEnd = Math.min(batch.start, end);
        targetOffset = copyFieldValuesFromRows(values, targetOffset, field, cursor, gapEnd);
        cursor = gapEnd;
        if (cursor >= end) {
          break;
        }
      }

      var segmentStart = Math.max(cursor, batch.start),
          segmentEnd = Math.min(batch.end, end),
          accessor = batch.accessors && batch.accessors[field],
          column = batch.columns[field];

      if (accessor) {
        for (var valueIndex = segmentStart; valueIndex < segmentEnd; ++valueIndex) {
          values[targetOffset++] = accessor(valueIndex - batch.start);
        }
      } else if (column != null) {
        for (var valueIndex = segmentStart; valueIndex < segmentEnd; ++valueIndex) {
          values[targetOffset++] = getColumnValue(column, valueIndex - batch.start);
        }
      } else {
        targetOffset = copyFieldValuesFromRows(values, targetOffset, field, segmentStart, segmentEnd);
      }

      cursor = segmentEnd;
    }

    if (cursor < end) {
      copyFieldValuesFromRows(values, targetOffset, field, cursor, end);
    }

    return values;
  }

  function findSingleColumnAccessorSegment(field, start, count) {
    if (!count || !columnarBatches.length) {
      return null;
    }

    var end = start + count;

    for (var batchIndex = 0; batchIndex < columnarBatches.length; ++batchIndex) {
      var batch = columnarBatches[batchIndex];

      if (batch.end <= start) {
        continue;
      }

      if (batch.start > start) {
        return null;
      }

      if (batch.end < end) {
        return null;
      }

      var directColumn = batch.columns[field];
      var isDirectIndexable = Array.isArray(directColumn) || ArrayBuffer.isView(directColumn);
      var arrowDictChunks = !isDirectIndexable ? resolveArrowDictionaryChunks(directColumn) : null;
      var arrowUtf8Chunks = !isDirectIndexable && !arrowDictChunks ? resolveArrowUtf8Chunks(directColumn) : null;
      if (!isDirectIndexable && !arrowDictChunks && !arrowUtf8Chunks && (!batch.accessors || !batch.accessors[field])) {
        return null;
      }

      return {
        accessor: batch.accessors ? batch.accessors[field] : null,
        arrowDictChunks: arrowDictChunks,
        arrowUtf8Chunks: arrowUtf8Chunks,
        column: isDirectIndexable ? directColumn : null,
        offset: start - batch.start
      };
    }

    return null;
  }

  // Adds the specified new records to this crossfilter.
  function add(newData) {
    var n0 = n,
        n1 = newData.length;

    // If there's actually new data to add…
    // Merge the new data into the existing data.
    // Lengthen the filter bitset to handle the new records.
    // Notify listeners (dimensions and groups) that new data is available.
    if (n1) {
      invalidateBrushState();
      appendData(newData);
      rememberColumnarBatch(newData, n0, n1);
      filterStore.lengthen(n += n1);
      activeRowsDirty = true;
      activeCountDirty = true;
      dataListeners.forEach(function(l) { l(newData, n0, n1); });
      triggerOnChange('dataAdded');
    }

    return crossfilter;
  }

  function canCompactColumnarOnRemove() {
    if (!columnarBatches.length || anyRowMaterialized) return false;
    var expectedStart = 0;
    for (var b = 0; b < columnarBatches.length; ++b) {
      var cb = columnarBatches[b];
      if (cb.start !== expectedStart) return false;
      if (!cb.batch || !cb.batch.rowFactory || !cb.batch.rowFactory._xfilterDefaultRowFactory) return false;
      expectedStart = cb.end;
    }
    return expectedStart === n;
  }

  function collectColumnarFields() {
    var seen = Object.create(null);
    var fields = [];
    for (var b = 0; b < columnarBatches.length; ++b) {
      var batchFields = columnarBatches[b].batch.fields;
      for (var f = 0; f < batchFields.length; ++f) {
        var name = batchFields[f];
        if (!seen[name]) {
          seen[name] = true;
          fields.push(name);
        }
      }
    }
    return fields;
  }

  // Removes all records that match the current filters, or if a predicate function is passed,
  // removes all records matching the predicate (ignoring filters).
  function removeData(predicate) {
    filterStore.ensureMaterialized(null);
    invalidateBrushState();
    var usePred = typeof predicate === 'function',
        indexOnlyPred = !usePred || predicate._xfilterIndexOnly === true,
        compactColumnar = indexOnlyPred && canCompactColumnarOnRemove();

    if (!compactColumnar) {
      materializeAllRecords();
    }

    var // Mapping from old record indexes to new indexes (after records removed)
        newIndex = new Array(n),
        removed = [],
        keptIndexes = compactColumnar ? new Uint32Array(n) : null,
        keptCount = 0;

    if (compactColumnar) {
      for (var ci = 0; ci < n; ++ci) {
        var dropRow = usePred ? predicate(undefined, ci) : filterStore.isActive(ci);
        if (dropRow) {
          removed.push(ci);
          newIndex[ci] = REMOVED_INDEX;
        } else {
          newIndex[ci] = keptCount;
          keptIndexes[keptCount++] = ci;
        }
      }
    } else {
      for (var index1 = 0, index2 = 0; index1 < n; ++index1) {
        if (usePred ? predicate(getRecord(index1), index1) : filterStore.isActive(index1)) {
          removed.push(index1);
          newIndex[index1] = REMOVED_INDEX;
        } else {
          newIndex[index1] = index2++;
        }
      }
    }

    // Build compacted columnar batch BEFORE notifying listeners & rewriting filters/data
    var nextColumnarBatch = null;
    if (compactColumnar && keptCount > 0) {
      var allFields = collectColumnarFields();
      var compacted = takeColumns(keptIndexes.subarray(0, keptCount), allFields);
      var compactedProxy = rowsFromColumns(compacted.columns, { fields: allFields, length: keptCount });
      var compactedMeta = getColumnarBatch(compactedProxy);
      nextColumnarBatch = {
        batch: compactedMeta,
        accessors: compactedMeta.accessorsByField,
        columns: compactedMeta.columns,
        start: 0,
        end: keptCount
      };
    }

    // Remove all matching records from groups.
    filterListeners.forEach(function(l) { l(null, [], removed, true); });

    // Update indexes.
    removeDataListeners.forEach(function(l) { l(newIndex); });

    // Remove old filters and data by overwriting.
    if (compactColumnar) {
      filterStore.compact(newIndex, keptCount, REMOVED_INDEX);
      n = keptCount;
      data = new Array(keptCount);
      columnarBatches = nextColumnarBatch ? [nextColumnarBatch] : [];
      anyRowMaterialized = false;
    } else {
      for (var index3 = 0, index4 = 0; index3 < n; ++index3) {
        if (newIndex[index3] !== REMOVED_INDEX) {
          if (index3 !== index4) data[index4] = data[index3];
          ++index4;
        }
      }
      filterStore.compact(newIndex, index4, REMOVED_INDEX);
      data.length = n = index4;
      columnarBatches = [];
    }

    numericColumns = Object.create(null);
    splitColumns = Object.create(null);
    activeRowsDirty = true;
    activeCountDirty = true;
    triggerOnChange('dataRemoved');
  }

  function buildIgnoreIdMap(dimensions) {
    if (!dimensions || !dimensions.length) {
      return null;
    }
    var map = Object.create(null);
    for (var d = 0, len = dimensions.length; d < len; d++) {
      map[dimensions[d].id()] = true;
    }
    return map;
  }

  // Return true if the data element at index i is filtered IN.
  // Optionally, ignore the filters of any dimensions in the ignore_dimensions list.
  function isElementFiltered(i, ignore_dimensions) {
    var ignoreMap = buildIgnoreIdMap(ignore_dimensions);
    return ignoreMap ? filterStore.isActiveIgnoring(i, ignoreMap) : filterStore.isActive(i);
  }

  // Adds a new dimension with the specified value accessor function.
  function dimension(value, iterable) {
    var accessorPath,
        isStringField = typeof value === 'string';

    if (isStringField) {
      accessorPath = value;
      value = function(d) { return result(d, accessorPath); };
    } else if (typeof value === 'function') {
      accessorPath = tryExtractAccessorPath(value);
    }

    var dimension = {
      filter: filter,
      filterExact: filterExact,
      filterIn: filterIn,
      filterRange: filterRange,
      filterFunction: filterFunction,
      filterAll: filterAll,
      currentFilter: currentFilter,
      hasCurrentFilter: hasCurrentFilter,
      top: top,
      topIndex: topIndex,
      bottom: bottom,
      bottomIndex: bottomIndex,
      group: group,
      groupAll: groupAll,
      dispose: dispose,
      remove: dispose, // for backwards-compatibility
      accessor: value,
      id: function() { return id; },
      _bounds: readDimensionBounds
    };

    var dimSlot, // 1-bit filter slot in filterStore
        id, // unique ID for this dimension (reused when dimensions are disposed)
        values, // sorted, cached array
        index, // maps sorted value index -> record index (in data)
        newValues, // temporary array storing newly-added values
        newIndex, // temporary array storing newly-added index
        lastAppendedCodes, // temporary: appended codes from lazy preAdd
        iterablesIndexCount,
        iterablesIndexFilterStatus,
        iterablesEmptyRows = [],
        sortRange = function(len) {
          var range = cr_range(len);
          if (len <= 1) return range;
          var first = newValues[0];
          var firstType = typeof first;
          var i, v;
          if (firstType === 'number') {
            var allNum = first === first;
            for (i = 1; allNum && i < len; ++i) {
              v = newValues[i];
              if (typeof v !== 'number' || v !== v) allNum = false;
            }
            if (allNum) {
              return range.sort(function(A, B) {
                var va = newValues[A], vb = newValues[B];
                return va < vb ? -1 : va > vb ? 1 : A - B;
              });
            }
          } else if (firstType === 'string') {
            var allStr = true;
            for (i = 1; i < len; ++i) {
              if (typeof newValues[i] !== 'string') { allStr = false; break; }
            }
            if (allStr) {
              return range.sort(function(A, B) {
                var va = newValues[A], vb = newValues[B];
                return va < vb ? -1 : va > vb ? 1 : A - B;
              });
            }
          } else if (first instanceof Date) {
            var times = new Float64Array(len);
            var t0 = first.getTime();
            var allDate = t0 === t0;
            times[0] = t0;
            for (i = 1; allDate && i < len; ++i) {
              v = newValues[i];
              if (!(v instanceof Date)) { allDate = false; break; }
              var tv = v.getTime();
              if (tv !== tv) { allDate = false; break; }
              times[i] = tv;
            }
            if (allDate) {
              return range.sort(function(A, B) {
                var va = times[A], vb = times[B];
                return va < vb ? -1 : va > vb ? 1 : A - B;
              });
            }
          }
          return range.sort(function(A, B) {
            var order = compareNaturalOrder(newValues[A], newValues[B]);
            return order || A - B;
          });
        },
        refilter = xfilterFilter.filterAll, // for recomputing filter
        refilterFunction, // the custom filter function in use
        filterValue, // the value used for filtering (value, array, function or undefined)
        filterValuePresent, // true if filterValue contains something
        filterMode = 'all',
        filterInValues = null,
        exactRangeCache = new Map(),
        lazyFilterTargetCodes = null,
        lazyFilterTargetCodesVersion = 0,
        lazyEncodedState = null,
        rawNumericState = null,
        deferredInit = false,
        indexListeners = [], // when data is added
        dimensionGroups = [],
        lo0 = 0,
        hi0 = 0,
        t = 0,
        k;

    function normalizeExactFilterValues(filterValues) {
      var uniqueValues = Array.from(new Set(filterValues));
      uniqueValues.sort(compareNaturalOrder);
      return uniqueValues;
    }

    function isLazyEncodedValue(valueToEncode) {
      var valueType = typeof valueToEncode;
      return valueToEncode == null
        || valueType === 'string'
        || valueType === 'number'
        || valueType === 'boolean'
        || valueType === 'bigint';
    }

    // ==========================================================================
    // Lazy encoded dimension path — semantic safety contract
    //
    // The lazy path stores dimension values as integer codes and defers
    // materialization of sorted values/index. All optimizations in this path
    // must preserve these invariants:
    //
    // 1. ORDERING: filterRange must use compareNaturalOrder, not raw JS < / >=,
    //    because mixed-type dimensions have type-rank ordering that differs
    //    from JS coercion. The gate is hasLazyEncodedGroupingSupport().
    //
    // 2. EQUALITY: filterExact and filterIn use Map-based code lookup, which
    //    uses SameValueZero. This differs from compareNaturalOrder for null/0
    //    (they are distinct in SameValueZero but equivalent in natural order).
    //    This is an intentional semantic tightening: null means null.
    //
    // 3. FILTER LIFECYCLE: reduce functions receive a third argument (noPrior)
    //    that distinguishes "new data" from "filter toggle." The lazy path
    //    must preserve this via resetNeeded + resetMany/resetOne, not by
    //    skipping reduce calls.
    //
    // 4. NOTIFICATION: filter changes must fire onChange('filtered') even when
    //    no filterListeners (groups) exist. Check callbacks.length too.
    //
    // 5. COUNTS: codeCounts must stay consistent through append, remove, and
    //    compaction. lazyCodesSelectAllRows depends on accurate counts.
    //
    // When in doubt, materialize. The materialized path is always correct.
    // ==========================================================================

    function createLazyEncodedStateFromSource(source, accessor, offset, length) {
      if (!accessorPath || iterable) {
        return null;
      }
      // Warm WASM runtime if enabled so runtimeInfo().active stays consistent.
      runtimeController.canUseWasmScan();

      var codesCapacity = length < 64 ? 64 : length,
          codes = new Uint32Array(codesCapacity),
          valueToCode = new Map(),
          codeToValue = [undefined],
          codeCounts = new Uint32Array(64),
          hasUnorderable = false,
          isPureNumeric = true,
          isPureString = true,
          i,
          valueToEncode,
          code;

      if (source) {
        if (offset === 0) {
          for (i = 0; i < length; ++i) {
            valueToEncode = source[i];
            code = valueToCode.get(valueToEncode);
            if (code === undefined) {
              if (!isLazyEncodedValue(valueToEncode)) {
                return null;
              }
              code = codeToValue.length;
              valueToCode.set(valueToEncode, code);
              codeToValue.push(valueToEncode);
              if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
                hasUnorderable = true;
                isPureNumeric = false;
                isPureString = false;
              } else if (typeof valueToEncode === 'number') {
                isPureString = false;
              } else if (typeof valueToEncode === 'string') {
                isPureNumeric = false;
              } else {
                isPureNumeric = false;
                isPureString = false;
              }
              if (code >= codeCounts.length) {
                var nextCountCap0 = codeCounts.length << 1;
                while (nextCountCap0 <= code) nextCountCap0 <<= 1;
                var nextCounts0 = new Uint32Array(nextCountCap0);
                nextCounts0.set(codeCounts);
                codeCounts = nextCounts0;
              }
            }
            codes[i] = code;
            ++codeCounts[code];
          }
        } else {
          for (i = 0; i < length; ++i) {
            valueToEncode = source[offset + i];
            code = valueToCode.get(valueToEncode);
            if (code === undefined) {
              if (!isLazyEncodedValue(valueToEncode)) {
                return null;
              }
              code = codeToValue.length;
              valueToCode.set(valueToEncode, code);
              codeToValue.push(valueToEncode);
              if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
                hasUnorderable = true;
                isPureNumeric = false;
                isPureString = false;
              } else if (typeof valueToEncode === 'number') {
                isPureString = false;
              } else if (typeof valueToEncode === 'string') {
                isPureNumeric = false;
              } else {
                isPureNumeric = false;
                isPureString = false;
              }
              if (code >= codeCounts.length) {
                var nextCountCap1 = codeCounts.length << 1;
                while (nextCountCap1 <= code) nextCountCap1 <<= 1;
                var nextCounts1 = new Uint32Array(nextCountCap1);
                nextCounts1.set(codeCounts);
                codeCounts = nextCounts1;
              }
            }
            codes[i] = code;
            ++codeCounts[code];
          }
        }
      } else {
        for (i = 0; i < length; ++i) {
          valueToEncode = accessor(offset + i);
          code = valueToCode.get(valueToEncode);
          if (code === undefined) {
            if (!isLazyEncodedValue(valueToEncode)) {
              return null;
            }
            code = codeToValue.length;
            valueToCode.set(valueToEncode, code);
            codeToValue.push(valueToEncode);
            if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
              hasUnorderable = true;
              isPureNumeric = false;
              isPureString = false;
            } else if (typeof valueToEncode === 'number') {
              isPureString = false;
            } else if (typeof valueToEncode === 'string') {
              isPureNumeric = false;
            } else {
              isPureNumeric = false;
              isPureString = false;
            }
            if (code >= codeCounts.length) {
              var nextCountCap2 = codeCounts.length << 1;
              while (nextCountCap2 <= code) nextCountCap2 <<= 1;
              var nextCounts2 = new Uint32Array(nextCountCap2);
              nextCounts2.set(codeCounts);
              codeCounts = nextCounts2;
            }
          }
          codes[i] = code;
          ++codeCounts[code];
        }
      }

      var marksCap = codeToValue.length < 64 ? 64 : codeToValue.length;
      return {
        codeCounts: codeCounts,
        codeRank: null,
        codeRankVersion: -1,
        codesLength: length,
        codeToValue: codeToValue,
        codes: codes,
        hasActiveFilterMask: false,
        hasUnorderable: hasUnorderable,
        isPureNumeric: isPureNumeric,
        isPureString: isPureString,
        lastSelectedCount: -1,
        selectionMarkVersion: 1,
        selectionMarks: new Uint32Array(marksCap),
        valueToCode: valueToCode,
        version: 1
      };
    }

    function createLazyEncodedStateFromArrowDict(chunks, startOffset, length) {
      if (!accessorPath || iterable) {
        return null;
      }
      runtimeController.canUseWasmScan();

      var codesCapacity = length < 64 ? 64 : length,
          codes = new Uint32Array(codesCapacity),
          valueToCode = new Map(),
          codeToValue = [undefined],
          codeCounts = new Uint32Array(64),
          hasUnorderable = false,
          isPureNumeric = true,
          isPureString = true,
          localEnd = startOffset + length,
          chunkStart = 0,
          outIdx = 0,
          nullCode = -1,
          c,
          j,
          dIdx,
          code,
          val;

      for (c = 0; c < chunks.length && outIdx < length; ++c) {
        var chunk = chunks[c];
        var chunkEnd = chunkStart + chunk.length;
        if (chunkEnd <= startOffset) {
          chunkStart = chunkEnd;
          continue;
        }
        if (chunkStart >= localEnd) break;
        var subStart = startOffset > chunkStart ? startOffset - chunkStart : 0;
        var subEnd = localEnd < chunkEnd ? localEnd - chunkStart : chunk.length;
        var dict = chunk.dictionary;
        var dictLen = dict.length;
        var dictToCode = new Int32Array(dictLen);
        dictToCode.fill(-1);
        var indices = chunk.values;

        if (chunk.nullCount === 0) {
          for (j = subStart; j < subEnd; ++j) {
            dIdx = indices[j];
            code = dictToCode[dIdx];
            if (!(code >= 0)) {
              if (dIdx < 0 || dIdx >= dictLen) return null;
              val = dict.get(dIdx);
              code = valueToCode.get(val);
              if (code === undefined) {
                if (!isLazyEncodedValue(val)) return null;
                code = codeToValue.length;
                valueToCode.set(val, code);
                codeToValue.push(val);
                if (val === undefined || !(val >= val)) {
                  hasUnorderable = true;
                  isPureNumeric = false;
                  isPureString = false;
                } else if (typeof val === 'number') {
                  isPureString = false;
                } else if (typeof val === 'string') {
                  isPureNumeric = false;
                } else {
                  isPureNumeric = false;
                  isPureString = false;
                }
                if (code >= codeCounts.length) {
                  var nextCapA = codeCounts.length << 1;
                  while (nextCapA <= code) nextCapA <<= 1;
                  var nextCountsA = new Uint32Array(nextCapA);
                  nextCountsA.set(codeCounts);
                  codeCounts = nextCountsA;
                }
              }
              dictToCode[dIdx] = code;
            }
            codes[outIdx++] = code;
            ++codeCounts[code];
          }
        } else {
          var nullBitmap = chunk.nullBitmap;
          var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
          for (j = subStart; j < subEnd; ++j) {
            var bitIdx = chunkOff + j;
            if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
              if (nullCode < 0) {
                code = valueToCode.get(null);
                if (code === undefined) {
                  code = codeToValue.length;
                  valueToCode.set(null, code);
                  codeToValue.push(null);
                  isPureNumeric = false;
                  isPureString = false;
                  if (code >= codeCounts.length) {
                    var nextCapN = codeCounts.length << 1;
                    while (nextCapN <= code) nextCapN <<= 1;
                    var nextCountsN = new Uint32Array(nextCapN);
                    nextCountsN.set(codeCounts);
                    codeCounts = nextCountsN;
                  }
                }
                nullCode = code;
              }
              codes[outIdx++] = nullCode;
              ++codeCounts[nullCode];
            } else {
              dIdx = indices[j];
              code = dictToCode[dIdx];
              if (!(code >= 0)) {
                if (dIdx < 0 || dIdx >= dictLen) return null;
                val = dict.get(dIdx);
                code = valueToCode.get(val);
                if (code === undefined) {
                  if (!isLazyEncodedValue(val)) return null;
                  code = codeToValue.length;
                  valueToCode.set(val, code);
                  codeToValue.push(val);
                  if (val === undefined || !(val >= val)) {
                    hasUnorderable = true;
                    isPureNumeric = false;
                    isPureString = false;
                  } else if (typeof val === 'number') {
                    isPureString = false;
                  } else if (typeof val === 'string') {
                    isPureNumeric = false;
                  } else {
                    isPureNumeric = false;
                    isPureString = false;
                  }
                  if (code >= codeCounts.length) {
                    var nextCapB = codeCounts.length << 1;
                    while (nextCapB <= code) nextCapB <<= 1;
                    var nextCountsB = new Uint32Array(nextCapB);
                    nextCountsB.set(codeCounts);
                    codeCounts = nextCountsB;
                  }
                }
                dictToCode[dIdx] = code;
              }
              codes[outIdx++] = code;
              ++codeCounts[code];
            }
          }
        }
        chunkStart = chunkEnd;
      }

      if (outIdx !== length) {
        return null;
      }

      var marksCap = codeToValue.length < 64 ? 64 : codeToValue.length;
      return {
        codeCounts: codeCounts,
        codeRank: null,
        codeRankVersion: -1,
        codesLength: length,
        codeToValue: codeToValue,
        codes: codes,
        hasActiveFilterMask: false,
        hasUnorderable: hasUnorderable,
        isPureNumeric: isPureNumeric,
        isPureString: isPureString,
        lastSelectedCount: -1,
        selectionMarkVersion: 1,
        selectionMarks: new Uint32Array(marksCap),
        valueToCode: valueToCode,
        version: 1
      };
    }

    function ensureLazySelectionMarksSize(size) {
      if (lazyEncodedState.selectionMarks.length >= size) {
        return;
      }

      var nextCap = lazyEncodedState.selectionMarks.length || 64;
      while (nextCap < size) nextCap <<= 1;
      var nextMarks = new Uint32Array(nextCap);
      nextMarks.set(lazyEncodedState.selectionMarks);
      lazyEncodedState.selectionMarks = nextMarks;
    }

    function getLazyCodes() {
      return lazyEncodedState.codes.length === lazyEncodedState.codesLength
        ? lazyEncodedState.codes
        : lazyEncodedState.codes.subarray(0, lazyEncodedState.codesLength);
    }

    function growLazyCodeCounts(codeCounts, minLength) {
      var nextCap = codeCounts.length || 64;
      while (nextCap < minLength) nextCap <<= 1;
      var nextCounts = new Uint32Array(nextCap);
      nextCounts.set(codeCounts);
      lazyEncodedState.codeCounts = nextCounts;
      return nextCounts;
    }

    function appendLazyEncodedValuesFromSource(source, accessor, offset, length) {
      if (!lazyEncodedState) {
        return null;
      }

      var existingLength = lazyEncodedState.codesLength,
          newLength = existingLength + length,
          codes = lazyEncodedState.codes,
          codeCounts = lazyEncodedState.codeCounts,
          valueToCode = lazyEncodedState.valueToCode,
          codeToValue = lazyEncodedState.codeToValue,
          appendedCodes = new Uint32Array(length),
          hasUnorderable = lazyEncodedState.hasUnorderable,
          isPureNumeric = lazyEncodedState.isPureNumeric,
          isPureString = lazyEncodedState.isPureString,
          i,
          valueToEncode,
          code;

      if (newLength > codes.length) {
        var nextCapacity = codes.length || 64;
        while (nextCapacity < newLength) nextCapacity <<= 1;
        var nextCodes = new Uint32Array(nextCapacity);
        nextCodes.set(codes.subarray(0, existingLength));
        codes = nextCodes;
        lazyEncodedState.codes = codes;
      }

      if (source) {
        if (offset === 0) {
          for (i = 0; i < length; ++i) {
            valueToEncode = source[i];
            code = valueToCode.get(valueToEncode);
            if (code === undefined) {
              if (!isLazyEncodedValue(valueToEncode)) {
                return null;
              }
              code = codeToValue.length;
              valueToCode.set(valueToEncode, code);
              codeToValue.push(valueToEncode);
              if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
                hasUnorderable = true;
                isPureNumeric = false;
                isPureString = false;
              } else if (typeof valueToEncode === 'number') {
                isPureString = false;
              } else if (typeof valueToEncode === 'string') {
                isPureNumeric = false;
              } else {
                isPureNumeric = false;
                isPureString = false;
              }
              if (code >= codeCounts.length) {
                codeCounts = growLazyCodeCounts(codeCounts, code + 1);
              }
            }
            appendedCodes[i] = code;
            codes[existingLength + i] = code;
            ++codeCounts[code];
          }
        } else {
          for (i = 0; i < length; ++i) {
            valueToEncode = source[offset + i];
            code = valueToCode.get(valueToEncode);
            if (code === undefined) {
              if (!isLazyEncodedValue(valueToEncode)) {
                return null;
              }
              code = codeToValue.length;
              valueToCode.set(valueToEncode, code);
              codeToValue.push(valueToEncode);
              if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
                hasUnorderable = true;
                isPureNumeric = false;
                isPureString = false;
              } else if (typeof valueToEncode === 'number') {
                isPureString = false;
              } else if (typeof valueToEncode === 'string') {
                isPureNumeric = false;
              } else {
                isPureNumeric = false;
                isPureString = false;
              }
              if (code >= codeCounts.length) {
                codeCounts = growLazyCodeCounts(codeCounts, code + 1);
              }
            }
            appendedCodes[i] = code;
            codes[existingLength + i] = code;
            ++codeCounts[code];
          }
        }
      } else {
        for (i = 0; i < length; ++i) {
          valueToEncode = accessor(offset + i);
          code = valueToCode.get(valueToEncode);
          if (code === undefined) {
            if (!isLazyEncodedValue(valueToEncode)) {
              return null;
            }
            code = codeToValue.length;
            valueToCode.set(valueToEncode, code);
            codeToValue.push(valueToEncode);
            if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
              hasUnorderable = true;
              isPureNumeric = false;
              isPureString = false;
            } else if (typeof valueToEncode === 'number') {
              isPureString = false;
            } else if (typeof valueToEncode === 'string') {
              isPureNumeric = false;
            } else {
              isPureNumeric = false;
              isPureString = false;
            }
            if (code >= codeCounts.length) {
              codeCounts = growLazyCodeCounts(codeCounts, code + 1);
            }
          }
          appendedCodes[i] = code;
          codes[existingLength + i] = code;
          ++codeCounts[code];
        }
      }

      lazyEncodedState.hasUnorderable = hasUnorderable;
      lazyEncodedState.isPureNumeric = isPureNumeric;
      lazyEncodedState.isPureString = isPureString;
      lazyEncodedState.codesLength = newLength;
      lazyEncodedState.version += 1;
      lazyEncodedState.codeRank = null;
      ensureLazySelectionMarksSize(codeToValue.length);
      return appendedCodes;
    }

    function appendLazyEncodedValuesFromArrowDict(chunks, startOffset, length) {
      if (!lazyEncodedState) {
        return null;
      }

      var existingLength = lazyEncodedState.codesLength,
          newLength = existingLength + length,
          codes = lazyEncodedState.codes,
          codeCounts = lazyEncodedState.codeCounts,
          valueToCode = lazyEncodedState.valueToCode,
          codeToValue = lazyEncodedState.codeToValue,
          appendedCodes = new Uint32Array(length),
          hasUnorderable = lazyEncodedState.hasUnorderable,
          isPureNumeric = lazyEncodedState.isPureNumeric,
          isPureString = lazyEncodedState.isPureString,
          localEnd = startOffset + length,
          chunkStart = 0,
          outIdx = 0,
          nullCode = -1,
          c,
          j,
          dIdx,
          code,
          val;

      if (newLength > codes.length) {
        var nextCapacity = codes.length || 64;
        while (nextCapacity < newLength) nextCapacity <<= 1;
        var nextCodes = new Uint32Array(nextCapacity);
        nextCodes.set(codes.subarray(0, existingLength));
        codes = nextCodes;
        lazyEncodedState.codes = codes;
      }

      for (c = 0; c < chunks.length && outIdx < length; ++c) {
        var chunk = chunks[c];
        var chunkEnd = chunkStart + chunk.length;
        if (chunkEnd <= startOffset) {
          chunkStart = chunkEnd;
          continue;
        }
        if (chunkStart >= localEnd) break;
        var subStart = startOffset > chunkStart ? startOffset - chunkStart : 0;
        var subEnd = localEnd < chunkEnd ? localEnd - chunkStart : chunk.length;
        var dict = chunk.dictionary;
        var dictLen = dict.length;
        var dictToCode = new Int32Array(dictLen);
        dictToCode.fill(-1);
        var indices = chunk.values;

        if (chunk.nullCount === 0) {
          for (j = subStart; j < subEnd; ++j) {
            dIdx = indices[j];
            code = dictToCode[dIdx];
            if (!(code >= 0)) {
              if (dIdx < 0 || dIdx >= dictLen) return null;
              val = dict.get(dIdx);
              code = valueToCode.get(val);
              if (code === undefined) {
                if (!isLazyEncodedValue(val)) return null;
                code = codeToValue.length;
                valueToCode.set(val, code);
                codeToValue.push(val);
                if (val === undefined || !(val >= val)) {
                  hasUnorderable = true;
                  isPureNumeric = false;
                  isPureString = false;
                } else if (typeof val === 'number') {
                  isPureString = false;
                } else if (typeof val === 'string') {
                  isPureNumeric = false;
                } else {
                  isPureNumeric = false;
                  isPureString = false;
                }
                if (code >= codeCounts.length) {
                  codeCounts = growLazyCodeCounts(codeCounts, code + 1);
                }
              }
              dictToCode[dIdx] = code;
            }
            appendedCodes[outIdx] = code;
            codes[existingLength + outIdx] = code;
            ++outIdx;
            ++codeCounts[code];
          }
        } else {
          var nullBitmap = chunk.nullBitmap;
          var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
          for (j = subStart; j < subEnd; ++j) {
            var bitIdx = chunkOff + j;
            if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
              if (nullCode < 0) {
                code = valueToCode.get(null);
                if (code === undefined) {
                  code = codeToValue.length;
                  valueToCode.set(null, code);
                  codeToValue.push(null);
                  isPureNumeric = false;
                  isPureString = false;
                  if (code >= codeCounts.length) {
                    codeCounts = growLazyCodeCounts(codeCounts, code + 1);
                  }
                }
                nullCode = code;
              }
              appendedCodes[outIdx] = nullCode;
              codes[existingLength + outIdx] = nullCode;
              ++outIdx;
              ++codeCounts[nullCode];
            } else {
              dIdx = indices[j];
              code = dictToCode[dIdx];
              if (!(code >= 0)) {
                if (dIdx < 0 || dIdx >= dictLen) return null;
                val = dict.get(dIdx);
                code = valueToCode.get(val);
                if (code === undefined) {
                  if (!isLazyEncodedValue(val)) return null;
                  code = codeToValue.length;
                  valueToCode.set(val, code);
                  codeToValue.push(val);
                  if (val === undefined || !(val >= val)) {
                    hasUnorderable = true;
                    isPureNumeric = false;
                    isPureString = false;
                  } else if (typeof val === 'number') {
                    isPureString = false;
                  } else if (typeof val === 'string') {
                    isPureNumeric = false;
                  } else {
                    isPureNumeric = false;
                    isPureString = false;
                  }
                  if (code >= codeCounts.length) {
                    codeCounts = growLazyCodeCounts(codeCounts, code + 1);
                  }
                }
                dictToCode[dIdx] = code;
              }
              appendedCodes[outIdx] = code;
              codes[existingLength + outIdx] = code;
              ++outIdx;
              ++codeCounts[code];
            }
          }
        }
        chunkStart = chunkEnd;
      }

      if (outIdx !== length) {
        return null;
      }

      lazyEncodedState.hasUnorderable = hasUnorderable;
      lazyEncodedState.isPureNumeric = isPureNumeric;
      lazyEncodedState.isPureString = isPureString;
      lazyEncodedState.codesLength = newLength;
      lazyEncodedState.version += 1;
      lazyEncodedState.codeRank = null;
      ensureLazySelectionMarksSize(codeToValue.length);
      return appendedCodes;
    }

    function buildCodeCounts(codes, length, size) {
      var cap = size < 64 ? 64 : size;
      var codeCounts = new Uint32Array(cap);
      for (var codeIndex = 0; codeIndex < length; ++codeIndex) {
        ++codeCounts[codes[codeIndex]];
      }
      return codeCounts;
    }

    function countLazySelectedRows(targetCodes) {
      if (!lazyEncodedState || !targetCodes || !targetCodes.length) {
        return 0;
      }

      var codeCounts = lazyEncodedState.codeCounts,
          selectedCount = 0;
      for (var codeIndex = 0; codeIndex < targetCodes.length; ++codeIndex) {
        selectedCount += codeCounts[targetCodes[codeIndex]] || 0;
      }
      return selectedCount;
    }

    function nextLazyMarkVersion() {
      ensureLazySelectionMarksSize(lazyEncodedState.codeToValue.length);
      if (lazyEncodedState.selectionMarkVersion === 0xffffffff) {
        lazyEncodedState.selectionMarks.fill(0);
        lazyEncodedState.selectionMarkVersion = 1;
      }
      return lazyEncodedState.selectionMarkVersion++;
    }

    function encodeLazyFilterValues(filterValues) {
      if (!lazyEncodedState) {
        return null;
      }

      var encodedValues = new Uint32Array(filterValues.length),
          count = 0,
          i,
          markVersion = nextLazyMarkVersion(),
          selectionMarks = lazyEncodedState.selectionMarks,
          valueToCode = lazyEncodedState.valueToCode,
          valueToEncode,
          code;

      for (i = 0; i < filterValues.length; ++i) {
        valueToEncode = filterValues[i];
        if (!isLazyEncodedValue(valueToEncode)) {
          return null;
        }
        code = valueToCode.get(valueToEncode);
        if (code === undefined || selectionMarks[code] === markVersion) {
          continue;
        }
        selectionMarks[code] = markVersion;
        encodedValues[count++] = code;
      }

      return encodedValues.subarray(0, count);
    }

    function applyLazyClearFilter() {
      if (!lazyEncodedState.hasActiveFilterMask) {
        return dimension;
      }

      var otherMode = (transientFilterDepth === 0 && batchedFilterDepth === 0 && filterListeners.length > 0)
            ? inspectOtherFilterListeners(dimSlot)
            : 0,
          prevSelected = lazyEncodedState.lastSelectedCount,
          useForceReset = otherMode === 1 && (
            !filterStore.hasOtherActive(dimSlot)
            || (prevSelected >= 0 && (n - prevSelected) > (n >>> 2))
          ),
          needDeltas = otherMode > 0 && !useForceReset;

      lazyEncodedState.hasActiveFilterMask = false;
      lazyEncodedState.lastSelectedCount = -1;

      if (!needDeltas) {
        filterStore.deactivate(dimSlot);
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
        return dimension;
      }

      var useScratch = !deltaBufInUse,
          added = useScratch ? (deltaAddedBuf = ensureUint32Capacity(deltaAddedBuf, n)) : [],
          addedCount;

      if (useScratch) deltaBufInUse = true;
      addedCount = filterStore.clearSlotWithDeltas(dimSlot, added, useScratch);

      if (useScratch) {
        try {
          notifyFilterListeners(dimSlot, added.subarray(0, addedCount), EMPTY_ARRAY);
        } finally {
          deltaBufInUse = false;
        }
      } else {
        notifyFilterListeners(dimSlot, added, EMPTY_ARRAY);
      }
      return dimension;
    }

    function applyLazyEncodedFilter(targetCodes, nextMode) {
      filterMode = nextMode;
      lo0 = 0;
      hi0 = 0;

      if (n === 0) {
        return applyLazyClearFilter();
      }
      var selectedCount = countLazySelectedRows(targetCodes);
      if (selectedCount === n) {
        return applyLazyClearFilter();
      }

      var hadMask = lazyEncodedState.hasActiveFilterMask,
          prevSelected = lazyEncodedState.lastSelectedCount,
          codes = lazyEncodedState.codes,
          targetCount = targetCodes.length,
          otherMode = (transientFilterDepth === 0 && batchedFilterDepth === 0 && filterListeners.length > 0)
            ? inspectOtherFilterListeners(dimSlot)
            : 0,
          useForceReset = otherMode === 1 && (
            !hadMask
              ? ((n - selectedCount) > 1024 || (n - selectedCount) > (n >>> 2))
              : (prevSelected >= 0 && Math.abs(selectedCount - prevSelected) > (n >>> 2))
          ),
          needDeltas = otherMode > 0 && !useForceReset,
          markVersion = 0,
          selectionMarks = null,
          t0 = 0,
          i;

      if (targetCount === 1) {
        t0 = targetCodes[0];
      } else if (targetCount > 1) {
        markVersion = nextLazyMarkVersion();
        selectionMarks = lazyEncodedState.selectionMarks;
        for (i = 0; i < targetCount; ++i) {
          selectionMarks[targetCodes[i]] = markVersion;
        }
      }

      lazyEncodedState.hasActiveFilterMask = true;
      lazyEncodedState.lastSelectedCount = selectedCount;

      var writeMode = targetCount === 0 ? 0 : (targetCount === 1 ? 1 : 2);
      var argA = targetCount === 1 ? t0 : selectionMarks;
      var argB = markVersion;

      if (!needDeltas) {
        filterStore.writePredicateNoDelta(dimSlot, writeMode, codes, argA, argB);
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
        return dimension;
      }

      var useScratch = !deltaBufInUse,
          added,
          removed,
          canBail = otherMode === 1,
          bailLimit = n >>> 2;

      if (useScratch) {
        deltaAddedBuf = ensureUint32Capacity(deltaAddedBuf, n);
        deltaRemovedBuf = ensureUint32Capacity(deltaRemovedBuf, n);
        added = deltaAddedBuf;
        removed = deltaRemovedBuf;
        deltaBufInUse = true;
      } else {
        added = [];
        removed = [];
      }

      var res = filterStore.writePredicateWithDeltas(
        dimSlot, writeMode, codes, argA, argB,
        added, removed, useScratch, canBail, bailLimit
      );

      if (res.bailed) {
        if (useScratch) deltaBufInUse = false;
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, true);
        return dimension;
      }

      if (useScratch) {
        try {
          notifyFilterListeners(
            dimSlot,
            added.subarray(0, res.addedCount),
            removed.subarray(0, res.removedCount)
          );
        } finally {
          deltaBufInUse = false;
        }
      } else {
        notifyFilterListeners(dimSlot, added, removed);
      }
      return dimension;
    }

    function computeLazyRangeCodes(range) {
      var codeToValue = lazyEncodedState.codeToValue,
          rangeCodes = [],
          lo = range[0],
          hi = range[1],
          code,
          v;

      if (lazyEncodedState.isPureNumeric && typeof lo === 'number' && typeof hi === 'number' && lo === lo && hi === hi) {
        for (code = 1; code < codeToValue.length; ++code) {
          v = codeToValue[code];
          if (v >= lo && v < hi) {
            rangeCodes.push(code);
          }
        }
      } else {
        for (code = 1; code < codeToValue.length; ++code) {
          v = codeToValue[code];
          if (compareNaturalOrder(v, lo) >= 0 && compareNaturalOrder(v, hi) < 0) {
            rangeCodes.push(code);
          }
        }
      }

      return new Uint32Array(rangeCodes);
    }

    function resolveLazyTargetCodes() {
      if (!lazyEncodedState || !filterValuePresent || filterMode === 'all') {
        return new Uint32Array(0);
      }

      if (lazyFilterTargetCodes || (filterMode === 'bounds' && Array.isArray(filterValue))) {
        var currentCodeCount = lazyEncodedState.codeToValue.length;
        if (lazyFilterTargetCodes && currentCodeCount === lazyFilterTargetCodesVersion) {
          return lazyFilterTargetCodes;
        }
        lazyFilterTargetCodes = computeLazyRangeCodes(filterValue);
        lazyFilterTargetCodesVersion = currentCodeCount;
        return lazyFilterTargetCodes;
      }

      if (filterMode === 'in') {
        return encodeLazyFilterValues(filterInValues || []);
      }

      return encodeLazyFilterValues([filterValue]);
    }

    function applyLazyFilterToRange(startRow, length) {
      if (!filterValuePresent || filterMode === 'all' || !length) {
        return;
      }

      var targetCodes = resolveLazyTargetCodes();
      if (!targetCodes) {
        materializeLazyEncodedState();
        return;
      }

      var codes = lazyEncodedState.codes,
          targetCount = targetCodes.length,
          endRow = startRow + length,
          maskedAny = false,
          i;

      if (targetCount === 0) {
        for (i = startRow; i < endRow; ++i) {
          filterStore.setSlotExcluded(dimSlot, i);
        }
        maskedAny = true;
      } else if (targetCount === 1) {
        var t0 = targetCodes[0];
        for (i = startRow; i < endRow; ++i) {
          if (codes[i] !== t0) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      } else {
        var markVersion = nextLazyMarkVersion(),
            selectionMarks = lazyEncodedState.selectionMarks;
        for (i = 0; i < targetCount; ++i) {
          selectionMarks[targetCodes[i]] = markVersion;
        }
        for (i = startRow; i < endRow; ++i) {
          if (selectionMarks[codes[i]] !== markVersion) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      }

      if (maskedAny) {
        lazyEncodedState.hasActiveFilterMask = true;
      }
      lazyEncodedState.lastSelectedCount = -1;
    }

    function compactLazyEncodedState(reIndex) {
      var nextLength = 0,
          i,
          nextCodes,
          rowIndex,
          hasActiveMask = false;

      for (i = 0; i < reIndex.length; ++i) {
        if (reIndex[i] !== REMOVED_INDEX) {
          ++nextLength;
        }
      }

      var nextCodesCapacity = nextLength < 64 ? 64 : nextLength;
      nextCodes = new Uint32Array(nextCodesCapacity);

      var existingCodes = lazyEncodedState.codes;
      for (i = 0, rowIndex = 0; i < reIndex.length; ++i) {
        if (reIndex[i] === REMOVED_INDEX) {
          continue;
        }
        nextCodes[rowIndex] = existingCodes[i];
        if (!hasActiveMask && filterStore.isSlotExcluded(dimSlot, i)) {
          hasActiveMask = true;
        }
        ++rowIndex;
      }
      if (!hasActiveMask && dimSlot.active) {
        filterStore.deactivate(dimSlot);
      }

      var codeToValue = lazyEncodedState.codeToValue;
      var codeCounts = buildCodeCounts(nextCodes, nextLength, codeToValue.length);
      var hasUnorderable = false;
      var isPureNumeric = true;
      var isPureString = true;
      for (var c = 1; c < codeToValue.length; ++c) {
        if (codeCounts[c] > 0) {
          var v = codeToValue[c];
          if (v === undefined || !(v >= v)) {
            hasUnorderable = true;
            isPureNumeric = false;
            isPureString = false;
          } else if (typeof v === 'number') {
            isPureString = false;
          } else if (typeof v === 'string') {
            isPureNumeric = false;
          } else {
            isPureNumeric = false;
            isPureString = false;
          }
        }
      }

      lazyEncodedState.codes = nextCodes;
      lazyEncodedState.codesLength = nextLength;
      lazyEncodedState.codeCounts = codeCounts;
      lazyEncodedState.hasActiveFilterMask = hasActiveMask;
      lazyEncodedState.hasUnorderable = hasUnorderable;
      lazyEncodedState.isPureNumeric = isPureNumeric;
      lazyEncodedState.isPureString = isPureString;
      lazyEncodedState.lastSelectedCount = -1;
      lazyEncodedState.version += 1;
      lazyEncodedState.codeRank = null;
      lo0 = 0;
      hi0 = 0;
    }

    function getLazyCodeRank() {
      if (lazyEncodedState.codeRank && lazyEncodedState.codeRankVersion === lazyEncodedState.version) {
        return lazyEncodedState.codeRank;
      }
      var codeToValue = lazyEncodedState.codeToValue,
          codeCounts = lazyEncodedState.codeCounts,
          activeCodes = [],
          c;
      for (c = 1; c < codeToValue.length; ++c) {
        if (codeCounts[c] > 0) {
          activeCodes.push(c);
        }
      }
      var isFastOrder = lazyEncodedState.isPureNumeric || lazyEncodedState.isPureString;
      if (isFastOrder) {
        activeCodes.sort(function(a, b) {
          var va = codeToValue[a], vb = codeToValue[b];
          return va < vb ? -1 : va > vb ? 1 : a - b;
        });
      } else {
        activeCodes.sort(function(a, b) {
          var order = compareNaturalOrder(codeToValue[a], codeToValue[b]);
          return order || a - b;
        });
      }
      var rankArr = new Uint32Array(codeToValue.length);
      var currentRank = 0;
      for (var i = 0; i < activeCodes.length; ++i) {
        if (i > 0) {
          if (isFastOrder) {
            if (codeToValue[activeCodes[i - 1]] !== codeToValue[activeCodes[i]]) {
              ++currentRank;
            }
          } else if (compareNaturalOrder(codeToValue[activeCodes[i - 1]], codeToValue[activeCodes[i]]) !== 0) {
            ++currentRank;
          }
        }
        rankArr[activeCodes[i]] = currentRank;
      }
      lazyEncodedState.codeRank = rankArr;
      lazyEncodedState.codeRankVersion = lazyEncodedState.version;
      return rankArr;
    }

    function upgradeRawNumericToLazy(existingLength) {
      if (!rawNumericState || lazyEncodedState || values) {
        return;
      }
      if (brushDimSlot === dimSlot) {
        filterStore.ensureSlotMaterialized(dimSlot);
        invalidateBrushState();
      }
      var len = existingLength === undefined ? n : existingLength;
      var rawValues = rawNumericState.values;
      var hadMask = rawNumericState.hasActiveFilterMask;
      rawNumericState = null;
      lazyEncodedState = createLazyEncodedStateFromSource(rawValues, null, 0, len);
      if (lazyEncodedState) {
        lazyEncodedState.hasActiveFilterMask = hadMask;
        if (filterValuePresent && filterMode === 'bounds' && Array.isArray(filterValue)) {
          lazyFilterTargetCodes = computeLazyRangeCodes(filterValue);
          lazyFilterTargetCodesVersion = lazyEncodedState.codeToValue.length;
        }
      }
      for (var i = 0; i < dimensionGroups.length; ++i) {
        if (typeof dimensionGroups[i]._onRawNumericUpgrade === 'function') {
          dimensionGroups[i]._onRawNumericUpgrade();
        }
      }
    }

    function applyRawNumericClearFilter() {
      if (!rawNumericState.hasActiveFilterMask) {
        return dimension;
      }
      var otherMode = (transientFilterDepth === 0 && batchedFilterDepth === 0 && filterListeners.length > 0)
            ? inspectOtherFilterListeners(dimSlot)
            : 0,
          useForceReset = otherMode === 1 && (
            !filterStore.hasOtherActive(dimSlot)
            || rawNumericState.lastMaskedCount > (n >>> 2)
          ),
          needDeltas = otherMode > 0 && !useForceReset;
      rawNumericState.hasActiveFilterMask = false;
      rawNumericState.lastMaskedCount = -1;
      if (!needDeltas) {
        filterStore.deactivate(dimSlot);
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
        return dimension;
      }
      var useScratch = !deltaBufInUse,
          added = useScratch ? (deltaAddedBuf = ensureUint32Capacity(deltaAddedBuf, n)) : [],
          addedCount;
      if (useScratch) deltaBufInUse = true;
      addedCount = filterStore.clearSlotWithDeltas(dimSlot, added, useScratch);
      if (useScratch) {
        try {
          notifyFilterListeners(dimSlot, added.subarray(0, addedCount), EMPTY_ARRAY);
        } finally {
          deltaBufInUse = false;
        }
      } else {
        notifyFilterListeners(dimSlot, added, EMPTY_ARRAY);
      }
      return dimension;
    }

    function applyRawNumericPredicate(kind, argA, argB, nextMode) {
      filterMode = nextMode;
      lo0 = 0;
      hi0 = 0;
      if (n === 0) {
        return applyRawNumericClearFilter();
      }
      var hadMask = rawNumericState.hasActiveFilterMask,
          vals = rawNumericState.values,
          otherMode = (transientFilterDepth === 0 && batchedFilterDepth === 0 && filterListeners.length > 0)
            ? inspectOtherFilterListeners(dimSlot)
            : 0,
          useForceReset = otherMode === 1 && !hadMask && n > 1024,
          needDeltas = otherMode > 0 && !useForceReset,
          writeMode = kind === 0 ? 0 : (kind === 1 ? 3 : (kind === 2 ? 4 : 5)),
          matchedCount,
          maskedCount;

      if (!needDeltas) {
        matchedCount = filterStore.writePredicateNoDelta(dimSlot, writeMode, vals, argA, argB);
        maskedCount = n - matchedCount;
        if (maskedCount === 0) {
          filterStore.deactivate(dimSlot);
          rawNumericState.hasActiveFilterMask = false;
          rawNumericState.lastMaskedCount = 0;
          if (!hadMask) {
            return dimension;
          }
          notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
          return dimension;
        }
        rawNumericState.hasActiveFilterMask = true;
        rawNumericState.lastMaskedCount = maskedCount;
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
        return dimension;
      }

      var useScratch = !deltaBufInUse,
          added = useScratch ? (deltaAddedBuf = ensureUint32Capacity(deltaAddedBuf, n)) : [],
          removed = useScratch ? (deltaRemovedBuf = ensureUint32Capacity(deltaRemovedBuf, n)) : [],
          canBail = otherMode === 1,
          bailLimit = n >>> 2;
      if (useScratch) deltaBufInUse = true;

      var res = filterStore.writePredicateWithDeltas(
        dimSlot, writeMode, vals, argA, argB,
        added, removed, useScratch, canBail, bailLimit
      );
      maskedCount = n - res.matchedCount;
      if (maskedCount === 0) {
        filterStore.deactivate(dimSlot);
      }
      rawNumericState.hasActiveFilterMask = maskedCount > 0;
      rawNumericState.lastMaskedCount = maskedCount;

      if (res.bailed) {
        if (useScratch) deltaBufInUse = false;
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, true);
        return dimension;
      }

      if (!hadMask && maskedCount === 0) {
        if (useScratch) deltaBufInUse = false;
        return dimension;
      }
      if (useScratch) {
        try {
          notifyFilterListeners(dimSlot, added.subarray(0, res.addedCount), removed.subarray(0, res.removedCount));
        } finally {
          deltaBufInUse = false;
        }
      } else {
        notifyFilterListeners(dimSlot, added, removed);
      }
      return dimension;
    }

    function applyRawNumericFilterToRange(startRow, length) {
      if (!filterValuePresent || filterMode === 'all' || !length) {
        return;
      }
      var vals = rawNumericState.values,
          endRow = startRow + length,
          maskedAny = false,
          i,
          v;
      if (filterMode === 'in') {
        var inSet = new Set(filterInValues || []);
        for (i = startRow; i < endRow; ++i) {
          if (!inSet.has(vals[i])) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      } else if (Array.isArray(filterValue)) {
        var lo = filterValue[0],
            hi = filterValue[1];
        for (i = startRow; i < endRow; ++i) {
          v = vals[i];
          if (!(v >= lo && v < hi)) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      } else {
        for (i = startRow; i < endRow; ++i) {
          if (vals[i] !== filterValue) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      }
      if (maskedAny) {
        rawNumericState.hasActiveFilterMask = true;
      }
      rawNumericState.lastMaskedCount = -1;
    }

    function materializeLazyEncodedState() {
      if (brushDimSlot === dimSlot) {
        filterStore.ensureSlotMaterialized(dimSlot);
        invalidateBrushState();
      }
      if (rawNumericState && !values) {
        upgradeRawNumericToLazy(n);
      }
      if (!lazyEncodedState || values) {
        return;
      }

      var lazyCodes = getLazyCodes(),
          materializedValues = new Array(lazyCodes.length),
          bounds,
          i,
          ranges;

      for (i = 0; i < materializedValues.length; ++i) {
        materializedValues[i] = lazyEncodedState.codeToValue[lazyCodes[i]];
      }

      newValues = materializedValues;
      newIndex = sortRange(materializedValues.length);
      values = permute(newValues, newIndex);
      index = newIndex;
      newValues = newIndex = null;
      exactRangeCache.clear();

      if (filterMode === 'in') {
        ranges = exactRanges(filterInValues || []);
        lo0 = ranges.length ? ranges[0][0] : 0;
        hi0 = ranges.length ? ranges[ranges.length - 1][1] : 0;
      } else {
        bounds = refilter(values);
        lo0 = bounds[0];
        hi0 = bounds[1];
      }

      for (i = 0; i < dimensionGroups.length; ++i) {
        if (typeof dimensionGroups[i]._onDimensionMaterialize === 'function') {
          dimensionGroups[i]._onDimensionMaterialize(lazyCodes);
        }
      }

      lazyEncodedState = null;
    }

    function hasLazyEncodedGroupingSupport() {
      return !!(lazyEncodedState && !values && !iterable && !lazyEncodedState.hasUnorderable);
    }

    function setFilterValuePresent(nextPresent) {
      filterValuePresent = !!nextPresent;
    }

    function hasOtherActiveDimensionFilters() {
      return filterStore.hasOtherActive(dimSlot);
    }

    function getExactRange(value) {
      if (exactRangeCache.has(value)) {
        return exactRangeCache.get(value);
      }

      var lo = bisect.left(values, value, 0, values.length),
          hi = bisect.right(values, value, lo, values.length),
          range = lo === hi ? null : [lo, hi];

      exactRangeCache.set(value, range);
      return range;
    }

    function exactRanges(filterValues) {
      if (!filterValues || !filterValues.length) {
        return [];
      }

      var ranges = [];
      for (var valueIndex = 0; valueIndex < filterValues.length; ++valueIndex) {
        var range = getExactRange(filterValues[valueIndex]),
            lastRange = ranges[ranges.length - 1];

        if (!range) {
          continue;
        }

        if (lastRange && range[0] <= lastRange[1]) {
          lastRange[1] = Math.max(lastRange[1], range[1]);
        } else {
          ranges.push([range[0], range[1]]);
        }
      }

      return ranges;
    }

    function resolveCurrentRanges() {
      if (!values) {
        return [];
      }

      switch (filterMode) {
        case 'all':
          return values.length ? [[0, values.length]] : [];
        case 'bounds':
          return lo0 === hi0 ? [] : [[lo0, hi0]];
        case 'in':
          return exactRanges(filterInValues);
        default:
          return null;
      }
    }

    function appendIndexedRange(rows, rowIndexes, start, end) {
      for (var i = start; i < end; ++i) {
        rows.push(index[i]);
        rowIndexes.push(i);
      }
    }

    function applyFilterChanges(added, removed, valueIndexAdded, valueIndexRemoved, includeEmptyRows) {
      var i,
          row;

      if (!iterable) {
        if (filterMode === 'all') {
          filterStore.deactivate(dimSlot);
        } else {
          if (removed.length > 0 && !dimSlot.active) {
            filterStore.activateAllOnes(dimSlot);
          }
          if (dimSlot.active) {
            filterStore.ensureSlotMaterialized(dimSlot);
            var bits = dimSlot.bitset;
            for (i = 0; i < added.length; i++) {
              row = added[i];
              bits[row >>> 5] |= (1 << (row & 31));
            }
            for (i = 0; i < removed.length; i++) {
              row = removed[i];
              bits[row >>> 5] &= ~(1 << (row & 31));
            }
          }
        }
      } else {
        var newAdded = [];
        var newRemoved = [];

        for (i = 0; i < added.length; i++) {
          iterablesIndexCount[added[i]]++;
          iterablesIndexFilterStatus[valueIndexAdded[i]] = 0;
          if (iterablesIndexCount[added[i]] === 1) {
            filterStore.setSlotIncluded(dimSlot, added[i]);
            newAdded.push(added[i]);
          }
        }
        for (i = 0; i < removed.length; i++) {
          iterablesIndexCount[removed[i]]--;
          iterablesIndexFilterStatus[valueIndexRemoved[i]] = 1;
          if (iterablesIndexCount[removed[i]] === 0) {
            filterStore.setSlotExcluded(dimSlot, removed[i]);
            newRemoved.push(removed[i]);
          }
        }

        added = newAdded;
        removed = newRemoved;

        if (includeEmptyRows) {
          for (i = 0; i < iterablesEmptyRows.length; i++) {
            row = iterablesEmptyRows[i];
            if (filterStore.isSlotExcluded(dimSlot, row)) {
              filterStore.setSlotIncluded(dimSlot, row);
              added.push(row);
            }
          }
        } else {
          for (i = 0; i < iterablesEmptyRows.length; i++) {
            row = iterablesEmptyRows[i];
            if (!filterStore.isSlotExcluded(dimSlot, row)) {
              filterStore.setSlotExcluded(dimSlot, row);
              removed.push(row);
            }
          }
        }
        if (filterMode === 'all') {
          filterStore.deactivate(dimSlot);
        }
      }

      notifyFilterListeners(dimSlot, added, removed);
      return dimension;
    }

    function filterIndexRanges(oldRanges, newRanges, includeEmptyRows) {
      var added = [],
          removed = [],
          valueIndexAdded = [],
          valueIndexRemoved = [],
          previousRanges = oldRanges.map(function(range) { return [range[0], range[1]]; }),
          nextRanges = newRanges.map(function(range) { return [range[0], range[1]]; }),
          oldIndex = 0,
          newIndexPointer = 0;

      while (oldIndex < previousRanges.length || newIndexPointer < nextRanges.length) {
        var oldRange = previousRanges[oldIndex],
            newRange = nextRanges[newIndexPointer];

        if (!oldRange) {
          appendIndexedRange(added, valueIndexAdded, newRange[0], newRange[1]);
          ++newIndexPointer;
          continue;
        }

        if (!newRange) {
          appendIndexedRange(removed, valueIndexRemoved, oldRange[0], oldRange[1]);
          ++oldIndex;
          continue;
        }

        if (oldRange[1] <= newRange[0]) {
          appendIndexedRange(removed, valueIndexRemoved, oldRange[0], oldRange[1]);
          ++oldIndex;
          continue;
        }

        if (newRange[1] <= oldRange[0]) {
          appendIndexedRange(added, valueIndexAdded, newRange[0], newRange[1]);
          ++newIndexPointer;
          continue;
        }

        if (oldRange[0] < newRange[0]) {
          appendIndexedRange(removed, valueIndexRemoved, oldRange[0], newRange[0]);
        } else if (newRange[0] < oldRange[0]) {
          appendIndexedRange(added, valueIndexAdded, newRange[0], oldRange[0]);
        }

        if (oldRange[1] < newRange[1]) {
          nextRanges[newIndexPointer] = [oldRange[1], newRange[1]];
          ++oldIndex;
        } else if (newRange[1] < oldRange[1]) {
          previousRanges[oldIndex] = [newRange[1], oldRange[1]];
          ++newIndexPointer;
        } else {
          ++oldIndex;
          ++newIndexPointer;
        }
      }

      lo0 = newRanges.length ? newRanges[0][0] : 0;
      hi0 = newRanges.length ? newRanges[newRanges.length - 1][1] : 0;

      return applyFilterChanges(added, removed, valueIndexAdded, valueIndexRemoved, includeEmptyRows);
    }

    // Updating a dimension is a two-stage process. First, we must update the
    // associated filters for the newly-added records. Once all dimensions have
    // updated their filters, the groups are notified to update.
    dataListeners.unshift(preAdd);
    dataListeners.push(postAdd);

    removeDataListeners.push(removeData);

    var lazyStateGetter = null;
    if (accessorPath && !iterable) {
      lazyStateGetter = function() {
        return (!values && lazyEncodedState) ? lazyEncodedState : null;
      };
      if (!lazyDimensionsByField[accessorPath]) {
        lazyDimensionsByField[accessorPath] = [];
      }
      lazyDimensionsByField[accessorPath].push(lazyStateGetter);
    }

    // Allocate a 1-bit filter slot in filterStore (reusing disposed dimension IDs).
    dimSlot = filterStore.allocSlot();
    id = dimSlot.id;

    function ensureDeferredReady() {
      if (!deferredInit) return;
      deferredInit = false;
      preAdd(data, 0, n);
      postAdd(data, 0, n);
    }

    if (isStringField && !iterable && (columnarBatches.length > 0 || n === 0)) {
      deferredInit = true;
      runtimeController.canUseWasmScan();
    } else {
      preAdd(data, 0, n);
      postAdd(data, 0, n);
    }

    // Incorporates the specified new records into this dimension.
    // This function is responsible for updating filters, values, and index.
    function preAdd(newData, n0, n1) {
      if (deferredInit) {
        if (columnarBatches.length > 0 && columnarBatches[columnarBatches.length - 1].end === n) {
          return;
        }
        deferredInit = false;
        if (n0 > 0) {
          preAdd(data, 0, n);
          return;
        }
      }
      var newIterablesIndexCount,
          sourceValues = null,
          columnAccessorSegment = accessorPath && !iterable
            ? findSingleColumnAccessorSegment(accessorPath, n0, n1)
            : null,
          useStoredRecords = !accessorPath && newData === data && columnarBatches.length,
          newIterablesIndexFilterStatus;

      function ensureSourceValues() {
        if (!accessorPath) {
          return null;
        }
        if (!sourceValues) {
          sourceValues = extractColumnValues(accessorPath, n0, n1);
        }
        return sourceValues;
      }

      function getSourceRecord(localIndex) {
        return useStoredRecords ? getRecord(n0 + localIndex) : newData[localIndex];
      }

      if (!iterable && accessorPath) {
        if (!rawNumericState && !lazyEncodedState && !n0 && !values) {
          if (n1 > 0 && isPureNumericColumnSource(accessorPath)) {
            var initNumCol = getNumericColumn(accessorPath);
            if (!initNumCol.hasNaN) {
              runtimeController.canUseWasmScan();
              rawNumericState = {
                field: accessorPath,
                hasActiveFilterMask: false,
                lastMaskedCount: -1,
                values: initNumCol.values,
                version: 1
              };
              applyRawNumericFilterToRange(0, n1);
              lastAppendedCodes = null;
              lo0 = 0;
              hi0 = 0;
              return;
            }
          }
          lazyEncodedState = columnAccessorSegment
            ? (columnAccessorSegment.arrowDictChunks
              ? createLazyEncodedStateFromArrowDict(columnAccessorSegment.arrowDictChunks, columnAccessorSegment.offset, n1)
              : (columnAccessorSegment.arrowUtf8Chunks
                ? createLazyEncodedStateFromSource(extractArrowUtf8Range(columnAccessorSegment.arrowUtf8Chunks, columnAccessorSegment.offset, n1), null, 0, n1)
                : createLazyEncodedStateFromSource(columnAccessorSegment.column, columnAccessorSegment.accessor, columnAccessorSegment.offset, n1)))
            : createLazyEncodedStateFromSource(ensureSourceValues(), null, 0, n1);
          if (lazyEncodedState) {
            applyLazyFilterToRange(0, n1);
            lastAppendedCodes = getLazyCodes();
            lo0 = 0;
            hi0 = 0;
            return;
          }
        } else if (rawNumericState && !values) {
          if (isPureNumericColumnSource(accessorPath)) {
            var nextNumCol = getNumericColumn(accessorPath);
            if (!nextNumCol.hasNaN) {
              rawNumericState.values = nextNumCol.values;
              rawNumericState.version += 1;
              applyRawNumericFilterToRange(n0, n1);
              lastAppendedCodes = null;
              lo0 = 0;
              hi0 = 0;
              return;
            }
          }
          upgradeRawNumericToLazy(n0);
          if (lazyEncodedState) {
            var upgradedAppendedCodes = columnAccessorSegment
              ? (columnAccessorSegment.arrowDictChunks
                ? appendLazyEncodedValuesFromArrowDict(columnAccessorSegment.arrowDictChunks, columnAccessorSegment.offset, n1)
                : (columnAccessorSegment.arrowUtf8Chunks
                  ? appendLazyEncodedValuesFromSource(extractArrowUtf8Range(columnAccessorSegment.arrowUtf8Chunks, columnAccessorSegment.offset, n1), null, 0, n1)
                  : appendLazyEncodedValuesFromSource(columnAccessorSegment.column, columnAccessorSegment.accessor, columnAccessorSegment.offset, n1)))
              : appendLazyEncodedValuesFromSource(ensureSourceValues(), null, 0, n1);
            if (upgradedAppendedCodes) {
              applyLazyFilterToRange(n0, n1);
              lastAppendedCodes = upgradedAppendedCodes;
              lo0 = 0;
              hi0 = 0;
              return;
            }
          }
          materializeLazyEncodedState();
        } else if (lazyEncodedState && !values) {
          if (
            !n0
            && n1 > 0
            && lazyEncodedState.codesLength === 0
            && !refilterFunction
            && (!filterValuePresent || filterMode === 'all' || filterMode === 'in' || typeof filterValue === 'number' || (Array.isArray(filterValue) && typeof filterValue[0] === 'number' && typeof filterValue[1] === 'number'))
            && isPureNumericColumnSource(accessorPath)
          ) {
            var canPromoteGroups = true;
            for (var pgi = 0; pgi < dimensionGroups.length; ++pgi) {
              if (!dimensionGroups[pgi]._canPromoteToRawNumeric) {
                canPromoteGroups = false;
                break;
              }
            }
            if (canPromoteGroups) {
              var promotedNumCol = getNumericColumn(accessorPath);
              if (!promotedNumCol.hasNaN) {
                rawNumericState = {
                  field: accessorPath,
                  hasActiveFilterMask: false,
                  lastMaskedCount: -1,
                  values: promotedNumCol.values,
                  version: 1
                };
                lazyEncodedState = null;
                lazyFilterTargetCodes = null;
                lazyFilterTargetCodesVersion = 0;
                for (var pgi2 = 0; pgi2 < dimensionGroups.length; ++pgi2) {
                  if (typeof dimensionGroups[pgi2]._onRawNumericPromote === 'function') {
                    dimensionGroups[pgi2]._onRawNumericPromote();
                  }
                }
                applyRawNumericFilterToRange(0, n1);
                lastAppendedCodes = null;
                lo0 = 0;
                hi0 = 0;
                return;
              }
            }
          }
          var appendedCodes = columnAccessorSegment
            ? (columnAccessorSegment.arrowDictChunks
              ? appendLazyEncodedValuesFromArrowDict(columnAccessorSegment.arrowDictChunks, columnAccessorSegment.offset, n1)
              : (columnAccessorSegment.arrowUtf8Chunks
                ? appendLazyEncodedValuesFromSource(extractArrowUtf8Range(columnAccessorSegment.arrowUtf8Chunks, columnAccessorSegment.offset, n1), null, 0, n1)
                : appendLazyEncodedValuesFromSource(columnAccessorSegment.column, columnAccessorSegment.accessor, columnAccessorSegment.offset, n1)))
            : appendLazyEncodedValuesFromSource(ensureSourceValues(), null, 0, n1);
          if (appendedCodes) {
            applyLazyFilterToRange(n0, n1);
            lastAppendedCodes = appendedCodes;
            lo0 = 0;
            hi0 = 0;
            return;
          }
          materializeLazyEncodedState();
        }
      }

      if (iterable){
        sourceValues = ensureSourceValues();
        // Count all the values
        t = 0;
        j = 0;
        k = [];

        for (var i0 = 0; i0 < newData.length; i0++) {
          for(j = 0, k = sourceValues ? sourceValues[i0] : value(getSourceRecord(i0)); j < k.length; j++) {
            t++;
          }
        }

        newValues = [];
        newIterablesIndexCount = cr_range(newData.length);
        newIterablesIndexFilterStatus = cr_index(t,1);
        var unsortedIndex = cr_range(t);

        for (var l = 0, index1 = 0; index1 < newData.length; index1++) {
          k = sourceValues ? sourceValues[index1] : value(getSourceRecord(index1));
          //
          if(!k.length){
            newIterablesIndexCount[index1] = 0;
            iterablesEmptyRows.push(index1 + n0);
            continue;
          }
          newIterablesIndexCount[index1] = k.length
          for (j = 0; j < k.length; j++) {
            newValues.push(k[j]);
            unsortedIndex[l] = index1;
            l++;
          }
        }

        // Create the Sort map used to sort both the values and the valueToData indices
        var sortMap = sortRange(t);

        // Use the sortMap to sort the newValues
        newValues = permute(newValues, sortMap);


        // Use the sortMap to sort the unsortedIndex map
        // newIndex should be a map of sortedValue -> crossfilterData
        newIndex = permute(unsortedIndex, sortMap)

      } else{
        // Permute new values into natural order using a standard sorted index.
        sourceValues = ensureSourceValues();
        if (sourceValues) {
          newValues = sourceValues;
        } else if (useStoredRecords) {
          newValues = new Array(n1);
          for (var recordIndex = 0; recordIndex < n1; ++recordIndex) {
            newValues[recordIndex] = value(getSourceRecord(recordIndex));
          }
        } else {
          newValues = newData.map(value);
        }
        newIndex = sortRange(n1);
        newValues = permute(newValues, newIndex);
      }

      // Bisect newValues to determine which new records are selected.
      var bounds = refilter(newValues), lo1 = bounds[0], hi1 = bounds[1];

      var index2, index3, index4;
      if (iterable) {
        n1 = t;
        if (refilterFunction) {
          for (index2 = 0; index2 < n1; ++index2) {
            if (!refilterFunction(newValues[index2], index2)) {
              if (--newIterablesIndexCount[newIndex[index2]] === 0) {
                filterStore.setSlotExcluded(dimSlot, newIndex[index2] + n0);
              }
              newIterablesIndexFilterStatus[index2] = 1;
            }
          }
        } else {
          for (index3 = 0; index3 < lo1; ++index3) {
            if (--newIterablesIndexCount[newIndex[index3]] === 0) {
              filterStore.setSlotExcluded(dimSlot, newIndex[index3] + n0);
            }
            newIterablesIndexFilterStatus[index3] = 1;
          }
          for (index4 = hi1; index4 < n1; ++index4) {
            if (--newIterablesIndexCount[newIndex[index4]] === 0) {
              filterStore.setSlotExcluded(dimSlot, newIndex[index4] + n0);
            }
            newIterablesIndexFilterStatus[index4] = 1;
          }
        }
      } else {
        if (refilterFunction) {
          for (index2 = 0; index2 < n1; ++index2) {
            if (!refilterFunction(newValues[index2], index2)) {
              filterStore.setSlotExcluded(dimSlot, newIndex[index2] + n0);
            }
          }
        } else {
          for (index3 = 0; index3 < lo1; ++index3) {
            filterStore.setSlotExcluded(dimSlot, newIndex[index3] + n0);
          }
          for (index4 = hi1; index4 < n1; ++index4) {
            filterStore.setSlotExcluded(dimSlot, newIndex[index4] + n0);
          }
        }
      }

      // If this dimension previously had no data, then we don't need to do the
      // more expensive merge operation; use the new values and index as-is.
      if (!n0) {
        values = newValues;
        index = newIndex;
        iterablesIndexCount = newIterablesIndexCount;
        iterablesIndexFilterStatus = newIterablesIndexFilterStatus;
        exactRangeCache.clear();
        lo0 = lo1;
        hi0 = hi1;
        return;
      }



      var oldValues = values,
        oldIndex = index,
        oldIterablesIndexFilterStatus = iterablesIndexFilterStatus,
        old_n0,
        i1 = 0;

      i0 = 0;

      if(iterable){
        old_n0 = n0
        n0 = oldValues.length;
        n1 = t
      }

      // Otherwise, create new arrays into which to merge new and old.
      values = iterable ? new Array(n0 + n1) : new Array(n);
      index = iterable ? new Array(n0 + n1) : cr_index(n, n);
      if(iterable) iterablesIndexFilterStatus = cr_index(n0 + n1, 1);

      // Concatenate the newIterablesIndexCount onto the old one.
      if(iterable) {
        var oldiiclength = iterablesIndexCount.length;
        iterablesIndexCount = xfilterArray.arrayLengthen(iterablesIndexCount, n);
        for(var j=0; j+oldiiclength < n; j++) {
          iterablesIndexCount[j+oldiiclength] = newIterablesIndexCount[j];
        }
      }

      // Merge the old and new sorted values, and old and new index.
      var index5 = 0;
      for (; i0 < n0 && i1 < n1; ++index5) {
        if (compareNaturalOrder(oldValues[i0], newValues[i1]) < 0) {
          values[index5] = oldValues[i0];
          if(iterable) iterablesIndexFilterStatus[index5] = oldIterablesIndexFilterStatus[i0];
          index[index5] = oldIndex[i0++];
        } else {
          values[index5] = newValues[i1];
          if(iterable) iterablesIndexFilterStatus[index5] = newIterablesIndexFilterStatus[i1];
          index[index5] = newIndex[i1++] + (iterable ? old_n0 : n0);
        }
      }

      // Add any remaining old values.
      for (; i0 < n0; ++i0, ++index5) {
        values[index5] = oldValues[i0];
        if(iterable) iterablesIndexFilterStatus[index5] = oldIterablesIndexFilterStatus[i0];
        index[index5] = oldIndex[i0];
      }

      // Add any remaining new values.
      for (; i1 < n1; ++i1, ++index5) {
        values[index5] = newValues[i1];
        if(iterable) iterablesIndexFilterStatus[index5] = newIterablesIndexFilterStatus[i1];
        index[index5] = newIndex[i1] + (iterable ? old_n0 : n0);
      }

      // Bisect again to recompute lo0 and hi0.
      exactRangeCache.clear();
      bounds = refilter(values), lo0 = bounds[0], hi0 = bounds[1];
    }

    // When all filters have updated, notify index listeners of the new values.
    function postAdd(newData, n0, n1) {
      if (deferredInit) return;
      indexListeners.forEach(function(l) { l(newValues, newIndex, n0, n1, lastAppendedCodes); });
      newValues = newIndex = null;
      lastAppendedCodes = null;
    }

    function removeData(reIndex) {
      if (deferredInit) return;
      if (rawNumericState && !values) {
        var rLen = 0,
            ri,
            rj,
            rawHasMask = false;
        for (ri = 0; ri < reIndex.length; ++ri) {
          if (reIndex[ri] !== REMOVED_INDEX) ++rLen;
        }
        var nextRawVals = new Float64Array(rLen < 64 ? 64 : rLen);
        var oldRawVals = rawNumericState.values;
        for (ri = 0, rj = 0; ri < reIndex.length; ++ri) {
          if (reIndex[ri] === REMOVED_INDEX) continue;
          nextRawVals[rj++] = oldRawVals[ri];
          if (!rawHasMask && filterStore.isSlotExcluded(dimSlot, ri)) rawHasMask = true;
        }
        if (!rawHasMask && dimSlot.active) {
          filterStore.deactivate(dimSlot);
        }
        rawNumericState.values = nextRawVals;
        rawNumericState.hasActiveFilterMask = rawHasMask;
        rawNumericState.lastMaskedCount = -1;
        rawNumericState.version += 1;
        lo0 = 0;
        hi0 = 0;
        for (ri = 0; ri < dimensionGroups.length; ++ri) {
          if (typeof dimensionGroups[ri]._onRawNumericRemove === 'function') {
            dimensionGroups[ri]._onRawNumericRemove();
          }
        }
        return;
      }
      if (lazyEncodedState && !values) {
        compactLazyEncodedState(reIndex);
        return;
      }

      if (iterable) {
        for (var i0 = 0, i1 = 0; i0 < iterablesEmptyRows.length; i0++) {
          if (reIndex[iterablesEmptyRows[i0]] !== REMOVED_INDEX) {
            iterablesEmptyRows[i1] = reIndex[iterablesEmptyRows[i0]];
            i1++;
          }
        }
        iterablesEmptyRows.length = i1;
        for (i0 = 0, i1 = 0; i0 < n; i0++) {
          if (reIndex[i0] !== REMOVED_INDEX) {
            if (i1 !== i0) iterablesIndexCount[i1] = iterablesIndexCount[i0];
            i1++;
          }
        }
        iterablesIndexCount = iterablesIndexCount.slice(0, i1);
      }
      // Rewrite our index, overwriting removed values
      var n0 = values.length;
      for (var i = 0, j = 0, oldDataIndex; i < n0; ++i) {
        oldDataIndex = index[i];
        if (reIndex[oldDataIndex] !== REMOVED_INDEX) {
          if (i !== j) values[j] = values[i];
          index[j] = reIndex[oldDataIndex];
          if (iterable) {
            iterablesIndexFilterStatus[j] = iterablesIndexFilterStatus[i];
          }
          ++j;
        }
      }
      values.length = j;
      if (iterable) iterablesIndexFilterStatus = iterablesIndexFilterStatus.slice(0, j);
      while (j < n0) index[j++] = 0;

      // Bisect again to recompute lo0 and hi0.
      exactRangeCache.clear();
      var bounds = refilter(values);
      lo0 = bounds[0], hi0 = bounds[1];
    }

    // Updates the selected values based on the specified bounds [lo, hi].
    // This implementation is used by all the public filter methods.
    function filterIndexBounds(bounds, includeEmptyRows, nextMode) {
      var lo1 = bounds[0],
          hi1 = bounds[1],
          previousMode = filterMode,
          oldRanges = resolveCurrentRanges(),
          newRanges = lo1 === hi1 ? [] : [[lo1, hi1]];

      if (includeEmptyRows === undefined) {
        includeEmptyRows = false;
      }
      if (nextMode === undefined) {
        nextMode = 'bounds';
      }

      if (oldRanges === null) {
        refilterFunction = null;
        filterMode = nextMode;
        filterInValues = null;
        filterIndexFunction(function(d, i) { return lo1 <= i && i < hi1; }, includeEmptyRows);
        lo0 = lo1;
        hi0 = hi1;
        return dimension;
      }

      refilterFunction = null;
      filterMode = nextMode;
      filterInValues = null;

      if (previousMode === 'in') {
        return filterIndexRanges(oldRanges, newRanges, includeEmptyRows);
      }

      var i,
          j,
          added = [],
          removed = [],
          valueIndexAdded = [],
          valueIndexRemoved = [];

      if (lo1 < lo0) {
        for (i = lo1, j = Math.min(lo0, hi1); i < j; ++i) {
          added.push(index[i]);
          valueIndexAdded.push(i);
        }
      } else if (lo1 > lo0) {
        for (i = lo0, j = Math.min(lo1, hi0); i < j; ++i) {
          removed.push(index[i]);
          valueIndexRemoved.push(i);
        }
      }

      if (hi1 > hi0) {
        for (i = Math.max(lo1, hi0), j = hi1; i < j; ++i) {
          added.push(index[i]);
          valueIndexAdded.push(i);
        }
      } else if (hi1 < hi0) {
        for (i = Math.max(lo0, hi1), j = hi0; i < j; ++i) {
          removed.push(index[i]);
          valueIndexRemoved.push(i);
        }
      }

      lo0 = lo1;
      hi0 = hi1;

      return applyFilterChanges(added, removed, valueIndexAdded, valueIndexRemoved, includeEmptyRows);
    }

    // Filters this dimension using the specified range, value, or null.
    // If the range is null, this is equivalent to filterAll.
    // If the range is an array, this is equivalent to filterRange.
    // Otherwise, this is equivalent to filterExact.
    function filter(range) {
      return range == null
          ? filterAll() : Array.isArray(range)
          ? filterRange(range) : typeof range === "function"
          ? filterFunction(range)
          : filterExact(range);
    }

    function materializeRawBrushBitset() {
      if (!rawNumericState || values) return;
      var vals = rawNumericState.values;
      var writeMode = brushQueryKind === 'exact' ? 3 : 4;
      var matched = filterStore.writePredicateNoDelta(dimSlot, writeMode, vals, brushLo, brushHi);
      if (matched === n) {
        filterStore.deactivate(dimSlot);
        rawNumericState.hasActiveFilterMask = false;
        rawNumericState.lastMaskedCount = 0;
      } else {
        rawNumericState.hasActiveFilterMask = true;
        rawNumericState.lastMaskedCount = n - matched;
      }
    }

    function materializeLazyBrushBitset() {
      if (!lazyEncodedState || values) return;
      var targetCodes = brushQueryKind === 'exact'
        ? encodeLazyFilterValues([brushLo])
        : computeLazyRangeCodes([brushLo, brushHi]);
      if (!targetCodes) {
        filterStore.writePredicateNoDelta(dimSlot, 0, lazyEncodedState.codes, 0, 0);
        lazyEncodedState.hasActiveFilterMask = true;
        lazyEncodedState.lastSelectedCount = 0;
        return;
      }
      if (brushQueryKind === 'range') {
        lazyFilterTargetCodes = targetCodes;
        lazyFilterTargetCodesVersion = lazyEncodedState.codeToValue.length;
      }
      var selCount = countLazySelectedRows(targetCodes);
      if (selCount === n) {
        filterStore.deactivate(dimSlot);
        lazyEncodedState.hasActiveFilterMask = false;
        lazyEncodedState.lastSelectedCount = -1;
        return;
      }
      var targetCount = targetCodes.length;
      var writeMode = targetCount === 0 ? 0 : (targetCount === 1 ? 1 : 2);
      var argA = targetCount === 1 ? targetCodes[0] : null;
      var argB = 0;
      if (targetCount > 1) {
        argB = nextLazyMarkVersion();
        argA = lazyEncodedState.selectionMarks;
        for (var mi = 0; mi < targetCount; ++mi) argA[targetCodes[mi]] = argB;
      }
      filterStore.writePredicateNoDelta(dimSlot, writeMode, lazyEncodedState.codes, argA, argB);
      lazyEncodedState.hasActiveFilterMask = true;
      lazyEncodedState.lastSelectedCount = selCount;
    }

    function tryEnterFalconBrush(queryKind, lo, hi, isRaw) {
      if (transientFilterDepth > 0 || batchedFilterDepth > 0 || n < 256) {
        return false;
      }
      var otherMode = filterListeners.length > 0 ? inspectOtherFilterListeners(dimSlot) : 0;
      if (otherMode !== 1) {
        return false;
      }
      if (brushDimSlot !== dimSlot) {
        invalidateBrushState();
        brushDimSlot = dimSlot;
        brushSameDimCount = 1;
        return false;
      }
      brushSameDimCount += 1;
      if (brushBuildFailed) {
        return false;
      }
      // On exact queries, only use Falcon if discrete mode (raw or lazy); avoid continuous CSR exact scan overhead on single clicks
      if (queryKind === 'exact' && brushFalcon && brushFalcon.mode !== 'discrete') {
        return false;
      }
      filterMode = 'bounds';
      lo0 = 0;
      hi0 = 0;
      brushActive = true;
      brushQueryKind = queryKind;
      brushLo = lo;
      brushHi = hi;
      brushDimSource = isRaw
        ? function() { return { isNumeric: true, rawVals: rawNumericState.values, lazyCodes: null, lazyCodeToValue: null }; }
        : function() { return { isNumeric: lazyEncodedState.isPureNumeric, rawVals: null, lazyCodes: lazyEncodedState.codes, lazyCodeToValue: lazyEncodedState.codeToValue }; };
      dimSlot.materialize = isRaw ? materializeRawBrushBitset : materializeLazyBrushBitset;
      filterStore.markDirty(dimSlot);
      if (isRaw) {
        rawNumericState.hasActiveFilterMask = true;
        rawNumericState.lastMaskedCount = -1;
      } else {
        lazyEncodedState.hasActiveFilterMask = true;
        lazyEncodedState.lastSelectedCount = -1;
      }
      notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, true);
      return true;
    }

    // Filters this dimension to select the exact value.
    function filterExact(value) {
      ensureDeferredReady();
      lazyFilterTargetCodes = null;
      lazyFilterTargetCodesVersion = 0;
      if (rawNumericState && !values) {
        if (isLazyEncodedValue(value)) {
          filterValue = value;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterExact(bisect, value);
          refilterFunction = null;
          filterInValues = null;
          if (typeof value === 'number' && value === value) {
            if (tryEnterFalconBrush('exact', value, value, true)) {
              return dimension;
            }
            if (brushDimSlot === dimSlot) brushActive = false;
            return applyRawNumericPredicate(1, value, 0, 'bounds');
          }
          if (brushDimSlot === dimSlot) invalidateBrushState();
          return applyRawNumericPredicate(0, 0, 0, 'bounds');
        }
        materializeLazyEncodedState();
      }
      if (lazyEncodedState && !values) {
        var exactCodes = encodeLazyFilterValues([value]);
        if (exactCodes) {
          filterValue = value;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterExact(bisect, value);
          refilterFunction = null;
          filterInValues = null;
          if (
            hasLazyEncodedGroupingSupport()
            && ((lazyEncodedState.isPureNumeric && typeof value === 'number' && value === value)
              || (lazyEncodedState.isPureString && typeof value === 'string'))
            && tryEnterFalconBrush('exact', value, value, false)
          ) {
            return dimension;
          }
          if (brushDimSlot === dimSlot) brushActive = false;
          return applyLazyEncodedFilter(exactCodes, 'bounds');
        }
        materializeLazyEncodedState();
      }

      if (brushDimSlot === dimSlot) invalidateBrushState();
      filterValue = value;
      setFilterValuePresent(true);
      refilter = xfilterFilter.filterExact(bisect, value);
      var range = getExactRange(value);
      return filterIndexBounds(range || [0, 0], false, 'bounds');
    }

    function filterIn(valuesToSelect) {
      ensureDeferredReady();
      if (brushDimSlot === dimSlot) {
        filterStore.ensureSlotMaterialized(dimSlot);
        invalidateBrushState();
      }
      lazyFilterTargetCodes = null;
      lazyFilterTargetCodesVersion = 0;
      if (rawNumericState && !values) {
        var rawExactFilterValues = normalizeExactFilterValues(valuesToSelect),
            allLazy = true,
            numSet = new Set(),
            ri;
        for (ri = 0; ri < rawExactFilterValues.length; ++ri) {
          var rv = rawExactFilterValues[ri];
          if (!isLazyEncodedValue(rv)) {
            allLazy = false;
            break;
          }
          if (typeof rv === 'number' && rv === rv) {
            numSet.add(rv);
          }
        }
        if (allLazy) {
          filterValue = valuesToSelect;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterAll;
          refilterFunction = null;
          filterMode = 'in';
          filterInValues = rawExactFilterValues;
          if (numSet.size === 0) {
            return applyRawNumericPredicate(0, 0, 0, 'in');
          }
          if (numSet.size === 1) {
            return applyRawNumericPredicate(1, numSet.values().next().value, 0, 'in');
          }
          return applyRawNumericPredicate(3, numSet, 0, 'in');
        }
        materializeLazyEncodedState();
      }
      if (lazyEncodedState && !values) {
        var lazyExactFilterValues = normalizeExactFilterValues(valuesToSelect),
            lazyEncodedValues = encodeLazyFilterValues(lazyExactFilterValues);

        if (lazyEncodedValues) {
          filterValue = valuesToSelect;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterAll;
          refilterFunction = null;
          filterMode = 'in';
          filterInValues = lazyExactFilterValues;
          return applyLazyEncodedFilter(lazyEncodedValues, 'in');
        }

        materializeLazyEncodedState();
      }

      var exactFilterValues = normalizeExactFilterValues(valuesToSelect),
          nextRanges = exactRanges(exactFilterValues),
          previousRanges = resolveCurrentRanges(),
          selectedValues = new Set(exactFilterValues),
          predicate = function(d) { return selectedValues.has(d); };

      filterValue = valuesToSelect;
      setFilterValuePresent(true);
      refilter = xfilterFilter.filterAll;
      refilterFunction = predicate;
      filterMode = 'in';
      filterInValues = exactFilterValues;

      if (previousRanges === null) {
        filterIndexFunction(predicate, false);
        lo0 = nextRanges.length ? nextRanges[0][0] : 0;
        hi0 = nextRanges.length ? nextRanges[nextRanges.length - 1][1] : 0;
        return dimension;
      }

      return filterIndexRanges(previousRanges, nextRanges, false);
    }

    // Filters this dimension to select the specified range [lo, hi].
    // The lower bound is inclusive, and the upper bound is exclusive.
    function filterRange(range) {
      ensureDeferredReady();
      if (rawNumericState && !values) {
        var rLo = range[0],
            rHi = range[1];
        if (typeof rLo === 'number' && typeof rHi === 'number' && rLo === rLo && rHi === rHi) {
          filterValue = range;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterRange(bisect, range);
          refilterFunction = null;
          filterInValues = null;
          if (tryEnterFalconBrush('range', rLo, rHi, true)) {
            return dimension;
          }
          if (brushDimSlot === dimSlot) brushActive = false;
          return applyRawNumericPredicate(2, rLo, rHi, 'bounds');
        }
        upgradeRawNumericToLazy(n);
      }
      if (lazyEncodedState && !values && hasLazyEncodedGroupingSupport()) {
        filterValue = range;
        setFilterValuePresent(true);
        refilter = xfilterFilter.filterRange(bisect, range);
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'bounds';
        if (
          ((lazyEncodedState.isPureNumeric && typeof range[0] === 'number' && typeof range[1] === 'number' && range[0] === range[0] && range[1] === range[1])
            || (lazyEncodedState.isPureString && typeof range[0] === 'string' && typeof range[1] === 'string'))
          && tryEnterFalconBrush('range', range[0], range[1], false)
        ) {
          lazyFilterTargetCodes = null;
          lazyFilterTargetCodesVersion = 0;
          return dimension;
        }
        if (brushDimSlot === dimSlot) brushActive = false;
        lazyFilterTargetCodes = computeLazyRangeCodes(range);
        lazyFilterTargetCodesVersion = lazyEncodedState.codeToValue.length;
        return applyLazyEncodedFilter(lazyFilterTargetCodes, 'bounds');
      }

      if (lazyEncodedState && !values) {
        materializeLazyEncodedState();
      }

      if (brushDimSlot === dimSlot) invalidateBrushState();
      filterValue = range;
      setFilterValuePresent(true);
      return filterIndexBounds((refilter = xfilterFilter.filterRange(bisect, range))(values), false, 'bounds');
    }

    // Clears any filters on this dimension.
    function filterAll() {
      lazyFilterTargetCodes = null;
      lazyFilterTargetCodesVersion = 0;
      if (brushDimSlot === dimSlot) {
        invalidateBrushState();
      }
      if (deferredInit) {
        filterValue = undefined;
        setFilterValuePresent(false);
        refilter = xfilterFilter.filterAll;
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'all';
        return dimension;
      }
      if (rawNumericState && !values) {
        filterValue = undefined;
        setFilterValuePresent(false);
        refilter = xfilterFilter.filterAll;
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'all';
        return applyRawNumericClearFilter();
      }
      if (lazyEncodedState && !values) {
        filterValue = undefined;
        setFilterValuePresent(false);
        refilter = xfilterFilter.filterAll;
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'all';
        return applyLazyClearFilter();
      }

      filterValue = undefined;
      setFilterValuePresent(false);
      refilter = xfilterFilter.filterAll;

      return filterIndexBounds((refilter = xfilterFilter.filterAll)(values), true, 'all');
    }

    // Filters this dimension using an arbitrary function.
    function filterFunction(f) {
      ensureDeferredReady();
      if (brushDimSlot === dimSlot) {
        filterStore.ensureSlotMaterialized(dimSlot);
        invalidateBrushState();
      }
      lazyFilterTargetCodes = null;
      lazyFilterTargetCodesVersion = 0;
      if ((rawNumericState || lazyEncodedState) && !values) {
        materializeLazyEncodedState();
      }

      filterValue = f;
      setFilterValuePresent(true);

      refilterFunction = f;
      refilter = xfilterFilter.filterAll;
      filterMode = 'function';
      filterInValues = null;

      filterIndexFunction(f, false);

      var bounds = refilter(values);
      lo0 = bounds[0], hi0 = bounds[1];

      return dimension;
    }

    function filterIndexFunction(f, filterAll) {
      var i,
          k,
          x,
          added = [],
          removed = [],
          valueIndexAdded = [],
          valueIndexRemoved = [],
          indexLength = values.length;

      if (!iterable) {
        for (i = 0; i < indexLength; ++i) {
          k = index[i];
          if (!filterStore.isSlotExcluded(dimSlot, k) ^ !!(x = f(values[i], i))) {
            if (x) added.push(k);
            else removed.push(k);
          }
        }
      }

      if (iterable) {
        for (i = 0; i < indexLength; ++i) {
          if (f(values[i], i)) {
            added.push(index[i]);
            valueIndexAdded.push(i);
          } else {
            removed.push(index[i]);
            valueIndexRemoved.push(i);
          }
        }
      }

      if (!iterable) {
        if (filterAll) {
          filterStore.deactivate(dimSlot);
        } else {
          for (i = 0; i < added.length; i++) {
            filterStore.setSlotIncluded(dimSlot, added[i]);
          }
          for (i = 0; i < removed.length; i++) {
            filterStore.setSlotExcluded(dimSlot, removed[i]);
          }
        }
      } else {
        var newAdded = [];
        var newRemoved = [];
        for (i = 0; i < added.length; i++) {
          if (iterablesIndexFilterStatus[valueIndexAdded[i]] === 1) {
            iterablesIndexCount[added[i]]++;
            iterablesIndexFilterStatus[valueIndexAdded[i]] = 0;
            if (iterablesIndexCount[added[i]] === 1) {
              filterStore.setSlotIncluded(dimSlot, added[i]);
              newAdded.push(added[i]);
            }
          }
        }
        for (i = 0; i < removed.length; i++) {
          if (iterablesIndexFilterStatus[valueIndexRemoved[i]] === 0) {
            iterablesIndexCount[removed[i]]--;
            iterablesIndexFilterStatus[valueIndexRemoved[i]] = 1;
            if (iterablesIndexCount[removed[i]] === 0) {
              filterStore.setSlotExcluded(dimSlot, removed[i]);
              newRemoved.push(removed[i]);
            }
          }
        }

        added = newAdded;
        removed = newRemoved;

        if (filterAll) {
          for (i = 0; i < iterablesEmptyRows.length; i++) {
            k = iterablesEmptyRows[i];
            if (filterStore.isSlotExcluded(dimSlot, k)) {
              filterStore.setSlotIncluded(dimSlot, k);
              added.push(k);
            }
          }
          filterStore.deactivate(dimSlot);
        } else {
          for (i = 0; i < iterablesEmptyRows.length; i++) {
            k = iterablesEmptyRows[i];
            if (!filterStore.isSlotExcluded(dimSlot, k)) {
              filterStore.setSlotExcluded(dimSlot, k);
              removed.push(k);
            }
          }
        }
      }

      notifyFilterListeners(dimSlot, added, removed);
    }

    function currentFilter() {
      return filterValue;
    }

    function hasCurrentFilter() {
      return filterValuePresent;
    }

    function readDimensionBounds() {
      if (iterable) {
        return null;
      }
      ensureDeferredReady();

      if (rawNumericState && !values) {
        var rVals = rawNumericState.values,
            rMin,
            rMax,
            ri,
            rv,
            rActive = getActiveRows();
        if (!rActive) {
          if (!n) return { max: null, min: null };
          rMin = rMax = rVals[0];
          for (ri = 1; ri < n; ++ri) {
            rv = rVals[ri];
            if (rv < rMin) rMin = rv;
            if (rv > rMax) rMax = rv;
          }
          return { max: rMax, min: rMin };
        }
        var rLen = rActive.length,
            rIdx = rActive.indices;
        if (!rLen) return { max: null, min: null };
        rMin = rMax = rVals[rIdx[0]];
        for (ri = 1; ri < rLen; ++ri) {
          rv = rVals[rIdx[ri]];
          if (rv < rMin) rMin = rv;
          if (rv > rMax) rMax = rv;
        }
        return { max: rMax, min: rMin };
      }

      if (lazyEncodedState && !values) {
        var codeToValue = lazyEncodedState.codeToValue,
            codeCounts = lazyEncodedState.codeCounts,
            codes = lazyEncodedState.codes,
            isPureNum = lazyEncodedState.isPureNumeric,
            hasAny = false,
            minVal = null,
            maxVal = null,
            c,
            i,
            v,
            active = getActiveRows();

        if (!active) {
          if (!n) return { max: null, min: null };
          if (isPureNum) {
            for (c = 1; c < codeToValue.length; ++c) {
              if (!codeCounts[c]) continue;
              v = codeToValue[c];
              if (!hasAny) {
                minVal = maxVal = v;
                hasAny = true;
              } else {
                if (v < minVal) minVal = v;
                if (v > maxVal) maxVal = v;
              }
            }
          } else {
            for (c = 1; c < codeToValue.length; ++c) {
              if (!codeCounts[c]) continue;
              v = codeToValue[c];
              if (!hasAny) {
                minVal = maxVal = v;
                hasAny = true;
              } else {
                if (compareNaturalOrder(v, minVal) < 0) minVal = v;
                if (compareNaturalOrder(v, maxVal) > 0) maxVal = v;
              }
            }
          }
          return {
            max: hasAny && maxVal != null ? maxVal : null,
            min: hasAny && minVal != null ? minVal : null
          };
        }

        var activeLen = active.length,
            activeIdx = active.indices;
        if (!activeLen) {
          return { max: null, min: null };
        }

        if (isPureNum) {
          minVal = maxVal = codeToValue[codes[activeIdx[0]]];
          for (i = 1; i < activeLen; ++i) {
            v = codeToValue[codes[activeIdx[i]]];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
          }
          return {
            max: maxVal != null ? maxVal : null,
            min: minVal != null ? minVal : null
          };
        }

        var markVersion = nextLazyMarkVersion(),
            marks = lazyEncodedState.selectionMarks;
        for (i = 0; i < activeLen; ++i) {
          marks[codes[activeIdx[i]]] = markVersion;
        }
        for (c = 1; c < codeToValue.length; ++c) {
          if (marks[c] !== markVersion) continue;
          v = codeToValue[c];
          if (!hasAny) {
            minVal = maxVal = v;
            hasAny = true;
          } else {
            if (compareNaturalOrder(v, minVal) < 0) minVal = v;
            if (compareNaturalOrder(v, maxVal) > 0) maxVal = v;
          }
        }
        return {
          max: hasAny && maxVal != null ? maxVal : null,
          min: hasAny && minVal != null ? minVal : null
        };
      }

      if (!values) {
        return { max: null, min: null };
      }

      var loVal = null,
          hiVal = null,
          idx;
      for (idx = lo0; idx < hi0; ++idx) {
        if (filterStore.isActive(index[idx])) {
          loVal = values[idx];
          break;
        }
      }
      if (idx === hi0) {
        return { max: null, min: null };
      }
      for (idx = hi0 - 1; idx >= lo0; --idx) {
        if (filterStore.isActive(index[idx])) {
          hiVal = values[idx];
          break;
        }
      }
      return {
        max: hiVal == null ? null : hiVal,
        min: loVal == null ? null : loVal
      };
    }

    function lazyTopBottomIndex(k, skipOffset, isTop) {
      if (k <= 0) {
        return [];
      }
      var isRaw = !!(rawNumericState && !lazyEncodedState);
      if (!isRaw && lazyEncodedState.hasUnorderable) {
        return null;
      }

      var toSkip = skipOffset && skipOffset > 0 ? skipOffset : 0,
          need = k + toSkip,
          activeIndices = null,
          rowCount;

      var active = getActiveRows();
      if (!active) {
        rowCount = n;
      } else {
        activeIndices = active.indices;
        rowCount = active.length;
      }

      if (rowCount <= toSkip) {
        return [];
      }

      if (need > 4096 && rowCount > 4096) {
        return null;
      }

      var rawVals = isRaw ? rawNumericState.values : null,
          codes = isRaw ? null : lazyEncodedState.codes,
          useNumeric = isRaw || lazyEncodedState.isPureNumeric,
          keyTable = isRaw ? null : (useNumeric ? lazyEncodedState.codeToValue : getLazyCodeRank()),
          i,
          r,
          v;

      if (need >= rowCount) {
        var allRows = new Array(rowCount);
        if (activeIndices) {
          for (i = 0; i < rowCount; ++i) allRows[i] = activeIndices[i];
        } else {
          for (i = 0; i < rowCount; ++i) allRows[i] = i;
        }
        if (isRaw) {
          allRows.sort(isTop
            ? function(a, b) {
                var va = rawVals[a], vb = rawVals[b];
                return va < vb ? 1 : va > vb ? -1 : b - a;
              }
            : function(a, b) {
                var va = rawVals[a], vb = rawVals[b];
                return va < vb ? -1 : va > vb ? 1 : a - b;
              });
        } else {
          allRows.sort(isTop
            ? function(a, b) {
                var va = keyTable[codes[a]], vb = keyTable[codes[b]];
                return va < vb ? 1 : va > vb ? -1 : b - a;
              }
            : function(a, b) {
                var va = keyTable[codes[a]], vb = keyTable[codes[b]];
                return va < vb ? -1 : va > vb ? 1 : a - b;
              });
        }
        return toSkip > 0 ? allRows.slice(toSkip, toSkip + k) : (allRows.length > k ? allRows.slice(0, k) : allRows);
      }

      var heapRow = new Uint32Array(need),
          heapVal = useNumeric ? new Float64Array(need) : new Uint32Array(need),
          heapSize = 0,
          heapRoot = 0,
          pos,
          parent,
          left,
          right,
          child,
          pv,
          pr,
          cv,
          cr;

      function pushTop(val, row) {
        if (heapSize < need) {
          pos = heapSize++;
          while (pos > 0) {
            parent = (pos - 1) >>> 1;
            pv = heapVal[parent];
            pr = heapRow[parent];
            if (val < pv || (val === pv && row < pr)) {
              heapVal[pos] = pv;
              heapRow[pos] = pr;
              pos = parent;
            } else {
              break;
            }
          }
          heapVal[pos] = val;
          heapRow[pos] = row;
          if (heapSize === need) heapRoot = heapVal[0];
        } else {
          pos = 0;
          while ((left = (pos << 1) + 1) < heapSize) {
            child = left;
            right = left + 1;
            if (right < heapSize) {
              cv = heapVal[right];
              cr = heapRow[right];
              if (cv < heapVal[left] || (cv === heapVal[left] && cr < heapRow[left])) {
                child = right;
              }
            }
            cv = heapVal[child];
            cr = heapRow[child];
            if (cv < val || (cv === val && cr < row)) {
              heapVal[pos] = cv;
              heapRow[pos] = cr;
              pos = child;
            } else {
              break;
            }
          }
          heapVal[pos] = val;
          heapRow[pos] = row;
          heapRoot = heapVal[0];
        }
      }

      function pushBottom(val, row) {
        if (heapSize < need) {
          pos = heapSize++;
          while (pos > 0) {
            parent = (pos - 1) >>> 1;
            pv = heapVal[parent];
            pr = heapRow[parent];
            if (val > pv || (val === pv && row > pr)) {
              heapVal[pos] = pv;
              heapRow[pos] = pr;
              pos = parent;
            } else {
              break;
            }
          }
          heapVal[pos] = val;
          heapRow[pos] = row;
          if (heapSize === need) heapRoot = heapVal[0];
        } else {
          pos = 0;
          while ((left = (pos << 1) + 1) < heapSize) {
            child = left;
            right = left + 1;
            if (right < heapSize) {
              cv = heapVal[right];
              cr = heapRow[right];
              if (cv > heapVal[left] || (cv === heapVal[left] && cr > heapRow[left])) {
                child = right;
              }
            }
            cv = heapVal[child];
            cr = heapRow[child];
            if (cv > val || (cv === val && cr > row)) {
              heapVal[pos] = cv;
              heapRow[pos] = cr;
              pos = child;
            } else {
              break;
            }
          }
          heapVal[pos] = val;
          heapRow[pos] = row;
          heapRoot = heapVal[0];
        }
      }

      if (isTop) {
        if (isRaw) {
          if (!activeIndices) {
            for (i = 0; i < need; ++i) pushTop(rawVals[i], i);
            for (; i < rowCount; ++i) {
              v = rawVals[i];
              if (v >= heapRoot) pushTop(v, i);
            }
          } else {
            for (i = 0; i < need; ++i) { r = activeIndices[i]; pushTop(rawVals[r], r); }
            for (; i < rowCount; ++i) {
              r = activeIndices[i];
              v = rawVals[r];
              if (v >= heapRoot) pushTop(v, r);
            }
          }
        } else if (!activeIndices) {
          for (i = 0; i < need; ++i) pushTop(keyTable[codes[i]], i);
          for (; i < rowCount; ++i) {
            v = keyTable[codes[i]];
            if (v >= heapRoot) pushTop(v, i);
          }
        } else {
          for (i = 0; i < need; ++i) { r = activeIndices[i]; pushTop(keyTable[codes[r]], r); }
          for (; i < rowCount; ++i) {
            r = activeIndices[i];
            v = keyTable[codes[r]];
            if (v >= heapRoot) pushTop(v, r);
          }
        }
      } else {
        if (isRaw) {
          if (!activeIndices) {
            for (i = 0; i < need; ++i) pushBottom(rawVals[i], i);
            for (; i < rowCount; ++i) {
              v = rawVals[i];
              if (v < heapRoot) pushBottom(v, i);
            }
          } else {
            for (i = 0; i < need; ++i) { r = activeIndices[i]; pushBottom(rawVals[r], r); }
            for (; i < rowCount; ++i) {
              r = activeIndices[i];
              v = rawVals[r];
              if (v < heapRoot) pushBottom(v, r);
            }
          }
        } else if (!activeIndices) {
          for (i = 0; i < need; ++i) pushBottom(keyTable[codes[i]], i);
          for (; i < rowCount; ++i) {
            v = keyTable[codes[i]];
            if (v < heapRoot) pushBottom(v, i);
          }
        } else {
          for (i = 0; i < need; ++i) { r = activeIndices[i]; pushBottom(keyTable[codes[r]], r); }
          for (; i < rowCount; ++i) {
            r = activeIndices[i];
            v = keyTable[codes[r]];
            if (v < heapRoot) pushBottom(v, r);
          }
        }
      }

      var result = new Array(heapSize);
      for (i = 0; i < heapSize; ++i) result[i] = heapRow[i];
      if (isRaw) {
        result.sort(isTop
          ? function(a, b) {
              var va = rawVals[a], vb = rawVals[b];
              return va < vb ? 1 : va > vb ? -1 : b - a;
            }
          : function(a, b) {
              var va = rawVals[a], vb = rawVals[b];
              return va < vb ? -1 : va > vb ? 1 : a - b;
            });
      } else {
        result.sort(isTop
          ? function(a, b) {
              var va = keyTable[codes[a]], vb = keyTable[codes[b]];
              return va < vb ? 1 : va > vb ? -1 : b - a;
            }
          : function(a, b) {
              var va = keyTable[codes[a]], vb = keyTable[codes[b]];
              return va < vb ? -1 : va > vb ? 1 : a - b;
            });
      }
      return toSkip > 0 ? result.slice(toSkip, toSkip + k) : (result.length > k ? result.slice(0, k) : result);
    }

    // Returns the top K selected records based on this dimension's order.
    // Note: observes this dimension's filter, unlike group and groupAll.
    function top(k, top_offset) {
      ensureDeferredReady();
      if ((rawNumericState || lazyEncodedState) && !values && !iterable) {
        var lazyRows = lazyTopBottomIndex(k, top_offset, true);
        if (lazyRows !== null) {
          var lazyOut = new Array(lazyRows.length);
          for (var li = 0; li < lazyRows.length; ++li) {
            lazyOut[li] = getRecord(lazyRows[li]);
          }
          return lazyOut;
        }
      }

      materializeLazyEncodedState();

      var array = [],
          i = hi0,
          j,
          toSkip = 0;

      if(top_offset && top_offset > 0) toSkip = top_offset;

      while (--i >= lo0 && k > 0) {
        if (filterStore.isActive(j = index[i])) {
          if(toSkip > 0) {
            //skip matching row
            --toSkip;
          } else {
            array.push(getRecord(j));
            --k;
          }
        }
      }

      if(iterable){
        for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
          // Add row with empty iterable column at the end
          if(filterStore.isActive(j = iterablesEmptyRows[i])) {
            if(toSkip > 0) {
              //skip matching row
              --toSkip;
            } else {
              array.push(getRecord(j));
              --k;
            }
          }
        }
      }

      return array;
    }

    function topIndex(k, top_offset) {
      ensureDeferredReady();
      if ((rawNumericState || lazyEncodedState) && !values && !iterable) {
        var lazyRows = lazyTopBottomIndex(k, top_offset, true);
        if (lazyRows !== null) {
          return lazyRows;
        }
      }

      materializeLazyEncodedState();

      var array = [],
          i = hi0,
          j,
          toSkip = 0;

      if(top_offset && top_offset > 0) toSkip = top_offset;

      while (--i >= lo0 && k > 0) {
        if (filterStore.isActive(j = index[i])) {
          if(toSkip > 0) {
            --toSkip;
          } else {
            array.push(j);
            --k;
          }
        }
      }

      if(iterable){
        for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
          if(filterStore.isActive(j = iterablesEmptyRows[i])) {
            if(toSkip > 0) {
              --toSkip;
            } else {
              array.push(j);
              --k;
            }
          }
        }
      }

      return array;
    }

    // Returns the bottom K selected records based on this dimension's order.
    // Note: observes this dimension's filter, unlike group and groupAll.
    function bottom(k, bottom_offset) {
      ensureDeferredReady();
      if ((rawNumericState || lazyEncodedState) && !values && !iterable) {
        var lazyRows = lazyTopBottomIndex(k, bottom_offset, false);
        if (lazyRows !== null) {
          var lazyOut = new Array(lazyRows.length);
          for (var li = 0; li < lazyRows.length; ++li) {
            lazyOut[li] = getRecord(lazyRows[li]);
          }
          return lazyOut;
        }
      }

      materializeLazyEncodedState();

      var array = [],
          i,
          j,
          toSkip = 0;

      if(bottom_offset && bottom_offset > 0) toSkip = bottom_offset;

      if(iterable) {
        // Add row with empty iterable column at the top
        for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
          if(filterStore.isActive(j = iterablesEmptyRows[i])) {
            if(toSkip > 0) {
              //skip matching row
              --toSkip;
            } else {
              array.push(getRecord(j));
              --k;
            }
          }
        }
      }

      i = lo0;

      while (i < hi0 && k > 0) {
        if (filterStore.isActive(j = index[i])) {
          if(toSkip > 0) {
            //skip matching row
            --toSkip;
          } else {
            array.push(getRecord(j));
            --k;
          }
        }
        i++;
      }

      return array;
    }

    function bottomIndex(k, bottom_offset) {
      ensureDeferredReady();
      if ((rawNumericState || lazyEncodedState) && !values && !iterable) {
        var lazyRows = lazyTopBottomIndex(k, bottom_offset, false);
        if (lazyRows !== null) {
          return lazyRows;
        }
      }

      materializeLazyEncodedState();

      var array = [],
          i,
          j,
          toSkip = 0;

      if(bottom_offset && bottom_offset > 0) toSkip = bottom_offset;

      if(iterable) {
        for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
          if(filterStore.isActive(j = iterablesEmptyRows[i])) {
            if(toSkip > 0) {
              --toSkip;
            } else {
              array.push(j);
              --k;
            }
          }
        }
      }

      i = lo0;

      while (i < hi0 && k > 0) {
        if (filterStore.isActive(j = index[i])) {
          if(toSkip > 0) {
            --toSkip;
          } else {
            array.push(j);
            --k;
          }
        }
        i++;
      }

      return array;
    }

    // Adds a new group to this dimension, using the specified key function.
    function group(key) {
      ensureDeferredReady();
      if (arguments.length < 1) key = cr_identity;

      var groupAll = key === cr_null;
      var isPureMonotonicKey = !!(key && key._xfilterPureMonotonic === true);
      var rawBucketMode = !groupAll && isPureMonotonicKey && !!(rawNumericState && !values && !iterable);

      if (rawNumericState && !values && !groupAll && !rawBucketMode) {
        if (key === cr_identity) {
          upgradeRawNumericToLazy(n);
        } else {
          materializeLazyEncodedState();
        }
      }

      var lazyIdentityMode = !rawBucketMode && key === cr_identity && hasLazyEncodedGroupingSupport();
      var lazyBucketMode = !groupAll && !rawBucketMode && !lazyIdentityMode && isPureMonotonicKey && hasLazyEncodedGroupingSupport();

      if (!groupAll && !rawBucketMode && !lazyIdentityMode && !lazyBucketMode) {
        materializeLazyEncodedState();
      }

      var group = {
        top: top,
        all: all,
        reduce: reduce,
        reduceCount: reduceCount,
        reduceSum: reduceSum,
        order: order,
        orderNatural: orderNatural,
        size: size,
        dispose: dispose,
        remove: dispose, // for backwards-compatibility
        _canPromoteToRawNumeric: !!(groupAll || lazyBucketMode),
        _coScanInfo: coScanInfo,
        _onDimensionMaterialize: onDimensionMaterialize,
        _onRawNumericPromote: onRawNumericPromote,
        _onRawNumericRemove: onRawNumericRemove,
        _onRawNumericUpgrade: onRawNumericUpgrade,
        _readColumnar: readColumnar
      };

      // Ensure that this group will be removed when the dimension is removed.
      dimensionGroups.push(group);

      var groups, // array of {key, value}
          groupIndex, // object id ↦ group id
          groupWidth = 8,
          groupCapacity = capacity(groupWidth),
          k = 0, // cardinality
          lazySortedCodes = null,
          lazyOrderVersion = -1,
          lazyCodeToGroup = null,
          bucketKeys = null,
          bucketKeyToSlot = null,
          bucketCodeToSlot = null,
          bucketOrderVersion = -1,
          bucketCodeCount = 0,
          bucketIndexedLength = 0,
          hasInvalidBucket = false,
          rawBucketKeys = null,
          rawBucketMap = null,
          rawBucketSortedOrder = null,
          rawBucketSlotToGroup = null,
          rawBucketIndexedLength = 0,
          rawBucketVersion = -1,
          rawBucketTimeStep = key && key._xfilterTimeStep ? key._xfilterTimeStep : 0,
          rawBucketTimeOffset = key && key._xfilterTimeOffset ? key._xfilterTimeOffset : 0,
          materializedVersion = 0,
          select,
          heap,
          reduceAdd,
          reduceRemove,
          reduceInitial,
          reduceMetricSpec = null,
          reduceSplitField = null,
          metricPlan = null,
          metricBuffers = null,
          unfilteredData = null,
          unfilteredRowCounts = null,
          unfilteredTmpCounts = null,
          unfilteredSlotCount = 0,
          unfilteredSplitMode = null,
          unfilteredSplitStride = 0,
          unfilteredValid = false,
          buffersHoldUnfiltered = false,
          countBuf = null,
          splitMode = null, // 'dense' | 'sparse'
          splitActiveStride = 0,
          sparsePairGroupIds = null,
          sparseHeadBySlot = null,
          sparseNextPair = null,
          sparsePairSplitCode = null,
          sparsePairMap = null,
          sparsePairCount = 0,
          sparseN = -1,
          sparseSplitStride = -1,
          sparseDimVersion = -1,
          reduceMode = null,
          valuesSynced = false,
          update = cr_null,
          reset = cr_null,
          resetNeeded = true,
          markResetNeeded = registerResetListener(function() {
            resetNeeded = true;
            valuesSynced = false;
          }),
          n0old;

      // The group listens to the crossfilter for when any dimension changes, so
      // that it can update the associated reduce values. It must also listen to
      // the parent dimension for when data is added, and compute new keys.
      filterListeners.push(update);
      indexListeners.push(add);
      removeDataListeners.push(removeData);

      function setFilterListener(nextUpdate, nextReset) {
        var listenerIndex = filterListeners.indexOf(update);
        update = nextUpdate;
        reset = nextReset;
        if (listenerIndex >= 0) {
          filterListeners[listenerIndex] = update;
        }
      }

      function ensureCountBuf(sizeNeeded) {
        if (countBuf && countBuf.length >= sizeNeeded) {
          return countBuf;
        }
        var nextCap = countBuf && countBuf.length ? countBuf.length : 64;
        while (nextCap < sizeNeeded) {
          nextCap = nextCap < 65536 ? nextCap << 1 : sizeNeeded;
        }
        countBuf = new Float64Array(nextCap);
        return countBuf;
      }

      function syncUpdateListenerMeta() {
        var canReset = !iterable && reduceMode !== null;
        updateMany._xfilterDimSlot = dimSlot;
        updateMany._xfilterResettable = canReset;
        updateOne._xfilterDimSlot = dimSlot;
        updateOne._xfilterResettable = canReset;
      }

      function ensureLazyOrder() {
        if (!lazyIdentityMode || !lazyEncodedState) {
          return;
        }
        if (lazyOrderVersion === lazyEncodedState.version) {
          return;
        }
        var codeToValue = lazyEncodedState.codeToValue,
            codeCounts = lazyEncodedState.codeCounts,
            sorted = [],
            c;

        if (!lazyEncodedState.hasUnorderable) {
          for (c = 1; c < codeToValue.length; ++c) {
            if (codeCounts[c] > 0) {
              sorted.push(c);
            }
          }
        } else {
          for (c = 1; c < codeToValue.length; ++c) {
            if (codeCounts[c] > 0 && isNaturallyOrderable(codeToValue[c])) {
              sorted.push(c);
            }
          }
        }
        if (lazyEncodedState.isPureNumeric || lazyEncodedState.isPureString) {
          sorted.sort(function(a, b) {
            var va = codeToValue[a], vb = codeToValue[b];
            return va < vb ? -1 : va > vb ? 1 : a - b;
          });
        } else {
          sorted.sort(function(a, b) {
            var order = compareNaturalOrder(codeToValue[a], codeToValue[b]);
            return order || a - b;
          });
        }

        lazySortedCodes = sorted;
        k = sorted.length;
        lazyOrderVersion = lazyEncodedState.version;
        lazyCodeToGroup = null;
        groups = null;
        valuesSynced = false;
      }

      function ensureLazyIdentityGroups() {
        ensureLazyOrder();
        if (groups && groups.length === k && (!lazyIdentityMode || lazyCodeToGroup)) {
          return;
        }
        var codeToValue = lazyEncodedState.codeToValue,
            len = k,
            arr = new Array(len),
            map = new Int32Array(codeToValue.length),
            i,
            c;
        map.fill(-1);
        for (i = 0; i < len; ++i) {
          c = lazySortedCodes[i];
          arr[i] = { key: codeToValue[c], value: undefined };
          map[c] = i;
        }
        groups = arr;
        lazyCodeToGroup = map;
      }

      function ensureLazyBucketLayout() {
        if (!lazyBucketMode || !lazyEncodedState) {
          return;
        }
        if (bucketOrderVersion === lazyEncodedState.version && bucketIndexedLength === n) {
          return;
        }

        var codeToValue = lazyEncodedState.codeToValue,
            codeCounts = lazyEncodedState.codeCounts,
            codes = lazyEncodedState.codes,
            codeLen = codeToValue.length,
            i,
            c,
            bk;

        // Fast incremental extend when only new rows arrived and no new or reappearing bucket key appeared.
        if (bucketKeyToSlot && bucketCodeToSlot && bucketCodeCount <= codeLen && bucketIndexedLength <= n && bucketOrderVersion > 0 && bucketIndexedLength > 0) {
          var canExtend = true;
          var newCodeToSlot = bucketCodeToSlot;
          if (newCodeToSlot.length < codeLen) {
            var nextMapCap = newCodeToSlot.length || 64;
            while (nextMapCap < codeLen) nextMapCap <<= 1;
            var nextMap = new Uint32Array(nextMapCap);
            nextMap.fill(0xffffffff);
            nextMap.set(bucketCodeToSlot);
            newCodeToSlot = nextMap;
          }
          for (c = bucketCodeCount; c < codeLen; ++c) {
            if (!codeCounts[c]) continue;
            bk = key(codeToValue[c]);
            if (!isNaturallyOrderable(bk)) {
              canExtend = false;
              break;
            }
            var existingSlot = bucketKeyToSlot.get(bk);
            if (existingSlot === undefined) {
              canExtend = false;
              break;
            }
            newCodeToSlot[c] = existingSlot;
          }
          if (canExtend && groupIndex) {
            if (groupIndex.length < n) {
              var nextGroupCap = groupIndex.length || 64;
              while (nextGroupCap < n) nextGroupCap <<= 1;
              groupIndex = xfilterArray.arrayLengthen(groupIndex, nextGroupCap);
            }
            var allMapped = true;
            for (i = bucketIndexedLength; i < n; ++i) {
              var mappedSlot = newCodeToSlot[codes[i]];
              if (mappedSlot === 0xffffffff) {
                allMapped = false;
                break;
              }
              groupIndex[i] = mappedSlot;
            }
            if (allMapped) {
              bucketCodeToSlot = newCodeToSlot;
              bucketCodeCount = codeLen;
              bucketIndexedLength = n;
              bucketOrderVersion = lazyEncodedState.version;
              return;
            }
          }
        }

        var uniqueKeys = [],
            keySet = new Map(),
            codeBuckets = new Array(codeLen),
            invalid = false;

        for (c = 1; c < codeLen; ++c) {
          if (!codeCounts[c]) continue;
          bk = key(codeToValue[c]);
          codeBuckets[c] = bk;
          if (isNaturallyOrderable(bk)) {
            if (!keySet.has(bk)) {
              keySet.set(bk, 1);
              uniqueKeys.push(bk);
            }
          } else {
            invalid = true;
          }
        }

        uniqueKeys.sort(compareNaturalOrder);
        var slotMap = new Map();
        for (i = 0; i < uniqueKeys.length; ++i) {
          slotMap.set(uniqueKeys[i], i);
        }

        var codeToSlot = new Uint32Array(codeLen);
        codeToSlot.fill(0xffffffff);
        var sentinel = uniqueKeys.length;
        for (c = 1; c < codeLen; ++c) {
          if (!codeCounts[c]) continue;
          bk = codeBuckets[c];
          if (isNaturallyOrderable(bk)) {
            codeToSlot[c] = slotMap.get(bk);
          } else {
            codeToSlot[c] = sentinel;
          }
        }

        bucketKeys = uniqueKeys;
        bucketKeyToSlot = slotMap;
        bucketCodeToSlot = codeToSlot;
        bucketCodeCount = codeLen;
        hasInvalidBucket = invalid;
        k = uniqueKeys.length;

        var totalSlots = k + (invalid ? 1 : 0);
        if (totalSlots > 0 && n > 0) {
          groupIndex = cr_index(n, totalSlots);
          for (i = 0; i < n; ++i) {
            groupIndex[i] = codeToSlot[codes[i]];
          }
        } else {
          groupIndex = null;
        }
        bucketIndexedLength = n;
        bucketOrderVersion = lazyEncodedState.version;
        groups = null;
        valuesSynced = false;
      }

      function ensureRawBucketLayout() {
        if (!rawBucketMode || !rawNumericState) {
          return;
        }
        if (rawBucketVersion === rawNumericState.version && rawBucketIndexedLength === n) {
          return;
        }

        var vals = rawNumericState.values,
            step = rawBucketTimeStep,
            timeOff = rawBucketTimeOffset,
            start = rawBucketIndexedLength,
            keysArr = rawBucketKeys,
            bMap = rawBucketMap,
            orderDirty = !rawBucketSortedOrder,
            i,
            bk,
            rawId;

        if (!keysArr) {
          keysArr = rawBucketKeys = [];
          bMap = rawBucketMap = new Map();
          start = 0;
          orderDirty = true;
        }

        if (!groupIndex || groupIndex.length < n) {
          var nextCap = (groupIndex && groupIndex.length) ? groupIndex.length : 64;
          while (nextCap < n) nextCap <<= 1;
          if (groupIndex && groupIndex.length > 0 && start > 0) {
            var grown = new Uint32Array(nextCap);
            grown.set(groupIndex.subarray(0, start));
            groupIndex = grown;
          } else {
            groupIndex = new Uint32Array(nextCap);
          }
        }

        var lastBk = NaN,
            lastId = -1;

        if (step > 0) {
          if (timeOff === 0) {
            for (i = start; i < n; ++i) {
              bk = Math.floor(vals[i] / step) * step;
              if (bk === lastBk) {
                groupIndex[i] = lastId;
                continue;
              }
              rawId = bMap.get(bk);
              if (rawId === undefined) {
                rawId = keysArr.length;
                keysArr.push(bk);
                bMap.set(bk, rawId);
                orderDirty = true;
              }
              lastBk = bk;
              lastId = rawId;
              groupIndex[i] = rawId;
            }
          } else {
            for (i = start; i < n; ++i) {
              bk = Math.floor((vals[i] + timeOff) / step) * step - timeOff;
              if (bk === lastBk) {
                groupIndex[i] = lastId;
                continue;
              }
              rawId = bMap.get(bk);
              if (rawId === undefined) {
                rawId = keysArr.length;
                keysArr.push(bk);
                bMap.set(bk, rawId);
                orderDirty = true;
              }
              lastBk = bk;
              lastId = rawId;
              groupIndex[i] = rawId;
            }
          }
        } else {
          for (i = start; i < n; ++i) {
            bk = key(vals[i]);
            if (!isNaturallyOrderable(bk)) {
              upgradeRawNumericToLazy(n);
              ensureLazyBucketLayout();
              return;
            }
            if (bk === lastBk) {
              groupIndex[i] = lastId;
              continue;
            }
            rawId = bMap.get(bk);
            if (rawId === undefined) {
              rawId = keysArr.length;
              keysArr.push(bk);
              bMap.set(bk, rawId);
              orderDirty = true;
            }
            lastBk = bk;
            lastId = rawId;
            groupIndex[i] = rawId;
          }
        }

        if (orderDirty) {
          var len = keysArr.length;
          var sorted = new Array(len);
          for (i = 0; i < len; ++i) sorted[i] = i;
          sorted.sort(function(a, b) {
            var order = compareNaturalOrder(keysArr[a], keysArr[b]);
            return order || a - b;
          });
          rawBucketSortedOrder = sorted;
          var slotToGroup = new Uint32Array(len);
          for (i = 0; i < len; ++i) slotToGroup[sorted[i]] = i;
          rawBucketSlotToGroup = slotToGroup;
          k = len;
          groups = null;
        }

        rawBucketIndexedLength = n;
        rawBucketVersion = rawNumericState.version;
        valuesSynced = false;
      }

      function onRawNumericPromote() {
        if (groupAll) {
          return;
        }
        lazyBucketMode = false;
        bucketKeys = null;
        bucketKeyToSlot = null;
        bucketCodeToSlot = null;
        bucketOrderVersion = -1;
        bucketCodeCount = 0;
        bucketIndexedLength = 0;
        hasInvalidBucket = false;
        rawBucketMode = true;
        rawBucketKeys = null;
        rawBucketMap = null;
        rawBucketSortedOrder = null;
        rawBucketSlotToGroup = null;
        rawBucketIndexedLength = 0;
        rawBucketVersion = -1;
        groupIndex = null;
        groups = null;
        sparseLayoutVersionReset();
        resetNeeded = true;
        valuesSynced = false;
      }

      function onRawNumericRemove() {
        if (!rawBucketMode) {
          return;
        }
        rawBucketKeys = null;
        rawBucketMap = null;
        rawBucketSortedOrder = null;
        rawBucketSlotToGroup = null;
        rawBucketIndexedLength = 0;
        rawBucketVersion = -1;
        groupIndex = null;
        groups = null;
        sparseLayoutVersionReset();
        resetNeeded = true;
        valuesSynced = false;
      }

      function onRawNumericUpgrade() {
        if (!rawBucketMode) {
          return;
        }
        rawBucketMode = false;
        rawBucketKeys = null;
        rawBucketMap = null;
        rawBucketSortedOrder = null;
        rawBucketSlotToGroup = null;
        rawBucketIndexedLength = 0;
        rawBucketVersion = -1;
        groupIndex = null;
        groups = null;
        lazyBucketMode = !!(lazyEncodedState && !lazyEncodedState.hasUnorderable);
        bucketOrderVersion = -1;
        bucketIndexedLength = 0;
        sparseLayoutVersionReset();
        resetNeeded = true;
        valuesSynced = false;
      }

      function getPrimarySlotArray() {
        if (lazyIdentityMode) {
          return lazyEncodedState.codes;
        }
        return groupIndex;
      }

      function getPrimarySlotCount() {
        if (lazyIdentityMode) {
          return lazyEncodedState ? lazyEncodedState.codeToValue.length : 0;
        }
        if (rawBucketMode) {
          return rawBucketKeys ? rawBucketKeys.length : 0;
        }
        if (lazyBucketMode) {
          return k + (hasInvalidBucket ? 1 : 0);
        }
        return k;
      }

      function ensureSparseSplitLayout(slotArr, primarySlots, splitCol) {
        var stride = splitCol.codeToKey.length;
        var dimVer = rawNumericState
          ? rawNumericState.version
          : (lazyEncodedState ? lazyEncodedState.version : materializedVersion);
        if (
          sparsePairGroupIds
          && sparseN === n
          && sparseSplitStride === stride
          && sparseDimVersion === dimVer
        ) {
          return;
        }

        var splitCodes = splitCol.codes,
            canExtend = (lazyIdentityMode || rawBucketMode)
              && sparsePairGroupIds
              && sparsePairMap
              && sparseN > 0
              && sparseN < n
              && sparseSplitStride === stride,
            startRow = canExtend ? sparseN : 0,
            pairIds = sparsePairGroupIds,
            head,
            cap,
            nextPair,
            pairSplit,
            pairMap,
            pairCount,
            i,
            s,
            sc,
            pairKey,
            pid;

        if (!pairIds || pairIds.length < n) {
          var nextPairCap = (pairIds && pairIds.length) ? pairIds.length : 64;
          while (nextPairCap < n) nextPairCap <<= 1;
          var grownPairIds = new Uint32Array(nextPairCap);
          if (canExtend && pairIds) {
            grownPairIds.set(pairIds.subarray(0, sparseN));
          }
          pairIds = grownPairIds;
        }

        if (canExtend) {
          head = sparseHeadBySlot;
          if (!head || head.length < primarySlots) {
            var nextHeadCap = (head && head.length) ? head.length : 64;
            while (nextHeadCap < primarySlots) nextHeadCap <<= 1;
            var grownHead = new Int32Array(nextHeadCap);
            grownHead.fill(-1);
            if (head) grownHead.set(head);
            head = grownHead;
          }
          nextPair = sparseNextPair;
          pairSplit = sparsePairSplitCode;
          cap = nextPair.length;
          pairMap = sparsePairMap;
          pairCount = sparsePairCount;
        } else {
          head = new Int32Array(primarySlots);
          head.fill(-1);
          cap = primarySlots < 256 ? 256 : primarySlots;
          nextPair = new Int32Array(cap);
          pairSplit = new Uint32Array(cap);
          pairMap = new Map();
          pairCount = 0;
        }

        for (i = startRow; i < n; ++i) {
          s = slotArr[i];
          sc = splitCodes[i];
          pairKey = s * stride + sc;
          pid = pairMap.get(pairKey);
          if (pid === undefined) {
            pid = pairCount++;
            pairMap.set(pairKey, pid);
            if (pid >= cap) {
              cap <<= 1;
              var grownNext = new Int32Array(cap);
              grownNext.set(nextPair);
              nextPair = grownNext;
              var grownSplit = new Uint32Array(cap);
              grownSplit.set(pairSplit);
              pairSplit = grownSplit;
            }
            pairSplit[pid] = sc;
            nextPair[pid] = head[s];
            head[s] = pid;
          }
          pairIds[i] = pid;
        }

        sparsePairGroupIds = pairIds;
        sparseHeadBySlot = head;
        sparseNextPair = nextPair;
        sparsePairSplitCode = pairSplit;
        sparsePairMap = pairMap;
        sparsePairCount = pairCount;
        sparseN = n;
        sparseSplitStride = stride;
        sparseDimVersion = dimVer;
      }

      function syncGroupsFromBuffers() {
        if (valuesSynced) {
          return;
        }
        if (reduceMode === null) {
          valuesSynced = true;
          return;
        }

        var i, slot, state, splitCol, splitKeys, sc, cell, bucket, pid;

        if (groupAll) {
          if (!groups || !groups.length) {
            groups = [{ key: null, value: undefined }];
          }
          if (reduceMode === 'count') {
            groups[0].value = countBuf ? countBuf[0] : 0;
          } else if (reduceMode === 'metricSpec') {
            if (!groups[0].value) groups[0].value = reduceInitial();
            writeMetricSlotToState(groups[0].value, metricPlan, metricBuffers, 0);
          } else if (reduceMode === 'splitMetricSpec') {
            splitCol = getSplitColumn(reduceSplitField);
            splitKeys = splitCol.codeToKey;
            state = reduceInitial();
            for (sc = 0; sc < splitActiveStride; ++sc) {
              if (slotHasAnyActivity(metricPlan, metricBuffers, sc)) {
                bucket = {};
                writeMetricSlotToState(bucket, metricPlan, metricBuffers, sc);
                state[splitKeys[sc]] = bucket;
              }
            }
            state.__version += 1;
            groups[0].value = state;
          }
          valuesSynced = true;
          return;
        }

        if (lazyIdentityMode) {
          ensureLazyIdentityGroups();
        } else if (rawBucketMode) {
          if (!groups || groups.length !== k) {
            groups = new Array(k);
            for (i = 0; i < k; ++i) {
              groups[i] = { key: rawBucketKeys[rawBucketSortedOrder[i]], value: undefined };
            }
          }
        } else if (lazyBucketMode) {
          if (!groups || groups.length !== k) {
            groups = new Array(k);
            for (i = 0; i < k; ++i) {
              groups[i] = { key: bucketKeys[i], value: undefined };
            }
          }
        }

        if (k === 0) {
          groups = [];
          valuesSynced = true;
          return;
        }

        var slotList = lazyIdentityMode ? lazySortedCodes : (rawBucketMode ? rawBucketSortedOrder : null);

        if (reduceMode === 'count') {
          for (i = 0; i < k; ++i) {
            slot = slotList ? slotList[i] : i;
            groups[i].value = countBuf[slot];
          }
        } else if (reduceMode === 'metricSpec') {
          for (i = 0; i < k; ++i) {
            slot = slotList ? slotList[i] : i;
            state = groups[i].value;
            if (!state) {
              state = groups[i].value = reduceInitial();
            }
            writeMetricSlotToState(state, metricPlan, metricBuffers, slot);
          }
        } else if (reduceMode === 'splitMetricSpec') {
          splitCol = getSplitColumn(reduceSplitField);
          splitKeys = splitCol.codeToKey;
          if (splitMode === 'dense') {
            for (i = 0; i < k; ++i) {
              slot = slotList ? slotList[i] : i;
              state = reduceInitial();
              var base = slot * splitActiveStride;
              for (sc = 0; sc < splitActiveStride; ++sc) {
                cell = base + sc;
                if (slotHasAnyActivity(metricPlan, metricBuffers, cell)) {
                  bucket = {};
                  writeMetricSlotToState(bucket, metricPlan, metricBuffers, cell);
                  state[splitKeys[sc]] = bucket;
                }
              }
              state.__version += 1;
              groups[i].value = state;
            }
          } else {
            for (i = 0; i < k; ++i) {
              slot = slotList ? slotList[i] : i;
              state = reduceInitial();
              for (pid = sparseHeadBySlot[slot]; pid !== -1; pid = sparseNextPair[pid]) {
                if (slotHasAnyActivity(metricPlan, metricBuffers, pid)) {
                  bucket = {};
                  writeMetricSlotToState(bucket, metricPlan, metricBuffers, pid);
                  state[splitKeys[sparsePairSplitCode[pid]]] = bucket;
                }
              }
              state.__version += 1;
              groups[i].value = state;
            }
          }
        }

        valuesSynced = true;
      }

      function onDimensionMaterialize(lazyCodes) {
        if (groupAll) {
          return;
        }
        if (!lazyIdentityMode && !lazyBucketMode) {
          return;
        }

        var wasIdentity = lazyIdentityMode;
        lazyIdentityMode = false;
        lazyBucketMode = false;
        lazyOrderVersion = -1;
        bucketOrderVersion = -1;
        bucketKeys = null;
        bucketKeyToSlot = null;
        bucketCodeToSlot = null;
        bucketCodeCount = 0;
        bucketIndexedLength = 0;
        hasInvalidBucket = false;
        sparseLayoutVersionReset();
        resetNeeded = true;
        valuesSynced = false;

        if (wasIdentity && lazyEncodedState && !lazyEncodedState.hasUnorderable) {
          var codeToValue = lazyEncodedState.codeToValue,
              codeCounts = lazyEncodedState.codeCounts,
              sorted = [],
              c,
              i;
          for (c = 1; c < codeToValue.length; ++c) {
            if (codeCounts[c] > 0 && isNaturallyOrderable(codeToValue[c])) {
              sorted.push(c);
            }
          }
          sorted.sort(function(a, b) {
            var order = compareNaturalOrder(codeToValue[a], codeToValue[b]);
            return order || a - b;
          });
          k = sorted.length;
          if (!k) {
            groups = [];
            groupIndex = null;
            setFilterListener(cr_null, cr_null);
            return;
          }
          while (k > groupCapacity) {
            groupWidth <<= 1;
            groupCapacity = capacity(groupWidth);
          }
          groups = new Array(k);
          var codeToGroup = new Uint32Array(codeToValue.length);
          for (i = 0; i < k; ++i) {
            groups[i] = { key: codeToValue[sorted[i]], value: undefined };
            codeToGroup[sorted[i]] = i;
          }
          if (k > 1) {
            groupIndex = cr_index(n, groupCapacity);
            for (i = 0; i < lazyCodes.length; ++i) {
              groupIndex[i] = codeToGroup[lazyCodes[i]];
            }
            setFilterListener(updateMany, resetMany);
          } else {
            groupIndex = null;
            setFilterListener(updateOne, resetOne);
          }
          lazySortedCodes = null;
          lazyCodeToGroup = null;
          materializedVersion += 1;
          return;
        }

        lazySortedCodes = null;
        lazyCodeToGroup = null;
        k = 0;
        groups = [];
        groupIndex = null;
        add(values, index, 0, lazyCodes.length);
        materializedVersion += 1;
      }

      function sparseLayoutVersionReset() {
        sparsePairMap = null;
        sparseDimVersion = -1;
        sparseN = -1;
        sparseSplitStride = -1;
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
      }

      function markBuffersHoldUnfiltered(totalSlots) {
        if (!metricPlan || !metricBuffers || totalSlots <= 0 || totalSlots * metricPlan.stride > 131072) {
          buffersHoldUnfiltered = false;
          unfilteredValid = false;
          return;
        }
        unfilteredSlotCount = totalSlots;
        unfilteredSplitMode = splitMode;
        unfilteredSplitStride = splitActiveStride;
        unfilteredRowCounts = null;
        unfilteredValid = false;
        buffersHoldUnfiltered = true;
      }

      function materializeUnfilteredCacheIfNeeded() {
        if (!buffersHoldUnfiltered) return;
        buffersHoldUnfiltered = false;
        if (unfilteredValid) return;
        if (!metricPlan || !metricBuffers || unfilteredSlotCount <= 0) return;
        var totalDoubles = unfilteredSlotCount * metricPlan.stride;
        if (totalDoubles > 131072) return;
        if (!unfilteredData || unfilteredData.length < totalDoubles) {
          var nextLen = unfilteredData && unfilteredData.length ? unfilteredData.length : totalDoubles;
          while (nextLen < totalDoubles) nextLen <<= 1;
          if (nextLen > 131072) nextLen = totalDoubles;
          unfilteredData = new Float64Array(nextLen);
        }
        unfilteredData.set(metricBuffers.data.subarray(0, totalDoubles));
        unfilteredValid = true;
      }

      function ensureUnfilteredRowCounts(totalSlots, slotArr, splitCodes, splitStride) {
        if (unfilteredRowCounts && unfilteredRowCounts.length >= totalSlots) {
          return unfilteredRowCounts;
        }
        unfilteredRowCounts = new Uint32Array(totalSlots);
        var ci;
        if (splitCodes) {
          for (ci = 0; ci < n; ++ci) {
            unfilteredRowCounts[slotArr[ci] * splitStride + splitCodes[ci]] += 1;
          }
        } else if (slotArr) {
          for (ci = 0; ci < n; ++ci) {
            unfilteredRowCounts[slotArr[ci]] += 1;
          }
        } else {
          unfilteredRowCounts[0] = n;
        }
        return unfilteredRowCounts;
      }

      function hasValidUnfilteredCache(totalSlots) {
        return (unfilteredValid || buffersHoldUnfiltered)
          && unfilteredSlotCount === totalSlots
          && unfilteredSplitMode === splitMode
          && unfilteredSplitStride === splitActiveStride;
      }

      function restoreUnfilteredIntoBuffers(totalSlots, forMutation) {
        if (!hasValidUnfilteredCache(totalSlots)) {
          return false;
        }
        if (buffersHoldUnfiltered) {
          if (forMutation) {
            materializeUnfilteredCacheIfNeeded();
          }
          return true;
        }
        if (!unfilteredData) return false;
        metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, totalSlots, false);
        metricBuffers.data.set(unfilteredData.subarray(0, totalSlots * metricPlan.stride));
        buffersHoldUnfiltered = !forMutation;
        return true;
      }

      function ensureUnfilteredTmpCounts(totalSlots) {
        if (!unfilteredTmpCounts || unfilteredTmpCounts.length < totalSlots) {
          unfilteredTmpCounts = new Uint32Array(totalSlots);
        }
        return unfilteredTmpCounts;
      }

      function coScanInfo() {
        if (!resetNeeded || iterable || groupAll || reduceMode !== 'metricSpec' || !metricPlan || !metricPlan.canCoScan) {
          return null;
        }
        if (lazyIdentityMode) {
          ensureLazyOrder();
        } else if (rawBucketMode) {
          ensureRawBucketLayout();
        } else if (lazyBucketMode) {
          ensureLazyBucketLayout();
        }
        if (k <= 1) {
          return null;
        }
        var slotArr = getPrimarySlotArray();
        var slotCount = getPrimarySlotCount();
        if (!slotArr || slotCount <= 0) {
          return null;
        }
        var applyFilteredRemovals = hasOtherActiveDimensionFilters();
        var info = {
          buffers: metricBuffers,
          canComplement: function() {
            return hasValidUnfilteredCache(slotCount);
          },
          cleanupComplement: function(exclIndices, exclLen) {
            var exCntOff = getExactCountOffset(metricPlan, getNumericColumn);
            var trk = exCntOff < 0 ? ensureUnfilteredRowCounts(slotCount, slotArr, null, 0) : null;
            var tmpC = exCntOff < 0 ? ensureUnfilteredTmpCounts(slotCount) : null;
            cleanupComplementEmptySlots(metricBuffers, metricPlan, exCntOff, slotArr, null, 0, trk, tmpC, exclIndices, exclLen, slotCount);
          },
          coScanKey: metricPlan.coScanKey,
          commit: function(saveCache) {
            if (saveCache) {
              markBuffersHoldUnfiltered(slotCount);
            }
            resetNeeded = false;
            valuesSynced = false;
          },
          ensureBuffers: function() {
            materializeUnfilteredCacheIfNeeded();
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
            info.buffers = metricBuffers;
          },
          groupRef: group,
          plan: metricPlan,
          prepareZero: function() {
            materializeUnfilteredCacheIfNeeded();
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
            zeroMetricBuffers(metricBuffers, slotCount);
            info.buffers = metricBuffers;
          },
          slotArr: slotArr,
          slotCount: slotCount,
          tryRestoreUnfiltered: function(forMutation) {
            if (restoreUnfilteredIntoBuffers(slotCount, !!forMutation)) {
              info.buffers = metricBuffers;
              return true;
            }
            return false;
          },
          unfiltered: !applyFilteredRemovals,
          usesGlobalActive: applyFilteredRemovals && !dimSlot.active
        };
        return info;
      }

      // Incorporate any existing data into the grouping.
      add(values, index, 0, n);

      // Incorporates the specified new values into this group.
      // This function is responsible for updating groups and groupIndex.
      function add(newValues, newIndex, n0, n1, appendedCodes) {
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
        if (groupAll && (rawNumericState || lazyEncodedState) && !values) {
          k = 1;
          if (!groups || !groups.length) {
            groups = [{ key: null, value: resetNeeded ? undefined : reduceInitial() }];
          }
          groupIndex = null;
          resetNeeded = true;
          valuesSynced = false;
          setFilterListener(updateOne, resetOne);
          return;
        }

        if (rawBucketMode && rawNumericState && !values) {
          resetNeeded = true;
          valuesSynced = false;
          setFilterListener(updateMany, resetMany);
          return;
        }

        if (lazyIdentityMode && lazyEncodedState && !values) {
          if (lazyEncodedState.hasUnorderable) {
            materializeLazyEncodedState();
            return;
          }
          resetNeeded = true;
          valuesSynced = false;
          setFilterListener(updateMany, resetMany);
          return;
        }

        if (lazyBucketMode && lazyEncodedState && !values) {
          if (lazyEncodedState.hasUnorderable) {
            materializeLazyEncodedState();
            return;
          }
          resetNeeded = true;
          valuesSynced = false;
          setFilterListener(updateMany, resetMany);
          return;
        }

        if (iterable) {
          n0old = n0;
          n0 = values.length - newValues.length;
          n1 = newValues.length;
        }

        if (reduceMode !== null && !iterable) {
          resetNeeded = true;
          valuesSynced = false;
        }

        var oldGroups = groups,
            reIndex = iterable ? [] : cr_index(k, groupCapacity),
            addFn = reduceAdd,
            removeFn = reduceRemove,
            initial = reduceInitial,
            k0 = k, // old cardinality
            i0 = 0, // index of old group
            i1 = 0, // index of new record
            j, // object id
            g0, // old group
            x0, // old key
            x1, // new key
            g, // group to add
            x; // key of group to add

        // If a reset is needed, we don't need to update the reduce values.
        if (resetNeeded) addFn = initial = cr_null;
        if (resetNeeded) removeFn = initial = cr_null;

        // Reset the new groups (k is a lower bound).
        // Also, make sure that groupIndex exists and is long enough.
        groups = new Array(k), k = 0;
        if (iterable) {
          groupIndex = k0 ? groupIndex : [];
        } else {
          groupIndex = k0 > 1 ? xfilterArray.arrayLengthen(groupIndex, n) : cr_index(n, groupCapacity);
        }

        // Get the first old key (x0 of g0), if it exists.
        if (k0) x0 = (g0 = oldGroups[0]).key;

        // Find the first new key (x1), skipping NaN keys.
        while (i1 < n1 && !isNaturallyOrderable(x1 = key(newValues[i1]))) ++i1;

        // While new keys remain…
        while (i1 < n1) {

          // Determine the lesser of the two current keys; new and old.
          // If there are no old keys remaining, then always add the new key.
          if (g0 && compareNaturalOrder(x0, x1) <= 0) {
            g = g0, x = x0;

            // Record the new index of the old group.
            reIndex[i0] = k;

            // Retrieve the next old key.
            g0 = oldGroups[++i0];
            if (g0) x0 = g0.key;
          } else {
            g = { key: x1, value: initial() }, x = x1;
          }

          // Add the lesser group.
          groups[k] = g;

          // Add any selected records belonging to the added group, while
          // advancing the new key and populating the associated group index.
          while (compareNaturalOrder(x1, x) <= 0) {
            j = newIndex[i1] + (iterable ? n0old : n0);

            if (iterable) {
              if (groupIndex[j]) {
                groupIndex[j].push(k);
              } else {
                groupIndex[j] = [k];
              }
            } else {
              groupIndex[j] = k;
            }

            if (!resetNeeded) {
              if (reduceMode === 'count') {
                g.value += 1;
                if (hasOtherActiveDimensionFilters() && !filterStore.isActiveExcept(j, dimSlot)) {
                  g.value -= 1;
                }
              } else {
                var rowRecord = getRecord(j);
                g.value = addFn(g.value, rowRecord, true);
                if (hasOtherActiveDimensionFilters() && !filterStore.isActiveExcept(j, dimSlot)) g.value = removeFn(g.value, rowRecord, false);
              }
            }
            if (++i1 >= n1) break;
            x1 = key(newValues[i1]);
          }

          groupIncrement();
        }

        // Add any remaining old groups that were greater than all new keys.
        while (i0 < k0) {
          groups[reIndex[i0] = k] = oldGroups[i0++];
          groupIncrement();
        }

        // Fill in gaps with empty arrays where there may have been rows with empty iterables
        if (iterable) {
          for (var index1 = 0; index1 < n; index1++) {
            if (!groupIndex[index1]) {
              groupIndex[index1] = [];
            }
          }
        }

        // If we added any new groups before any old groups,
        // update the group index of all the old records.
        if (k > i0) {
          if (iterable) {
            for (i0 = 0; i0 < n0old; ++i0) {
              for (index1 = 0; index1 < groupIndex[i0].length; index1++) {
                groupIndex[i0][index1] = reIndex[groupIndex[i0][index1]];
              }
            }
          } else {
            for (i0 = 0; i0 < n0; ++i0) {
              groupIndex[i0] = reIndex[groupIndex[i0]];
            }
          }
        }

        materializedVersion += 1;

        if (k > 1 || iterable) {
          setFilterListener(updateMany, resetMany);
        } else {
          if (!k && groupAll) {
            k = 1;
            groups = [{ key: null, value: initial() }];
          }
          if (k === 1) {
            setFilterListener(updateOne, resetOne);
          } else {
            setFilterListener(cr_null, cr_null);
          }
          groupIndex = null;
        }

        function groupIncrement() {
          if (iterable) {
            k++;
            return;
          }
          if (++k === groupCapacity) {
            reIndex = xfilterArray.arrayWiden(reIndex, groupWidth <<= 1);
            groupIndex = xfilterArray.arrayWiden(groupIndex, groupWidth);
            groupCapacity = capacity(groupWidth);
          }
        }
      }

      function removeData(reIndex) {
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
        sparseLayoutVersionReset();

        if (rawBucketMode && rawNumericState && !values) {
          onRawNumericRemove();
          return;
        }

        if (lazyIdentityMode && lazyEncodedState && !values) {
          lazyOrderVersion = -1;
          lazySortedCodes = null;
          lazyCodeToGroup = null;
          groups = null;
          valuesSynced = false;
          resetNeeded = true;
          if (lazyEncodedState.hasUnorderable) {
            materializeLazyEncodedState();
          }
          return;
        }

        if (lazyBucketMode && lazyEncodedState && !values) {
          bucketOrderVersion = -1;
          bucketKeys = null;
          bucketKeyToSlot = null;
          bucketCodeToSlot = null;
          bucketCodeCount = 0;
          bucketIndexedLength = 0;
          hasInvalidBucket = false;
          groups = null;
          groupIndex = null;
          valuesSynced = false;
          resetNeeded = true;
          if (lazyEncodedState.hasUnorderable) {
            materializeLazyEncodedState();
          }
          return;
        }

        if (reduceMode !== null && !iterable) {
          resetNeeded = true;
          valuesSynced = false;
        }
        materializedVersion += 1;

        if (k > 1 || iterable) {
          var oldK = k,
              oldGroups = groups,
              seenGroups = cr_index(oldK, oldK),
              i,
              i0,
              j;

          if (!iterable) {
            for (i = 0, j = 0; i < n; ++i) {
              if (reIndex[i] !== REMOVED_INDEX) {
                seenGroups[groupIndex[j] = groupIndex[i]] = 1;
                ++j;
              }
            }
          } else {
            for (i = 0, j = 0; i < n; ++i) {
              if (reIndex[i] !== REMOVED_INDEX) {
                groupIndex[j] = groupIndex[i];
                for (i0 = 0; i0 < groupIndex[j].length; i0++) {
                  seenGroups[groupIndex[j][i0]] = 1;
                }
                ++j;
              }
            }
            groupIndex = groupIndex.slice(0, j);
          }

          groups = [], k = 0;
          for (i = 0; i < oldK; ++i) {
            if (seenGroups[i]) {
              seenGroups[i] = k++;
              groups.push(oldGroups[i]);
            }
          }

          if (k > 1 || iterable) {
            if (!iterable) {
              for (i = 0; i < j; ++i) groupIndex[i] = seenGroups[groupIndex[i]];
            } else {
              for (i = 0; i < j; ++i) {
                for (i0 = 0; i0 < groupIndex[i].length; ++i0) {
                  groupIndex[i][i0] = seenGroups[groupIndex[i][i0]];
                }
              }
            }
          } else {
            groupIndex = null;
          }
          if (k > 1 || iterable) {
            setFilterListener(updateMany, resetMany);
          } else if (k === 1) {
            setFilterListener(updateOne, resetOne);
          } else {
            setFilterListener(cr_null, cr_null);
          }
        } else if (k === 1) {
          if (groupAll) return;
          for (var index3 = 0; index3 < n; ++index3) if (reIndex[index3] !== REMOVED_INDEX) return;
          groups = [], k = 0;
          setFilterListener(cr_null, cr_null);
        }
      }

      // Reduces the specified selected or deselected records.
      function updateMany(filterSlot, added, removed, notFilter, forceReset) {
        if (notFilter) { unfilteredValid = false; buffersHoldUnfiltered = false; }
        if (filterSlot === dimSlot || resetNeeded) return;

        var i,
            j,
            rowIdx,
            len,
            g;

        if (iterable) {
          for (i = 0, len = added.length; i < len; ++i) {
            if (filterStore.isActiveExcept(rowIdx = added[i], dimSlot)) {
              for (j = 0; j < groupIndex[rowIdx].length; j++) {
                g = groups[groupIndex[rowIdx][j]];
                if (reduceMode === 'count') {
                  g.value += 1;
                } else {
                  g.value = reduceAdd(g.value, getRecord(rowIdx), false, j);
                }
              }
            }
          }

          for (i = 0, len = removed.length; i < len; ++i) {
            if (filterStore.isOnlyExcludedByExcept(rowIdx = removed[i], dimSlot, filterSlot)) {
              for (j = 0; j < groupIndex[rowIdx].length; j++) {
                g = groups[groupIndex[rowIdx][j]];
                if (reduceMode === 'count') {
                  g.value -= 1;
                } else {
                  g.value = reduceRemove(g.value, getRecord(rowIdx), notFilter, j);
                }
              }
            }
          }
          return;
        }

        if (reduceMode !== null) {
          if (notFilter || forceReset || added.length + removed.length > (n >>> 2)
            || (reduceMode !== 'count' && removed.length > 0 && metricPlan && !canPlanUseComplement(metricPlan, getNumericColumn))) {
            resetNeeded = true;
            valuesSynced = false;
            return;
          }

          var slotArr = getPrimarySlotArray();
          if (!slotArr || k === 0) {
            return;
          }
          materializeUnfilteredCacheIfNeeded();

          if (reduceMode === 'count') {
            for (i = 0, len = added.length; i < len; ++i) {
              rowIdx = added[i];
              if (filterStore.isActiveExcept(rowIdx, dimSlot)) {
                countBuf[slotArr[rowIdx]] += 1;
              }
            }
            for (i = 0, len = removed.length; i < len; ++i) {
              rowIdx = removed[i];
              if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) {
                countBuf[slotArr[rowIdx]] -= 1;
              }
            }
            valuesSynced = false;
            return;
          }

          var addCount = 0,
              remCount = 0,
              maxWork = added.length > removed.length ? added.length : removed.length;

          if (reduceMode === 'splitMetricSpec') {
            var splitCol = getSplitColumn(reduceSplitField);
            if (splitCol.codeToKey.length !== splitActiveStride) {
              resetNeeded = true;
              valuesSynced = false;
              return;
            }
            if (maxWork > 0) {
              deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, maxWork);
            }
            for (i = 0, len = added.length; i < len; ++i) {
              rowIdx = added[i];
              if (filterStore.isActiveExcept(rowIdx, dimSlot)) {
                deltaWorkBuf[addCount++] = rowIdx;
              }
            }
            if (addCount > 0) {
              if (splitMode === 'dense') {
                reduceSplitDenseIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, splitActiveStride, deltaWorkBuf, addCount, 1, 0);
              } else {
                reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, deltaWorkBuf, addCount, 1, 0);
              }
            }
            for (i = 0, len = removed.length; i < len; ++i) {
              rowIdx = removed[i];
              if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) {
                deltaWorkBuf[remCount++] = rowIdx;
              }
            }
            if (remCount > 0) {
              if (splitMode === 'dense') {
                reduceSplitDenseIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, splitActiveStride, deltaWorkBuf, remCount, -1, 0);
              } else {
                reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, deltaWorkBuf, remCount, -1, 0);
              }
            }
            valuesSynced = false;
            return;
          }

          // reduceMode === 'metricSpec'
          if (maxWork > 0) {
            deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, maxWork);
          }
          for (i = 0, len = added.length; i < len; ++i) {
            rowIdx = added[i];
            if (filterStore.isActiveExcept(rowIdx, dimSlot)) {
              deltaWorkBuf[addCount++] = rowIdx;
            }
          }
          if (addCount > 0) {
            reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, deltaWorkBuf, addCount, 1, 0);
          }
          for (i = 0, len = removed.length; i < len; ++i) {
            rowIdx = removed[i];
            if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) {
              deltaWorkBuf[remCount++] = rowIdx;
            }
          }
          if (remCount > 0) {
            reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, deltaWorkBuf, remCount, -1, 0);
          }
          valuesSynced = false;
          return;
        }

        // Custom reducer path
        var customSlotArr = lazyIdentityMode ? lazyEncodedState.codes : groupIndex;
        for (i = 0, len = added.length; i < len; ++i) {
          if (filterStore.isActiveExcept(rowIdx = added[i], dimSlot)) {
            var ag = lazyIdentityMode
              ? lazyCodeToGroup[customSlotArr[rowIdx]]
              : (rawBucketMode ? rawBucketSlotToGroup[customSlotArr[rowIdx]] : customSlotArr[rowIdx]);
            if (ag >= 0 && ag < k) {
              g = groups[ag];
              g.value = reduceAdd(g.value, getRecord(rowIdx), false);
            }
          }
        }

        for (i = 0, len = removed.length; i < len; ++i) {
          if (filterStore.isOnlyExcludedByExcept(rowIdx = removed[i], dimSlot, filterSlot)) {
            var rg = lazyIdentityMode
              ? lazyCodeToGroup[customSlotArr[rowIdx]]
              : (rawBucketMode ? rawBucketSlotToGroup[customSlotArr[rowIdx]] : customSlotArr[rowIdx]);
            if (rg >= 0 && rg < k) {
              g = groups[rg];
              g.value = reduceRemove(g.value, getRecord(rowIdx), notFilter);
            }
          }
        }
      }

      // Reduces the specified selected or deselected records (cardinality 1).
      function updateOne(filterSlot, added, removed, notFilter, forceReset) {
        if (notFilter) { unfilteredValid = false; buffersHoldUnfiltered = false; }
        if (filterSlot === dimSlot || resetNeeded) return;

        var i,
            rowIdx,
            len,
            g;

        if (reduceMode !== null) {
          if (notFilter || forceReset || added.length + removed.length > (n >>> 2)
            || (reduceMode !== 'count' && removed.length > 0 && metricPlan && !canPlanUseComplement(metricPlan, getNumericColumn))) {
            resetNeeded = true;
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'count') {
            var delta = 0;
            for (i = 0, len = added.length; i < len; ++i) {
              if (filterStore.isActiveExcept(added[i], dimSlot)) ++delta;
            }
            for (i = 0, len = removed.length; i < len; ++i) {
              if (filterStore.isOnlyExcludedByExcept(removed[i], dimSlot, filterSlot)) --delta;
            }
            countBuf[0] += delta;
            valuesSynced = false;
            return;
          }

          var addCount = 0,
              remCount = 0,
              maxWork = added.length > removed.length ? added.length : removed.length;
          if (maxWork > 0) {
            deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, maxWork);
          }

          if (reduceMode === 'splitMetricSpec') {
            var splitCol = getSplitColumn(reduceSplitField);
            if (splitCol.codeToKey.length !== splitActiveStride) {
              resetNeeded = true;
              valuesSynced = false;
              return;
            }
            materializeUnfilteredCacheIfNeeded();
            for (i = 0, len = added.length; i < len; ++i) {
              rowIdx = added[i];
              if (filterStore.isActiveExcept(rowIdx, dimSlot)) deltaWorkBuf[addCount++] = rowIdx;
            }
            if (addCount > 0) {
              reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, deltaWorkBuf, addCount, 1, 0);
            }
            for (i = 0, len = removed.length; i < len; ++i) {
              rowIdx = removed[i];
              if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) deltaWorkBuf[remCount++] = rowIdx;
            }
            if (remCount > 0) {
              reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, deltaWorkBuf, remCount, -1, 0);
            }
            valuesSynced = false;
            return;
          }

          // reduceMode === 'metricSpec'
          materializeUnfilteredCacheIfNeeded();
          for (i = 0, len = added.length; i < len; ++i) {
            rowIdx = added[i];
            if (filterStore.isActiveExcept(rowIdx, dimSlot)) deltaWorkBuf[addCount++] = rowIdx;
          }
          if (addCount > 0) {
            reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, addCount, 1);
          }
          for (i = 0, len = removed.length; i < len; ++i) {
            rowIdx = removed[i];
            if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) deltaWorkBuf[remCount++] = rowIdx;
          }
          if (remCount > 0) {
            reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, remCount, -1);
          }
          valuesSynced = false;
          return;
        }

        g = groups[0];
        for (i = 0, len = added.length; i < len; ++i) {
          if (filterStore.isActiveExcept(rowIdx = added[i], dimSlot)) {
            g.value = reduceAdd(g.value, getRecord(rowIdx), false);
          }
        }
        for (i = 0, len = removed.length; i < len; ++i) {
          if (filterStore.isOnlyExcludedByExcept(rowIdx = removed[i], dimSlot, filterSlot)) {
            g.value = reduceRemove(g.value, getRecord(rowIdx), notFilter);
          }
        }
      }

      // Recomputes the group reduce values from scratch.
      function resetMany() {
        var i,
            j,
            g,
            applyFilteredRemovals = hasOtherActiveDimensionFilters();

        if (lazyIdentityMode) {
          ensureLazyOrder();
        } else if (rawBucketMode) {
          ensureRawBucketLayout();
        } else if (lazyBucketMode) {
          ensureLazyBucketLayout();
        }

        if (iterable) {
          for (i = 0; i < k; ++i) {
            groups[i].value = reduceInitial();
          }
          for (i = 0; i < n; ++i) {
            for (j = 0; j < groupIndex[i].length; j++) {
              g = groups[groupIndex[i][j]];
              if (reduceMode === 'count') {
                g.value += 1;
              } else {
                var iterableRecord = getRecord(i);
                g.value = reduceAdd(g.value, iterableRecord, true, j);
              }
            }
          }
          if (!applyFilteredRemovals) {
            valuesSynced = true;
            return;
          }
          for (i = 0; i < n; ++i) {
            if (!filterStore.isActiveExcept(i, dimSlot)) {
              for (j = 0; j < groupIndex[i].length; j++) {
                g = groups[groupIndex[i][j]];
                if (reduceMode === 'count') {
                  g.value -= 1;
                } else {
                  var filteredIterableRecord = getRecord(i);
                  g.value = reduceRemove(g.value, filteredIterableRecord, false, j);
                }
              }
            }
          }
          valuesSynced = true;
          return;
        }

        if (k === 0) {
          groups = [];
          valuesSynced = true;
          return;
        }

        if (reduceMode !== null) {
          var slotArr = getPrimarySlotArray(),
              slotCount = getPrimarySlotCount(),
              rows;

          if (reduceMode === 'count') {
            ensureCountBuf(slotCount);
            countBuf.fill(0, 0, slotCount);
            if (!applyFilteredRemovals) {
              if (lazyIdentityMode) {
                var cc = lazyEncodedState.codeCounts;
                for (i = 1; i < slotCount; ++i) {
                  countBuf[i] = cc[i];
                }
              } else {
                for (i = 0; i < n; ++i) {
                  countBuf[slotArr[i]] += 1;
                }
              }
            } else {
              rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
              if (!rows) {
                if (lazyIdentityMode) {
                  var ccAll = lazyEncodedState.codeCounts;
                  for (i = 1; i < slotCount; ++i) {
                    countBuf[i] = ccAll[i];
                  }
                } else {
                  for (i = 0; i < n; ++i) {
                    countBuf[slotArr[i]] += 1;
                  }
                }
              } else {
                var rIdx = rows.indices,
                    rLen = rows.length;
                for (i = 0; i < rLen; ++i) {
                  countBuf[slotArr[rIdx[i]]] += 1;
                }
              }
            }
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'metricSpec') {
            if (!applyFilteredRemovals) {
              if (!restoreUnfilteredIntoBuffers(slotCount, false)) {
                buffersHoldUnfiltered = false;
                unfilteredValid = false;
                metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
                zeroMetricBuffers(metricBuffers, slotCount);
                reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, slotArr, n, slotCount);
                markBuffersHoldUnfiltered(slotCount);
              }
            } else if (brushActive && brushFalcon && transientFilterDepth === 0 && !dimSlot.active && brushFalcon.hasGroup(group)) {
              var singleInfo = {
                buffers: metricBuffers,
                ensureBuffers: function() {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
                  singleInfo.buffers = metricBuffers;
                },
                groupRef: group,
                slotArr: slotArr,
                slotCount: slotCount
              };
              brushFalcon.applyQuerySingle(brushQueryKind, brushLo, brushHi, singleInfo);
            } else {
              var mActCnt = !dimSlot.active ? filteredCount() : filterStore.countActive(dimSlot);
              if (mActCnt === 0) {
                materializeUnfilteredCacheIfNeeded();
                metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
                zeroMetricBuffers(metricBuffers, slotCount);
              } else if (mActCnt === n && restoreUnfilteredIntoBuffers(slotCount, false)) {
                // restored from unfiltered cache
              } else if (mActCnt > (n >>> 1) && hasValidUnfilteredCache(slotCount) && canPlanUseComplement(metricPlan, getNumericColumn)) {
                var mExcl = getExcludedRows(dimSlot.active ? dimSlot : null);
                restoreUnfilteredIntoBuffers(slotCount, true);
                if (mExcl.length > 0) {
                  reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, mExcl.indices, mExcl.length, -1, slotCount);
                  var mExCntOff = getExactCountOffset(metricPlan, getNumericColumn);
                  var mTrk = mExCntOff < 0 ? ensureUnfilteredRowCounts(slotCount, slotArr, null, 0) : null;
                  cleanupComplementEmptySlots(
                    metricBuffers, metricPlan, mExCntOff, slotArr, null, 0,
                    mTrk, mExCntOff < 0 ? ensureUnfilteredTmpCounts(slotCount) : null,
                    mExcl.indices, mExcl.length, slotCount
                  );
                }
              } else {
                materializeUnfilteredCacheIfNeeded();
                metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
                zeroMetricBuffers(metricBuffers, slotCount);
                rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
                if (!rows) {
                  reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, slotArr, n, slotCount);
                } else {
                  reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, rows.indices, rows.length, 1, slotCount);
                }
              }
            }
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'splitMetricSpec') {
            var splitCol = getSplitColumn(reduceSplitField),
                stride = splitCol.codeToKey.length;
            splitActiveStride = stride;
            if (stride === 0) {
              splitMode = 'dense';
              buffersHoldUnfiltered = false;
              unfilteredValid = false;
              metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
              zeroMetricBuffers(metricBuffers, 1);
              valuesSynced = false;
              return;
            }
            if (slotCount * stride <= 262144) {
              splitMode = 'dense';
              var totalSlots = slotCount * stride;
              if (!applyFilteredRemovals) {
                if (!restoreUnfilteredIntoBuffers(totalSlots, false)) {
                  buffersHoldUnfiltered = false;
                  unfilteredValid = false;
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, totalSlots, false);
                  zeroMetricBuffers(metricBuffers, totalSlots);
                  reduceSplitDenseAll(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, stride, n, totalSlots);
                  markBuffersHoldUnfiltered(totalSlots);
                }
              } else {
                var sdActCnt = !dimSlot.active ? filteredCount() : filterStore.countActive(dimSlot);
                if (sdActCnt === 0) {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, totalSlots, false);
                  zeroMetricBuffers(metricBuffers, totalSlots);
                } else if (sdActCnt === n && restoreUnfilteredIntoBuffers(totalSlots, false)) {
                  // restored from unfiltered cache
                } else if (sdActCnt > (n >>> 1) && hasValidUnfilteredCache(totalSlots) && canPlanUseComplement(metricPlan, getNumericColumn)) {
                  var sdExcl = getExcludedRows(dimSlot.active ? dimSlot : null);
                  restoreUnfilteredIntoBuffers(totalSlots, true);
                  if (sdExcl.length > 0) {
                    reduceSplitDenseIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, stride, sdExcl.indices, sdExcl.length, -1, totalSlots);
                    var sdExCntOff = getExactCountOffset(metricPlan, getNumericColumn);
                    var sdTrk = sdExCntOff < 0 ? ensureUnfilteredRowCounts(totalSlots, slotArr, splitCol.codes, stride) : null;
                    cleanupComplementEmptySlots(
                      metricBuffers, metricPlan, sdExCntOff, slotArr, splitCol.codes, stride,
                      sdTrk, sdExCntOff < 0 ? ensureUnfilteredTmpCounts(totalSlots) : null,
                      sdExcl.indices, sdExcl.length, totalSlots
                    );
                  }
                } else {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, totalSlots, false);
                  zeroMetricBuffers(metricBuffers, totalSlots);
                  rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
                  if (!rows) {
                    reduceSplitDenseAll(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, stride, n, totalSlots);
                  } else {
                    reduceSplitDenseIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, stride, rows.indices, rows.length, 1, totalSlots);
                  }
                }
              }
            } else {
              splitMode = 'sparse';
              ensureSparseSplitLayout(slotArr, slotCount, splitCol);
              var spSlots = sparsePairCount || 1;
              if (!applyFilteredRemovals) {
                if (!restoreUnfilteredIntoBuffers(sparsePairCount, false)) {
                  buffersHoldUnfiltered = false;
                  unfilteredValid = false;
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, spSlots, false);
                  zeroMetricBuffers(metricBuffers, sparsePairCount);
                  reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, n, sparsePairCount);
                  markBuffersHoldUnfiltered(sparsePairCount);
                }
              } else {
                var spActCnt = !dimSlot.active ? filteredCount() : filterStore.countActive(dimSlot);
                if (spActCnt === 0) {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, spSlots, false);
                  zeroMetricBuffers(metricBuffers, sparsePairCount);
                } else if (spActCnt === n && restoreUnfilteredIntoBuffers(sparsePairCount, false)) {
                  // restored from unfiltered cache
                } else if (spActCnt > (n >>> 1) && hasValidUnfilteredCache(sparsePairCount) && canPlanUseComplement(metricPlan, getNumericColumn)) {
                  var spExcl = getExcludedRows(dimSlot.active ? dimSlot : null);
                  restoreUnfilteredIntoBuffers(sparsePairCount, true);
                  if (spExcl.length > 0) {
                    reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, spExcl.indices, spExcl.length, -1, sparsePairCount);
                    var spExCntOff = getExactCountOffset(metricPlan, getNumericColumn);
                    var spTrk = spExCntOff < 0 ? ensureUnfilteredRowCounts(sparsePairCount, sparsePairGroupIds, null, 0) : null;
                    cleanupComplementEmptySlots(
                      metricBuffers, metricPlan, spExCntOff, sparsePairGroupIds, null, 0,
                      spTrk, spExCntOff < 0 ? ensureUnfilteredTmpCounts(sparsePairCount) : null,
                      spExcl.indices, spExcl.length, sparsePairCount
                    );
                  }
                } else {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, spSlots, false);
                  zeroMetricBuffers(metricBuffers, sparsePairCount);
                  rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
                  if (!rows) {
                    reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, n, sparsePairCount);
                  } else {
                    reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, rows.indices, rows.length, 1, sparsePairCount);
                  }
                }
              }
            }
            valuesSynced = false;
            return;
          }
        }

        // Custom reducer path
        if (lazyIdentityMode) {
          ensureLazyIdentityGroups();
        } else if (rawBucketMode) {
          if (!groups || groups.length !== k) {
            groups = new Array(k);
            for (i = 0; i < k; ++i) {
              groups[i] = { key: rawBucketKeys[rawBucketSortedOrder[i]], value: undefined };
            }
          }
        } else if (lazyBucketMode && (!groups || groups.length !== k)) {
          groups = new Array(k);
          for (i = 0; i < k; ++i) {
            groups[i] = { key: bucketKeys[i], value: undefined };
          }
        }

        for (i = 0; i < k; ++i) {
          groups[i].value = reduceInitial();
        }

        var rawToSorted = null;
        if (rawBucketMode) {
          rawToSorted = new Uint32Array(k);
          for (i = 0; i < k; ++i) rawToSorted[rawBucketSortedOrder[i]] = i;
        }

        var customSlotArr = lazyIdentityMode ? lazyEncodedState.codes : groupIndex;
        for (i = 0; i < n; ++i) {
          var ag = lazyIdentityMode
            ? lazyCodeToGroup[customSlotArr[i]]
            : (rawBucketMode ? rawToSorted[customSlotArr[i]] : customSlotArr[i]);
          if (ag >= 0 && ag < k) {
            g = groups[ag];
            g.value = reduceAdd(g.value, getRecord(i), true);
          }
        }
        if (!applyFilteredRemovals) {
          valuesSynced = true;
          return;
        }
        for (i = 0; i < n; ++i) {
          if (!filterStore.isActiveExcept(i, dimSlot)) {
            var rg = lazyIdentityMode
              ? lazyCodeToGroup[customSlotArr[i]]
              : (rawBucketMode ? rawToSorted[customSlotArr[i]] : customSlotArr[i]);
            if (rg >= 0 && rg < k) {
              g = groups[rg];
              g.value = reduceRemove(g.value, getRecord(i), false);
            }
          }
        }
        valuesSynced = true;
      }

      // Recomputes the group reduce values from scratch (cardinality 1).
      function resetOne() {
        var i,
            applyFilteredRemovals = hasOtherActiveDimensionFilters(),
            rows;

        if (reduceMode !== null) {
          if (reduceMode === 'count') {
            ensureCountBuf(1);
            if (!applyFilteredRemovals) {
              countBuf[0] = n;
            } else if (!dimSlot.active) {
              countBuf[0] = filteredCount();
            } else {
              countBuf[0] = filterStore.countActive(dimSlot);
            }
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'metricSpec') {
            buffersHoldUnfiltered = false;
            unfilteredValid = false;
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
            zeroMetricBuffers(metricBuffers, 1);
            if (!applyFilteredRemovals) {
              reduceScalarAll(metricBuffers, metricPlan, getNumericColumn, n);
            } else {
              rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
              if (!rows) {
                reduceScalarAll(metricBuffers, metricPlan, getNumericColumn, n);
              } else {
                reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, rows.indices, rows.length, 1);
              }
            }
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'splitMetricSpec') {
            buffersHoldUnfiltered = false;
            unfilteredValid = false;
            var splitCol = getSplitColumn(reduceSplitField),
                stride = splitCol.codeToKey.length;
            splitMode = 'dense';
            splitActiveStride = stride;
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, stride || 1, false);
            zeroMetricBuffers(metricBuffers, stride);
            if (stride > 0) {
              if (!applyFilteredRemovals) {
                reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, n, stride);
              } else {
                rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
                if (!rows) {
                  reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, n, stride);
                } else {
                  reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, rows.indices, rows.length, 1, stride);
                }
              }
            }
            valuesSynced = false;
            return;
          }
        }

        var g = groups[0];
        g.value = reduceInitial();
        for (i = 0; i < n; ++i) {
          g.value = reduceAdd(g.value, getRecord(i), true);
        }
        if (!applyFilteredRemovals) {
          valuesSynced = true;
          return;
        }
        for (i = 0; i < n; ++i) {
          if (!filterStore.isActiveExcept(i, dimSlot)) {
            g.value = reduceRemove(g.value, getRecord(i), false);
          }
        }
        valuesSynced = true;
      }

      function readColumnar() {
        if (iterable || (reduceMode !== 'metricSpec' && reduceMode !== 'splitMetricSpec')) {
          return null;
        }
        if (lazyIdentityMode) {
          ensureLazyOrder();
        } else if (rawBucketMode) {
          ensureRawBucketLayout();
        } else if (lazyBucketMode) {
          ensureLazyBucketLayout();
        }
        if (resetNeeded) {
          reset();
          resetNeeded = false;
        }

        var keySource = null,
            codeToValue = null,
            slotOf = null,
            groupsRef = null;

        if (lazyIdentityMode) {
          codeToValue = lazyEncodedState.codeToValue;
          slotOf = lazySortedCodes;
        } else if (rawBucketMode) {
          codeToValue = rawBucketKeys;
          slotOf = rawBucketSortedOrder;
        } else if (lazyBucketMode) {
          keySource = bucketKeys;
        } else {
          groupsRef = groups;
        }

        if (reduceMode === 'metricSpec') {
          return {
            buffers: metricBuffers,
            codeToValue: codeToValue,
            count: k,
            groups: groupsRef,
            keys: keySource,
            mode: 'flat',
            plan: metricPlan,
            slotOf: slotOf
          };
        }

        var splitCol = getSplitColumn(reduceSplitField);
        if (splitMode === 'dense') {
          return {
            buffers: metricBuffers,
            codeToValue: codeToValue,
            count: k,
            groups: groupsRef,
            keys: keySource,
            mode: 'splitDense',
            plan: metricPlan,
            slotOf: slotOf,
            splitKeys: splitCol.codeToKey,
            splitStride: splitActiveStride
          };
        }

        return {
          buffers: metricBuffers,
          codeToValue: codeToValue,
          count: k,
          groups: groupsRef,
          headBySlot: sparseHeadBySlot,
          keys: keySource,
          mode: 'splitSparse',
          nextPair: sparseNextPair,
          pairSplitCode: sparsePairSplitCode,
          plan: metricPlan,
          slotOf: slotOf,
          splitKeys: splitCol.codeToKey
        };
      }

      // Returns the array of group values, in the dimension's natural order.
      function all() {
        if (resetNeeded) reset(), resetNeeded = false;
        syncGroupsFromBuffers();
        return groups;
      }

      // Returns a new array containing the top K group values, in reduce order.
      function top(k) {
        var top = select(all(), 0, groups.length, k);
        return heap.sort(top, 0, top.length);
      }

      // Sets the reduce behavior for this group to use the specified functions.
      // This method lazily recomputes the reduce values, waiting until needed.
      function reduce(addFn, removeFn, initialFn) {
        reduceAdd = addFn;
        reduceRemove = removeFn;
        reduceInitial = initialFn;
        var resolved = resolveReduceMetricSpec(addFn, removeFn, initialFn);
        reduceMetricSpec = resolved ? resolved.metrics : null;
        reduceSplitField = resolved ? resolved.splitField : null;
        metricPlan = reduceMetricSpec ? compileMetricPlan(reduceMetricSpec) : null;
        metricBuffers = null;
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
        unfilteredData = null;
        unfilteredRowCounts = null;
        unfilteredTmpCounts = null;
        if (brushFalcon && brushFalcon.hasGroup(group)) {
          brushFalcon = null;
          brushBuildFailed = false;
        }
        splitMode = null;
        splitActiveStride = 0;
        reduceMode = null;
        if (reduceMetricSpec && !iterable) {
          reduceMode = reduceSplitField ? 'splitMetricSpec' : 'metricSpec';
        }
        syncUpdateListenerMeta();
        resetNeeded = true;
        valuesSynced = false;
        return group;
      }

      // A convenience method for reducing by count.
      function reduceCount() {
        reduce(xfilterReduce.reduceIncrement, xfilterReduce.reduceDecrement, cr_zero);
        reduceMode = 'count';
        syncUpdateListenerMeta();
        return group;
      }

      // A convenience method for reducing by sum(value).
      function reduceSum(value) {
        return reduce(xfilterReduce.reduceAdd(value), xfilterReduce.reduceSubtract(value), cr_zero);
      }

      // Sets the reduce order, using the specified accessor.
      function order(value) {
        select = xfilterHeapselect.by(valueOf);
        heap = xfilterHeap.by(valueOf);
        function valueOf(d) { return value(d.value); }
        return group;
      }

      // A convenience method for natural ordering by reduce value.
      function orderNatural() {
        return order(cr_identity);
      }

      // Returns the cardinality of this group, irrespective of any filters.
      function size() {
        if (lazyIdentityMode) {
          ensureLazyOrder();
        } else if (rawBucketMode) {
          ensureRawBucketLayout();
        } else if (lazyBucketMode) {
          ensureLazyBucketLayout();
        }
        return k;
      }

      // Removes this group and associated event listeners.
      function dispose() {
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
        unfilteredData = null;
        unfilteredRowCounts = null;
        unfilteredTmpCounts = null;
        if (brushFalcon && brushFalcon.hasGroup(group)) {
          brushFalcon = null;
          brushBuildFailed = false;
        }
        var i = filterListeners.indexOf(update);
        if (i >= 0) filterListeners.splice(i, 1);
        i = indexListeners.indexOf(add);
        if (i >= 0) indexListeners.splice(i, 1);
        i = removeDataListeners.indexOf(removeData);
        if (i >= 0) removeDataListeners.splice(i, 1);
        i = dimensionGroups.indexOf(group);
        if (i >= 0) dimensionGroups.splice(i, 1);
        unregisterResetListener(markResetNeeded);
        return group;
      }

      return reduceCount().orderNatural();
    }

    // A convenience function for generating a singleton group.
    function groupAll() {
      var g = group(cr_null), all = g.all;
      delete g.all;
      delete g.top;
      delete g.order;
      delete g.orderNatural;
      delete g.size;
      g.value = function() { return all()[0].value; };
      return g;
    }

    // Removes this dimension and associated groups and event listeners.
    function dispose() {
      dimensionGroups.slice().forEach(function(group) { group.dispose(); });
      if (lazyStateGetter && accessorPath && lazyDimensionsByField[accessorPath]) {
        var lIdx = lazyDimensionsByField[accessorPath].indexOf(lazyStateGetter);
        if (lIdx >= 0) lazyDimensionsByField[accessorPath].splice(lIdx, 1);
      }
      var i = dataListeners.indexOf(preAdd);
      if (i >= 0) dataListeners.splice(i, 1);
      i = dataListeners.indexOf(postAdd);
      if (i >= 0) dataListeners.splice(i, 1);
      i = removeDataListeners.indexOf(removeData);
      if (i >= 0) removeDataListeners.splice(i, 1);
      filterAll();
      if (brushDimSlot === dimSlot) {
        invalidateBrushState();
      }
      filterStore.freeSlot(dimSlot);
      return dimension;
    }

    return dimension;
  }

  // A convenience method for groupAll on a dummy dimension.
  // This implementation can be optimized since it always has cardinality 1.
  function groupAll() {
    var group = {
      reduce: reduce,
      reduceCount: reduceCount,
      reduceSum: reduceSum,
      value: value,
      dispose: dispose,
      remove: dispose, // for backwards-compatibility
      _coScanInfo: coScanInfo,
      _readScalar: readScalar
    };

    var reduceValue,
        reduceAdd,
        reduceRemove,
        reduceInitial,
        reduceMetricSpec = null,
        metricPlan = null,
        metricBuffers = null,
        unfilteredData = null,
        unfilteredValid = false,
        reduceMode = null,
        valueSynced = false,
        resetNeeded = true,
        markResetNeeded = registerResetListener(function() {
          resetNeeded = true;
          valueSynced = false;
        });

    function saveUnfilteredScalar() {
      if (!metricPlan || !metricBuffers) return;
      var stride = metricPlan.stride;
      if (!unfilteredData || unfilteredData.length < stride) {
        unfilteredData = new Float64Array(stride);
      }
      unfilteredData.set(metricBuffers.data.subarray(0, stride));
      unfilteredValid = true;
    }

    function restoreUnfilteredScalar() {
      if (!unfilteredValid || !unfilteredData || !metricPlan) return false;
      metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
      metricBuffers.data.set(unfilteredData.subarray(0, metricPlan.stride));
      return true;
    }

    function coScanInfo() {
      if (!resetNeeded || reduceMode !== 'metricSpec' || !metricPlan || !metricPlan.canCoScan) {
        return null;
      }
      var applyFilteredRemovals = hasAnyActiveDimensionFilters();
      var info = {
        buffers: metricBuffers,
        canComplement: function() {
          return unfilteredValid && unfilteredData !== null;
        },
        coScanKey: metricPlan.coScanKey,
        commit: function(saveCache) {
          if (saveCache) saveUnfilteredScalar();
          resetNeeded = false;
          valueSynced = false;
        },
        ensureBuffers: function() {
          metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
          info.buffers = metricBuffers;
        },
        groupRef: group,
        plan: metricPlan,
        prepareZero: function() {
          metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
          zeroMetricBuffers(metricBuffers, 1);
          info.buffers = metricBuffers;
        },
        tryRestoreUnfiltered: function() {
          if (restoreUnfilteredScalar()) {
            info.buffers = metricBuffers;
            return true;
          }
          return false;
        },
        unfiltered: !applyFilteredRemovals
      };
      return info;
    }

    // The group listens to the crossfilter for when any dimension changes, so
    // that it can update the reduce value. It must also listen to the parent
    // dimension for when data is added.
    update._xfilterDimSlot = null;
    update._xfilterResettable = false;
    filterListeners.push(update);
    dataListeners.push(add);

    // For consistency; actually a no-op since resetNeeded is true.
    add(data, 0, n);

    // Incorporates the specified new values into this group.
    function add(newData, n0) {
      unfilteredValid = false;
      var i,
          applyFilteredRemovals = hasAnyActiveDimensionFilters();

      if (resetNeeded) return;

      if (reduceMode === 'count') {
        if (!applyFilteredRemovals) {
          reduceValue += (n - n0);
        } else {
          for (i = n0; i < n; ++i) {
            if (filterStore.isActive(i)) reduceValue += 1;
          }
        }
        return;
      }

      if (reduceMode === 'metricSpec') {
        var addedLen = n - n0;
        if (!addedLen) return;
        deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, addedLen);
        var count = 0;
        if (!applyFilteredRemovals) {
          for (i = n0; i < n; ++i) deltaWorkBuf[count++] = i;
        } else {
          for (i = n0; i < n; ++i) {
            if (filterStore.isActive(i)) deltaWorkBuf[count++] = i;
          }
        }
        if (count > 0) {
          reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, count, 1);
          valueSynced = false;
        }
        return;
      }

      // Cycle through all the values.
      for (i = n0; i < n; ++i) {
        var rowRecord = getRecord(i);
        reduceValue = reduceAdd(reduceValue, rowRecord, true);
        if (applyFilteredRemovals && !filterStore.isActive(i)) {
          reduceValue = reduceRemove(reduceValue, rowRecord, false);
        }
      }
    }

    // Reduces the specified selected or deselected records.
    function update(filterSlot, added, removed, notFilter, forceReset) {
      if (notFilter) unfilteredValid = false;
      var i,
          k,
          len;

      if (resetNeeded) return;

      if (reduceMode !== null) {
        if (notFilter || forceReset || added.length + removed.length > (n >>> 2)
          || (reduceMode !== 'count' && removed.length > 0 && metricPlan && !canPlanUseComplement(metricPlan, getNumericColumn))) {
          resetNeeded = true;
          valueSynced = false;
          return;
        }

        if (reduceMode === 'count') {
          var delta = 0;
          for (i = 0, len = added.length; i < len; ++i) {
            if (filterStore.isActive(added[i])) ++delta;
          }
          for (i = 0, len = removed.length; i < len; ++i) {
            if (filterStore.isOnlyExcludedBy(removed[i], filterSlot)) --delta;
          }
          reduceValue += delta;
          return;
        }

        // reduceMode === 'metricSpec'
        var maxWork = added.length > removed.length ? added.length : removed.length;
        if (maxWork > 0) {
          deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, maxWork);
        }
        var addCount = 0;
        for (i = 0, len = added.length; i < len; ++i) {
          k = added[i];
          if (filterStore.isActive(k)) deltaWorkBuf[addCount++] = k;
        }
        if (addCount > 0) {
          reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, addCount, 1);
        }
        var remCount = 0;
        for (i = 0, len = removed.length; i < len; ++i) {
          k = removed[i];
          if (filterStore.isOnlyExcludedBy(k, filterSlot)) deltaWorkBuf[remCount++] = k;
        }
        if (remCount > 0) {
          reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, remCount, -1);
        }
        valueSynced = false;
        return;
      }

      // Add the added values.
      for (i = 0, len = added.length; i < len; ++i) {
        if (filterStore.isActive(k = added[i])) {
          reduceValue = reduceAdd(reduceValue, getRecord(k), notFilter);
        }
      }

      // Remove the removed values.
      for (i = 0, len = removed.length; i < len; ++i) {
        if (filterStore.isOnlyExcludedBy(k = removed[i], filterSlot)) {
          reduceValue = reduceRemove(reduceValue, getRecord(k), notFilter);
        }
      }
    }

    // Recomputes the group reduce value from scratch.
    function reset() {
      var i,
          applyFilteredRemovals = hasAnyActiveDimensionFilters();

      if (reduceMode === 'count') {
        reduceValue = filteredCount();
        valueSynced = true;
        return;
      }

      if (reduceMode === 'metricSpec') {
        if (!applyFilteredRemovals) {
          if (!restoreUnfilteredScalar()) {
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
            zeroMetricBuffers(metricBuffers, 1);
            reduceScalarAll(metricBuffers, metricPlan, getNumericColumn, n);
            saveUnfilteredScalar();
          }
        } else if (brushActive && brushFalcon && transientFilterDepth === 0 && brushFalcon.hasGroup(group)) {
          var kpiSingle = {
            buffers: metricBuffers,
            ensureBuffers: function() {
              metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
              kpiSingle.buffers = metricBuffers;
            },
            groupRef: group,
            slotArr: null,
            slotCount: 1
          };
          brushFalcon.applyQuerySingle(brushQueryKind, brushLo, brushHi, kpiSingle);
        } else {
          var sActCnt = filteredCount();
          if (sActCnt === 0) {
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
            zeroMetricBuffers(metricBuffers, 1);
          } else if (sActCnt === n && restoreUnfilteredScalar()) {
            // restored from unfiltered cache
          } else if (sActCnt > (n >>> 1) && unfilteredValid && canPlanUseComplement(metricPlan, getNumericColumn)) {
            var sExcl = getExcludedRows(null);
            restoreUnfilteredScalar();
            if (sExcl.length > 0) {
              reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, sExcl.indices, sExcl.length, -1);
            }
          } else {
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
            zeroMetricBuffers(metricBuffers, 1);
            var active = getActiveRows();
            if (!active) {
              reduceScalarAll(metricBuffers, metricPlan, getNumericColumn, n);
            } else {
              reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, active.indices, active.length, 1);
            }
          }
        }
        valueSynced = false;
        return;
      }

      reduceValue = reduceInitial();

      for (i = 0; i < n; ++i) {
        var rowRecord = getRecord(i);
        reduceValue = reduceAdd(reduceValue, rowRecord, true);
        if (applyFilteredRemovals && !filterStore.isActive(i)) {
          reduceValue = reduceRemove(reduceValue, rowRecord, false);
        }
      }
      valueSynced = true;
    }

    // Sets the reduce behavior for this group to use the specified functions.
    // This method lazily recomputes the reduce value, waiting until needed.
    function reduce(addFn, removeFn, initialFn) {
      reduceAdd = addFn;
      reduceRemove = removeFn;
      reduceInitial = initialFn;
      var resolved = resolveReduceMetricSpec(addFn, removeFn, initialFn);
      reduceMetricSpec = resolved && !resolved.splitField ? resolved.metrics : null;
      metricPlan = reduceMetricSpec ? compileMetricPlan(reduceMetricSpec) : null;
      metricBuffers = null;
      unfilteredValid = false;
      unfilteredData = null;
      if (brushFalcon && brushFalcon.hasGroup(group)) {
        brushFalcon = null;
        brushBuildFailed = false;
      }
      reduceMode = reduceMetricSpec ? 'metricSpec' : null;
      update._xfilterResettable = reduceMode !== null;
      resetNeeded = true;
      valueSynced = false;
      return group;
    }

    // A convenience method for reducing by count.
    function reduceCount() {
      reduce(xfilterReduce.reduceIncrement, xfilterReduce.reduceDecrement, cr_zero);
      reduceMode = 'count';
      update._xfilterResettable = true;
      return group;
    }

    // A convenience method for reducing by sum(value).
    function reduceSum(value) {
      return reduce(xfilterReduce.reduceAdd(value), xfilterReduce.reduceSubtract(value), cr_zero);
    }

    function readScalar() {
      if (reduceMode !== 'metricSpec') {
        return null;
      }
      if (resetNeeded) reset(), resetNeeded = false;
      return finalizeMetricSlot(metricPlan, metricBuffers, 0);
    }

    // Returns the computed reduce value.
    function value() {
      if (resetNeeded) reset(), resetNeeded = false;
      if (reduceMode === 'metricSpec' && !valueSynced) {
        if (!reduceValue) reduceValue = reduceInitial();
        writeMetricSlotToState(reduceValue, metricPlan, metricBuffers, 0);
        valueSynced = true;
      }
      return reduceValue;
    }

    // Removes this group and associated event listeners.
    function dispose() {
      unfilteredValid = false;
      unfilteredData = null;
      if (brushFalcon && brushFalcon.hasGroup(group)) {
        brushFalcon = null;
        brushBuildFailed = false;
      }
      var i = filterListeners.indexOf(update);
      if (i >= 0) filterListeners.splice(i, 1);
      i = dataListeners.indexOf(add);
      if (i >= 0) dataListeners.splice(i, 1);
      unregisterResetListener(markResetNeeded);
      return group;
    }

    return reduceCount();
  }

  // Returns the number of records in this crossfilter, irrespective of any filters.
  function size() {
    return n;
  }

  // Returns the raw row data contained in this crossfilter
  function all(){
    materializeAllRecords();
    return data;
  }

  // Returns row data with all dimension filters applied, except for filters in ignore_dimensions
  function allFiltered(ignore_dimensions) {
    var array = [],
        i = 0,
        ignoreMap = buildIgnoreIdMap(ignore_dimensions);

    if (!ignoreMap) {
      if (!filterStore.hasAnyActive()) {
        for (i = 0; i < n; i++) array.push(getRecord(i));
        return array;
      }
      var active = getActiveRows();
      if (!active) {
        for (i = 0; i < n; i++) array.push(getRecord(i));
        return array;
      }
      var indices = active.indices,
          len = active.length;
      for (i = 0; i < len; i++) {
        array.push(getRecord(indices[i]));
      }
      return array;
    }

    for (i = 0; i < n; i++) {
      if (filterStore.isActiveIgnoring(i, ignoreMap)) {
        array.push(getRecord(i));
      }
    }

    return array;
  }

  function allFilteredIndexes(ignore_dimensions) {
    var array,
        i = 0,
        ignoreMap;

    if (!ignore_dimensions || !ignore_dimensions.length) {
      if (!filterStore.hasAnyActive()) {
        array = new Array(n);
        for (i = 0; i < n; ++i) array[i] = i;
        return array;
      }
      var active = getActiveRows();
      if (!active) {
        array = new Array(n);
        for (i = 0; i < n; ++i) array[i] = i;
        return array;
      }
      array = new Array(active.length);
      var indices = active.indices;
      for (i = 0; i < active.length; ++i) array[i] = indices[i];
      return array;
    }

    array = [];
    ignoreMap = buildIgnoreIdMap(ignore_dimensions);

    for (i = 0; i < n; i++) {
      if (filterStore.isActiveIgnoring(i, ignoreMap)) {
        array.push(i);
      }
    }

    return array;
  }

  function resolveUniformTypedArrayConstructor(field) {
    if (!columnarBatches.length) return null;
    var expectedStart = 0;
    var ctor = null;
    var firstTag = null;
    var b, batch, col, tag;
    for (b = 0; b < columnarBatches.length; ++b) {
      batch = columnarBatches[b];
      if (batch.start !== expectedStart) return null;
      expectedStart = batch.end;
      col = batch.columns[field];
      if (!ArrayBuffer.isView(col) || typeof col.BYTES_PER_ELEMENT !== 'number') return null;
      tag = objToString.call(col);
      if (ctor === null) {
        ctor = col.constructor;
        firstTag = tag;
      } else if (tag !== firstTag) {
        return null;
      }
    }
    return expectedStart === n ? ctor : null;
  }

  function takeColumns(rowIndexes, fields) {
    var selectedFields = fields && fields.length ? fields.slice() : null;
    var columns = {};
    var rowCount = rowIndexes ? rowIndexes.length : 0;
    var fieldIndex;
    var rowIndex;
    var batchCount = columnarBatches.length;
    var singleFullBatch = batchCount === 1
      && columnarBatches[0].start === 0
      && columnarBatches[0].end === n
      ? columnarBatches[0]
      : null;

    if (!selectedFields) {
      return {
        columns: columns,
        fields: [],
        length: rowCount
      };
    }

    var batchStarts = null;
    var batchEnds = null;
    if (batchCount > 0 && !singleFullBatch) {
      batchStarts = new Uint32Array(batchCount);
      batchEnds = new Uint32Array(batchCount);
      for (var bi0 = 0; bi0 < batchCount; ++bi0) {
        batchStarts[bi0] = columnarBatches[bi0].start;
        batchEnds[bi0] = columnarBatches[bi0].end;
      }
    }

    for (fieldIndex = 0; fieldIndex < selectedFields.length; ++fieldIndex) {
      var field = selectedFields[fieldIndex];
      var typedCtor = resolveUniformTypedArrayConstructor(field);
      var out = typedCtor ? new typedCtor(rowCount) : new Array(rowCount);

      if (singleFullBatch) {
        var srcCol = singleFullBatch.columns[field];
        var srcAcc = singleFullBatch.accessors && singleFullBatch.accessors[field];
        if (ArrayBuffer.isView(srcCol) || Array.isArray(srcCol)) {
          for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
            out[rowIndex] = srcCol[rowIndexes[rowIndex]];
          }
        } else {
          var srcDictChunks = rowCount > 32 ? resolveArrowDictionaryChunks(srcCol) : null;
          if (srcDictChunks && srcDictChunks.length === 1 && srcDictChunks[0].dictionary.length <= rowCount * 2) {
            var dChunk = srcDictChunks[0];
            var dDict = dChunk.dictionary;
            var dLen = dDict.length;
            var dVals = new Array(dLen);
            for (var d = 0; d < dLen; ++d) dVals[d] = dDict.get(d);
            var dIndices = dChunk.values;
            if (dChunk.nullCount === 0) {
              for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                out[rowIndex] = dVals[dIndices[rowIndexes[rowIndex]]];
              }
            } else {
              var dNull = dChunk.nullBitmap;
              var dOff = typeof dChunk.offset === 'number' ? dChunk.offset : 0;
              for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                var dri = rowIndexes[rowIndex];
                var dBitIdx = dOff + dri;
                out[rowIndex] = (dNull[dBitIdx >>> 3] & (1 << (dBitIdx & 7))) ? dVals[dIndices[dri]] : null;
              }
            }
          } else {
            var srcUtf8Chunks = rowCount > 32 ? resolveArrowUtf8Chunks(srcCol) : null;
            if (srcUtf8Chunks && srcUtf8Chunks.length === 1 && rowCount >= (srcUtf8Chunks[0].length >>> 2)) {
              var decodedUtf8 = extractArrowUtf8Range(srcUtf8Chunks, 0, srcUtf8Chunks[0].length);
              if (decodedUtf8) {
                for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                  out[rowIndex] = decodedUtf8[rowIndexes[rowIndex]];
                }
              } else if (srcAcc) {
                for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                  out[rowIndex] = srcAcc(rowIndexes[rowIndex]);
                }
              } else {
                for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                  out[rowIndex] = getFieldValue(rowIndexes[rowIndex], field);
                }
              }
            } else if (srcAcc) {
              for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                out[rowIndex] = srcAcc(rowIndexes[rowIndex]);
              }
            } else {
              for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                out[rowIndex] = getFieldValue(rowIndexes[rowIndex], field);
              }
            }
          }
        }
      } else if (!batchCount) {
        for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
          var row = data[rowIndexes[rowIndex]];
          out[rowIndex] = row ? row[field] : undefined;
        }
      } else {
        var cachedNum = typedCtor ? numericColumns[field] : null;
        if (cachedNum && cachedNum.length === n && !cachedNum.hasNaN && (isGuaranteedFiniteTypedArray(out) || isFloatTypedArray(out))) {
          var cachedVals = cachedNum.values;
          for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
            out[rowIndex] = cachedVals[rowIndexes[rowIndex]];
          }
        } else {
          var batchDirect = new Array(batchCount);
          var batchDict = new Array(batchCount);
          var batchAcc = new Array(batchCount);
          for (var bi = 0; bi < batchCount; ++bi) {
            var bCol = columnarBatches[bi].columns[field];
            if (ArrayBuffer.isView(bCol) || Array.isArray(bCol)) {
              batchDirect[bi] = bCol;
              batchDict[bi] = null;
              batchAcc[bi] = null;
            } else {
              batchDirect[bi] = null;
              var bDictChunks = rowCount > 32 ? resolveArrowDictionaryChunks(bCol) : null;
              if (bDictChunks && bDictChunks.length === 1 && bDictChunks[0].dictionary.length <= rowCount * 2) {
                var bdChunk = bDictChunks[0];
                var bdDict = bdChunk.dictionary;
                var bdLen = bdDict.length;
                var bdVals = new Array(bdLen);
                for (var bd = 0; bd < bdLen; ++bd) bdVals[bd] = bdDict.get(bd);
                batchDict[bi] = {
                  indices: bdChunk.values,
                  nullBitmap: bdChunk.nullCount > 0 ? bdChunk.nullBitmap : null,
                  offset: typeof bdChunk.offset === 'number' ? bdChunk.offset : 0,
                  vals: bdVals
                };
                batchAcc[bi] = null;
              } else {
                var bUtf8Chunks = rowCount > 32 ? resolveArrowUtf8Chunks(bCol) : null;
                if (bUtf8Chunks && bUtf8Chunks.length === 1 && rowCount >= (bUtf8Chunks[0].length >>> 2)) {
                  var bDecodedUtf8 = extractArrowUtf8Range(bUtf8Chunks, 0, bUtf8Chunks[0].length);
                  if (bDecodedUtf8) {
                    batchDirect[bi] = bDecodedUtf8;
                    batchDict[bi] = null;
                    batchAcc[bi] = null;
                    continue;
                  }
                }
                batchDict[bi] = null;
                batchAcc[bi] = (columnarBatches[bi].accessors && columnarBatches[bi].accessors[field]) || null;
              }
            }
          }
          var lastStart = -1;
          var lastEnd = -1;
          var lastDirect = null;
          var lastDict = null;
          var lastAcc = null;
          for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
            var ri = rowIndexes[rowIndex];
            if (ri < lastStart || ri >= lastEnd) {
              var bLo = 0, bHi = batchCount, found = -1;
              while (bLo < bHi) {
                var bMid = (bLo + bHi) >>> 1;
                if (ri < batchStarts[bMid]) bHi = bMid;
                else if (ri >= batchEnds[bMid]) bLo = bMid + 1;
                else { found = bMid; break; }
              }
              if (found >= 0) {
                lastStart = batchStarts[found];
                lastEnd = batchEnds[found];
                lastDirect = batchDirect[found];
                lastDict = batchDict[found];
                lastAcc = batchAcc[found];
              } else {
                lastStart = -1;
                lastEnd = -1;
                lastDirect = null;
                lastDict = null;
                lastAcc = null;
              }
            }
            if (lastDirect) {
              out[rowIndex] = lastDirect[ri - lastStart];
            } else if (lastDict) {
              var locIdx = ri - lastStart;
              if (!lastDict.nullBitmap) {
                out[rowIndex] = lastDict.vals[lastDict.indices[locIdx]];
              } else {
                var mbBit = lastDict.offset + locIdx;
                out[rowIndex] = (lastDict.nullBitmap[mbBit >>> 3] & (1 << (mbBit & 7)))
                  ? lastDict.vals[lastDict.indices[locIdx]]
                  : null;
              }
            } else if (lastAcc) {
              out[rowIndex] = lastAcc(ri - lastStart);
            } else {
              out[rowIndex] = getFieldValue(ri, field);
            }
          }
        }
      }

      columns[field] = out;
    }

    return {
      columns: columns,
      fields: selectedFields,
      length: rowCount
    };
  }

  function onChange(cb){
    if(typeof cb !== 'function'){
      /* eslint no-console: 0 */
      console.warn('onChange callback parameter must be a function!');
      return;
    }
    callbacks.push(cb);
    return function(){
      callbacks.splice(callbacks.indexOf(cb), 1);
    };
  }

  function triggerOnChange(eventName){
    for (var i = 0; i < callbacks.length; i++) {
      callbacks[i](eventName);
    }
  }

  return arguments.length
      ? add(arguments[0])
      : crossfilter;
}

// Returns an array of size n, big enough to store ids up to m.
function cr_index(n, m) {
  return (m < 0x101
      ? xfilterArray.array8 : m < 0x10001
      ? xfilterArray.array16
      : xfilterArray.array32)(n);
}

// Constructs a new array of size n, with sequential values from 0 to n - 1.
function cr_range(n) {
  var range = cr_index(n, n);
  for (var i = -1; ++i < n;) range[i] = i;
  return range;
}

function capacity(w) {
  return w === 8
      ? 0x100 : w === 16
      ? 0x10000
      : 0x100000000;
}
