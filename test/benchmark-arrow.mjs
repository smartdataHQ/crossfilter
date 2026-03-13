import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import crossfilter from '../main.js';

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const options = {
    file: 'test/data/poi-stays.arrow',
    field: null,
    values: 3,
    iterations: 200,
    warmup: 20
  };

  for (let i = 0; i < argv.length; ++i) {
    const arg = argv[i];
    if (arg === '--field') {
      options.field = argv[++i];
    } else if (arg === '--values') {
      options.values = Number(argv[++i]);
    } else if (arg === '--iterations') {
      options.iterations = Number(argv[++i]);
    } else if (arg === '--warmup') {
      options.warmup = Number(argv[++i]);
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
    'Usage: node test/benchmark-arrow.mjs [file] [--field name] [--values n] [--iterations n] [--warmup n]',
    '',
    'Environment:',
    '  CROSSFILTER_ARROW_MODULE  Optional module specifier for apache-arrow,',
    '                            e.g. /absolute/path/to/Arrow.node.mjs'
  ].join('\n'));
}

async function loadArrowModule() {
  const override = process.env.CROSSFILTER_ARROW_MODULE;
  if (override) {
    return import(override);
  }

  try {
    return await import('apache-arrow/Arrow.node.mjs');
  } catch (nodeError) {
    try {
      return await import('apache-arrow');
    } catch (packageError) {
      const error = new Error(
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
    const byName = table.getChild(fieldName);
    if (byName != null) {
      return byName;
    }
  }
  if (typeof table.getColumn === 'function') {
    const byColumn = table.getColumn(fieldName);
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
  const fields = getFieldNames(table);
  const columns = fields.map(function(field, fieldIndex) {
    return getColumn(table, field, fieldIndex);
  });
  const rows = new Array(table.numRows);

  for (let rowIndex = 0; rowIndex < table.numRows; ++rowIndex) {
    const row = {};
    for (let fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
      row[fields[fieldIndex]] = getValue(columns[fieldIndex], rowIndex);
    }
    rows[rowIndex] = row;
  }

  return rows;
}

function stats(samples) {
  const sorted = samples.slice().sort(function(a, b) { return a - b; });
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = samples.reduce(function(sum, value) { return sum + value; }, 0) / samples.length;
  const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];
  return { median, mean, p95 };
}

function bench(iterations, warmup, fn) {
  for (let i = 0; i < warmup; ++i) {
    fn();
  }

  const samples = new Array(iterations);
  for (let i = 0; i < iterations; ++i) {
    const t0 = performance.now();
    fn();
    samples[i] = performance.now() - t0;
  }

  return stats(samples);
}

function pickField(table, requestedField) {
  const fields = getFieldNames(table);
  if (requestedField) {
    if (!fields.includes(requestedField)) {
      throw new Error(`Field not found: ${requestedField}`);
    }
    return requestedField;
  }

  for (let fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
    const field = fields[fieldIndex];
    const column = getColumn(table, field, fieldIndex);
    const seen = new Set();
    for (let rowIndex = 0; rowIndex < table.numRows && rowIndex < 4096; ++rowIndex) {
      const value = getValue(column, rowIndex);
      if (value == null || typeof value === 'object') {
        continue;
      }
      seen.add(value);
      if (seen.size >= 3) {
        return field;
      }
    }
  }

  throw new Error('Could not find a scalar field with at least three distinct values. Pass --field explicitly.');
}

function pickValues(table, field, count) {
  const fields = getFieldNames(table);
  const fieldIndex = fields.indexOf(field);
  const column = getColumn(table, field, fieldIndex);
  const seen = new Set();
  const values = [];

  for (let rowIndex = 0; rowIndex < table.numRows && values.length < count; ++rowIndex) {
    const value = getValue(column, rowIndex);
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

const options = parseArgs(process.argv.slice(2));
const arrowModule = await loadArrowModule();
const tableFromIPC = getTableFromIPC(arrowModule);

if (typeof tableFromIPC !== 'function') {
  throw new Error('Arrow module does not export tableFromIPC.');
}

const filePath = path.resolve(process.cwd(), options.file);
const bytes = fs.readFileSync(filePath);
const table = tableFromIPC(bytes);
const field = pickField(table, options.field);
const selectedMany = pickValues(table, field, Math.max(1, options.values));
const selectedSingle = selectedMany[0];
const selectedSet = new Set(selectedMany);

const results = {
  decode_arrow: bench(options.iterations, options.warmup, function() {
    tableFromIPC(bytes);
  }),
  materialize_rows: bench(options.iterations, options.warmup, function() {
    materializeRows(table);
  }),
  row_path_plus_dimension: bench(options.iterations, options.warmup, function() {
    const cf = crossfilter(materializeRows(table));
    cf.dimension(field);
  }),
  from_arrow_table: bench(options.iterations * 2, options.warmup, function() {
    crossfilter.fromArrowTable(table);
  }),
  from_arrow_table_plus_dimension: bench(options.iterations * 2, options.warmup, function() {
    const cf = crossfilter.fromArrowTable(table);
    cf.dimension(field);
  })
};

const rowPath = crossfilter(materializeRows(table));
const rowDimension = rowPath.dimension(field);
const arrowPath = crossfilter.fromArrowTable(table);
const arrowDimension = arrowPath.dimension(field);

for (let i = 0; i < options.warmup * 5; ++i) {
  rowDimension.filterExact(selectedSingle);
  rowDimension.filterAll();
  rowDimension.filterFunction(function(value) { return selectedSet.has(value); });
  rowDimension.filterAll();
  arrowDimension.filterExact(selectedSingle);
  arrowDimension.filterAll();
  arrowDimension.filterIn(selectedMany);
  arrowDimension.filterAll();
}

results.row_path_filter_exact = bench(options.iterations * 20, 0, function() {
  rowDimension.filterExact(selectedSingle);
  rowDimension.filterAll();
});
results.arrow_path_filter_exact = bench(options.iterations * 20, 0, function() {
  arrowDimension.filterExact(selectedSingle);
  arrowDimension.filterAll();
});
results.row_path_filter_function_multi = bench(options.iterations * 15, 0, function() {
  rowDimension.filterFunction(function(value) { return selectedSet.has(value); });
  rowDimension.filterAll();
});
results.arrow_path_filter_in_multi = bench(options.iterations * 15, 0, function() {
  arrowDimension.filterIn(selectedMany);
  arrowDimension.filterAll();
});

console.log(JSON.stringify({
  file: filePath,
  rows: table.numRows,
  columns: getFieldNames(table).length,
  field: field,
  selectedSingle: selectedSingle,
  selectedMany: selectedMany,
  iterations: options.iterations,
  warmup: options.warmup,
  results: results
}, null, 2));
