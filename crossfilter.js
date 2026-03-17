// https://github.com/smartdataHQ/crossfilter v2.0.1 Copyright 2026 SmartData HQ
(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? module.exports = factory() :
  typeof define === 'function' && define.amd ? define(factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, global.crossfilter = factory());
})(this, (function () { 'use strict';

  let array8 = arrayUntyped,
      array16 = arrayUntyped,
      array32 = arrayUntyped,
      arrayLengthen = arrayLengthenUntyped,
      arrayWiden = arrayWidenUntyped;
  if (typeof Uint8Array !== "undefined") {
    array8 = function(n) { return new Uint8Array(n); };
    array16 = function(n) { return new Uint16Array(n); };
    array32 = function(n) { return new Uint32Array(n); };

    arrayLengthen = function(array, length) {
      if (array.length >= length) return array;
      var copy = new array.constructor(length);
      copy.set(array);
      return copy;
    };

    arrayWiden = function(array, width) {
      var copy;
      switch (width) {
        case 16: copy = array16(array.length); break;
        case 32: copy = array32(array.length); break;
        default: throw new Error("invalid array width!");
      }
      copy.set(array);
      return copy;
    };
  }

  function arrayUntyped(n) {
    var array = new Array(n), i = -1;
    while (++i < n) array[i] = 0;
    return array;
  }

  function arrayLengthenUntyped(array, length) {
    var n = array.length;
    while (n < length) array[n++] = 0;
    return array;
  }

  function arrayWidenUntyped(array, width) {
    if (width > 32) throw new Error("invalid array width!");
    return array;
  }

  // An arbitrarily-wide array of bitmasks
  function bitarray(n) {
    this.length = n;
    this.subarrays = 1;
    this.width = 8;
    this.masks = {
      0: 0
    };

    this[0] = array8(n);
  }

  bitarray.prototype.lengthen = function(n) {
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      this[i] = arrayLengthen(this[i], n);
    }
    this.length = n;
  };

  // Reserve a new bit index in the array, returns {offset, one}
  bitarray.prototype.add = function() {
    var m, w, one, i, len;

    for (i = 0, len = this.subarrays; i < len; ++i) {
      m = this.masks[i];
      w = this.width - (32 * i);
      // isolate the rightmost zero bit and return it as an unsigned int of 32 bits, if NaN or -1, return a 0 
      one = (~m & (m + 1)) >>> 0;

      if (w >= 32 && !one) {
        continue;
      }

      if (w < 32 && (one & (1 << w))) {
        // widen this subarray
        this[i] = arrayWiden(this[i], w <<= 1);
        this.width = 32 * i + w;
      }

      this.masks[i] |= one;

      return {
        offset: i,
        one: one
      };
    }

    // add a new subarray
    this[this.subarrays] = array8(this.length);
    this.masks[this.subarrays] = 1;
    this.width += 8;
    return {
      offset: this.subarrays++,
      one: 1
    };
  };

  // Copy record from index src to index dest
  bitarray.prototype.copy = function(dest, src) {
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      this[i][dest] = this[i][src];
    }
  };

  // Truncate the array to the given length
  bitarray.prototype.truncate = function(n) {
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      for (var j = this.length - 1; j >= n; j--) {
        this[i][j] = 0;
      }
    }
    this.length = n;
  };

  // Checks that all bits for the given index are 0
  bitarray.prototype.zero = function(n) {
    if (this.subarrays === 1) {
      return !this[0][n];
    }
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      if (this[i][n]) {
        return false;
      }
    }
    return true;
  };

  // Checks that all bits for the given index are 0 except for possibly one
  bitarray.prototype.zeroExcept = function(n, offset, zero) {
    if (this.subarrays === 1) {
      var mask = this[0][n];
      return !(offset === 0 ? mask & zero : mask);
    }
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      if (i === offset ? this[i][n] & zero : this[i][n]) {
        return false;
      }
    }
    return true;
  };

  // Checks that all bits for the given index are 0 except for the specified mask.
  // The mask should be an array of the same size as the filter subarrays width.
  bitarray.prototype.zeroExceptMask = function(n, mask) {
    if (this.subarrays === 1) {
      return !(this[0][n] & mask[0]);
    }
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      if (this[i][n] & mask[i]) {
        return false;
      }
    }
    return true;
  };

  // Checks that only the specified bit is set for the given index
  bitarray.prototype.only = function(n, offset, one) {
    if (this.subarrays === 1) {
      return this[0][n] === (offset === 0 ? one : 0);
    }
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      if (this[i][n] != (i === offset ? one : 0)) {
        return false;
      }
    }
    return true;
  };

  // Checks that only the specified bit is set for the given index except for possibly one other
  bitarray.prototype.onlyExcept = function(n, offset, zero, onlyOffset, onlyOne) {
    if (this.subarrays === 1) {
      var masked = this[0][n];
      if (offset === 0) {
        masked = (masked & zero) >>> 0;
      }
      return masked === (onlyOffset === 0 ? onlyOne : 0);
    }
    var mask;
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      mask = this[i][n];
      if (i === offset)
        mask = (mask & zero) >>> 0;
      if (mask != (i === onlyOffset ? onlyOne : 0)) {
        return false;
      }
    }
    return true;
  };

  var xfilterArray = {
    array8: array8,
    array16: array16,
    array32: array32,
    arrayLengthen: arrayLengthen,
    arrayWiden: arrayWiden,
    bitarray: bitarray
  };

  const filterExact = (bisect, value) => {
    return function(values) {
      var n = values.length;
      return [bisect.left(values, value, 0, n), bisect.right(values, value, 0, n)];
    };
  };

  const filterRange = (bisect, range) => {
    var min = range[0],
        max = range[1];
    return function(values) {
      var n = values.length;
      return [bisect.left(values, min, 0, n), bisect.left(values, max, 0, n)];
    };
  };

  const filterAll = values => {
    return [0, values.length];
  };

  var xfilterFilter = {
    filterExact,
    filterRange,
    filterAll
  };

  var cr_identity = d => {
    return d;
  };

  var cr_null = () =>  {
    return null;
  };

  var cr_zero = () => {
    return 0;
  };

  function heap_by(f) {

    // Builds a binary heap within the specified array a[lo:hi]. The heap has the
    // property such that the parent a[lo+i] is always less than or equal to its
    // two children: a[lo+2*i+1] and a[lo+2*i+2].
    function heap(a, lo, hi) {
      var n = hi - lo,
          i = (n >>> 1) + 1;
      while (--i > 0) sift(a, i, n, lo);
      return a;
    }

    // Sorts the specified array a[lo:hi] in descending order, assuming it is
    // already a heap.
    function sort(a, lo, hi) {
      var n = hi - lo,
          t;
      while (--n > 0) t = a[lo], a[lo] = a[lo + n], a[lo + n] = t, sift(a, 1, n, lo);
      return a;
    }

    // Sifts the element a[lo+i-1] down the heap, where the heap is the contiguous
    // slice of array a[lo:lo+n]. This method can also be used to update the heap
    // incrementally, without incurring the full cost of reconstructing the heap.
    function sift(a, i, n, lo) {
      var d = a[--lo + i],
          x = f(d),
          child;
      while ((child = i << 1) <= n) {
        if (child < n && f(a[lo + child]) > f(a[lo + child + 1])) child++;
        if (x <= f(a[lo + child])) break;
        a[lo + i] = a[lo + child];
        i = child;
      }
      a[lo + i] = d;
    }

    heap.sort = sort;
    return heap;
  }

  const h$1 = heap_by(cr_identity);
  h$1.by = heap_by;

  function heapselect_by(f) {
    var heap = h$1.by(f);

    // Returns a new array containing the top k elements in the array a[lo:hi].
    // The returned array is not sorted, but maintains the heap property. If k is
    // greater than hi - lo, then fewer than k elements will be returned. The
    // order of elements in a is unchanged by this operation.
    function heapselect(a, lo, hi, k) {
      var queue = new Array(k = Math.min(hi - lo, k)),
          min,
          i,
          d;

      for (i = 0; i < k; ++i) queue[i] = a[lo++];
      heap(queue, 0, k);

      if (lo < hi) {
        min = f(queue[0]);
        do {
          if (f(d = a[lo]) > min) {
            queue[0] = d;
            min = f(heap(queue, 0, k)[0]);
          }
        } while (++lo < hi);
      }

      return queue;
    }

    return heapselect;
  }


  const h = heapselect_by(cr_identity);
  h.by = heapselect_by; // assign the raw function to the export as well

  function primitiveValue(value) {
    if (value == null || typeof value !== 'object') {
      return value;
    }

    if (typeof value.valueOf === 'function') {
      var primitive = value.valueOf();
      if (primitive !== value) {
        return primitive;
      }
    }

    if (typeof value.toString === 'function') {
      var text = value.toString();
      if (text !== value) {
        return text;
      }
    }

    return value;
  }

  function typeRank(value) {
    if (value === null) {
      return 0;
    }

    switch (typeof value) {
      case 'boolean':
        return 1;
      case 'number':
        return 2;
      case 'bigint':
        return 3;
      case 'string':
        return 4;
      case 'symbol':
        return 5;
      case 'undefined':
        return 6;
      default:
        return 7;
    }
  }

  function equivalentByNaturalCoercion(left, right) {
    if (typeof left === 'symbol' || typeof right === 'symbol') {
      return false;
    }

    var numericLeft = Number(left),
        numericRight = Number(right);

    return numericLeft === numericRight && numericLeft === numericLeft;
  }

  function compareNaturalOrder(left, right) {
    var a = primitiveValue(left),
        b = primitiveValue(right),
        rankA,
        rankB,
        descA,
        descB,
        textA,
        textB;

    if (Object.is(a, b) || a === b) {
      return 0;
    }

    if (typeof a !== 'symbol' && typeof b !== 'symbol') {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      if (equivalentByNaturalCoercion(a, b)) {
        return 0;
      }
    }

    rankA = typeRank(a);
    rankB = typeRank(b);

    if (rankA !== rankB) {
      return rankA - rankB;
    }

    if (rankA === 5) {
      descA = a.description;
      descB = b.description;
      if (descA === descB) {
        return 0;
      }
      if (descA == null) {
        return -1;
      }
      if (descB == null) {
        return 1;
      }
      return descA < descB ? -1 : 1;
    }

    textA = String(a);
    textB = String(b);
    if (textA < textB) {
      return -1;
    }
    if (textA > textB) {
      return 1;
    }

    return 0;
  }

  function isNaturallyOrderable(value) {
    var normalized = primitiveValue(value);

    if (normalized === null) {
      return true;
    }
    if (normalized === undefined) {
      return false;
    }
    if (typeof normalized === 'number') {
      return normalized === normalized;
    }

    return true;
  }

  function bisect_by(f) {

    // Locate the insertion point for x in a to maintain sorted order. The
    // arguments lo and hi may be used to specify a subset of the array which
    // should be considered; by default the entire array is used. If x is already
    // present in a, the insertion point will be before (to the left of) any
    // existing entries. The return value is suitable for use as the first
    // argument to `array.splice` assuming that a is already sorted.
    //
    // The returned insertion point i partitions the array a into two halves so
    // that all v < x for v in a[lo:i] for the left side and all v >= x for v in
    // a[i:hi] for the right side.
    function bisectLeft(a, x, lo, hi) {
      while (lo < hi) {
        var mid = lo + hi >>> 1;
        if (compareNaturalOrder(f(a[mid]), x) < 0) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    }

    // Similar to bisectLeft, but returns an insertion point which comes after (to
    // the right of) any existing entries of x in a.
    //
    // The returned insertion point i partitions the array into two halves so that
    // all v <= x for v in a[lo:i] for the left side and all v > x for v in
    // a[i:hi] for the right side.
    function bisectRight(a, x, lo, hi) {
      while (lo < hi) {
        var mid = lo + hi >>> 1;
        if (compareNaturalOrder(x, f(a[mid])) < 0) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }

    bisectRight.right = bisectRight;
    bisectRight.left = bisectLeft;
    return bisectRight;
  }

  const bisect = bisect_by(cr_identity);
  bisect.by = bisect_by; // assign the raw function to the export as well

  var permute = (array, index, deep) => {
    for (var i = 0, n = index.length, copy = deep ? JSON.parse(JSON.stringify(array)) : new Array(n); i < n; ++i) {
      copy[i] = array[index[i]];
    }
    return copy;
  };

  const reduceIncrement = p => {
    return p + 1;
  };

  const reduceDecrement = p => {
    return p - 1;
  };

  const reduceAdd = f => {
    return function(p, v) {
      return p + +f(v);
    };
  };

  const reduceSubtract = f => {
    return function(p, v) {
      return p - f(v);
    };
  };

  var xfilterReduce = {
    reduceIncrement,
    reduceDecrement,
    reduceAdd,
    reduceSubtract
  };

  function deep(t,e,i,n,r){for(r in n=(i=i.split(".")).splice(-1,1),i)e=e[i[r]]=e[i[r]]||{};return t(e,n)}

  // Note(cg): result was previsouly using lodash.result, not ESM compatible.
   
  const get = (obj, prop) => {
    const value = obj[prop];
    return (typeof value === 'function') ? value.call(obj) : value;
  };

  /**
   * get value of object at a deep path.
   * if the resolved value is a function,
   * it's invoked with the `this` binding of 
   * its parent object and its result is returned. 
   *  
   * @param  {Object} obj  the object (e.g. { 'a': [{ 'b': { 'c1': 3, 'c2': 4} }], 'd': {e:1} }; )
   * @param  {String} path deep path (e.g. `d.e`` or `a[0].b.c1`. Dot notation (a.0.b)is also supported)
   * @return {Any}      the resolved value
   */
  const reg = /\[([\w\d]+)\]/g;
  var result = (obj, path) => {
    return deep(get, obj, path.replace(reg, '.$1'))
  };

  const COLUMNAR_BATCH_KEY = typeof Symbol !== "undefined"
    ? Symbol.for("crossfilter2.columnarBatch")
    : "__crossfilter2ColumnarBatch__";

  function isArrayIndex(prop) {
    if (typeof prop === "symbol") {
      return false;
    }
    var index = Number(prop);
    return String(index) === prop && index >= 0 && Number.isInteger(index);
  }

  function getColumnAccessor(column) {
    if (column == null) {
      return function() { return undefined; };
    }
    if (typeof column.get === "function") {
      return function(index) { return column.get(index); };
    }
    if (typeof column.at === "function") {
      return function(index) { return column.at(index); };
    }
    return function(index) { return column[index]; };
  }

  function getColumnValue(column, index) {
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

  function getColumnarBatch(records) {
    return records && records[COLUMNAR_BATCH_KEY]
      ? records[COLUMNAR_BATCH_KEY]
      : null;
  }

  function materializeColumnarRow(batch, index) {
    if (batch.materialized[index]) {
      return batch.rows[index];
    }

    var row;
    if (typeof batch.rowFactory === "function") {
      row = batch.rowFactory(index, batch.columns, batch.fields, batch.accessors);
    } else {
      row = {};
      for (var fieldIndex = 0; fieldIndex < batch.fields.length; ++fieldIndex) {
        row[batch.fields[fieldIndex]] = batch.accessors[fieldIndex](index);
      }
    }

    batch.rows[index] = row;
    batch.materialized[index] = 1;
    return row;
  }

  function createDefaultRowFactory(fields, accessors) {
    var fieldCount = fields.length;

    return function(index) {
      var row = {},
          fieldIndex = 0;

      for (; fieldIndex + 3 < fieldCount; fieldIndex += 4) {
        row[fields[fieldIndex]] = accessors[fieldIndex](index);
        row[fields[fieldIndex + 1]] = accessors[fieldIndex + 1](index);
        row[fields[fieldIndex + 2]] = accessors[fieldIndex + 2](index);
        row[fields[fieldIndex + 3]] = accessors[fieldIndex + 3](index);
      }

      for (; fieldIndex < fieldCount; ++fieldIndex) {
        row[fields[fieldIndex]] = accessors[fieldIndex](index);
      }

      return row;
    };
  }

  function rowsFromColumns(columns, options) {
    options = options || {};

    var fields = inferFields(columns, options.fields);
    var length = inferLength(columns, fields, options.length);
    var transformedColumns = maybeTransformColumns(columns, fields, length, options.transforms);
    var accessors = new Array(fields.length);
    var accessorsByField = {};

    for (var accessorIndex = 0; accessorIndex < fields.length; ++accessorIndex) {
      accessors[accessorIndex] = getColumnAccessor(transformedColumns[fields[accessorIndex]]);
      accessorsByField[fields[accessorIndex]] = accessors[accessorIndex];
    }

    var rows = new Array(length);
    var batch = {
      accessors: accessors,
      accessorsByField: accessorsByField,
      columns: transformedColumns,
      fields: fields,
      length: length,
      materialized: new Uint8Array(length),
      rowFactory: typeof options.rowFactory === "function"
        ? options.rowFactory
        : createDefaultRowFactory(fields, accessors),
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

  function rowsFromArrowTable(table, options) {
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
  var SMALL_DATA_WASM_THRESHOLD = 1000;
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
        var currentBytes = this.memory.buffer.byteLength;

        if (totalBytes <= currentBytes) {
          return this.memory.buffer;
        }

        var targetBytes = currentBytes;
        while (targetBytes < totalBytes) {
          targetBytes = targetBytes ? targetBytes * 2 : 65536;
        }

        var pagesNeeded = Math.ceil(targetBytes / 65536);
        var currentPages = currentBytes / 65536;

        this.memory.grow(pagesNeeded - currentPages);
        this.cachedCodes = null;
        this.cachedCodesLength = 0;
        this.cachedTargets = null;
        this.cachedTargetsLength = 0;
        this.cachedTargetsOffset = 0;

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

        // Zero marks region — it may contain stale data from prior matchSmall output
        new Uint32Array(buffer, markPtr, maxTargetCode + 1).fill(0);

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

  function ensureScratchCapacity(state, size) {
    if (state.scratch.length >= size) {
      return state.scratch;
    }

    var nextSize = state.scratch.length || 256;
    while (nextSize < size) {
      nextSize <<= 1;
    }

    state.scratch = new Uint32Array(nextSize);
    return state.scratch;
  }

  function denseLookupMatches(codes, targetCodes, state) {
    var matches = ensureScratchCapacity(state, codes.length);
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

  function createWasmRuntimeController(options) {
    var enabled = options && Object.prototype.hasOwnProperty.call(options, 'wasm')
      ? options.wasm !== false
      : defaultRuntimeOptions.wasm !== false;
    var denseLookupState = {
      marks: new Uint32Array(0),
      version: 1,
      scratch: new Uint32Array(0)
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

      if (runtime) {
        var useSmall = targetCodes.length <= SMALL_TARGET_WASM_THRESHOLD
          && codes.length <= SMALL_DATA_WASM_THRESHOLD;

        if (useSmall) {
          try {
            return runtime.matchSmall(codes, targetCodes);
          } catch (error) {
            sharedRuntimeState.error = error;
            sharedRuntimeState.runtime = null;
          }
        }
      }

      if (runtime) {
        maxTargetCode = Math.max(maxCodeValue(targetCodes), maxCodeValue(codes));
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

  function configureWasmRuntime(options) {
    if (options && Object.prototype.hasOwnProperty.call(options, 'wasm')) {
      defaultRuntimeOptions.wasm = options.wasm !== false;
    }
    return defaultRuntimeController.configureRuntime(options);
  }

  function getWasmRuntimeInfo() {
    return defaultRuntimeController.runtimeInfo();
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function uniqueFields(values) {
    var seen = new Set(),
        result = [];

    for (var i = 0; i < values.length; ++i) {
      if (!values[i] || seen.has(values[i])) {
        continue;
      }
      seen.add(values[i]);
      result.push(values[i]);
    }

    return result;
  }

  var TIME_BUCKET_MS = {
    minute: 60000,
    hour: 3600000,
    day: 86400000
  };

  function normalizeMetrics(metrics, prefix) {
    var normalized = (metrics && metrics.length ? metrics : [{ op: "count" }]).map(function(metric, metricIndex) {
      var id = metric.id || prefix + "_" + metricIndex;
      if (metric.op !== "count" && !metric.field) {
        throw new Error("Dashboard metric `" + id + "` requires a field.");
      }
      if (metric.op !== "count" && metric.op !== "sum" && metric.op !== "avg" && metric.op !== "avgNonZero") {
        throw new Error("Unsupported dashboard metric op: " + metric.op);
      }

      return {
        field: metric.field,
        id: id,
        op: metric.op || "count"
      };
    });

    return normalized;
  }

  function normalizeTimeBucketValue(value) {
    if (value == null) {
      return null;
    }

    if (value instanceof Date) {
      return value.getTime();
    }

    if (typeof value === "number") {
      return Number.isFinite(value) ? value : null;
    }

    var numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }

    var parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  function bucketTimestampValue(value, granularity) {
    var numeric = normalizeTimeBucketValue(value);
    if (numeric == null) {
      return null;
    }

    if (granularity === "month") {
      var monthDate = new Date(numeric);
      return Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1);
    }

    if (granularity === "week") {
      var weekDate = new Date(numeric);
      var day = weekDate.getUTCDay();
      var monday = new Date(Date.UTC(
        weekDate.getUTCFullYear(),
        weekDate.getUTCMonth(),
        weekDate.getUTCDate() - ((day + 6) % 7)
      ));
      return monday.getTime();
    }

    var step = TIME_BUCKET_MS[granularity];
    if (!step) {
      throw new Error("Unsupported dashboard time bucket granularity: " + granularity);
    }

    return Math.floor(numeric / step) * step;
  }

  function resolveGroupAccessor(spec) {
    if (!spec || !spec.bucket) {
      return null;
    }

    if (spec.bucket.type !== "timeBucket") {
      throw new Error("Unsupported dashboard group bucket type: " + spec.bucket.type);
    }

    var granularity = spec.bucket.granularity || "day";
    return function(value) {
      return bucketTimestampValue(value, granularity);
    };
  }

  function buildMetricReducer(metrics) {
    var metricSpec = metrics.map(function(metric) {
      return {
        field: metric.field || null,
        id: metric.id,
        op: metric.op
      };
    });

    function initial() {
      var state = {};

      for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
        var metric = metrics[metricIndex];
        if (metric.op === "avg" || metric.op === "avgNonZero") {
          state[metric.id] = { count: 0, sum: 0 };
        } else {
          state[metric.id] = 0;
        }
      }

      Object.defineProperties(state, {
        __cache: {
          configurable: true,
          enumerable: false,
          value: null,
          writable: true
        },
        __cacheVersion: {
          configurable: true,
          enumerable: false,
          value: -1,
          writable: true
        },
        __version: {
          configurable: true,
          enumerable: false,
          value: 0,
          writable: true
        }
      });

      return state;
    }

    function add(state, row) {
      for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
        var metric = metrics[metricIndex];
        var value;

        switch (metric.op) {
          case "count":
            state[metric.id] += 1;
            break;
          case "sum":
            value = row[metric.field];
            if (isFiniteNumber(value)) {
              state[metric.id] += value;
            }
            break;
          case "avg":
            value = row[metric.field];
            if (isFiniteNumber(value)) {
              state[metric.id].sum += value;
              state[metric.id].count += 1;
            }
            break;
          case "avgNonZero":
            value = row[metric.field];
            if (isFiniteNumber(value) && value !== 0) {
              state[metric.id].sum += value;
              state[metric.id].count += 1;
            }
            break;
        }
      }

      state.__version += 1;
      return state;
    }

    function remove(state, row) {
      for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
        var metric = metrics[metricIndex];
        var value;

        switch (metric.op) {
          case "count":
            state[metric.id] -= 1;
            break;
          case "sum":
            value = row[metric.field];
            if (isFiniteNumber(value)) {
              state[metric.id] -= value;
            }
            break;
          case "avg":
            value = row[metric.field];
            if (isFiniteNumber(value)) {
              state[metric.id].sum -= value;
              state[metric.id].count -= 1;
            }
            break;
          case "avgNonZero":
            value = row[metric.field];
            if (isFiniteNumber(value) && value !== 0) {
              state[metric.id].sum -= value;
              state[metric.id].count -= 1;
            }
            break;
        }
      }

      state.__version += 1;
      return state;
    }

    function finalize(state) {
      if (state.__cacheVersion === state.__version && state.__cache) {
        return state.__cache;
      }

      var result = {};

      for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
        var metric = metrics[metricIndex];
        var value = state[metric.id];

        if (metric.op === "avg" || metric.op === "avgNonZero") {
          result[metric.id] = value.count ? value.sum / value.count : null;
        } else {
          result[metric.id] = value;
        }
      }

      state.__cache = result;
      state.__cacheVersion = state.__version;
      return result;
    }

    add._xfilterMetricSpec = metricSpec;
    remove._xfilterMetricSpec = metricSpec;
    initial._xfilterMetricSpec = metricSpec;

    return {
      add: add,
      finalize: finalize,
      initial: initial,
      remove: remove
    };
  }

  function getNativeSumMetric(metrics) {
    return metrics && metrics.length === 1 && metrics[0].op === "sum"
      ? metrics[0]
      : null;
  }

  function createNativeSumAccessor(metric) {
    return function(row) {
      var value = row[metric.field];
      return isFiniteNumber(value) ? value : 0;
    };
  }

  function normalizeFilter(filter) {
    if (!filter || filter.type === "all") {
      return null;
    }

    if (filter.type === "exact") {
      return {
        type: "exact",
        value: filter.value
      };
    }

    if (filter.type === "in") {
      return {
        type: "in",
        values: Array.isArray(filter.values) ? filter.values.slice() : []
      };
    }

    if (filter.type === "range") {
      return {
        range: Array.isArray(filter.range) ? filter.range.slice() : [],
        type: "range"
      };
    }

    throw new Error("Unsupported dashboard filter type: " + filter.type);
  }

  function normalizeFilterState(filters) {
    var normalized = {};

    if (!filters) {
      return normalized;
    }

    for (var field in filters) {
      normalized[field] = normalizeFilter(filters[field]);
    }

    return normalized;
  }

  function sameFilter(left, right) {
    if (left === right) {
      return true;
    }
    if (!left || !right) {
      return !left && !right;
    }
    if (left.type !== right.type) {
      return false;
    }

    if (left.type === "exact") {
      return left.value === right.value;
    }

    var leftValues = left.type === "range" ? left.range : left.values;
    var rightValues = right.type === "range" ? right.range : right.values;

    if (!leftValues || !rightValues || leftValues.length !== rightValues.length) {
      return false;
    }

    for (var valueIndex = 0; valueIndex < leftValues.length; ++valueIndex) {
      if (leftValues[valueIndex] !== rightValues[valueIndex]) {
        return false;
      }
    }

    return true;
  }

  function applyFilter(dimension, filter) {
    if (!filter) {
      dimension.filterAll();
      return;
    }

    switch (filter.type) {
      case "exact":
        dimension.filterExact(filter.value);
        return;
      case "in":
        dimension.filterIn(filter.values);
        return;
      case "range":
        dimension.filterRange(filter.range);
        return;
    }
  }

  function normalizeGroupQuery(query) {
    if (query == null || query === true) {
      return null;
    }
    if (query === false) {
      return false;
    }

    return {
      includeKeys: Array.isArray(query.includeKeys) && query.includeKeys.length ? query.includeKeys.slice() : null,
      includeTotals: query.includeTotals !== false,
      keys: Array.isArray(query.keys) && query.keys.length ? query.keys.slice() : null,
      limit: typeof query.limit === "number" && query.limit >= 0 ? Math.floor(query.limit) : null,
      nonEmptyKeys: query.nonEmptyKeys === true,
      offset: typeof query.offset === "number" && query.offset >= 0 ? Math.floor(query.offset) : 0,
      search: typeof query.search === "string" && query.search ? query.search.toLowerCase() : null,
      sort: query.sort === "asc" || query.sort === "natural" ? query.sort : "desc",
      sortMetric: query.sortMetric || null,
      visibleOnly: query.visibleOnly !== false
    };
  }

  function metricComparableValue(metric, value) {
    if (!metric) {
      return 0;
    }

    if (metric.op === "avg" || metric.op === "avgNonZero") {
      return value && value.count ? value.sum / value.count : null;
    }

    return typeof value === "number" ? value : 0;
  }

  function metricHasVisibleValue(metric, value) {
    var comparable = metricComparableValue(metric, value);
    return comparable != null && comparable > 0;
  }

  function compareGroupKeys(left, right) {
    if (left === right) {
      return 0;
    }
    return String(left).localeCompare(String(right));
  }

  function insertSortedEntry(entries, entry, compare, maxSize) {
    var insertIndex = entries.length;

    if (maxSize != null && entries.length >= maxSize && compare(entry, entries[entries.length - 1]) >= 0) {
      return;
    }

    while (insertIndex > 0 && compare(entry, entries[insertIndex - 1]) < 0) {
      insertIndex -= 1;
    }

    entries.splice(insertIndex, 0, entry);
    if (maxSize != null && entries.length > maxSize) {
      entries.pop();
    }
  }

  function createKpiRuntime(cf, metrics) {
    var nativeSumMetric = getNativeSumMetric(metrics);
    var reducer = nativeSumMetric ? null : buildMetricReducer(metrics);
    var group = nativeSumMetric && typeof cf.groupAll === "function"
      ? cf.groupAll().reduceSum(createNativeSumAccessor(nativeSumMetric))
      : cf.groupAll().reduce(reducer.add, reducer.remove, reducer.initial);

    return {
      dispose: function() {
        group.dispose();
      },
      read: function() {
        if (nativeSumMetric) {
          var result = {};
          result[nativeSumMetric.id] = group.value();
          return result;
        }
        return reducer.finalize(group.value());
      }
    };
  }

  function createGroupRuntime(dimension, spec, index) {
    var metrics = normalizeMetrics(spec.metrics, spec.id || "group_" + index);
    var metricsById = {};
    var metricIndex;
    var nativeSumMetric = getNativeSumMetric(metrics);
    var reducer = nativeSumMetric ? null : buildMetricReducer(metrics);
    var groupAccessor = resolveGroupAccessor(spec);
    var group = groupAccessor ? dimension.group(groupAccessor) : dimension.group();
    var visibleMetric = null;
    var defaultSortMetric = null;
    var orderedMetricId = null;
    if (nativeSumMetric && typeof group.reduceSum === "function") {
      group.reduceSum(createNativeSumAccessor(nativeSumMetric));
    } else {
      group.reduce(reducer.add, reducer.remove, reducer.initial);
    }

    for (metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      metricsById[metrics[metricIndex].id] = metrics[metricIndex];
      if (!visibleMetric && metrics[metricIndex].op === "count") {
        visibleMetric = metrics[metricIndex];
      }
    }

    if (!visibleMetric) {
      visibleMetric = metrics[0] || null;
    }
    defaultSortMetric = metricsById[spec.sortMetric] || metricsById.rows || metrics[0] || null;

    function metricStateValue(value, metric) {
      if (!metric) {
        return 0;
      }
      if (nativeSumMetric) {
        return metric.id === nativeSumMetric.id ? value : 0;
      }
      return value ? value[metric.id] : 0;
    }

    function entryMetricValue(entry, metric) {
      return entry ? metricStateValue(entry.value, metric) : 0;
    }

    function finalizeEntryValue(value) {
      if (!nativeSumMetric) {
        return reducer.finalize(value);
      }

      var result = {};
      result[nativeSumMetric.id] = value;
      return result;
    }

    function finalizeEntry(entry) {
      return {
        key: entry.key,
        value: finalizeEntryValue(entry.value)
      };
    }

    function readAll() {
      return group.all().map(finalizeEntry);
    }

    function matchesGroupKey(key, query, keySet, forceInclude) {
      if (!forceInclude && query.nonEmptyKeys && (key == null || key === "")) {
        return false;
      }
      if (!forceInclude && keySet && !keySet.has(key)) {
        return false;
      }
      if (!forceInclude && query.search && String(key).toLowerCase().indexOf(query.search) < 0) {
        return false;
      }
      return true;
    }

    function compareEntries(query, sortMetric, left, right) {
      var diff = metricComparableValue(sortMetric, entryMetricValue(left, sortMetric)) - metricComparableValue(sortMetric, entryMetricValue(right, sortMetric));
      if (!Number.isFinite(diff) || diff === 0) {
        return compareGroupKeys(left.key, right.key);
      }
      return query.sort === "asc" ? diff : -diff;
    }

    function topComparableValue(sortMetric, entry) {
      var comparable = metricComparableValue(sortMetric, entryMetricValue(entry, sortMetric));
      return comparable == null ? Number.NEGATIVE_INFINITY : comparable;
    }

    function ensureTopOrder(sortMetric) {
      if (!sortMetric || typeof group.order !== "function" || typeof group.top !== "function") {
        return false;
      }
      if (orderedMetricId === sortMetric.id) {
        return true;
      }
      group.order(function(value) {
        var comparable = metricComparableValue(sortMetric, metricStateValue(value, sortMetric));
        return comparable == null ? Number.NEGATIVE_INFINITY : comparable;
      });
      orderedMetricId = sortMetric.id;
      return true;
    }

    function canUseTopQuery(normalized, sortMetric) {
      return !!(
        normalized
        && normalized.sort === "desc"
        && sortMetric
        && normalized.includeTotals === false
        && !normalized.includeKeys
        && !normalized.keys
        && !normalized.search
        && typeof group.size === "function"
        && ensureTopOrder(sortMetric)
      );
    }

    function readTopQuery(normalized, sortMetric) {
      var limitWindow = normalized.limit == null ? null : normalized.offset + normalized.limit;
      var groupSize = group.size();
      var requested = limitWindow == null
        ? groupSize
        : Math.min(groupSize, Math.max(limitWindow + 1, 32));
      var rawEntries;
      var filteredEntries;

      do {
        rawEntries = group.top(requested);
        filteredEntries = [];

        for (var rawIndex = 0; rawIndex < rawEntries.length; ++rawIndex) {
          var rawEntry = rawEntries[rawIndex];
          var visible = !normalized.visibleOnly || metricHasVisibleValue(visibleMetric, entryMetricValue(rawEntry, visibleMetric));
          if (visible && matchesGroupKey(rawEntry.key, normalized, null, false)) {
            filteredEntries.push(rawEntry);
          }
        }

        filteredEntries.sort(function(left, right) {
          return compareEntries(normalized, sortMetric, left, right);
        });

        if (limitWindow == null || requested >= groupSize) {
          break;
        }

        var shouldExpand = filteredEntries.length < limitWindow;
        if (!shouldExpand) {
          var boundaryEntry = filteredEntries[limitWindow - 1];
          shouldExpand = !!boundaryEntry
            && topComparableValue(sortMetric, rawEntries[rawEntries.length - 1]) >= topComparableValue(sortMetric, boundaryEntry);
        }

        if (!shouldExpand) {
          break;
        }

        requested = Math.min(groupSize, Math.max(requested + 32, requested * 2));
      } while (true);

      return {
        entries: (normalized.limit == null
          ? filteredEntries.slice(normalized.offset)
          : filteredEntries.slice(normalized.offset, normalized.offset + normalized.limit)).map(finalizeEntry),
        limit: normalized.limit,
        offset: normalized.offset,
        sort: normalized.sort,
        sortMetric: sortMetric ? sortMetric.id : null
      };
    }

    function readQuery(query) {
      var normalized = normalizeGroupQuery(query);
      var allEntries;
      var includeKeySet;
      var keySet;
      var matchedEntries = [];
      var forcedEntries = [];
      var sortMetric = metricsById[normalized && normalized.sortMetric] || defaultSortMetric;
      var limitWindow = null;
      var useBoundedSort = false;
      var compareMatchedEntries = null;
      var entryIndex;
      var total = 0;

      if (!normalized) {
        return readAll();
      }

      if (canUseTopQuery(normalized, sortMetric)) {
        return readTopQuery(normalized, sortMetric);
      }

      allEntries = group.all();
      includeKeySet = normalized.includeKeys ? new Set(normalized.includeKeys) : null;
      keySet = normalized.keys ? new Set(normalized.keys) : null;
      limitWindow = normalized.limit == null ? null : normalized.offset + normalized.limit;
      useBoundedSort = limitWindow != null && normalized.sort !== "natural" && !!sortMetric;
      if (normalized.sort !== "natural" && sortMetric) {
        compareMatchedEntries = function(left, right) {
          return compareEntries(normalized, sortMetric, left, right);
        };
      }

      for (entryIndex = 0; entryIndex < allEntries.length; ++entryIndex) {
        var entry = allEntries[entryIndex];
        var forceInclude = includeKeySet && includeKeySet.has(entry.key);
        var visible = !normalized.visibleOnly || metricHasVisibleValue(visibleMetric, entryMetricValue(entry, visibleMetric));
        var matchesBaseQuery = visible && matchesGroupKey(entry.key, normalized, keySet, false);

        if (matchesBaseQuery) {
          total += 1;
          if (useBoundedSort) {
            insertSortedEntry(matchedEntries, entry, compareMatchedEntries, limitWindow);
          } else {
            matchedEntries.push(entry);
          }
        }

        if (forceInclude) {
          forcedEntries.push(entry);
        }
      }

      if (normalized.sort !== "natural" && sortMetric && !useBoundedSort) {
        matchedEntries.sort(function(left, right) {
          return compareEntries(normalized, sortMetric, left, right);
        });
      }

      if (normalized.sort !== "natural" && sortMetric) {
        forcedEntries.sort(function(left, right) {
          return compareEntries(normalized, sortMetric, left, right);
        });
      }

      var pagedEntries = normalized.limit == null
        ? matchedEntries.slice(normalized.offset)
        : matchedEntries.slice(normalized.offset, normalized.offset + normalized.limit);
      var seenKeys = new Set();
      var mergedEntries = [];

      for (entryIndex = 0; entryIndex < pagedEntries.length; ++entryIndex) {
        mergedEntries.push(pagedEntries[entryIndex]);
        seenKeys.add(pagedEntries[entryIndex].key);
      }

      for (entryIndex = 0; entryIndex < forcedEntries.length; ++entryIndex) {
        if (seenKeys.has(forcedEntries[entryIndex].key)) {
          continue;
        }
        mergedEntries.push(forcedEntries[entryIndex]);
        seenKeys.add(forcedEntries[entryIndex].key);
      }

      if (normalized.sort !== "natural" && sortMetric && forcedEntries.length) {
        mergedEntries.sort(function(left, right) {
          return compareEntries(normalized, sortMetric, left, right);
        });
      }

      var result = {
        entries: mergedEntries.map(finalizeEntry),
        limit: normalized.limit,
        offset: normalized.offset,
        sort: normalized.sort,
        sortMetric: sortMetric ? sortMetric.id : null
      };

      if (normalized.includeTotals) {
        result.total = total;
      }

      return result;
    }

    return {
      dispose: function() {
        group.dispose();
      },
      id: spec.id || "group_" + index,
      read: function(query) {
        return readQuery(query);
      }
    };
  }

  function createCrossfilterInstance(crossfilter, options) {
    if (options.table) {
      return crossfilter.fromArrowTable(options.table, options.columnarOptions);
    }
    if (options.columns) {
      return crossfilter.fromColumns(options.columns, options.columnarOptions);
    }
    return crossfilter(options.records || []);
  }

  function appendColumns(crossfilter, cf, columns, options) {
    cf.add(crossfilter.rowsFromColumns(columns || {}, options || {}));
    return cf.size();
  }

  function appendArrowTable(crossfilter, cf, table, options) {
    cf.add(crossfilter.rowsFromArrowTable(table, options || {}));
    return cf.size();
  }

  function normalizeRowQuery(query) {
    query = query || {};

    return {
      columnar: query.columnar === true,
      direction: query.direction === "bottom" ? "bottom" : "top",
      fields: Array.isArray(query.fields) && query.fields.length ? query.fields.slice() : null,
      limit: typeof query.limit === "number" && query.limit >= 0 ? Math.floor(query.limit) : 50,
      offset: typeof query.offset === "number" && query.offset >= 0 ? Math.floor(query.offset) : 0,
      sortBy: query.sortBy || null
    };
  }

  function normalizeBoundsQuery(query) {
    query = query || {};

    return {
      fields: Array.isArray(query.fields) && query.fields.length ? uniqueFields(query.fields) : []
    };
  }

  function readColumnarFirstValue(result, field) {
    if (!result || !result.columns || !result.length) {
      return null;
    }

    var column = result.columns[field];
    if (!column || !column.length) {
      return null;
    }

    return column[0];
  }

  function projectRows(rows, fields) {
    if (!fields) {
      return rows.slice();
    }

    return rows.map(function(row) {
      var projected = {};
      for (var fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
        projected[fields[fieldIndex]] = row[fields[fieldIndex]];
      }
      return projected;
    });
  }

  function rowIndexesToColumns(cf, rowIndexes, fields) {
    if (typeof cf.takeColumns === "function") {
      return cf.takeColumns(rowIndexes, fields);
    }

    var allRows = cf.all();
    var columns = {};
    var fieldIndex;
    var rowIndex;

    for (fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
      columns[fields[fieldIndex]] = new Array(rowIndexes.length);
    }

    for (rowIndex = 0; rowIndex < rowIndexes.length; ++rowIndex) {
      var row = allRows[rowIndexes[rowIndex]];
      for (fieldIndex = 0; fieldIndex < fields.length; ++fieldIndex) {
        columns[fields[fieldIndex]][rowIndex] = row ? row[fields[fieldIndex]] : undefined;
      }
    }

    return {
      columns: columns,
      fields: fields ? fields.slice() : [],
      length: rowIndexes.length
    };
  }

  function ensureDimension(dimensions, dimensionFields, cf, field) {
    if (!dimensions[field]) {
      dimensions[field] = cf.dimension(field);
      dimensionFields.push(field);
    }
    return dimensions[field];
  }

  function createDashboardRuntime(crossfilter, options) {
    options = options || {};

    var sourceCount = (options.table ? 1 : 0) + (options.columns ? 1 : 0) + (options.records ? 1 : 0);
    if (sourceCount > 1) {
      throw new Error("createDashboardRuntime expects at most one of `table`, `columns` or `records`.");
    }

    var cf = createCrossfilterInstance(crossfilter, options);

    if (typeof cf.configureRuntime === "function") {
      cf.configureRuntime({ wasm: options.wasm !== false });
    } else {
      crossfilter.configureRuntime({ wasm: options.wasm !== false });
    }

    var groupSpecs = options.groups || [];
    var dimensionFields = uniqueFields((options.dimensions || []).concat(groupSpecs.map(function(group) {
      return group.field;
    })));
    var dimensions = {};
    var currentFilters = {};
    var groupRuntimes = {};
    var kpiRuntime = createKpiRuntime(cf, normalizeMetrics(options.kpis, "kpi"));
    var rowCountGroup = cf.groupAll().reduceCount();

    for (var fieldIndex = 0; fieldIndex < dimensionFields.length; ++fieldIndex) {
      dimensions[dimensionFields[fieldIndex]] = cf.dimension(dimensionFields[fieldIndex]);
    }

    for (var groupIndex = 0; groupIndex < groupSpecs.length; ++groupIndex) {
      var groupSpec = groupSpecs[groupIndex];
      var groupDimension = ensureDimension(dimensions, dimensionFields, cf, groupSpec.field);
      var groupRuntime = createGroupRuntime(groupDimension, groupSpec, groupIndex);
      groupRuntimes[groupRuntime.id] = groupRuntime;
    }

    function updateFilters(filters) {
      var nextFilters = normalizeFilterState(filters);
      var seen = new Set();
      var operations = [];
      var clearFields = [];
      var changedCount = 0;

      for (var field in nextFilters) {
        if (!dimensions[field]) {
          throw new Error("Unknown dashboard filter dimension: " + field);
        }
        seen.add(field);
        if (!sameFilter(currentFilters[field], nextFilters[field])) {
          operations.push({
            dimension: dimensions[field],
            filter: nextFilters[field]
          });
          changedCount += 1;
        }
      }

      for (field in currentFilters) {
        if (seen.has(field)) {
          continue;
        }
        if (dimensions[field]) {
          clearFields.push(field);
          changedCount += 1;
        }
      }

      var applyOperations = function() {
        var operationIndex;
        for (operationIndex = 0; operationIndex < operations.length; ++operationIndex) {
          applyFilter(operations[operationIndex].dimension, operations[operationIndex].filter);
        }
        for (operationIndex = 0; operationIndex < clearFields.length; ++operationIndex) {
          dimensions[clearFields[operationIndex]].filterAll();
        }
      };

      if (changedCount > 1 && typeof cf.batch === "function") {
        cf.batch(applyOperations);
      } else {
        applyOperations();
      }

      currentFilters = nextFilters;
      return typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo();
    }

    function readGroups(groupQueries) {
      var groups = {};

      if (!groupQueries) {
        for (var groupId in groupRuntimes) {
          groups[groupId] = groupRuntimes[groupId].read();
        }
        return groups;
      }

      for (var requestedGroupId in groupQueries) {
        if (!groupRuntimes[requestedGroupId]) {
          throw new Error("Unknown dashboard group: " + requestedGroupId);
        }
        if (groupQueries[requestedGroupId] === false) {
          continue;
        }
        groups[requestedGroupId] = groupRuntimes[requestedGroupId].read(groupQueries[requestedGroupId]);
      }

      return groups;
    }

    function readSnapshot(options) {
      var groups = {};

      if (!options || options.groups !== false) {
        groups = readGroups(options && options.groups ? options.groups : null);
      }

      return {
        groups: groups,
        kpis: kpiRuntime.read(),
        runtime: typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo()
      };
    }

    function readRowCount() {
      return rowCountGroup.value();
    }

    function readRows(query) {
      var normalized = normalizeRowQuery(query);
      var rowIndexes;
      var rows;

      if (normalized.columnar) {
        if (!normalized.fields) {
          throw new Error("Columnar row queries require `fields`.");
        }
        if (normalized.sortBy) {
          var columnDimension = ensureDimension(dimensions, dimensionFields, cf, normalized.sortBy);
          rowIndexes = normalized.direction === "bottom" && typeof columnDimension.bottomIndex === "function"
            ? columnDimension.bottomIndex(normalized.limit, normalized.offset)
            : typeof columnDimension.topIndex === "function"
              ? columnDimension.topIndex(normalized.limit, normalized.offset)
              : null;
        } else if (typeof cf.allFilteredIndexes === "function") {
          rowIndexes = cf.allFilteredIndexes().slice(normalized.offset, normalized.offset + normalized.limit);
        }

        if (rowIndexes) {
          return rowIndexesToColumns(cf, rowIndexes, normalized.fields);
        }
      }

      if (normalized.sortBy) {
        var dimension = ensureDimension(dimensions, dimensionFields, cf, normalized.sortBy);
        rows = normalized.direction === "bottom"
          ? dimension.bottom(normalized.limit, normalized.offset)
          : dimension.top(normalized.limit, normalized.offset);
      } else {
        var allRows = typeof cf.allFiltered === "function" ? cf.allFiltered() : cf.all();
        rows = allRows.slice(normalized.offset, normalized.offset + normalized.limit);
      }

      return projectRows(rows, normalized.fields);
    }

    function readBounds(query) {
      var normalized = normalizeBoundsQuery(query);
      var bounds = {};
      var fieldIndex;

      for (fieldIndex = 0; fieldIndex < normalized.fields.length; ++fieldIndex) {
        var field = normalized.fields[fieldIndex];
        var dimension = ensureDimension(dimensions, dimensionFields, cf, field);
        var lowerIndexes = typeof dimension.bottomIndex === "function" ? dimension.bottomIndex(1) : null;
        var upperIndexes = typeof dimension.topIndex === "function" ? dimension.topIndex(1) : null;
        var minValue = null;
        var maxValue = null;

        if (lowerIndexes && lowerIndexes.length) {
          minValue = readColumnarFirstValue(rowIndexesToColumns(cf, [lowerIndexes[0]], [field]), field);
        } else {
          var lowerRows = dimension.bottom(1);
          minValue = lowerRows.length ? lowerRows[0][field] : null;
        }

        if (upperIndexes && upperIndexes.length) {
          maxValue = readColumnarFirstValue(rowIndexesToColumns(cf, [upperIndexes[0]], [field]), field);
        } else {
          var upperRows = dimension.top(1);
          maxValue = upperRows.length ? upperRows[0][field] : null;
        }

        bounds[field] = {
          max: maxValue == null ? null : maxValue,
          min: minValue == null ? null : minValue
        };
      }

      return bounds;
    }

    function readRowSets(rowSetQueries) {
      var rowSets = {};

      if (!rowSetQueries) {
        return rowSets;
      }

      for (var rowSetId in rowSetQueries) {
        if (rowSetQueries[rowSetId] === false) {
          continue;
        }
        rowSets[rowSetId] = readRows(rowSetQueries[rowSetId]);
      }

      return rowSets;
    }

    function queryRuntime(request) {
      request = request || {};
      if (request.filters) {
        updateFilters(request.filters);
      }

      var response = {
        rows: request.rows ? readRows(request.rows) : [],
        snapshot: request.snapshot === false ? null : readSnapshot(request.snapshot)
      };

      if (request.rowCount) {
        response.rowCount = readRowCount();
      }

      if (request.groups) {
        response.groups = readGroups(request.groups);
      }

      if (request.bounds) {
        response.bounds = readBounds(request.bounds);
      }

      if (request.rowSets) {
        response.rowSets = readRowSets(request.rowSets);
      }

      return response;
    }

    function queryGroups(request) {
      request = request || {};
      if (request.filters) {
        updateFilters(request.filters);
      }
      return readGroups(request.groups || null);
    }

    function queryBounds(request) {
      request = request || {};
      if (request.filters) {
        updateFilters(request.filters);
      }
      return readBounds(request.bounds || request);
    }

    function queryRowSets(request) {
      request = request || {};
      if (request.filters) {
        updateFilters(request.filters);
      }
      return readRowSets(request.rowSets || request);
    }

    function removeFiltered(selection) {
      if (selection === "excluded") {
        cf.remove(function(_, index) {
          return typeof cf.isElementFiltered === "function" ? !cf.isElementFiltered(index) : false;
        });
      } else {
        cf.remove();
      }
      return cf.size();
    }

    return {
      append: function(records) {
        cf.add(records || []);
        return cf.size();
      },
      appendArrowTable: function(table, columnarOptions) {
        return appendArrowTable(crossfilter, cf, table, columnarOptions);
      },
      appendColumns: function(columns, columnarOptions) {
        return appendColumns(crossfilter, cf, columns, columnarOptions);
      },
      bounds: function(request) {
        return queryBounds(request);
      },
      dispose: function() {
        this.reset();
        for (var groupId in groupRuntimes) {
          groupRuntimes[groupId].dispose();
        }
        kpiRuntime.dispose();
        rowCountGroup.dispose();
        for (var dimensionIndex = 0; dimensionIndex < dimensionFields.length; ++dimensionIndex) {
          dimensions[dimensionFields[dimensionIndex]].dispose();
        }
      },
      query: function(request) {
        return queryRuntime(request);
      },
      groups: function(request) {
        return queryGroups(request);
      },
      removeFiltered: function(selection) {
        return removeFiltered(selection);
      },
      reset: function() {
        return updateFilters({});
      },
      rows: function(query) {
        return readRows(query);
      },
      rowSets: function(request) {
        return queryRowSets(request);
      },
      rowCount: function(request) {
        request = request || {};
        if (request.filters) {
          updateFilters(request.filters);
        }
        return readRowCount();
      },
      runtimeInfo: function() {
        return typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo();
      },
      size: function() {
        return cf.size();
      },
      snapshot: function(filters, snapshotOptions) {
        if (filters) {
          updateFilters(filters);
        }
        return readSnapshot(snapshotOptions);
      },
      updateFilters: updateFilters
    };
  }

  function resolveArrowBuffer$1(source) {
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

  function resolveAssetUrl$1(url) {
    if (typeof URL === "function" && typeof location !== "undefined" && location && location.href) {
      return new URL(url, location.href).toString();
    }
    return url;
  }

  function createWorkerSource$1(crossfilterUrl, arrowUrl) {
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

  function createDashboardWorker(options) {
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

      var resolvedCrossfilterUrl = resolveAssetUrl$1(options.crossfilterUrl),
          resolvedArrowUrl = resolveAssetUrl$1(options.arrowRuntimeUrl || options.arrowUrl);

      workerFactory = function() {
        workerUrl = URL.createObjectURL(new Blob([
          createWorkerSource$1(resolvedCrossfilterUrl, resolvedArrowUrl)
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
          dataUrl: options.dataUrl ? resolveAssetUrl$1(options.dataUrl) : null,
          dimensions: options.dimensions || [],
          groups: options.groups || [],
          kpis: options.kpis || [],
          wasm: options.wasm !== false
        };

    if (options.arrowBuffer) {
      payload.arrowBuffer = resolveArrowBuffer$1(options.arrowBuffer);
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
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.snapshot(message.payload.filters, message.payload.options || null));
        return;
      case 'groups':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.groups(message.payload.request));
        return;
      case 'bounds':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.bounds(message.payload.request));
        return;
      case 'query':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.query(message.payload.request));
        return;
      case 'append':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.append(message.payload.records || []));
        return;
      case 'updateFilters':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.updateFilters(message.payload.filters));
        return;
      case 'rows':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.rows(message.payload.query));
        return;
      case 'rowSets':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.rowSets(message.payload.request));
        return;
      case 'removeFiltered':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.removeFiltered(message.payload.selection));
        return;
      case 'reset':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
        respond(id, runtime.reset());
        return;
      case 'runtimeInfo':
        if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
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

  function createStreamingDashboardWorker(options) {
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
        workerRuntime: initPayload.runtime
      };
    }).catch(function(error) {
      disposed = true;
      worker.terminate();
      cleanupWorker();
      throw error;
    });
  }

  // constants
  var REMOVED_INDEX = -1;

  crossfilter.heap = h$1;
  crossfilter.heapselect = h;
  crossfilter.bisect = bisect;
  crossfilter.permute = permute;
  crossfilter.rowsFromColumns = rowsFromColumns;
  crossfilter.fromColumns = function(columns, options) {
    return crossfilter(rowsFromColumns(columns, options));
  };
  crossfilter.rowsFromArrowTable = rowsFromArrowTable;
  crossfilter.fromArrowTable = function(table, options) {
    return crossfilter(rowsFromArrowTable(table, options));
  };
  crossfilter.configureRuntime = configureWasmRuntime;
  crossfilter.runtimeInfo = getWasmRuntimeInfo;
  crossfilter.createDashboardRuntime = function(options) {
    return createDashboardRuntime(crossfilter, options);
  };
  crossfilter.createDashboardWorker = function(options) {
    return createDashboardWorker(options);
  };
  crossfilter.createStreamingDashboardWorker = function(options) {
    return createStreamingDashboardWorker(options);
  };
  // Match simple property access patterns in function source:
  //   d => d.prop, (d) => d['prop'], function(d) { return d.prop; }
  var re_arrowAccessor = /^\(?(\w+)\)?\s*=>\s*\1(?:\.(\w+)|\[['"]([^'"]+)['"]\])\s*$/;
  var re_functionAccessor = /^function\s*\w*\s*\(\s*(\w+)\s*\)\s*\{\s*return\s+\1(?:\.(\w+)|\[['"]([^'"]+)['"]\])\s*;?\s*\}$/;

  function tryExtractAccessorPath(fn) {
    try {
      var source = fn.toString().trim();
      var match = re_arrowAccessor.exec(source) || re_functionAccessor.exec(source);
      return match ? (match[2] || match[3]) : null;
    } catch (e) {
      return null;
    }
  }

  function crossfilter() {
    var runtimeController = createWasmRuntimeController();
    var crossfilter = {
      add: add,
      allFilteredIndexes: allFilteredIndexes,
      batch: batch,
      remove: removeData,
      dimension: dimension,
      getFieldValue: getFieldValue,
      groupAll: groupAll,
      size: size,
      all: all,
      allFiltered: allFiltered,
      onChange: onChange,
      isElementFiltered: isElementFiltered,
      takeColumns: takeColumns,
      configureRuntime: runtimeController.configureRuntime,
      runtimeInfo: runtimeController.runtimeInfo
    };

    var data = [], // the records
        n = 0, // the number of records; data.length
        filters, // 1 is filtered out
        filterListeners = [], // when the filters change
        dataListeners = [], // when data is added
        removeDataListeners = [], // when data is removed
        resetListeners = [],
        callbacks = [],
        columnarBatches = [],
        activeDimensionFilterCount = 0,
        batchedFilterDepth = 0,
        batchedFilterEventPending = false,
        batchedFilterResetPending = false;

    filters = new xfilterArray.bitarray(0);

    function appendData(newData) {
      var offset = data.length;
      data.length = offset + newData.length;
      var batch = getColumnarBatch(newData);
      if (batch) {
        for (var key in batch.rows) {
          if (Object.prototype.hasOwnProperty.call(batch.rows, key)) {
            data[offset + Number(key)] = batch.rows[key];
          }
        }
        return;
      }
      for (var i = 0; i < newData.length; ++i) {
        data[offset + i] = newData[i];
      }
    }

    function rememberColumnarBatch(newData, n0, n1) {
      var batch = getColumnarBatch(newData);
      if (!batch) {
        return;
      }

      columnarBatches.push({
        batch: batch,
        accessors: batch.accessorsByField,
        columns: batch.columns,
        start: n0,
        end: n0 + n1
      });
    }

    function findColumnarBatch(rowIndex) {
      if (columnarBatches.length === 1) {
        var onlyBatch = columnarBatches[0];
        return rowIndex >= onlyBatch.start && rowIndex < onlyBatch.end
          ? onlyBatch
          : null;
      }

      var lo = 0,
          hi = columnarBatches.length;

      while (lo < hi) {
        var mid = lo + hi >>> 1,
            batch = columnarBatches[mid];
        if (rowIndex < batch.start) hi = mid;
        else if (rowIndex >= batch.end) lo = mid + 1;
        else return batch;
      }

      return null;
    }

    function hasAnyActiveDimensionFilters() {
      return activeDimensionFilterCount > 0;
    }

    function registerResetListener(listener) {
      resetListeners.push(listener);
      return listener;
    }

    function unregisterResetListener(listener) {
      var listenerIndex = resetListeners.indexOf(listener);
      if (listenerIndex >= 0) {
        resetListeners.splice(listenerIndex, 1);
      }
    }

    function markFilterListenersDirty() {
      if (batchedFilterResetPending) {
        return;
      }
      batchedFilterResetPending = true;
      for (var listenerIndex = 0; listenerIndex < resetListeners.length; ++listenerIndex) {
        resetListeners[listenerIndex]();
      }
    }

    function notifyFilterListeners(filterOne, filterOffset, added, removed) {
      if (batchedFilterDepth > 0) {
        batchedFilterEventPending = true;
        markFilterListenersDirty();
        return;
      }

      filterListeners.forEach(function(l) { l(filterOne, filterOffset, added, removed); });
      triggerOnChange('filtered');
    }

    function flushBatchedFilterEvents() {
      if (!batchedFilterEventPending) {
        return;
      }
      batchedFilterEventPending = false;
      batchedFilterResetPending = false;
      triggerOnChange('filtered');
    }

    function batch(callback) {
      batchedFilterDepth += 1;
      try {
        return callback();
      } finally {
        batchedFilterDepth -= 1;
        if (!batchedFilterDepth) {
          flushBatchedFilterEvents();
        }
      }
    }

    function getRecord(rowIndex) {
      var row = data[rowIndex];
      if (row !== undefined) {
        return row;
      }

      if (!columnarBatches.length) {
        return rowIndex in data ? row : undefined;
      }

      var batch = findColumnarBatch(rowIndex);
      if (!batch) {
        return rowIndex in data ? row : undefined;
      }

      var batchRowIndex = rowIndex - batch.start;
      if (batch.batch.materialized && batch.batch.materialized[batchRowIndex]) {
        row = batch.batch.rows[batchRowIndex];
      } else {
        row = materializeColumnarRow(batch.batch, batchRowIndex);
      }
      data[rowIndex] = row;
      return row;
    }

    function getFieldValue(rowIndex, field) {
      var row = data[rowIndex];
      if (row !== undefined) {
        return row ? row[field] : undefined;
      }

      if (columnarBatches.length) {
        var batch = findColumnarBatch(rowIndex);
        if (batch) {
          var batchRowIndex = rowIndex - batch.start;
          if (batch.accessors && batch.accessors[field]) {
            return batch.accessors[field](batchRowIndex);
          }
          if (Object.prototype.hasOwnProperty.call(batch.columns, field)) {
            return getColumnValue(batch.columns[field], batchRowIndex);
          }
        }
      }

      row = getRecord(rowIndex);
      return row ? row[field] : undefined;
    }

    function isFiniteMetricNumber(value) {
      return typeof value === 'number' && Number.isFinite(value);
    }

    function resolveReduceMetricSpec(add, remove, initial) {
      var metricSpec = add && add._xfilterMetricSpec;
      if (!metricSpec || metricSpec !== (remove && remove._xfilterMetricSpec) || metricSpec !== (initial && initial._xfilterMetricSpec)) {
        return null;
      }
      return metricSpec;
    }

    function applyReduceMetricSpec(state, metricSpec, rowIndex, delta) {
      if (!state) {
        return state;
      }

      for (var metricIndex = 0; metricIndex < metricSpec.length; ++metricIndex) {
        var metric = metricSpec[metricIndex];
        var value;

        switch (metric.op) {
          case 'count':
            state[metric.id] += delta;
            break;
          case 'sum':
            value = getFieldValue(rowIndex, metric.field);
            if (isFiniteMetricNumber(value)) {
              state[metric.id] += delta * value;
            }
            break;
          case 'avg':
            value = getFieldValue(rowIndex, metric.field);
            if (isFiniteMetricNumber(value)) {
              state[metric.id].sum += delta * value;
              state[metric.id].count += delta;
            }
            break;
          case 'avgNonZero':
            value = getFieldValue(rowIndex, metric.field);
            if (isFiniteMetricNumber(value) && value !== 0) {
              state[metric.id].sum += delta * value;
              state[metric.id].count += delta;
            }
            break;
        }
      }

      state.__version += 1;
      return state;
    }

    function materializeAllRecords() {
      if (!columnarBatches.length) {
        return;
      }
      for (var rowIndex = 0; rowIndex < n; ++rowIndex) {
        getRecord(rowIndex);
      }
    }

    function copyFieldValuesFromRows(target, targetOffset, field, start, end) {
      for (var i = start; i < end; ++i) {
        target[targetOffset++] = getRecord(i)[field];
      }
      return targetOffset;
    }

    function extractColumnValues(field, start, count) {
      if (!count) {
        return [];
      }

      var values = new Array(count),
          cursor = start,
          targetOffset = 0,
          end = start + count;

      if (!columnarBatches.length) {
        copyFieldValuesFromRows(values, 0, field, start, end);
        return values;
      }

      for (var batchIndex = 0; batchIndex < columnarBatches.length && cursor < end; ++batchIndex) {
        var batch = columnarBatches[batchIndex];

        if (batch.end <= cursor) {
          continue;
        }

        if (batch.start >= end) {
          break;
        }

        if (cursor < batch.start) {
          var gapEnd = Math.min(batch.start, end);
          targetOffset = copyFieldValuesFromRows(values, targetOffset, field, cursor, gapEnd);
          cursor = gapEnd;
          if (cursor >= end) {
            break;
          }
        }

        var segmentStart = Math.max(cursor, batch.start),
            segmentEnd = Math.min(batch.end, end),
            accessor = batch.accessors && batch.accessors[field],
            column = batch.columns[field];

        if (accessor) {
          for (var valueIndex = segmentStart; valueIndex < segmentEnd; ++valueIndex) {
            values[targetOffset++] = accessor(valueIndex - batch.start);
          }
        } else if (column != null) {
          for (var valueIndex = segmentStart; valueIndex < segmentEnd; ++valueIndex) {
            values[targetOffset++] = getColumnValue(column, valueIndex - batch.start);
          }
        } else {
          targetOffset = copyFieldValuesFromRows(values, targetOffset, field, segmentStart, segmentEnd);
        }

        cursor = segmentEnd;
      }

      if (cursor < end) {
        copyFieldValuesFromRows(values, targetOffset, field, cursor, end);
      }

      return values;
    }

    function findSingleColumnAccessorSegment(field, start, count) {
      if (!count || !columnarBatches.length) {
        return null;
      }

      var end = start + count;

      for (var batchIndex = 0; batchIndex < columnarBatches.length; ++batchIndex) {
        var batch = columnarBatches[batchIndex];

        if (batch.end <= start) {
          continue;
        }

        if (batch.start > start) {
          return null;
        }

        if (batch.end < end) {
          return null;
        }

        if (!batch.accessors || !batch.accessors[field]) {
          return null;
        }

        return {
          accessor: batch.accessors[field],
          offset: start - batch.start
        };
      }

      return null;
    }

    // Adds the specified new records to this crossfilter.
    function add(newData) {
      var n0 = n,
          n1 = newData.length;

      // If there's actually new data to add…
      // Merge the new data into the existing data.
      // Lengthen the filter bitset to handle the new records.
      // Notify listeners (dimensions and groups) that new data is available.
      if (n1) {
        appendData(newData);
        rememberColumnarBatch(newData, n0, n1);
        filters.lengthen(n += n1);
        dataListeners.forEach(function(l) { l(newData, n0, n1); });
        triggerOnChange('dataAdded');
      }

      return crossfilter;
    }

    // Removes all records that match the current filters, or if a predicate function is passed,
    // removes all records matching the predicate (ignoring filters).
    function removeData(predicate) {
      materializeAllRecords();
      var // Mapping from old record indexes to new indexes (after records removed)
          newIndex = new Array(n),
          removed = [],
          usePred = typeof predicate === 'function',
          shouldRemove = function (i) {
            return usePred ? predicate(getRecord(i), i) : filters.zero(i)
          };

      for (var index1 = 0, index2 = 0; index1 < n; ++index1) {
        if ( shouldRemove(index1) ) {
          removed.push(index1);
          newIndex[index1] = REMOVED_INDEX;
        } else {
          newIndex[index1] = index2++;
        }
      }

      // Remove all matching records from groups.
      filterListeners.forEach(function(l) { l(-1, -1, [], removed, true); });

      // Update indexes.
      removeDataListeners.forEach(function(l) { l(newIndex); });

      // Remove old filters and data by overwriting.
      for (var index3 = 0, index4 = 0; index3 < n; ++index3) {
        if ( newIndex[index3] !== REMOVED_INDEX ) {
          if (index3 !== index4) filters.copy(index4, index3), data[index4] = data[index3];
          ++index4;
        }
      }

      data.length = n = index4;
      filters.truncate(index4);
      columnarBatches = [];
      triggerOnChange('dataRemoved');
    }

    function maskForDimensions(dimensions) {
      var n,
          d,
          len,
          id,
          mask = Array(filters.subarrays);
      for (n = 0; n < filters.subarrays; n++) { mask[n] = ~0; }
      for (d = 0, len = dimensions.length; d < len; d++) {
        // The top bits of the ID are the subarray offset and the lower bits are the bit
        // offset of the "one" mask.
        id = dimensions[d].id();
        mask[id >> 7] &= ~(0x1 << (id & 0x3f));
      }
      return mask;
    }

    // Return true if the data element at index i is filtered IN.
    // Optionally, ignore the filters of any dimensions in the ignore_dimensions list.
    function isElementFiltered(i, ignore_dimensions) {
      var mask = maskForDimensions(ignore_dimensions || []);
      return filters.zeroExceptMask(i,mask);
    }

    // Adds a new dimension with the specified value accessor function.
    function dimension(value, iterable) {
      var accessorPath;

      if (typeof value === 'string') {
        accessorPath = value;
        value = function(d) { return result(d, accessorPath); };
      } else if (typeof value === 'function') {
        accessorPath = tryExtractAccessorPath(value);
      }

      var dimension = {
        filter: filter,
        filterExact: filterExact,
        filterIn: filterIn,
        filterRange: filterRange,
        filterFunction: filterFunction,
        filterAll: filterAll,
        currentFilter: currentFilter,
        hasCurrentFilter: hasCurrentFilter,
        top: top,
        topIndex: topIndex,
        bottom: bottom,
        bottomIndex: bottomIndex,
        group: group,
        groupAll: groupAll,
        dispose: dispose,
        remove: dispose, // for backwards-compatibility
        accessor: value,
        id: function() { return id; }
      };

      var one, // lowest unset bit as mask, e.g., 00001000
          zero, // inverted one, e.g., 11110111
          offset, // offset into the filters arrays
          id, // unique ID for this dimension (reused when dimensions are disposed)
          values, // sorted, cached array
          index, // maps sorted value index -> record index (in data)
          newValues, // temporary array storing newly-added values
          newIndex, // temporary array storing newly-added index
          lastAppendedCodes, // temporary: appended codes from lazy preAdd
          iterablesIndexCount,
          iterablesIndexFilterStatus,
          iterablesEmptyRows = [],
          sortRange = function(n) {
            return cr_range(n).sort(function(A, B) {
              var order = compareNaturalOrder(newValues[A], newValues[B]);
              return order || A - B;
            });
          },
          refilter = xfilterFilter.filterAll, // for recomputing filter
          refilterFunction, // the custom filter function in use
          filterValue, // the value used for filtering (value, array, function or undefined)
          filterValuePresent, // true if filterValue contains something
          filterMode = 'all',
          filterInValues = null,
          exactRangeCache = new Map(),
          lazyFilterTargetCodes = null,
          lazyFilterTargetCodesVersion = 0,
          lazyEncodedState = null,
          indexListeners = [], // when data is added
          dimensionGroups = [],
          lo0 = 0,
          hi0 = 0,
          t = 0,
          k;

      function normalizeExactFilterValues(filterValues) {
        var uniqueValues = Array.from(new Set(filterValues));
        uniqueValues.sort(compareNaturalOrder);
        return uniqueValues;
      }

      function isLazyEncodedValue(valueToEncode) {
        var valueType = typeof valueToEncode;
        return valueToEncode == null
          || valueType === 'string'
          || valueType === 'number'
          || valueType === 'boolean'
          || valueType === 'bigint';
      }

      // ==========================================================================
      // Lazy encoded dimension path — semantic safety contract
      //
      // The lazy path stores dimension values as integer codes and defers
      // materialization of sorted values/index. All optimizations in this path
      // must preserve these invariants:
      //
      // 1. ORDERING: filterRange must use compareNaturalOrder, not raw JS < / >=,
      //    because mixed-type dimensions have type-rank ordering that differs
      //    from JS coercion. The gate is hasLazyEncodedGroupingSupport().
      //
      // 2. EQUALITY: filterExact and filterIn use Map-based code lookup, which
      //    uses SameValueZero. This differs from compareNaturalOrder for null/0
      //    (they are distinct in SameValueZero but equivalent in natural order).
      //    This is an intentional semantic tightening: null means null.
      //
      // 3. FILTER LIFECYCLE: reduce functions receive a third argument (noPrior)
      //    that distinguishes "new data" from "filter toggle." The lazy path
      //    must preserve this via resetNeeded + resetMany/resetOne, not by
      //    skipping reduce calls.
      //
      // 4. NOTIFICATION: filter changes must fire onChange('filtered') even when
      //    no filterListeners (groups) exist. Check callbacks.length too.
      //
      // 5. COUNTS: codeCounts must stay consistent through append, remove, and
      //    compaction. lazyCodesSelectAllRows depends on accurate counts.
      //
      // When in doubt, materialize. The materialized path is always correct.
      // ==========================================================================

      function createLazyEncodedState(sourceValues) {
        if (!accessorPath || iterable || !runtimeController.canUseWasmScan()) {
          return null;
        }

        var codesCapacity = sourceValues.length < 64 ? 64 : sourceValues.length,
            codes = new Uint32Array(codesCapacity),
            valueToCode = new Map(),
            codeToValue = [undefined],
            i,
            valueToEncode,
            code;

        for (i = 0; i < sourceValues.length; ++i) {
          valueToEncode = sourceValues[i];
          if (!isLazyEncodedValue(valueToEncode)) {
            return null;
          }
          if (!valueToCode.has(valueToEncode)) {
            code = codeToValue.length;
            valueToCode.set(valueToEncode, code);
            codeToValue.push(valueToEncode);
          }
          codes[i] = valueToCode.get(valueToEncode);
        }

        return {
          codeCounts: buildCodeCounts(codes, codeToValue.length),
          codesLength: sourceValues.length,
          codeToValue: codeToValue,
          codes: codes,
          matchIndices: null,
          selected: null,
          selectionMarkVersion: 1,
          selectionMarks: new Uint32Array(codeToValue.length),
          valueToCode: valueToCode
        };
      }

      function createLazyEncodedStateFromAccessor(accessor, offset, length) {
        if (!accessorPath || iterable || !runtimeController.canUseWasmScan()) {
          return null;
        }

        var codesCapacity = length < 64 ? 64 : length,
            codes = new Uint32Array(codesCapacity),
            valueToCode = new Map(),
            codeToValue = [undefined],
            i,
            valueToEncode,
            code;

        for (i = 0; i < length; ++i) {
          valueToEncode = accessor(offset + i);
          if (!isLazyEncodedValue(valueToEncode)) {
            return null;
          }
          if (!valueToCode.has(valueToEncode)) {
            code = codeToValue.length;
            valueToCode.set(valueToEncode, code);
            codeToValue.push(valueToEncode);
          }
          codes[i] = valueToCode.get(valueToEncode);
        }

        return {
          codeCounts: buildCodeCounts(codes, codeToValue.length),
          codesLength: length,
          codeToValue: codeToValue,
          codes: codes,
          matchIndices: null,
          selected: null,
          selectionMarkVersion: 1,
          selectionMarks: new Uint32Array(codeToValue.length),
          valueToCode: valueToCode
        };
      }

      function ensureLazySelectionMarksSize(size) {
        if (lazyEncodedState.selectionMarks.length >= size) {
          return;
        }

        var nextMarks = new Uint32Array(size);
        nextMarks.set(lazyEncodedState.selectionMarks);
        lazyEncodedState.selectionMarks = nextMarks;
      }

      function getLazyCodes() {
        return lazyEncodedState.codes.length === lazyEncodedState.codesLength
          ? lazyEncodedState.codes
          : lazyEncodedState.codes.subarray(0, lazyEncodedState.codesLength);
      }

      function growLazyCodeCounts(codeCounts, code) {
        var nextCounts = new Uint32Array(lazyEncodedState.codeToValue.length);
        nextCounts.set(codeCounts);
        lazyEncodedState.codeCounts = nextCounts;
        return nextCounts;
      }

      function appendLazyEncodedValues(sourceValues) {
        if (!lazyEncodedState) {
          return null;
        }

        var existingLength = lazyEncodedState.codesLength,
            newLength = existingLength + sourceValues.length,
            codes = lazyEncodedState.codes,
            codeCounts = lazyEncodedState.codeCounts,
            appendedCodes = new Uint32Array(sourceValues.length),
            i,
            valueToEncode,
            code;

        if (newLength > codes.length) {
          var nextCapacity = codes.length;
          while (nextCapacity < newLength) nextCapacity *= 2;
          var nextCodes = new Uint32Array(nextCapacity);
          nextCodes.set(codes.subarray(0, existingLength));
          codes = nextCodes;
          lazyEncodedState.codes = codes;
        }

        for (i = 0; i < sourceValues.length; ++i) {
          valueToEncode = sourceValues[i];
          if (!isLazyEncodedValue(valueToEncode)) {
            return null;
          }
          if (!lazyEncodedState.valueToCode.has(valueToEncode)) {
            code = lazyEncodedState.codeToValue.length;
            lazyEncodedState.valueToCode.set(valueToEncode, code);
            lazyEncodedState.codeToValue.push(valueToEncode);
          }
          code = lazyEncodedState.valueToCode.get(valueToEncode);
          appendedCodes[i] = code;
          codes[existingLength + i] = code;
          if (code >= codeCounts.length) {
            codeCounts = growLazyCodeCounts(codeCounts);
          }
          ++codeCounts[code];
        }

        lazyEncodedState.codesLength = newLength;
        ensureLazySelectionMarksSize(lazyEncodedState.codeToValue.length);
        return appendedCodes;
      }

      function appendLazyEncodedValuesFromAccessor(accessor, offset, length) {
        if (!lazyEncodedState) {
          return null;
        }

        var existingLength = lazyEncodedState.codesLength,
            newLength = existingLength + length,
            codes = lazyEncodedState.codes,
            codeCounts = lazyEncodedState.codeCounts,
            appendedCodes = new Uint32Array(length),
            i,
            valueToEncode,
            code;

        if (newLength > codes.length) {
          var nextCapacity = codes.length;
          while (nextCapacity < newLength) nextCapacity *= 2;
          var nextCodes = new Uint32Array(nextCapacity);
          nextCodes.set(codes.subarray(0, existingLength));
          codes = nextCodes;
          lazyEncodedState.codes = codes;
        }

        for (i = 0; i < length; ++i) {
          valueToEncode = accessor(offset + i);
          if (!isLazyEncodedValue(valueToEncode)) {
            return null;
          }
          if (!lazyEncodedState.valueToCode.has(valueToEncode)) {
            code = lazyEncodedState.codeToValue.length;
            lazyEncodedState.valueToCode.set(valueToEncode, code);
            lazyEncodedState.codeToValue.push(valueToEncode);
          }
          code = lazyEncodedState.valueToCode.get(valueToEncode);
          appendedCodes[i] = code;
          codes[existingLength + i] = code;
          if (code >= codeCounts.length) {
            codeCounts = growLazyCodeCounts(codeCounts);
          }
          ++codeCounts[code];
        }

        lazyEncodedState.codesLength = newLength;
        ensureLazySelectionMarksSize(lazyEncodedState.codeToValue.length);
        return appendedCodes;
      }

      function buildCodeCounts(codes, size) {
        var codeCounts = new Uint32Array(size);
        for (var codeIndex = 0; codeIndex < codes.length; ++codeIndex) {
          ++codeCounts[codes[codeIndex]];
        }
        return codeCounts;
      }

      function lazyCodesSelectAllRows(targetCodes) {
        if (!lazyEncodedState || !targetCodes || !targetCodes.length) {
          return false;
        }

        var selectedCount = 0;
        for (var codeIndex = 0; codeIndex < targetCodes.length; ++codeIndex) {
          selectedCount += lazyEncodedState.codeCounts[targetCodes[codeIndex]] || 0;
        }
        return selectedCount === n;
      }

      function normalizeLazySelectionMask(selection) {
        if (!selection) {
          return null;
        }

        for (var i = 0; i < selection.length; ++i) {
          if (!selection[i]) {
            return selection;
          }
        }

        return null;
      }

      function normalizeLazyMatchIndices(matches) {
        if (!matches || matches.length === n) {
          return null;
        }
        return matches;
      }

      function createLazySelectionFromMatches(matches) {
        if (!matches || matches.length === n) {
          return null;
        }

        var selection = new Uint8Array(n);
        for (var i = 0; i < matches.length; ++i) {
          selection[matches[i]] = 1;
        }
        return selection;
      }

      function ensureLazySelection(currentMatches, currentSelected) {
        return currentSelected || createLazySelectionFromMatches(currentMatches);
      }

      function encodeLazyFilterValues(filterValues) {
        if (!lazyEncodedState) {
          return null;
        }

        var encodedValues = new Uint32Array(filterValues.length),
            count = 0,
            i,
            markVersion,
            selectionMarks,
            valueToEncode,
            code;

        ensureLazySelectionMarksSize(lazyEncodedState.codeToValue.length);
        selectionMarks = lazyEncodedState.selectionMarks;
        if (lazyEncodedState.selectionMarkVersion === 0xffffffff) {
          selectionMarks.fill(0);
          lazyEncodedState.selectionMarkVersion = 1;
        }
        markVersion = lazyEncodedState.selectionMarkVersion++;

        for (i = 0; i < filterValues.length; ++i) {
          valueToEncode = filterValues[i];
          if (!isLazyEncodedValue(valueToEncode)) {
            return null;
          }
          code = lazyEncodedState.valueToCode.get(valueToEncode);
          if (code === undefined || selectionMarks[code] === markVersion) {
            continue;
          }
          selectionMarks[code] = markVersion;
          encodedValues[count++] = code;
        }

        return encodedValues.slice(0, count);
      }

      function applyLazySelectionState(nextMatches) {
        var shouldNotify = filterListeners.length > 0 || callbacks.length > 0,
            added = shouldNotify ? [] : null,
            removed = shouldNotify ? [] : null,
            currentSelected = lazyEncodedState.selected,
            currentMatches = normalizeLazyMatchIndices(lazyEncodedState.matchIndices),
            currentIndex,
            nextIndex,
            currentValue,
            nextValue,
            i,
            isSelected,
            nextSelected,
            wasSelected;

        nextMatches = normalizeLazyMatchIndices(nextMatches);

        if (!currentMatches && !nextMatches) {
          lazyEncodedState.selected = null;
          lazyEncodedState.matchIndices = null;
          return dimension;
        }

        if (currentMatches && nextMatches) {
          currentSelected = ensureLazySelection(currentMatches, currentSelected);
          currentIndex = 0;
          nextIndex = 0;

          while (currentIndex < currentMatches.length || nextIndex < nextMatches.length) {
            currentValue = currentIndex < currentMatches.length ? currentMatches[currentIndex] : n;
            nextValue = nextIndex < nextMatches.length ? nextMatches[nextIndex] : n;

            if (currentValue === nextValue) {
              ++currentIndex;
              ++nextIndex;
              continue;
            }

            if (currentValue < nextValue) {
              if (!(filters[offset][currentValue] & one)) {
                filters[offset][currentValue] |= one;
              }
              currentSelected[currentValue] = 0;
              if (shouldNotify) {
                removed.push(currentValue);
              }
              ++currentIndex;
              continue;
            }

            if (filters[offset][nextValue] & one) {
              filters[offset][nextValue] &= zero;
            }
            currentSelected[nextValue] = 1;
            if (shouldNotify) {
              added.push(nextValue);
            }
            ++nextIndex;
          }

          lazyEncodedState.selected = normalizeLazySelectionMask(currentSelected);
          lazyEncodedState.matchIndices = nextMatches;
          if (shouldNotify) {
            notifyFilterListeners(one, offset, added, removed);
          }
          return dimension;
        }

        nextSelected = createLazySelectionFromMatches(nextMatches);
        currentSelected = ensureLazySelection(currentMatches, currentSelected);

        if (!currentSelected && !nextSelected) {
          lazyEncodedState.selected = null;
          lazyEncodedState.matchIndices = null;
          return dimension;
        }

        for (i = 0; i < n; ++i) {
          wasSelected = currentSelected ? currentSelected[i] === 1 : true;
          isSelected = nextSelected ? nextSelected[i] === 1 : true;
          if (wasSelected === isSelected) {
            continue;
          }
          if (isSelected) {
            if (filters[offset][i] & one) {
              filters[offset][i] &= zero;
            }
            if (shouldNotify) {
              added.push(i);
            }
          } else {
            if (!(filters[offset][i] & one)) {
              filters[offset][i] |= one;
            }
            if (shouldNotify) {
              removed.push(i);
            }
          }
        }

        lazyEncodedState.selected = nextSelected;
        lazyEncodedState.matchIndices = nextMatches;
        if (shouldNotify) {
          notifyFilterListeners(one, offset, added, removed);
        }
        return dimension;
      }

      function applyLazyEncodedFilter(targetCodes, nextMode) {
        var matches;

        if (lazyCodesSelectAllRows(targetCodes)) {
          filterMode = nextMode;
          lo0 = 0;
          hi0 = 0;
          return applyLazySelectionState(null);
        }

        matches = runtimeController.findEncodedMatches(getLazyCodes(), targetCodes);
        // Copy from possible WASM memory view before it can be invalidated
        matches = new Uint32Array(matches);

        filterMode = nextMode;
        lo0 = 0;
        hi0 = 0;

        return applyLazySelectionState(matches);
      }

      function resolveLazyTargetCodes() {
        if (!lazyEncodedState || !filterValuePresent || filterMode === 'all') {
          return new Uint32Array(0);
        }

        if (lazyFilterTargetCodes) {
          var currentCodeCount = lazyEncodedState.codeToValue.length;
          if (currentCodeCount === lazyFilterTargetCodesVersion) {
            return lazyFilterTargetCodes;
          }
          // New codes appeared — rescan
          var codeToValue = lazyEncodedState.codeToValue,
              rangeCodes = [],
              code,
              v,
              range = filterValue;

          for (code = 1; code < codeToValue.length; ++code) {
            v = codeToValue[code];
            if (compareNaturalOrder(v, range[0]) >= 0 && compareNaturalOrder(v, range[1]) < 0) {
              rangeCodes.push(code);
            }
          }
          lazyFilterTargetCodes = new Uint32Array(rangeCodes);
          lazyFilterTargetCodesVersion = currentCodeCount;
          return lazyFilterTargetCodes;
        }

        if (filterMode === 'in') {
          return encodeLazyFilterValues(filterInValues || []);
        }

        return encodeLazyFilterValues([filterValue]);
      }

      function concatLazyMatchIndices(currentMatches, appendedMatches) {
        if (!currentMatches || !currentMatches.length) {
          return appendedMatches;
        }
        if (!appendedMatches || !appendedMatches.length) {
          return currentMatches;
        }

        var nextMatches = new Uint32Array(currentMatches.length + appendedMatches.length);
        nextMatches.set(currentMatches);
        nextMatches.set(appendedMatches, currentMatches.length);
        return nextMatches;
      }

      function applyLazyFilterToNewRows(n0, appendedCodes) {
        var currentMatches = normalizeLazyMatchIndices(lazyEncodedState.matchIndices),
            currentSelected,
            nextMatches,
            nextSelected,
            matches,
            i,
            rowIndex,
            targetCodes;

        if (!currentMatches) {
          return;
        }

        targetCodes = resolveLazyTargetCodes();
        if (!targetCodes) {
          materializeLazyEncodedState();
          return;
        }

        currentSelected = ensureLazySelection(currentMatches, lazyEncodedState.selected);
        if (currentSelected.length >= n) {
          // Buffer is already large enough — reuse it directly.
          nextSelected = currentSelected;
        } else {
          // Must grow — allocate exact size to preserve normalizeLazySelectionMask semantics.
          nextSelected = new Uint8Array(n);
          nextSelected.set(currentSelected);
        }
        matches = runtimeController.findEncodedMatches(appendedCodes, targetCodes);
        nextMatches = new Uint32Array(matches.length);

        for (i = 0; i < matches.length; ++i) {
          rowIndex = n0 + matches[i];
          nextSelected[rowIndex] = 1;
          nextMatches[i] = rowIndex;
        }

        for (rowIndex = n0; rowIndex < n; ++rowIndex) {
          if (!nextSelected[rowIndex]) {
            filters[offset][rowIndex] |= one;
          }
        }

        lazyEncodedState.matchIndices = normalizeLazyMatchIndices(concatLazyMatchIndices(currentMatches, nextMatches));
        lazyEncodedState.selected = normalizeLazySelectionMask(nextSelected);
      }

      function compactLazyEncodedState(reIndex) {
        var currentMatches = normalizeLazyMatchIndices(lazyEncodedState.matchIndices),
            nextLength = 0,
            i,
            nextCodes,
            nextMatchCount = 0,
            nextMatchIndices = currentMatches ? new Uint32Array(currentMatches.length) : null,
            nextSelected = lazyEncodedState.selected ? new Uint8Array(reIndex.length) : null,
            rowIndex;

        for (i = 0; i < reIndex.length; ++i) {
          if (reIndex[i] !== REMOVED_INDEX) {
            ++nextLength;
          }
        }

        var nextCodesCapacity = nextLength < 64 ? 64 : nextLength;
        nextCodes = new Uint32Array(nextCodesCapacity);
        if (nextSelected) {
          nextSelected = new Uint8Array(nextLength);
        }

        var existingCodes = getLazyCodes();
        for (i = 0, rowIndex = 0; i < reIndex.length; ++i) {
          if (reIndex[i] === REMOVED_INDEX) {
            continue;
          }
          nextCodes[rowIndex] = existingCodes[i];
          if (nextSelected && lazyEncodedState.selected[i]) {
            nextSelected[rowIndex] = 1;
          }
          ++rowIndex;
        }

        if (nextMatchIndices) {
          for (i = 0; i < currentMatches.length; ++i) {
            rowIndex = reIndex[currentMatches[i]];
            if (rowIndex === REMOVED_INDEX) {
              continue;
            }
            nextMatchIndices[nextMatchCount++] = rowIndex;
          }
          nextMatchIndices = normalizeLazyMatchIndices(nextMatchIndices.slice(0, nextMatchCount));
        }

        lazyEncodedState.codes = nextCodes;
        lazyEncodedState.codesLength = nextLength;
        lazyEncodedState.codeCounts = buildCodeCounts(
          nextCodes.subarray(0, nextLength),
          lazyEncodedState.codeToValue.length
        );
        lazyEncodedState.matchIndices = nextMatchIndices;
        lazyEncodedState.selected = normalizeLazySelectionMask(nextSelected);
        lo0 = 0;
        hi0 = 0;
      }

      function materializeLazyEncodedState() {
        if (!lazyEncodedState || values) {
          return;
        }

        var lazyCodes = getLazyCodes(),
            materializedValues = new Array(lazyCodes.length),
            bounds,
            i,
            ranges;

        for (i = 0; i < materializedValues.length; ++i) {
          materializedValues[i] = lazyEncodedState.codeToValue[lazyCodes[i]];
        }

        newValues = materializedValues;
        newIndex = sortRange(materializedValues.length);
        values = permute(newValues, newIndex);
        index = newIndex;
        newValues = newIndex = null;
        exactRangeCache.clear();

        if (filterMode === 'in') {
          ranges = exactRanges(filterInValues || []);
          lo0 = ranges.length ? ranges[0][0] : 0;
          hi0 = ranges.length ? ranges[ranges.length - 1][1] : 0;
        } else {
          bounds = refilter(values);
          lo0 = bounds[0];
          hi0 = bounds[1];
        }

        lazyEncodedState = null;
      }

      function hasLazyEncodedGroupingSupport() {
        if (!lazyEncodedState || values || iterable) {
          return false;
        }

        for (var code = 1; code < lazyEncodedState.codeToValue.length; ++code) {
          var encodedValue = lazyEncodedState.codeToValue[code];
          if (encodedValue === undefined || !(encodedValue >= encodedValue)) {
            return false;
          }
        }

        return true;
      }

      function setFilterValuePresent(nextPresent) {
        var currentPresent = filterValuePresent === true;
        nextPresent = !!nextPresent;
        if (currentPresent === nextPresent) {
          return;
        }
        activeDimensionFilterCount += nextPresent ? 1 : -1;
        filterValuePresent = nextPresent;
      }

      function hasOtherActiveDimensionFilters() {
        return activeDimensionFilterCount > (filterValuePresent ? 1 : 0);
      }

      function getExactRange(value) {
        if (exactRangeCache.has(value)) {
          return exactRangeCache.get(value);
        }

        var lo = bisect.left(values, value, 0, values.length),
            hi = bisect.right(values, value, lo, values.length),
            range = lo === hi ? null : [lo, hi];

        exactRangeCache.set(value, range);
        return range;
      }

      function exactRanges(filterValues) {
        if (!filterValues || !filterValues.length) {
          return [];
        }

        var ranges = [];
        for (var valueIndex = 0; valueIndex < filterValues.length; ++valueIndex) {
          var range = getExactRange(filterValues[valueIndex]),
              lastRange = ranges[ranges.length - 1];

          if (!range) {
            continue;
          }

          if (lastRange && range[0] <= lastRange[1]) {
            lastRange[1] = Math.max(lastRange[1], range[1]);
          } else {
            ranges.push([range[0], range[1]]);
          }
        }

        return ranges;
      }

      function resolveCurrentRanges() {
        if (!values) {
          return [];
        }

        switch (filterMode) {
          case 'all':
            return values.length ? [[0, values.length]] : [];
          case 'bounds':
            return lo0 === hi0 ? [] : [[lo0, hi0]];
          case 'in':
            return exactRanges(filterInValues);
          default:
            return null;
        }
      }

      function appendIndexedRange(rows, rowIndexes, start, end) {
        for (var i = start; i < end; ++i) {
          rows.push(index[i]);
          rowIndexes.push(i);
        }
      }

      function applyFilterChanges(added, removed, valueIndexAdded, valueIndexRemoved, includeEmptyRows) {
        var i,
            row;

        if(!iterable) {
          for(i = 0; i < added.length; i++) {
            filters[offset][added[i]] ^= one;
          }

          for(i = 0; i < removed.length; i++) {
            filters[offset][removed[i]] ^= one;
          }
        } else {
          var newAdded = [];
          var newRemoved = [];

          for (i = 0; i < added.length; i++) {
            iterablesIndexCount[added[i]]++;
            iterablesIndexFilterStatus[valueIndexAdded[i]] = 0;
            if(iterablesIndexCount[added[i]] === 1) {
              filters[offset][added[i]] ^= one;
              newAdded.push(added[i]);
            }
          }
          for (i = 0; i < removed.length; i++) {
            iterablesIndexCount[removed[i]]--;
            iterablesIndexFilterStatus[valueIndexRemoved[i]] = 1;
            if(iterablesIndexCount[removed[i]] === 0) {
              filters[offset][removed[i]] ^= one;
              newRemoved.push(removed[i]);
            }
          }

          added = newAdded;
          removed = newRemoved;

          if(includeEmptyRows) {
            for(i = 0; i < iterablesEmptyRows.length; i++) {
              if((filters[offset][row = iterablesEmptyRows[i]] & one)) {
                filters[offset][row] ^= one;
                added.push(row);
              }
            }
          } else {
            for(i = 0; i < iterablesEmptyRows.length; i++) {
              if(!(filters[offset][row = iterablesEmptyRows[i]] & one)) {
                filters[offset][row] ^= one;
                removed.push(row);
              }
            }
          }
        }

        notifyFilterListeners(one, offset, added, removed);
        return dimension;
      }

      function filterIndexRanges(oldRanges, newRanges, includeEmptyRows) {
        var added = [],
            removed = [],
            valueIndexAdded = [],
            valueIndexRemoved = [],
            previousRanges = oldRanges.map(function(range) { return [range[0], range[1]]; }),
            nextRanges = newRanges.map(function(range) { return [range[0], range[1]]; }),
            oldIndex = 0,
            newIndexPointer = 0;

        while (oldIndex < previousRanges.length || newIndexPointer < nextRanges.length) {
          var oldRange = previousRanges[oldIndex],
              newRange = nextRanges[newIndexPointer];

          if (!oldRange) {
            appendIndexedRange(added, valueIndexAdded, newRange[0], newRange[1]);
            ++newIndexPointer;
            continue;
          }

          if (!newRange) {
            appendIndexedRange(removed, valueIndexRemoved, oldRange[0], oldRange[1]);
            ++oldIndex;
            continue;
          }

          if (oldRange[1] <= newRange[0]) {
            appendIndexedRange(removed, valueIndexRemoved, oldRange[0], oldRange[1]);
            ++oldIndex;
            continue;
          }

          if (newRange[1] <= oldRange[0]) {
            appendIndexedRange(added, valueIndexAdded, newRange[0], newRange[1]);
            ++newIndexPointer;
            continue;
          }

          if (oldRange[0] < newRange[0]) {
            appendIndexedRange(removed, valueIndexRemoved, oldRange[0], newRange[0]);
          } else if (newRange[0] < oldRange[0]) {
            appendIndexedRange(added, valueIndexAdded, newRange[0], oldRange[0]);
          }

          if (oldRange[1] < newRange[1]) {
            nextRanges[newIndexPointer] = [oldRange[1], newRange[1]];
            ++oldIndex;
          } else if (newRange[1] < oldRange[1]) {
            previousRanges[oldIndex] = [newRange[1], oldRange[1]];
            ++newIndexPointer;
          } else {
            ++oldIndex;
            ++newIndexPointer;
          }
        }

        lo0 = newRanges.length ? newRanges[0][0] : 0;
        hi0 = newRanges.length ? newRanges[newRanges.length - 1][1] : 0;

        return applyFilterChanges(added, removed, valueIndexAdded, valueIndexRemoved, includeEmptyRows);
      }

      // Updating a dimension is a two-stage process. First, we must update the
      // associated filters for the newly-added records. Once all dimensions have
      // updated their filters, the groups are notified to update.
      dataListeners.unshift(preAdd);
      dataListeners.push(postAdd);

      removeDataListeners.push(removeData);

      // Add a new dimension in the filter bitmap and store the offset and bitmask.
      var tmp = filters.add();
      offset = tmp.offset;
      one = tmp.one;
      zero = ~one;

      // Create a unique ID for the dimension
      // IDs will be re-used if dimensions are disposed.
      // For internal use the ID is the subarray offset shifted left 7 bits or'd with the
      // bit offset of the set bit in the dimension's "one" mask.
      id = (offset << 7) | (Math.log(one) / Math.log(2));

      preAdd(data, 0, n);
      postAdd(data, 0, n);

      // Incorporates the specified new records into this dimension.
      // This function is responsible for updating filters, values, and index.
      function preAdd(newData, n0, n1) {
        var newIterablesIndexCount,
            sourceValues = null,
            columnAccessorSegment = accessorPath && !iterable && runtimeController.canUseWasmScan()
              ? findSingleColumnAccessorSegment(accessorPath, n0, n1)
              : null,
            useStoredRecords = !accessorPath && newData === data && columnarBatches.length,
            newIterablesIndexFilterStatus;

        function ensureSourceValues() {
          if (!accessorPath) {
            return null;
          }
          if (!sourceValues) {
            sourceValues = extractColumnValues(accessorPath, n0, n1);
          }
          return sourceValues;
        }

        function getSourceRecord(localIndex) {
          return useStoredRecords ? getRecord(n0 + localIndex) : newData[localIndex];
        }

        if (!iterable && accessorPath) {
          if (!n0 && !values) {
            lazyEncodedState = columnAccessorSegment
              ? createLazyEncodedStateFromAccessor(columnAccessorSegment.accessor, columnAccessorSegment.offset, n1)
              : createLazyEncodedState(ensureSourceValues());
            if (lazyEncodedState) {
              if (filterValuePresent && filterMode !== 'all') {
                var initialTargetCodes = resolveLazyTargetCodes();
                if (initialTargetCodes) {
                  var initialMatches = initialTargetCodes.length
                    ? runtimeController.findEncodedMatches(getLazyCodes(), initialTargetCodes)
                    : new Uint32Array(0);
                  initialMatches = new Uint32Array(initialMatches);
                  var initialSelected = new Uint8Array(n1);
                  for (var mi = 0; mi < initialMatches.length; ++mi) {
                    initialSelected[initialMatches[mi]] = 1;
                  }
                  for (var ri = 0; ri < n1; ++ri) {
                    if (!initialSelected[ri]) {
                      filters[offset][ri] |= one;
                    }
                  }
                  lazyEncodedState.matchIndices = normalizeLazyMatchIndices(initialMatches);
                  lazyEncodedState.selected = normalizeLazySelectionMask(initialSelected);
                }
              }
              lastAppendedCodes = getLazyCodes();
              lo0 = 0;
              hi0 = 0;
              return;
            }
          } else if (lazyEncodedState && !values) {
            var appendedCodes = columnAccessorSegment
              ? appendLazyEncodedValuesFromAccessor(columnAccessorSegment.accessor, columnAccessorSegment.offset, n1)
              : appendLazyEncodedValues(ensureSourceValues());
            if (appendedCodes) {
              applyLazyFilterToNewRows(n0, appendedCodes);
              lastAppendedCodes = appendedCodes;
              lo0 = 0;
              hi0 = 0;
              return;
            }
            materializeLazyEncodedState();
          }
        }

        if (iterable){
          sourceValues = ensureSourceValues();
          // Count all the values
          t = 0;
          j = 0;
          k = [];

          for (var i0 = 0; i0 < newData.length; i0++) {
            for(j = 0, k = sourceValues ? sourceValues[i0] : value(getSourceRecord(i0)); j < k.length; j++) {
              t++;
            }
          }

          newValues = [];
          newIterablesIndexCount = cr_range(newData.length);
          newIterablesIndexFilterStatus = cr_index(t,1);
          var unsortedIndex = cr_range(t);

          for (var l = 0, index1 = 0; index1 < newData.length; index1++) {
            k = sourceValues ? sourceValues[index1] : value(getSourceRecord(index1));
            //
            if(!k.length){
              newIterablesIndexCount[index1] = 0;
              iterablesEmptyRows.push(index1 + n0);
              continue;
            }
            newIterablesIndexCount[index1] = k.length;
            for (j = 0; j < k.length; j++) {
              newValues.push(k[j]);
              unsortedIndex[l] = index1;
              l++;
            }
          }

          // Create the Sort map used to sort both the values and the valueToData indices
          var sortMap = sortRange(t);

          // Use the sortMap to sort the newValues
          newValues = permute(newValues, sortMap);


          // Use the sortMap to sort the unsortedIndex map
          // newIndex should be a map of sortedValue -> crossfilterData
          newIndex = permute(unsortedIndex, sortMap);

        } else {
          // Permute new values into natural order using a standard sorted index.
          sourceValues = ensureSourceValues();
          if (sourceValues) {
            newValues = sourceValues;
          } else if (useStoredRecords) {
            newValues = new Array(n1);
            for (var recordIndex = 0; recordIndex < n1; ++recordIndex) {
              newValues[recordIndex] = value(getSourceRecord(recordIndex));
            }
          } else {
            newValues = newData.map(value);
          }
          newIndex = sortRange(n1);
          newValues = permute(newValues, newIndex);
        }

        // Bisect newValues to determine which new records are selected.
        var bounds = refilter(newValues), lo1 = bounds[0], hi1 = bounds[1];

        var index2, index3, index4;
        if(iterable) {
          n1 = t;
          if (refilterFunction) {
            for (index2 = 0; index2 < n1; ++index2) {
              if (!refilterFunction(newValues[index2], index2)) {
                if(--newIterablesIndexCount[newIndex[index2]] === 0) {
                  filters[offset][newIndex[index2] + n0] |= one;
                }
                newIterablesIndexFilterStatus[index2] = 1;
              }
            }
          } else {
            for (index3 = 0; index3 < lo1; ++index3) {
              if(--newIterablesIndexCount[newIndex[index3]] === 0) {
                filters[offset][newIndex[index3] + n0] |= one;
              }
              newIterablesIndexFilterStatus[index3] = 1;
            }
            for (index4 = hi1; index4 < n1; ++index4) {
              if(--newIterablesIndexCount[newIndex[index4]] === 0) {
                filters[offset][newIndex[index4] + n0] |= one;
              }
              newIterablesIndexFilterStatus[index4] = 1;
            }
          }
        } else {
          if (refilterFunction) {
            for (index2 = 0; index2 < n1; ++index2) {
              if (!refilterFunction(newValues[index2], index2)) {
                filters[offset][newIndex[index2] + n0] |= one;
              }
            }
          } else {
            for (index3 = 0; index3 < lo1; ++index3) {
              filters[offset][newIndex[index3] + n0] |= one;
            }
            for (index4 = hi1; index4 < n1; ++index4) {
              filters[offset][newIndex[index4] + n0] |= one;
            }
          }
        }

        // If this dimension previously had no data, then we don't need to do the
        // more expensive merge operation; use the new values and index as-is.
        if (!n0) {
          values = newValues;
          index = newIndex;
          iterablesIndexCount = newIterablesIndexCount;
          iterablesIndexFilterStatus = newIterablesIndexFilterStatus;
          exactRangeCache.clear();
          lo0 = lo1;
          hi0 = hi1;
          return;
        }



        var oldValues = values,
          oldIndex = index,
          oldIterablesIndexFilterStatus = iterablesIndexFilterStatus,
          old_n0,
          i1 = 0;

        i0 = 0;

        if(iterable){
          old_n0 = n0;
          n0 = oldValues.length;
          n1 = t;
        }

        // Otherwise, create new arrays into which to merge new and old.
        values = iterable ? new Array(n0 + n1) : new Array(n);
        index = iterable ? new Array(n0 + n1) : cr_index(n, n);
        if(iterable) iterablesIndexFilterStatus = cr_index(n0 + n1, 1);

        // Concatenate the newIterablesIndexCount onto the old one.
        if(iterable) {
          var oldiiclength = iterablesIndexCount.length;
          iterablesIndexCount = xfilterArray.arrayLengthen(iterablesIndexCount, n);
          for(var j=0; j+oldiiclength < n; j++) {
            iterablesIndexCount[j+oldiiclength] = newIterablesIndexCount[j];
          }
        }

        // Merge the old and new sorted values, and old and new index.
        var index5 = 0;
        for (; i0 < n0 && i1 < n1; ++index5) {
          if (compareNaturalOrder(oldValues[i0], newValues[i1]) < 0) {
            values[index5] = oldValues[i0];
            if(iterable) iterablesIndexFilterStatus[index5] = oldIterablesIndexFilterStatus[i0];
            index[index5] = oldIndex[i0++];
          } else {
            values[index5] = newValues[i1];
            if(iterable) iterablesIndexFilterStatus[index5] = newIterablesIndexFilterStatus[i1];
            index[index5] = newIndex[i1++] + (iterable ? old_n0 : n0);
          }
        }

        // Add any remaining old values.
        for (; i0 < n0; ++i0, ++index5) {
          values[index5] = oldValues[i0];
          if(iterable) iterablesIndexFilterStatus[index5] = oldIterablesIndexFilterStatus[i0];
          index[index5] = oldIndex[i0];
        }

        // Add any remaining new values.
        for (; i1 < n1; ++i1, ++index5) {
          values[index5] = newValues[i1];
          if(iterable) iterablesIndexFilterStatus[index5] = newIterablesIndexFilterStatus[i1];
          index[index5] = newIndex[i1] + (iterable ? old_n0 : n0);
        }

        // Bisect again to recompute lo0 and hi0.
        exactRangeCache.clear();
        bounds = refilter(values), lo0 = bounds[0], hi0 = bounds[1];
      }

      // When all filters have updated, notify index listeners of the new values.
      function postAdd(newData, n0, n1) {
        indexListeners.forEach(function(l) { l(newValues, newIndex, n0, n1, lastAppendedCodes); });
        newValues = newIndex = null;
        lastAppendedCodes = null;
      }

      function removeData(reIndex) {
        if (lazyEncodedState && !values) {
          compactLazyEncodedState(reIndex);
          return;
        }

        if (iterable) {
          for (var i0 = 0, i1 = 0; i0 < iterablesEmptyRows.length; i0++) {
            if (reIndex[iterablesEmptyRows[i0]] !== REMOVED_INDEX) {
              iterablesEmptyRows[i1] = reIndex[iterablesEmptyRows[i0]];
              i1++;
            }
          }
          iterablesEmptyRows.length = i1;
          for (i0 = 0, i1 = 0; i0 < n; i0++) {
            if (reIndex[i0] !== REMOVED_INDEX) {
              if (i1 !== i0) iterablesIndexCount[i1] = iterablesIndexCount[i0];
              i1++;
            }
          }
          iterablesIndexCount = iterablesIndexCount.slice(0, i1);
        }
        // Rewrite our index, overwriting removed values
        var n0 = values.length;
        for (var i = 0, j = 0, oldDataIndex; i < n0; ++i) {
          oldDataIndex = index[i];
          if (reIndex[oldDataIndex] !== REMOVED_INDEX) {
            if (i !== j) values[j] = values[i];
            index[j] = reIndex[oldDataIndex];
            if (iterable) {
              iterablesIndexFilterStatus[j] = iterablesIndexFilterStatus[i];
            }
            ++j;
          }
        }
        values.length = j;
        if (iterable) iterablesIndexFilterStatus = iterablesIndexFilterStatus.slice(0, j);
        while (j < n0) index[j++] = 0;

        // Bisect again to recompute lo0 and hi0.
        exactRangeCache.clear();
        var bounds = refilter(values);
        lo0 = bounds[0], hi0 = bounds[1];
      }

      // Updates the selected values based on the specified bounds [lo, hi].
      // This implementation is used by all the public filter methods.
      function filterIndexBounds(bounds, includeEmptyRows, nextMode) {
        var lo1 = bounds[0],
            hi1 = bounds[1],
            previousMode = filterMode,
            oldRanges = resolveCurrentRanges(),
            newRanges = lo1 === hi1 ? [] : [[lo1, hi1]];

        if (includeEmptyRows === undefined) {
          includeEmptyRows = false;
        }
        if (nextMode === undefined) {
          nextMode = 'bounds';
        }

        if (oldRanges === null) {
          refilterFunction = null;
          filterMode = nextMode;
          filterInValues = null;
          filterIndexFunction(function(d, i) { return lo1 <= i && i < hi1; }, includeEmptyRows);
          lo0 = lo1;
          hi0 = hi1;
          return dimension;
        }

        refilterFunction = null;
        filterMode = nextMode;
        filterInValues = null;

        if (previousMode === 'in') {
          return filterIndexRanges(oldRanges, newRanges, includeEmptyRows);
        }

        var i,
            j,
            added = [],
            removed = [],
            valueIndexAdded = [],
            valueIndexRemoved = [];

        if (lo1 < lo0) {
          for (i = lo1, j = Math.min(lo0, hi1); i < j; ++i) {
            added.push(index[i]);
            valueIndexAdded.push(i);
          }
        } else if (lo1 > lo0) {
          for (i = lo0, j = Math.min(lo1, hi0); i < j; ++i) {
            removed.push(index[i]);
            valueIndexRemoved.push(i);
          }
        }

        if (hi1 > hi0) {
          for (i = Math.max(lo1, hi0), j = hi1; i < j; ++i) {
            added.push(index[i]);
            valueIndexAdded.push(i);
          }
        } else if (hi1 < hi0) {
          for (i = Math.max(lo0, hi1), j = hi0; i < j; ++i) {
            removed.push(index[i]);
            valueIndexRemoved.push(i);
          }
        }

        lo0 = lo1;
        hi0 = hi1;

        return applyFilterChanges(added, removed, valueIndexAdded, valueIndexRemoved, includeEmptyRows);
      }

      // Filters this dimension using the specified range, value, or null.
      // If the range is null, this is equivalent to filterAll.
      // If the range is an array, this is equivalent to filterRange.
      // Otherwise, this is equivalent to filterExact.
      function filter(range) {
        return range == null
            ? filterAll() : Array.isArray(range)
            ? filterRange(range) : typeof range === "function"
            ? filterFunction(range)
            : filterExact(range);
      }

      // Filters this dimension to select the exact value.
      function filterExact(value) {
        lazyFilterTargetCodes = null;
        lazyFilterTargetCodesVersion = 0;
        if (lazyEncodedState && !values) {
          var exactCodes = encodeLazyFilterValues([value]);
          if (exactCodes) {
            filterValue = value;
            setFilterValuePresent(true);
            refilter = xfilterFilter.filterExact(bisect, value);
            refilterFunction = null;
            filterInValues = null;
            return applyLazyEncodedFilter(exactCodes, 'bounds');
          }
          materializeLazyEncodedState();
        }

        filterValue = value;
        setFilterValuePresent(true);
        refilter = xfilterFilter.filterExact(bisect, value);
        var range = getExactRange(value);
        return filterIndexBounds(range || [0, 0], false, 'bounds');
      }

      function filterIn(valuesToSelect) {
        lazyFilterTargetCodes = null;
        lazyFilterTargetCodesVersion = 0;
        if (lazyEncodedState && !values) {
          var lazyExactFilterValues = normalizeExactFilterValues(valuesToSelect),
              lazyEncodedValues = encodeLazyFilterValues(lazyExactFilterValues);

          if (lazyEncodedValues) {
            filterValue = valuesToSelect;
            setFilterValuePresent(true);
            refilter = xfilterFilter.filterAll;
            refilterFunction = null;
            filterMode = 'in';
            filterInValues = lazyExactFilterValues;
            return applyLazyEncodedFilter(lazyEncodedValues, 'in');
          }

          materializeLazyEncodedState();
        }

        var exactFilterValues = normalizeExactFilterValues(valuesToSelect),
            nextRanges = exactRanges(exactFilterValues),
            previousRanges = resolveCurrentRanges(),
            selectedValues = new Set(exactFilterValues),
            predicate = function(d) { return selectedValues.has(d); };

        filterValue = valuesToSelect;
        setFilterValuePresent(true);
        refilter = xfilterFilter.filterAll;
        refilterFunction = predicate;
        filterMode = 'in';
        filterInValues = exactFilterValues;

        if (previousRanges === null) {
          filterIndexFunction(predicate, false);
          lo0 = nextRanges.length ? nextRanges[0][0] : 0;
          hi0 = nextRanges.length ? nextRanges[nextRanges.length - 1][1] : 0;
          return dimension;
        }

        return filterIndexRanges(previousRanges, nextRanges, false);
      }

      // Filters this dimension to select the specified range [lo, hi].
      // The lower bound is inclusive, and the upper bound is exclusive.
      function filterRange(range) {
        if (lazyEncodedState && !values && hasLazyEncodedGroupingSupport()) {
          var codeToValue = lazyEncodedState.codeToValue,
              rangeCodes = [],
              rangeCode,
              rangeValue;

          for (rangeCode = 1; rangeCode < codeToValue.length; ++rangeCode) {
            rangeValue = codeToValue[rangeCode];
            if (compareNaturalOrder(rangeValue, range[0]) >= 0 && compareNaturalOrder(rangeValue, range[1]) < 0) {
              rangeCodes.push(rangeCode);
            }
          }

          filterValue = range;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterRange(bisect, range);
          refilterFunction = null;
          filterInValues = null;
          filterMode = 'bounds';
          lazyFilterTargetCodes = new Uint32Array(rangeCodes);
          lazyFilterTargetCodesVersion = codeToValue.length;
          return applyLazyEncodedFilter(lazyFilterTargetCodes, 'bounds');
        }

        if (lazyEncodedState && !values) {
          materializeLazyEncodedState();
        }

        filterValue = range;
        setFilterValuePresent(true);
        return filterIndexBounds((refilter = xfilterFilter.filterRange(bisect, range))(values), false, 'bounds');
      }

      // Clears any filters on this dimension.
      function filterAll() {
        lazyFilterTargetCodes = null;
        lazyFilterTargetCodesVersion = 0;
        if (lazyEncodedState && !values) {
          filterValue = undefined;
          setFilterValuePresent(false);
          refilter = xfilterFilter.filterAll;
          refilterFunction = null;
          filterInValues = null;
          return applyLazySelectionState(null);
        }

        filterValue = undefined;
        setFilterValuePresent(false);
        refilter = xfilterFilter.filterAll;

        return filterIndexBounds((refilter = xfilterFilter.filterAll)(values), true, 'all');
      }

      // Filters this dimension using an arbitrary function.
      function filterFunction(f) {
        lazyFilterTargetCodes = null;
        lazyFilterTargetCodesVersion = 0;
        if (lazyEncodedState && !values) {
          materializeLazyEncodedState();
        }

        filterValue = f;
        setFilterValuePresent(true);

        refilterFunction = f;
        refilter = xfilterFilter.filterAll;
        filterMode = 'function';
        filterInValues = null;

        filterIndexFunction(f, false);

        var bounds = refilter(values);
        lo0 = bounds[0], hi0 = bounds[1];

        return dimension;
      }

      function filterIndexFunction(f, filterAll) {
        var i,
            k,
            x,
            added = [],
            removed = [],
            valueIndexAdded = [],
            valueIndexRemoved = [],
            indexLength = values.length;

        if(!iterable) {
          for (i = 0; i < indexLength; ++i) {
            if (!(filters[offset][k = index[i]] & one) ^ !!(x = f(values[i], i))) {
              if (x) added.push(k);
              else removed.push(k);
            }
          }
        }

        if(iterable) {
          for(i=0; i < indexLength; ++i) {
            if(f(values[i], i)) {
              added.push(index[i]);
              valueIndexAdded.push(i);
            } else {
              removed.push(index[i]);
              valueIndexRemoved.push(i);
            }
          }
        }

        if(!iterable) {
          for(i=0; i<added.length; i++) {
            if(filters[offset][added[i]] & one) filters[offset][added[i]] &= zero;
          }

          for(i=0; i<removed.length; i++) {
            if(!(filters[offset][removed[i]] & one)) filters[offset][removed[i]] |= one;
          }
        } else {

          var newAdded = [];
          var newRemoved = [];
          for (i = 0; i < added.length; i++) {
            // First check this particular value needs to be added
            if(iterablesIndexFilterStatus[valueIndexAdded[i]] === 1) {
              iterablesIndexCount[added[i]]++;
              iterablesIndexFilterStatus[valueIndexAdded[i]] = 0;
              if(iterablesIndexCount[added[i]] === 1) {
                filters[offset][added[i]] ^= one;
                newAdded.push(added[i]);
              }
            }
          }
          for (i = 0; i < removed.length; i++) {
            // First check this particular value needs to be removed
            if(iterablesIndexFilterStatus[valueIndexRemoved[i]] === 0) {
              iterablesIndexCount[removed[i]]--;
              iterablesIndexFilterStatus[valueIndexRemoved[i]] = 1;
              if(iterablesIndexCount[removed[i]] === 0) {
                filters[offset][removed[i]] ^= one;
                newRemoved.push(removed[i]);
              }
            }
          }

          added = newAdded;
          removed = newRemoved;

          // Now handle empty rows.
          if(filterAll) {
            for(i = 0; i < iterablesEmptyRows.length; i++) {
              if((filters[offset][k = iterablesEmptyRows[i]] & one)) {
                // Was not in the filter, so set the filter and add
                filters[offset][k] ^= one;
                added.push(k);
              }
            }
          } else {
            // filter in place - remove empty rows if necessary
            for(i = 0; i < iterablesEmptyRows.length; i++) {
              if(!(filters[offset][k = iterablesEmptyRows[i]] & one)) {
                // Was in the filter, so set the filter and remove
                filters[offset][k] ^= one;
                removed.push(k);
              }
            }
          }
        }

        notifyFilterListeners(one, offset, added, removed);
      }

      function currentFilter() {
        return filterValue;
      }

      function hasCurrentFilter() {
        return filterValuePresent;
      }

      // Returns the top K selected records based on this dimension's order.
      // Note: observes this dimension's filter, unlike group and groupAll.
      function top(k, top_offset) {
        materializeLazyEncodedState();

        var array = [],
            i = hi0,
            j,
            toSkip = 0;

        if(top_offset && top_offset > 0) toSkip = top_offset;

        while (--i >= lo0 && k > 0) {
          if (filters.zero(j = index[i])) {
            if(toSkip > 0) {
              //skip matching row
              --toSkip;
            } else {
              array.push(getRecord(j));
              --k;
            }
          }
        }

        if(iterable){
          for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
            // Add row with empty iterable column at the end
            if(filters.zero(j = iterablesEmptyRows[i])) {
              if(toSkip > 0) {
                //skip matching row
                --toSkip;
              } else {
                array.push(getRecord(j));
                --k;
              }
            }
          }
        }

        return array;
      }

      function topIndex(k, top_offset) {
        materializeLazyEncodedState();

        var array = [],
            i = hi0,
            j,
            toSkip = 0;

        if(top_offset && top_offset > 0) toSkip = top_offset;

        while (--i >= lo0 && k > 0) {
          if (filters.zero(j = index[i])) {
            if(toSkip > 0) {
              --toSkip;
            } else {
              array.push(j);
              --k;
            }
          }
        }

        if(iterable){
          for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
            if(filters.zero(j = iterablesEmptyRows[i])) {
              if(toSkip > 0) {
                --toSkip;
              } else {
                array.push(j);
                --k;
              }
            }
          }
        }

        return array;
      }

      // Returns the bottom K selected records based on this dimension's order.
      // Note: observes this dimension's filter, unlike group and groupAll.
      function bottom(k, bottom_offset) {
        materializeLazyEncodedState();

        var array = [],
            i,
            j,
            toSkip = 0;

        if(bottom_offset && bottom_offset > 0) toSkip = bottom_offset;

        if(iterable) {
          // Add row with empty iterable column at the top
          for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
            if(filters.zero(j = iterablesEmptyRows[i])) {
              if(toSkip > 0) {
                //skip matching row
                --toSkip;
              } else {
                array.push(getRecord(j));
                --k;
              }
            }
          }
        }

        i = lo0;

        while (i < hi0 && k > 0) {
          if (filters.zero(j = index[i])) {
            if(toSkip > 0) {
              //skip matching row
              --toSkip;
            } else {
              array.push(getRecord(j));
              --k;
            }
          }
          i++;
        }

        return array;
      }

      function bottomIndex(k, bottom_offset) {
        materializeLazyEncodedState();

        var array = [],
            i,
            j,
            toSkip = 0;

        if(bottom_offset && bottom_offset > 0) toSkip = bottom_offset;

        if(iterable) {
          for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
            if(filters.zero(j = iterablesEmptyRows[i])) {
              if(toSkip > 0) {
                --toSkip;
              } else {
                array.push(j);
                --k;
              }
            }
          }
        }

        i = lo0;

        while (i < hi0 && k > 0) {
          if (filters.zero(j = index[i])) {
            if(toSkip > 0) {
              --toSkip;
            } else {
              array.push(j);
              --k;
            }
          }
          i++;
        }

        return array;
      }

      // Adds a new group to this dimension, using the specified key function.
      function group(key) {
        if (arguments.length < 1) key = cr_identity;

        var useLazyEncodedGrouping = (key === cr_identity || key === cr_null) && hasLazyEncodedGroupingSupport();
        if (!useLazyEncodedGrouping) {
          materializeLazyEncodedState();
        }

        var group = {
          top: top,
          all: all,
          reduce: reduce,
          reduceCount: reduceCount,
          reduceSum: reduceSum,
          order: order,
          orderNatural: orderNatural,
          size: size,
          dispose: dispose,
          remove: dispose // for backwards-compatibility
        };

        // Ensure that this group will be removed when the dimension is removed.
        dimensionGroups.push(group);

        var groups, // array of {key, value}
            groupIndex, // object id ↦ group id
            groupWidth = 8,
            groupCapacity = capacity(groupWidth),
            k = 0, // cardinality
            lazyCodeToGroup = null,
            select,
            heap,
            reduceAdd,
            reduceRemove,
            reduceInitial,
            reduceMetricSpec = null,
            reduceMode = null,
            update = cr_null,
            reset = cr_null,
            resetNeeded = true,
            markResetNeeded = registerResetListener(function() {
              resetNeeded = true;
            }),
            groupAll = key === cr_null,
            n0old;

        // The group listens to the crossfilter for when any dimension changes, so
        // that it can update the associated reduce values. It must also listen to
        // the parent dimension for when data is added, and compute new keys.
        filterListeners.push(update);
        indexListeners.push(add);
        removeDataListeners.push(removeData);

        // Incorporate any existing data into the grouping.
        add(values, index, 0, n);

        // Incorporates the specified new values into this group.
        // This function is responsible for updating groups and groupIndex.
        function add(newValues, newIndex, n0, n1, appendedCodes) {

          // Incremental lazy append: groups already exist, dimension is still encoded
          if (appendedCodes && lazyEncodedState && !values && k > 0) {
            // groupAll (k=1, no groupIndex): just mark reset needed
            if (groupAll) {
              resetNeeded = true;
              return;
            }

            if (lazyCodeToGroup) {
            var hasNewGroups = false,
                incrCode,
                incrI;

            for (incrI = 0; incrI < appendedCodes.length; ++incrI) {
              incrCode = appendedCodes[incrI];
              if (incrCode > 0 && lazyCodeToGroup[incrCode] === undefined) {
                hasNewGroups = true;
                break;
              }
            }

            if (!hasNewGroups) {
              // Fast path: extend groupIndex for new rows, no new groups
              if (k > 1) {
                groupIndex = xfilterArray.arrayLengthen(groupIndex, n);
                for (incrI = 0; incrI < appendedCodes.length; ++incrI) {
                  groupIndex[n0 + incrI] = lazyCodeToGroup[appendedCodes[incrI]];
                }
              }
              resetNeeded = true;
              return;
            }
            // hasNewGroups: fall through to full lazy rebuild below
            }
          }

          if (useLazyEncodedGrouping && lazyEncodedState && !values) {
            var codeToValue = lazyEncodedState.codeToValue,
                codes = getLazyCodes(),
                sortedCodes = [],
                initialValue = resetNeeded ? cr_null : reduceInitial,
                rowIndex,
                encodedCode,
                sortIndex;

            groups = [];
            k = 0;

            for (var code = 1; code < codeToValue.length; ++code) {
              if (!isNaturallyOrderable(codeToValue[code])) {
                continue;
              }
              sortedCodes.push(code);
            }

            sortedCodes.sort(function(a, b) {
              var valueA = codeToValue[a],
                  valueB = codeToValue[b];
              var order = compareNaturalOrder(valueA, valueB);
              return order || a - b;
            });

            if (groupAll) {
              k = 1;
              groups = [{key: null, value: initialValue()}];
              groupIndex = null;
              lazyCodeToGroup = null;
            } else if (!sortedCodes.length) {
              k = 0;
              groups = [];
              groupIndex = null;
              lazyCodeToGroup = null;
            } else {
              while (sortedCodes.length > groupCapacity) {
                groupWidth <<= 1;
                groupCapacity = capacity(groupWidth);
              }

              lazyCodeToGroup = new Array(codeToValue.length);

              for (sortIndex = 0; sortIndex < sortedCodes.length; ++sortIndex) {
                encodedCode = sortedCodes[sortIndex];
                groups[sortIndex] = {key: codeToValue[encodedCode], value: initialValue()};
                lazyCodeToGroup[encodedCode] = sortIndex;
              }

              k = groups.length;
              groupIndex = k > 1 ? cr_index(n, groupCapacity) : null;

              if (groupIndex) {
                for (rowIndex = 0; rowIndex < n; ++rowIndex) {
                  groupIndex[rowIndex] = lazyCodeToGroup[codes[rowIndex]];
                }
              }
            }

            resetNeeded = true;

            var listenerIndex = filterListeners.indexOf(update);
            if (k > 1) {
              update = updateMany;
              reset = resetMany;
            } else if (k === 1) {
              update = updateOne;
              reset = resetOne;
              groupIndex = null;
            } else {
              update = cr_null;
              reset = cr_null;
              groupIndex = null;
            }
            filterListeners[listenerIndex] = update;
            return;
          }

          if(iterable) {
            n0old = n0;
            n0 = values.length - newValues.length;
            n1 = newValues.length;
          }

          var oldGroups = groups,
              reIndex = iterable ? [] : cr_index(k, groupCapacity),
              add = reduceAdd,
              remove = reduceRemove,
              initial = reduceInitial,
              k0 = k, // old cardinality
              i0 = 0, // index of old group
              i1 = 0, // index of new record
              j, // object id
              g0, // old group
              x0, // old key
              x1, // new key
              g, // group to add
              x; // key of group to add

          // If a reset is needed, we don't need to update the reduce values.
          if (resetNeeded) add = initial = cr_null;
          if (resetNeeded) remove = initial = cr_null;

          // Reset the new groups (k is a lower bound).
          // Also, make sure that groupIndex exists and is long enough.
          groups = new Array(k), k = 0;
          if(iterable){
            groupIndex = k0 ? groupIndex : [];
          }
          else {
            groupIndex = k0 > 1 ? xfilterArray.arrayLengthen(groupIndex, n) : cr_index(n, groupCapacity);
          }


          // Get the first old key (x0 of g0), if it exists.
          if (k0) x0 = (g0 = oldGroups[0]).key;

          // Find the first new key (x1), skipping NaN keys.
          while (i1 < n1 && !isNaturallyOrderable(x1 = key(newValues[i1]))) ++i1;

          // While new keys remain…
          while (i1 < n1) {

            // Determine the lesser of the two current keys; new and old.
            // If there are no old keys remaining, then always add the new key.
            if (g0 && compareNaturalOrder(x0, x1) <= 0) {
              g = g0, x = x0;

              // Record the new index of the old group.
              reIndex[i0] = k;

              // Retrieve the next old key.
              g0 = oldGroups[++i0];
              if (g0) x0 = g0.key;
            } else {
              g = {key: x1, value: initial()}, x = x1;
            }

            // Add the lesser group.
            groups[k] = g;

            // Add any selected records belonging to the added group, while
            // advancing the new key and populating the associated group index.

            while (compareNaturalOrder(x1, x) <= 0) {
              j = newIndex[i1] + (iterable ? n0old : n0);


              if(iterable){
                if(groupIndex[j]){
                  groupIndex[j].push(k);
                }
                else {
                  groupIndex[j] = [k];
                }
              }
              else {
                groupIndex[j] = k;
              }

              // Always add new values to groups. Only remove when another dimension has filtered them out.
              // This gives groups full information on data life-cycle without paying for no-op filter checks.
              if (reduceMode === 'count') {
                if (!resetNeeded) {
                  g.value += 1;
                  if (hasOtherActiveDimensionFilters() && !filters.zeroExcept(j, offset, zero)) {
                    g.value -= 1;
                  }
                }
              } else if (reduceMode === 'metricSpec') {
                if (!resetNeeded) {
                  g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, j, 1);
                  if (hasOtherActiveDimensionFilters() && !filters.zeroExcept(j, offset, zero)) {
                    g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, j, -1);
                  }
                }
              } else {
                var rowRecord = getRecord(j);
                g.value = add(g.value, rowRecord, true);
                if (hasOtherActiveDimensionFilters() && !filters.zeroExcept(j, offset, zero)) g.value = remove(g.value, rowRecord, false);
              }
              if (++i1 >= n1) break;
              x1 = key(newValues[i1]);
            }

            groupIncrement();
          }

          // Add any remaining old groups that were greater th1an all new keys.
          // No incremental reduce is needed; these groups have no new records.
          // Also record the new index of the old group.
          while (i0 < k0) {
            groups[reIndex[i0] = k] = oldGroups[i0++];
            groupIncrement();
          }


          // Fill in gaps with empty arrays where there may have been rows with empty iterables
          if(iterable){
            for (var index1 = 0; index1 < n; index1++) {
              if(!groupIndex[index1]){
                groupIndex[index1] = [];
              }
            }
          }

          // If we added any new groups before any old groups,
          // update the group index of all the old records.
          if(k > i0){
            if(iterable){
              for (i0 = 0; i0 < n0old; ++i0) {
                for (index1 = 0; index1 < groupIndex[i0].length; index1++) {
                  groupIndex[i0][index1] = reIndex[groupIndex[i0][index1]];
                }
              }
            }
            else {
              for (i0 = 0; i0 < n0; ++i0) {
                groupIndex[i0] = reIndex[groupIndex[i0]];
              }
            }
          }

          // Modify the update and reset behavior based on the cardinality.
          // If the cardinality is less than or equal to one, then the groupIndex
          // is not needed. If the cardinality is zero, then there are no records
          // and therefore no groups to update or reset. Note that we also must
          // change the registered listener to point to the new method.
          j = filterListeners.indexOf(update);
          if (k > 1 || iterable) {
            update = updateMany;
            reset = resetMany;
          } else {
            if (!k && groupAll) {
              k = 1;
              groups = [{key: null, value: initial()}];
            }
            if (k === 1) {
              update = updateOne;
              reset = resetOne;
            } else {
              update = cr_null;
              reset = cr_null;
            }
            groupIndex = null;
          }
          filterListeners[j] = update;

          // Count the number of added groups,
          // and widen the group index as needed.
          function groupIncrement() {
            if(iterable){
              k++;
              return
            }
            if (++k === groupCapacity) {
              reIndex = xfilterArray.arrayWiden(reIndex, groupWidth <<= 1);
              groupIndex = xfilterArray.arrayWiden(groupIndex, groupWidth);
              groupCapacity = capacity(groupWidth);
            }
          }
        }

        function removeData(reIndex) {
          lazyCodeToGroup = null;
          if (k > 1 || iterable) {
            var oldK = k,
                oldGroups = groups,
                seenGroups = cr_index(oldK, oldK),
                i,
                i0,
                j;

            // Filter out non-matches by copying matching group index entries to
            // the beginning of the array.
            if (!iterable) {
              for (i = 0, j = 0; i < n; ++i) {
                if (reIndex[i] !== REMOVED_INDEX) {
                  seenGroups[groupIndex[j] = groupIndex[i]] = 1;
                  ++j;
                }
              }
            } else {
              for (i = 0, j = 0; i < n; ++i) {
                if (reIndex[i] !== REMOVED_INDEX) {
                  groupIndex[j] = groupIndex[i];
                  for (i0 = 0; i0 < groupIndex[j].length; i0++) {
                    seenGroups[groupIndex[j][i0]] = 1;
                  }
                  ++j;
                }
              }
              groupIndex = groupIndex.slice(0, j);
            }

            // Reassemble groups including only those groups that were referred
            // to by matching group index entries.  Note the new group index in
            // seenGroups.
            groups = [], k = 0;
            for (i = 0; i < oldK; ++i) {
              if (seenGroups[i]) {
                seenGroups[i] = k++;
                groups.push(oldGroups[i]);
              }
            }

            if (k > 1 || iterable) {
              // Reindex the group index using seenGroups to find the new index.
              if (!iterable) {
                for (i = 0; i < j; ++i) groupIndex[i] = seenGroups[groupIndex[i]];
              } else {
                for (i = 0; i < j; ++i) {
                  for (i0 = 0; i0 < groupIndex[i].length; ++i0) {
                    groupIndex[i][i0] = seenGroups[groupIndex[i][i0]];
                  }
                }
              }
            } else {
              groupIndex = null;
            }
            filterListeners[filterListeners.indexOf(update)] = k > 1 || iterable
                ? (reset = resetMany, update = updateMany)
                : k === 1 ? (reset = resetOne, update = updateOne)
                : reset = update = cr_null;
          } else if (k === 1) {
            if (groupAll) return;
            for (var index3 = 0; index3 < n; ++index3) if (reIndex[index3] !== REMOVED_INDEX) return;
            groups = [], k = 0;
            filterListeners[filterListeners.indexOf(update)] =
            update = reset = cr_null;
          }
        }

        // Reduces the specified selected or deselected records.
        // This function is only used when the cardinality is greater than 1.
        // notFilter indicates a crossfilter.add/remove operation.
        function updateMany(filterOne, filterOffset, added, removed, notFilter) {

          if ((filterOne === one && filterOffset === offset) || resetNeeded) return;

          var i,
              j,
              k,
              n,
              g;

          if(iterable){
            // Add the added values.
            for (i = 0, n = added.length; i < n; ++i) {
              if (filters.zeroExcept(k = added[i], offset, zero)) {
                for (j = 0; j < groupIndex[k].length; j++) {
                  g = groups[groupIndex[k][j]];
                  if (reduceMode === 'count') {
                    g.value += 1;
                  } else if (reduceMode === 'metricSpec') {
                    g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, k, 1);
                  } else {
                    g.value = reduceAdd(g.value, getRecord(k), false, j);
                  }
                }
              }
            }

            // Remove the removed values.
            for (i = 0, n = removed.length; i < n; ++i) {
              if (filters.onlyExcept(k = removed[i], offset, zero, filterOffset, filterOne)) {
                for (j = 0; j < groupIndex[k].length; j++) {
                  g = groups[groupIndex[k][j]];
                  if (reduceMode === 'count') {
                    g.value -= 1;
                  } else if (reduceMode === 'metricSpec') {
                    g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, k, -1);
                  } else {
                    g.value = reduceRemove(g.value, getRecord(k), notFilter, j);
                  }
                }
              }
            }
            return;
          }

          // Add the added values.
          for (i = 0, n = added.length; i < n; ++i) {
            if (filters.zeroExcept(k = added[i], offset, zero)) {
              g = groups[groupIndex[k]];
              if (reduceMode === 'count') {
                g.value += 1;
              } else if (reduceMode === 'metricSpec') {
                g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, k, 1);
              } else {
                g.value = reduceAdd(g.value, getRecord(k), false);
              }
            }
          }

          // Remove the removed values.
          for (i = 0, n = removed.length; i < n; ++i) {
            if (filters.onlyExcept(k = removed[i], offset, zero, filterOffset, filterOne)) {
              g = groups[groupIndex[k]];
              if (reduceMode === 'count') {
                g.value -= 1;
              } else if (reduceMode === 'metricSpec') {
                g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, k, -1);
              } else {
                g.value = reduceRemove(g.value, getRecord(k), notFilter);
              }
            }
          }
        }

        // Reduces the specified selected or deselected records.
        // This function is only used when the cardinality is 1.
        // notFilter indicates a crossfilter.add/remove operation.
        function updateOne(filterOne, filterOffset, added, removed, notFilter) {
          if ((filterOne === one && filterOffset === offset) || resetNeeded) return;

          var i,
              k,
              n,
              g = groups[0];

          // Add the added values.
          for (i = 0, n = added.length; i < n; ++i) {
            if (filters.zeroExcept(k = added[i], offset, zero)) {
              if (reduceMode === 'count') {
                g.value += 1;
              } else if (reduceMode === 'metricSpec') {
                g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, k, 1);
              } else {
                g.value = reduceAdd(g.value, getRecord(k), false);
              }
            }
          }

          // Remove the removed values.
          for (i = 0, n = removed.length; i < n; ++i) {
            if (filters.onlyExcept(k = removed[i], offset, zero, filterOffset, filterOne)) {
              if (reduceMode === 'count') {
                g.value -= 1;
              } else if (reduceMode === 'metricSpec') {
                g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, k, -1);
              } else {
                g.value = reduceRemove(g.value, getRecord(k), notFilter);
              }
            }
          }
        }

        // Recomputes the group reduce values from scratch.
        // This function is only used when the cardinality is greater than 1.
        function resetMany() {
          var i,
              j,
              g,
              applyFilteredRemovals = hasOtherActiveDimensionFilters();

          // Reset all group values.
          for (i = 0; i < k; ++i) {
            groups[i].value = reduceInitial();
          }

          // We add all records and then remove filtered records so that reducers
          // can build an 'unfiltered' view even if there are already filters in
          // place on other dimensions.
          if(iterable){
            for (i = 0; i < n; ++i) {
              for (j = 0; j < groupIndex[i].length; j++) {
                g = groups[groupIndex[i][j]];
                if (reduceMode === 'count') {
                  g.value += 1;
                } else if (reduceMode === 'metricSpec') {
                  g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, i, 1);
                } else {
                  var iterableRecord = getRecord(i);
                  g.value = reduceAdd(g.value, iterableRecord, true, j);
                }
              }
            }
            if (!applyFilteredRemovals) {
              return;
            }
            for (i = 0; i < n; ++i) {
              if (!filters.zeroExcept(i, offset, zero)) {
                for (j = 0; j < groupIndex[i].length; j++) {
                  g = groups[groupIndex[i][j]];
                  if (reduceMode === 'count') {
                    g.value -= 1;
                  } else if (reduceMode === 'metricSpec') {
                    g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, i, -1);
                  } else {
                    var filteredIterableRecord = getRecord(i);
                    g.value = reduceRemove(g.value, filteredIterableRecord, false, j);
                  }
                }
              }
            }
            return;
          }

          for (i = 0; i < n; ++i) {
            g = groups[groupIndex[i]];
            if (reduceMode === 'count') {
              g.value += 1;
            } else if (reduceMode === 'metricSpec') {
              g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, i, 1);
            } else {
              g.value = reduceAdd(g.value, getRecord(i), true);
            }
          }
          if (!applyFilteredRemovals) {
            return;
          }
          for (i = 0; i < n; ++i) {
            if (!filters.zeroExcept(i, offset, zero)) {
              g = groups[groupIndex[i]];
              if (reduceMode === 'count') {
                g.value -= 1;
              } else if (reduceMode === 'metricSpec') {
                g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, i, -1);
              } else {
                g.value = reduceRemove(g.value, getRecord(i), false);
              }
            }
          }
        }

        // Recomputes the group reduce values from scratch.
        // This function is only used when the cardinality is 1.
        function resetOne() {
          var i,
              applyFilteredRemovals = hasOtherActiveDimensionFilters(),
              g = groups[0];

          // Reset the singleton group values.
          g.value = reduceInitial();

          // We add all records and then remove filtered records so that reducers
          // can build an 'unfiltered' view even if there are already filters in
          // place on other dimensions.
          for (i = 0; i < n; ++i) {
            if (reduceMode === 'count') {
              g.value += 1;
            } else if (reduceMode === 'metricSpec') {
              g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, i, 1);
            } else {
              g.value = reduceAdd(g.value, getRecord(i), true);
            }
          }

          if (!applyFilteredRemovals) {
            return;
          }
          for (i = 0; i < n; ++i) {
            if (!filters.zeroExcept(i, offset, zero)) {
              if (reduceMode === 'count') {
                g.value -= 1;
              } else if (reduceMode === 'metricSpec') {
                g.value = applyReduceMetricSpec(g.value, reduceMetricSpec, i, -1);
              } else {
                g.value = reduceRemove(g.value, getRecord(i), false);
              }
            }
          }
        }

        // Returns the array of group values, in the dimension's natural order.
        function all() {
          if (resetNeeded) reset(), resetNeeded = false;
          return groups;
        }

        // Returns a new array containing the top K group values, in reduce order.
        function top(k) {
          var top = select(all(), 0, groups.length, k);
          return heap.sort(top, 0, top.length);
        }

        // Sets the reduce behavior for this group to use the specified functions.
        // This method lazily recomputes the reduce values, waiting until needed.
        function reduce(add, remove, initial) {
          reduceAdd = add;
          reduceRemove = remove;
          reduceInitial = initial;
          reduceMetricSpec = resolveReduceMetricSpec(add, remove, initial);
          reduceMode = null;
          if (reduceMetricSpec) {
            reduceMode = 'metricSpec';
          }
          resetNeeded = true;
          return group;
        }

        // A convenience method for reducing by count.
        function reduceCount() {
          reduce(xfilterReduce.reduceIncrement, xfilterReduce.reduceDecrement, cr_zero);
          reduceMode = 'count';
          return group;
        }

        // A convenience method for reducing by sum(value).
        function reduceSum(value) {
          return reduce(xfilterReduce.reduceAdd(value), xfilterReduce.reduceSubtract(value), cr_zero);
        }

        // Sets the reduce order, using the specified accessor.
        function order(value) {
          select = h.by(valueOf);
          heap = h$1.by(valueOf);
          function valueOf(d) { return value(d.value); }
          return group;
        }

        // A convenience method for natural ordering by reduce value.
        function orderNatural() {
          return order(cr_identity);
        }

        // Returns the cardinality of this group, irrespective of any filters.
        function size() {
          return k;
        }

        // Removes this group and associated event listeners.
        function dispose() {
          var i = filterListeners.indexOf(update);
          if (i >= 0) filterListeners.splice(i, 1);
          i = indexListeners.indexOf(add);
          if (i >= 0) indexListeners.splice(i, 1);
          i = removeDataListeners.indexOf(removeData);
          if (i >= 0) removeDataListeners.splice(i, 1);
          i = dimensionGroups.indexOf(group);
          if (i >= 0) dimensionGroups.splice(i, 1);
          unregisterResetListener(markResetNeeded);
          return group;
        }

        return reduceCount().orderNatural();
      }

      // A convenience function for generating a singleton group.
      function groupAll() {
        var g = group(cr_null), all = g.all;
        delete g.all;
        delete g.top;
        delete g.order;
        delete g.orderNatural;
        delete g.size;
        g.value = function() { return all()[0].value; };
        return g;
      }

      // Removes this dimension and associated groups and event listeners.
      function dispose() {
        dimensionGroups.forEach(function(group) { group.dispose(); });
        var i = dataListeners.indexOf(preAdd);
        if (i >= 0) dataListeners.splice(i, 1);
        i = dataListeners.indexOf(postAdd);
        if (i >= 0) dataListeners.splice(i, 1);
        i = removeDataListeners.indexOf(removeData);
        if (i >= 0) removeDataListeners.splice(i, 1);
        filters.masks[offset] &= zero;
        return filterAll();
      }

      return dimension;
    }

    // A convenience method for groupAll on a dummy dimension.
    // This implementation can be optimized since it always has cardinality 1.
    function groupAll() {
      var group = {
        reduce: reduce,
        reduceCount: reduceCount,
        reduceSum: reduceSum,
        value: value,
        dispose: dispose,
        remove: dispose // for backwards-compatibility
      };

      var reduceValue,
          reduceAdd,
          reduceRemove,
          reduceInitial,
          reduceMetricSpec = null,
          reduceMode = null,
          resetNeeded = true,
          markResetNeeded = registerResetListener(function() {
            resetNeeded = true;
          });

      // The group listens to the crossfilter for when any dimension changes, so
      // that it can update the reduce value. It must also listen to the parent
      // dimension for when data is added.
      filterListeners.push(update);
      dataListeners.push(add);

      // For consistency; actually a no-op since resetNeeded is true.
      add(data, 0);

      // Incorporates the specified new values into this group.
      function add(newData, n0) {
        var i,
            applyFilteredRemovals = hasAnyActiveDimensionFilters();

        if (resetNeeded) return;

        // Cycle through all the values.
        for (i = n0; i < n; ++i) {
          if (reduceMode === 'count') {
            reduceValue += 1;
            if (applyFilteredRemovals && !filters.zero(i)) {
              reduceValue -= 1;
            }
          } else if (reduceMode === 'metricSpec') {
            reduceValue = applyReduceMetricSpec(reduceValue, reduceMetricSpec, i, 1);
            if (applyFilteredRemovals && !filters.zero(i)) {
              reduceValue = applyReduceMetricSpec(reduceValue, reduceMetricSpec, i, -1);
            }
          } else {
            var rowRecord = getRecord(i);

            // Add all values all the time.
            reduceValue = reduceAdd(reduceValue, rowRecord, true);

            // Remove the value if filtered.
            if (applyFilteredRemovals && !filters.zero(i)) {
              reduceValue = reduceRemove(reduceValue, rowRecord, false);
            }
          }
        }
      }

      // Reduces the specified selected or deselected records.
      function update(filterOne, filterOffset, added, removed, notFilter) {
        var i,
            k,
            n;

        if (resetNeeded) return;

        // Add the added values.
        for (i = 0, n = added.length; i < n; ++i) {
          if (filters.zero(k = added[i])) {
            if (reduceMode === 'count') {
              reduceValue += 1;
            } else if (reduceMode === 'metricSpec') {
              reduceValue = applyReduceMetricSpec(reduceValue, reduceMetricSpec, k, 1);
            } else {
              reduceValue = reduceAdd(reduceValue, getRecord(k), notFilter);
            }
          }
        }

        // Remove the removed values.
        for (i = 0, n = removed.length; i < n; ++i) {
          if (filters.only(k = removed[i], filterOffset, filterOne)) {
            if (reduceMode === 'count') {
              reduceValue -= 1;
            } else if (reduceMode === 'metricSpec') {
              reduceValue = applyReduceMetricSpec(reduceValue, reduceMetricSpec, k, -1);
            } else {
              reduceValue = reduceRemove(reduceValue, getRecord(k), notFilter);
            }
          }
        }
      }

      // Recomputes the group reduce value from scratch.
      function reset() {
        var i,
            applyFilteredRemovals = hasAnyActiveDimensionFilters();

        reduceValue = reduceInitial();

        // Cycle through all the values.
        for (i = 0; i < n; ++i) {
          if (reduceMode === 'count') {
            reduceValue += 1;
            if (applyFilteredRemovals && !filters.zero(i)) {
              reduceValue -= 1;
            }
          } else if (reduceMode === 'metricSpec') {
            reduceValue = applyReduceMetricSpec(reduceValue, reduceMetricSpec, i, 1);
            if (applyFilteredRemovals && !filters.zero(i)) {
              reduceValue = applyReduceMetricSpec(reduceValue, reduceMetricSpec, i, -1);
            }
          } else {
            var rowRecord = getRecord(i);

            // Add all values all the time.
            reduceValue = reduceAdd(reduceValue, rowRecord, true);

            // Remove the value if it is filtered.
            if (applyFilteredRemovals && !filters.zero(i)) {
              reduceValue = reduceRemove(reduceValue, rowRecord, false);
            }
          }
        }
      }

      // Sets the reduce behavior for this group to use the specified functions.
      // This method lazily recomputes the reduce value, waiting until needed.
      function reduce(add, remove, initial) {
        reduceAdd = add;
        reduceRemove = remove;
        reduceInitial = initial;
        reduceMetricSpec = resolveReduceMetricSpec(add, remove, initial);
        reduceMode = null;
        if (reduceMetricSpec) {
          reduceMode = 'metricSpec';
        }
        resetNeeded = true;
        return group;
      }

      // A convenience method for reducing by count.
      function reduceCount() {
        reduce(xfilterReduce.reduceIncrement, xfilterReduce.reduceDecrement, cr_zero);
        reduceMode = 'count';
        return group;
      }

      // A convenience method for reducing by sum(value).
      function reduceSum(value) {
        return reduce(xfilterReduce.reduceAdd(value), xfilterReduce.reduceSubtract(value), cr_zero);
      }

      // Returns the computed reduce value.
      function value() {
        if (resetNeeded) reset(), resetNeeded = false;
        return reduceValue;
      }

      // Removes this group and associated event listeners.
      function dispose() {
        var i = filterListeners.indexOf(update);
        if (i >= 0) filterListeners.splice(i, 1);
        i = dataListeners.indexOf(add);
        if (i >= 0) dataListeners.splice(i, 1);
        unregisterResetListener(markResetNeeded);
        return group;
      }

      return reduceCount();
    }

    // Returns the number of records in this crossfilter, irrespective of any filters.
    function size() {
      return n;
    }

    // Returns the raw row data contained in this crossfilter
    function all(){
      materializeAllRecords();
      return data;
    }

    // Returns row data with all dimension filters applied, except for filters in ignore_dimensions
    function allFiltered(ignore_dimensions) {
      var array = [],
          i = 0,
          mask = maskForDimensions(ignore_dimensions || []);

        for (i = 0; i < n; i++) {
          if (filters.zeroExceptMask(i, mask)) {
            array.push(getRecord(i));
          }
        }

        return array;
    }

    function allFilteredIndexes(ignore_dimensions) {
      var array = [],
          i = 0,
          mask = maskForDimensions(ignore_dimensions || []);

      for (i = 0; i < n; i++) {
        if (filters.zeroExceptMask(i, mask)) {
          array.push(i);
        }
      }

      return array;
    }

    function takeColumns(rowIndexes, fields) {
      var selectedFields = fields && fields.length ? fields.slice() : null;
      var columns = {};
      var rowCount = rowIndexes ? rowIndexes.length : 0;
      var fieldIndex;
      var rowIndex;

      if (!selectedFields) {
        return {
          columns: columns,
          fields: [],
          length: rowCount
        };
      }

      for (fieldIndex = 0; fieldIndex < selectedFields.length; ++fieldIndex) {
        columns[selectedFields[fieldIndex]] = new Array(rowCount);
      }

      for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        for (fieldIndex = 0; fieldIndex < selectedFields.length; ++fieldIndex) {
          var field = selectedFields[fieldIndex];
          columns[field][rowIndex] = getFieldValue(rowIndexes[rowIndex], field);
        }
      }

      return {
        columns: columns,
        fields: selectedFields,
        length: rowCount
      };
    }

    function onChange(cb){
      if(typeof cb !== 'function'){
        /* eslint no-console: 0 */
        console.warn('onChange callback parameter must be a function!');
        return;
      }
      callbacks.push(cb);
      return function(){
        callbacks.splice(callbacks.indexOf(cb), 1);
      };
    }

    function triggerOnChange(eventName){
      for (var i = 0; i < callbacks.length; i++) {
        callbacks[i](eventName);
      }
    }

    return arguments.length
        ? add(arguments[0])
        : crossfilter;
  }

  // Returns an array of size n, big enough to store ids up to m.
  function cr_index(n, m) {
    return (m < 0x101
        ? xfilterArray.array8 : m < 0x10001
        ? xfilterArray.array16
        : xfilterArray.array32)(n);
  }

  // Constructs a new array of size n, with sequential values from 0 to n - 1.
  function cr_range(n) {
    var range = cr_index(n, n);
    for (var i = -1; ++i < n;) range[i] = i;
    return range;
  }

  function capacity(w) {
    return w === 8
        ? 0x100 : w === 16
        ? 0x10000
        : 0x100000000;
  }

  var version = "2.0.1";

  // Note(cg): exporting current version for umd build.
  crossfilter.version = version;

  return crossfilter;

}));
