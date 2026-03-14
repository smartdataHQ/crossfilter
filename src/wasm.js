var defaultRuntimeOptions = {
  wasm: true
};

var sharedRuntimeState = {
  error: null,
  runtime: null,
  supported: typeof WebAssembly !== 'undefined'
    && typeof WebAssembly.Module === 'function'
    && typeof WebAssembly.Instance === 'function'
};

var SMALL_TARGET_WASM_THRESHOLD = 4;
var MAX_WASM_MARK_BYTES = 32 * 1024 * 1024;

function arraysEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function encodeU32(value) {
  var bytes = [];
  do {
    var byte = value & 0x7f;
    value >>>= 7;
    if (value) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (value);
  return bytes;
}

function encodeString(value) {
  var bytes = [];
  for (var i = 0; i < value.length; ++i) {
    bytes.push(value.charCodeAt(i));
  }
  return encodeU32(bytes.length).concat(bytes);
}

function encodeSection(id, payload) {
  return [id].concat(encodeU32(payload.length), payload);
}

function createFilterModuleBytes() {
  var typeSection = encodeSection(1, [].concat(
    encodeU32(2),
    [0x60],
    encodeU32(5),
    [0x7f, 0x7f, 0x7f, 0x7f, 0x7f],
    encodeU32(1),
    [0x7f],
    [0x60],
    encodeU32(6),
    [0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f],
    encodeU32(1),
    [0x7f]
  ));
  var functionSection = encodeSection(3, [].concat(encodeU32(2), encodeU32(0), encodeU32(1)));
  var memorySection = encodeSection(5, [].concat(encodeU32(1), [0x00], encodeU32(1)));
  var exportSection = encodeSection(7, [].concat(
    encodeU32(3),
    encodeString('memory'),
    [0x02],
    encodeU32(0),
    encodeString('filterInU32'),
    [0x00],
    encodeU32(0),
    encodeString('markFilterInU32'),
    [0x00],
    encodeU32(1)
  ));
  var filterSmallBody = [].concat(
    encodeU32(1),
    encodeU32(4),
    [0x7f],
    [0x41, 0x00, 0x21, 0x05],
    [0x41, 0x00, 0x21, 0x06],
    [0x02, 0x40],
    [0x03, 0x40],
    [0x20, 0x05, 0x20, 0x01, 0x49, 0x45, 0x0d, 0x01],
    [0x20, 0x00, 0x20, 0x05, 0x41, 0x04, 0x6c, 0x6a, 0x28, 0x02, 0x00, 0x21, 0x07],
    [0x41, 0x00, 0x21, 0x08],
    [0x02, 0x40],
    [0x03, 0x40],
    [0x20, 0x08, 0x20, 0x03, 0x49, 0x45, 0x0d, 0x01],
    [0x20, 0x07],
    [0x20, 0x02, 0x20, 0x08, 0x41, 0x04, 0x6c, 0x6a, 0x28, 0x02, 0x00],
    [0x46],
    [0x04, 0x40],
    [0x20, 0x04, 0x20, 0x06, 0x41, 0x04, 0x6c, 0x6a],
    [0x20, 0x05],
    [0x36, 0x02, 0x00],
    [0x20, 0x06, 0x41, 0x01, 0x6a, 0x21, 0x06],
    [0x0c, 0x02],
    [0x0b],
    [0x20, 0x08, 0x41, 0x01, 0x6a, 0x21, 0x08],
    [0x0c, 0x00],
    [0x0b],
    [0x0b],
    [0x20, 0x05, 0x41, 0x01, 0x6a, 0x21, 0x05],
    [0x0c, 0x00],
    [0x0b],
    [0x0b],
    [0x20, 0x06],
    [0x0b]
  );
  var filterMarkedBody = [].concat(
    encodeU32(1),
    encodeU32(3),
    [0x7f],
    [0x41, 0x00, 0x21, 0x06],
    [0x41, 0x00, 0x21, 0x07],
    [0x02, 0x40],
    [0x03, 0x40],
    [0x20, 0x07, 0x20, 0x03, 0x49, 0x45, 0x0d, 0x01],
    [0x20, 0x02, 0x20, 0x07, 0x41, 0x04, 0x6c, 0x6a, 0x28, 0x02, 0x00, 0x21, 0x08],
    [0x20, 0x04, 0x20, 0x08, 0x41, 0x04, 0x6c, 0x6a, 0x41, 0x01, 0x36, 0x02, 0x00],
    [0x20, 0x07, 0x41, 0x01, 0x6a, 0x21, 0x07],
    [0x0c, 0x00],
    [0x0b],
    [0x0b],
    [0x41, 0x00, 0x21, 0x07],
    [0x02, 0x40],
    [0x03, 0x40],
    [0x20, 0x07, 0x20, 0x01, 0x49, 0x45, 0x0d, 0x01],
    [0x20, 0x00, 0x20, 0x07, 0x41, 0x04, 0x6c, 0x6a, 0x28, 0x02, 0x00, 0x21, 0x08],
    [0x20, 0x04, 0x20, 0x08, 0x41, 0x04, 0x6c, 0x6a, 0x28, 0x02, 0x00, 0x41, 0x00, 0x47],
    [0x04, 0x40],
    [0x20, 0x05, 0x20, 0x06, 0x41, 0x04, 0x6c, 0x6a, 0x20, 0x07, 0x36, 0x02, 0x00],
    [0x20, 0x06, 0x41, 0x01, 0x6a, 0x21, 0x06],
    [0x0b],
    [0x20, 0x07, 0x41, 0x01, 0x6a, 0x21, 0x07],
    [0x0c, 0x00],
    [0x0b],
    [0x0b],
    [0x41, 0x00, 0x21, 0x07],
    [0x02, 0x40],
    [0x03, 0x40],
    [0x20, 0x07, 0x20, 0x03, 0x49, 0x45, 0x0d, 0x01],
    [0x20, 0x02, 0x20, 0x07, 0x41, 0x04, 0x6c, 0x6a, 0x28, 0x02, 0x00, 0x21, 0x08],
    [0x20, 0x04, 0x20, 0x08, 0x41, 0x04, 0x6c, 0x6a, 0x41, 0x00, 0x36, 0x02, 0x00],
    [0x20, 0x07, 0x41, 0x01, 0x6a, 0x21, 0x07],
    [0x0c, 0x00],
    [0x0b],
    [0x0b],
    [0x20, 0x06],
    [0x0b]
  );
  var codeSection = encodeSection(10, [].concat(
    encodeU32(2),
    encodeU32(filterSmallBody.length),
    filterSmallBody,
    encodeU32(filterMarkedBody.length),
    filterMarkedBody
  ));

  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00].concat(
    typeSection,
    functionSection,
    memorySection,
    exportSection,
    codeSection
  ));
}

function buildRuntime() {
  var module = new WebAssembly.Module(createFilterModuleBytes());
  var instance = new WebAssembly.Instance(module, {});

  return {
    cachedCodes: null,
    cachedCodesLength: 0,
    cachedTargets: null,
    cachedTargetsLength: 0,
    cachedTargetsOffset: 0,
    filterInU32: instance.exports.filterInU32,
    markFilterInU32: instance.exports.markFilterInU32,
    memory: instance.exports.memory,
    ensureCapacity: function(totalBytes) {
      var pagesNeeded = Math.ceil(totalBytes / 65536);
      var currentPages = this.memory.buffer.byteLength / 65536;

      if (pagesNeeded > currentPages) {
        this.memory.grow(pagesNeeded - currentPages);
        this.cachedCodes = null;
        this.cachedCodesLength = 0;
        this.cachedTargets = null;
        this.cachedTargetsLength = 0;
        this.cachedTargetsOffset = 0;
      }

      return this.memory.buffer;
    },
    syncCodes: function(buffer, codes) {
      if (this.cachedCodes === codes && this.cachedCodesLength === codes.length) {
        return;
      }
      new Uint32Array(buffer, 0, codes.length).set(codes);
      this.cachedCodes = codes;
      this.cachedCodesLength = codes.length;
    },
    syncTargets: function(buffer, targetCodes, offset) {
      if (arraysEqual(this.cachedTargets, targetCodes)
          && this.cachedTargetsOffset === offset) {
        return;
      }
      new Uint32Array(buffer, offset, targetCodes.length).set(targetCodes);
      this.cachedTargets = targetCodes.slice ? targetCodes.slice() : Array.prototype.slice.call(targetCodes);
      this.cachedTargetsLength = targetCodes.length;
      this.cachedTargetsOffset = offset;
    },
    matchSmall: function(codes, targetCodes) {
      var dataBytes = codes.length * 4;
      var targetBytes = targetCodes.length * 4;
      var outPtr = dataBytes + targetBytes;
      var totalBytes = outPtr + dataBytes;
      var buffer = this.ensureCapacity(totalBytes);

      this.syncCodes(buffer, codes);
      this.syncTargets(buffer, targetCodes, dataBytes);

      var count = this.filterInU32(0, codes.length, dataBytes, targetCodes.length, outPtr);
      // SAFETY: returned view is only valid until next matchSmall/matchMarked call
      return new Uint32Array(buffer, outPtr, count);
    },
    matchMarked: function(codes, targetCodes, maxTargetCode) {
      var dataBytes = codes.length * 4;
      var targetBytes = targetCodes.length * 4;
      var marksBytes = (maxTargetCode + 1) * 4;
      var markPtr = dataBytes + targetBytes;
      var outPtr = markPtr + marksBytes;
      var totalBytes = outPtr + dataBytes;
      var buffer = this.ensureCapacity(totalBytes);

      this.syncCodes(buffer, codes);
      this.syncTargets(buffer, targetCodes, dataBytes);

      var count = this.markFilterInU32(0, codes.length, dataBytes, targetCodes.length, markPtr, outPtr);
      // SAFETY: returned view is only valid until next matchSmall/matchMarked call
      return new Uint32Array(buffer, outPtr, count);
    }
  };
}

function getSharedRuntime(enabled) {
  if (!sharedRuntimeState.supported || !enabled) {
    return null;
  }

  if (!sharedRuntimeState.runtime) {
    try {
      sharedRuntimeState.runtime = buildRuntime();
      sharedRuntimeState.error = null;
    } catch (error) {
      sharedRuntimeState.error = error;
      sharedRuntimeState.runtime = null;
    }
  }

  return sharedRuntimeState.runtime;
}

function currentRuntimeInfo(enabled) {
  return {
    active: sharedRuntimeState.runtime && enabled ? 'wasm' : 'js',
    lastError: sharedRuntimeState.error ? String(sharedRuntimeState.error.message || sharedRuntimeState.error) : null,
    wasmEnabled: enabled !== false,
    wasmSupported: sharedRuntimeState.supported
  };
}

function ensureDenseLookupCapacity(state, size) {
  if (state.marks.length >= size) {
    return;
  }

  var nextSize = state.marks.length || 16;
  while (nextSize < size) {
    nextSize <<= 1;
  }

  var nextMarks = new Uint32Array(nextSize);
  nextMarks.set(state.marks);
  state.marks = nextMarks;
}

function denseLookupMatches(codes, targetCodes, state) {
  var matches = new Uint32Array(codes.length);
  var count = 0;
  var i;

  if (targetCodes.length === 1) {
    var targetCode = targetCodes[0];
    for (i = 0; i < codes.length; ++i) {
      if (codes[i] === targetCode) {
        matches[count++] = i;
      }
    }
    return matches.slice(0, count);
  }

  var maxTargetCode = 0;
  for (i = 0; i < targetCodes.length; ++i) {
    if (targetCodes[i] > maxTargetCode) {
      maxTargetCode = targetCodes[i];
    }
  }

  ensureDenseLookupCapacity(state, maxTargetCode + 1);
  if (state.version === 0xffffffff) {
    state.marks.fill(0);
    state.version = 1;
  }

  var version = state.version++;
  var marks = state.marks;

  for (i = 0; i < targetCodes.length; ++i) {
    marks[targetCodes[i]] = version;
  }

  for (i = 0; i < codes.length; ++i) {
    if (marks[codes[i]] === version) {
      matches[count++] = i;
    }
  }

  return matches.slice(0, count);
}

function maxCodeValue(values) {
  var maxValue = 0;
  for (var valueIndex = 0; valueIndex < values.length; ++valueIndex) {
    if (values[valueIndex] > maxValue) {
      maxValue = values[valueIndex];
    }
  }
  return maxValue;
}

export function createWasmRuntimeController(options) {
  var enabled = options && Object.prototype.hasOwnProperty.call(options, 'wasm')
    ? options.wasm !== false
    : defaultRuntimeOptions.wasm !== false;
  var denseLookupState = {
    marks: new Uint32Array(0),
    version: 1
  };

  function configureRuntime(nextOptions) {
    if (nextOptions && Object.prototype.hasOwnProperty.call(nextOptions, 'wasm')) {
      enabled = nextOptions.wasm !== false;
    }
    return currentRuntimeInfo(enabled);
  }

  function runtimeInfo() {
    return currentRuntimeInfo(enabled);
  }

  function canUseWasmScan() {
    return !!getSharedRuntime(enabled);
  }

  function findMatches(codes, targetCodes) {
    if (!targetCodes.length) {
      return new Uint32Array(0);
    }

    var runtime = getSharedRuntime(enabled);
    var maxTargetCode;
    if (runtime && targetCodes.length <= SMALL_TARGET_WASM_THRESHOLD) {
      try {
        return runtime.matchSmall(codes, targetCodes);
      } catch (error) {
        sharedRuntimeState.error = error;
        sharedRuntimeState.runtime = null;
      }
    }

    if (runtime) {
      maxTargetCode = maxCodeValue(targetCodes);
      if ((maxTargetCode + 1) * 4 <= MAX_WASM_MARK_BYTES) {
        try {
          return runtime.matchMarked(codes, targetCodes, maxTargetCode);
        } catch (error) {
          sharedRuntimeState.error = error;
          sharedRuntimeState.runtime = null;
        }
      }
    }

    return denseLookupMatches(codes, targetCodes, denseLookupState);
  }

  return {
    canUseWasmScan: canUseWasmScan,
    configureRuntime: configureRuntime,
    findEncodedMatches: findMatches,
    runtimeInfo: runtimeInfo
  };
}

var defaultRuntimeController = createWasmRuntimeController();

export function configureWasmRuntime(options) {
  if (options && Object.prototype.hasOwnProperty.call(options, 'wasm')) {
    defaultRuntimeOptions.wasm = options.wasm !== false;
  }
  return defaultRuntimeController.configureRuntime(options);
}

export function getWasmRuntimeInfo() {
  return defaultRuntimeController.runtimeInfo();
}

export function canUseWasmScan() {
  return defaultRuntimeController.canUseWasmScan();
}

export function findEncodedMatches(codes, targetCodes) {
  return defaultRuntimeController.findEncodedMatches(codes, targetCodes);
}

export { denseLookupMatches as _denseLookupMatches };
