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

  throw new Error("createDashboardWorker expects `arrowBuffer` to be an ArrayBuffer or typed array view.");
}

function resolveAssetUrl(url) {
  if (typeof URL === "function" && typeof location !== "undefined" && location && location.href) {
    return new URL(url, location.href).toString();
  }
  return url;
}

function createWorkerSource(crossfilterUrl, arrowUrl) {
  return [
    "'use strict';",
    "importScripts(" + JSON.stringify(crossfilterUrl) + ", " + JSON.stringify(arrowUrl) + ");",
    "var runtime = null;",
    "function getTableFromIPC(module) {",
    "  return module && (module.tableFromIPC || (module.default && module.default.tableFromIPC)) || null;",
    "}",
    "function collectRowTransferables(obj) {",
    "  var buffers = [];",
    "  if (!obj || typeof obj !== 'object' || !obj.columns) return buffers;",
    "  for (var field in obj.columns) {",
    "    if (Object.prototype.hasOwnProperty.call(obj.columns, field)) {",
    "      var col = obj.columns[field];",
    "      if (ArrayBuffer.isView(col) && col.buffer) buffers.push(col.buffer);",
    "    }",
    "  }",
    "  return buffers;",
    "}",
    "function collectResponseTransferables(payload) {",
    "  if (!payload || typeof payload !== 'object') return [];",
    "  var seen = [];",
    "  var buffers = [];",
    "  function add(obj) {",
    "    var found = collectRowTransferables(obj);",
    "    for (var i = 0; i < found.length; ++i) {",
    "      if (seen.indexOf(found[i]) < 0) {",
    "        seen.push(found[i]);",
    "        buffers.push(found[i]);",
    "      }",
    "    }",
    "  }",
    "  add(payload);",
    "  if (payload.rows) add(payload.rows);",
    "  if (payload.rowSets) {",
    "    for (var setId in payload.rowSets) {",
    "      if (Object.prototype.hasOwnProperty.call(payload.rowSets, setId)) {",
    "        add(payload.rowSets[setId]);",
    "      }",
    "    }",
    "  }",
    "  return buffers;",
    "}",
    "function respond(id, payload) {",
    "  var transferables = collectResponseTransferables(payload);",
    "  self.postMessage({ id: id, ok: true, payload: payload }, transferables);",
    "}",
    "function fail(id, error) {",
    "  self.postMessage({ id: id, ok: false, error: {",
    "    message: String(error && error.message || error),",
    "    stack: error && error.stack ? String(error.stack) : null",
    "  } });",
    "}",
    "self.onmessage = async function(event) {",
    "  var message = event.data || {};",
    "  var id = message.id;",
    "  try {",
    "    switch (message.type) {",
    "      case 'init': {",
    "        var arrow = self.Arrow;",
    "        var tableFromIPC = getTableFromIPC(arrow);",
    "        if (!tableFromIPC) {",
    "          throw new Error('Apache Arrow tableFromIPC is not available in the worker.');",
    "        }",
    "        var tableSource = null;",
    "        if (message.payload.dataUrl) {",
    "          tableSource = fetch(message.payload.dataUrl, message.payload.dataFetchInit || undefined);",
    "        } else if (message.payload.arrowBuffer) {",
    "          tableSource = new Uint8Array(message.payload.arrowBuffer);",
    "        } else {",
    "          throw new Error('Dashboard worker init requires `dataUrl` or `arrowBuffer`.');",
    "        }",
    "        var table = await tableFromIPC(tableSource);",
    "        runtime = self.crossfilter.createDashboardRuntime({",
    "          table: table,",
    "          wasm: message.payload.wasm,",
    "          dimensions: message.payload.dimensions,",
    "          groups: message.payload.groups,",
    "          kpis: message.payload.kpis",
    "        });",
    "        respond(id, { runtime: runtime.runtimeInfo() });",
    "        return;",
    "      }",
    "      case 'snapshot':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.snapshot(message.payload.filters, message.payload.options || null));",
    "        return;",
    "      case 'groups':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.groups(message.payload.request));",
    "        return;",
    "      case 'bounds':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.bounds(message.payload.request));",
    "        return;",
    "      case 'query':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.query(message.payload.request));",
    "        return;",
    "      case 'rows':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.rows(message.payload.query));",
    "        return;",
    "      case 'rowSets':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.rowSets(message.payload.request));",
    "        return;",
    "      case 'append':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.append(message.payload.records || []));",
    "        return;",
    "      case 'removeFiltered':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.removeFiltered(message.payload.selection));",
    "        return;",
    "      case 'updateFilters':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.updateFilters(message.payload.filters));",
    "        return;",
    "      case 'reset':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.reset());",
    "        return;",
    "      case 'runtimeInfo':",
    "        if (!runtime) {",
    "          throw new Error('Dashboard worker is not initialized.');",
    "        }",
    "        respond(id, runtime.runtimeInfo());",
    "        return;",
    "      case 'dispose':",
    "        if (runtime) {",
    "          runtime.dispose();",
    "          runtime = null;",
    "        }",
    "        respond(id, null);",
    "        self.close();",
    "        return;",
    "      default:",
    "        throw new Error('Unknown dashboard worker message: ' + message.type);",
    "    }",
    "  } catch (error) {",
    "    fail(id, error);",
    "  }",
    "};"
  ].join("\n");
}

export function createDashboardWorker(options) {
  options = options || {};

  if (!!options.arrowBuffer === !!options.dataUrl) {
    throw new Error("createDashboardWorker expects exactly one of `arrowBuffer` or `dataUrl`.");
  }

  var workerFactory = options.workerFactory,
      workerUrl = null;

  if (!workerFactory) {
    if (typeof Worker === "undefined") {
      throw new Error("Workers are not available in this environment.");
    }
    if (!options.crossfilterUrl || !(options.arrowRuntimeUrl || options.arrowUrl)) {
      throw new Error("createDashboardWorker requires `crossfilterUrl` and `arrowRuntimeUrl` unless `workerFactory` is provided.");
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
  var disposed = false;

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

  function call(type, payload, transfer) {
    if (disposed) {
      return Promise.reject(new Error("Dashboard worker has already been disposed."));
    }

    var id = nextId++;
    return new Promise(function(resolve, reject) {
      pending.set(id, { reject: reject, resolve: resolve });
      worker.postMessage({
        id: id,
        payload: payload || null,
        type: type
      }, transfer || []);
    });
  }

  worker.addEventListener("message", function(event) {
    var message = event.data || {};
    var entry = pending.get(message.id);
    if (!entry) {
      return;
    }

    pending.delete(message.id);

    if (message.ok) {
      entry.resolve(message.payload);
      return;
    }

    var error = new Error(message.error && message.error.message || "Dashboard worker request failed.");
    if (message.error && message.error.stack) {
      error.stack = message.error.stack;
    }
    entry.reject(error);
  });

  worker.addEventListener("error", function(event) {
    var error = event.error || new Error(event.message || "Dashboard worker failed.");
    rejectPending(error);
    cleanupWorker();
  });

  var transfer = [],
      payload = {
        dataFetchInit: options.dataFetchInit || null,
        dataUrl: options.dataUrl ? resolveAssetUrl(options.dataUrl) : null,
        dimensions: options.dimensions || [],
        groups: options.groups || [],
        kpis: options.kpis || [],
        wasm: options.wasm !== false
      };

  if (options.arrowBuffer) {
    payload.arrowBuffer = resolveArrowBuffer(options.arrowBuffer);
    transfer.push(payload.arrowBuffer);
  }

  return call("init", payload, transfer).then(function(initPayload) {
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
      workerRuntime: initPayload.runtime
    };
  }).catch(function(error) {
    disposed = true;
    worker.terminate();
    cleanupWorker();
    throw error;
  });
}
