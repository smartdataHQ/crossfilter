export const COLUMNAR_BATCH_KEY = typeof Symbol !== "undefined"
  ? Symbol.for("crossfilter2.columnarBatch")
  : "__crossfilter2ColumnarBatch__";

function isArrayIndex(prop) {
  if (typeof prop === "symbol") {
    return false;
  }
  var index = Number(prop);
  return String(index) === prop && index >= 0 && Number.isInteger(index);
}

export function getColumnValue(column, index) {
  if (column == null) {
    return undefined;
  }
  if (typeof column.get === "function") {
    return column.get(index);
  }
  if (typeof column.at === "function") {
    return column.at(index);
  }
  return column[index];
}

function getColumnLength(column) {
  if (column == null) {
    return undefined;
  }
  if (typeof column.length === "number") {
    return column.length;
  }
  if (typeof column.size === "number") {
    return column.size;
  }
  return undefined;
}

function inferFields(columns, fields) {
  if (fields && fields.length) {
    return fields.slice();
  }
  return Object.keys(columns);
}

function inferLength(columns, fields, explicitLength) {
  if (typeof explicitLength === "number") {
    return explicitLength;
  }

  for (var i = 0; i < fields.length; ++i) {
    var columnLength = getColumnLength(columns[fields[i]]);
    if (typeof columnLength === "number") {
      return columnLength;
    }
  }

  return 0;
}

function maybeTransformColumns(columns, fields, length, transforms) {
  if (!transforms) {
    return columns;
  }

  var transformed = Object.assign({}, columns);
  for (var i = 0; i < fields.length; ++i) {
    var field = fields[i];
    var transform = transforms[field];
    if (typeof transform !== "function") {
      continue;
    }
    var values = new Array(length);
    for (var rowIndex = 0; rowIndex < length; ++rowIndex) {
      values[rowIndex] = transform(getColumnValue(columns[field], rowIndex), rowIndex);
    }
    transformed[field] = values;
  }

  return transformed;
}

export function getColumnarBatch(records) {
  return records && records[COLUMNAR_BATCH_KEY]
    ? records[COLUMNAR_BATCH_KEY]
    : null;
}

export function materializeColumnarRow(batch, index) {
  var cached = batch.rows[index];
  if (cached !== undefined || index in batch.rows) {
    return cached;
  }

  var row;
  if (typeof batch.rowFactory === "function") {
    row = batch.rowFactory(index, batch.columns, batch.fields);
  } else {
    row = {};
    for (var fieldIndex = 0; fieldIndex < batch.fields.length; ++fieldIndex) {
      var field = batch.fields[fieldIndex];
      row[field] = getColumnValue(batch.columns[field], index);
    }
  }

  batch.rows[index] = row;
  return row;
}

export function rowsFromColumns(columns, options) {
  options = options || {};

  var fields = inferFields(columns, options.fields);
  var length = inferLength(columns, fields, options.length);
  var transformedColumns = maybeTransformColumns(columns, fields, length, options.transforms);
  var rows = new Array(length);
  var batch = {
    columns: transformedColumns,
    fields: fields,
    length: length,
    rowFactory: typeof options.rowFactory === "function" ? options.rowFactory : null,
    rows: rows
  };

  Object.defineProperty(rows, COLUMNAR_BATCH_KEY, {
    configurable: true,
    enumerable: false,
    value: batch,
    writable: false
  });

  return new Proxy(rows, {
    get: function(target, prop, receiver) {
      if (prop === COLUMNAR_BATCH_KEY) {
        return batch;
      }
      if (isArrayIndex(prop)) {
        var index = Number(prop);
        if (index < 0 || index >= batch.length) {
          return undefined;
        }
        return materializeColumnarRow(batch, index);
      }
      return Reflect.get(target, prop, receiver);
    },
    has: function(target, prop) {
      if (isArrayIndex(prop)) {
        var index = Number(prop);
        return index >= 0 && index < batch.length;
      }
      return Reflect.has(target, prop);
    }
  });
}

function getArrowFieldNames(table, explicitFields) {
  if (explicitFields && explicitFields.length) {
    return explicitFields.slice();
  }

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

function getArrowColumn(table, fieldName, fieldIndex) {
  if (table == null) {
    return undefined;
  }
  if (typeof table.getChild === "function") {
    var byName = table.getChild(fieldName);
    if (byName != null) {
      return byName;
    }
  }
  if (typeof table.getColumn === "function") {
    var byColumn = table.getColumn(fieldName);
    if (byColumn != null) {
      return byColumn;
    }
  }
  if (typeof table.getChildAt === "function") {
    return table.getChildAt(fieldIndex);
  }
  return table[fieldName];
}

export function rowsFromArrowTable(table, options) {
  options = options || {};

  var fields = getArrowFieldNames(table, options.fields);
  var columns = {};
  for (var i = 0; i < fields.length; ++i) {
    columns[fields[i]] = getArrowColumn(table, fields[i], i);
  }

  return rowsFromColumns(columns, {
    fields: fields,
    length: typeof table.numRows === "number" ? table.numRows : options.length,
    rowFactory: options.rowFactory,
    transforms: options.transforms
  });
}
