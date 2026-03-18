// demo-stockout/router.js
//
// URL hash is the single source of truth.
// getState() parses hash into { store, category, supplier, ... }
// setState(patch) merges patch into current state and updates hash.
// onStateChange(cb) registers a listener called on hashchange.

var listeners = [];
var currentState = null;

// URL param name -> cube dimension name
export var PARAM_TO_DIMENSION = {
  category: 'product_category',
  subcategory: 'product_sub_category',
  supplier: 'supplier',
  product: 'product',
  risk: 'risk_tier',
  active: 'is_currently_active',
};

export function parseHash(hash) {
  var raw = (hash || '').replace(/^#/, '');
  var params = new URLSearchParams(raw);
  var state = { store: params.get('store') || null };

  for (var param in PARAM_TO_DIMENSION) {
    var val = params.get(param);
    if (param === 'active') {
      state[param] = val === 'true' ? 'true' : val === 'false' ? 'false' : null;
    } else {
      state[param] = val || null;
    }
  }

  // Sensitivity param (not a standard dimension mapping)
  var sens = params.get('sensitivity');
  state.sensitivity = sens === 'confirmed' || sens === 'high' ? sens : null;

  return state;
}

export function serializeHash(state) {
  var params = new URLSearchParams();
  if (state.store) params.set('store', state.store);
  for (var param in PARAM_TO_DIMENSION) {
    if (state[param]) params.set(param, state[param]);
  }
  if (state.sensitivity) params.set('sensitivity', state.sensitivity);
  var str = params.toString();
  return str ? '#' + str : '#';
}

export function getState() {
  if (!currentState) currentState = parseHash(location.hash);
  return currentState;
}

export function setState(patch) {
  var next = Object.assign({}, getState(), patch);
  // Remove null/empty values
  for (var key in next) {
    if (next[key] == null || next[key] === '') next[key] = null;
  }
  var hash = serializeHash(next);
  if (location.hash !== hash) {
    location.hash = hash;
  }
  // hashchange will fire and update currentState
}

export function onStateChange(callback) {
  listeners.push(callback);
  return function () {
    listeners = listeners.filter(function (cb) { return cb !== callback; });
  };
}

// Sensitivity filter: maps one URL param to different dimensions per runtime
// 'all' = no filter, 'confirmed' = confirmed only, 'high' = high confidence only
var SENSITIVITY_MAPPINGS = {
  confirmed: {
    signal_quality: { type: 'in', values: ['HIGH CONFIDENCE', 'MIXED'] },
    is_confirmed: { type: 'in', values: [true, 1] },
  },
  high: {
    signal_quality: { type: 'in', values: ['HIGH CONFIDENCE'] },
    is_confirmed: { type: 'in', values: [true, 1] },
  },
};

// Convert URL state to dashboard filter objects (for crossfilter runtime.updateFilters)
export function buildDashboardFilters(state, runtimeDimensions) {
  var filters = {};

  // Store filter → sold_location dimension (the global cross-crossfilter filter)
  if (state.store && runtimeDimensions.includes('sold_location')) {
    filters.sold_location = { type: 'in', values: [state.store] };
  }

  for (var param in PARAM_TO_DIMENSION) {
    var dimName = PARAM_TO_DIMENSION[param];
    var val = state[param];
    if (!val || !runtimeDimensions.includes(dimName)) continue;
    if (param === 'active') {
      filters[dimName] = { type: 'in', values: [val === 'true'] };
    } else {
      filters[dimName] = { type: 'in', values: val.split(',') };
    }
  }

  // Sensitivity filter — maps to different dimensions per runtime
  var sens = state.sensitivity;
  if (sens && SENSITIVITY_MAPPINGS[sens]) {
    var mapping = SENSITIVITY_MAPPINGS[sens];
    for (var dimName in mapping) {
      if (runtimeDimensions.includes(dimName)) {
        filters[dimName] = mapping[dimName];
        break;  // apply first matching dimension only
      }
    }
  }

  return filters;
}

function onHashChange() {
  var prev = currentState;
  currentState = parseHash(location.hash);
  for (var i = 0; i < listeners.length; ++i) {
    listeners[i](currentState, prev);
  }
}

window.addEventListener('hashchange', onHashChange);
currentState = parseHash(location.hash);
