// demo-stockout/filter-router.js
//
// Holds a registry of { id, runtime, dimensions } entries.
// Filters are now applied inline via query({ filters }) in each app's
// refreshAllPanels(). This module only manages runtime registration
// and bulk disposal.

var entries = [];

export function registerRuntime(id, runtime, dimensions) {
  entries.push({ id: id, runtime: runtime, dimensions: dimensions });
}

export function unregisterRuntime(id) {
  entries = entries.filter(function (e) { return e.id !== id; });
}

export function disposeAll() {
  var disposePromises = entries.map(function (e) {
    return e.runtime.dispose().catch(function () {});
  });
  entries = [];
  return Promise.all(disposePromises);
}
