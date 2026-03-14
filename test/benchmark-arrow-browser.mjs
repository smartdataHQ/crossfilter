const crossfilter = globalThis.crossfilter;
const arrowModule = globalThis.Arrow;

if (!crossfilter) {
  throw new Error('Expected `window.crossfilter` from ../crossfilter.js before loading the browser benchmark.');
}
if (!arrowModule) {
  throw new Error('Expected `window.Arrow` from ../node_modules/apache-arrow/Arrow.es2015.min.js before loading the browser benchmark.');
}

const FILE_PATH = './data/query-result.arrow';
const FIELDS = {
  country: 'semantic_events__dimensions_customer_country',
  event: 'semantic_events__event',
  region: 'semantic_events__location_region',
  time: 'semantic_events__timestamp_minute',
  latitude: 'semantic_events__location_latitude'
};
const WORKLOADS = [
  {
    id: 'build_dashboard',
    description: 'Create the dashboard and read KPI/group outputs once.',
    includeGroups: true,
    buildOnly: true
  },
  {
    id: 'kpis_country_single',
    description: 'Apply a single country filter and read KPI cards.',
    includeGroups: false,
    filters: {
      country: 'single',
      event: 'off',
      region: 'off',
      time: 'off'
    }
  },
  {
    id: 'kpis_country_multi',
    description: 'Apply a multi-country filter and read KPI cards.',
    includeGroups: false,
    filters: {
      country: 'multi',
      event: 'off',
      region: 'off',
      time: 'off'
    }
  },
  {
    id: 'dashboard__country_single__event_single__region_single__time_off',
    description: 'Apply country/event/region single-select filters and read KPI/group outputs.',
    includeGroups: true,
    filters: {
      country: 'single',
      event: 'single',
      region: 'single',
      time: 'off'
    }
  },
  {
    id: 'dashboard__country_multi__event_multi__region_multi__time_range',
    description: 'Apply country/event/region multi-select filters and a time range, then read KPI/group outputs.',
    includeGroups: true,
    filters: {
      country: 'multi',
      event: 'multi',
      region: 'multi',
      time: 'range'
    }
  }
];

function reportProgress(callback, message) {
  if (typeof callback === 'function') {
    callback({ message: message, timestamp: new Date().toISOString() });
  }
}

function getTableFromIPC(module) {
  return module.tableFromIPC
    || (module.default && module.default.tableFromIPC)
    || null;
}

function getFieldNames(table) {
  return table.schema.fields.map(function(field) {
    return field.name;
  });
}

function getColumn(table, fieldName, fieldIndex) {
  if (typeof table.getChild === 'function') {
    var byName = table.getChild(fieldName);
    if (byName != null) {
      return byName;
    }
  }
  if (typeof table.getColumn === 'function') {
    var byColumn = table.getColumn(fieldName);
    if (byColumn != null) {
      return byColumn;
    }
  }
  if (typeof table.getChildAt === 'function') {
    return table.getChildAt(fieldIndex);
  }
  return table[fieldName];
}

function getValue(column, index) {
  if (column == null) {
    return undefined;
  }
  if (typeof column.get === 'function') {
    return column.get(index);
  }
  if (typeof column.at === 'function') {
    return column.at(index);
  }
  return column[index];
}

function pickValues(table, field, count) {
  var fields = getFieldNames(table);
  var fieldIndex = fields.indexOf(field);
  var column = getColumn(table, field, fieldIndex);
  var values = [];
  var seen = new Set();

  for (var rowIndex = 0; rowIndex < table.numRows && values.length < count; ++rowIndex) {
    var value = getValue(column, rowIndex);
    if (value == null || typeof value === 'object' || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }

  return values;
}

function pickNumericRange(table, field, sampleSize) {
  var fields = getFieldNames(table);
  var fieldIndex = fields.indexOf(field);
  var column = getColumn(table, field, fieldIndex);
  var sample = [];

  for (var rowIndex = 0; rowIndex < table.numRows && sample.length < sampleSize; ++rowIndex) {
    var value = getValue(column, rowIndex);
    if (typeof value === 'number' && Number.isFinite(value)) {
      sample.push(value);
    }
  }

  sample.sort(function(a, b) { return a - b; });
  var lower = sample[Math.floor(sample.length * 0.25)];
  var upper = sample[Math.floor(sample.length * 0.75)];
  if (!(upper > lower)) {
    upper = sample[sample.length - 1];
  }
  if (!(upper > lower)) {
    upper = lower + 1;
  } else if (Number.isInteger(upper)) {
    upper += 1;
  }
  return [lower, upper];
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function createCombinedKpiRuntime(cf, fields) {
  var group = cf.groupAll().reduce(
    function(state, row) {
      var latitude = row[fields.latitude];
      var timestamp = row[fields.time];
      state.totalRows += 1;
      if (isFiniteNumber(timestamp)) {
        state.timestampSum += timestamp;
      }
      if (isFiniteNumber(latitude)) {
        state.locatedRows += 1;
        if (latitude !== 0) {
          state.latitudeSum += latitude;
          state.latitudeCount += 1;
        }
      }
      return state;
    },
    function(state, row) {
      var latitude = row[fields.latitude];
      var timestamp = row[fields.time];
      state.totalRows -= 1;
      if (isFiniteNumber(timestamp)) {
        state.timestampSum -= timestamp;
      }
      if (isFiniteNumber(latitude)) {
        state.locatedRows -= 1;
        if (latitude !== 0) {
          state.latitudeSum -= latitude;
          state.latitudeCount -= 1;
        }
      }
      return state;
    },
    function() {
      return {
        totalRows: 0,
        locatedRows: 0,
        timestampSum: 0,
        latitudeSum: 0,
        latitudeCount: 0
      };
    }
  );

  return {
    read: function() {
      var state = group.value();
      return {
        totalRows: state.totalRows,
        locatedRows: state.locatedRows,
        timestampSum: state.timestampSum,
        latitudeAvgNonZero: state.latitudeCount ? state.latitudeSum / state.latitudeCount : null
      };
    },
    dispose: function() {
      group.dispose();
    }
  };
}

function createGroupRuntime(dimension, fields) {
  var group = dimension.group();
  group.reduce(
    function(state, row) {
      var latitude = row[fields.latitude];
      var timestamp = row[fields.time];
      state.totalRows += 1;
      if (isFiniteNumber(timestamp)) {
        state.timestampSum += timestamp;
      }
      if (isFiniteNumber(latitude)) {
        state.locatedRows += 1;
      }
      return state;
    },
    function(state, row) {
      var latitude = row[fields.latitude];
      var timestamp = row[fields.time];
      state.totalRows -= 1;
      if (isFiniteNumber(timestamp)) {
        state.timestampSum -= timestamp;
      }
      if (isFiniteNumber(latitude)) {
        state.locatedRows -= 1;
      }
      return state;
    },
    function() {
      return {
        totalRows: 0,
        locatedRows: 0,
        timestampSum: 0
      };
    }
  );

  return {
    readDigest: function() {
      var entries = group.all();
      var checksum = 0;
      for (var index = 0; index < entries.length; ++index) {
        checksum += entries[index].value.totalRows;
        checksum += entries[index].value.locatedRows;
      }
      return checksum;
    },
    dispose: function() {
      group.dispose();
    }
  };
}

function createEnvironment(table) {
  crossfilter.configureRuntime({ wasm: true });
  var cf = crossfilter.fromArrowTable(table);
  var dimensions = {
    country: cf.dimension(FIELDS.country),
    event: cf.dimension(FIELDS.event),
    region: cf.dimension(FIELDS.region),
    time: cf.dimension(FIELDS.time)
  };

  return {
    dimensions: dimensions,
    groups: {
      event: createGroupRuntime(dimensions.event, FIELDS),
      region: createGroupRuntime(dimensions.region, FIELDS)
    },
    kpis: createCombinedKpiRuntime(cf, FIELDS),
    runtime: crossfilter.runtimeInfo(),
    dispose: function() {
      resetFilters(this);
      this.groups.event.dispose();
      this.groups.region.dispose();
      this.kpis.dispose();
      this.dimensions.country.dispose();
      this.dimensions.event.dispose();
      this.dimensions.region.dispose();
      this.dimensions.time.dispose();
    }
  };
}

function resetFilters(environment) {
  environment.dimensions.country.filterAll();
  environment.dimensions.event.filterAll();
  environment.dimensions.region.filterAll();
  environment.dimensions.time.filterAll();
}

function applyDiscreteFilter(dimension, values) {
  if (values.length === 1) {
    dimension.filterExact(values[0]);
  } else {
    dimension.filterIn(values);
  }
}

function applyScenario(environment, selections, scenario) {
  var filters = scenario.filters;
  if (filters.country !== 'off') {
    applyDiscreteFilter(environment.dimensions.country, selections.country[filters.country]);
  }
  if (filters.event !== 'off') {
    applyDiscreteFilter(environment.dimensions.event, selections.event[filters.event]);
  }
  if (filters.region !== 'off') {
    applyDiscreteFilter(environment.dimensions.region, selections.region[filters.region]);
  }
  if (filters.time === 'range') {
    environment.dimensions.time.filterRange(selections.timeRange);
  }
}

function readSnapshot(environment, includeGroups) {
  var checksum = 0;
  var kpis = environment.kpis.read();
  checksum += kpis.totalRows || 0;
  checksum += kpis.locatedRows || 0;
  checksum += kpis.timestampSum || 0;
  checksum += kpis.latitudeAvgNonZero || 0;

  if (includeGroups) {
    checksum += environment.groups.event.readDigest();
    checksum += environment.groups.region.readDigest();
  }

  return checksum;
}

function stats(samples) {
  var sorted = samples.slice().sort(function(a, b) { return a - b; });
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    mean: samples.reduce(function(sum, value) { return sum + value; }, 0) / samples.length,
    p95: sorted[Math.floor((sorted.length - 1) * 0.95)]
  };
}

function bench(iterations, warmup, fn) {
  for (var warm = 0; warm < warmup; ++warm) {
    fn();
  }

  var samples = new Array(iterations);
  for (var index = 0; index < iterations; ++index) {
    var started = performance.now();
    fn();
    samples[index] = performance.now() - started;
  }
  return stats(samples);
}

function nextTick() {
  return new Promise(function(resolve) {
    setTimeout(resolve, 0);
  });
}

export async function runBrowserBenchmark(progressCallback) {
  reportProgress(progressCallback, 'Fetching Arrow fixture...');
  var response = await fetch(FILE_PATH);
  if (!response.ok) {
    throw new Error('Failed to fetch Arrow fixture: ' + response.status + ' ' + response.statusText);
  }
  var bytes = new Uint8Array(await response.arrayBuffer());
  var tableFromIPC = getTableFromIPC(arrowModule);
  var table = tableFromIPC(bytes);

  var selections = {
    country: {
      single: pickValues(table, FIELDS.country, 1),
      multi: pickValues(table, FIELDS.country, 5)
    },
    event: {
      single: pickValues(table, FIELDS.event, 1),
      multi: pickValues(table, FIELDS.event, 3)
    },
    region: {
      single: pickValues(table, FIELDS.region, 1),
      multi: pickValues(table, FIELDS.region, 3)
    },
    timeRange: pickNumericRange(table, FIELDS.time, 50000)
  };

  var results = {
    file: FILE_PATH,
    rows: table.numRows,
    columns: getFieldNames(table).length,
    runtime: null,
    selections: selections,
    workloads: {}
  };

  for (var workloadIndex = 0; workloadIndex < WORKLOADS.length; ++workloadIndex) {
    var workload = WORKLOADS[workloadIndex];
    reportProgress(progressCallback, 'Running ' + workload.id + ' (' + (workloadIndex + 1) + '/' + WORKLOADS.length + ')');
    await nextTick();

    if (workload.buildOnly) {
      results.workloads[workload.id] = bench(2, 1, function() {
        var environment = createEnvironment(table);
        try {
          results.runtime = environment.runtime;
          readSnapshot(environment, true);
        } finally {
          environment.dispose();
        }
      });
      continue;
    }

    var environment = createEnvironment(table);
    try {
      if (!results.runtime) {
        results.runtime = environment.runtime;
      }
      results.workloads[workload.id] = bench(2, 1, function() {
        resetFilters(environment);
        applyScenario(environment, selections, workload);
        readSnapshot(environment, workload.includeGroups);
        resetFilters(environment);
      });
    } finally {
      environment.dispose();
    }
  }

  return results;
}
