function resolveArrowBuffer(source) {
  if (source instanceof ArrayBuffer) {
    return source;
  }

  if (ArrayBuffer.isView(source)) {
    var view = source;
    if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) {
      return view.buffer;
    }
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  }

  throw new Error("createStreamingDashboardWorker expects `arrowBuffer` to be an ArrayBuffer or typed array view.");
}

function resolveAssetUrl(url) {
  if (typeof URL === "function" && typeof location !== "undefined" && location && location.href) {
    return new URL(url, location.href).toString();
  }
  return url;
}

function normalizeStreamingSource(source, index, defaultFetchInit, transfer) {
  if (!source || typeof source !== "object") {
    throw new Error("Streaming dashboard source at index " + index + " must be an object.");
  }

  var id = source.id || "source_" + index;
  var hasArrowBuffer = source.arrowBuffer != null;
  var hasDataUrl = !!source.dataUrl;

  if (hasArrowBuffer === hasDataUrl) {
    throw new Error("Streaming dashboard source `" + id + "` expects exactly one of `arrowBuffer` or `dataUrl`.");
  }

  var normalized = {
    dataFetchInit: source.dataFetchInit || defaultFetchInit || null,
    dataUrl: source.dataUrl ? resolveAssetUrl(source.dataUrl) : null,
    id: id,
    lookup: source.lookup || null,
    projection: source.projection || null,
    role: source.role || null
  };

  if (hasArrowBuffer) {
    normalized.arrowBuffer = resolveArrowBuffer(source.arrowBuffer);
    transfer.push(normalized.arrowBuffer);
  }

  return normalized;
}

function resolveStreamingSources(options, transfer) {
  if (!Array.isArray(options.sources) || !options.sources.length) {
    return null;
  }

  var sources = options.sources.map(function(source, index) {
    return normalizeStreamingSource(source, index, options.dataFetchInit || null, transfer);
  });
  var baseCount = 0;

  for (var sourceIndex = 0; sourceIndex < sources.length; ++sourceIndex) {
    var source = sources[sourceIndex];
    if (!source.role) {
      source.role = sourceIndex === 0 ? "base" : "lookup";
    }
    if (source.role === "base") {
      baseCount += 1;
      if (source.lookup) {
        throw new Error("Streaming dashboard source `" + source.id + "` cannot declare `lookup` when role is `base`.");
      }
      continue;
    }
    if (source.role !== "lookup") {
      throw new Error("Streaming dashboard source `" + source.id + "` has unsupported role `" + source.role + "`.");
    }
    if (!source.lookup || !Array.isArray(source.lookup.keyFields) || !source.lookup.keyFields.length || !Array.isArray(source.lookup.valueFields) || !source.lookup.valueFields.length) {
      throw new Error("Streaming dashboard lookup source `" + source.id + "` requires non-empty `lookup.keyFields` and `lookup.valueFields`.");
    }
  }

  if (baseCount !== 1) {
    throw new Error("Streaming dashboard worker expects exactly one base source.");
  }

  return sources;
}

function createWorkerSource(crossfilterUrl, arrowUrl) {
  return `
'use strict';
importScripts(${JSON.stringify(crossfilterUrl)}, ${JSON.stringify(arrowUrl)});
var runtime = null;
var runtimeConfig = null;
var abortControllers = [];
var progress = null;
var progressTimer = 0;
var snapshotTimer = 0;
function getRecordBatchReader(module) {
  return module && (module.RecordBatchReader || (module.default && module.default.RecordBatchReader)) || null;
}
function getFieldNames(table) {
  if (table && table.schema && Array.isArray(table.schema.fields)) {
    return table.schema.fields.map(function(field) { return field.name; });
  }
  if (table && Array.isArray(table.columnNames)) {
    return table.columnNames.slice();
  }
  return [];
}
function getColumn(table, name, index) {
  if (!table) return undefined;
  if (typeof table.getChild === 'function') {
    var child = table.getChild(name);
    if (child != null) return child;
  }
  if (typeof table.getColumn === 'function') {
    var column = table.getColumn(name);
    if (column != null) return column;
  }
  if (typeof table.getChildAt === 'function') {
    return table.getChildAt(index);
  }
  return table[name];
}
function getValue(column, index) {
  if (column == null) return undefined;
  if (typeof column.get === 'function') return column.get(index);
  if (typeof column.at === 'function') return column.at(index);
  return column[index];
}
function resolveColumnAccessor(column) {
  if (column == null) return null;
  if (ArrayBuffer.isView(column) || Array.isArray(column)) return 'index';
  if (typeof column.get === 'function') return 'get';
  if (typeof column.at === 'function') return 'at';
  return 'index';
}
function getValueByKind(column, index, kind) {
  if (kind === 'get') return column.get(index);
  if (kind === 'at') return column.at(index);
  return column[index];
}
function allocateMergedColumn(column, length) {
  if (ArrayBuffer.isView(column) && typeof column.constructor === 'function' && typeof column.BYTES_PER_ELEMENT === 'number') {
    return new column.constructor(length);
  }
  return new Array(length);
}
function copyColumnValues(target, targetOffset, source, length) {
  if (ArrayBuffer.isView(target) && ArrayBuffer.isView(source) && source.constructor === target.constructor && typeof source.length === 'number') {
    target.set(source, targetOffset);
    return;
  }
  var sourceKind = resolveColumnAccessor(source);
  for (var rowIndex = 0; rowIndex < length; ++rowIndex) {
    target[targetOffset + rowIndex] = source == null ? undefined : getValueByKind(source, rowIndex, sourceKind);
  }
}
function mergeProjectedBatches(batches) {
  if (!batches.length) {
    return null;
  }
  if (batches.length === 1) {
    return batches[0];
  }

  var fields = batches[0].fields.slice();
  var totalLength = 0;
  var columns = {};

  for (var batchIndex = 0; batchIndex < batches.length; ++batchIndex) {
    totalLength += batches[batchIndex].length;
  }

  for (var fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
    columns[fields[fieldIndex]] = allocateMergedColumn(batches[0].columns[fields[fieldIndex]], totalLength);
  }

  var offset = 0;
  for (batchIndex = 0; batchIndex < batches.length; ++batchIndex) {
    var batch = batches[batchIndex];
    for (fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
      var field = fields[fieldIndex];
      copyColumnValues(columns[field], offset, batch.columns[field], batch.length);
    }
    offset += batch.length;
  }

  return {
    columns: columns,
    fields: fields,
    length: totalLength
  };
}
function flushBufferedRuntimeBatches(bufferedBatches) {
  if (!runtime || !bufferedBatches.length) {
    return;
  }
  var merged = mergeProjectedBatches(bufferedBatches);
  runtime.appendColumns(merged.columns, {
    fields: merged.fields,
    length: merged.length
  });
  bufferedBatches.length = 0;
}
function normalizeTimestampValue(value) {
  if (typeof value === 'string') {
    var parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number') {
    return value < 1e12 ? value * 1000 : value;
  }
  var numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return 0;
}
function collectRowTransferables(obj) {
  var buffers = [];
  if (!obj || typeof obj !== 'object' || !obj.columns) return buffers;
  for (var field in obj.columns) {
    if (Object.prototype.hasOwnProperty.call(obj.columns, field)) {
      var col = obj.columns[field];
      if (ArrayBuffer.isView(col) && col.buffer) buffers.push(col.buffer);
    }
  }
  return buffers;
}
function collectResponseTransferables(payload) {
  if (!payload || typeof payload !== 'object') return [];
  var seen = [];
  var buffers = [];
  function add(obj) {
    var found = collectRowTransferables(obj);
    for (var i = 0; i < found.length; ++i) {
      if (seen.indexOf(found[i]) < 0) {
        seen.push(found[i]);
        buffers.push(found[i]);
      }
    }
  }
  add(payload);
  if (payload.rows) add(payload.rows);
  if (payload.rowSets) {
    for (var setId in payload.rowSets) {
      if (Object.prototype.hasOwnProperty.call(payload.rowSets, setId)) {
        add(payload.rowSets[setId]);
      }
    }
  }
  return buffers;
}
function respond(id, payload) {
  var transferables = collectResponseTransferables(payload);
  self.postMessage({ id: id, ok: true, payload: payload }, transferables);
}
function fail(id, error) {
  self.postMessage({ id: id, ok: false, error: {
    message: String(error && error.message || error),
    stack: error && error.stack ? String(error.stack) : null
  } });
}
function publish(eventType, payload) {
  self.postMessage({ eventType: eventType, payload: payload });
}
function getProjectionFieldName(projection, inputName) {
  return projection && projection.rename && projection.rename[inputName] || inputName;
}
function getProjectionTransform(projection, inputName, outputName) {
  if (!projection || !projection.transforms) {
    return null;
  }
  return projection.transforms[outputName] || projection.transforms[inputName] || null;
}
function normalizeNumericValue(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  var numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
function projectBatch(batch, projection) {
  var actualFields = getFieldNames(batch);
  var inputFields = projection && Array.isArray(projection.fields) && projection.fields.length
    ? projection.fields.slice()
    : actualFields.slice();
  var fieldIndexes = {};
  var projectedFields = [];
  var columns = {};
  var length = batch && typeof batch.numRows === 'number' ? batch.numRows : 0;

  for (var actualIndex = 0; actualIndex < actualFields.length; ++actualIndex) {
    fieldIndexes[actualFields[actualIndex]] = actualIndex;
  }
  if (projection && Array.isArray(projection.extraFields) && projection.extraFields.length) {
    for (var extraIndex = 0; extraIndex < projection.extraFields.length; ++extraIndex) {
      var extraField = projection.extraFields[extraIndex];
      if (inputFields.indexOf(extraField) < 0) {
        inputFields.push(extraField);
      }
    }
  }

  for (var fieldIndex = 0; fieldIndex < inputFields.length; ++fieldIndex) {
    var inputName = inputFields[fieldIndex];
    var outputName = getProjectionFieldName(projection, inputName);
    var inputIndex = Object.prototype.hasOwnProperty.call(fieldIndexes, inputName)
      ? fieldIndexes[inputName]
      : fieldIndex;
    var sourceColumn = getColumn(batch, inputName, inputIndex);
    var transform = getProjectionTransform(projection, inputName, outputName);

    if (!Object.prototype.hasOwnProperty.call(columns, outputName)) {
      projectedFields.push(outputName);
    }

    var sourceKind = resolveColumnAccessor(sourceColumn);

    if (transform === 'timestampMs') {
      var values = new Float64Array(length);
      for (var rowIndex = 0; rowIndex < length; ++rowIndex) {
        values[rowIndex] = normalizeTimestampValue(sourceColumn == null ? undefined : getValueByKind(sourceColumn, rowIndex, sourceKind));
      }
      columns[outputName] = values;
    } else if (transform === 'number') {
      values = new Float64Array(length);
      for (rowIndex = 0; rowIndex < length; ++rowIndex) {
        values[rowIndex] = normalizeNumericValue(sourceColumn == null ? undefined : getValueByKind(sourceColumn, rowIndex, sourceKind));
      }
      columns[outputName] = values;
    } else if (transform === 'constantOne') {
      values = new Float64Array(length);
      values.fill(1);
      columns[outputName] = values;
    } else {
      columns[outputName] = sourceColumn;
    }
  }

  return {
    columns: columns,
    fields: projectedFields,
    length: length
  };
}
function buildLookupKey(columns, keyFields, rowIndex) {
  if (keyFields.length === 1) {
    var value = getValue(columns[keyFields[0]], rowIndex);
    return value == null ? '' : String(value);
  }
  var parts = new Array(keyFields.length);
  for (var fieldIndex = 0; fieldIndex < keyFields.length; ++fieldIndex) {
    var value = getValue(columns[keyFields[fieldIndex]], rowIndex);
    parts[fieldIndex] = value == null ? '' : String(value);
  }
  return parts.join('|');
}
function buildLookupKeyResolved(columns, keyFields, keyKinds, rowIndex) {
  if (keyFields.length === 1) {
    var col = columns[keyFields[0]];
    var value = col == null ? undefined : getValueByKind(col, rowIndex, keyKinds[0]);
    return value == null ? '' : String(value);
  }
  var parts = new Array(keyFields.length);
  for (var fieldIndex = 0; fieldIndex < keyFields.length; ++fieldIndex) {
    var col = columns[keyFields[fieldIndex]];
    var value = col == null ? undefined : getValueByKind(col, rowIndex, keyKinds[fieldIndex]);
    parts[fieldIndex] = value == null ? '' : String(value);
  }
  return parts.join('|');
}
function createSourceProgress(source) {
  return {
    batchesLoaded: 0,
    bytesLoaded: 0,
    response: null,
    rowsLoaded: 0,
    status: 'idle',
    totalBytes: null
  };
}
function cloneSourceProgressMap(sources) {
  var clone = {};
  for (var sourceId in sources) {
    var source = sources[sourceId];
    clone[sourceId] = {
      batchesLoaded: source.batchesLoaded,
      bytesLoaded: source.bytesLoaded,
      response: source.response ? Object.assign({}, source.response) : null,
      rowsLoaded: source.rowsLoaded,
      status: source.status,
      totalBytes: source.totalBytes
    };
  }
  return clone;
}
async function readResponseErrorDetail(response) {
  if (!response || typeof response.text !== 'function') {
    return null;
  }

  try {
    var text = await response.text();
    if (!text) {
      return null;
    }
    try {
      var parsed = JSON.parse(text);
      return parsed && (parsed.error || parsed.message) ? String(parsed.error || parsed.message) : text;
    } catch (_) {
      return text;
    }
  } catch (_) {
    return null;
  }
}
function releaseAbortControllers() {
  for (var controllerIndex = 0; controllerIndex < abortControllers.length; ++controllerIndex) {
    try {
      abortControllers[controllerIndex].abort();
    } catch (_) {}
  }
  abortControllers = [];
}
function ensureRuntimeFromColumns(batchSpec) {
  if (runtime) {
    return;
  }
  runtime = self.crossfilter.createDashboardRuntime({
    columnarOptions: {
      fields: batchSpec.fields,
      length: batchSpec.length
    },
    columns: batchSpec.columns,
    wasm: runtimeConfig.wasm,
    dimensions: runtimeConfig.dimensions,
    groups: runtimeConfig.groups,
    kpis: runtimeConfig.kpis
  });
  if (runtimeConfig.initialFilters) {
    runtime.updateFilters(runtimeConfig.initialFilters);
  }
}
function ensureEmptyRuntime() {
  if (runtime) {
    return;
  }
  runtime = self.crossfilter.createDashboardRuntime({
    records: [],
    wasm: runtimeConfig.wasm,
    dimensions: runtimeConfig.dimensions,
    groups: runtimeConfig.groups,
    kpis: runtimeConfig.kpis
  });
  if (runtimeConfig.initialFilters) {
    runtime.updateFilters(runtimeConfig.initialFilters);
  }
}
function progressPayload(status, extra) {
  var sources = progress && progress.sources ? progress.sources : {};
  var batchesLoaded = 0;
  var bytesLoaded = 0;
  var rowsLoaded = 0;
  var totalBytes = 0;
  var hasKnownTotals = true;
  var hasSources = false;
  var baseRuntimeInfo = self.crossfilter.runtimeInfo();
  var payload = {
    batchesLoaded: 0,
    bytesLoaded: 0,
    fetch: {
      bytesLoaded: 0,
      totalBytes: null,
      percent: null,
      complete: false
    },
    load: {
      batchesLoaded: 0,
      rowsLoaded: 0,
      complete: !!(progress && progress.ready)
    },
    rowsLoaded: 0,
    runtime: runtime ? runtime.runtimeInfo() : {
      active: 'js',
      lastError: baseRuntimeInfo.lastError,
      wasmEnabled: runtimeConfig ? runtimeConfig.wasm !== false : baseRuntimeInfo.wasmEnabled,
      wasmSupported: baseRuntimeInfo.wasmSupported
    },
    sources: cloneSourceProgressMap(sources),
    status: status,
    totalBytes: null
  };

  for (var sourceId in sources) {
    var source = sources[sourceId];
    hasSources = true;
    batchesLoaded += source.batchesLoaded || 0;
    bytesLoaded += source.bytesLoaded || 0;
    rowsLoaded += source.rowsLoaded || 0;
    if (source.totalBytes == null) {
      hasKnownTotals = false;
    } else {
      totalBytes += source.totalBytes;
    }
  }

  payload.batchesLoaded = batchesLoaded;
  payload.bytesLoaded = bytesLoaded;
  payload.rowsLoaded = rowsLoaded;
  payload.load = {
    batchesLoaded: batchesLoaded,
    rowsLoaded: rowsLoaded,
    complete: !!(progress && progress.ready)
  };
  payload.totalBytes = hasSources && hasKnownTotals ? totalBytes : null;
  payload.fetch = {
    bytesLoaded: bytesLoaded,
    totalBytes: payload.totalBytes,
    percent: payload.totalBytes > 0 ? Math.min(1, bytesLoaded / payload.totalBytes) : null,
    complete: status === 'ready' || status === 'aborted' || status === 'error' || (payload.totalBytes != null && bytesLoaded >= payload.totalBytes)
  };

  if (extra) {
    for (var key in extra) {
      payload[key] = extra[key];
    }
  }

  return payload;
}
function publishProgress(status, force, extra) {
  var now = Date.now();
  if (!force && progress && progress.progressThrottleMs > 0 && now - progressTimer < progress.progressThrottleMs) {
    return;
  }
  progressTimer = now;
  publish('progress', progressPayload(status, extra));
}
async function* responseChunks(sourceId, response) {
  var sourceProgress = progress.sources[sourceId];
  if (!response.body || typeof response.body.getReader !== 'function') {
    var buffer = await response.arrayBuffer();
    sourceProgress.bytesLoaded = buffer.byteLength;
    sourceProgress.status = 'downloading';
    publishProgress('downloading', true);
    yield new Uint8Array(buffer);
    return;
  }
  var reader = response.body.getReader();
  try {
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) {
        return;
      }
      var value = chunk.value;
      sourceProgress.bytesLoaded += value.byteLength || value.length || 0;
      sourceProgress.status = 'downloading';
      publishProgress('downloading', false);
      yield value;
    }
  } finally {
    if (reader.releaseLock) reader.releaseLock();
  }
}
async function getSourceInput(source) {
  var sourceProgress = progress.sources[source.id];
  if (source.dataUrl) {
    sourceProgress.status = 'requesting';
    publishProgress('starting', true);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var fetchInit = source.dataFetchInit || {};
    if (controller) {
      fetchInit = Object.assign({}, fetchInit, { signal: controller.signal });
      abortControllers.push(controller);
    }
    var response = await fetch(source.dataUrl, fetchInit);
    if (!response.ok) {
      var responseErrorDetail = await readResponseErrorDetail(response);
      throw new Error('Failed to fetch Arrow stream for ' + source.id + ': ' + response.status + ' ' + response.statusText + (responseErrorDetail ? ' — ' + responseErrorDetail : ''));
    }
    var headerValue = response.headers && response.headers.get ? response.headers.get('content-length') : null;
    sourceProgress.response = response.headers && response.headers.get ? {
      arrowFieldMapping: response.headers.get('x-synmetrix-arrow-field-mapping') || null,
      arrowFieldMappingEncoding: response.headers.get('x-synmetrix-arrow-field-mapping-encoding') || null,
      contentDisposition: response.headers.get('content-disposition') || null,
      contentType: response.headers.get('content-type') || null
    } : null;
    sourceProgress.totalBytes = headerValue == null ? null : Number(headerValue);
    sourceProgress.status = 'downloading';
    publishProgress('downloading', true);
    return responseChunks(source.id, response);
  }
  sourceProgress.totalBytes = source.arrowBuffer.byteLength || null;
  sourceProgress.bytesLoaded = sourceProgress.totalBytes || 0;
  sourceProgress.status = 'downloading';
  publishProgress('downloading', true);
  return new Uint8Array(source.arrowBuffer);
}
async function maybePublishSnapshot(force) {
  if (!progress || !progress.emitSnapshots || !runtime) {
    return;
  }
  var now = Date.now();
  if (!force && progress.snapshotThrottleMs > 0 && now - snapshotTimer < progress.snapshotThrottleMs) {
    return;
  }
  snapshotTimer = now;
  publish('snapshot', {
    progress: progressPayload(progress.ready ? 'ready' : 'streaming'),
    snapshot: runtime.snapshot(null, runtimeConfig && runtimeConfig.snapshotGroups ? { groups: runtimeConfig.snapshotGroups } : null)
  });
}
async function streamBaseSourceIntoRuntime(source) {
  var arrow = self.Arrow;
  var RecordBatchReader = getRecordBatchReader(arrow);
  var sourceProgress = progress.sources[source.id];
  var reader = await RecordBatchReader.from(await getSourceInput(source));
  var bufferedBatches = [];
  var bufferedRows = 0;

  for await (var batch of reader) {
    var projected = projectBatch(batch, source.projection);
    if (!runtime) {
      ensureRuntimeFromColumns(projected);
    } else {
      bufferedBatches.push(projected);
      bufferedRows += projected.length;
      if (bufferedRows >= runtimeConfig.batchCoalesceRows) {
        flushBufferedRuntimeBatches(bufferedBatches);
        bufferedRows = 0;
      }
    }
    sourceProgress.batchesLoaded += 1;
    sourceProgress.rowsLoaded += projected.length;
    sourceProgress.status = 'streaming';
    publishProgress('streaming', false);
    if (progress.emitSnapshots && bufferedBatches.length) {
      var shouldFlushForSnapshot = progress.snapshotThrottleMs <= 0 || Date.now() - snapshotTimer >= progress.snapshotThrottleMs;
      if (shouldFlushForSnapshot) {
        flushBufferedRuntimeBatches(bufferedBatches);
        bufferedRows = 0;
      }
    }
    await maybePublishSnapshot(false);
  }

  if (bufferedBatches.length) {
    flushBufferedRuntimeBatches(bufferedBatches);
  }

  sourceProgress.status = 'ready';
  publishProgress('streaming', true);
}
async function loadProjectedBatchesFromSource(source) {
  var arrow = self.Arrow;
  var RecordBatchReader = getRecordBatchReader(arrow);
  var sourceProgress = progress.sources[source.id];
  var reader = await RecordBatchReader.from(await getSourceInput(source));
  var batches = [];
  var fields = [];
  var rowCount = 0;

  for await (var batch of reader) {
    var projected = projectBatch(batch, source.projection);
    batches.push(projected);
    if (!fields.length) {
      fields = projected.fields.slice();
    }
    rowCount += projected.length;
    sourceProgress.batchesLoaded += 1;
    sourceProgress.rowsLoaded += projected.length;
    sourceProgress.status = 'streaming';
    publishProgress('streaming', false);
  }

  sourceProgress.status = 'ready';
  publishProgress('streaming', true);
  return {
    batches: batches,
    fields: fields,
    rowCount: rowCount,
    sourceId: source.id
  };
}
async function buildLookupIndexFromSource(source) {
  var arrow = self.Arrow;
  var RecordBatchReader = getRecordBatchReader(arrow);
  var sourceProgress = progress.sources[source.id];
  var reader = await RecordBatchReader.from(await getSourceInput(source));
  var index = new Map();
  var valueFields = source.lookup.valueFields.slice();
  var valueKinds = new Array(valueFields.length);

  for await (var batch of reader) {
    var projected = projectBatch(batch, source.projection);
    var keyKinds = new Array(source.lookup.keyFields.length);
    for (var ki = 0; ki < source.lookup.keyFields.length; ++ki) {
      keyKinds[ki] = resolveColumnAccessor(projected.columns[source.lookup.keyFields[ki]]);
    }
    var valKinds = new Array(valueFields.length);
    for (var vi = 0; vi < valueFields.length; ++vi) {
      valKinds[vi] = resolveColumnAccessor(projected.columns[valueFields[vi]]);
    }

    for (var rowIndex = 0; rowIndex < projected.length; ++rowIndex) {
      var key = buildLookupKeyResolved(projected.columns, source.lookup.keyFields, keyKinds, rowIndex);
      if (index.has(key)) {
        continue;
      }
      var values = new Array(valueFields.length);
      for (var valueIndex = 0; valueIndex < valueFields.length; ++valueIndex) {
        var valCol = projected.columns[valueFields[valueIndex]];
        var fieldValue = valCol == null ? undefined : getValueByKind(valCol, rowIndex, valKinds[valueIndex]);
        values[valueIndex] = fieldValue;
        if (valueKinds[valueIndex] !== 'generic' && typeof fieldValue === 'number' && Number.isFinite(fieldValue)) {
          valueKinds[valueIndex] = 'number';
        } else if (fieldValue != null && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))) {
          valueKinds[valueIndex] = 'generic';
        }
      }
      index.set(key, values);
    }

    sourceProgress.batchesLoaded += 1;
    sourceProgress.rowsLoaded += projected.length;
    sourceProgress.status = 'streaming';
    publishProgress('streaming', false);
  }

  sourceProgress.status = 'ready';
  publishProgress('streaming', true);
  return {
    id: source.id,
    index: index,
    keyFields: source.lookup.keyFields.slice(),
    valueFields: valueFields,
    valueKinds: valueKinds.map(function(kind) {
      return kind === 'number' ? 'number' : 'generic';
    })
  };
}
function allocateLookupColumn(length, kind) {
  if (kind === 'number') {
    var numeric = new Float64Array(length);
    numeric.fill(NaN);
    return numeric;
  }
  return new Array(length);
}
function applyLookupIndexes(baseBatches, lookupResults) {
  for (var batchIndex = 0; batchIndex < baseBatches.length; ++batchIndex) {
    var batch = baseBatches[batchIndex];

    for (var lookupIndex = 0; lookupIndex < lookupResults.length; ++lookupIndex) {
      var lookup = lookupResults[lookupIndex];
      var columnsByField = {};

      for (var valueFieldIndex = 0; valueFieldIndex < lookup.valueFields.length; ++valueFieldIndex) {
        var valueField = lookup.valueFields[valueFieldIndex];
        columnsByField[valueField] = allocateLookupColumn(batch.length, lookup.valueKinds[valueFieldIndex]);
        if (batch.fields.indexOf(valueField) < 0) {
          batch.fields.push(valueField);
        }
      }

      var lookupKeyKinds = new Array(lookup.keyFields.length);
      for (var ki = 0; ki < lookup.keyFields.length; ++ki) {
        lookupKeyKinds[ki] = resolveColumnAccessor(batch.columns[lookup.keyFields[ki]]);
      }

      for (var rowIndex = 0; rowIndex < batch.length; ++rowIndex) {
        var values = lookup.index.get(buildLookupKeyResolved(batch.columns, lookup.keyFields, lookupKeyKinds, rowIndex));
        if (!values) {
          continue;
        }
        for (var fieldIndex = 0; fieldIndex < lookup.valueFields.length; ++fieldIndex) {
          columnsByField[lookup.valueFields[fieldIndex]][rowIndex] = values[fieldIndex];
        }
      }

      for (fieldIndex = 0; fieldIndex < lookup.valueFields.length; ++fieldIndex) {
        batch.columns[lookup.valueFields[fieldIndex]] = columnsByField[lookup.valueFields[fieldIndex]];
      }
    }
  }
}
function buildRuntimeFromBatches(batches) {
  if (!batches.length) {
    ensureEmptyRuntime();
    return;
  }

  ensureRuntimeFromColumns(batches[0]);
  if (batches.length === 1) {
    return;
  }

  var bufferedBatches = [];
  var bufferedRows = 0;

  for (var batchIndex = 1; batchIndex < batches.length; ++batchIndex) {
    bufferedBatches.push(batches[batchIndex]);
    bufferedRows += batches[batchIndex].length;
    if (bufferedRows >= runtimeConfig.batchCoalesceRows) {
      flushBufferedRuntimeBatches(bufferedBatches);
      bufferedRows = 0;
    }
  }

  if (bufferedBatches.length) {
    flushBufferedRuntimeBatches(bufferedBatches);
  }
}
async function startStreaming(payload) {
  var arrow = self.Arrow;
  var RecordBatchReader = getRecordBatchReader(arrow);
  if (!RecordBatchReader || !RecordBatchReader.from) {
    throw new Error('Apache Arrow RecordBatchReader is not available in the worker.');
  }

  var sources = payload.sources && payload.sources.length
    ? payload.sources.slice()
    : [{
        arrowBuffer: payload.arrowBuffer || null,
        dataFetchInit: payload.dataFetchInit || null,
        dataUrl: payload.dataUrl || null,
        id: 'source_0',
        lookup: null,
        projection: null,
        role: 'base'
      }];

  progress = {
    emitSnapshots: payload.emitSnapshots === true,
    progressThrottleMs: typeof payload.progressThrottleMs === 'number' ? payload.progressThrottleMs : 100,
    ready: false,
    snapshotThrottleMs: typeof payload.snapshotThrottleMs === 'number' ? payload.snapshotThrottleMs : 250,
    sources: {}
  };

  progressTimer = 0;
  snapshotTimer = 0;
  abortControllers = [];

  for (var sourceIndex = 0; sourceIndex < sources.length; ++sourceIndex) {
    progress.sources[sources[sourceIndex].id] = createSourceProgress(sources[sourceIndex]);
  }

  publishProgress('starting', true);

  try {
    if (sources.length === 1 && sources[0].role === 'base') {
      await streamBaseSourceIntoRuntime(sources[0]);
    } else {
      var baseSource = null;
      var lookupSources = [];

      for (sourceIndex = 0; sourceIndex < sources.length; ++sourceIndex) {
        if (sources[sourceIndex].role === 'base') {
          baseSource = sources[sourceIndex];
        } else {
          lookupSources.push(sources[sourceIndex]);
        }
      }

      var results = await Promise.all([loadProjectedBatchesFromSource(baseSource)].concat(lookupSources.map(function(source) {
        return buildLookupIndexFromSource(source);
      })));
      var baseResult = results[0];
      var lookupResults = results.slice(1);

      publishProgress('joining', true);
      applyLookupIndexes(baseResult.batches, lookupResults);
      publishProgress('building', true);
      buildRuntimeFromBatches(baseResult.batches);
    }

    ensureEmptyRuntime();
    progress.ready = true;
    publishProgress('ready', true);
    await maybePublishSnapshot(true);
    publish('ready', progressPayload('ready'));
  } catch (error) {
    if (error && error.name === 'AbortError') {
      publishProgress('aborted', true);
      return;
    }
    publish('error', Object.assign(progressPayload('error'), {
      message: String(error && error.message || error),
      stack: error && error.stack ? String(error.stack) : null
    }));
  }
}
self.onmessage = async function(event) {
  var message = event.data || {};
  var id = message.id;
  try {
    if (message.type !== 'initStreaming' && message.type !== 'dispose') {
      if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
    }
    switch (message.type) {
      case 'initStreaming': {
        runtimeConfig = {
          batchCoalesceRows: typeof message.payload.batchCoalesceRows === 'number' && message.payload.batchCoalesceRows > 0
            ? Math.floor(message.payload.batchCoalesceRows)
            : 65536,
          wasm: message.payload.wasm,
          dimensions: message.payload.dimensions,
          groups: message.payload.groups,
          kpis: message.payload.kpis,
          initialFilters: message.payload.initialFilters || null,
          snapshotGroups: message.payload.snapshotGroups || null
        };
        runtime = null;
        startStreaming(message.payload);
        respond(id, { runtime: null });
        return;
      }
      case 'snapshot':
        respond(id, runtime.snapshot(message.payload.filters, message.payload.options || null));
        return;
      case 'groups':
        respond(id, runtime.groups(message.payload.request));
        return;
      case 'bounds':
        respond(id, runtime.bounds(message.payload.request));
        return;
      case 'query':
        respond(id, runtime.query(message.payload.request));
        return;
      case 'append':
        respond(id, runtime.append(message.payload.records || []));
        return;
      case 'updateFilters':
        respond(id, runtime.updateFilters(message.payload.filters));
        return;
      case 'createGroup':
        respond(id, runtime.createGroup(message.payload.spec));
        return;
      case 'disposeGroup':
        respond(id, runtime.disposeGroup(message.payload.id));
        return;
      case 'rows':
        respond(id, runtime.rows(message.payload.query));
        return;
      case 'rowSets':
        respond(id, runtime.rowSets(message.payload.request));
        return;
      case 'removeFiltered':
        respond(id, runtime.removeFiltered(message.payload.selection));
        return;
      case 'reset':
        respond(id, runtime.reset());
        return;
      case 'runtimeInfo':
        respond(id, runtime.runtimeInfo());
        return;
      case 'dispose':
        releaseAbortControllers();
        if (runtime) {
          runtime.dispose();
          runtime = null;
        }
        runtimeConfig = null;
        respond(id, null);
        self.close();
        return;
      default:
        throw new Error('Unknown streaming dashboard worker message: ' + message.type);
    }
  } catch (error) {
    fail(id, error);
  }
};
`;
}

export function createStreamingDashboardWorker(options) {
  options = options || {};

  var hasSources = Array.isArray(options.sources) && options.sources.length > 0;
  var modeCount = (options.arrowBuffer ? 1 : 0) + (options.dataUrl ? 1 : 0) + (hasSources ? 1 : 0);

  if (modeCount !== 1) {
    throw new Error("createStreamingDashboardWorker expects exactly one of `arrowBuffer`, `dataUrl` or `sources`.");
  }

  var workerFactory = options.workerFactory,
      workerUrl = null;

  if (!workerFactory) {
    if (typeof Worker === "undefined") {
      throw new Error("Workers are not available in this environment.");
    }
    if (!options.crossfilterUrl || !(options.arrowRuntimeUrl || options.arrowUrl)) {
      throw new Error("createStreamingDashboardWorker requires `crossfilterUrl` and `arrowRuntimeUrl` unless `workerFactory` is provided.");
    }

    var resolvedCrossfilterUrl = resolveAssetUrl(options.crossfilterUrl),
        resolvedArrowUrl = resolveAssetUrl(options.arrowRuntimeUrl || options.arrowUrl);

    workerFactory = function() {
      workerUrl = URL.createObjectURL(new Blob([
        createWorkerSource(resolvedCrossfilterUrl, resolvedArrowUrl)
      ], { type: "text/javascript" }));
      return new Worker(workerUrl);
    };
  }

  var worker = workerFactory();
  var nextId = 1;
  var pending = new Map();
  var listeners = {
    error: new Set(),
    progress: new Set(),
    ready: new Set(),
    snapshot: new Set()
  };
  var disposed = false;
  var readyResolve;
  var readyReject;
  var ready = new Promise(function(resolve, reject) {
    readyResolve = resolve;
    readyReject = reject;
  });

  function cleanupWorker() {
    if (workerUrl) {
      URL.revokeObjectURL(workerUrl);
      workerUrl = null;
    }
  }

  function rejectPending(error) {
    pending.forEach(function(entry) {
      entry.reject(error);
    });
    pending.clear();
  }

  function emit(eventType, payload) {
    listeners[eventType].forEach(function(listener) {
      listener(payload);
    });
  }

  function call(type, payload, transfer) {
    if (disposed) {
      return Promise.reject(new Error("Streaming dashboard worker has already been disposed."));
    }

    var id = nextId++;
    return new Promise(function(resolve, reject) {
      pending.set(id, { resolve: resolve, reject: reject });
      worker.postMessage({
        id: id,
        payload: payload || null,
        type: type
      }, transfer || []);
    });
  }

  worker.addEventListener("message", function(event) {
    var message = event.data || {};

    if (message.eventType) {
      emit(message.eventType, message.payload);
      if (message.eventType === "ready") {
        readyResolve(message.payload);
      } else if (message.eventType === "error") {
        readyReject(new Error(message.payload && message.payload.message || "Streaming dashboard worker failed."));
      }
      return;
    }

    var entry = pending.get(message.id);
    if (!entry) {
      return;
    }

    pending.delete(message.id);

    if (message.ok) {
      entry.resolve(message.payload);
      return;
    }

    var error = new Error(message.error && message.error.message || "Streaming dashboard worker request failed.");
    if (message.error && message.error.stack) {
      error.stack = message.error.stack;
    }
    entry.reject(error);
  });

  worker.addEventListener("error", function(event) {
    var error = event.error || new Error(event.message || "Streaming dashboard worker failed.");
    rejectPending(error);
    readyReject(error);
    cleanupWorker();
  });

  var transfer = [];
  var sources = resolveStreamingSources(options, transfer);
  var payload = {
    dataFetchInit: options.dataFetchInit || null,
    dataUrl: sources ? null : options.dataUrl ? resolveAssetUrl(options.dataUrl) : null,
    dimensions: options.dimensions || [],
    emitSnapshots: options.emitSnapshots === true,
    groups: options.groups || [],
    initialFilters: options.initialFilters || null,
    kpis: options.kpis || [],
    progressThrottleMs: options.progressThrottleMs,
    snapshotGroups: options.snapshotGroups || null,
    snapshotThrottleMs: options.snapshotThrottleMs,
    sources: sources,
    batchCoalesceRows: options.batchCoalesceRows,
    wasm: options.wasm !== false
  };

  if (!sources && options.arrowBuffer) {
    payload.arrowBuffer = resolveArrowBuffer(options.arrowBuffer);
    transfer.push(payload.arrowBuffer);
  }

  return call("initStreaming", payload, transfer).then(function(initPayload) {
    return {
      append: function(records) {
        return call('append', { records: records || [] });
      },
      bounds: function(request) {
        return call("bounds", { request: request || null });
      },
      dispose: function() {
        if (disposed) {
          return Promise.resolve();
        }
        return call("dispose").catch(function(error) {
          worker.terminate();
          cleanupWorker();
          throw error;
        }).finally(function() {
          disposed = true;
          worker.terminate();
          cleanupWorker();
        });
      },
      on: function(eventType, listener) {
        if (!listeners[eventType]) {
          throw new Error("Unsupported streaming dashboard event: " + eventType);
        }
        listeners[eventType].add(listener);
        return function() {
          listeners[eventType].delete(listener);
        };
      },
      ready: ready,
      query: function(request) {
        return call('query', { request: request || null });
      },
      groups: function(request) {
        return call("groups", { request: request || null });
      },
      removeFiltered: function(selection) {
        return call('removeFiltered', { selection: selection || 'included' });
      },
      reset: function() {
        return call("reset");
      },
      runtimeInfo: function() {
        return call("runtimeInfo");
      },
      snapshot: function(filters, options) {
        return call("snapshot", {
          filters: filters || null,
          options: options || null
        });
      },
      rows: function(query) {
        return call("rows", { query: query || null });
      },
      rowSets: function(request) {
        return call("rowSets", { request: request || null });
      },
      updateFilters: function(filters) {
        return call("updateFilters", { filters: filters || null });
      },
      createGroup: function(spec) {
        return call("createGroup", { spec: spec });
      },
      disposeGroup: function(groupId) {
        return call("disposeGroup", { id: groupId });
      },
      workerRuntime: initPayload.runtime
    };
  }).catch(function(error) {
    disposed = true;
    worker.terminate();
    cleanupWorker();
    throw error;
  });
}
