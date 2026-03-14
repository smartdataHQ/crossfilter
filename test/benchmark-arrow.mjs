import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

import crossfilter from '../main.js';

const DEFAULT_FILE = 'test/data/query-result.arrow';
const DEFAULT_OUTPUT_DIR = 'test/results';
const DEFAULT_FIELDS = {
  country: 'semantic_events__dimensions_customer_country',
  event: 'semantic_events__event',
  region: 'semantic_events__location_region',
  time: 'semantic_events__timestamp_minute',
  latitude: 'semantic_events__location_latitude'
};
const MODES = [
  {
    id: 'row_baseline',
    label: 'Row objects + filterFunction + separate KPIs',
    source: 'row',
    wasm: false,
    filterStrategy: 'function',
    kpiStrategy: 'separate'
  },
  {
    id: 'row_native',
    label: 'Row objects + filterIn/filterExact + combined KPIs',
    source: 'row',
    wasm: false,
    filterStrategy: 'native',
    kpiStrategy: 'combined'
  },
  {
    id: 'arrow_js',
    label: 'Arrow columns + native filters + combined KPIs (WASM disabled)',
    source: 'arrow',
    wasm: false,
    filterStrategy: 'native',
    kpiStrategy: 'combined'
  },
  {
    id: 'arrow_wasm',
    label: 'Arrow columns + native filters + combined KPIs (WASM enabled)',
    source: 'arrow',
    wasm: true,
    filterStrategy: 'native',
    kpiStrategy: 'combined'
  }
];
const DISCRETE_DIMENSIONS = [
  { key: 'country', label: 'country' },
  { key: 'event', label: 'event' },
  { key: 'region', label: 'region' }
];
const KPI_ONLY_SCENARIOS = buildKpiOnlyScenarios();
const MATRIX_SCENARIOS = buildMatrixScenarios();
const WORKLOADS = [{
  id: 'build_dashboard',
  family: 'build',
  description: 'Create crossfilter, dimensions, KPI reducers, and grouped reducers, then read them once.',
  includeGroups: true,
  buildOnly: true
}].concat(KPI_ONLY_SCENARIOS, MATRIX_SCENARIOS);

function parseArgs(argv) {
  const options = {
    file: DEFAULT_FILE,
    iterations: 3,
    warmup: 1,
    countryValues: 5,
    eventValues: 3,
    regionValues: 3,
    timeSampleSize: 50000,
    out: null,
    save: true,
    scenarioRegex: null,
    maxScenarios: null,
    modes: null
  };

  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === '--iterations') {
      options.iterations = Number(argv[++i]);
    } else if (arg === '--warmup') {
      options.warmup = Number(argv[++i]);
    } else if (arg === '--country-values' || arg === '--values') {
      options.countryValues = Number(argv[++i]);
    } else if (arg === '--event-values') {
      options.eventValues = Number(argv[++i]);
    } else if (arg === '--region-values') {
      options.regionValues = Number(argv[++i]);
    } else if (arg === '--time-sample-size') {
      options.timeSampleSize = Number(argv[++i]);
    } else if (arg === '--out') {
      options.out = argv[++i];
    } else if (arg === '--no-save') {
      options.save = false;
    } else if (arg === '--scenario-regex') {
      options.scenarioRegex = argv[++i];
    } else if (arg === '--max-scenarios') {
      options.maxScenarios = Number(argv[++i]);
    } else if (arg === '--modes') {
      options.modes = argv[++i].split(',').map(function(value) { return value.trim(); }).filter(Boolean);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      options.file = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log([
    'Usage: node test/benchmark-arrow.mjs [file] [--iterations n] [--warmup n] [--country-values n] [--event-values n] [--region-values n]',
    '',
    `Defaults to ${DEFAULT_FILE} and runs a large-file dashboard workload matrix.`,
    '',
    'Options:',
    '  --out <path>            Write JSON to a specific file.',
    '  --no-save               Do not write a timestamped JSON artifact.',
    '  --scenario-regex <re>   Run only scenarios whose id matches the regex.',
    '  --max-scenarios <n>     Limit the number of interactive scenarios after filtering.',
    '  --modes <csv>           Run only the specified mode ids.',
    '',
    'Environment:',
    '  CROSSFILTER_ARROW_MODULE  Optional module specifier for apache-arrow,',
    '                            e.g. /absolute/path/to/Arrow.node.mjs'
  ].join('\n'));
}

function buildKpiOnlyScenarios() {
  var scenarios = [];
  for (var i = 0; i < DISCRETE_DIMENSIONS.length; ++i) {
    var dimension = DISCRETE_DIMENSIONS[i];
    scenarios.push({
      id: `kpis_${dimension.key}_single`,
      family: 'kpi_only',
      description: `Apply a single-select ${dimension.label} filter and read KPI cards.`,
      includeGroups: false,
      filters: createEmptyFilterState(),
      groupReads: []
    });
    scenarios[scenarios.length - 1].filters[dimension.key] = 'single';

    scenarios.push({
      id: `kpis_${dimension.key}_multi`,
      family: 'kpi_only',
      description: `Apply a multi-select ${dimension.label} filter and read KPI cards.`,
      includeGroups: false,
      filters: createEmptyFilterState(),
      groupReads: []
    });
    scenarios[scenarios.length - 1].filters[dimension.key] = 'multi';
  }
  return scenarios;
}

function buildMatrixScenarios() {
  var scenarios = [];
  var discreteStates = ['off', 'single', 'multi'];
  var timeStates = ['off', 'range'];

  for (var countryIndex = 0; countryIndex < discreteStates.length; ++countryIndex) {
    for (var eventIndex = 0; eventIndex < discreteStates.length; ++eventIndex) {
      for (var regionIndex = 0; regionIndex < discreteStates.length; ++regionIndex) {
        for (var timeIndex = 0; timeIndex < timeStates.length; ++timeIndex) {
          var filters = {
            country: discreteStates[countryIndex],
            event: discreteStates[eventIndex],
            region: discreteStates[regionIndex],
            time: timeStates[timeIndex]
          };

          if (filters.country === 'off' && filters.event === 'off' && filters.region === 'off' && filters.time === 'off') {
            continue;
          }

          scenarios.push({
            id: scenarioId(filters),
            family: 'dashboard_matrix',
            description: scenarioDescription(filters),
            includeGroups: true,
            filters: filters,
            groupReads: ['event', 'region']
          });
        }
      }
    }
  }

  return scenarios;
}

function buildAllFieldScenarios(activeFieldPlans, totalFieldCount) {
  if (!activeFieldPlans.length) {
    return [];
  }

  return [{
    id: 'all_fields_single',
    family: 'all_fields',
    description: `Apply one active filter to each realistic field (${activeFieldPlans.length} active / ${totalFieldCount} total columns) and read all reducers.`,
    includeGroups: true,
    groupReads: ['event', 'region'],
    applyAllFieldsMode: 'single'
  }, {
    id: 'all_fields_mixed',
    family: 'all_fields',
    description: `Apply multi-select or range filters to each realistic field (${activeFieldPlans.length} active / ${totalFieldCount} total columns) and read all reducers.`,
    includeGroups: true,
    groupReads: ['event', 'region'],
    applyAllFieldsMode: 'mixed'
  }];
}

function createEmptyFilterState() {
  return {
    country: 'off',
    event: 'off',
    region: 'off',
    time: 'off'
  };
}

function scenarioId(filters) {
  return [
    'dashboard',
    `country_${filters.country}`,
    `event_${filters.event}`,
    `region_${filters.region}`,
    `time_${filters.time}`
  ].join('__');
}

function scenarioDescription(filters) {
  var parts = [];
  if (filters.country !== 'off') {
    parts.push(`${filters.country}-select country`);
  }
  if (filters.event !== 'off') {
    parts.push(`${filters.event}-select event`);
  }
  if (filters.region !== 'off') {
    parts.push(`${filters.region}-select region`);
  }
  if (filters.time === 'range') {
    parts.push('time range');
  }
  return `Apply ${parts.join(', ')}, then read KPI cards and grouped charts.`;
}

function createTimestamp(date) {
  function pad(value) {
    return String(value).padStart(2, '0');
  }

  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate())
  ].join('') + 'T' + [
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds())
  ].join('') + 'Z';
}

function logProgress(message) {
  process.stderr.write(`[benchmark] ${new Date().toISOString()} ${message}\n`);
}

async function loadArrowModule() {
  var override = process.env.CROSSFILTER_ARROW_MODULE;
  if (override) {
    return import(override);
  }

  try {
    return await import('apache-arrow/Arrow.node.mjs');
  } catch (nodeError) {
    try {
      return await import('apache-arrow');
    } catch (packageError) {
      var error = new Error(
        'apache-arrow is required for this benchmark. Install it with `npm install --save-dev apache-arrow`, or set CROSSFILTER_ARROW_MODULE to an Arrow module path.'
      );
      error.cause = packageError || nodeError;
      throw error;
    }
  }
}

function getTableFromIPC(arrowModule) {
  return arrowModule.tableFromIPC
    || (arrowModule.default && arrowModule.default.tableFromIPC)
    || null;
}

function getFieldNames(table) {
  if (table && table.schema && Array.isArray(table.schema.fields)) {
    return table.schema.fields.map(function(field) {
      return field.name;
    });
  }
  if (table && Array.isArray(table.columnNames)) {
    return table.columnNames.slice();
  }
  return [];
}

function getColumn(table, fieldName, fieldIndex) {
  if (table == null) {
    return undefined;
  }
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

function materializeRows(table) {
  var fields = getFieldNames(table);
  var columns = fields.map(function(field, fieldIndex) {
    return getColumn(table, field, fieldIndex);
  });
  var rows = new Array(table.numRows);

  for (var rowIndex = 0; rowIndex < table.numRows; ++rowIndex) {
    var row = {};
    for (var fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
      row[fields[fieldIndex]] = getValue(columns[fieldIndex], rowIndex);
    }
    rows[rowIndex] = row;
  }

  return rows;
}

function stats(samples) {
  var sorted = samples.slice().sort(function(a, b) { return a - b; });
  var median = sorted[Math.floor(sorted.length / 2)];
  var mean = samples.reduce(function(sum, value) { return sum + value; }, 0) / samples.length;
  var p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];
  return { median: median, mean: mean, p95: p95 };
}

function bench(iterations, warmup, fn) {
  for (var i = 0; i < warmup; ++i) {
    fn();
  }

  var samples = new Array(iterations);
  for (var j = 0; j < iterations; ++j) {
    var t0 = performance.now();
    fn();
    samples[j] = performance.now() - t0;
  }

  return stats(samples);
}

function pushPhaseSample(store, phase, value) {
  if (!store[phase]) {
    store[phase] = [];
  }
  store[phase].push(value);
}

function summarizePhaseSamples(store) {
  var phases = {};
  for (var phase in store) {
    phases[phase] = stats(store[phase]);
  }
  return phases;
}

function pickValues(table, field, count) {
  var fields = getFieldNames(table);
  var fieldIndex = fields.indexOf(field);
  var column = getColumn(table, field, fieldIndex);
  var seen = new Set();
  var values = [];

  for (var rowIndex = 0; rowIndex < table.numRows && values.length < count; ++rowIndex) {
    var value = getValue(column, rowIndex);
    if (value == null || typeof value === 'object' || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }

  if (!values.length) {
    throw new Error(`Could not find benchmark values for field: ${field}`);
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

  if (sample.length < 2) {
    throw new Error(`Could not find enough numeric values for field: ${field}`);
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

function sampleScalarValue(table, field) {
  var fields = getFieldNames(table);
  var fieldIndex = fields.indexOf(field);
  var column = getColumn(table, field, fieldIndex);

  for (var rowIndex = 0; rowIndex < table.numRows; ++rowIndex) {
    var value = getValue(column, rowIndex);
    if (value == null || typeof value === 'object') {
      continue;
    }
    return value;
  }

  return undefined;
}

function isActiveFilterPlan(plan) {
  return plan.kind === 'range'
    || (plan.kind === 'discrete' && plan.multi && plan.multi.length > 1);
}

function buildAllFieldPlans(table, fieldNames, options) {
  var plans = [];

  for (var fieldIndex = 0; fieldIndex < fieldNames.length; ++fieldIndex) {
    var field = fieldNames[fieldIndex];
    var sample = sampleScalarValue(table, field);

    if (sample == null || typeof sample === 'object') {
      continue;
    }

    if (typeof sample === 'number' && Number.isFinite(sample)) {
      try {
        plans.push({
          field: field,
          kind: 'range',
          range: pickNumericRange(table, field, options.timeSampleSize)
        });
      } catch (error) {
        // Skip numeric fields that don't provide a meaningful range sample.
      }
      continue;
    }

    if (typeof sample === 'string' || typeof sample === 'boolean' || typeof sample === 'bigint') {
      var single = pickValues(table, field, 1);
      var multi = pickValues(table, field, Math.max(2, Math.min(3, options.countryValues)));
      plans.push({
        field: field,
        kind: 'discrete',
        single: single,
        multi: multi.length > 1 ? multi : single
      });
    }
  }

  return plans;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function addFieldContribution(total, value) {
  if (value == null) {
    return total;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? total + (value % 1000003) : total;
  }
  if (typeof value === 'string') {
    return total + value.length;
  }
  if (typeof value === 'boolean') {
    return total + (value ? 1 : 0);
  }
  if (typeof value === 'bigint') {
    return total + Number(value % 2147483647n);
  }
  if (value instanceof Date) {
    return total + (value.getTime() % 1000003);
  }
  if (typeof value.length === 'number') {
    return total + value.length;
  }
  if (typeof value.size === 'number') {
    return total + value.size;
  }
  return total + 1;
}

function rowFieldDigest(row, fieldNames) {
  var total = 0;
  for (var fieldIndex = 0; fieldIndex < fieldNames.length; ++fieldIndex) {
    total = addFieldContribution(total, row[fieldNames[fieldIndex]]);
  }
  return total;
}

function createAllFieldDigestRuntime(cf, fieldNames) {
  var group = cf.groupAll().reduce(
    function(total, row) {
      return total + rowFieldDigest(row, fieldNames);
    },
    function(total, row) {
      return total - rowFieldDigest(row, fieldNames);
    },
    function() {
      return 0;
    }
  );

  return {
    read: function() {
      return group.value();
    },
    dispose: function() {
      group.dispose();
    }
  };
}

function createSeparateKpiRuntime(cf, fields) {
  var totalRows = cf.groupAll().reduceCount();
  var timestampSum = cf.groupAll().reduceSum(function(row) {
    return isFiniteNumber(row[fields.time]) ? row[fields.time] : 0;
  });
  var locatedRows = cf.groupAll().reduce(
    function(count, row) {
      return count + (isFiniteNumber(row[fields.latitude]) ? 1 : 0);
    },
    function(count, row) {
      return count - (isFiniteNumber(row[fields.latitude]) ? 1 : 0);
    },
    function() {
      return 0;
    }
  );
  var latitudeAverage = cf.groupAll().reduce(
    function(state, row) {
      var value = row[fields.latitude];
      if (isFiniteNumber(value) && value !== 0) {
        state.sum += value;
        state.count += 1;
      }
      return state;
    },
    function(state, row) {
      var value = row[fields.latitude];
      if (isFiniteNumber(value) && value !== 0) {
        state.sum -= value;
        state.count -= 1;
      }
      return state;
    },
    function() {
      return { sum: 0, count: 0 };
    }
  );

  return {
    read: function() {
      var latitudeState = latitudeAverage.value();
      return {
        totalRows: totalRows.value(),
        locatedRows: locatedRows.value(),
        timestampSum: timestampSum.value(),
        latitudeAvgNonZero: latitudeState.count ? latitudeState.sum / latitudeState.count : null
      };
    },
    dispose: function() {
      totalRows.dispose();
      timestampSum.dispose();
      locatedRows.dispose();
      latitudeAverage.dispose();
    }
  };
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
      for (var i = 0; i < entries.length; ++i) {
        checksum += entries[i].value.totalRows;
        checksum += entries[i].value.locatedRows;
      }
      return checksum;
    },
    dispose: function() {
      group.dispose();
    }
  };
}

function createEnvironment(table, fields, allFieldPlans, mode) {
  crossfilter.configureRuntime({ wasm: mode.wasm });

  var cf = mode.source === 'arrow'
    ? crossfilter.fromArrowTable(table)
    : crossfilter(materializeRows(table));
  var allDimensions = {};
  var allFieldNames = new Array(allFieldPlans.length);

  for (var planIndex = 0; planIndex < allFieldPlans.length; ++planIndex) {
    var fieldName = allFieldPlans[planIndex].field;
    allFieldNames[planIndex] = fieldName;
    allDimensions[fieldName] = cf.dimension(fieldName);
  }

  var dimensions = {
    country: allDimensions[fields.country],
    event: allDimensions[fields.event],
    region: allDimensions[fields.region],
    time: allDimensions[fields.time]
  };
  var kpis = mode.kpiStrategy === 'combined'
    ? createCombinedKpiRuntime(cf, fields)
    : createSeparateKpiRuntime(cf, fields);
  var groups = {
    event: createGroupRuntime(dimensions.event, fields),
    region: createGroupRuntime(dimensions.region, fields)
  };
  var allFieldDigest = createAllFieldDigestRuntime(cf, allFieldNames);

  return {
    cf: cf,
    dimensions: dimensions,
    allDimensions: allDimensions,
    allFieldDigest: allFieldDigest,
    groups: groups,
    kpis: kpis,
    runtime: crossfilter.runtimeInfo(),
    dispose: function() {
      resetFilters(this);
      this.groups.event.dispose();
      this.groups.region.dispose();
      this.kpis.dispose();
      this.allFieldDigest.dispose();
      for (var fieldIndex = 0; fieldIndex < allFieldNames.length; ++fieldIndex) {
        this.allDimensions[allFieldNames[fieldIndex]].dispose();
      }
    }
  };
}

function resetFilters(environment) {
  for (var field in environment.allDimensions) {
    environment.allDimensions[field].filterAll();
  }
}

function applyDiscreteFilter(dimension, values, strategy) {
  if (values.length === 1) {
    dimension.filterExact(values[0]);
    return;
  }

  if (strategy === 'function') {
    var selected = new Set(values);
    dimension.filterFunction(function(value) {
      return selected.has(value);
    });
    return;
  }

  dimension.filterIn(values);
}

function applyAllFieldScenario(environment, fieldPlans, scenarioMode, strategy) {
  for (var planIndex = 0; planIndex < fieldPlans.length; ++planIndex) {
    var plan = fieldPlans[planIndex];
    var dimension = environment.allDimensions[plan.field];

    if (plan.kind === 'range') {
      dimension.filterRange(plan.range);
      continue;
    }

    if (scenarioMode === 'mixed' && plan.multi && plan.multi.length > 1) {
      applyDiscreteFilter(dimension, plan.multi, strategy);
    } else {
      applyDiscreteFilter(dimension, plan.single, strategy);
    }
  }
}

function applyScenario(environment, selections, scenario, mode) {
  if (scenario.applyAllFieldsMode) {
    applyAllFieldScenario(environment, selections.activeAllFields, scenario.applyAllFieldsMode, mode.filterStrategy);
    return;
  }

  var filters = scenario.filters;

  if (filters.country !== 'off') {
    applyDiscreteFilter(environment.dimensions.country, selections.country[filters.country], mode.filterStrategy);
  }
  if (filters.event !== 'off') {
    applyDiscreteFilter(environment.dimensions.event, selections.event[filters.event], mode.filterStrategy);
  }
  if (filters.region !== 'off') {
    applyDiscreteFilter(environment.dimensions.region, selections.region[filters.region], mode.filterStrategy);
  }
  if (filters.time === 'range') {
    environment.dimensions.time.filterRange(selections.timeRange);
  }
}

function readKpiDigest(environment) {
  var values = environment.kpis.read();
  var checksum = 0;
  checksum += values.totalRows || 0;
  checksum += values.locatedRows || 0;
  checksum += values.timestampSum || 0;
  checksum += values.latitudeAvgNonZero || 0;
  checksum += environment.allFieldDigest.read() || 0;
  return checksum;
}

function readSnapshot(environment, scenario) {
  var checksum = readKpiDigest(environment);
  if (scenario.includeGroups) {
    for (var i = 0; i < scenario.groupReads.length; ++i) {
      checksum += environment.groups[scenario.groupReads[i]].readDigest();
    }
  }
  return checksum;
}

function benchBuildScenario(table, fields, allFieldPlans, mode, iterations, warmup) {
  var totalSamples = new Array(iterations);
  var phaseSamples = {};

  function runIteration(recordSamples) {
    var environment,
        t0,
        t1,
        t2,
        t3,
        t4,
        disposeStart,
        disposeEnd;

    t0 = performance.now();
    environment = createEnvironment(table, fields, allFieldPlans, mode);
    t1 = performance.now();
    readKpiDigest(environment);
    t2 = performance.now();
    environment.groups.event.readDigest();
    t3 = performance.now();
    environment.groups.region.readDigest();
    t4 = performance.now();

    if (recordSamples) {
      pushPhaseSample(recordSamples, 'create_environment', t1 - t0);
      pushPhaseSample(recordSamples, 'read_kpis', t2 - t1);
      pushPhaseSample(recordSamples, 'read_event_group', t3 - t2);
      pushPhaseSample(recordSamples, 'read_region_group', t4 - t3);
    }

    disposeStart = performance.now();
    environment.dispose();
    disposeEnd = performance.now();

    if (recordSamples) {
      pushPhaseSample(recordSamples, 'dispose', disposeEnd - disposeStart);
    }

    return t4 - t0;
  }

  for (var warmIndex = 0; warmIndex < warmup; ++warmIndex) {
    runIteration(null);
  }

  for (var iterationIndex = 0; iterationIndex < iterations; ++iterationIndex) {
    totalSamples[iterationIndex] = runIteration(phaseSamples);
  }

  var result = stats(totalSamples);
  result.phases = summarizePhaseSamples(phaseSamples);
  return result;
}

function benchInteractiveScenario(environment, selections, mode, scenario, iterations, warmup) {
  var totalSamples = new Array(iterations);
  var phaseSamples = {};

  resetFilters(environment);
  readSnapshot(environment, scenario);
  resetFilters(environment);

  function runIteration(recordSamples) {
    var t0,
        t1,
        t2,
        cleanupStart,
        cleanupEnd;

    t0 = performance.now();
    applyScenario(environment, selections, scenario, mode);
    t1 = performance.now();
    readSnapshot(environment, scenario);
    t2 = performance.now();

    if (recordSamples) {
      pushPhaseSample(recordSamples, 'apply_filters', t1 - t0);
      pushPhaseSample(recordSamples, 'read_snapshot', t2 - t1);
    }

    cleanupStart = performance.now();
    resetFilters(environment);
    cleanupEnd = performance.now();

    if (recordSamples) {
      pushPhaseSample(recordSamples, 'cleanup_reset', cleanupEnd - cleanupStart);
    }

    return t2 - t0;
  }

  for (var warmIndex = 0; warmIndex < warmup; ++warmIndex) {
    runIteration(null);
  }

  for (var iterationIndex = 0; iterationIndex < iterations; ++iterationIndex) {
    totalSamples[iterationIndex] = runIteration(phaseSamples);
  }

  var result = stats(totalSamples);
  result.phases = summarizePhaseSamples(phaseSamples);
  return result;
}

function compareStats(before, after) {
  return {
    beforeMedian: before.median,
    afterMedian: after.median,
    speedup: before.median / after.median,
    deltaPct: ((after.median - before.median) / before.median) * 100
  };
}

function compareModes(resultsByMode, leftMode, rightMode, scenarios) {
  var comparisons = {};
  var left = resultsByMode[leftMode];
  var right = resultsByMode[rightMode];

  for (var i = 0; i < scenarios.length; ++i) {
    var scenarioId = scenarios[i].id;
    comparisons[scenarioId] = compareStats(left.workloads[scenarioId], right.workloads[scenarioId]);
  }

  return comparisons;
}

function summarizeMode(workloads, scenarios) {
  var summary = {
    buildDashboardMedian: workloads.build_dashboard.median,
    kpiOnlyMedian: null,
    dashboardMatrixMedian: null,
    allFieldsMedian: null
  };
  var kpiOnly = [];
  var dashboardMatrix = [];
  var allFields = [];

  for (var i = 0; i < scenarios.length; ++i) {
    var scenario = scenarios[i];
    if (scenario.family === 'kpi_only') {
      kpiOnly.push(workloads[scenario.id].median);
    } else if (scenario.family === 'dashboard_matrix') {
      dashboardMatrix.push(workloads[scenario.id].median);
    } else if (scenario.family === 'all_fields') {
      allFields.push(workloads[scenario.id].median);
    }
  }

  if (kpiOnly.length) {
    summary.kpiOnlyMedian = stats(kpiOnly).median;
  }
  if (dashboardMatrix.length) {
    summary.dashboardMatrixMedian = stats(dashboardMatrix).median;
  }
  if (allFields.length) {
    summary.allFieldsMedian = stats(allFields).median;
  }

  return summary;
}

function selectScenarios(options, extraScenarios) {
  var scenarios = KPI_ONLY_SCENARIOS.concat(MATRIX_SCENARIOS, extraScenarios || []);

  if (options.scenarioRegex) {
    var matcher = new RegExp(options.scenarioRegex);
    scenarios = scenarios.filter(function(scenario) {
      return matcher.test(scenario.id);
    });
  }

  if (options.maxScenarios != null) {
    scenarios = scenarios.slice(0, options.maxScenarios);
  }

  return scenarios;
}

function selectModes(options) {
  if (!options.modes || !options.modes.length) {
    return MODES.slice();
  }

  var allowed = new Set(options.modes);
  var selected = MODES.filter(function(mode) {
    return allowed.has(mode.id);
  });

  if (!selected.length) {
    throw new Error(`No benchmark modes matched: ${options.modes.join(', ')}`);
  }

  return selected;
}

function saveResults(output, options) {
  if (!options.save) {
    return null;
  }

  var outputPath = options.out;
  if (!outputPath) {
    var stamp = createTimestamp(new Date());
    outputPath = path.join(DEFAULT_OUTPUT_DIR, `benchmark-arrow-${stamp}.json`);
  }

  var absolutePath = path.resolve(process.cwd(), outputPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(output, null, 2) + '\n');
  return absolutePath;
}

var options = parseArgs(process.argv.slice(2));
var selectedModes = selectModes(options);
var arrowModule = await loadArrowModule();
var tableFromIPC = getTableFromIPC(arrowModule);

if (typeof tableFromIPC !== 'function') {
  throw new Error('Arrow module does not export tableFromIPC.');
}

var filePath = path.resolve(process.cwd(), options.file);
var bytes = fs.readFileSync(filePath);
var table = tableFromIPC(bytes);
var fields = getFieldNames(table);

for (var fieldKey in DEFAULT_FIELDS) {
  if (!fields.includes(DEFAULT_FIELDS[fieldKey])) {
    throw new Error(`Required benchmark field is missing from ${filePath}: ${DEFAULT_FIELDS[fieldKey]}`);
  }
}

var allFieldPlans = buildAllFieldPlans(table, fields, options);
var activeAllFieldPlans = allFieldPlans.filter(isActiveFilterPlan);
var allFieldScenarios = buildAllFieldScenarios(activeAllFieldPlans, fields.length);
var interactiveScenarios = selectScenarios(options, allFieldScenarios);
var scenarioDefinitions = [{
  id: 'build_dashboard',
  family: 'build',
  description: 'Create crossfilter, dimensions for all fields, KPI reducers, grouped reducers, and an all-field digest, then read them once.',
  includeGroups: true,
  filters: null
}].concat(interactiveScenarios);
var selections = {
  country: {
    single: pickValues(table, DEFAULT_FIELDS.country, 1),
    multi: pickValues(table, DEFAULT_FIELDS.country, Math.max(2, options.countryValues))
  },
  event: {
    single: pickValues(table, DEFAULT_FIELDS.event, 1),
    multi: pickValues(table, DEFAULT_FIELDS.event, Math.max(2, options.eventValues))
  },
  region: {
    single: pickValues(table, DEFAULT_FIELDS.region, 1),
    multi: pickValues(table, DEFAULT_FIELDS.region, Math.max(2, options.regionValues))
  },
  timeRange: pickNumericRange(table, DEFAULT_FIELDS.time, options.timeSampleSize),
  allFields: allFieldPlans,
  activeAllFields: activeAllFieldPlans
};

logProgress(`loaded ${filePath} (${table.numRows} rows, ${fields.length} columns)`);
logProgress(`using ${allFieldPlans.length} scalar field plan(s), ${activeAllFieldPlans.length} active filter plan(s), across all ${fields.length} columns`);
logProgress(`running ${selectedModes.length} mode(s) across ${interactiveScenarios.length + 1} workload(s)`);

var lowLevel = {
  decode_arrow: bench(options.iterations, options.warmup, function() {
    tableFromIPC(bytes);
  }),
  materialize_rows: bench(options.iterations, options.warmup, function() {
    materializeRows(table);
  })
};
var resultsByMode = {};

for (var modeIndex = 0; modeIndex < selectedModes.length; ++modeIndex) {
  var mode = selectedModes[modeIndex];
  logProgress(`mode ${modeIndex + 1}/${selectedModes.length}: ${mode.id} - build_dashboard`);

  var workloads = {
    build_dashboard: benchBuildScenario(table, DEFAULT_FIELDS, allFieldPlans, mode, options.iterations, options.warmup)
  };
  var environment = createEnvironment(table, DEFAULT_FIELDS, allFieldPlans, mode);

  try {
    for (var scenarioIndex = 0; scenarioIndex < interactiveScenarios.length; ++scenarioIndex) {
      var scenario = interactiveScenarios[scenarioIndex];
      logProgress(`mode ${modeIndex + 1}/${selectedModes.length}: ${mode.id} - scenario ${scenarioIndex + 1}/${interactiveScenarios.length} ${scenario.id}`);
      workloads[scenario.id] = benchInteractiveScenario(environment, selections, mode, scenario, options.iterations, options.warmup);
    }

    resultsByMode[mode.id] = {
      label: mode.label,
      config: {
        source: mode.source,
        wasm: mode.wasm,
        filterStrategy: mode.filterStrategy,
        kpiStrategy: mode.kpiStrategy
      },
      runtime: environment.runtime,
      summary: summarizeMode(workloads, interactiveScenarios),
      workloads: workloads
    };
  } finally {
    environment.dispose();
  }
}

var output = {
  file: filePath,
  rows: table.numRows,
  columns: fields.length,
  benchmarkFields: DEFAULT_FIELDS,
  allFieldsUsed: fields,
  allFieldPlans: allFieldPlans.map(function(plan) {
    return {
      field: plan.field,
      kind: plan.kind,
      activeForFiltering: isActiveFilterPlan(plan),
      discreteValueCount: plan.kind === 'discrete' ? {
        single: plan.single.length,
        multi: plan.multi.length
      } : null,
      range: plan.kind === 'range' ? plan.range : null
    };
  }),
  activeFilterFieldCount: activeAllFieldPlans.length,
  selections: selections,
  iterations: options.iterations,
  warmup: options.warmup,
  lowLevel: lowLevel,
  scenarioCount: scenarioDefinitions.length,
  workloads: Object.fromEntries(scenarioDefinitions.map(function(scenario) {
    return [scenario.id, {
      family: scenario.family,
      description: scenario.description,
      includeGroups: scenario.includeGroups,
      filters: scenario.filters || null,
      applyAllFieldsMode: scenario.applyAllFieldsMode || null
    }];
  })),
  modes: resultsByMode,
  comparisons: {}
};

if (resultsByMode.row_baseline && resultsByMode.row_native) {
  output.comparisons.row_native_vs_row_baseline = compareModes(resultsByMode, 'row_baseline', 'row_native', scenarioDefinitions.filter(function(scenario) {
    return resultsByMode.row_baseline.workloads[scenario.id] && resultsByMode.row_native.workloads[scenario.id];
  }));
}
if (resultsByMode.row_native && resultsByMode.arrow_js) {
  output.comparisons.arrow_js_vs_row_native = compareModes(resultsByMode, 'row_native', 'arrow_js', scenarioDefinitions.filter(function(scenario) {
    return resultsByMode.row_native.workloads[scenario.id] && resultsByMode.arrow_js.workloads[scenario.id];
  }));
}
if (resultsByMode.arrow_js && resultsByMode.arrow_wasm) {
  output.comparisons.arrow_wasm_vs_arrow_js = compareModes(resultsByMode, 'arrow_js', 'arrow_wasm', scenarioDefinitions.filter(function(scenario) {
    return resultsByMode.arrow_js.workloads[scenario.id] && resultsByMode.arrow_wasm.workloads[scenario.id];
  }));
}
if (resultsByMode.row_baseline && resultsByMode.arrow_wasm) {
  output.comparisons.arrow_wasm_vs_row_baseline = compareModes(resultsByMode, 'row_baseline', 'arrow_wasm', scenarioDefinitions.filter(function(scenario) {
    return resultsByMode.row_baseline.workloads[scenario.id] && resultsByMode.arrow_wasm.workloads[scenario.id];
  }));
}

var savedPath = saveResults(output, options);
if (savedPath) {
  logProgress(`saved results to ${savedPath}`);
}
console.log(JSON.stringify(output, null, 2));
