// demo-stockout/filter-router.js
//
// Holds a registry of { id, runtime, dimensions } entries.
// When filters change, dispatches updateFilters() to each runtime
// for dimensions it has loaded. Ignores dimensions not in a runtime.

import { buildDashboardFilters } from './router.js';

var entries = [];
var panelCallbacks = [];

export function registerRuntime(id, runtime, dimensions) {
  entries.push({ id: id, runtime: runtime, dimensions: dimensions });
}

export function unregisterRuntime(id) {
  entries = entries.filter(function (e) { return e.id !== id; });
}

export function onPanelRefresh(callback) {
  panelCallbacks.push(callback);
}

export async function dispatchFilters(state) {
  var promises = [];
  for (var i = 0; i < entries.length; ++i) {
    var entry = entries[i];
    var filters = buildDashboardFilters(state, entry.dimensions);
    promises.push(
      entry.runtime.updateFilters(filters).catch(function (err) {
        console.error('Filter dispatch failed for ' + entry.id + ':', err);
      })
    );
  }
  await Promise.all(promises);
  // Notify panels to re-query
  for (var j = 0; j < panelCallbacks.length; ++j) {
    panelCallbacks[j]();
  }
}

export function disposeAll() {
  var disposePromises = entries.map(function (e) {
    return e.runtime.dispose().catch(function () {});
  });
  entries = [];
  return Promise.all(disposePromises);
}
