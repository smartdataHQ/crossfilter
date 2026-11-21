// https://github.com/smartdataHQ/crossfilter v3.2.0 Copyright 2026 Mike Bostock
'use strict';

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
  var cap = n < 64 ? 64 : n;
  this.length = n;
  this.capacity = cap;
  this.subarrays = 1;
  this.width = 8;
  this.masks = {
    0: 0
  };

  this[0] = array8(cap);
}

bitarray.prototype.lengthen = function(n) {
  if (n > this.capacity) {
    var nextCap = this.capacity || 64;
    while (nextCap < n) nextCap <<= 1;
    var i, len;
    for (i = 0, len = this.subarrays; i < len; ++i) {
      this[i] = arrayLengthen(this[i], nextCap);
    }
    this.capacity = nextCap;
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
  this[this.subarrays] = array8(this.capacity);
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
    if (typeof this[i].fill === "function") {
      this[i].fill(0, n, this.length);
    } else {
      for (var j = this.length - 1; j >= n; j--) {
        this[i][j] = 0;
      }
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

// Compact 1-bit-per-row per-dimension filter bitset store.
// Convention: bit 1 = row INCLUDED by this dimension, bit 0 = row EXCLUDED.
// Trailing bits beyond `length` are always 0.
// Unfiltered dimensions are not present in `active` (0 memory traffic, O(1) clear).

function popcount32(x) {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

function tailMaskFor(n) {
  var rem = n & 31;
  return rem === 0 ? 0xffffffff : (0xffffffff >>> (32 - rem));
}

function ensureWordCapacity(arr, neededWords) {
  if (arr && arr.length >= neededWords) {
    return arr;
  }
  var cap = arr && arr.length ? arr.length : 2;
  while (cap < neededWords) cap <<= 1;
  var next = new Uint32Array(cap);
  if (arr) next.set(arr);
  return next;
}

function fillBitsOnes(bits, n) {
  var fullWords = n >>> 5;
  if (fullWords > 0) {
    bits.fill(0xffffffff, 0, fullWords);
  }
  var rem = n & 31;
  if (rem > 0) {
    bits[fullWords] = 0xffffffff >>> (32 - rem);
  }
}

function setBitsOnesRange(bits, startRow, endRow) {
  if (startRow >= endRow) return;
  var startWord = startRow >>> 5;
  var startBit = startRow & 31;
  var lastRow = endRow - 1;
  var endWord = lastRow >>> 5;
  var endBit = lastRow & 31;
  var keepLowMask = startBit === 0 ? 0 : (0xffffffff >>> (32 - startBit));

  if (startWord === endWord) {
    var span = endBit - startBit + 1;
    var mask = span === 32 ? 0xffffffff : (((0xffffffff >>> (32 - span)) << startBit) >>> 0);
    bits[startWord] = ((bits[startWord] & keepLowMask) | mask) >>> 0;
    return;
  }

  if (startBit > 0) {
    bits[startWord] = ((bits[startWord] & keepLowMask) | ((0xffffffff << startBit) >>> 0)) >>> 0;
    startWord += 1;
  }
  if (startWord < endWord) {
    bits.fill(0xffffffff, startWord, endWord);
  }
  var endMask = endBit === 31 ? 0xffffffff : (0xffffffff >>> (31 - endBit));
  bits[endWord] = endMask >>> 0;
}

function extractClz1(b0, wordCount, out) {
  var count = 0, j, w, base, lsb;
  for (j = 0; j < wordCount; ++j) {
    w = b0[j];
    if (w === 0) continue;
    base = j << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  return count;
}

function extractClz2(b0, b1, wordCount, out) {
  var count = 0, j, w, base, lsb;
  for (j = 0; j < wordCount; ++j) {
    w = b0[j] & b1[j];
    if (w === 0) continue;
    base = j << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  return count;
}

function extractClz3(b0, b1, b2, wordCount, out) {
  var count = 0, j, w, base, lsb;
  for (j = 0; j < wordCount; ++j) {
    w = b0[j] & b1[j] & b2[j];
    if (w === 0) continue;
    base = j << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  return count;
}

function extractClzN(bitsets, bitsetCount, wordCount, out) {
  var count = 0, j, k, w, base, lsb;
  var b0 = bitsets[0];
  for (j = 0; j < wordCount; ++j) {
    w = b0[j];
    for (k = 1; w !== 0 && k < bitsetCount; ++k) {
      w &= bitsets[k][j];
    }
    if (w === 0) continue;
    base = j << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  return count;
}

function extractExclClz1(b0, wordCount, tailMask, out) {
  var count = 0, last = wordCount - 1, j, w, base, lsb;
  if (last < 0) return 0;
  for (j = 0; j < last; ++j) {
    w = (~b0[j]) | 0;
    if (w === 0) continue;
    base = j << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  w = (~b0[last]) & tailMask;
  if (w !== 0) {
    base = last << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  return count;
}

function extractExclClz2(b0, b1, wordCount, tailMask, out) {
  var count = 0, last = wordCount - 1, j, w, base, lsb;
  if (last < 0) return 0;
  for (j = 0; j < last; ++j) {
    w = (~(b0[j] & b1[j])) | 0;
    if (w === 0) continue;
    base = j << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  w = (~(b0[last] & b1[last])) & tailMask;
  if (w !== 0) {
    base = last << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  return count;
}

function extractExclClz3(b0, b1, b2, wordCount, tailMask, out) {
  var count = 0, last = wordCount - 1, j, w, base, lsb;
  if (last < 0) return 0;
  for (j = 0; j < last; ++j) {
    w = (~(b0[j] & b1[j] & b2[j])) | 0;
    if (w === 0) continue;
    base = j << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  w = (~(b0[last] & b1[last] & b2[last])) & tailMask;
  if (w !== 0) {
    base = last << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  return count;
}

function extractExclClzN(bitsets, bitsetCount, wordCount, tailMask, out) {
  var count = 0, last = wordCount - 1, j, k, w, base, lsb;
  if (last < 0) return 0;
  var b0 = bitsets[0];
  for (j = 0; j < wordCount; ++j) {
    w = b0[j];
    for (k = 1; w !== 0 && k < bitsetCount; ++k) {
      w &= bitsets[k][j];
    }
    w = j === last ? ((~w) & tailMask) : ((~w) | 0);
    if (w === 0) continue;
    base = j << 5;
    while (w !== 0) {
      lsb = w & -w;
      out[count++] = base + (31 - Math.clz32(lsb));
      w ^= lsb;
    }
  }
  return count;
}

function countPop1(b0, wordCount) {
  var total = 0, j, w;
  for (j = 0; j < wordCount; ++j) {
    w = b0[j];
    if (w !== 0) total += popcount32(w);
  }
  return total;
}

function countPop2(b0, b1, wordCount) {
  var total = 0, j, w;
  for (j = 0; j < wordCount; ++j) {
    w = b0[j] & b1[j];
    if (w !== 0) total += popcount32(w);
  }
  return total;
}

function countPop3(b0, b1, b2, wordCount) {
  var total = 0, j, w;
  for (j = 0; j < wordCount; ++j) {
    w = b0[j] & b1[j] & b2[j];
    if (w !== 0) total += popcount32(w);
  }
  return total;
}

function countPopN(bitsets, bitsetCount, wordCount) {
  var total = 0, j, k, w;
  var b0 = bitsets[0];
  for (j = 0; j < wordCount; ++j) {
    w = b0[j];
    for (k = 1; w !== 0 && k < bitsetCount; ++k) {
      w &= bitsets[k][j];
    }
    if (w !== 0) total += popcount32(w);
  }
  return total;
}

// Fast 32-unrolled word builders (bit 1 = matches filter / included)

function packExactWord(codes, base, target) {
  var word = 0;
  if (codes[base] === target) word |= 1;
  if (codes[base + 1] === target) word |= 2;
  if (codes[base + 2] === target) word |= 4;
  if (codes[base + 3] === target) word |= 8;
  if (codes[base + 4] === target) word |= 16;
  if (codes[base + 5] === target) word |= 32;
  if (codes[base + 6] === target) word |= 64;
  if (codes[base + 7] === target) word |= 128;
  if (codes[base + 8] === target) word |= 256;
  if (codes[base + 9] === target) word |= 512;
  if (codes[base + 10] === target) word |= 1024;
  if (codes[base + 11] === target) word |= 2048;
  if (codes[base + 12] === target) word |= 4096;
  if (codes[base + 13] === target) word |= 8192;
  if (codes[base + 14] === target) word |= 16384;
  if (codes[base + 15] === target) word |= 32768;
  if (codes[base + 16] === target) word |= 65536;
  if (codes[base + 17] === target) word |= 131072;
  if (codes[base + 18] === target) word |= 262144;
  if (codes[base + 19] === target) word |= 524288;
  if (codes[base + 20] === target) word |= 1048576;
  if (codes[base + 21] === target) word |= 2097152;
  if (codes[base + 22] === target) word |= 4194304;
  if (codes[base + 23] === target) word |= 8388608;
  if (codes[base + 24] === target) word |= 16777216;
  if (codes[base + 25] === target) word |= 33554432;
  if (codes[base + 26] === target) word |= 67108864;
  if (codes[base + 27] === target) word |= 134217728;
  if (codes[base + 28] === target) word |= 268435456;
  if (codes[base + 29] === target) word |= 536870912;
  if (codes[base + 30] === target) word |= 1073741824;
  if (codes[base + 31] === target) word |= -2147483648;
  return word >>> 0;
}

function packMarkedWord(codes, base, marks, markVersion) {
  var word = 0;
  if (marks[codes[base]] === markVersion) word |= 1;
  if (marks[codes[base + 1]] === markVersion) word |= 2;
  if (marks[codes[base + 2]] === markVersion) word |= 4;
  if (marks[codes[base + 3]] === markVersion) word |= 8;
  if (marks[codes[base + 4]] === markVersion) word |= 16;
  if (marks[codes[base + 5]] === markVersion) word |= 32;
  if (marks[codes[base + 6]] === markVersion) word |= 64;
  if (marks[codes[base + 7]] === markVersion) word |= 128;
  if (marks[codes[base + 8]] === markVersion) word |= 256;
  if (marks[codes[base + 9]] === markVersion) word |= 512;
  if (marks[codes[base + 10]] === markVersion) word |= 1024;
  if (marks[codes[base + 11]] === markVersion) word |= 2048;
  if (marks[codes[base + 12]] === markVersion) word |= 4096;
  if (marks[codes[base + 13]] === markVersion) word |= 8192;
  if (marks[codes[base + 14]] === markVersion) word |= 16384;
  if (marks[codes[base + 15]] === markVersion) word |= 32768;
  if (marks[codes[base + 16]] === markVersion) word |= 65536;
  if (marks[codes[base + 17]] === markVersion) word |= 131072;
  if (marks[codes[base + 18]] === markVersion) word |= 262144;
  if (marks[codes[base + 19]] === markVersion) word |= 524288;
  if (marks[codes[base + 20]] === markVersion) word |= 1048576;
  if (marks[codes[base + 21]] === markVersion) word |= 2097152;
  if (marks[codes[base + 22]] === markVersion) word |= 4194304;
  if (marks[codes[base + 23]] === markVersion) word |= 8388608;
  if (marks[codes[base + 24]] === markVersion) word |= 16777216;
  if (marks[codes[base + 25]] === markVersion) word |= 33554432;
  if (marks[codes[base + 26]] === markVersion) word |= 67108864;
  if (marks[codes[base + 27]] === markVersion) word |= 134217728;
  if (marks[codes[base + 28]] === markVersion) word |= 268435456;
  if (marks[codes[base + 29]] === markVersion) word |= 536870912;
  if (marks[codes[base + 30]] === markVersion) word |= 1073741824;
  if (marks[codes[base + 31]] === markVersion) word |= -2147483648;
  return word >>> 0;
}

function packRangeWord(vals, base, lo, hi) {
  var word = 0, v;
  v = vals[base]; if (v >= lo && v < hi) word |= 1;
  v = vals[base + 1]; if (v >= lo && v < hi) word |= 2;
  v = vals[base + 2]; if (v >= lo && v < hi) word |= 4;
  v = vals[base + 3]; if (v >= lo && v < hi) word |= 8;
  v = vals[base + 4]; if (v >= lo && v < hi) word |= 16;
  v = vals[base + 5]; if (v >= lo && v < hi) word |= 32;
  v = vals[base + 6]; if (v >= lo && v < hi) word |= 64;
  v = vals[base + 7]; if (v >= lo && v < hi) word |= 128;
  v = vals[base + 8]; if (v >= lo && v < hi) word |= 256;
  v = vals[base + 9]; if (v >= lo && v < hi) word |= 512;
  v = vals[base + 10]; if (v >= lo && v < hi) word |= 1024;
  v = vals[base + 11]; if (v >= lo && v < hi) word |= 2048;
  v = vals[base + 12]; if (v >= lo && v < hi) word |= 4096;
  v = vals[base + 13]; if (v >= lo && v < hi) word |= 8192;
  v = vals[base + 14]; if (v >= lo && v < hi) word |= 16384;
  v = vals[base + 15]; if (v >= lo && v < hi) word |= 32768;
  v = vals[base + 16]; if (v >= lo && v < hi) word |= 65536;
  v = vals[base + 17]; if (v >= lo && v < hi) word |= 131072;
  v = vals[base + 18]; if (v >= lo && v < hi) word |= 262144;
  v = vals[base + 19]; if (v >= lo && v < hi) word |= 524288;
  v = vals[base + 20]; if (v >= lo && v < hi) word |= 1048576;
  v = vals[base + 21]; if (v >= lo && v < hi) word |= 2097152;
  v = vals[base + 22]; if (v >= lo && v < hi) word |= 4194304;
  v = vals[base + 23]; if (v >= lo && v < hi) word |= 8388608;
  v = vals[base + 24]; if (v >= lo && v < hi) word |= 16777216;
  v = vals[base + 25]; if (v >= lo && v < hi) word |= 33554432;
  v = vals[base + 26]; if (v >= lo && v < hi) word |= 67108864;
  v = vals[base + 27]; if (v >= lo && v < hi) word |= 134217728;
  v = vals[base + 28]; if (v >= lo && v < hi) word |= 268435456;
  v = vals[base + 29]; if (v >= lo && v < hi) word |= 536870912;
  v = vals[base + 30]; if (v >= lo && v < hi) word |= 1073741824;
  v = vals[base + 31]; if (v >= lo && v < hi) word |= -2147483648;
  return word >>> 0;
}

function packSetWord(vals, base, valSet) {
  var word = 0, b;
  for (b = 0; b < 32; ++b) {
    if (valSet.has(vals[base + b])) word |= (1 << b);
  }
  return word >>> 0;
}

function createFilterBitsetStore() {
  var length = 0;
  var wordCount = 0;
  var active = [];
  var nextId = 0;
  var freeIds = [];
  var dirtyCount = 0;
  var scratchBitsets = [];

  function allocSlot() {
    var id = freeIds.length ? freeIds.pop() : nextId++;
    return {
      active: false,
      bitset: null,
      bitsetDirty: false,
      id: id,
      materialize: null
    };
  }

  function freeSlot(slot) {
    deactivate(slot);
    slot.bitset = null;
    slot.materialize = null;
    freeIds.push(slot.id);
  }

  function markDirty(slot) {
    if (!slot.active) {
      slot.active = true;
      active.push(slot);
    }
    if (!slot.bitsetDirty) {
      slot.bitsetDirty = true;
      dirtyCount += 1;
    }
  }

  function clearDirty(slot) {
    if (slot.bitsetDirty) {
      slot.bitsetDirty = false;
      dirtyCount -= 1;
    }
  }

  function ensureMaterialized(ignoreSlot) {
    if (dirtyCount === 0) return;
    for (var i = active.length - 1; i >= 0; --i) {
      var s = active[i];
      if (s.bitsetDirty && s !== ignoreSlot) {
        s.bitsetDirty = false;
        dirtyCount -= 1;
        if (s.materialize) {
          s.materialize();
        }
      }
    }
  }

  function ensureSlotMaterialized(slot) {
    if (slot.bitsetDirty) {
      slot.bitsetDirty = false;
      dirtyCount -= 1;
      if (slot.materialize) {
        slot.materialize();
      }
    }
  }

  function activateForOverwrite(slot) {
    clearDirty(slot);
    if (wordCount > 0) {
      slot.bitset = ensureWordCapacity(slot.bitset, wordCount);
    } else if (!slot.bitset) {
      slot.bitset = new Uint32Array(2);
    }
    if (!slot.active) {
      slot.active = true;
      active.push(slot);
    }
    return slot.bitset;
  }

  function activateAllOnes(slot) {
    clearDirty(slot);
    if (wordCount > 0) {
      slot.bitset = ensureWordCapacity(slot.bitset, wordCount);
      fillBitsOnes(slot.bitset, length);
    } else if (!slot.bitset) {
      slot.bitset = new Uint32Array(2);
    }
    if (!slot.active) {
      slot.active = true;
      active.push(slot);
    }
    return slot.bitset;
  }

  function deactivate(slot) {
    clearDirty(slot);
    if (!slot.active) return;
    slot.active = false;
    var idx = active.indexOf(slot);
    if (idx >= 0) {
      active.splice(idx, 1);
    }
  }

  function lengthen(newN) {
    ensureMaterialized(null);
    var oldN = length;
    var newWordCount = (newN + 31) >>> 5;
    var i, slot;
    for (i = 0; i < active.length; ++i) {
      slot = active[i];
      slot.bitset = ensureWordCapacity(slot.bitset, newWordCount);
      if (newN > oldN) {
        setBitsOnesRange(slot.bitset, oldN, newN);
      }
    }
    length = newN;
    wordCount = newWordCount;
  }

  function compact(reIndex, newN, removedSentinel) {
    ensureMaterialized(null);
    var oldN = length;
    var oldWordCount = wordCount;
    var newWordCount = (newN + 31) >>> 5;
    var aIdx, slot, bits, fi, outW, outBit, outWord;

    for (aIdx = 0; aIdx < active.length; ++aIdx) {
      slot = active[aIdx];
      bits = slot.bitset;
      if (!bits) continue;
      outW = 0;
      outBit = 0;
      outWord = 0;
      for (fi = 0; fi < oldN; ++fi) {
        if (reIndex[fi] === removedSentinel) continue;
        if (bits[fi >>> 5] & (1 << (fi & 31))) {
          outWord |= (1 << outBit);
        }
        if (++outBit === 32) {
          bits[outW++] = outWord >>> 0;
          outBit = 0;
          outWord = 0;
        }
      }
      if (outBit > 0) {
        bits[outW++] = outWord >>> 0;
      }
      if (outW < oldWordCount) {
        bits.fill(0, outW, oldWordCount);
      }
    }
    length = newN;
    wordCount = newWordCount;
  }

  function collectOtherBitsets(ignoreSlot) {
    var count = 0, i, s;
    for (i = 0; i < active.length; ++i) {
      s = active[i];
      if (s === ignoreSlot) continue;
      scratchBitsets[count++] = s.bitset;
    }
    return count;
  }

  // Returns -1 if no active filters apply (all rows active), otherwise number of active rows written to out.
  function extractActive(out, ignoreSlot) {
    ensureMaterialized(ignoreSlot);
    var activeLen = active.length;
    if (activeLen === 0) return -1;
    if (ignoreSlot == null) {
      if (wordCount === 0) return 0;
      if (activeLen === 1) return extractClz1(active[0].bitset, wordCount, out);
      if (activeLen === 2) return extractClz2(active[0].bitset, active[1].bitset, wordCount, out);
      if (activeLen === 3) return extractClz3(active[0].bitset, active[1].bitset, active[2].bitset, wordCount, out);
      var k = collectOtherBitsets(null);
      return extractClzN(scratchBitsets, k, wordCount, out);
    }
    var otherCount = collectOtherBitsets(ignoreSlot);
    if (otherCount === 0) return -1;
    if (wordCount === 0) return 0;
    if (otherCount === 1) return extractClz1(scratchBitsets[0], wordCount, out);
    if (otherCount === 2) return extractClz2(scratchBitsets[0], scratchBitsets[1], wordCount, out);
    if (otherCount === 3) return extractClz3(scratchBitsets[0], scratchBitsets[1], scratchBitsets[2], wordCount, out);
    return extractClzN(scratchBitsets, otherCount, wordCount, out);
  }

  // Writes excluded row indices to `out` and returns excluded count (0 if no active filters).
  function extractExcluded(out, ignoreSlot) {
    ensureMaterialized(ignoreSlot);
    var activeLen = active.length;
    if (activeLen === 0 || wordCount === 0) return 0;
    var tMask = tailMaskFor(length);
    if (ignoreSlot == null) {
      if (activeLen === 1) return extractExclClz1(active[0].bitset, wordCount, tMask, out);
      if (activeLen === 2) return extractExclClz2(active[0].bitset, active[1].bitset, wordCount, tMask, out);
      if (activeLen === 3) return extractExclClz3(active[0].bitset, active[1].bitset, active[2].bitset, wordCount, tMask, out);
      var k = collectOtherBitsets(null);
      return extractExclClzN(scratchBitsets, k, wordCount, tMask, out);
    }
    var otherCount = collectOtherBitsets(ignoreSlot);
    if (otherCount === 0) return 0;
    if (otherCount === 1) return extractExclClz1(scratchBitsets[0], wordCount, tMask, out);
    if (otherCount === 2) return extractExclClz2(scratchBitsets[0], scratchBitsets[1], wordCount, tMask, out);
    if (otherCount === 3) return extractExclClz3(scratchBitsets[0], scratchBitsets[1], scratchBitsets[2], wordCount, tMask, out);
    return extractExclClzN(scratchBitsets, otherCount, wordCount, tMask, out);
  }

  function countActive(ignoreSlot) {
    ensureMaterialized(ignoreSlot);
    var activeLen = active.length;
    if (activeLen === 0) return length;
    if (wordCount === 0) return 0;
    if (ignoreSlot == null) {
      if (activeLen === 1) return countPop1(active[0].bitset, wordCount);
      if (activeLen === 2) return countPop2(active[0].bitset, active[1].bitset, wordCount);
      if (activeLen === 3) return countPop3(active[0].bitset, active[1].bitset, active[2].bitset, wordCount);
      var k = collectOtherBitsets(null);
      return countPopN(scratchBitsets, k, wordCount);
    }
    var otherCount = collectOtherBitsets(ignoreSlot);
    if (otherCount === 0) return length;
    if (otherCount === 1) return countPop1(scratchBitsets[0], wordCount);
    if (otherCount === 2) return countPop2(scratchBitsets[0], scratchBitsets[1], wordCount);
    if (otherCount === 3) return countPop3(scratchBitsets[0], scratchBitsets[1], scratchBitsets[2], wordCount);
    return countPopN(scratchBitsets, otherCount, wordCount);
  }

  function isActive(row) {
    if (dirtyCount > 0) ensureMaterialized(null);
    var activeLen = active.length;
    if (activeLen === 0) return true;
    var w = row >>> 5;
    var bit = 1 << (row & 31);
    if (activeLen === 1) return (active[0].bitset[w] & bit) !== 0;
    if (activeLen === 2) return ((active[0].bitset[w] & active[1].bitset[w]) & bit) !== 0;
    for (var i = 0; i < activeLen; ++i) {
      if (!(active[i].bitset[w] & bit)) return false;
    }
    return true;
  }

  function isActiveExcept(row, selfSlot) {
    if (dirtyCount > 0) ensureMaterialized(selfSlot);
    var activeLen = active.length;
    if (activeLen === 0) return true;
    var w = row >>> 5;
    var bit = 1 << (row & 31);
    if (activeLen === 1) {
      return active[0] === selfSlot ? true : (active[0].bitset[w] & bit) !== 0;
    }
    for (var i = 0; i < activeLen; ++i) {
      var s = active[i];
      if (s === selfSlot) continue;
      if (!(s.bitset[w] & bit)) return false;
    }
    return true;
  }

  function isOnlyExcludedBy(row, excludedSlot) {
    if (excludedSlot == null) return isActive(row);
    if (dirtyCount > 0) ensureMaterialized(null);
    if (!excludedSlot.active) return false;
    var w = row >>> 5;
    var bit = 1 << (row & 31);
    if (excludedSlot.bitset[w] & bit) return false;
    var activeLen = active.length;
    if (activeLen === 1) return true;
    for (var i = 0; i < activeLen; ++i) {
      var s = active[i];
      if (s === excludedSlot) continue;
      if (!(s.bitset[w] & bit)) return false;
    }
    return true;
  }

  function isOnlyExcludedByExcept(row, selfSlot, excludedSlot) {
    if (excludedSlot == null) return isActiveExcept(row, selfSlot);
    if (dirtyCount > 0) ensureMaterialized(selfSlot);
    if (!excludedSlot.active) return false;
    var w = row >>> 5;
    var bit = 1 << (row & 31);
    if (excludedSlot.bitset[w] & bit) return false;
    var activeLen = active.length;
    for (var i = 0; i < activeLen; ++i) {
      var s = active[i];
      if (s === selfSlot || s === excludedSlot) continue;
      if (!(s.bitset[w] & bit)) return false;
    }
    return true;
  }

  function isActiveIgnoring(row, ignoreIdMap) {
    if (dirtyCount > 0) ensureMaterialized(null);
    var activeLen = active.length;
    if (activeLen === 0) return true;
    var w = row >>> 5;
    var bit = 1 << (row & 31);
    for (var i = 0; i < activeLen; ++i) {
      var s = active[i];
      if (ignoreIdMap && ignoreIdMap[s.id]) continue;
      if (!(s.bitset[w] & bit)) return false;
    }
    return true;
  }

  function isSlotExcluded(slot, row) {
    if (!slot.active) return false;
    ensureSlotMaterialized(slot);
    if (!slot.active) return false;
    return (slot.bitset[row >>> 5] & (1 << (row & 31))) === 0;
  }

  function setSlotIncluded(slot, row) {
    if (!slot.active) return;
    ensureSlotMaterialized(slot);
    if (!slot.active) return;
    slot.bitset[row >>> 5] |= (1 << (row & 31));
  }

  function setSlotExcluded(slot, row) {
    if (slot.active) {
      ensureSlotMaterialized(slot);
    }
    if (!slot.active) {
      activateAllOnes(slot);
    }
    slot.bitset[row >>> 5] &= ~(1 << (row & 31));
  }

  function toggleSlotRow(slot, row) {
    if (slot.active) {
      ensureSlotMaterialized(slot);
    }
    if (!slot.active) {
      activateAllOnes(slot);
    }
    slot.bitset[row >>> 5] ^= (1 << (row & 31));
  }

  function slotHasAnyExcluded(slot) {
    if (!slot.active || length === 0) return false;
    ensureSlotMaterialized(slot);
    if (!slot.active) return false;
    return countPop1(slot.bitset, wordCount) < length;
  }

  // Clear filter on `slot` and optionally extract added (previously excluded) rows.
  function clearSlotWithDeltas(slot, added, useScratch) {
    if (!slot.active) return 0;
    ensureSlotMaterialized(slot);
    if (!slot.active) return 0;
    var bits = slot.bitset;
    var tMask = tailMaskFor(length);
    var last = wordCount - 1;
    var count = 0, j, w, base, lsb;
    if (last >= 0) {
      for (j = 0; j < last; ++j) {
        w = (~bits[j]) | 0;
        if (w === 0) continue;
        base = j << 5;
        while (w !== 0) {
          lsb = w & -w;
          if (useScratch) added[count++] = base + (31 - Math.clz32(lsb));
          else added.push(base + (31 - Math.clz32(lsb)));
          w ^= lsb;
        }
      }
      w = (~bits[last]) & tMask;
      if (w !== 0) {
        base = last << 5;
        while (w !== 0) {
          lsb = w & -w;
          if (useScratch) added[count++] = base + (31 - Math.clz32(lsb));
          else added.push(base + (31 - Math.clz32(lsb)));
          w ^= lsb;
        }
      }
    }
    deactivate(slot);
    return useScratch ? count : added.length;
  }

  // Fast overwrite writers (no deltas required).
  // mode: 0=allZero, 1=exactCode(argA), 2=markedCodes(argA=marks, argB=markVersion),
  //       3=numExact(argA), 4=numRange(argA=lo, argB=hi), 5=numSet(argA=Set)
  function writePredicateNoDelta(slot, mode, source, argA, argB) {
    var bits = activateForOverwrite(slot);
    var n = length;
    var fullWords = n >>> 5;
    var w, base, word, i, b, v;
    var matchedCount = 0;

    if (mode === 0) {
      if (wordCount > 0) bits.fill(0, 0, wordCount);
      return 0;
    }

    if (mode === 1) {
      for (w = 0, base = 0; w < fullWords; ++w, base += 32) {
        bits[w] = packExactWord(source, base, argA);
      }
      if (base < n) {
        word = 0;
        for (i = base, b = 0; i < n; ++i, ++b) {
          if (source[i] === argA) word |= (1 << b);
        }
        bits[fullWords] = word >>> 0;
      }
      return -1;
    }

    if (mode === 2) {
      for (w = 0, base = 0; w < fullWords; ++w, base += 32) {
        bits[w] = packMarkedWord(source, base, argA, argB);
      }
      if (base < n) {
        word = 0;
        for (i = base, b = 0; i < n; ++i, ++b) {
          if (argA[source[i]] === argB) word |= (1 << b);
        }
        bits[fullWords] = word >>> 0;
      }
      return -1;
    }

    if (mode === 3) {
      for (w = 0, base = 0; w < fullWords; ++w, base += 32) {
        word = packExactWord(source, base, argA);
        bits[w] = word;
        if (word !== 0) matchedCount += popcount32(word);
      }
      if (base < n) {
        word = 0;
        for (i = base, b = 0; i < n; ++i, ++b) {
          if (source[i] === argA) word |= (1 << b);
        }
        word = word >>> 0;
        bits[fullWords] = word;
        if (word !== 0) matchedCount += popcount32(word);
      }
      return matchedCount;
    }

    if (mode === 4) {
      for (w = 0, base = 0; w < fullWords; ++w, base += 32) {
        word = packRangeWord(source, base, argA, argB);
        bits[w] = word;
        if (word !== 0) matchedCount += popcount32(word);
      }
      if (base < n) {
        word = 0;
        for (i = base, b = 0; i < n; ++i, ++b) {
          v = source[i];
          if (v >= argA && v < argB) word |= (1 << b);
        }
        word = word >>> 0;
        bits[fullWords] = word;
        if (word !== 0) matchedCount += popcount32(word);
      }
      return matchedCount;
    }

    // mode === 5: Set membership
    for (w = 0, base = 0; w < fullWords; ++w, base += 32) {
      word = packSetWord(source, base, argA);
      bits[w] = word;
      if (word !== 0) matchedCount += popcount32(word);
    }
    if (base < n) {
      word = 0;
      for (i = base, b = 0; i < n; ++i, ++b) {
        if (argA.has(source[i])) word |= (1 << b);
      }
      word = word >>> 0;
      bits[fullWords] = word;
      if (word !== 0) matchedCount += popcount32(word);
    }
    return matchedCount;
  }

  // Word-level XOR delta writer with optional bailout!
  function writePredicateWithDeltas(slot, mode, source, argA, argB, added, removed, useScratch, canBail, bailLimit) {
    if (slot.active) ensureSlotMaterialized(slot);
    var hadMask = slot.active;
    var bits = activateForOverwrite(slot);
    var n = length;
    var fullWords = n >>> 5;
    var tMask = tailMaskFor(n);
    var addedCount = 0;
    var removedCount = 0;
    var matchedCount = 0;
    var bailed = false;
    var w, base, newWord, oldWord, diff, addBits, remBits, lsb, i, b, v;
    var countMatches = mode >= 3;

    for (w = 0, base = 0; w < wordCount; ++w, base += 32) {
      if (w < fullWords) {
        if (mode === 0) newWord = 0;
        else if (mode === 1 || mode === 3) newWord = packExactWord(source, base, argA);
        else if (mode === 2) newWord = packMarkedWord(source, base, argA, argB);
        else if (mode === 4) newWord = packRangeWord(source, base, argA, argB);
        else newWord = packSetWord(source, base, argA);
        oldWord = hadMask ? bits[w] : 0xffffffff;
      } else {
        newWord = 0;
        if (mode === 1 || mode === 3) {
          for (i = base, b = 0; i < n; ++i, ++b) if (source[i] === argA) newWord |= (1 << b);
        } else if (mode === 2) {
          for (i = base, b = 0; i < n; ++i, ++b) if (argA[source[i]] === argB) newWord |= (1 << b);
        } else if (mode === 4) {
          for (i = base, b = 0; i < n; ++i, ++b) { v = source[i]; if (v >= argA && v < argB) newWord |= (1 << b); }
        } else if (mode === 5) {
          for (i = base, b = 0; i < n; ++i, ++b) if (argA.has(source[i])) newWord |= (1 << b);
        }
        newWord = newWord >>> 0;
        oldWord = hadMask ? bits[w] : tMask;
      }

      bits[w] = newWord;
      if (countMatches && newWord !== 0) {
        matchedCount += popcount32(newWord);
      }

      if (bailed) continue;

      diff = (oldWord ^ newWord) >>> 0;
      if (diff === 0) continue;

      addBits = diff & newWord;
      if (addBits !== 0) {
        while (addBits !== 0) {
          lsb = addBits & -addBits;
          if (useScratch) added[addedCount++] = base + (31 - Math.clz32(lsb));
          else { added.push(base + (31 - Math.clz32(lsb))); ++addedCount; }
          addBits ^= lsb;
        }
      }

      remBits = diff & oldWord;
      if (remBits !== 0) {
        while (remBits !== 0) {
          lsb = remBits & -remBits;
          if (useScratch) removed[removedCount++] = base + (31 - Math.clz32(lsb));
          else { removed.push(base + (31 - Math.clz32(lsb))); ++removedCount; }
          remBits ^= lsb;
        }
      }

      if (canBail && addedCount + removedCount > bailLimit) {
        bailed = true;
      }
    }

    return {
      addedCount: addedCount,
      bailed: bailed,
      matchedCount: countMatches ? matchedCount : -1,
      removedCount: removedCount
    };
  }

  return {
    activateAllOnes: activateAllOnes,
    activateForOverwrite: activateForOverwrite,
    active: active,
    allocSlot: allocSlot,
    clearDirty: clearDirty,
    clearSlotWithDeltas: clearSlotWithDeltas,
    compact: compact,
    countActive: countActive,
    deactivate: deactivate,
    ensureMaterialized: ensureMaterialized,
    ensureSlotMaterialized: ensureSlotMaterialized,
    extractActive: extractActive,
    extractExcluded: extractExcluded,
    freeSlot: freeSlot,
    hasAnyActive: function() { return active.length > 0; },
    hasOtherActive: function(selfSlot) {
      return active.length > (selfSlot && selfSlot.active ? 1 : 0);
    },
    isActive: isActive,
    isActiveExcept: isActiveExcept,
    isActiveIgnoring: isActiveIgnoring,
    isOnlyExcludedBy: isOnlyExcludedBy,
    isOnlyExcludedByExcept: isOnlyExcludedByExcept,
    isSlotExcluded: isSlotExcluded,
    lengthen: lengthen,
    markDirty: markDirty,
    setSlotExcluded: setSlotExcluded,
    setSlotIncluded: setSlotIncluded,
    slotHasAnyExcluded: slotHasAnyExcluded,
    toggleSlotRow: toggleSlotRow,
    writePredicateNoDelta: writePredicateNoDelta,
    writePredicateWithDeltas: writePredicateWithDeltas
  };
}

var OP_COUNT = 0;
var OP_SUM = 1;
var OP_AVG = 2;
var OP_AVG_NON_ZERO = 3;
var OP_RATIO = 4;

function compileMetricPlan(metricSpec) {
  var count = metricSpec.length;
  var ops = new Uint8Array(count);
  var ids = new Array(count);
  var fields = new Array(count);
  var denominators = new Array(count);
  var hidden = new Uint8Array(count);
  var primOff = new Int32Array(count);
  var secOff = new Int32Array(count);
  var sumOffByField = Object.create(null);
  var avgCountOffByField = Object.create(null);
  var sumFields = [];
  var sumFieldOffs = [];
  var sumFieldAvgOffs = [];
  var avgNzFields = [];
  var avgNzPrimOffs = [];
  var avgNzSecOffs = [];
  var countOffset = -1;
  var firstCountIndex = -1;
  var stride = 0;
  var i, metric, op, field, denom, off, idx;

  primOff.fill(-1);
  secOff.fill(-1);

  function ensureSumField(fieldName) {
    if (sumOffByField[fieldName] !== undefined) {
      return sumOffByField[fieldName];
    }
    var assigned = stride++;
    sumOffByField[fieldName] = assigned;
    sumFields.push(fieldName);
    sumFieldOffs.push(assigned);
    sumFieldAvgOffs.push(-1);
    return assigned;
  }

  for (i = 0; i < count; ++i) {
    metric = metricSpec[i];
    ids[i] = metric.id;
    field = metric.field || null;
    denom = metric.denominator || null;
    fields[i] = field;
    denominators[i] = denom;
    hidden[i] = metric.hidden ? 1 : 0;
    switch (metric.op) {
      case 'count':
        op = OP_COUNT;
        if (firstCountIndex < 0) firstCountIndex = i;
        if (countOffset < 0) countOffset = stride++;
        primOff[i] = countOffset;
        break;
      case 'sum':
        op = OP_SUM;
        if (field) {
          primOff[i] = ensureSumField(field);
        }
        break;
      case 'avg':
        op = OP_AVG;
        if (field) {
          primOff[i] = ensureSumField(field);
          if (avgCountOffByField[field] !== undefined) {
            secOff[i] = avgCountOffByField[field];
          } else {
            off = stride++;
            avgCountOffByField[field] = off;
            secOff[i] = off;
            idx = sumFields.indexOf(field);
            if (idx >= 0) sumFieldAvgOffs[idx] = off;
          }
        }
        break;
      case 'avgNonZero':
        op = OP_AVG_NON_ZERO;
        if (field) {
          primOff[i] = stride++;
          secOff[i] = stride++;
          avgNzFields.push(field);
          avgNzPrimOffs.push(primOff[i]);
          avgNzSecOffs.push(secOff[i]);
        }
        break;
      case 'ratio':
        op = OP_RATIO;
        if (field) {
          primOff[i] = ensureSumField(field);
        }
        if (denom) {
          secOff[i] = ensureSumField(denom);
        }
        break;
      default:
        op = OP_COUNT;
        if (firstCountIndex < 0) firstCountIndex = i;
        if (countOffset < 0) countOffset = stride++;
        primOff[i] = countOffset;
    }
    ops[i] = op;
  }

  if (stride === 0) stride = 1;

  // Collect all unique avgCountOffs and unique referenced numeric fields
  var avgCountOffs = [];
  var allUniqueFields = [];
  var seenFields = Object.create(null);
  for (i = 0; i < sumFields.length; ++i) {
    if (!seenFields[sumFields[i]]) {
      seenFields[sumFields[i]] = true;
      allUniqueFields.push(sumFields[i]);
    }
    if (sumFieldAvgOffs[i] >= 0) {
      avgCountOffs.push(sumFieldAvgOffs[i]);
    }
  }
  for (i = 0; i < avgNzFields.length; ++i) {
    if (!seenFields[avgNzFields[i]]) {
      seenFields[avgNzFields[i]] = true;
      allUniqueFields.push(avgNzFields[i]);
    }
  }

  // Primary row-count slot used by fast finite kernels (either OP_COUNT or first OP_AVG secOff)
  var fastCountOff = countOffset >= 0 ? countOffset : (avgCountOffs.length > 0 ? avgCountOffs[0] : -1);
  var fastCountField = null;
  if (countOffset < 0 && fastCountOff >= 0) {
    for (i = 0; i < sumFields.length; ++i) {
      if (sumFieldAvgOffs[i] === fastCountOff) {
        fastCountField = sumFields[i];
        break;
      }
    }
  }
  var extraAvgOffs = [];
  for (i = 0; i < avgCountOffs.length; ++i) {
    if (avgCountOffs[i] !== fastCountOff) {
      extraAvgOffs.push(avgCountOffs[i]);
    }
  }

  // Co-scan eligibility: no avgNonZero, 0..6 unique sum fields
  var canCoScan = avgNzFields.length === 0 && sumFields.length <= 6;
  var coScanKey = null;
  if (canCoScan) {
    coScanKey = stride + '|' + fastCountOff + '|' + sumFields.join(',') + '|' + sumFieldOffs.join(',') + '|' + extraAvgOffs.join(',');
  }

  return {
    allUniqueFields: allUniqueFields,
    avgCountOffs: avgCountOffs,
    avgNzFields: avgNzFields,
    avgNzPrimOffs: avgNzPrimOffs,
    avgNzSecOffs: avgNzSecOffs,
    canCoScan: canCoScan,
    coScanKey: coScanKey,
    count: count,
    countOffset: countOffset,
    denominators: denominators,
    extraAvgOffs: extraAvgOffs,
    fastCountField: fastCountField,
    fastCountOff: fastCountOff,
    fields: fields,
    firstCountIndex: firstCountIndex,
    hidden: hidden,
    ids: ids,
    ops: ops,
    primOff: primOff,
    secOff: secOff,
    spec: metricSpec,
    stride: stride,
    sumFieldAvgOffs: sumFieldAvgOffs,
    sumFieldOffs: sumFieldOffs,
    sumFields: sumFields
  };
}

function ensureMetricBuffers(buffers, plan, required, preserve) {
  var stride = plan.stride;
  var nextCap, nextData, copyLen;

  if (buffers && buffers.stride === stride && buffers.capacity >= required) {
    return buffers;
  }

  if (buffers && buffers.stride === stride && buffers.capacity > 0) {
    nextCap = buffers.capacity;
    while (nextCap < required) {
      nextCap = nextCap < 65536 ? nextCap * 2 : required;
    }
  } else {
    nextCap = required < 64 ? 64 : required;
  }

  nextData = new Float64Array(nextCap * stride);
  if (preserve && buffers && buffers.stride === stride && buffers.capacity > 0) {
    copyLen = buffers.capacity * stride;
    nextData.set(buffers.data.subarray(0, copyLen));
  }

  return {
    capacity: nextCap,
    data: nextData,
    stride: stride
  };
}

function zeroMetricBuffers(buffers, slotCount) {
  if (slotCount > 0) {
    buffers.data.fill(0, 0, slotCount * buffers.stride);
  }
}

function canPlanUseComplement(plan, getNumericColumn) {
  var fields = plan.allUniqueFields;
  for (var i = 0; i < fields.length; ++i) {
    var col = getNumericColumn(fields[i]);
    if (col && col.hasExtreme) {
      return false;
    }
  }
  return true;
}

function getExactCountOffset(plan, getNumericColumn) {
  if (plan.countOffset >= 0) return plan.countOffset;
  if (plan.fastCountOff >= 0 && plan.fastCountField) {
    var col = getNumericColumn(plan.fastCountField);
    if (col && !col.hasNaN) return plan.fastCountOff;
  }
  return -1;
}

function mirrorExtraAvgCounts(data, stride, slotCount, srcOff, extraAvgOffs) {
  var extraLen = extraAvgOffs.length;
  if (!extraLen || srcOff < 0 || slotCount <= 0) return;
  var s, base, val, e;
  if (extraLen === 1) {
    var e0 = extraAvgOffs[0];
    for (s = 0, base = 0; s < slotCount; ++s, base += stride) {
      data[base + e0] = data[base + srcOff];
    }
    return;
  }
  for (s = 0, base = 0; s < slotCount; ++s, base += stride) {
    val = data[base + srcOff];
    for (e = 0; e < extraLen; ++e) {
      data[base + extraAvgOffs[e]] = val;
    }
  }
}

// ============================================================================
// Single-group interleaved AoS leaf kernels (ALL rows 0..n-1)
// ============================================================================

function aoCountAll(data, stride, cOff, groupIds, n) {
  for (var i = 0; i < n; ++i) data[groupIds[i] * stride + cOff] += 1;
}

function ao1All(data, stride, cOff, o0, groupIds, v0, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
    }
  } else if (stride === 1 && o0 === 0) {
    for (i = 0; i < n; ++i) data[groupIds[i]] += v0[i];
  } else {
    for (i = 0; i < n; ++i) data[groupIds[i] * stride + o0] += v0[i];
  }
}

function ao2All(data, stride, cOff, o0, o1, groupIds, v0, v1, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
    }
  }
}

function ao3All(data, stride, cOff, o0, o1, o2, groupIds, v0, v1, v2, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
    }
  }
}

function ao4All(data, stride, cOff, o0, o1, o2, o3, groupIds, v0, v1, v2, v3, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
      data[o + o3] += v3[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
      data[o + o3] += v3[i];
    }
  }
}

function ao5All(data, stride, cOff, o0, o1, o2, o3, o4, groupIds, v0, v1, v2, v3, v4, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
      data[o + o3] += v3[i];
      data[o + o4] += v4[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      o = groupIds[i] * stride;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
      data[o + o3] += v3[i];
      data[o + o4] += v4[i];
    }
  }
}

function ao6All(data, stride, cOff, o0, o1, o2, o3, o4, o5, groupIds, v0, v1, v2, v3, v4, v5, n) {
  var i, o;
  for (i = 0; i < n; ++i) {
    o = groupIds[i] * stride;
    if (cOff >= 0) data[o + cOff] += 1;
    data[o + o0] += v0[i];
    data[o + o1] += v1[i];
    data[o + o2] += v2[i];
    data[o + o3] += v3[i];
    data[o + o4] += v4[i];
    data[o + o5] += v5[i];
  }
}

// ============================================================================
// Single-group interleaved AoS leaf kernels (INDEXED rows, add or sub)
// ============================================================================

function aoCountIdx(data, stride, cOff, groupIds, rowIndexes, rowCount, add) {
  var j;
  if (add) {
    for (j = 0; j < rowCount; ++j) data[groupIds[rowIndexes[j]] * stride + cOff] += 1;
  } else {
    for (j = 0; j < rowCount; ++j) data[groupIds[rowIndexes[j]] * stride + cOff] -= 1;
  }
}

function ao1Idx(data, stride, cOff, o0, groupIds, v0, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
      }
    } else if (stride === 1 && o0 === 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        data[groupIds[idx]] += v0[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        data[groupIds[idx] * stride + o0] += v0[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
    }
  } else if (stride === 1 && o0 === 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      data[groupIds[idx]] -= v0[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      data[groupIds[idx] * stride + o0] -= v0[idx];
    }
  }
}

function ao2Idx(data, stride, cOff, o0, o1, groupIds, v0, v1, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
    }
  }
}

function ao3Idx(data, stride, cOff, o0, o1, o2, groupIds, v0, v1, v2, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
    }
  }
}

function ao4Idx(data, stride, cOff, o0, o1, o2, o3, groupIds, v0, v1, v2, v3, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
        data[o + o3] += v3[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
        data[o + o3] += v3[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
    }
  }
}

function ao5Idx(data, stride, cOff, o0, o1, o2, o3, o4, groupIds, v0, v1, v2, v3, v4, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
        data[o + o3] += v3[idx];
        data[o + o4] += v4[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = groupIds[idx] * stride;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
        data[o + o3] += v3[idx];
        data[o + o4] += v4[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
      data[o + o4] -= v4[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
      data[o + o4] -= v4[idx];
    }
  }
}

function ao6Idx(data, stride, cOff, o0, o1, o2, o3, o4, o5, groupIds, v0, v1, v2, v3, v4, v5, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      if (cOff >= 0) data[o + cOff] += 1;
      data[o + o0] += v0[idx];
      data[o + o1] += v1[idx];
      data[o + o2] += v2[idx];
      data[o + o3] += v3[idx];
      data[o + o4] += v4[idx];
      data[o + o5] += v5[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = groupIds[idx] * stride;
      if (cOff >= 0) data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
      data[o + o4] -= v4[idx];
      data[o + o5] -= v5[idx];
    }
  }
}

// ============================================================================
// Split-Dense interleaved AoS leaf kernels (ALL & INDEXED)
// ============================================================================

function sd1All(data, stride, cOff, o0, pSlots, sCodes, sStride, v0, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = (pSlots[i] * sStride + sCodes[i]) * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
    }
  } else if (stride === 1 && o0 === 0) {
    for (i = 0; i < n; ++i) data[pSlots[i] * sStride + sCodes[i]] += v0[i];
  } else {
    for (i = 0; i < n; ++i) data[(pSlots[i] * sStride + sCodes[i]) * stride + o0] += v0[i];
  }
}

function sd2All(data, stride, cOff, o0, o1, pSlots, sCodes, sStride, v0, v1, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = (pSlots[i] * sStride + sCodes[i]) * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      o = (pSlots[i] * sStride + sCodes[i]) * stride;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
    }
  }
}

function sd3All(data, stride, cOff, o0, o1, o2, pSlots, sCodes, sStride, v0, v1, v2, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = (pSlots[i] * sStride + sCodes[i]) * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      o = (pSlots[i] * sStride + sCodes[i]) * stride;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
    }
  }
}

function sd4All(data, stride, cOff, o0, o1, o2, o3, pSlots, sCodes, sStride, v0, v1, v2, v3, n) {
  var i, o;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      o = (pSlots[i] * sStride + sCodes[i]) * stride;
      data[o + cOff] += 1;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
      data[o + o3] += v3[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      o = (pSlots[i] * sStride + sCodes[i]) * stride;
      data[o + o0] += v0[i];
      data[o + o1] += v1[i];
      data[o + o2] += v2[i];
      data[o + o3] += v3[i];
    }
  }
}

function sd5All(data, stride, cOff, o0, o1, o2, o3, o4, pSlots, sCodes, sStride, v0, v1, v2, v3, v4, n) {
  var i, o;
  for (i = 0; i < n; ++i) {
    o = (pSlots[i] * sStride + sCodes[i]) * stride;
    if (cOff >= 0) data[o + cOff] += 1;
    data[o + o0] += v0[i];
    data[o + o1] += v1[i];
    data[o + o2] += v2[i];
    data[o + o3] += v3[i];
    data[o + o4] += v4[i];
  }
}

function sd6All(data, stride, cOff, o0, o1, o2, o3, o4, o5, pSlots, sCodes, sStride, v0, v1, v2, v3, v4, v5, n) {
  var i, o;
  for (i = 0; i < n; ++i) {
    o = (pSlots[i] * sStride + sCodes[i]) * stride;
    if (cOff >= 0) data[o + cOff] += 1;
    data[o + o0] += v0[i];
    data[o + o1] += v1[i];
    data[o + o2] += v2[i];
    data[o + o3] += v3[i];
    data[o + o4] += v4[i];
    data[o + o5] += v5[i];
  }
}

function sd1Idx(data, stride, cOff, o0, pSlots, sCodes, sStride, v0, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
      }
    } else if (stride === 1 && o0 === 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        data[pSlots[idx] * sStride + sCodes[idx]] += v0[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        data[(pSlots[idx] * sStride + sCodes[idx]) * stride + o0] += v0[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
    }
  } else if (stride === 1 && o0 === 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      data[pSlots[idx] * sStride + sCodes[idx]] -= v0[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      data[(pSlots[idx] * sStride + sCodes[idx]) * stride + o0] -= v0[idx];
    }
  }
}

function sd2Idx(data, stride, cOff, o0, o1, pSlots, sCodes, sStride, v0, v1, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
    }
  }
}

function sd3Idx(data, stride, cOff, o0, o1, o2, pSlots, sCodes, sStride, v0, v1, v2, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
    }
  }
}

function sd4Idx(data, stride, cOff, o0, o1, o2, o3, pSlots, sCodes, sStride, v0, v1, v2, v3, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    if (cOff >= 0) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
        data[o + cOff] += 1;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
        data[o + o3] += v3[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
        data[o + o0] += v0[idx];
        data[o + o1] += v1[idx];
        data[o + o2] += v2[idx];
        data[o + o3] += v3[idx];
      }
    }
  } else if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
    }
  }
}

function sd5Idx(data, stride, cOff, o0, o1, o2, o3, o4, pSlots, sCodes, sStride, v0, v1, v2, v3, v4, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      if (cOff >= 0) data[o + cOff] += 1;
      data[o + o0] += v0[idx];
      data[o + o1] += v1[idx];
      data[o + o2] += v2[idx];
      data[o + o3] += v3[idx];
      data[o + o4] += v4[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      if (cOff >= 0) data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
      data[o + o4] -= v4[idx];
    }
  }
}

function sd6Idx(data, stride, cOff, o0, o1, o2, o3, o4, o5, pSlots, sCodes, sStride, v0, v1, v2, v3, v4, v5, rowIndexes, rowCount, add) {
  var j, idx, o;
  if (add) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      if (cOff >= 0) data[o + cOff] += 1;
      data[o + o0] += v0[idx];
      data[o + o1] += v1[idx];
      data[o + o2] += v2[idx];
      data[o + o3] += v3[idx];
      data[o + o4] += v4[idx];
      data[o + o5] += v5[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
      if (cOff >= 0) data[o + cOff] -= 1;
      data[o + o0] -= v0[idx];
      data[o + o1] -= v1[idx];
      data[o + o2] -= v2[idx];
      data[o + o3] -= v3[idx];
      data[o + o4] -= v4[idx];
      data[o + o5] -= v5[idx];
    }
  }
}

// ============================================================================
// General NaN / >4-field / avgNonZero AoS fallbacks
// ============================================================================

function aoGeneralAll(data, stride, plan, getNumericColumn, groupIds, n) {
  var i, f, col, vals, hasNaN, off, avgOff, pOff, sOff, v, o;
  var cOff = plan.countOffset;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) data[groupIds[i] * stride + cOff] += 1;
  }
  var sumFields = plan.sumFields;
  var sumFieldOffs = plan.sumFieldOffs;
  var sumFieldAvgOffs = plan.sumFieldAvgOffs;
  for (f = 0; f < sumFields.length; ++f) {
    col = getNumericColumn(sumFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    off = sumFieldOffs[f];
    avgOff = sumFieldAvgOffs[f];
    if (avgOff >= 0) {
      if (!hasNaN) {
        for (i = 0; i < n; ++i) {
          o = groupIds[i] * stride;
          data[o + off] += vals[i];
          data[o + avgOff] += 1;
        }
      } else {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v) {
            o = groupIds[i] * stride;
            data[o + off] += v;
            data[o + avgOff] += 1;
          }
        }
      }
    } else if (!hasNaN) {
      for (i = 0; i < n; ++i) data[groupIds[i] * stride + off] += vals[i];
    } else {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v === v) data[groupIds[i] * stride + off] += v;
      }
    }
  }
  var avgNzFields = plan.avgNzFields;
  var avgNzPrimOffs = plan.avgNzPrimOffs;
  var avgNzSecOffs = plan.avgNzSecOffs;
  for (f = 0; f < avgNzFields.length; ++f) {
    col = getNumericColumn(avgNzFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    pOff = avgNzPrimOffs[f];
    sOff = avgNzSecOffs[f];
    if (!hasNaN) {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v !== 0) {
          o = groupIds[i] * stride;
          data[o + pOff] += v;
          data[o + sOff] += 1;
        }
      }
    } else {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v === v && v !== 0) {
          o = groupIds[i] * stride;
          data[o + pOff] += v;
          data[o + sOff] += 1;
        }
      }
    }
  }
}

function aoGeneralIdx(data, stride, plan, getNumericColumn, groupIds, rowIndexes, rowCount, add) {
  var j, idx, f, col, vals, hasNaN, off, avgOff, pOff, sOff, v, o;
  var cOff = plan.countOffset;
  var sign = add ? 1 : -1;
  if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) data[groupIds[rowIndexes[j]] * stride + cOff] += sign;
  }
  var sumFields = plan.sumFields;
  var sumFieldOffs = plan.sumFieldOffs;
  var sumFieldAvgOffs = plan.sumFieldAvgOffs;
  for (f = 0; f < sumFields.length; ++f) {
    col = getNumericColumn(sumFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    off = sumFieldOffs[f];
    avgOff = sumFieldAvgOffs[f];
    if (avgOff >= 0) {
      if (!hasNaN) {
        for (j = 0; j < rowCount; ++j) {
          idx = rowIndexes[j];
          o = groupIds[idx] * stride;
          data[o + off] += sign * vals[idx];
          data[o + avgOff] += sign;
        }
      } else {
        for (j = 0; j < rowCount; ++j) {
          idx = rowIndexes[j];
          v = vals[idx];
          if (v === v) {
            o = groupIds[idx] * stride;
            data[o + off] += sign * v;
            data[o + avgOff] += sign;
          }
        }
      }
    } else if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        data[groupIds[idx] * stride + off] += sign * vals[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v) data[groupIds[idx] * stride + off] += sign * v;
      }
    }
  }
  var avgNzFields = plan.avgNzFields;
  var avgNzPrimOffs = plan.avgNzPrimOffs;
  var avgNzSecOffs = plan.avgNzSecOffs;
  for (f = 0; f < avgNzFields.length; ++f) {
    col = getNumericColumn(avgNzFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    pOff = avgNzPrimOffs[f];
    sOff = avgNzSecOffs[f];
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v !== 0) {
          o = groupIds[idx] * stride;
          data[o + pOff] += sign * v;
          data[o + sOff] += sign;
        }
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v && v !== 0) {
          o = groupIds[idx] * stride;
          data[o + pOff] += sign * v;
          data[o + sOff] += sign;
        }
      }
    }
  }
}

function sdGeneralAll(data, stride, plan, getNumericColumn, pSlots, sCodes, sStride, n) {
  var i, f, col, vals, hasNaN, off, avgOff, pOff, sOff, v, o;
  var cOff = plan.countOffset;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) data[(pSlots[i] * sStride + sCodes[i]) * stride + cOff] += 1;
  }
  var sumFields = plan.sumFields;
  var sumFieldOffs = plan.sumFieldOffs;
  var sumFieldAvgOffs = plan.sumFieldAvgOffs;
  for (f = 0; f < sumFields.length; ++f) {
    col = getNumericColumn(sumFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    off = sumFieldOffs[f];
    avgOff = sumFieldAvgOffs[f];
    if (avgOff >= 0) {
      if (!hasNaN) {
        for (i = 0; i < n; ++i) {
          o = (pSlots[i] * sStride + sCodes[i]) * stride;
          data[o + off] += vals[i];
          data[o + avgOff] += 1;
        }
      } else {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v) {
            o = (pSlots[i] * sStride + sCodes[i]) * stride;
            data[o + off] += v;
            data[o + avgOff] += 1;
          }
        }
      }
    } else if (!hasNaN) {
      for (i = 0; i < n; ++i) data[(pSlots[i] * sStride + sCodes[i]) * stride + off] += vals[i];
    } else {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v === v) data[(pSlots[i] * sStride + sCodes[i]) * stride + off] += v;
      }
    }
  }
  var avgNzFields = plan.avgNzFields;
  var avgNzPrimOffs = plan.avgNzPrimOffs;
  var avgNzSecOffs = plan.avgNzSecOffs;
  for (f = 0; f < avgNzFields.length; ++f) {
    col = getNumericColumn(avgNzFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    pOff = avgNzPrimOffs[f];
    sOff = avgNzSecOffs[f];
    if (!hasNaN) {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v !== 0) {
          o = (pSlots[i] * sStride + sCodes[i]) * stride;
          data[o + pOff] += v;
          data[o + sOff] += 1;
        }
      }
    } else {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v === v && v !== 0) {
          o = (pSlots[i] * sStride + sCodes[i]) * stride;
          data[o + pOff] += v;
          data[o + sOff] += 1;
        }
      }
    }
  }
}

function sdGeneralIdx(data, stride, plan, getNumericColumn, pSlots, sCodes, sStride, rowIndexes, rowCount, add) {
  var j, idx, f, col, vals, hasNaN, off, avgOff, pOff, sOff, v, o;
  var cOff = plan.countOffset;
  var sign = add ? 1 : -1;
  if (cOff >= 0) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      data[(pSlots[idx] * sStride + sCodes[idx]) * stride + cOff] += sign;
    }
  }
  var sumFields = plan.sumFields;
  var sumFieldOffs = plan.sumFieldOffs;
  var sumFieldAvgOffs = plan.sumFieldAvgOffs;
  for (f = 0; f < sumFields.length; ++f) {
    col = getNumericColumn(sumFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    off = sumFieldOffs[f];
    avgOff = sumFieldAvgOffs[f];
    if (avgOff >= 0) {
      if (!hasNaN) {
        for (j = 0; j < rowCount; ++j) {
          idx = rowIndexes[j];
          o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
          data[o + off] += sign * vals[idx];
          data[o + avgOff] += sign;
        }
      } else {
        for (j = 0; j < rowCount; ++j) {
          idx = rowIndexes[j];
          v = vals[idx];
          if (v === v) {
            o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
            data[o + off] += sign * v;
            data[o + avgOff] += sign;
          }
        }
      }
    } else if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        data[(pSlots[idx] * sStride + sCodes[idx]) * stride + off] += sign * vals[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v) data[(pSlots[idx] * sStride + sCodes[idx]) * stride + off] += sign * v;
      }
    }
  }
  var avgNzFields = plan.avgNzFields;
  var avgNzPrimOffs = plan.avgNzPrimOffs;
  var avgNzSecOffs = plan.avgNzSecOffs;
  for (f = 0; f < avgNzFields.length; ++f) {
    col = getNumericColumn(avgNzFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    pOff = avgNzPrimOffs[f];
    sOff = avgNzSecOffs[f];
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v !== 0) {
          o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
          data[o + pOff] += sign * v;
          data[o + sOff] += sign;
        }
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v && v !== 0) {
          o = (pSlots[idx] * sStride + sCodes[idx]) * stride;
          data[o + pOff] += sign * v;
          data[o + sOff] += sign;
        }
      }
    }
  }
}

// ============================================================================
// Multi-group shared-scan kernels (2..5 groups + optional KPI in one pass!)
// ============================================================================

function resolveFastColumns(plan, getNumericColumn) {
  if (!plan.canCoScan) return null;
  var sf = plan.sumFields;
  var fLen = sf.length;
  var cols = new Array(fLen);
  for (var f = 0; f < fLen; ++f) {
    var c = getNumericColumn(sf[f]);
    if (c.hasNaN) return null;
    cols[f] = c.values;
  }
  return cols;
}

function coAll0(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, n) {
  for (var i = 0; i < n; ++i) {
    d0[s0[i] * stride + cOff] += 1;
    if (count > 1) d1[s1[i] * stride + cOff] += 1;
    if (count > 2) d2[s2[i] * stride + cOff] += 1;
    if (count > 3) d3[s3[i] * stride + cOff] += 1;
    if (count > 4) d4[s4[i] * stride + cOff] += 1;
  }
  if (kpiData) kpiData[cOff] += n;
}

function coAll1(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, o0, col0, n) {
  var i, o, v0, k0 = 0;
  if (cOff >= 0) {
    for (i = 0; i < n; ++i) {
      v0 = col0[i]; k0 += v0;
      o = s0[i] * stride; d0[o + cOff] += 1; d0[o + o0] += v0;
      if (count > 1) { o = s1[i] * stride; d1[o + cOff] += 1; d1[o + o0] += v0; }
      if (count > 2) { o = s2[i] * stride; d2[o + cOff] += 1; d2[o + o0] += v0; }
      if (count > 3) { o = s3[i] * stride; d3[o + cOff] += 1; d3[o + o0] += v0; }
      if (count > 4) { o = s4[i] * stride; d4[o + cOff] += 1; d4[o + o0] += v0; }
    }
    if (kpiData) { kpiData[cOff] += n; kpiData[o0] += k0; }
  } else if (stride === 1 && o0 === 0) {
    for (i = 0; i < n; ++i) {
      v0 = col0[i]; k0 += v0;
      d0[s0[i]] += v0;
      if (count > 1) d1[s1[i]] += v0;
      if (count > 2) d2[s2[i]] += v0;
      if (count > 3) d3[s3[i]] += v0;
      if (count > 4) d4[s4[i]] += v0;
    }
    if (kpiData) kpiData[0] += k0;
  } else {
    for (i = 0; i < n; ++i) {
      v0 = col0[i]; k0 += v0;
      d0[s0[i] * stride + o0] += v0;
      if (count > 1) d1[s1[i] * stride + o0] += v0;
      if (count > 2) d2[s2[i] * stride + o0] += v0;
      if (count > 3) d3[s3[i] * stride + o0] += v0;
      if (count > 4) d4[s4[i] * stride + o0] += v0;
    }
    if (kpiData) kpiData[o0] += k0;
  }
}

function coAll2(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, p0, p1, a0, a1, n) {
  var i, o, v0, v1, k0 = 0, k1 = 0, hasC = cOff >= 0;
  for (i = 0; i < n; ++i) {
    v0 = a0[i]; v1 = a1[i]; k0 += v0; k1 += v1;
    o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + p0] += v0; d0[o + p1] += v1;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + p0] += v0; d1[o + p1] += v1; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + p0] += v0; d2[o + p1] += v1; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + p0] += v0; d3[o + p1] += v1; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + p0] += v0; d4[o + p1] += v1; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += n; kpiData[p0] += k0; kpiData[p1] += k1; }
}

function coAll3(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, q0, q1, q2, b0, b1, b2, n) {
  var i, o, v0, v1, v2, k0 = 0, k1 = 0, k2 = 0, hasC = cOff >= 0;
  for (i = 0; i < n; ++i) {
    v0 = b0[i]; v1 = b1[i]; v2 = b2[i]; k0 += v0; k1 += v1; k2 += v2;
    o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + q0] += v0; d0[o + q1] += v1; d0[o + q2] += v2;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + q0] += v0; d1[o + q1] += v1; d1[o + q2] += v2; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + q0] += v0; d2[o + q1] += v1; d2[o + q2] += v2; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + q0] += v0; d3[o + q1] += v1; d3[o + q2] += v2; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + q0] += v0; d4[o + q1] += v1; d4[o + q2] += v2; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += n; kpiData[q0] += k0; kpiData[q1] += k1; kpiData[q2] += k2; }
}

function coAll4(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, r0, r1, r2, r3, c0, c1, c2, c3, n) {
  var i, o, v0, v1, v2, v3, k0 = 0, k1 = 0, k2 = 0, k3 = 0, hasC = cOff >= 0;
  if (hasC && count === 5) {
    for (i = 0; i < n; ++i) {
      v0 = c0[i]; v1 = c1[i]; v2 = c2[i]; v3 = c3[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3;
      o = s0[i] * stride; d0[o + cOff] += 1; d0[o + r0] += v0; d0[o + r1] += v1; d0[o + r2] += v2; d0[o + r3] += v3;
      o = s1[i] * stride; d1[o + cOff] += 1; d1[o + r0] += v0; d1[o + r1] += v1; d1[o + r2] += v2; d1[o + r3] += v3;
      o = s2[i] * stride; d2[o + cOff] += 1; d2[o + r0] += v0; d2[o + r1] += v1; d2[o + r2] += v2; d2[o + r3] += v3;
      o = s3[i] * stride; d3[o + cOff] += 1; d3[o + r0] += v0; d3[o + r1] += v1; d3[o + r2] += v2; d3[o + r3] += v3;
      o = s4[i] * stride; d4[o + cOff] += 1; d4[o + r0] += v0; d4[o + r1] += v1; d4[o + r2] += v2; d4[o + r3] += v3;
    }
  } else {
    for (i = 0; i < n; ++i) {
      v0 = c0[i]; v1 = c1[i]; v2 = c2[i]; v3 = c3[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3;
      o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + r0] += v0; d0[o + r1] += v1; d0[o + r2] += v2; d0[o + r3] += v3;
      if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + r0] += v0; d1[o + r1] += v1; d1[o + r2] += v2; d1[o + r3] += v3; }
      if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + r0] += v0; d2[o + r1] += v1; d2[o + r2] += v2; d2[o + r3] += v3; }
      if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + r0] += v0; d3[o + r1] += v1; d3[o + r2] += v2; d3[o + r3] += v3; }
      if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + r0] += v0; d4[o + r1] += v1; d4[o + r2] += v2; d4[o + r3] += v3; }
    }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += n; kpiData[r0] += k0; kpiData[r1] += k1; kpiData[r2] += k2; kpiData[r3] += k3; }
}

function coAll5(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, t0, t1, t2, t3, t4, e0, e1, e2, e3, e4, n) {
  var i, o, v0, v1, v2, v3, v4, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0, hasC = cOff >= 0;
  if (hasC && count === 5) {
    for (i = 0; i < n; ++i) {
      v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4;
      o = s0[i] * stride; d0[o + cOff] += 1; d0[o + t0] += v0; d0[o + t1] += v1; d0[o + t2] += v2; d0[o + t3] += v3; d0[o + t4] += v4;
      o = s1[i] * stride; d1[o + cOff] += 1; d1[o + t0] += v0; d1[o + t1] += v1; d1[o + t2] += v2; d1[o + t3] += v3; d1[o + t4] += v4;
      o = s2[i] * stride; d2[o + cOff] += 1; d2[o + t0] += v0; d2[o + t1] += v1; d2[o + t2] += v2; d2[o + t3] += v3; d2[o + t4] += v4;
      o = s3[i] * stride; d3[o + cOff] += 1; d3[o + t0] += v0; d3[o + t1] += v1; d3[o + t2] += v2; d3[o + t3] += v3; d3[o + t4] += v4;
      o = s4[i] * stride; d4[o + cOff] += 1; d4[o + t0] += v0; d4[o + t1] += v1; d4[o + t2] += v2; d4[o + t3] += v3; d4[o + t4] += v4;
    }
  } else {
    for (i = 0; i < n; ++i) {
      v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4;
      o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + t0] += v0; d0[o + t1] += v1; d0[o + t2] += v2; d0[o + t3] += v3; d0[o + t4] += v4;
      if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + t0] += v0; d1[o + t1] += v1; d1[o + t2] += v2; d1[o + t3] += v3; d1[o + t4] += v4; }
      if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + t0] += v0; d2[o + t1] += v1; d2[o + t2] += v2; d2[o + t3] += v3; d2[o + t4] += v4; }
      if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + t0] += v0; d3[o + t1] += v1; d3[o + t2] += v2; d3[o + t3] += v3; d3[o + t4] += v4; }
      if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + t0] += v0; d4[o + t1] += v1; d4[o + t2] += v2; d4[o + t3] += v3; d4[o + t4] += v4; }
    }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += n; kpiData[t0] += k0; kpiData[t1] += k1; kpiData[t2] += k2; kpiData[t3] += k3; kpiData[t4] += k4; }
}

function coAll6(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, t0, t1, t2, t3, t4, t5, e0, e1, e2, e3, e4, e5, n) {
  var i, o, v0, v1, v2, v3, v4, v5, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0, hasC = cOff >= 0;
  for (i = 0; i < n; ++i) {
    v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i]; v5 = e5[i];
    k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4; k5 += v5;
    o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + t0] += v0; d0[o + t1] += v1; d0[o + t2] += v2; d0[o + t3] += v3; d0[o + t4] += v4; d0[o + t5] += v5;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + t0] += v0; d1[o + t1] += v1; d1[o + t2] += v2; d1[o + t3] += v3; d1[o + t4] += v4; d1[o + t5] += v5; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + t0] += v0; d2[o + t1] += v1; d2[o + t2] += v2; d2[o + t3] += v3; d2[o + t4] += v4; d2[o + t5] += v5; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + t0] += v0; d3[o + t1] += v1; d3[o + t2] += v2; d3[o + t3] += v3; d3[o + t4] += v4; d3[o + t5] += v5; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + t0] += v0; d4[o + t1] += v1; d4[o + t2] += v2; d4[o + t3] += v3; d4[o + t4] += v4; d4[o + t5] += v5; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += n; kpiData[t0] += k0; kpiData[t1] += k1; kpiData[t2] += k2; kpiData[t3] += k3; kpiData[t4] += k4; kpiData[t5] += k5; }
}

function coScanRunAll(targets, start, count, kpiData, stride, cOff, offs, cols, n) {
  var fLen = cols.length;
  var d0 = targets[start].buffers.data, s0 = targets[start].slotArr;
  var d1 = count > 1 ? targets[start + 1].buffers.data : null, s1 = count > 1 ? targets[start + 1].slotArr : null;
  var d2 = count > 2 ? targets[start + 2].buffers.data : null, s2 = count > 2 ? targets[start + 2].slotArr : null;
  var d3 = count > 3 ? targets[start + 3].buffers.data : null, s3 = count > 3 ? targets[start + 3].slotArr : null;
  var d4 = count > 4 ? targets[start + 4].buffers.data : null, s4 = count > 4 ? targets[start + 4].slotArr : null;

  if (fLen === 0 && cOff >= 0) {
    coAll0(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, n);
  } else if (fLen === 1) {
    coAll1(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], cols[0], n);
  } else if (fLen === 2) {
    coAll2(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], cols[0], cols[1], n);
  } else if (fLen === 3) {
    coAll3(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], cols[0], cols[1], cols[2], n);
  } else if (fLen === 4) {
    coAll4(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], cols[0], cols[1], cols[2], cols[3], n);
  } else if (fLen === 5) {
    coAll5(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], cols[0], cols[1], cols[2], cols[3], cols[4], n);
  } else if (fLen === 6) {
    coAll6(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], offs[5], cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], n);
  }
}

function coIdx0(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, rowIndexes, rowCount, sign) {
  for (var j = 0, i; j < rowCount; ++j) {
    i = rowIndexes[j];
    d0[s0[i] * stride + cOff] += sign;
    if (count > 1) d1[s1[i] * stride + cOff] += sign;
    if (count > 2) d2[s2[i] * stride + cOff] += sign;
    if (count > 3) d3[s3[i] * stride + cOff] += sign;
    if (count > 4) d4[s4[i] * stride + cOff] += sign;
  }
  if (kpiData) kpiData[cOff] += sign * rowCount;
}

function coIdx1Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, o0, col0, rowIndexes, rowCount) {
  var j, i, o, v0, k0 = 0, hasC = cOff >= 0;
  for (j = 0; j < rowCount; ++j) {
    i = rowIndexes[j]; v0 = col0[i]; k0 += v0;
    o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + o0] += v0;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + o0] += v0; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + o0] += v0; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + o0] += v0; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + o0] += v0; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += rowCount; kpiData[o0] += k0; }
}

function coIdx1Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, o0, col0, rowIndexes, rowCount) {
  var j, i, o, v0, k0 = 0, hasC = cOff >= 0;
  for (j = 0; j < rowCount; ++j) {
    i = rowIndexes[j]; v0 = col0[i]; k0 += v0;
    o = s0[i] * stride; if (hasC) d0[o + cOff] -= 1; d0[o + o0] -= v0;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] -= 1; d1[o + o0] -= v0; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] -= 1; d2[o + o0] -= v0; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] -= 1; d3[o + o0] -= v0; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] -= 1; d4[o + o0] -= v0; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] -= rowCount; kpiData[o0] -= k0; }
}

function coIdx2Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, p0, p1, a0, a1, rowIndexes, rowCount) {
  var j, i, o, v0, v1, k0 = 0, k1 = 0, hasC = cOff >= 0;
  for (j = 0; j < rowCount; ++j) {
    i = rowIndexes[j]; v0 = a0[i]; v1 = a1[i]; k0 += v0; k1 += v1;
    o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + p0] += v0; d0[o + p1] += v1;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + p0] += v0; d1[o + p1] += v1; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + p0] += v0; d2[o + p1] += v1; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + p0] += v0; d3[o + p1] += v1; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + p0] += v0; d4[o + p1] += v1; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += rowCount; kpiData[p0] += k0; kpiData[p1] += k1; }
}

function coIdx2Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, p0, p1, a0, a1, rowIndexes, rowCount) {
  var j, i, o, v0, v1, k0 = 0, k1 = 0, hasC = cOff >= 0;
  for (j = 0; j < rowCount; ++j) {
    i = rowIndexes[j]; v0 = a0[i]; v1 = a1[i]; k0 += v0; k1 += v1;
    o = s0[i] * stride; if (hasC) d0[o + cOff] -= 1; d0[o + p0] -= v0; d0[o + p1] -= v1;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] -= 1; d1[o + p0] -= v0; d1[o + p1] -= v1; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] -= 1; d2[o + p0] -= v0; d2[o + p1] -= v1; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] -= 1; d3[o + p0] -= v0; d3[o + p1] -= v1; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] -= 1; d4[o + p0] -= v0; d4[o + p1] -= v1; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] -= rowCount; kpiData[p0] -= k0; kpiData[p1] -= k1; }
}

function coIdx3Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, q0, q1, q2, b0, b1, b2, rowIndexes, rowCount) {
  var j, i, o, v0, v1, v2, k0 = 0, k1 = 0, k2 = 0, hasC = cOff >= 0;
  for (j = 0; j < rowCount; ++j) {
    i = rowIndexes[j]; v0 = b0[i]; v1 = b1[i]; v2 = b2[i]; k0 += v0; k1 += v1; k2 += v2;
    o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + q0] += v0; d0[o + q1] += v1; d0[o + q2] += v2;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + q0] += v0; d1[o + q1] += v1; d1[o + q2] += v2; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + q0] += v0; d2[o + q1] += v1; d2[o + q2] += v2; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + q0] += v0; d3[o + q1] += v1; d3[o + q2] += v2; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + q0] += v0; d4[o + q1] += v1; d4[o + q2] += v2; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += rowCount; kpiData[q0] += k0; kpiData[q1] += k1; kpiData[q2] += k2; }
}

function coIdx3Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, q0, q1, q2, b0, b1, b2, rowIndexes, rowCount) {
  var j, i, o, v0, v1, v2, k0 = 0, k1 = 0, k2 = 0, hasC = cOff >= 0;
  for (j = 0; j < rowCount; ++j) {
    i = rowIndexes[j]; v0 = b0[i]; v1 = b1[i]; v2 = b2[i]; k0 += v0; k1 += v1; k2 += v2;
    o = s0[i] * stride; if (hasC) d0[o + cOff] -= 1; d0[o + q0] -= v0; d0[o + q1] -= v1; d0[o + q2] -= v2;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] -= 1; d1[o + q0] -= v0; d1[o + q1] -= v1; d1[o + q2] -= v2; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] -= 1; d2[o + q0] -= v0; d2[o + q1] -= v1; d2[o + q2] -= v2; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] -= 1; d3[o + q0] -= v0; d3[o + q1] -= v1; d3[o + q2] -= v2; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] -= 1; d4[o + q0] -= v0; d4[o + q1] -= v1; d4[o + q2] -= v2; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] -= rowCount; kpiData[q0] -= k0; kpiData[q1] -= k1; kpiData[q2] -= k2; }
}

function coIdx4Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, r0, r1, r2, r3, c0, c1, c2, c3, rowIndexes, rowCount) {
  var j, i, o, v0, v1, v2, v3, k0 = 0, k1 = 0, k2 = 0, k3 = 0, hasC = cOff >= 0;
  if (hasC && count === 5) {
    for (j = 0; j < rowCount; ++j) {
      i = rowIndexes[j];
      v0 = c0[i]; v1 = c1[i]; v2 = c2[i]; v3 = c3[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3;
      o = s0[i] * stride; d0[o + cOff] += 1; d0[o + r0] += v0; d0[o + r1] += v1; d0[o + r2] += v2; d0[o + r3] += v3;
      o = s1[i] * stride; d1[o + cOff] += 1; d1[o + r0] += v0; d1[o + r1] += v1; d1[o + r2] += v2; d1[o + r3] += v3;
      o = s2[i] * stride; d2[o + cOff] += 1; d2[o + r0] += v0; d2[o + r1] += v1; d2[o + r2] += v2; d2[o + r3] += v3;
      o = s3[i] * stride; d3[o + cOff] += 1; d3[o + r0] += v0; d3[o + r1] += v1; d3[o + r2] += v2; d3[o + r3] += v3;
      o = s4[i] * stride; d4[o + cOff] += 1; d4[o + r0] += v0; d4[o + r1] += v1; d4[o + r2] += v2; d4[o + r3] += v3;
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      i = rowIndexes[j];
      v0 = c0[i]; v1 = c1[i]; v2 = c2[i]; v3 = c3[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3;
      o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + r0] += v0; d0[o + r1] += v1; d0[o + r2] += v2; d0[o + r3] += v3;
      if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + r0] += v0; d1[o + r1] += v1; d1[o + r2] += v2; d1[o + r3] += v3; }
      if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + r0] += v0; d2[o + r1] += v1; d2[o + r2] += v2; d2[o + r3] += v3; }
      if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + r0] += v0; d3[o + r1] += v1; d3[o + r2] += v2; d3[o + r3] += v3; }
      if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + r0] += v0; d4[o + r1] += v1; d4[o + r2] += v2; d4[o + r3] += v3; }
    }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += rowCount; kpiData[r0] += k0; kpiData[r1] += k1; kpiData[r2] += k2; kpiData[r3] += k3; }
}

function coIdx4Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, r0, r1, r2, r3, c0, c1, c2, c3, rowIndexes, rowCount) {
  var j, i, o, v0, v1, v2, v3, k0 = 0, k1 = 0, k2 = 0, k3 = 0, hasC = cOff >= 0;
  if (hasC && count === 5) {
    for (j = 0; j < rowCount; ++j) {
      i = rowIndexes[j];
      v0 = c0[i]; v1 = c1[i]; v2 = c2[i]; v3 = c3[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3;
      o = s0[i] * stride; d0[o + cOff] -= 1; d0[o + r0] -= v0; d0[o + r1] -= v1; d0[o + r2] -= v2; d0[o + r3] -= v3;
      o = s1[i] * stride; d1[o + cOff] -= 1; d1[o + r0] -= v0; d1[o + r1] -= v1; d1[o + r2] -= v2; d1[o + r3] -= v3;
      o = s2[i] * stride; d2[o + cOff] -= 1; d2[o + r0] -= v0; d2[o + r1] -= v1; d2[o + r2] -= v2; d2[o + r3] -= v3;
      o = s3[i] * stride; d3[o + cOff] -= 1; d3[o + r0] -= v0; d3[o + r1] -= v1; d3[o + r2] -= v2; d3[o + r3] -= v3;
      o = s4[i] * stride; d4[o + cOff] -= 1; d4[o + r0] -= v0; d4[o + r1] -= v1; d4[o + r2] -= v2; d4[o + r3] -= v3;
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      i = rowIndexes[j];
      v0 = c0[i]; v1 = c1[i]; v2 = c2[i]; v3 = c3[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3;
      o = s0[i] * stride; if (hasC) d0[o + cOff] -= 1; d0[o + r0] -= v0; d0[o + r1] -= v1; d0[o + r2] -= v2; d0[o + r3] -= v3;
      if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] -= 1; d1[o + r0] -= v0; d1[o + r1] -= v1; d1[o + r2] -= v2; d1[o + r3] -= v3; }
      if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] -= 1; d2[o + r0] -= v0; d2[o + r1] -= v1; d2[o + r2] -= v2; d2[o + r3] -= v3; }
      if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] -= 1; d3[o + r0] -= v0; d3[o + r1] -= v1; d3[o + r2] -= v2; d3[o + r3] -= v3; }
      if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] -= 1; d4[o + r0] -= v0; d4[o + r1] -= v1; d4[o + r2] -= v2; d4[o + r3] -= v3; }
    }
  }
  if (kpiData) { if (hasC) kpiData[cOff] -= rowCount; kpiData[r0] -= k0; kpiData[r1] -= k1; kpiData[r2] -= k2; kpiData[r3] -= k3; }
}

function coIdx5Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, t0, t1, t2, t3, t4, e0, e1, e2, e3, e4, rowIndexes, rowCount) {
  var j, i, o, v0, v1, v2, v3, v4, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0, hasC = cOff >= 0;
  if (hasC && count === 5) {
    for (j = 0; j < rowCount; ++j) {
      i = rowIndexes[j];
      v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4;
      o = s0[i] * stride; d0[o + cOff] += 1; d0[o + t0] += v0; d0[o + t1] += v1; d0[o + t2] += v2; d0[o + t3] += v3; d0[o + t4] += v4;
      o = s1[i] * stride; d1[o + cOff] += 1; d1[o + t0] += v0; d1[o + t1] += v1; d1[o + t2] += v2; d1[o + t3] += v3; d1[o + t4] += v4;
      o = s2[i] * stride; d2[o + cOff] += 1; d2[o + t0] += v0; d2[o + t1] += v1; d2[o + t2] += v2; d2[o + t3] += v3; d2[o + t4] += v4;
      o = s3[i] * stride; d3[o + cOff] += 1; d3[o + t0] += v0; d3[o + t1] += v1; d3[o + t2] += v2; d3[o + t3] += v3; d3[o + t4] += v4;
      o = s4[i] * stride; d4[o + cOff] += 1; d4[o + t0] += v0; d4[o + t1] += v1; d4[o + t2] += v2; d4[o + t3] += v3; d4[o + t4] += v4;
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      i = rowIndexes[j];
      v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4;
      o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + t0] += v0; d0[o + t1] += v1; d0[o + t2] += v2; d0[o + t3] += v3; d0[o + t4] += v4;
      if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + t0] += v0; d1[o + t1] += v1; d1[o + t2] += v2; d1[o + t3] += v3; d1[o + t4] += v4; }
      if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + t0] += v0; d2[o + t1] += v1; d2[o + t2] += v2; d2[o + t3] += v3; d2[o + t4] += v4; }
      if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + t0] += v0; d3[o + t1] += v1; d3[o + t2] += v2; d3[o + t3] += v3; d3[o + t4] += v4; }
      if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + t0] += v0; d4[o + t1] += v1; d4[o + t2] += v2; d4[o + t3] += v3; d4[o + t4] += v4; }
    }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += rowCount; kpiData[t0] += k0; kpiData[t1] += k1; kpiData[t2] += k2; kpiData[t3] += k3; kpiData[t4] += k4; }
}

function coIdx5Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, t0, t1, t2, t3, t4, e0, e1, e2, e3, e4, rowIndexes, rowCount) {
  var j, i, o, v0, v1, v2, v3, v4, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0, hasC = cOff >= 0;
  if (hasC && count === 5) {
    for (j = 0; j < rowCount; ++j) {
      i = rowIndexes[j];
      v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4;
      o = s0[i] * stride; d0[o + cOff] -= 1; d0[o + t0] -= v0; d0[o + t1] -= v1; d0[o + t2] -= v2; d0[o + t3] -= v3; d0[o + t4] -= v4;
      o = s1[i] * stride; d1[o + cOff] -= 1; d1[o + t0] -= v0; d1[o + t1] -= v1; d1[o + t2] -= v2; d1[o + t3] -= v3; d1[o + t4] -= v4;
      o = s2[i] * stride; d2[o + cOff] -= 1; d2[o + t0] -= v0; d2[o + t1] -= v1; d2[o + t2] -= v2; d2[o + t3] -= v3; d2[o + t4] -= v4;
      o = s3[i] * stride; d3[o + cOff] -= 1; d3[o + t0] -= v0; d3[o + t1] -= v1; d3[o + t2] -= v2; d3[o + t3] -= v3; d3[o + t4] -= v4;
      o = s4[i] * stride; d4[o + cOff] -= 1; d4[o + t0] -= v0; d4[o + t1] -= v1; d4[o + t2] -= v2; d4[o + t3] -= v3; d4[o + t4] -= v4;
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      i = rowIndexes[j];
      v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i];
      k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4;
      o = s0[i] * stride; if (hasC) d0[o + cOff] -= 1; d0[o + t0] -= v0; d0[o + t1] -= v1; d0[o + t2] -= v2; d0[o + t3] -= v3; d0[o + t4] -= v4;
      if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] -= 1; d1[o + t0] -= v0; d1[o + t1] -= v1; d1[o + t2] -= v2; d1[o + t3] -= v3; d1[o + t4] -= v4; }
      if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] -= 1; d2[o + t0] -= v0; d2[o + t1] -= v1; d2[o + t2] -= v2; d2[o + t3] -= v3; d2[o + t4] -= v4; }
      if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] -= 1; d3[o + t0] -= v0; d3[o + t1] -= v1; d3[o + t2] -= v2; d3[o + t3] -= v3; d3[o + t4] -= v4; }
      if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] -= 1; d4[o + t0] -= v0; d4[o + t1] -= v1; d4[o + t2] -= v2; d4[o + t3] -= v3; d4[o + t4] -= v4; }
    }
  }
  if (kpiData) { if (hasC) kpiData[cOff] -= rowCount; kpiData[t0] -= k0; kpiData[t1] -= k1; kpiData[t2] -= k2; kpiData[t3] -= k3; kpiData[t4] -= k4; }
}

function coIdx6Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, t0, t1, t2, t3, t4, t5, e0, e1, e2, e3, e4, e5, rowIndexes, rowCount) {
  var j, i, o, v0, v1, v2, v3, v4, v5, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0, hasC = cOff >= 0;
  for (j = 0; j < rowCount; ++j) {
    i = rowIndexes[j];
    v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i]; v5 = e5[i];
    k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4; k5 += v5;
    o = s0[i] * stride; if (hasC) d0[o + cOff] += 1; d0[o + t0] += v0; d0[o + t1] += v1; d0[o + t2] += v2; d0[o + t3] += v3; d0[o + t4] += v4; d0[o + t5] += v5;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] += 1; d1[o + t0] += v0; d1[o + t1] += v1; d1[o + t2] += v2; d1[o + t3] += v3; d1[o + t4] += v4; d1[o + t5] += v5; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] += 1; d2[o + t0] += v0; d2[o + t1] += v1; d2[o + t2] += v2; d2[o + t3] += v3; d2[o + t4] += v4; d2[o + t5] += v5; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] += 1; d3[o + t0] += v0; d3[o + t1] += v1; d3[o + t2] += v2; d3[o + t3] += v3; d3[o + t4] += v4; d3[o + t5] += v5; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] += 1; d4[o + t0] += v0; d4[o + t1] += v1; d4[o + t2] += v2; d4[o + t3] += v3; d4[o + t4] += v4; d4[o + t5] += v5; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] += rowCount; kpiData[t0] += k0; kpiData[t1] += k1; kpiData[t2] += k2; kpiData[t3] += k3; kpiData[t4] += k4; kpiData[t5] += k5; }
}

function coIdx6Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, t0, t1, t2, t3, t4, t5, e0, e1, e2, e3, e4, e5, rowIndexes, rowCount) {
  var j, i, o, v0, v1, v2, v3, v4, v5, k0 = 0, k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0, hasC = cOff >= 0;
  for (j = 0; j < rowCount; ++j) {
    i = rowIndexes[j];
    v0 = e0[i]; v1 = e1[i]; v2 = e2[i]; v3 = e3[i]; v4 = e4[i]; v5 = e5[i];
    k0 += v0; k1 += v1; k2 += v2; k3 += v3; k4 += v4; k5 += v5;
    o = s0[i] * stride; if (hasC) d0[o + cOff] -= 1; d0[o + t0] -= v0; d0[o + t1] -= v1; d0[o + t2] -= v2; d0[o + t3] -= v3; d0[o + t4] -= v4; d0[o + t5] -= v5;
    if (count > 1) { o = s1[i] * stride; if (hasC) d1[o + cOff] -= 1; d1[o + t0] -= v0; d1[o + t1] -= v1; d1[o + t2] -= v2; d1[o + t3] -= v3; d1[o + t4] -= v4; d1[o + t5] -= v5; }
    if (count > 2) { o = s2[i] * stride; if (hasC) d2[o + cOff] -= 1; d2[o + t0] -= v0; d2[o + t1] -= v1; d2[o + t2] -= v2; d2[o + t3] -= v3; d2[o + t4] -= v4; d2[o + t5] -= v5; }
    if (count > 3) { o = s3[i] * stride; if (hasC) d3[o + cOff] -= 1; d3[o + t0] -= v0; d3[o + t1] -= v1; d3[o + t2] -= v2; d3[o + t3] -= v3; d3[o + t4] -= v4; d3[o + t5] -= v5; }
    if (count > 4) { o = s4[i] * stride; if (hasC) d4[o + cOff] -= 1; d4[o + t0] -= v0; d4[o + t1] -= v1; d4[o + t2] -= v2; d4[o + t3] -= v3; d4[o + t4] -= v4; d4[o + t5] -= v5; }
  }
  if (kpiData) { if (hasC) kpiData[cOff] -= rowCount; kpiData[t0] -= k0; kpiData[t1] -= k1; kpiData[t2] -= k2; kpiData[t3] -= k3; kpiData[t4] -= k4; kpiData[t5] -= k5; }
}

function coScanRunIdx(targets, start, count, kpiData, stride, cOff, offs, cols, rowIndexes, rowCount, add) {
  var fLen = cols.length;
  var d0 = targets[start].buffers.data, s0 = targets[start].slotArr;
  var d1 = count > 1 ? targets[start + 1].buffers.data : null, s1 = count > 1 ? targets[start + 1].slotArr : null;
  var d2 = count > 2 ? targets[start + 2].buffers.data : null, s2 = count > 2 ? targets[start + 2].slotArr : null;
  var d3 = count > 3 ? targets[start + 3].buffers.data : null, s3 = count > 3 ? targets[start + 3].slotArr : null;
  var d4 = count > 4 ? targets[start + 4].buffers.data : null, s4 = count > 4 ? targets[start + 4].slotArr : null;

  if (fLen === 0 && cOff >= 0) {
    coIdx0(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, rowIndexes, rowCount, add ? 1 : -1);
  } else if (fLen === 1) {
    if (add) coIdx1Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], cols[0], rowIndexes, rowCount);
    else coIdx1Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], cols[0], rowIndexes, rowCount);
  } else if (fLen === 2) {
    if (add) coIdx2Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], cols[0], cols[1], rowIndexes, rowCount);
    else coIdx2Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], cols[0], cols[1], rowIndexes, rowCount);
  } else if (fLen === 3) {
    if (add) coIdx3Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], cols[0], cols[1], cols[2], rowIndexes, rowCount);
    else coIdx3Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], cols[0], cols[1], cols[2], rowIndexes, rowCount);
  } else if (fLen === 4) {
    if (add) coIdx4Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], cols[0], cols[1], cols[2], cols[3], rowIndexes, rowCount);
    else coIdx4Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], cols[0], cols[1], cols[2], cols[3], rowIndexes, rowCount);
  } else if (fLen === 5) {
    if (add) coIdx5Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], cols[0], cols[1], cols[2], cols[3], cols[4], rowIndexes, rowCount);
    else coIdx5Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], cols[0], cols[1], cols[2], cols[3], cols[4], rowIndexes, rowCount);
  } else if (fLen === 6) {
    if (add) coIdx6Add(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], offs[5], cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], rowIndexes, rowCount);
    else coIdx6Sub(d0, s0, d1, s1, d2, s2, d3, s3, d4, s4, count, kpiData, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], offs[5], cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], rowIndexes, rowCount);
  }
}

function reduceMultiGroupsAll(targets, kpiBuffers, plan, getNumericColumn, n) {
  var cols = resolveFastColumns(plan, getNumericColumn);
  var i;
  if (!cols) {
    for (i = 0; i < targets.length; ++i) {
      reduceGroupedAll(targets[i].buffers, plan, getNumericColumn, targets[i].slotArr, n, targets[i].slotCount);
    }
    if (kpiBuffers) {
      reduceScalarAll(kpiBuffers, plan, getNumericColumn, n);
    }
    return;
  }
  var stride = plan.stride;
  var cOff = plan.fastCountOff;
  var offs = plan.sumFieldOffs;
  var extra = plan.extraAvgOffs;
  var kpiData = kpiBuffers ? kpiBuffers.data : null;
  var pos = 0;
  var total = targets.length;
  while (pos < total) {
    var chunk = total - pos;
    if (chunk > 5) chunk = 5;
    coScanRunAll(targets, pos, chunk, pos === 0 ? kpiData : null, stride, cOff, offs, cols, n);
    pos += chunk;
  }
  if (extra.length > 0) {
    for (i = 0; i < total; ++i) {
      mirrorExtraAvgCounts(targets[i].buffers.data, stride, targets[i].slotCount, cOff, extra);
    }
    if (kpiData) {
      mirrorExtraAvgCounts(kpiData, stride, 1, cOff, extra);
    }
  }
}

function reduceMultiGroupsIndexed(targets, kpiBuffers, plan, getNumericColumn, rowIndexes, rowCount, delta) {
  if (!rowCount) return;
  var cols = resolveFastColumns(plan, getNumericColumn);
  var i;
  if (!cols) {
    for (i = 0; i < targets.length; ++i) {
      reduceGroupedIndexed(targets[i].buffers, plan, getNumericColumn, targets[i].slotArr, rowIndexes, rowCount, delta, targets[i].slotCount);
    }
    if (kpiBuffers) {
      reduceScalarIndexed(kpiBuffers, plan, getNumericColumn, rowIndexes, rowCount, delta);
    }
    return;
  }
  var stride = plan.stride;
  var cOff = plan.fastCountOff;
  var offs = plan.sumFieldOffs;
  var extra = plan.extraAvgOffs;
  var add = delta > 0;
  var kpiData = kpiBuffers ? kpiBuffers.data : null;
  var pos = 0;
  var total = targets.length;
  while (pos < total) {
    var chunk = total - pos;
    if (chunk > 5) chunk = 5;
    coScanRunIdx(targets, pos, chunk, pos === 0 ? kpiData : null, stride, cOff, offs, cols, rowIndexes, rowCount, add);
    pos += chunk;
  }
  if (extra.length > 0) {
    for (i = 0; i < total; ++i) {
      mirrorExtraAvgCounts(targets[i].buffers.data, stride, targets[i].slotCount, cOff, extra);
    }
    if (kpiData) {
      mirrorExtraAvgCounts(kpiData, stride, 1, cOff, extra);
    }
  }
}

// ============================================================================
// Public single-group & scalar dispatchers
// ============================================================================

function reduceGroupedAll(buffers, plan, getNumericColumn, groupIds, n, slotCount) {
  if (!n) return;
  var data = buffers.data;
  var stride = plan.stride;
  var cols = resolveFastColumns(plan, getNumericColumn);
  if (cols) {
    var cOff = plan.fastCountOff;
    var offs = plan.sumFieldOffs;
    var fLen = cols.length;
    if (fLen === 0 && cOff >= 0) {
      aoCountAll(data, stride, cOff, groupIds, n);
    } else if (fLen === 1) {
      ao1All(data, stride, cOff, offs[0], groupIds, cols[0], n);
    } else if (fLen === 2) {
      ao2All(data, stride, cOff, offs[0], offs[1], groupIds, cols[0], cols[1], n);
    } else if (fLen === 3) {
      ao3All(data, stride, cOff, offs[0], offs[1], offs[2], groupIds, cols[0], cols[1], cols[2], n);
    } else if (fLen === 4) {
      ao4All(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], groupIds, cols[0], cols[1], cols[2], cols[3], n);
    } else if (fLen === 5) {
      ao5All(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], groupIds, cols[0], cols[1], cols[2], cols[3], cols[4], n);
    } else if (fLen === 6) {
      ao6All(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], offs[5], groupIds, cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], n);
    }
    if (plan.extraAvgOffs.length > 0) {
      mirrorExtraAvgCounts(data, stride, slotCount, cOff, plan.extraAvgOffs);
    }
    return;
  }
  aoGeneralAll(data, stride, plan, getNumericColumn, groupIds, n);
}

function reduceGroupedIndexed(buffers, plan, getNumericColumn, groupIds, rowIndexes, rowCount, delta, slotCount) {
  if (!rowCount) return;
  var data = buffers.data;
  var stride = plan.stride;
  var add = delta > 0;
  var cols = resolveFastColumns(plan, getNumericColumn);
  if (cols) {
    var cOff = plan.fastCountOff;
    var offs = plan.sumFieldOffs;
    var fLen = cols.length;
    if (fLen === 0 && cOff >= 0) {
      aoCountIdx(data, stride, cOff, groupIds, rowIndexes, rowCount, add);
    } else if (fLen === 1) {
      ao1Idx(data, stride, cOff, offs[0], groupIds, cols[0], rowIndexes, rowCount, add);
    } else if (fLen === 2) {
      ao2Idx(data, stride, cOff, offs[0], offs[1], groupIds, cols[0], cols[1], rowIndexes, rowCount, add);
    } else if (fLen === 3) {
      ao3Idx(data, stride, cOff, offs[0], offs[1], offs[2], groupIds, cols[0], cols[1], cols[2], rowIndexes, rowCount, add);
    } else if (fLen === 4) {
      ao4Idx(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], groupIds, cols[0], cols[1], cols[2], cols[3], rowIndexes, rowCount, add);
    } else if (fLen === 5) {
      ao5Idx(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], groupIds, cols[0], cols[1], cols[2], cols[3], cols[4], rowIndexes, rowCount, add);
    } else if (fLen === 6) {
      ao6Idx(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], offs[5], groupIds, cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], rowIndexes, rowCount, add);
    }
    if (plan.extraAvgOffs.length > 0) {
      var capSlots = slotCount > 0 ? slotCount : buffers.capacity;
      mirrorExtraAvgCounts(data, stride, capSlots, cOff, plan.extraAvgOffs);
    }
    return;
  }
  aoGeneralIdx(data, stride, plan, getNumericColumn, groupIds, rowIndexes, rowCount, add);
}

function reduceSplitDenseAll(buffers, plan, getNumericColumn, primarySlotArr, splitCodes, splitStride, n, totalSlots) {
  if (!n || !splitStride) return;
  var data = buffers.data;
  var stride = plan.stride;
  var cols = resolveFastColumns(plan, getNumericColumn);
  if (cols) {
    var cOff = plan.fastCountOff;
    var offs = plan.sumFieldOffs;
    var fLen = cols.length;
    if (fLen === 0 && cOff >= 0) {
      for (var i = 0; i < n; ++i) data[(primarySlotArr[i] * splitStride + splitCodes[i]) * stride + cOff] += 1;
    } else if (fLen === 1) {
      sd1All(data, stride, cOff, offs[0], primarySlotArr, splitCodes, splitStride, cols[0], n);
    } else if (fLen === 2) {
      sd2All(data, stride, cOff, offs[0], offs[1], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], n);
    } else if (fLen === 3) {
      sd3All(data, stride, cOff, offs[0], offs[1], offs[2], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], cols[2], n);
    } else if (fLen === 4) {
      sd4All(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], cols[2], cols[3], n);
    } else if (fLen === 5) {
      sd5All(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], cols[2], cols[3], cols[4], n);
    } else if (fLen === 6) {
      sd6All(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], offs[5], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], n);
    }
    if (plan.extraAvgOffs.length > 0) {
      mirrorExtraAvgCounts(data, stride, totalSlots, cOff, plan.extraAvgOffs);
    }
    return;
  }
  sdGeneralAll(data, stride, plan, getNumericColumn, primarySlotArr, splitCodes, splitStride, n);
}

function reduceSplitDenseIndexed(buffers, plan, getNumericColumn, primarySlotArr, splitCodes, splitStride, rowIndexes, rowCount, delta, totalSlots) {
  if (!rowCount || !splitStride) return;
  var data = buffers.data;
  var stride = plan.stride;
  var add = delta > 0;
  var cols = resolveFastColumns(plan, getNumericColumn);
  if (cols) {
    var cOff = plan.fastCountOff;
    var offs = plan.sumFieldOffs;
    var fLen = cols.length;
    if (fLen === 0 && cOff >= 0) {
      var sign = add ? 1 : -1;
      for (var j = 0; j < rowCount; ++j) {
        var idx = rowIndexes[j];
        data[(primarySlotArr[idx] * splitStride + splitCodes[idx]) * stride + cOff] += sign;
      }
    } else if (fLen === 1) {
      sd1Idx(data, stride, cOff, offs[0], primarySlotArr, splitCodes, splitStride, cols[0], rowIndexes, rowCount, add);
    } else if (fLen === 2) {
      sd2Idx(data, stride, cOff, offs[0], offs[1], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], rowIndexes, rowCount, add);
    } else if (fLen === 3) {
      sd3Idx(data, stride, cOff, offs[0], offs[1], offs[2], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], cols[2], rowIndexes, rowCount, add);
    } else if (fLen === 4) {
      sd4Idx(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], cols[2], cols[3], rowIndexes, rowCount, add);
    } else if (fLen === 5) {
      sd5Idx(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], cols[2], cols[3], cols[4], rowIndexes, rowCount, add);
    } else if (fLen === 6) {
      sd6Idx(data, stride, cOff, offs[0], offs[1], offs[2], offs[3], offs[4], offs[5], primarySlotArr, splitCodes, splitStride, cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], rowIndexes, rowCount, add);
    }
    if (plan.extraAvgOffs.length > 0) {
      var capSlots = totalSlots > 0 ? totalSlots : buffers.capacity;
      mirrorExtraAvgCounts(data, stride, capSlots, cOff, plan.extraAvgOffs);
    }
    return;
  }
  sdGeneralIdx(data, stride, plan, getNumericColumn, primarySlotArr, splitCodes, splitStride, rowIndexes, rowCount, add);
}

// ============================================================================
// Scalar (KPI) reductions into slot 0 of buffers.data
// ============================================================================

function reduceScalarAll(buffers, plan, getNumericColumn, n) {
  if (!n) return;
  var data = buffers.data;
  var i, f, col, vals, hasNaN, v, s, s2;
  if (plan.countOffset >= 0) {
    data[plan.countOffset] += n;
  }
  var sumFields = plan.sumFields;
  var sumFieldOffs = plan.sumFieldOffs;
  var sumFieldAvgOffs = plan.sumFieldAvgOffs;
  for (f = 0; f < sumFields.length; ++f) {
    col = getNumericColumn(sumFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    s = 0;
    s2 = 0;
    if (!hasNaN) {
      for (i = 0; i < n; ++i) s += vals[i];
      s2 = n;
    } else {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v === v) { s += v; s2 += 1; }
      }
    }
    data[sumFieldOffs[f]] += s;
    if (sumFieldAvgOffs[f] >= 0) data[sumFieldAvgOffs[f]] += s2;
  }
  var avgNzFields = plan.avgNzFields;
  var avgNzPrimOffs = plan.avgNzPrimOffs;
  var avgNzSecOffs = plan.avgNzSecOffs;
  for (f = 0; f < avgNzFields.length; ++f) {
    col = getNumericColumn(avgNzFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    s = 0;
    s2 = 0;
    if (!hasNaN) {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v !== 0) { s += v; s2 += 1; }
      }
    } else {
      for (i = 0; i < n; ++i) {
        v = vals[i];
        if (v === v && v !== 0) { s += v; s2 += 1; }
      }
    }
    data[avgNzPrimOffs[f]] += s;
    data[avgNzSecOffs[f]] += s2;
  }
}

function reduceScalarIndexed(buffers, plan, getNumericColumn, rowIndexes, rowCount, delta) {
  if (!rowCount) return;
  var data = buffers.data;
  var sign = delta > 0 ? 1 : -1;
  var j, f, col, vals, hasNaN, v, s, s2;
  if (plan.countOffset >= 0) {
    data[plan.countOffset] += sign * rowCount;
  }
  var sumFields = plan.sumFields;
  var sumFieldOffs = plan.sumFieldOffs;
  var sumFieldAvgOffs = plan.sumFieldAvgOffs;
  for (f = 0; f < sumFields.length; ++f) {
    col = getNumericColumn(sumFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    s = 0;
    s2 = 0;
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) s += vals[rowIndexes[j]];
      s2 = rowCount;
    } else {
      for (j = 0; j < rowCount; ++j) {
        v = vals[rowIndexes[j]];
        if (v === v) { s += v; s2 += 1; }
      }
    }
    data[sumFieldOffs[f]] += sign * s;
    if (sumFieldAvgOffs[f] >= 0) data[sumFieldAvgOffs[f]] += sign * s2;
  }
  var avgNzFields = plan.avgNzFields;
  var avgNzPrimOffs = plan.avgNzPrimOffs;
  var avgNzSecOffs = plan.avgNzSecOffs;
  for (f = 0; f < avgNzFields.length; ++f) {
    col = getNumericColumn(avgNzFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    s = 0;
    s2 = 0;
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        v = vals[rowIndexes[j]];
        if (v !== 0) { s += v; s2 += 1; }
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        v = vals[rowIndexes[j]];
        if (v === v && v !== 0) { s += v; s2 += 1; }
      }
    }
    data[avgNzPrimOffs[f]] += sign * s;
    data[avgNzSecOffs[f]] += sign * s2;
  }
}

// ============================================================================
// Complement subtraction exact empty-slot cleanup (eliminates FP dust!)
// ============================================================================

function cleanupComplementEmptySlots(buffers, plan, exactCountOff, slotArr, splitCodes, splitStride, trackedCounts, tmpCounts, rowIndexes, rowCount, totalSlots) {
  var data = buffers.data;
  var stride = plan.stride;
  var cOff = exactCountOff >= 0 ? exactCountOff : plan.countOffset;
  var j, idx, slot, base, k;

  if (cOff >= 0) {
    if (splitCodes) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        slot = slotArr[idx] * splitStride + splitCodes[idx];
        base = slot * stride;
        if (data[base + cOff] <= 0) {
          for (k = 0; k < stride; ++k) data[base + k] = 0;
        }
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        slot = slotArr[rowIndexes[j]];
        base = slot * stride;
        if (data[base + cOff] <= 0) {
          for (k = 0; k < stride; ++k) data[base + k] = 0;
        }
      }
    }
    return;
  }

  if (!trackedCounts || !tmpCounts) return;
  tmpCounts.set(trackedCounts.subarray(0, totalSlots));
  if (splitCodes) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      slot = slotArr[idx] * splitStride + splitCodes[idx];
      if (--tmpCounts[slot] === 0) {
        base = slot * stride;
        for (k = 0; k < stride; ++k) data[base + k] = 0;
      }
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      slot = slotArr[rowIndexes[j]];
      if (--tmpCounts[slot] === 0) {
        base = slot * stride;
        for (k = 0; k < stride; ++k) data[base + k] = 0;
      }
    }
  }
}

// ============================================================================
// Slot materialization & visibility helpers (interleaved AoS reads)
// ============================================================================

function writeMetricSlotToState(state, plan, buffers, slot) {
  var ops = plan.ops;
  var ids = plan.ids;
  var primOff = plan.primOff;
  var secOff = plan.secOff;
  var data = buffers.data;
  var base = slot * buffers.stride;
  var isEmpty = plan.countOffset >= 0 && data[base + plan.countOffset] <= 0;
  var m, op, id, sub;

  for (m = 0; m < plan.count; ++m) {
    op = ops[m];
    id = ids[m];
    if (op === OP_AVG || op === OP_AVG_NON_ZERO) {
      sub = state[id];
      if (!sub) {
        state[id] = { count: isEmpty ? 0 : data[base + secOff[m]], sum: isEmpty ? 0 : data[base + primOff[m]] };
      } else {
        sub.sum = isEmpty ? 0 : data[base + primOff[m]];
        sub.count = isEmpty ? 0 : data[base + secOff[m]];
      }
    } else if (op === OP_RATIO) {
      sub = state[id];
      if (!sub) {
        state[id] = { den: isEmpty ? 0 : data[base + secOff[m]], num: isEmpty ? 0 : data[base + primOff[m]] };
      } else {
        sub.num = isEmpty ? 0 : data[base + primOff[m]];
        sub.den = isEmpty ? 0 : data[base + secOff[m]];
      }
    } else {
      state[id] = isEmpty ? 0 : data[base + primOff[m]];
    }
  }
  if (state.__version !== undefined) {
    state.__version += 1;
  }
}

function finalizeMetricSlot(plan, buffers, slot) {
  var ops = plan.ops;
  var ids = plan.ids;
  var hidden = plan.hidden;
  var primOff = plan.primOff;
  var secOff = plan.secOff;
  var data = buffers.data;
  var base = slot * buffers.stride;
  var isEmpty = plan.countOffset >= 0 && data[base + plan.countOffset] <= 0;
  var result = {};
  var m, op, denom;

  if (isEmpty) {
    for (m = 0; m < plan.count; ++m) {
      if (hidden[m]) continue;
      op = ops[m];
      result[ids[m]] = (op === OP_AVG || op === OP_AVG_NON_ZERO || op === OP_RATIO) ? null : 0;
    }
    return result;
  }

  for (m = 0; m < plan.count; ++m) {
    if (hidden[m]) continue;
    op = ops[m];
    if (op === OP_AVG || op === OP_AVG_NON_ZERO) {
      denom = data[base + secOff[m]];
      result[ids[m]] = denom ? data[base + primOff[m]] / denom : null;
    } else if (op === OP_RATIO) {
      denom = data[base + secOff[m]];
      result[ids[m]] = denom !== 0 ? data[base + primOff[m]] / denom : null;
    } else {
      result[ids[m]] = data[base + primOff[m]];
    }
  }
  return result;
}

function slotHasAnyActivity(plan, buffers, slot) {
  var data = buffers.data;
  var base = slot * buffers.stride;
  if (plan.countOffset >= 0) {
    return data[base + plan.countOffset] > 0;
  }
  var ops = plan.ops;
  var primOff = plan.primOff;
  var secOff = plan.secOff;
  var m, op;

  for (m = 0; m < plan.count; ++m) {
    op = ops[m];
    if (op === OP_COUNT) {
      if (data[base + primOff[m]] > 0) return true;
    } else if (op === OP_AVG || op === OP_AVG_NON_ZERO) {
      if (data[base + secOff[m]] > 0) return true;
    } else if (op === OP_RATIO) {
      if (data[base + primOff[m]] !== 0 || data[base + secOff[m]] !== 0) return true;
    } else {
      if (data[base + primOff[m]] !== 0) return true;
    }
  }
  return false;
}

// Falcon-style active-dimension prefix-sum brush cache.

var MAX_DISCRETE_BINS = 2048;
var CONTINUOUS_BINS = 256;
var MAX_CUBE_DOUBLES = 262144; // 2 MB cap per chart cube

function bisectLeftNumeric(arr, len, target) {
  var lo = 0, hi = len, mid;
  while (lo < hi) {
    mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bisectLeftString(arr, len, target) {
  var lo = 0, hi = len, mid;
  while (lo < hi) {
    mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findContinuousBin(splitters, splitCount, v) {
  var lo = 0, hi = splitCount, mid;
  while (lo < hi) {
    mid = (lo + hi) >>> 1;
    if (v < splitters[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function accumulateRowsIntoCube(cube, binCount, slotCount, stride, plan, getNumericColumn, slotArr, rowIndices, rowBins, baseCount) {
  var sumFields = plan.sumFields;
  var sumFieldOffs = plan.sumFieldOffs;
  var sumFieldAvgOffs = plan.sumFieldAvgOffs;
  var avgNzFields = plan.avgNzFields;
  var avgNzPrimOffs = plan.avgNzPrimOffs;
  var avgNzSecOffs = plan.avgNzSecOffs;
  var cOff = plan.countOffset;
  var j, row, bin, s, o, f, col, vals, hasNaN, v, off, avgOff, pOff, sOff;

  // Fast fused path for <= 4 finite sum fields and no avgNonZero
  if (avgNzFields.length === 0 && sumFields.length <= 4) {
    var fLen = sumFields.length;
    var cols = new Array(fLen);
    var allFinite = true;
    for (f = 0; f < fLen; ++f) {
      col = getNumericColumn(sumFields[f]);
      if (col.hasNaN) { allFinite = false; break; }
      cols[f] = col.values;
    }
    if (allFinite) {
      var fastCOff = plan.fastCountOff;
      var hasC = fastCOff >= 0;
      if (fLen === 0 && hasC) {
        for (j = 0; j < baseCount; ++j) {
          row = rowIndices ? rowIndices[j] : j;
          bin = rowBins[j];
          s = slotArr ? slotArr[row] : 0;
          cube[((bin + 1) * slotCount + s) * stride + fastCOff] += 1;
        }
      } else if (fLen === 1) {
        var c0 = cols[0], o0 = sumFieldOffs[0];
        for (j = 0; j < baseCount; ++j) {
          row = rowIndices ? rowIndices[j] : j;
          bin = rowBins[j];
          s = slotArr ? slotArr[row] : 0;
          o = ((bin + 1) * slotCount + s) * stride;
          if (hasC) cube[o + fastCOff] += 1;
          cube[o + o0] += c0[row];
        }
      } else if (fLen === 2) {
        var a0 = cols[0], a1 = cols[1], p0 = sumFieldOffs[0], p1 = sumFieldOffs[1];
        for (j = 0; j < baseCount; ++j) {
          row = rowIndices ? rowIndices[j] : j;
          bin = rowBins[j];
          s = slotArr ? slotArr[row] : 0;
          o = ((bin + 1) * slotCount + s) * stride;
          if (hasC) cube[o + fastCOff] += 1;
          cube[o + p0] += a0[row];
          cube[o + p1] += a1[row];
        }
      } else if (fLen === 3) {
        var b0 = cols[0], b1 = cols[1], b2 = cols[2], q0 = sumFieldOffs[0], q1 = sumFieldOffs[1], q2 = sumFieldOffs[2];
        for (j = 0; j < baseCount; ++j) {
          row = rowIndices ? rowIndices[j] : j;
          bin = rowBins[j];
          s = slotArr ? slotArr[row] : 0;
          o = ((bin + 1) * slotCount + s) * stride;
          if (hasC) cube[o + fastCOff] += 1;
          cube[o + q0] += b0[row];
          cube[o + q1] += b1[row];
          cube[o + q2] += b2[row];
        }
      } else {
        var d0 = cols[0], d1 = cols[1], d2 = cols[2], d3 = cols[3];
        var r0 = sumFieldOffs[0], r1 = sumFieldOffs[1], r2 = sumFieldOffs[2], r3 = sumFieldOffs[3];
        for (j = 0; j < baseCount; ++j) {
          row = rowIndices ? rowIndices[j] : j;
          bin = rowBins[j];
          s = slotArr ? slotArr[row] : 0;
          o = ((bin + 1) * slotCount + s) * stride;
          if (hasC) cube[o + fastCOff] += 1;
          cube[o + r0] += d0[row];
          cube[o + r1] += d1[row];
          cube[o + r2] += d2[row];
          cube[o + r3] += d3[row];
        }
      }
      if (plan.extraAvgOffs.length > 0 && hasC) {
        var extra = plan.extraAvgOffs;
        var totalCells = (binCount + 1) * slotCount;
        for (var ci = 0, cb = 0; ci < totalCells; ++ci, cb += stride) {
          var cv = cube[cb + fastCOff];
          for (var ei = 0; ei < extra.length; ++ei) cube[cb + extra[ei]] = cv;
        }
      }
      return;
    }
  }

  // General fallback (NaN / avgNonZero / >4 fields)
  if (cOff >= 0) {
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      bin = rowBins[j];
      s = slotArr ? slotArr[row] : 0;
      cube[((bin + 1) * slotCount + s) * stride + cOff] += 1;
    }
  }
  for (f = 0; f < sumFields.length; ++f) {
    col = getNumericColumn(sumFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    off = sumFieldOffs[f];
    avgOff = sumFieldAvgOffs[f];
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      v = vals[row];
      if (!hasNaN || v === v) {
        bin = rowBins[j];
        s = slotArr ? slotArr[row] : 0;
        o = ((bin + 1) * slotCount + s) * stride;
        cube[o + off] += v;
        if (avgOff >= 0) cube[o + avgOff] += 1;
      }
    }
  }
  for (f = 0; f < avgNzFields.length; ++f) {
    col = getNumericColumn(avgNzFields[f]);
    vals = col.values;
    hasNaN = col.hasNaN;
    pOff = avgNzPrimOffs[f];
    sOff = avgNzSecOffs[f];
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      v = vals[row];
      if ((!hasNaN || v === v) && v !== 0) {
        bin = rowBins[j];
        s = slotArr ? slotArr[row] : 0;
        o = ((bin + 1) * slotCount + s) * stride;
        cube[o + pOff] += v;
        cube[o + sOff] += 1;
      }
    }
  }
}

function prefixSumCube(cube, binCount, rowStride) {
  var b, k, cur, prev;
  for (b = 1; b <= binCount; ++b) {
    cur = b * rowStride;
    prev = cur - rowStride;
    for (k = 0; k < rowStride; ++k) {
      cube[cur + k] += cube[prev + k];
    }
  }
}

function prefixSumUint32(arr, binCount, slotCount) {
  var b, s, cur, prev;
  for (b = 1; b <= binCount; ++b) {
    cur = b * slotCount;
    prev = cur - slotCount;
    for (s = 0; s < slotCount; ++s) {
      arr[cur + s] += arr[prev + s];
    }
  }
}

// Fast fused multi-cube build for groups sharing the exact same finite <=4-field plan!
function buildSharedCubesPass(cubeEntries, kpiCube, plan, getNumericColumn, rowIndices, rowBins, baseCount) {
  var fLen = plan.sumFields.length;
  var cols = new Array(fLen);
  for (var f = 0; f < fLen; ++f) {
    var col = getNumericColumn(plan.sumFields[f]);
    if (col.hasNaN) return false;
    cols[f] = col.values;
  }
  var stride = plan.stride;
  var cOff = plan.fastCountOff;
  var hasC = cOff >= 0;
  var offs = plan.sumFieldOffs;
  var count = cubeEntries.length;
  var cb0 = count > 0 ? cubeEntries[0].cube : null, s0 = count > 0 ? cubeEntries[0].slotArr : null, S0 = count > 0 ? cubeEntries[0].slotCount : 0;
  var cb1 = count > 1 ? cubeEntries[1].cube : null, s1 = count > 1 ? cubeEntries[1].slotArr : null, S1 = count > 1 ? cubeEntries[1].slotCount : 0;
  var cb2 = count > 2 ? cubeEntries[2].cube : null, s2 = count > 2 ? cubeEntries[2].slotArr : null, S2 = count > 2 ? cubeEntries[2].slotCount : 0;
  var cb3 = count > 3 ? cubeEntries[3].cube : null, s3 = count > 3 ? cubeEntries[3].slotArr : null, S3 = count > 3 ? cubeEntries[3].slotCount : 0;
  var cb4 = count > 4 ? cubeEntries[4].cube : null, s4 = count > 4 ? cubeEntries[4].slotArr : null, S4 = count > 4 ? cubeEntries[4].slotCount : 0;
  var j, row, bin1, o, v0, v1, v2, v3;

  if (fLen === 4) {
    var d0 = cols[0], d1 = cols[1], d2 = cols[2], d3 = cols[3];
    var r0 = offs[0], r1 = offs[1], r2 = offs[2], r3 = offs[3];
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      bin1 = rowBins[j] + 1;
      v0 = d0[row]; v1 = d1[row]; v2 = d2[row]; v3 = d3[row];
      if (kpiCube) {
        o = bin1 * stride;
        if (hasC) kpiCube[o + cOff] += 1;
        kpiCube[o + r0] += v0; kpiCube[o + r1] += v1; kpiCube[o + r2] += v2; kpiCube[o + r3] += v3;
      }
      if (count > 0) { o = (bin1 * S0 + s0[row]) * stride; if (hasC) cb0[o + cOff] += 1; cb0[o + r0] += v0; cb0[o + r1] += v1; cb0[o + r2] += v2; cb0[o + r3] += v3; }
      if (count > 1) { o = (bin1 * S1 + s1[row]) * stride; if (hasC) cb1[o + cOff] += 1; cb1[o + r0] += v0; cb1[o + r1] += v1; cb1[o + r2] += v2; cb1[o + r3] += v3; }
      if (count > 2) { o = (bin1 * S2 + s2[row]) * stride; if (hasC) cb2[o + cOff] += 1; cb2[o + r0] += v0; cb2[o + r1] += v1; cb2[o + r2] += v2; cb2[o + r3] += v3; }
      if (count > 3) { o = (bin1 * S3 + s3[row]) * stride; if (hasC) cb3[o + cOff] += 1; cb3[o + r0] += v0; cb3[o + r1] += v1; cb3[o + r2] += v2; cb3[o + r3] += v3; }
      if (count > 4) { o = (bin1 * S4 + s4[row]) * stride; if (hasC) cb4[o + cOff] += 1; cb4[o + r0] += v0; cb4[o + r1] += v1; cb4[o + r2] += v2; cb4[o + r3] += v3; }
    }
    return true;
  }

  if (fLen === 1) {
    var c0 = cols[0], o0 = offs[0];
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      bin1 = rowBins[j] + 1;
      v0 = c0[row];
      if (kpiCube) { o = bin1 * stride; if (hasC) kpiCube[o + cOff] += 1; kpiCube[o + o0] += v0; }
      if (count > 0) { o = (bin1 * S0 + s0[row]) * stride; if (hasC) cb0[o + cOff] += 1; cb0[o + o0] += v0; }
      if (count > 1) { o = (bin1 * S1 + s1[row]) * stride; if (hasC) cb1[o + cOff] += 1; cb1[o + o0] += v0; }
      if (count > 2) { o = (bin1 * S2 + s2[row]) * stride; if (hasC) cb2[o + cOff] += 1; cb2[o + o0] += v0; }
      if (count > 3) { o = (bin1 * S3 + s3[row]) * stride; if (hasC) cb3[o + cOff] += 1; cb3[o + o0] += v0; }
      if (count > 4) { o = (bin1 * S4 + s4[row]) * stride; if (hasC) cb4[o + cOff] += 1; cb4[o + o0] += v0; }
    }
    return true;
  }

  if (fLen === 2) {
    var a0 = cols[0], a1 = cols[1], p0 = offs[0], p1 = offs[1];
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      bin1 = rowBins[j] + 1;
      v0 = a0[row]; v1 = a1[row];
      if (kpiCube) { o = bin1 * stride; if (hasC) kpiCube[o + cOff] += 1; kpiCube[o + p0] += v0; kpiCube[o + p1] += v1; }
      if (count > 0) { o = (bin1 * S0 + s0[row]) * stride; if (hasC) cb0[o + cOff] += 1; cb0[o + p0] += v0; cb0[o + p1] += v1; }
      if (count > 1) { o = (bin1 * S1 + s1[row]) * stride; if (hasC) cb1[o + cOff] += 1; cb1[o + p0] += v0; cb1[o + p1] += v1; }
      if (count > 2) { o = (bin1 * S2 + s2[row]) * stride; if (hasC) cb2[o + cOff] += 1; cb2[o + p0] += v0; cb2[o + p1] += v1; }
      if (count > 3) { o = (bin1 * S3 + s3[row]) * stride; if (hasC) cb3[o + cOff] += 1; cb3[o + p0] += v0; cb3[o + p1] += v1; }
      if (count > 4) { o = (bin1 * S4 + s4[row]) * stride; if (hasC) cb4[o + cOff] += 1; cb4[o + p0] += v0; cb4[o + p1] += v1; }
    }
    return true;
  }

  if (fLen === 3) {
    var b0 = cols[0], b1 = cols[1], b2 = cols[2], q0 = offs[0], q1 = offs[1], q2 = offs[2];
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      bin1 = rowBins[j] + 1;
      v0 = b0[row]; v1 = b1[row]; v2 = b2[row];
      if (kpiCube) { o = bin1 * stride; if (hasC) kpiCube[o + cOff] += 1; kpiCube[o + q0] += v0; kpiCube[o + q1] += v1; kpiCube[o + q2] += v2; }
      if (count > 0) { o = (bin1 * S0 + s0[row]) * stride; if (hasC) cb0[o + cOff] += 1; cb0[o + q0] += v0; cb0[o + q1] += v1; cb0[o + q2] += v2; }
      if (count > 1) { o = (bin1 * S1 + s1[row]) * stride; if (hasC) cb1[o + cOff] += 1; cb1[o + q0] += v0; cb1[o + q1] += v1; cb1[o + q2] += v2; }
      if (count > 2) { o = (bin1 * S2 + s2[row]) * stride; if (hasC) cb2[o + cOff] += 1; cb2[o + q0] += v0; cb2[o + q1] += v1; cb2[o + q2] += v2; }
      if (count > 3) { o = (bin1 * S3 + s3[row]) * stride; if (hasC) cb3[o + cOff] += 1; cb3[o + q0] += v0; cb3[o + q1] += v1; cb3[o + q2] += v2; }
      if (count > 4) { o = (bin1 * S4 + s4[row]) * stride; if (hasC) cb4[o + cOff] += 1; cb4[o + q0] += v0; cb4[o + q1] += v1; cb4[o + q2] += v2; }
    }
    return true;
  }

  if (fLen === 5) {
    var e0 = cols[0], e1 = cols[1], e2 = cols[2], e3 = cols[3], e4 = cols[4];
    var t0 = offs[0], t1 = offs[1], t2 = offs[2], t3 = offs[3], t4 = offs[4];
    var v4;
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      bin1 = rowBins[j] + 1;
      v0 = e0[row]; v1 = e1[row]; v2 = e2[row]; v3 = e3[row]; v4 = e4[row];
      if (kpiCube) { o = bin1 * stride; if (hasC) kpiCube[o + cOff] += 1; kpiCube[o + t0] += v0; kpiCube[o + t1] += v1; kpiCube[o + t2] += v2; kpiCube[o + t3] += v3; kpiCube[o + t4] += v4; }
      if (count > 0) { o = (bin1 * S0 + s0[row]) * stride; if (hasC) cb0[o + cOff] += 1; cb0[o + t0] += v0; cb0[o + t1] += v1; cb0[o + t2] += v2; cb0[o + t3] += v3; cb0[o + t4] += v4; }
      if (count > 1) { o = (bin1 * S1 + s1[row]) * stride; if (hasC) cb1[o + cOff] += 1; cb1[o + t0] += v0; cb1[o + t1] += v1; cb1[o + t2] += v2; cb1[o + t3] += v3; cb1[o + t4] += v4; }
      if (count > 2) { o = (bin1 * S2 + s2[row]) * stride; if (hasC) cb2[o + cOff] += 1; cb2[o + t0] += v0; cb2[o + t1] += v1; cb2[o + t2] += v2; cb2[o + t3] += v3; cb2[o + t4] += v4; }
      if (count > 3) { o = (bin1 * S3 + s3[row]) * stride; if (hasC) cb3[o + cOff] += 1; cb3[o + t0] += v0; cb3[o + t1] += v1; cb3[o + t2] += v2; cb3[o + t3] += v3; cb3[o + t4] += v4; }
      if (count > 4) { o = (bin1 * S4 + s4[row]) * stride; if (hasC) cb4[o + cOff] += 1; cb4[o + t0] += v0; cb4[o + t1] += v1; cb4[o + t2] += v2; cb4[o + t3] += v3; cb4[o + t4] += v4; }
    }
    return true;
  }

  return false;
}

function createFalconBrushCache(dimSource, baseRows, n, candidateInfos, kpiInfo, getNumericColumn) {
  var rowIndices = baseRows ? baseRows.indices : null;
  var baseCount = baseRows ? baseRows.length : n;
  if (baseCount <= 0) {
    return null;
  }

  var mode = null; // 'discrete' | 'continuous'
  var isNumeric = dimSource.isNumeric;
  var rawVals = dimSource.rawVals; // Float64Array or null
  var lazyCodes = dimSource.lazyCodes;
  var lazyCodeToValue = dimSource.lazyCodeToValue;
  var sortedVals = null;
  var binCount = 0;
  var splitters = null;
  var binMin = null;
  var binMax = null;
  var binOffsets = null;
  var binRows = null;
  var rowBins = new Uint16Array(baseCount);
  var prefixTotalCount;
  var j, row, v, b;

  if (lazyCodes) {
    var codeLen = lazyCodeToValue.length;
    if (codeLen - 1 > MAX_DISCRETE_BINS) {
      return null;
    }
    var activeCodes = [];
    var codeUsed = new Uint8Array(codeLen);
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      var c = lazyCodes[row];
      if (!codeUsed[c]) {
        codeUsed[c] = 1;
        activeCodes.push(c);
      }
    }
    if (activeCodes.length === 0 || activeCodes.length > MAX_DISCRETE_BINS) {
      return null;
    }
    activeCodes.sort(function(a, b2) {
      var va = lazyCodeToValue[a], vb = lazyCodeToValue[b2];
      return va < vb ? -1 : va > vb ? 1 : a - b2;
    });
    binCount = activeCodes.length;
    sortedVals = isNumeric ? new Float64Array(binCount) : new Array(binCount);
    var codeToBin = new Int32Array(codeLen);
    codeToBin.fill(-1);
    for (b = 0; b < binCount; ++b) {
      sortedVals[b] = lazyCodeToValue[activeCodes[b]];
      codeToBin[activeCodes[b]] = b;
    }
    prefixTotalCount = new Uint32Array(binCount + 1);
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      b = codeToBin[lazyCodes[row]];
      rowBins[j] = b;
      prefixTotalCount[b + 1] += 1;
    }
    mode = 'discrete';
  } else if (rawVals) {
    // Probe uniqueness up to MAX_DISCRETE_BINS
    var uniqMap = new Map();
    var tooMany = false;
    for (j = 0; j < baseCount; ++j) {
      row = rowIndices ? rowIndices[j] : j;
      v = rawVals[row];
      if (!uniqMap.has(v)) {
        if (uniqMap.size >= MAX_DISCRETE_BINS) {
          tooMany = true;
          break;
        }
        uniqMap.set(v, 0);
      }
    }

    if (!tooMany) {
      binCount = uniqMap.size;
      sortedVals = new Float64Array(binCount);
      var ui = 0;
      uniqMap.forEach(function(_, key) { sortedVals[ui++] = key; });
      sortedVals.sort();
      for (b = 0; b < binCount; ++b) uniqMap.set(sortedVals[b], b);
      prefixTotalCount = new Uint32Array(binCount + 1);
      for (j = 0; j < baseCount; ++j) {
        row = rowIndices ? rowIndices[j] : j;
        b = uniqMap.get(rawVals[row]);
        rowBins[j] = b;
        prefixTotalCount[b + 1] += 1;
      }
      mode = 'discrete';
    } else {
      // Continuous exact quantile bins (B <= 256) + CSR per-bin row lists
      var sampleSize = baseCount < 2048 ? baseCount : 2048;
      var sample = new Float64Array(sampleSize);
      var step = baseCount / sampleSize;
      for (j = 0; j < sampleSize; ++j) {
        var idx = Math.floor(j * step);
        row = rowIndices ? rowIndices[idx] : idx;
        sample[j] = rawVals[row];
      }
      sample.sort();
      var rawSplits = [];
      for (b = 1; b < CONTINUOUS_BINS; ++b) {
        var sp = sample[Math.floor((b * sampleSize) / CONTINUOUS_BINS)];
        if (rawSplits.length === 0 || sp > rawSplits[rawSplits.length - 1]) {
          rawSplits.push(sp);
        }
      }
      var splitCount = rawSplits.length;
      splitters = Float64Array.from(rawSplits);
      binCount = splitCount + 1;
      binMin = new Float64Array(binCount);
      binMax = new Float64Array(binCount);
      binMin.fill(Infinity);
      binMax.fill(-Infinity);
      var binCounts = new Uint32Array(binCount);
      prefixTotalCount = new Uint32Array(binCount + 1);

      for (j = 0; j < baseCount; ++j) {
        row = rowIndices ? rowIndices[j] : j;
        v = rawVals[row];
        b = findContinuousBin(splitters, splitCount, v);
        rowBins[j] = b;
        binCounts[b] += 1;
        prefixTotalCount[b + 1] += 1;
        if (v < binMin[b]) binMin[b] = v;
        if (v > binMax[b]) binMax[b] = v;
      }

      binOffsets = new Uint32Array(binCount + 1);
      for (b = 0; b < binCount; ++b) {
        binOffsets[b + 1] = binOffsets[b] + binCounts[b];
      }
      binRows = new Uint32Array(baseCount);
      var writePos = new Uint32Array(binOffsets.subarray(0, binCount));
      for (j = 0; j < baseCount; ++j) {
        row = rowIndices ? rowIndices[j] : j;
        b = rowBins[j];
        binRows[writePos[b]++] = row;
      }
      mode = 'continuous';
    }
  } else {
    return null;
  }

  for (b = 1; b <= binCount; ++b) {
    prefixTotalCount[b] += prefixTotalCount[b - 1];
  }

  // Select eligible charts within memory budget & !hasExtreme
  var cubesByGroup = new Map();
  var eligibleByPlan = Object.create(null);
  var planKeys = [];
  var fallbackEntries = [];

  for (var gi = 0; gi < candidateInfos.length; ++gi) {
    var info = candidateInfos[gi];
    if (!info || !info.plan || !canPlanUseComplement(info.plan, getNumericColumn)) continue;
    var doubles = (binCount + 1) * info.slotCount * info.plan.stride;
    if (doubles > MAX_CUBE_DOUBLES) continue;
    var entry = {
      cube: new Float64Array(doubles),
      groupRef: info.groupRef,
      plan: info.plan,
      prefixRowCounts: info.plan.countOffset < 0 ? new Uint32Array((binCount + 1) * info.slotCount) : null,
      slotArr: info.slotArr,
      slotCount: info.slotCount
    };
    cubesByGroup.set(info.groupRef, entry);
    if (info.plan.canCoScan && info.plan.sumFields.length >= 1 && info.plan.sumFields.length <= 5) {
      var pk = info.plan.coScanKey;
      if (!eligibleByPlan[pk]) {
        eligibleByPlan[pk] = [];
        planKeys.push(pk);
      }
      eligibleByPlan[pk].push(entry);
    } else {
      fallbackEntries.push(entry);
    }
  }

  var kpiEntry = null;
  if (kpiInfo && kpiInfo.plan && canPlanUseComplement(kpiInfo.plan, getNumericColumn)) {
    var kpiDoubles = (binCount + 1) * kpiInfo.plan.stride;
    if (kpiDoubles <= MAX_CUBE_DOUBLES) {
      kpiEntry = {
        cube: new Float64Array(kpiDoubles),
        groupRef: kpiInfo.groupRef,
        plan: kpiInfo.plan,
        slotCount: 1
      };
      cubesByGroup.set(kpiInfo.groupRef, kpiEntry);
    }
  }

  if (cubesByGroup.size === 0) {
    return null;
  }

  // Build cubes in fused passes by planKey!
  var kpiBuilt = false;
  for (var pki = 0; pki < planKeys.length; ++pki) {
    var pKey = planKeys[pki];
    var list = eligibleByPlan[pKey];
    var plan = list[0].plan;
    var matchKpiCube = (!kpiBuilt && kpiEntry && kpiEntry.plan.coScanKey === pKey) ? kpiEntry.cube : null;
    var pos = 0;
    var usedFused = false;
    while (pos < list.length) {
      var chunk = list.slice(pos, pos + 5);
      var ok = buildSharedCubesPass(chunk, pos === 0 ? matchKpiCube : null, plan, getNumericColumn, rowIndices, rowBins, baseCount);
      if (!ok) {
        // hasNaN encountered -> fall back cleanly
        for (var fi = pos; fi < list.length; ++fi) {
          list[fi].cube.fill(0);
          fallbackEntries.push(list[fi]);
        }
        if (pos === 0 && matchKpiCube) {
          matchKpiCube.fill(0);
          matchKpiCube = null;
        }
        usedFused = false;
        break;
      }
      usedFused = true;
      pos += chunk.length;
    }
    if (usedFused) {
      if (matchKpiCube) {
        kpiBuilt = true;
        if (plan.extraAvgOffs.length > 0 && plan.fastCountOff >= 0) {
          for (b = 0; b <= binCount; ++b) {
            var kv = matchKpiCube[b * plan.stride + plan.fastCountOff];
            for (var ke = 0; ke < plan.extraAvgOffs.length; ++ke) matchKpiCube[b * plan.stride + plan.extraAvgOffs[ke]] = kv;
          }
        }
      }
      if (plan.extraAvgOffs.length > 0 && plan.fastCountOff >= 0) {
        for (var li = 0; li < list.length; ++li) {
          var le = list[li];
          var cells = (binCount + 1) * le.slotCount;
          for (var ci = 0, cb = 0; ci < cells; ++ci, cb += plan.stride) {
            var lv = le.cube[cb + plan.fastCountOff];
            for (var ee = 0; ee < plan.extraAvgOffs.length; ++ee) le.cube[cb + plan.extraAvgOffs[ee]] = lv;
          }
        }
      }
    }
  }

  for (var fbi = 0; fbi < fallbackEntries.length; ++fbi) {
    var fe = fallbackEntries[fbi];
    accumulateRowsIntoCube(fe.cube, binCount, fe.slotCount, fe.plan.stride, fe.plan, getNumericColumn, fe.slotArr, rowIndices, rowBins, baseCount);
  }
  if (kpiEntry && !kpiBuilt) {
    accumulateRowsIntoCube(kpiEntry.cube, binCount, 1, kpiEntry.plan.stride, kpiEntry.plan, getNumericColumn, null, rowIndices, rowBins, baseCount);
  }

  // Populate prefixRowCounts for groups without OP_COUNT, and compute 1D prefix sums along bins!
  cubesByGroup.forEach(function(ce) {
    if (ce.prefixRowCounts) {
      var prc = ce.prefixRowCounts;
      var sArr = ce.slotArr;
      var sCnt = ce.slotCount;
      for (j = 0; j < baseCount; ++j) {
        row = rowIndices ? rowIndices[j] : j;
        prc[(rowBins[j] + 1) * sCnt + sArr[row]] += 1;
      }
      prefixSumUint32(prc, binCount, sCnt);
    }
    prefixSumCube(ce.cube, binCount, ce.slotCount * ce.plan.stride);
  });

  // Free temporary rowBins array immediately!
  rowBins = null;

  var boundaryBuf = mode === 'continuous' ? new Uint32Array(Math.max(64, (baseCount >>> 6) + 64)) : null;

  function resolveRangeQuery(queryKind, lo, hi) {
    var fullLo = 0, fullHi = 0, boundaryLen = 0;
    if (mode === 'discrete') {
      if (queryKind === 'exact') {
        var pos = isNumeric ? bisectLeftNumeric(sortedVals, binCount, lo) : bisectLeftString(sortedVals, binCount, lo);
        if (pos < binCount && sortedVals[pos] === lo) {
          fullLo = pos;
          fullHi = pos + 1;
        }
      } else {
        if (lo < hi) {
          fullLo = isNumeric ? bisectLeftNumeric(sortedVals, binCount, lo) : bisectLeftString(sortedVals, binCount, lo);
          fullHi = isNumeric ? bisectLeftNumeric(sortedVals, binCount, hi) : bisectLeftString(sortedVals, binCount, hi);
          if (fullHi < fullLo) fullHi = fullLo;
        }
      }
      return { boundaryLen: 0, fullHi: fullHi, fullLo: fullLo };
    }

    // Continuous mode
    if (queryKind === 'exact') {
      var eb = findContinuousBin(splitters, splitters.length, lo);
      if (eb < binCount && binMin[eb] <= lo && binMax[eb] >= lo) {
        var eStart = binOffsets[eb], eEnd = binOffsets[eb + 1];
        if (boundaryBuf.length < eEnd - eStart) boundaryBuf = new Uint32Array(eEnd - eStart);
        for (var ei = eStart; ei < eEnd; ++ei) {
          var er = binRows[ei];
          if (rawVals[er] === lo) boundaryBuf[boundaryLen++] = er;
        }
      }
      return { boundaryLen: boundaryLen, fullHi: 0, fullLo: 0 };
    }

    if (!(lo < hi)) {
      return { boundaryLen: 0, fullHi: 0, fullLo: 0 };
    }

    var firstFull = -1, lastFull = -1;
    var pStart, pEnd, pi, pr, pv;
    for (b = 0; b < binCount; ++b) {
      var bLo = binMin[b], bHi = binMax[b];
      if (bLo > bHi) continue; // empty bin
      if (bHi < lo) continue;
      if (bLo >= hi) break;
      if (bLo >= lo && bHi < hi) {
        if (firstFull < 0) firstFull = b;
        lastFull = b;
      } else {
        pStart = binOffsets[b];
        pEnd = binOffsets[b + 1];
        var need = boundaryLen + (pEnd - pStart);
        if (boundaryBuf.length < need) {
          var grown = new Uint32Array(need << 1);
          grown.set(boundaryBuf.subarray(0, boundaryLen));
          boundaryBuf = grown;
        }
        for (pi = pStart; pi < pEnd; ++pi) {
          pr = binRows[pi];
          pv = rawVals[pr];
          if (pv >= lo && pv < hi) {
            boundaryBuf[boundaryLen++] = pr;
          }
        }
      }
    }
    if (firstFull >= 0) {
      fullLo = firstFull;
      fullHi = lastFull + 1;
    }
    return { boundaryLen: boundaryLen, fullHi: fullHi, fullLo: fullLo };
  }

  function applyPrefixToEntry(ce, targetBuffers, fullLo, fullHi) {
    var data = targetBuffers.data;
    var stride = ce.plan.stride;
    var slotCount = ce.slotCount;
    var rowStride = slotCount * stride;
    var cube = ce.cube;
    var k;
    if (fullHi > fullLo) {
      if (slotCount === 1 && prefixTotalCount[fullHi] - prefixTotalCount[fullLo] <= 0) {
        data.fill(0, 0, stride);
        return;
      }
      var oLo = fullLo * rowStride;
      var oHi = fullHi * rowStride;
      for (k = 0; k < rowStride; ++k) {
        data[k] = cube[oHi + k] - cube[oLo + k];
      }
      var cOff = ce.plan.countOffset;
      if (cOff >= 0) {
        for (var s = 0, base = 0; s < slotCount; ++s, base += stride) {
          if (data[base + cOff] <= 0) {
            for (k = 0; k < stride; ++k) data[base + k] = 0;
          }
        }
      } else if (ce.prefixRowCounts) {
        var prc = ce.prefixRowCounts;
        var cLo = fullLo * slotCount, cHi = fullHi * slotCount;
        for (var s2 = 0, base2 = 0; s2 < slotCount; ++s2, base2 += stride) {
          if (prc[cHi + s2] - prc[cLo + s2] <= 0) {
            for (k = 0; k < stride; ++k) data[base2 + k] = 0;
          }
        }
      }
    } else {
      data.fill(0, 0, rowStride);
    }
  }

  function applyQueryBatch(queryKind, lo, hi, targetInfos, kpiInfoArg) {
    var resolved = resolveRangeQuery(queryKind, lo, hi);
    var fullLo = resolved.fullLo;
    var fullHi = resolved.fullHi;
    var bLen = resolved.boundaryLen;
    var appliedCount = 0;

    // Group boundary work by planKey for co-scan!
    var bndByPlan = bLen > 0 ? Object.create(null) : null;
    var bndPlanKeys = bLen > 0 ? [] : null;
    var bndFallback = bLen > 0 ? [] : null;
    var kpiBndEntry = null;
    var i, info, ce;

    for (i = 0; i < targetInfos.length; ++i) {
      info = targetInfos[i];
      ce = cubesByGroup.get(info.groupRef);
      if (!ce) continue;
      info.ensureBuffers();
      applyPrefixToEntry(ce, info.buffers, fullLo, fullHi);
      if (bLen > 0) {
        if (ce.plan.canCoScan) {
          var pk = ce.plan.coScanKey;
          if (!bndByPlan[pk]) {
            bndByPlan[pk] = [];
            bndPlanKeys.push(pk);
          }
          bndByPlan[pk].push(info);
        } else {
          bndFallback.push(info);
        }
      } else {
        info.commit(false);
      }
      appliedCount += 1;
    }

    var kpiApplied = false;
    if (kpiInfoArg && kpiEntry && kpiInfoArg.groupRef === kpiEntry.groupRef) {
      kpiInfoArg.ensureBuffers();
      applyPrefixToEntry(kpiEntry, kpiInfoArg.buffers, fullLo, fullHi);
      if (bLen > 0) {
        kpiBndEntry = kpiInfoArg;
      } else {
        kpiInfoArg.commit(false);
      }
      kpiApplied = true;
    }

    if (bLen > 0) {
      var kpiDone = false;
      for (i = 0; i < bndPlanKeys.length; ++i) {
        var bKey = bndPlanKeys[i];
        var bList = bndByPlan[bKey];
        var matchKpi = (!kpiDone && kpiBndEntry && kpiBndEntry.plan.coScanKey === bKey) ? kpiBndEntry : null;
        if (bList.length >= 2 || matchKpi) {
          reduceMultiGroupsIndexed(bList, matchKpi ? matchKpi.buffers : null, bList[0].plan, getNumericColumn, boundaryBuf, bLen, 1);
          if (matchKpi) { matchKpi.commit(false); kpiDone = true; }
        } else {
          reduceGroupedIndexed(bList[0].buffers, bList[0].plan, getNumericColumn, bList[0].slotArr, boundaryBuf, bLen, 1, bList[0].slotCount);
        }
        for (var bi = 0; bi < bList.length; ++bi) {
          bList[bi].commit(false);
        }
      }
      for (i = 0; i < bndFallback.length; ++i) {
        var bf = bndFallback[i];
        reduceGroupedIndexed(bf.buffers, bf.plan, getNumericColumn, bf.slotArr, boundaryBuf, bLen, 1, bf.slotCount);
        bf.commit(false);
      }
      if (kpiBndEntry && !kpiDone) {
        reduceScalarIndexed(kpiBndEntry.buffers, kpiBndEntry.plan, getNumericColumn, boundaryBuf, bLen, 1);
        kpiBndEntry.commit(false);
      }
    }

    return {
      appliedCount: appliedCount,
      kpiApplied: kpiApplied,
      totalCount: (fullHi > fullLo ? prefixTotalCount[fullHi] - prefixTotalCount[fullLo] : 0) + bLen
    };
  }

  function applyQuerySingle(queryKind, lo, hi, info) {
    var ce = cubesByGroup.get(info.groupRef);
    if (!ce) return false;
    var resolved = resolveRangeQuery(queryKind, lo, hi);
    info.ensureBuffers();
    applyPrefixToEntry(ce, info.buffers, resolved.fullLo, resolved.fullHi);
    if (resolved.boundaryLen > 0) {
      if (ce.slotCount === 1 && !info.slotArr) {
        reduceScalarIndexed(info.buffers, ce.plan, getNumericColumn, boundaryBuf, resolved.boundaryLen, 1);
      } else {
        reduceGroupedIndexed(info.buffers, ce.plan, getNumericColumn, ce.slotArr, boundaryBuf, resolved.boundaryLen, 1, ce.slotCount);
      }
    }
    return true;
  }

  function queryCount(queryKind, lo, hi) {
    var resolved = resolveRangeQuery(queryKind, lo, hi);
    return (resolved.fullHi > resolved.fullLo ? prefixTotalCount[resolved.fullHi] - prefixTotalCount[resolved.fullLo] : 0) + resolved.boundaryLen;
  }

  return {
    applyQueryBatch: applyQueryBatch,
    applyQuerySingle: applyQuerySingle,
    hasGroup: function(groupRef) { return cubesByGroup.has(groupRef); },
    mode: mode,
    queryCount: queryCount
  };
}

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
  ? Symbol.for("crossfilter3.columnarBatch")
  : "__crossfilter3ColumnarBatch__";

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
  if (Array.isArray(column) || ArrayBuffer.isView(column)) {
    return function(index) { return column[index]; };
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
  if (Array.isArray(column) || ArrayBuffer.isView(column)) {
    return column[index];
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

  var factory = function(index) {
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
  factory._xfilterDefaultRowFactory = true;
  return factory;
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
    lastMarkPtr: -1,
    lastMarkMax: -1,
    marksDirty: false,
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
      this.marksDirty = true;

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
      this.marksDirty = true;

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

      if (this.marksDirty || this.lastMarkPtr !== markPtr || maxTargetCode > this.lastMarkMax) {
        new Uint32Array(buffer, markPtr, maxTargetCode + 1).fill(0);
        this.marksDirty = false;
        this.lastMarkPtr = markPtr;
      }
      // Always track the exact mark upper bound because outPtr starts immediately
      // after maxTargetCode and overwrites any previously-zeroed marks above it.
      this.lastMarkMax = maxTargetCode;

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

function denseLookupMatches(codes, targetCodes, state, maxCodeHint) {
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

  var requiredMarks = maxTargetCode + 1;
  if (typeof maxCodeHint === 'number' && maxCodeHint + 1 > requiredMarks && (maxCodeHint + 1) * 4 <= MAX_WASM_MARK_BYTES) {
    requiredMarks = maxCodeHint + 1;
  }
  ensureDenseLookupCapacity(state, requiredMarks);
  if (state.version === 0xffffffff) {
    state.marks.fill(0);
    state.version = 1;
  }

  var version = state.version++;
  var marks = state.marks;
  var marksLen = marks.length;

  for (i = 0; i < targetCodes.length; ++i) {
    marks[targetCodes[i]] = version;
  }

  for (i = 0; i < codes.length; ++i) {
    var code = codes[i];
    if (code < marksLen && marks[code] === version) {
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

  function findMatches(codes, targetCodes, maxCodeHint) {
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
      if (targetCodes.length === 1 && (runtime.cachedCodes !== codes || runtime.cachedCodesLength !== codes.length)) {
        return denseLookupMatches(codes, targetCodes, denseLookupState, maxCodeHint);
      }
      maxTargetCode = typeof maxCodeHint === 'number' && maxCodeHint >= 0
        ? Math.max(maxCodeValue(targetCodes), maxCodeHint)
        : Math.max(maxCodeValue(targetCodes), maxCodeValue(codes));
      if ((maxTargetCode + 1) * 4 <= MAX_WASM_MARK_BYTES) {
        try {
          return runtime.matchMarked(codes, targetCodes, maxTargetCode);
        } catch (error) {
          sharedRuntimeState.error = error;
          sharedRuntimeState.runtime = null;
        }
      }
    }

    return denseLookupMatches(codes, targetCodes, denseLookupState, maxCodeHint);
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
    if (metric.op !== "count" && metric.op !== "sum" && metric.op !== "avg" && metric.op !== "avgNonZero" && metric.op !== "ratio") {
      throw new Error("Unsupported dashboard metric op: " + metric.op);
    }
    if (metric.op === "ratio" && !metric.denominator) {
      throw new Error("Dashboard metric `" + id + "` with op `ratio` requires a denominator.");
    }

    return {
      field: metric.field,
      id: id,
      op: metric.op || "count",
      denominator: metric.denominator || null
    };
  });

  return normalized;
}

var reusableMonthDate = new Date(0);

function normalizeTimeBucketValue(value) {
  if (typeof value === "number") {
    return value === value && value !== Infinity && value !== -Infinity ? value : null;
  }

  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    var time = value.getTime();
    return time === time ? time : null;
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

  if (granularity === "day") {
    return Math.floor(numeric / 86400000) * 86400000;
  }

  if (granularity === "hour") {
    return Math.floor(numeric / 3600000) * 3600000;
  }

  if (granularity === "minute") {
    return Math.floor(numeric / 60000) * 60000;
  }

  if (granularity === "week") {
    return Math.floor((numeric + 259200000) / 604800000) * 604800000 - 259200000;
  }

  if (granularity === "month") {
    reusableMonthDate.setTime(numeric);
    return Date.UTC(reusableMonthDate.getUTCFullYear(), reusableMonthDate.getUTCMonth(), 1);
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
  var accessor = function(value) {
    return bucketTimestampValue(value, granularity);
  };
  accessor._xfilterPureMonotonic = true;
  if (granularity === "day") {
    accessor._xfilterTimeStep = 86400000;
    accessor._xfilterTimeOffset = 0;
  } else if (granularity === "hour") {
    accessor._xfilterTimeStep = 3600000;
    accessor._xfilterTimeOffset = 0;
  } else if (granularity === "minute") {
    accessor._xfilterTimeStep = 60000;
    accessor._xfilterTimeOffset = 0;
  } else if (granularity === "week") {
    accessor._xfilterTimeStep = 604800000;
    accessor._xfilterTimeOffset = 259200000;
  }
  return accessor;
}

function buildMetricReducer(metrics, splitField) {
  var metricSpec = metrics.map(function(metric) {
    return {
      field: metric.field || null,
      denominator: metric.denominator || null,
      hidden: !!metric.hidden,
      id: metric.id,
      op: metric.op
    };
  });

  function initBucket() {
    var bucket = {};
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      if (metric.op === "avg" || metric.op === "avgNonZero") {
        bucket[metric.id] = { count: 0, sum: 0 };
      } else if (metric.op === "ratio") {
        bucket[metric.id] = { num: 0, den: 0 };
      } else {
        bucket[metric.id] = 0;
      }
    }
    return bucket;
  }

  function isBucketEmpty(bucket) {
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value = bucket[metric.id];
      if (metric.op === "avg" || metric.op === "avgNonZero") {
        if (value && value.count > 0) return false;
      } else if (metric.op === "ratio") {
        if (value && (value.num !== 0 || value.den !== 0)) return false;
      } else if (metric.op === "count") {
        if (value > 0) return false;
      } else {
        if (value !== 0) return false;
      }
    }
    return true;
  }

  function addToBucket(bucket, row) {
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value;

      switch (metric.op) {
        case "count":
          bucket[metric.id] += 1;
          break;
        case "sum":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id] += value;
          }
          break;
        case "avg":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id].sum += value;
            bucket[metric.id].count += 1;
          }
          break;
        case "avgNonZero":
          value = row[metric.field];
          if (isFiniteNumber(value) && value !== 0) {
            bucket[metric.id].sum += value;
            bucket[metric.id].count += 1;
          }
          break;
        case "ratio":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id].num += value;
          }
          value = row[metric.denominator];
          if (isFiniteNumber(value)) {
            bucket[metric.id].den += value;
          }
          break;
      }
    }
  }

  function removeFromBucket(bucket, row) {
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      var value;

      switch (metric.op) {
        case "count":
          bucket[metric.id] -= 1;
          break;
        case "sum":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id] -= value;
          }
          break;
        case "avg":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id].sum -= value;
            bucket[metric.id].count -= 1;
          }
          break;
        case "avgNonZero":
          value = row[metric.field];
          if (isFiniteNumber(value) && value !== 0) {
            bucket[metric.id].sum -= value;
            bucket[metric.id].count -= 1;
          }
          break;
        case "ratio":
          value = row[metric.field];
          if (isFiniteNumber(value)) {
            bucket[metric.id].num -= value;
          }
          value = row[metric.denominator];
          if (isFiniteNumber(value)) {
            bucket[metric.id].den -= value;
          }
          break;
      }
    }
  }

  function finalizeBucket(bucket) {
    var result = {};
    for (var metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
      var metric = metrics[metricIndex];
      if (metric.hidden) continue;
      var value = bucket[metric.id];
      if (metric.op === "avg" || metric.op === "avgNonZero") {
        result[metric.id] = value.count ? value.sum / value.count : null;
      } else if (metric.op === "ratio") {
        result[metric.id] = value.den !== 0 ? value.num / value.den : null;
      } else {
        result[metric.id] = value;
      }
    }
    return result;
  }

  // ---- Split-field path: nested aggregates keyed by splitField value ----

  if (splitField) {
    var splitInitial = function() {
      var state = {};
      Object.defineProperties(state, {
        __cache: { configurable: true, enumerable: false, value: null, writable: true },
        __cacheVersion: { configurable: true, enumerable: false, value: -1, writable: true },
        __version: { configurable: true, enumerable: false, value: 0, writable: true }
      });
      return state;
    };

    var splitAdd = function(state, row) {
      var splitKey = row[splitField];
      if (splitKey == null || splitKey === "") splitKey = "__unknown__";
      if (!state[splitKey]) state[splitKey] = initBucket();
      addToBucket(state[splitKey], row);
      state.__version += 1;
      return state;
    };

    var splitRemove = function(state, row) {
      var splitKey = row[splitField];
      if (splitKey == null || splitKey === "") splitKey = "__unknown__";
      if (state[splitKey]) removeFromBucket(state[splitKey], row);
      state.__version += 1;
      return state;
    };

    var splitFinalize = function(state) {
      if (state.__cacheVersion === state.__version && state.__cache) {
        return state.__cache;
      }
      var result = {};
      for (var key in state) {
        var bucket = state[key];
        // Skip buckets reduced to zero (filtered-out stores)
        if (isBucketEmpty(bucket)) continue;
        result[key] = finalizeBucket(bucket);
      }
      state.__cache = result;
      state.__cacheVersion = state.__version;
      return result;
    };

    splitAdd._xfilterMetricSpec = metricSpec;
    splitRemove._xfilterMetricSpec = metricSpec;
    splitInitial._xfilterMetricSpec = metricSpec;
    splitAdd._xfilterSplitField = splitField;
    splitRemove._xfilterSplitField = splitField;
    splitInitial._xfilterSplitField = splitField;

    return { add: splitAdd, finalize: splitFinalize, initial: splitInitial, remove: splitRemove };
  }

  // ---- Standard path: flat metrics ----

  function initial() {
    var state = initBucket();

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
    addToBucket(state, row);
    state.__version += 1;
    return state;
  }

  function remove(state, row) {
    removeFromBucket(state, row);
    state.__version += 1;
    return state;
  }

  function finalize(state) {
    if (state.__cacheVersion === state.__version && state.__cache) {
      return state.__cache;
    }

    var result = finalizeBucket(state);

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

function shallowCopy(obj) {
  var copy = {};
  for (var key in obj) {
    copy[key] = obj[key];
  }
  return copy;
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

function sameFilterState(left, right) {
  var field;
  for (field in left) {
    if (!sameFilter(left[field], right[field])) {
      return false;
    }
  }
  for (field in right) {
    if (!(field in left) && right[field] != null) {
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

  if (metric.op === "ratio") {
    return value && value.den !== 0 ? value.num / value.den : null;
  }

  return typeof value === "number" ? value : 0;
}

function metricHasVisibleValue(metric, value) {
  var comparable = metricComparableValue(metric, value);
  return comparable != null && comparable > 0;
}

var groupKeyCollator = typeof Intl !== "undefined" && typeof Intl.Collator === "function"
  ? new Intl.Collator()
  : null;

function compareGroupKeys(left, right) {
  if (left === right) {
    return 0;
  }
  var leftText = String(left);
  var rightText = String(right);
  return groupKeyCollator ? groupKeyCollator.compare(leftText, rightText) : leftText.localeCompare(rightText);
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
  var reducer = buildMetricReducer(metrics);
  var group = cf.groupAll().reduce(reducer.add, reducer.remove, reducer.initial);

  return {
    dispose: function() {
      group.dispose();
    },
    rawGroup: group,
    read: function() {
      if (typeof group._readScalar === "function") {
        var fast = group._readScalar();
        if (fast) {
          return fast;
        }
      }
      return reducer.finalize(group.value());
    }
  };
}

function finalizeColumnarSlot(view, slot) {
  if (view.mode === "flat") {
    return finalizeMetricSlot(view.plan, view.buffers, slot);
  }

  var result = {};
  var splitKeys = view.splitKeys;
  var plan = view.plan;
  var buffers = view.buffers;

  if (view.mode === "splitDense") {
    var stride = view.splitStride;
    var base = slot * stride;
    for (var sc = 0; sc < stride; ++sc) {
      var cell = base + sc;
      if (slotHasAnyActivity(plan, buffers, cell)) {
        result[splitKeys[sc]] = finalizeMetricSlot(plan, buffers, cell);
      }
    }
    return result;
  }

  var activePairs = [];
  for (var pid = view.headBySlot[slot]; pid !== -1; pid = view.nextPair[pid]) {
    if (slotHasAnyActivity(plan, buffers, pid)) {
      activePairs.push(pid);
    }
  }
  if (activePairs.length > 1) {
    var pairSplitCode = view.pairSplitCode;
    activePairs.sort(function(a, b) {
      return pairSplitCode[a] - pairSplitCode[b];
    });
  }
  for (var pi = 0; pi < activePairs.length; ++pi) {
    var pairId = activePairs[pi];
    result[splitKeys[view.pairSplitCode[pairId]]] = finalizeMetricSlot(plan, buffers, pairId);
  }
  return result;
}

function createGroupRuntime(dimension, spec, index) {
  var metrics = normalizeMetrics(spec.metrics, spec.id || "group_" + index);
  // A category shows while rows contribute to it, as Cube's GROUP BY returns it, whatever
  // its value: a hidden row count proves that when no metric counts rows.
  if (!metrics.some(function(metric) { return metric.op === "count"; })) {
    metrics = metrics.concat([{ field: undefined, id: "__rows", op: "count", denominator: null, hidden: true }]);
  }
  var metricsById = {};
  var metricIndexById = {};
  var metricIndex;
  var splitField = spec.splitField || null;
  var reducer = buildMetricReducer(metrics, splitField);
  var groupAccessor = resolveGroupAccessor(spec);
  var group = groupAccessor ? dimension.group(groupAccessor) : dimension.group();
  var visibleMetric = null;
  var visibleMetricIndex = 0;
  var defaultSortMetric = null;
  var orderedMetricId = null;
  var queryHeapVal = null;
  var queryHeapSlot = null;
  var queryHeapKey = null;

  group.reduce(reducer.add, reducer.remove, reducer.initial);

  for (metricIndex = 0; metricIndex < metrics.length; ++metricIndex) {
    metricsById[metrics[metricIndex].id] = metrics[metricIndex];
    metricIndexById[metrics[metricIndex].id] = metricIndex;
    if (!visibleMetric && metrics[metricIndex].op === "count") {
      visibleMetric = metrics[metricIndex];
      visibleMetricIndex = metricIndex;
    }
  }

  if (!visibleMetric) {
    visibleMetric = metrics[0] || null;
    visibleMetricIndex = 0;
  }
  defaultSortMetric = metricsById[spec.sortMetric] || metricsById.rows || metrics[0] || null;

  function metricStateValue(value, metric) {
    if (!metric) {
      return 0;
    }
    if (splitField) {
      // Sum the metric across all split buckets for comparability
      var total = 0;
      for (var splitKey in value) {
        var bucket = value[splitKey];
        if (bucket && bucket[metric.id] != null) {
          var bv = bucket[metric.id];
          if (typeof bv === "object" && bv.count != null) {
            total += bv.sum || 0;
          } else if (typeof bv === "object" && bv.den != null) {
            total += bv.num || 0;
          } else {
            total += bv;
          }
        }
      }
      return total;
    }
    return value ? value[metric.id] : 0;
  }

  function entryMetricValue(entry, metric) {
    return entry ? metricStateValue(entry.value, metric) : 0;
  }

  function finalizeEntry(entry) {
    return {
      key: entry.key,
      value: reducer.finalize(entry.value)
    };
  }

  function readAllColumnar(view) {
    var count = view.count;
    var out = new Array(count);
    var slotOf = view.slotOf;
    var codeToValue = view.codeToValue;
    var keys = view.keys;
    var groupsRef = view.groups;
    var i, slot, key;

    for (i = 0; i < count; ++i) {
      if (slotOf) {
        slot = slotOf[i];
        key = codeToValue[slot];
      } else if (keys) {
        slot = i;
        key = keys[i];
      } else {
        slot = i;
        key = groupsRef[i].key;
      }
      out[i] = {
        key: key,
        value: finalizeColumnarSlot(view, slot)
      };
    }

    return out;
  }

  function readAll() {
    if (typeof group._readColumnar === "function") {
      var view = group._readColumnar();
      if (view) {
        return readAllColumnar(view);
      }
    }
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

  function readQueryColumnar(view, normalized, sortMetric) {
    var count = view.count;
    var mode = view.mode;
    var plan = view.plan;
    var buffers = view.buffers;
    var slotOf = view.slotOf;
    var codeToValue = view.codeToValue;
    var keys = view.keys;
    var groupsRef = view.groups;
    var stride = view.splitStride || 0;
    var headBySlot = view.headBySlot;
    var nextPair = view.nextPair;

    var includeKeySet = normalized.includeKeys ? new Set(normalized.includeKeys) : null;
    var keySet = normalized.keys ? new Set(normalized.keys) : null;
    var visibleOnly = normalized.visibleOnly;
    var nonEmptyKeys = normalized.nonEmptyKeys;
    var searchTerm = normalized.search;
    var sortDir = normalized.sort;
    var isAsc = sortDir === "asc";
    var isNatural = sortDir === "natural" || !sortMetric;
    var limitWindow = normalized.limit == null ? null : normalized.offset + normalized.limit;
    var useHeap = !isNatural && limitWindow != null && limitWindow > 0 && limitWindow < count;

    var bufData = buffers ? buffers.data : null;
    var bufStride = buffers ? buffers.stride : 0;
    var visPrimOff = plan.primOff[visibleMetricIndex];
    var visSecOff = plan.secOff[visibleMetricIndex];
    var visOp = plan.ops[visibleMetricIndex];

    var sortIdx = sortMetric ? metricIndexById[sortMetric.id] : -1;
    var sortPrimOff = sortIdx >= 0 ? plan.primOff[sortIdx] : -1;
    var sortSecOff = sortIdx >= 0 ? plan.secOff[sortIdx] : -1;
    var sortOp = sortIdx >= 0 ? plan.ops[sortIdx] : OP_COUNT;
    var modeCode = mode === "flat" ? 0 : (mode === "splitDense" ? 1 : 2);

    function isSlotVisible(slot) {
      if (!bufData) return false;
      var off;
      if (modeCode === 0) {
        off = slot * bufStride;
        if (visOp === OP_COUNT || visOp === OP_SUM) {
          return bufData[off + visPrimOff] > 0;
        }
        if (visOp === OP_AVG || visOp === OP_AVG_NON_ZERO) {
          var vc = bufData[off + visSecOff];
          return vc > 0 && (bufData[off + visPrimOff] / vc) > 0;
        }
        if (visOp === OP_RATIO) {
          var vd = bufData[off + visSecOff];
          return vd !== 0 && (bufData[off + visPrimOff] / vd) > 0;
        }
        return false;
      }
      var sum = 0;
      if (modeCode === 1) {
        var base = slot * stride * bufStride + visPrimOff;
        for (var sc = 0; sc < stride; ++sc, base += bufStride) {
          sum += bufData[base];
        }
        return sum > 0;
      }
      for (var pid = headBySlot[slot]; pid !== -1; pid = nextPair[pid]) {
        sum += bufData[pid * bufStride + visPrimOff];
      }
      return sum > 0;
    }

    function readSortComparable(slot) {
      if (!bufData || sortPrimOff < 0) return 0;
      var off;
      if (modeCode === 0) {
        off = slot * bufStride;
        if (sortOp === OP_COUNT || sortOp === OP_SUM) {
          return bufData[off + sortPrimOff];
        }
        if (sortOp === OP_AVG || sortOp === OP_AVG_NON_ZERO) {
          var c = bufData[off + sortSecOff];
          return c ? bufData[off + sortPrimOff] / c : 0;
        }
        if (sortOp === OP_RATIO) {
          var d = bufData[off + sortSecOff];
          return d !== 0 ? bufData[off + sortPrimOff] / d : 0;
        }
        return 0;
      }
      var sum = 0;
      if (modeCode === 1) {
        var base = slot * stride * bufStride + sortPrimOff;
        for (var sc = 0; sc < stride; ++sc, base += bufStride) {
          sum += bufData[base];
        }
        return sum;
      }
      for (var pid = headBySlot[slot]; pid !== -1; pid = nextPair[pid]) {
        sum += bufData[pid * bufStride + sortPrimOff];
      }
      return sum;
    }

    var total = 0;
    var forcedItems = includeKeySet ? [] : null;
    var matchedItems = useHeap ? null : [];
    if (useHeap && (!queryHeapVal || queryHeapVal.length < limitWindow)) {
      var nextHeapCap = queryHeapVal && queryHeapVal.length ? queryHeapVal.length : 32;
      while (nextHeapCap < limitWindow) nextHeapCap <<= 1;
      queryHeapVal = new Float64Array(nextHeapCap);
      queryHeapSlot = new Uint32Array(nextHeapCap);
      queryHeapKey = new Array(nextHeapCap);
    }
    var heapVal = useHeap ? queryHeapVal : null;
    var heapSlot = useHeap ? queryHeapSlot : null;
    var heapKey = useHeap ? queryHeapKey : null;
    var heapSize = 0;
    var canBreakNatural = isNatural && limitWindow != null && !normalized.includeTotals && !includeKeySet;

    function isHeapWorse(valA, keyA, valB, keyB) {
      var diff = valA - valB;
      if (!Number.isFinite(diff) || diff === 0) {
        return compareGroupKeys(keyA, keyB) > 0;
      }
      return isAsc ? diff > 0 : diff < 0;
    }

    var i, slot, key, visible, matchesKey, val, pos, parent, left, right, child;
    for (i = 0; i < count; ++i) {
      if (slotOf) {
        slot = slotOf[i];
        key = codeToValue[slot];
      } else if (keys) {
        slot = i;
        key = keys[i];
      } else {
        slot = i;
        key = groupsRef[i].key;
      }

      var forceInclude = includeKeySet !== null && includeKeySet.has(key);

      visible = !visibleOnly || isSlotVisible(slot);
      if (visible) {
        matchesKey = true;
        if (nonEmptyKeys && (key == null || key === "")) {
          matchesKey = false;
        } else if (keySet && !keySet.has(key)) {
          matchesKey = false;
        } else if (searchTerm && String(key).toLowerCase().indexOf(searchTerm) < 0) {
          matchesKey = false;
        }
      } else {
        matchesKey = false;
      }

      if (matchesKey) {
        total += 1;
        if (limitWindow === 0) ; else if (useHeap) {
          val = readSortComparable(slot);
          if (heapSize < limitWindow) {
            pos = heapSize++;
            while (pos > 0) {
              parent = (pos - 1) >>> 1;
              if (isHeapWorse(val, key, heapVal[parent], heapKey[parent])) {
                heapVal[pos] = heapVal[parent];
                heapSlot[pos] = heapSlot[parent];
                heapKey[pos] = heapKey[parent];
                pos = parent;
              } else {
                break;
              }
            }
            heapVal[pos] = val;
            heapSlot[pos] = slot;
            heapKey[pos] = key;
          } else {
            var rootVal = heapVal[0];
            var better = isAsc
              ? (val < rootVal || (val === rootVal && compareGroupKeys(key, heapKey[0]) < 0))
              : (val > rootVal || (val === rootVal && compareGroupKeys(key, heapKey[0]) < 0));
            if (better) {
              pos = 0;
              while ((left = (pos << 1) + 1) < heapSize) {
                child = left;
                right = left + 1;
                if (right < heapSize && isHeapWorse(heapVal[right], heapKey[right], heapVal[left], heapKey[left])) {
                  child = right;
                }
                if (isHeapWorse(heapVal[child], heapKey[child], val, key)) {
                  heapVal[pos] = heapVal[child];
                  heapSlot[pos] = heapSlot[child];
                  heapKey[pos] = heapKey[child];
                  pos = child;
                } else {
                  break;
                }
              }
              heapVal[pos] = val;
              heapSlot[pos] = slot;
              heapKey[pos] = key;
            }
          }
        } else if (isNatural) {
          if (limitWindow == null || (total > normalized.offset && matchedItems.length < normalized.limit)) {
            matchedItems.push({ key: key, slot: slot, val: 0 });
            if (canBreakNatural && matchedItems.length >= normalized.limit) {
              break;
            }
          }
        } else {
          matchedItems.push({ key: key, slot: slot, val: readSortComparable(slot) });
        }
      }

      if (forceInclude) {
        forcedItems.push({
          key: key,
          slot: slot,
          val: isNatural ? 0 : readSortComparable(slot)
        });
      }
    }

    var compareItems = function(leftItem, rightItem) {
      var diff = leftItem.val - rightItem.val;
      if (!Number.isFinite(diff) || diff === 0) {
        return compareGroupKeys(leftItem.key, rightItem.key);
      }
      return isAsc ? diff : -diff;
    };

    var pagedItems;
    if (useHeap) {
      var extracted = new Array(heapSize);
      for (i = 0; i < heapSize; ++i) {
        extracted[i] = { key: heapKey[i], slot: heapSlot[i], val: heapVal[i] };
      }
      extracted.sort(compareItems);
      pagedItems = normalized.offset > 0
        ? extracted.slice(normalized.offset, normalized.offset + normalized.limit)
        : (extracted.length > normalized.limit ? extracted.slice(0, normalized.limit) : extracted);
    } else if (isNatural) {
      pagedItems = limitWindow != null
        ? matchedItems
        : (normalized.offset > 0 ? matchedItems.slice(normalized.offset) : matchedItems);
    } else {
      matchedItems.sort(compareItems);
      pagedItems = normalized.limit == null
        ? matchedItems.slice(normalized.offset)
        : matchedItems.slice(normalized.offset, normalized.offset + normalized.limit);
    }

    var finalItems = pagedItems;
    if (forcedItems && forcedItems.length) {
      if (!isNatural) {
        forcedItems.sort(compareItems);
      }
      var seenKeys = new Set();
      var merged = [];
      for (i = 0; i < pagedItems.length; ++i) {
        merged.push(pagedItems[i]);
        seenKeys.add(pagedItems[i].key);
      }
      for (i = 0; i < forcedItems.length; ++i) {
        if (seenKeys.has(forcedItems[i].key)) continue;
        merged.push(forcedItems[i]);
        seenKeys.add(forcedItems[i].key);
      }
      if (!isNatural) {
        merged.sort(compareItems);
      }
      finalItems = merged;
    }

    var entries = new Array(finalItems.length);
    for (i = 0; i < finalItems.length; ++i) {
      entries[i] = {
        key: finalItems[i].key,
        value: finalizeColumnarSlot(view, finalItems[i].slot)
      };
    }

    var result = {
      entries: entries,
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

    if (typeof group._readColumnar === "function") {
      var view = group._readColumnar();
      if (view) {
        return readQueryColumnar(view, normalized, sortMetric);
      }
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
      queryHeapVal = null;
      queryHeapSlot = null;
      queryHeapKey = null;
      group.dispose();
    },
    id: spec.id || "group_" + index,
    rawGroup: group,
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
  var allRawGroups = [];
  var kpiRuntime = createKpiRuntime(cf, normalizeMetrics(options.kpis, "kpi"));
  var rowCountGroup = typeof cf._filteredCount === "function" ? null : cf.groupAll().reduceCount();

  for (var fieldIndex = 0; fieldIndex < dimensionFields.length; ++fieldIndex) {
    dimensions[dimensionFields[fieldIndex]] = cf.dimension(dimensionFields[fieldIndex]);
  }

  var nextGroupIndex = 0;
  for (nextGroupIndex = 0; nextGroupIndex < groupSpecs.length; ++nextGroupIndex) {
    var groupSpec = groupSpecs[nextGroupIndex];
    var groupDimension = ensureDimension(dimensions, dimensionFields, cf, groupSpec.field);
    var groupRuntime = createGroupRuntime(groupDimension, groupSpec, nextGroupIndex);
    groupRuntimes[groupRuntime.id] = groupRuntime;
    allRawGroups.push(groupRuntime.rawGroup);
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

  function readGroups(groupQueries, skipFlush) {
    var groups = {};

    if (!groupQueries) {
      if (!skipFlush && allRawGroups.length > 1 && typeof cf._flushGroups === "function") {
        cf._flushGroups(allRawGroups, null);
      }
      for (var groupId in groupRuntimes) {
        groups[groupId] = groupRuntimes[groupId].read();
      }
      return groups;
    }

    var requestedIds = [];
    for (var requestedGroupId in groupQueries) {
      if (!groupRuntimes[requestedGroupId]) {
        throw new Error("Unknown dashboard group: " + requestedGroupId);
      }
      if (groupQueries[requestedGroupId] === false) {
        continue;
      }
      requestedIds.push(requestedGroupId);
    }

    if (!skipFlush && requestedIds.length > 1 && typeof cf._flushGroups === "function") {
      var reqRaw = new Array(requestedIds.length);
      for (var ri = 0; ri < requestedIds.length; ++ri) {
        reqRaw[ri] = groupRuntimes[requestedIds[ri]].rawGroup;
      }
      cf._flushGroups(reqRaw, null);
    }

    for (var i = 0; i < requestedIds.length; ++i) {
      var id = requestedIds[i];
      groups[id] = groupRuntimes[id].read(groupQueries[id]);
    }

    return groups;
  }

  function readSnapshot(options) {
    var groups = {};
    var includeGroups = !options || options.groups !== false;
    var groupQueries = options && options.groups ? options.groups : null;

    if (includeGroups && typeof cf._flushGroups === "function") {
      if (!groupQueries) {
        cf._flushGroups(allRawGroups, kpiRuntime.rawGroup);
      } else {
        var reqRaw = [];
        for (var gId in groupQueries) {
          if (groupQueries[gId] !== false && groupRuntimes[gId]) {
            reqRaw.push(groupRuntimes[gId].rawGroup);
          }
        }
        cf._flushGroups(reqRaw, kpiRuntime.rawGroup);
      }
    }

    if (includeGroups) {
      groups = readGroups(groupQueries, true);
    }

    return {
      groups: groups,
      kpis: kpiRuntime.read(),
      runtime: typeof cf.runtimeInfo === "function" ? cf.runtimeInfo() : crossfilter.runtimeInfo()
    };
  }

  function readRowCount() {
    if (typeof cf._filteredCount === "function") {
      return cf._filteredCount();
    }
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
      } else if (typeof cf._filteredIndexesSlice === "function") {
        rowIndexes = cf._filteredIndexesSlice(normalized.offset, normalized.limit);
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
    } else if (typeof cf._filteredIndexesSlice === "function" && typeof cf._materializeRowsByIndex === "function") {
      var pageIndexes = cf._filteredIndexesSlice(normalized.offset, normalized.limit);
      return cf._materializeRowsByIndex(pageIndexes, normalized.fields);
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
      if (typeof dimension._bounds === "function") {
        var fastBounds = dimension._bounds();
        if (fastBounds) {
          bounds[field] = fastBounds;
          continue;
        }
      }
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

  function executeQueryReads(request) {
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

  function queryRuntime(request) {
    request = request || {};

    if (request.isolatedFilters) {
      var normalizedIsolated = normalizeFilterState(request.isolatedFilters);
      for (var isolatedField in normalizedIsolated) {
        if (!dimensions[isolatedField]) {
          throw new Error("Unknown dashboard filter dimension: " + isolatedField);
        }
      }
      if (sameFilterState(currentFilters, normalizedIsolated)) {
        return executeQueryReads(request);
      }
      var savedFilters = shallowCopy(currentFilters);
      var needsGroupState = request.snapshot !== false || !!request.groups;
      if (!needsGroupState && typeof cf._withTransientFilters === "function") {
        return cf._withTransientFilters(function() {
          updateFilters(normalizedIsolated);
          try {
            return executeQueryReads(request);
          } finally {
            updateFilters(savedFilters);
          }
        });
      }
      updateFilters(normalizedIsolated);
      try {
        return executeQueryReads(request);
      } finally {
        updateFilters(savedFilters);
      }
    }

    if (request.filters) {
      updateFilters(request.filters);
    }

    return executeQueryReads(request);
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
      var isExcluded = function(_, index) {
        return typeof cf.isElementFiltered === "function" ? !cf.isElementFiltered(index) : false;
      };
      isExcluded._xfilterIndexOnly = true;
      cf.remove(isExcluded);
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
      if (rowCountGroup) rowCountGroup.dispose();
      for (var dimensionIndex = 0; dimensionIndex < dimensionFields.length; ++dimensionIndex) {
        dimensions[dimensionFields[dimensionIndex]].dispose();
      }
    },
    createGroup: function(spec) {
      var groupDimension = ensureDimension(dimensions, dimensionFields, cf, spec.field);
      var groupRuntime = createGroupRuntime(groupDimension, spec, nextGroupIndex++);
      // Replace only after construction succeeds; a failed definition keeps
      // the previous group usable, while successful replacement releases it.
      if (groupRuntimes[groupRuntime.id]) groupRuntimes[groupRuntime.id].dispose();
      groupRuntimes[groupRuntime.id] = groupRuntime;
      return groupRuntime.id;
    },
    disposeGroup: function(id) {
      if (groupRuntimes[id]) {
        groupRuntimes[id].dispose();
        delete groupRuntimes[id];
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
    "    if (message.type !== 'init' && message.type !== 'dispose') {",
    "      if (!runtime) throw new Error('Dashboard worker is not initialized.');",
    "    }",
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
    "        respond(id, runtime.snapshot(message.payload.filters, message.payload.options || null));",
    "        return;",
    "      case 'groups':",
    "        respond(id, runtime.groups(message.payload.request));",
    "        return;",
    "      case 'bounds':",
    "        respond(id, runtime.bounds(message.payload.request));",
    "        return;",
    "      case 'query':",
    "        respond(id, runtime.query(message.payload.request));",
    "        return;",
    "      case 'createGroup':",
    "        respond(id, runtime.createGroup(message.payload.spec));",
    "        return;",
    "      case 'disposeGroup':",
    "        respond(id, runtime.disposeGroup(message.payload.id));",
    "        return;",
    "      case 'rows':",
    "        respond(id, runtime.rows(message.payload.query));",
    "        return;",
    "      case 'rowSets':",
    "        respond(id, runtime.rowSets(message.payload.request));",
    "        return;",
    "      case 'append':",
    "        respond(id, runtime.append(message.payload.records || []));",
    "        return;",
    "      case 'removeFiltered':",
    "        respond(id, runtime.removeFiltered(message.payload.selection));",
    "        return;",
    "      case 'updateFilters':",
    "        respond(id, runtime.updateFilters(message.payload.filters));",
    "        return;",
    "      case 'reset':",
    "        respond(id, runtime.reset());",
    "        return;",
    "      case 'runtimeInfo':",
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
      createGroup: function(spec) {
        return call("createGroup", { spec: spec });
      },
      disposeGroup: function(groupId) {
        return call("disposeGroup", { id: groupId });
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
// The two libraries load when streaming starts, not here. importScripts blocks this thread, and
// at the top it held the first data request back until both scripts had been fetched and run.
var runtimeScriptsLoaded = false;
function ensureRuntimeScripts() {
  if (runtimeScriptsLoaded) return;
  importScripts(${JSON.stringify(crossfilterUrl)}, ${JSON.stringify(arrowUrl)});
  runtimeScriptsLoaded = true;
}
var runtime = null;
var runtimeConfig = null;
var abortControllers = [];
var progress = null;
var progressTimer = 0;
var snapshotTimer = 0;
var sourceResponses = Object.create(null);
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
  if (ArrayBuffer.isView(column) || Array.isArray(column)) return column[index];
  if (typeof column.get === 'function') return column.get(index);
  if (typeof column.at === 'function') return column.at(index);
  return column[index];
}
var typedArrayToString = Object.prototype.toString;
function isStandardNumericTypedArray(arr) {
  if (!ArrayBuffer.isView(arr)) return false;
  var tag = typedArrayToString.call(arr);
  return tag === '[object Float64Array]'
    || tag === '[object Float32Array]'
    || tag === '[object Int32Array]'
    || tag === '[object Uint32Array]'
    || tag === '[object Int16Array]'
    || tag === '[object Uint16Array]'
    || tag === '[object Int8Array]'
    || tag === '[object Uint8Array]';
}
function isIntegerTypedArray(arr) {
  if (!ArrayBuffer.isView(arr)) return false;
  var tag = typedArrayToString.call(arr);
  return tag === '[object Int32Array]'
    || tag === '[object Uint32Array]'
    || tag === '[object Int16Array]'
    || tag === '[object Uint16Array]'
    || tag === '[object Int8Array]'
    || tag === '[object Uint8Array]';
}
function isBigIntTypedArray(arr) {
  if (!ArrayBuffer.isView(arr)) return false;
  var tag = typedArrayToString.call(arr);
  return tag === '[object BigInt64Array]' || tag === '[object BigUint64Array]';
}
var utf8FatalDecoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;
var utf8Decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
function hasValidNullBitmap(chunk) {
  if (!chunk || chunk.nullCount === 0) return true;
  if (!chunk.nullBitmap || typeof chunk.nullBitmap.length !== 'number') return false;
  var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
  return chunk.nullBitmap.length >= ((chunkOff + chunk.length + 7) >>> 3);
}
function extractArrowTemporalChunks(sourceColumn, length, mode) {
  if (!sourceColumn || !Array.isArray(sourceColumn.data) || !sourceColumn.data.length) {
    return null;
  }
  var colType = sourceColumn.type || sourceColumn.data[0].type;
  var typeId = colType && typeof colType.typeId === 'number' ? colType.typeId : -1;
  if (typeId !== 8 && typeId !== 10) {
    return null;
  }
  var unit = colType && typeof colType.unit === 'number' ? colType.unit : -1;
  var scaleMul = 1;
  var scaleDiv = 1;
  if (typeId === 8) {
    if (unit === 0) scaleMul = 86400000;
    else if (unit !== 1) return null;
  } else {
    if (unit === 0) scaleMul = 1000;
    else if (unit === 1) scaleMul = 1;
    else if (unit === 2) scaleDiv = 1000;
    else if (unit === 3) scaleDiv = 1000000;
    else return null;
  }
  var chunks = sourceColumn.data;
  var c, chunk, chunkLen, vals, j, v, nullBitmap, chunkOff, bitIdx;
  var total = 0;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    if (!chunk || !ArrayBuffer.isView(chunk.values)) return null;
    if (mode === 'raw' ? chunk.nullCount !== 0 : !hasValidNullBitmap(chunk)) return null;
    chunkLen = chunk.length;
    if (chunk.values.length < chunkLen) return null;
    if (typeId === 8 && unit === 0) {
      if (!isIntegerTypedArray(chunk.values)) return null;
    } else if (!isBigIntTypedArray(chunk.values) && !isStandardNumericTypedArray(chunk.values)) {
      return null;
    }
    total += chunkLen;
  }
  if (total !== length) return null;

  var out = new Float64Array(length);
  var outOffset = 0;
  var isTsMode = mode === 'timestampMs';
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    chunkLen = chunk.length;
    vals = chunk.values;
    nullBitmap = chunk.nullCount > 0 ? chunk.nullBitmap : null;
    chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
    var isBig = isBigIntTypedArray(vals);
    if (!nullBitmap) {
      for (j = 0; j < chunkLen; ++j) {
        v = isBig ? Number(vals[j]) : vals[j];
        if (scaleMul !== 1) v *= scaleMul;
        else if (scaleDiv !== 1) v /= scaleDiv;
        out[outOffset + j] = isTsMode ? (v < 1e12 ? v * 1000 : v) : v;
      }
    } else {
      for (j = 0; j < chunkLen; ++j) {
        bitIdx = chunkOff + j;
        if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
          out[outOffset + j] = 0;
        } else {
          v = isBig ? Number(vals[j]) : vals[j];
          if (scaleMul !== 1) v *= scaleMul;
          else if (scaleDiv !== 1) v /= scaleDiv;
          out[outOffset + j] = isTsMode ? (v < 1e12 ? v * 1000 : v) : v;
        }
      }
    }
    outOffset += chunkLen;
  }
  return out;
}
function extractArrowBoolColumn(sourceColumn, length) {
  if (!sourceColumn || !Array.isArray(sourceColumn.data) || !sourceColumn.data.length) {
    return null;
  }
  var colType = sourceColumn.type || sourceColumn.data[0].type;
  if (!colType || colType.typeId !== 6) {
    return null;
  }
  var chunks = sourceColumn.data;
  var c, chunk, chunkLen, chunkOff, total = 0;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    if (!chunk || !ArrayBuffer.isView(chunk.values) || !hasValidNullBitmap(chunk)) return null;
    chunkLen = chunk.length;
    chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
    if (chunk.values.length < ((chunkOff + chunkLen + 7) >>> 3)) return null;
    total += chunkLen;
  }
  if (total !== length) return null;

  var out = new Array(length);
  var outOffset = 0;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    chunkLen = chunk.length;
    chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
    var vals = chunk.values;
    var nullBitmap = chunk.nullCount > 0 ? chunk.nullBitmap : null;
    var j, bitIdx;
    if (!nullBitmap) {
      for (j = 0; j < chunkLen; ++j) {
        bitIdx = chunkOff + j;
        out[outOffset + j] = (vals[bitIdx >>> 3] & (1 << (bitIdx & 7))) ? 'true' : 'false';
      }
    } else {
      for (j = 0; j < chunkLen; ++j) {
        bitIdx = chunkOff + j;
        if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
          out[outOffset + j] = null;
        } else {
          out[outOffset + j] = (vals[bitIdx >>> 3] & (1 << (bitIdx & 7))) ? 'true' : 'false';
        }
      }
    }
    outOffset += chunkLen;
  }
  return out;
}
function copyArrowUtf8Into(target, targetOffset, sourceColumn, length) {
  if (!utf8Decoder || !sourceColumn || !Array.isArray(sourceColumn.data) || !sourceColumn.data.length) {
    return false;
  }
  var colType = sourceColumn.type || sourceColumn.data[0].type;
  if (!colType || colType.typeId !== 5) {
    return false;
  }
  var chunks = sourceColumn.data;
  var c, chunk, total = 0;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    if (!chunk || !ArrayBuffer.isView(chunk.values) || !ArrayBuffer.isView(chunk.valueOffsets) || chunk.valueOffsets.length <= chunk.length || !hasValidNullBitmap(chunk)) {
      return false;
    }
    total += chunk.length;
  }
  if (total !== length) return false;
  var outOffset = targetOffset;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    var chunkLen = chunk.length;
    var vo = chunk.valueOffsets;
    var bytes = chunk.values;
    var base = vo[0];
    var end = vo[chunkLen];
    var byteLen = end - base;
    var nullBitmap = chunk.nullCount > 0 ? chunk.nullBitmap : null;
    var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
    var asciiStr = null;
    if (utf8FatalDecoder && byteLen >= 0) {
      try {
        var decoded = utf8FatalDecoder.decode(bytes.subarray(base, end));
        if (decoded.length === byteLen) asciiStr = decoded;
      } catch (_) {}
    }
    var j, bitIdx;
    if (asciiStr !== null) {
      if (!nullBitmap) {
        for (j = 0; j < chunkLen; ++j) {
          target[outOffset + j] = asciiStr.slice(vo[j] - base, vo[j + 1] - base);
        }
      } else {
        for (j = 0; j < chunkLen; ++j) {
          bitIdx = chunkOff + j;
          target[outOffset + j] = (nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))
            ? asciiStr.slice(vo[j] - base, vo[j + 1] - base)
            : null;
        }
      }
    } else if (!nullBitmap) {
      for (j = 0; j < chunkLen; ++j) {
        target[outOffset + j] = utf8Decoder.decode(bytes.subarray(vo[j], vo[j + 1]));
      }
    } else {
      for (j = 0; j < chunkLen; ++j) {
        bitIdx = chunkOff + j;
        target[outOffset + j] = (nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))
          ? utf8Decoder.decode(bytes.subarray(vo[j], vo[j + 1]))
          : null;
      }
    }
    outOffset += chunkLen;
  }
  return true;
}
function extractArrowNumericChunks(sourceColumn, length, mode) {
  if (!sourceColumn || !Array.isArray(sourceColumn.data) || !sourceColumn.data.length) {
    return null;
  }
  var typeId = sourceColumn.type && typeof sourceColumn.type.typeId === 'number'
    ? sourceColumn.type.typeId
    : (sourceColumn.data[0].type && sourceColumn.data[0].type.typeId);
  if (typeId === 8 || typeId === 10) {
    return extractArrowTemporalChunks(sourceColumn, length, mode);
  }
  if (typeId !== 2 && typeId !== 3) {
    return null;
  }
  var chunks = sourceColumn.data;
  var c, chunk, chunkLen, vals, j, v, nullBitmap, chunkOff, bitIdx;
  var total = 0;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    if (!chunk || !ArrayBuffer.isView(chunk.values)) {
      return null;
    }
    if (mode === 'raw' ? chunk.nullCount !== 0 : !hasValidNullBitmap(chunk)) {
      return null;
    }
    chunkLen = chunk.length;
    if (chunk.values.length < chunkLen) {
      return null;
    }
    if (typeId === 2 && chunk.type && chunk.type.bitWidth > 32 && !isBigIntTypedArray(chunk.values)) {
      return null;
    }
    if (typeId === 3 && chunk.type && chunk.type.precision === 0) {
      return null;
    }
    if (!isStandardNumericTypedArray(chunk.values) && !isBigIntTypedArray(chunk.values)) {
      return null;
    }
    total += chunkLen;
  }
  if (total !== length) {
    return null;
  }

  if (mode === 'raw') {
    if (chunks.length === 1 && isStandardNumericTypedArray(chunks[0].values)) {
      vals = chunks[0].values;
      return vals.length === length ? vals : vals.subarray(0, length);
    }
    return null;
  }

  var out = new Float64Array(length);
  var outOffset = 0;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    chunkLen = chunk.length;
    vals = chunk.values;
    nullBitmap = chunk.nullCount > 0 ? chunk.nullBitmap : null;
    chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
    if (mode === 'number') {
      if (!nullBitmap) {
        if (isIntegerTypedArray(vals)) {
          out.set(vals.length === chunkLen ? vals : vals.subarray(0, chunkLen), outOffset);
        } else if (isBigIntTypedArray(vals)) {
          for (j = 0; j < chunkLen; ++j) {
            v = Number(vals[j]);
            out[outOffset + j] = (v === v && v !== Infinity && v !== -Infinity) ? v : 0;
          }
        } else {
          for (j = 0; j < chunkLen; ++j) {
            v = vals[j];
            out[outOffset + j] = (v === v && v !== Infinity && v !== -Infinity) ? v : 0;
          }
        }
      } else if (isBigIntTypedArray(vals)) {
        for (j = 0; j < chunkLen; ++j) {
          bitIdx = chunkOff + j;
          if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
            out[outOffset + j] = 0;
          } else {
            v = Number(vals[j]);
            out[outOffset + j] = (v === v && v !== Infinity && v !== -Infinity) ? v : 0;
          }
        }
      } else {
        for (j = 0; j < chunkLen; ++j) {
          bitIdx = chunkOff + j;
          if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
            out[outOffset + j] = 0;
          } else {
            v = vals[j];
            out[outOffset + j] = (v === v && v !== Infinity && v !== -Infinity) ? v : 0;
          }
        }
      }
    } else if (mode === 'timestampMs') {
      if (!nullBitmap) {
        if (isBigIntTypedArray(vals)) {
          for (j = 0; j < chunkLen; ++j) {
            v = Number(vals[j]);
            out[outOffset + j] = (v === v && v !== Infinity && v !== -Infinity) ? (v < 1e12 ? v * 1000 : v) : 0;
          }
        } else {
          for (j = 0; j < chunkLen; ++j) {
            v = vals[j];
            out[outOffset + j] = v < 1e12 ? v * 1000 : v;
          }
        }
      } else if (isBigIntTypedArray(vals)) {
        for (j = 0; j < chunkLen; ++j) {
          bitIdx = chunkOff + j;
          if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
            out[outOffset + j] = 0;
          } else {
            v = Number(vals[j]);
            out[outOffset + j] = (v === v && v !== Infinity && v !== -Infinity) ? (v < 1e12 ? v * 1000 : v) : 0;
          }
        }
      } else {
        for (j = 0; j < chunkLen; ++j) {
          bitIdx = chunkOff + j;
          if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
            out[outOffset + j] = 0;
          } else {
            v = vals[j];
            out[outOffset + j] = v < 1e12 ? v * 1000 : v;
          }
        }
      }
    }
    outOffset += chunkLen;
  }
  return out;
}
function copyArrowDictionaryInto(target, targetOffset, sourceColumn, length) {
  if (!sourceColumn || !Array.isArray(sourceColumn.data) || !sourceColumn.data.length) {
    return false;
  }
  var chunks = sourceColumn.data;
  var c, chunk, total = 0;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    if (!chunk || !chunk.dictionary || typeof chunk.dictionary.get !== 'function' || !hasValidNullBitmap(chunk) || !ArrayBuffer.isView(chunk.values) || chunk.values.length < chunk.length) {
      return false;
    }
    total += chunk.length;
  }
  if (total !== length) {
    return false;
  }
  var outOffset = targetOffset;
  for (c = 0; c < chunks.length; ++c) {
    chunk = chunks[c];
    var dict = chunk.dictionary;
    var dictLen = dict.length;
    var dictVals = new Array(dictLen);
    var d;
    for (d = 0; d < dictLen; ++d) {
      dictVals[d] = dict.get(d);
    }
    var indices = chunk.values;
    var chunkLen = chunk.length;
    var nullBitmap = chunk.nullCount > 0 ? chunk.nullBitmap : null;
    var j;
    if (!nullBitmap) {
      for (j = 0; j < chunkLen; ++j) {
        target[outOffset + j] = dictVals[indices[j]];
      }
    } else {
      var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
      for (j = 0; j < chunkLen; ++j) {
        var bitIdx = chunkOff + j;
        target[outOffset + j] = (nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))
          ? dictVals[indices[j]]
          : null;
      }
    }
    outOffset += chunkLen;
  }
  return true;
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
function allocateMergedColumnForBatches(batches, field, length) {
  var first = batches[0].columns[field];
  if (!ArrayBuffer.isView(first) || typeof first.constructor !== 'function' || typeof first.BYTES_PER_ELEMENT !== 'number') {
    return new Array(length);
  }
  var firstTag = typedArrayToString.call(first);
  for (var b = 1; b < batches.length; ++b) {
    var col = batches[b].columns[field];
    if (!ArrayBuffer.isView(col) || typedArrayToString.call(col) !== firstTag) {
      return new Array(length);
    }
  }
  return new first.constructor(length);
}
function copyColumnValues(target, targetOffset, source, length) {
  if (ArrayBuffer.isView(target) && ArrayBuffer.isView(source) && typedArrayToString.call(source) === typedArrayToString.call(target) && typeof source.length === 'number') {
    target.set(source.length === length ? source : source.subarray(0, length), targetOffset);
    return;
  }
  if (copyArrowDictionaryInto(target, targetOffset, source, length)) {
    return;
  }
  if (copyArrowUtf8Into(target, targetOffset, source, length)) {
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
    var mergeField = fields[fieldIndex];
    columns[mergeField] = allocateMergedColumnForBatches(batches, mergeField, totalLength);
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
    code: error && typeof error.code === 'string' ? error.code : null,
    status: error && typeof error.status === 'number' ? error.status : null,
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
// A yes/no field as the semantic layer answers it: 'true', 'false', or null for
// a missing value (never folded into false, as a numeric transform would).
function normalizeBooleanValue(value) {
  if (value == null) {
    return null;
  }
  if (value === true || value === 1 || value === 1n || value === 'true' || value === '1') {
    return 'true';
  }
  if (value === false || value === 0 || value === 0n || value === 'false' || value === '0') {
    return 'false';
  }
  return String(value);
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
      var fastTs = extractArrowNumericChunks(sourceColumn, length, 'timestampMs');
      if (fastTs) {
        columns[outputName] = fastTs;
      } else {
        var values = new Float64Array(length);
        for (var rowIndex = 0; rowIndex < length; ++rowIndex) {
          values[rowIndex] = normalizeTimestampValue(sourceColumn == null ? undefined : getValueByKind(sourceColumn, rowIndex, sourceKind));
        }
        columns[outputName] = values;
      }
    } else if (transform === 'number') {
      var fastNum = extractArrowNumericChunks(sourceColumn, length, 'number');
      if (fastNum) {
        columns[outputName] = fastNum;
      } else {
        values = new Float64Array(length);
        for (rowIndex = 0; rowIndex < length; ++rowIndex) {
          values[rowIndex] = normalizeNumericValue(sourceColumn == null ? undefined : getValueByKind(sourceColumn, rowIndex, sourceKind));
        }
        columns[outputName] = values;
      }
    } else if (transform === 'boolean') {
      var fastBool = extractArrowBoolColumn(sourceColumn, length);
      if (fastBool) {
        columns[outputName] = fastBool;
      } else {
        values = new Array(length);
        for (rowIndex = 0; rowIndex < length; ++rowIndex) {
          values[rowIndex] = normalizeBooleanValue(sourceColumn == null ? undefined : getValueByKind(sourceColumn, rowIndex, sourceKind));
        }
        columns[outputName] = values;
      }
    } else if (transform === 'constantOne') {
      values = new Float64Array(length);
      values.fill(1);
      columns[outputName] = values;
    } else {
      var fastRaw = extractArrowNumericChunks(sourceColumn, length, 'raw');
      columns[outputName] = fastRaw || sourceColumn;
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
      return {
        message: parsed && (parsed.error || parsed.message) ? String(parsed.error || parsed.message) : text,
        code: parsed && typeof parsed.code === 'string' ? parsed.code : null
      };
    } catch (_) {
      return { message: text, code: null };
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
function reserveInput(kind, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid input ' + kind + ' count.');
  var limit = runtimeConfig[kind === 'rows' ? 'maxRows' : 'maxBytes'];
  var key = kind === 'rows' ? 'inputRows' : 'inputBytes';
  var next = runtimeConfig[key] + amount;
  if (limit != null && next > limit) {
    throw Object.assign(new Error('Dashboard input ' + kind + ' budget exceeded (' + next + ' > ' + limit + ').'), {
      code: kind === 'rows' ? 'dashboard_input_rows_exceeded' : 'dashboard_input_bytes_exceeded',
      status: 413
    });
  }
  runtimeConfig[key] = next;
}
async function* responseChunks(sourceId, response) {
  var sourceProgress = progress.sources[sourceId];
  if (!response.body || typeof response.body.getReader !== 'function') {
    if (runtimeConfig.maxBytes != null) throw new Error('Byte-bounded loading requires a readable response body.');
    var buffer = await response.arrayBuffer();
    reserveInput('bytes', buffer.byteLength);
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
      reserveInput('bytes', value.byteLength || value.length || 0);
      sourceProgress.bytesLoaded += value.byteLength || value.length || 0;
      sourceProgress.status = 'downloading';
      publishProgress('downloading', false);
      yield value;
    }
  } catch (error) {
    if (reader.cancel) await reader.cancel(error).catch(function() {});
    throw error;
  } finally {
    if (reader.releaseLock) reader.releaseLock();
  }
}
// Issues a source's request. Called for every URL source as streaming starts, before the
// libraries load, so the data is on its way while the import blocks. Nothing else moves:
// progress events and reading the response stay where they were, in getSourceInput.
function requestSource(source) {
  var controller = typeof AbortController === 'function' ? new AbortController() : null;
  var fetchInit = source.dataFetchInit || {};
  if (controller) {
    fetchInit = Object.assign({}, fetchInit, { signal: controller.signal });
    abortControllers.push(controller);
  }
  var response = sourceResponses[source.id] = fetch(source.dataUrl, fetchInit);
  // A failure before getSourceInput awaits it is getSourceInput's to report, not an unhandled rejection.
  response.catch(function() {});
  return response;
}
async function getSourceInput(source) {
  var sourceProgress = progress.sources[source.id];
  if (source.dataUrl) {
    sourceProgress.status = 'requesting';
    publishProgress('starting', true);
    var response = await (sourceResponses[source.id] || requestSource(source));
    if (!response.ok) {
      var responseErrorDetail = await readResponseErrorDetail(response);
      var responseError = new Error('Failed to fetch Arrow stream for ' + source.id + ': ' + response.status + ' ' + response.statusText + (responseErrorDetail ? ' — ' + responseErrorDetail.message : ''));
      responseError.status = response.status;
      responseError.code = responseErrorDetail ? responseErrorDetail.code : null;
      throw responseError;
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
  reserveInput('bytes', source.arrowBuffer.byteLength);
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
    reserveInput('rows', batch.numRows);
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
    reserveInput('rows', batch.numRows);
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
function resolveArrowDictForLookup(column, length) {
  if (!column || !Array.isArray(column.data) || !column.data.length) return null;
  var chunks = column.data;
  var total = 0;
  for (var c = 0; c < chunks.length; ++c) {
    var ch = chunks[c];
    if (!ch || !ch.dictionary || typeof ch.dictionary.get !== 'function' || !ArrayBuffer.isView(ch.values) || ch.values.length < ch.length || !hasValidNullBitmap(ch)) {
      return null;
    }
    total += ch.length;
  }
  return total === length ? chunks : null;
}
async function buildLookupIndexFromSource(source) {
  var arrow = self.Arrow;
  var RecordBatchReader = getRecordBatchReader(arrow);
  var sourceProgress = progress.sources[source.id];
  var reader = await RecordBatchReader.from(await getSourceInput(source));
  var index = new Map();
  var keyFields = source.lookup.keyFields;
  var singleKey = keyFields.length === 1;
  var valueFields = source.lookup.valueFields.slice();
  var valueCount = valueFields.length;
  var valueKinds = new Array(valueCount);

  for await (var batch of reader) {
    reserveInput('rows', batch.numRows);
    var projected = projectBatch(batch, source.projection);
    var keyKinds = new Array(keyFields.length);
    var keyCols = new Array(keyFields.length);
    for (var ki = 0; ki < keyFields.length; ++ki) {
      keyCols[ki] = projected.columns[keyFields[ki]];
      keyKinds[ki] = resolveColumnAccessor(keyCols[ki]);
    }
    var valKinds = new Array(valueCount);
    var valCols = new Array(valueCount);
    for (var vi = 0; vi < valueCount; ++vi) {
      valCols[vi] = projected.columns[valueFields[vi]];
      valKinds[vi] = resolveColumnAccessor(valCols[vi]);
    }

    var singleKeyCol = singleKey ? keyCols[0] : null;
    var singleKeyKind = singleKey ? keyKinds[0] : null;
    for (var rowIndex = 0; rowIndex < projected.length; ++rowIndex) {
      var key;
      if (singleKey) {
        var rawK = singleKeyCol == null ? undefined : getValueByKind(singleKeyCol, rowIndex, singleKeyKind);
        key = rawK == null ? '' : (typeof rawK === 'string' ? rawK : String(rawK));
      } else {
        key = buildLookupKeyResolved(projected.columns, keyFields, keyKinds, rowIndex);
      }
      if (index.has(key)) {
        continue;
      }
      var values = new Array(valueCount);
      for (var valueIndex = 0; valueIndex < valueCount; ++valueIndex) {
        var valCol = valCols[valueIndex];
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
    keyFields: keyFields.slice(),
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
      var valueCount = lookup.valueFields.length;
      var targetCols = new Array(valueCount);

      for (var valueFieldIndex = 0; valueFieldIndex < valueCount; ++valueFieldIndex) {
        var valueField = lookup.valueFields[valueFieldIndex];
        targetCols[valueFieldIndex] = allocateLookupColumn(batch.length, lookup.valueKinds[valueFieldIndex]);
        if (batch.fields.indexOf(valueField) < 0) {
          batch.fields.push(valueField);
        }
      }

      var lookupIndexMap = lookup.index;
      var singleKey = lookup.keyFields.length === 1;
      var keyCol0 = singleKey ? batch.columns[lookup.keyFields[0]] : null;
      var dictChunks = singleKey ? resolveArrowDictForLookup(keyCol0, batch.length) : null;
      var rowIndex, fieldIndex, values;

      if (dictChunks) {
        var nullHit = lookupIndexMap.get('');
        var outRow = 0;
        for (var ci = 0; ci < dictChunks.length; ++ci) {
          var ch = dictChunks[ci];
          var dict = ch.dictionary;
          var dictLen = dict.length;
          var dictHits = new Array(dictLen);
          for (var di = 0; di < dictLen; ++di) {
            var dk = dict.get(di);
            dictHits[di] = lookupIndexMap.get(dk == null ? '' : (typeof dk === 'string' ? dk : String(dk)));
          }
          var indices = ch.values;
          var chLen = ch.length;
          var nullBitmap = ch.nullCount > 0 ? ch.nullBitmap : null;
          var chOff = typeof ch.offset === 'number' ? ch.offset : 0;
          if (!nullBitmap) {
            for (var j = 0; j < chLen; ++j) {
              values = dictHits[indices[j]];
              if (values) {
                for (fieldIndex = 0; fieldIndex < valueCount; ++fieldIndex) {
                  targetCols[fieldIndex][outRow] = values[fieldIndex];
                }
              }
              ++outRow;
            }
          } else {
            for (var j2 = 0; j2 < chLen; ++j2) {
              var bIdx = chOff + j2;
              values = (nullBitmap[bIdx >>> 3] & (1 << (bIdx & 7))) ? dictHits[indices[j2]] : nullHit;
              if (values) {
                for (fieldIndex = 0; fieldIndex < valueCount; ++fieldIndex) {
                  targetCols[fieldIndex][outRow] = values[fieldIndex];
                }
              }
              ++outRow;
            }
          }
        }
      } else if (singleKey) {
        var keyKind0 = resolveColumnAccessor(keyCol0);
        for (rowIndex = 0; rowIndex < batch.length; ++rowIndex) {
          var rawKey = keyCol0 == null ? undefined : getValueByKind(keyCol0, rowIndex, keyKind0);
          var keyStr = rawKey == null ? '' : (typeof rawKey === 'string' ? rawKey : String(rawKey));
          values = lookupIndexMap.get(keyStr);
          if (!values) continue;
          for (fieldIndex = 0; fieldIndex < valueCount; ++fieldIndex) {
            targetCols[fieldIndex][rowIndex] = values[fieldIndex];
          }
        }
      } else {
        var lookupKeyKinds = new Array(lookup.keyFields.length);
        for (var ki = 0; ki < lookup.keyFields.length; ++ki) {
          lookupKeyKinds[ki] = resolveColumnAccessor(batch.columns[lookup.keyFields[ki]]);
        }
        for (rowIndex = 0; rowIndex < batch.length; ++rowIndex) {
          values = lookupIndexMap.get(buildLookupKeyResolved(batch.columns, lookup.keyFields, lookupKeyKinds, rowIndex));
          if (!values) continue;
          for (fieldIndex = 0; fieldIndex < valueCount; ++fieldIndex) {
            targetCols[fieldIndex][rowIndex] = values[fieldIndex];
          }
        }
      }

      for (fieldIndex = 0; fieldIndex < valueCount; ++fieldIndex) {
        batch.columns[lookup.valueFields[fieldIndex]] = targetCols[fieldIndex];
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

  abortControllers = [];
  sourceResponses = Object.create(null);
  for (var requestIndex = 0; requestIndex < sources.length; ++requestIndex) {
    if (sources[requestIndex].dataUrl) requestSource(sources[requestIndex]);
  }

  try {
    ensureRuntimeScripts();
    var RecordBatchReader = getRecordBatchReader(self.Arrow);
    if (!RecordBatchReader || !RecordBatchReader.from) {
      throw new Error('Apache Arrow RecordBatchReader is not available in the worker.');
    }
  } catch (error) {
    // The libraries are missing or unusable, so there is no runtime info to report progress
    // with: abort what was asked for and say why. The caller does not await this function, so
    // a throw from here would reach no one.
    releaseAbortControllers();
    publish('error', { message: String(error && error.message || error), code: null, status: null, stack: error && error.stack ? String(error.stack) : null });
    return;
  }

  progress = {
    emitSnapshots: payload.emitSnapshots === true,
    progressThrottleMs: typeof payload.progressThrottleMs === 'number' ? payload.progressThrottleMs : 100,
    ready: false,
    snapshotThrottleMs: typeof payload.snapshotThrottleMs === 'number' ? payload.snapshotThrottleMs : 250,
    sources: {}
  };

  progressTimer = 0;
  snapshotTimer = 0;

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
    releaseAbortControllers();
    if (runtime) runtime.dispose();
    runtime = null;
    if (error && error.name === 'AbortError') {
      publishProgress('aborted', true);
      return;
    }
    publish('error', Object.assign(progressPayload('error'), {
      message: String(error && error.message || error),
      code: error && typeof error.code === 'string' ? error.code : null,
      status: error && typeof error.status === 'number' ? error.status : null,
      stack: error && error.stack ? String(error.stack) : null
    }));
  }
}
self.onmessage = async function(event) {
  var message = event.data || {};
  var id = message.id;
  try {
    if (message.type !== 'initStreaming' && message.type !== 'dispose') {
      if (!runtime) throw new Error('Streaming dashboard worker is not initialized.');
    }
    switch (message.type) {
      case 'initStreaming': {
        runtimeConfig = {
          maxRows: message.payload.maxRows,
          maxBytes: message.payload.maxBytes,
          inputRows: 0,
          inputBytes: 0,
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
        respond(id, runtime.snapshot(message.payload.filters, message.payload.options || null));
        return;
      case 'groups':
        respond(id, runtime.groups(message.payload.request));
        return;
      case 'bounds':
        respond(id, runtime.bounds(message.payload.request));
        return;
      case 'query':
        respond(id, runtime.query(message.payload.request));
        return;
      case 'append':
        respond(id, runtime.append(message.payload.records || []));
        return;
      case 'updateFilters':
        respond(id, runtime.updateFilters(message.payload.filters));
        return;
      case 'createGroup':
        respond(id, runtime.createGroup(message.payload.spec));
        return;
      case 'disposeGroup':
        respond(id, runtime.disposeGroup(message.payload.id));
        return;
      case 'rows':
        respond(id, runtime.rows(message.payload.query));
        return;
      case 'rowSets':
        respond(id, runtime.rowSets(message.payload.request));
        return;
      case 'removeFiltered':
        respond(id, runtime.removeFiltered(message.payload.selection));
        return;
      case 'reset':
        respond(id, runtime.reset());
        return;
      case 'runtimeInfo':
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
  for (var limitName of ['maxRows', 'maxBytes']) {
    if (options[limitName] != null && (!Number.isSafeInteger(options[limitName]) || options[limitName] < 1)) {
      throw new Error(limitName + ' must be a positive safe integer.');
    }
  }

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
  var latestEvents = Object.create(null);
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
    latestEvents[eventType] = payload;
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
        readyReject(Object.assign(new Error(message.payload && message.payload.message || "Streaming dashboard worker failed."), {
          code: message.payload && message.payload.code,
          status: message.payload && message.payload.status
        }));
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
    error.code = message.error && message.error.code;
    error.status = message.error && message.error.status;
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
    maxRows: options.maxRows,
    maxBytes: options.maxBytes,
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
        if (Object.prototype.hasOwnProperty.call(latestEvents, eventType)) {
          listener(latestEvents[eventType]);
        }
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
      createGroup: function(spec) {
        return call("createGroup", { spec: spec });
      },
      disposeGroup: function(groupId) {
        return call("disposeGroup", { id: groupId });
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
var EMPTY_ARRAY = [];
var utf8FatalDecoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8', { fatal: true }) : null;
var utf8Decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;

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
    runtimeInfo: runtimeController.runtimeInfo,
    _filteredCount: filteredCount,
    _filteredIndexesSlice: filteredIndexesSlice,
    _flushGroups: flushGroups,
    _materializeRowsByIndex: materializeRowsByIndex,
    _withTransientFilters: withTransientFilters
  };

  var data = [], // the records
      n = 0, // the number of records; data.length
      filterStore = createFilterBitsetStore(), // per-dimension 1-bit filter bitsets
      filterListeners = [], // when the filters change
      dataListeners = [], // when data is added
      removeDataListeners = [], // when data is removed
      resetListeners = [],
      callbacks = [],
      columnarBatches = [],
      anyRowMaterialized = false,
      lazyDimensionsByField = Object.create(null),
      numericColumns = Object.create(null),
      splitColumns = Object.create(null),
      activeRowsDirty = true,
      activeCountDirty = true,
      activeCountCached = 0,
      activeRowsBuf = new Uint32Array(0),
      activeRowsLength = 0,
      excludedRowsBuf = new Uint32Array(0),
      dimActiveRowsBuf = new Uint32Array(0),
      deltaAddedBuf = new Uint32Array(0),
      deltaRemovedBuf = new Uint32Array(0),
      deltaWorkBuf = new Uint32Array(0),
      deltaBufInUse = false,
      batchedFilterDepth = 0,
      batchedFilterEventPending = false,
      batchedFilterResetPending = false,
      transientFilterDepth = 0,
      brushDimSlot = null,
      brushActive = false,
      brushQueryKind = null,
      brushLo = 0,
      brushHi = 0,
      brushDimSource = null,
      brushFalcon = null,
      brushBuildFailed = false;

  function invalidateBrushState() {
    brushDimSlot = null;
    brushActive = false;
    brushQueryKind = null;
    brushDimSource = null;
    brushFalcon = null;
    brushBuildFailed = false;
  }

  function ensureUint32Capacity(buf, required) {
    if (buf.length >= required) return buf;
    var nextSize = buf.length || 256;
    while (nextSize < required) nextSize <<= 1;
    return new Uint32Array(nextSize);
  }

  var objToString = Object.prototype.toString;

  function isGuaranteedFiniteTypedArray(col) {
    if (!ArrayBuffer.isView(col)) return false;
    var tag = objToString.call(col);
    return tag === '[object Int32Array]'
      || tag === '[object Uint32Array]'
      || tag === '[object Int16Array]'
      || tag === '[object Uint16Array]'
      || tag === '[object Int8Array]'
      || tag === '[object Uint8Array]'
      || tag === '[object Uint8ClampedArray]';
  }

  function isFloatTypedArray(col) {
    if (!ArrayBuffer.isView(col)) return false;
    var tag = objToString.call(col);
    return tag === '[object Float64Array]' || tag === '[object Float32Array]';
  }

  function hasValidArrowNullBitmap(chunk) {
    if (!chunk || chunk.nullCount === 0) return true;
    if (!chunk.nullBitmap || typeof chunk.nullBitmap.length !== 'number') return false;
    var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
    return chunk.nullBitmap.length >= ((chunkOff + chunk.length + 7) >>> 3);
  }

  function resolveArrowDictionaryChunks(col) {
    if (!col || !Array.isArray(col.data) || !col.data.length) return null;
    var chunks = col.data;
    var total = 0;
    for (var c = 0; c < chunks.length; ++c) {
      var chunk = chunks[c];
      if (
        !chunk
        || !chunk.dictionary
        || typeof chunk.dictionary.get !== 'function'
        || typeof chunk.dictionary.length !== 'number'
        || !isGuaranteedFiniteTypedArray(chunk.values)
        || chunk.values.length < chunk.length
        || !hasValidArrowNullBitmap(chunk)
      ) {
        return null;
      }
      total += chunk.length;
    }
    if (typeof col.length === 'number' && total !== col.length) return null;
    return chunks;
  }

  function resolveArrowNumericChunks(col) {
    if (!col || !Array.isArray(col.data) || !col.data.length) return null;
    var colType = col.type || col.data[0].type;
    if (!colType) return null;
    var typeId = colType.typeId;
    if (typeId === 2) {
      if (!(colType.bitWidth > 0 && colType.bitWidth <= 32)) return null;
    } else if (typeId === 3) {
      if (!(colType.precision >= 1)) return null;
    } else {
      return null;
    }
    var chunks = col.data;
    var total = 0;
    for (var c = 0; c < chunks.length; ++c) {
      var chunk = chunks[c];
      if (
        !chunk
        || chunk.dictionary
        || !(isGuaranteedFiniteTypedArray(chunk.values) || isFloatTypedArray(chunk.values))
        || chunk.values.length < chunk.length
        || !hasValidArrowNullBitmap(chunk)
      ) {
        return null;
      }
      total += chunk.length;
    }
    if (typeof col.length === 'number' && total !== col.length) return null;
    return chunks;
  }

  function isBigIntTypedArray(col) {
    if (!ArrayBuffer.isView(col)) return false;
    var tag = objToString.call(col);
    return tag === '[object BigInt64Array]' || tag === '[object BigUint64Array]';
  }

  function resolveArrowTemporalChunks(col) {
    if (!col || !Array.isArray(col.data) || !col.data.length) return null;
    var colType = col.type || col.data[0].type;
    if (!colType) return null;
    var typeId = colType.typeId;
    if (typeId !== 8 && typeId !== 10) return null;
    var unit = typeof colType.unit === 'number' ? colType.unit : -1;
    var scaleMul = 1;
    var scaleDiv = 1;
    if (typeId === 8) {
      if (unit === 0) scaleMul = 86400000;
      else if (unit !== 1) return null;
    } else {
      if (unit === 0) scaleMul = 1000;
      else if (unit === 1) scaleMul = 1;
      else if (unit === 2) scaleDiv = 1000;
      else if (unit === 3) scaleDiv = 1000000;
      else return null;
    }
    var chunks = col.data;
    var total = 0;
    for (var c = 0; c < chunks.length; ++c) {
      var chunk = chunks[c];
      if (!chunk || chunk.dictionary || chunk.values == null || chunk.values.length < chunk.length || !hasValidArrowNullBitmap(chunk)) {
        return null;
      }
      if (typeId === 8 && unit === 0) {
        if (!isGuaranteedFiniteTypedArray(chunk.values)) return null;
      } else if (!isBigIntTypedArray(chunk.values) && !isGuaranteedFiniteTypedArray(chunk.values) && !isFloatTypedArray(chunk.values)) {
        return null;
      }
      total += chunk.length;
    }
    if (typeof col.length === 'number' && total !== col.length) return null;
    return { chunks: chunks, scaleDiv: scaleDiv, scaleMul: scaleMul };
  }

  function resolveArrowUtf8Chunks(col) {
    if (!utf8Decoder || !col || !Array.isArray(col.data) || !col.data.length) return null;
    var colType = col.type || col.data[0].type;
    if (!colType || colType.typeId !== 5) return null;
    var chunks = col.data;
    var total = 0;
    for (var c = 0; c < chunks.length; ++c) {
      var chunk = chunks[c];
      if (
        !chunk
        || !ArrayBuffer.isView(chunk.values)
        || !ArrayBuffer.isView(chunk.valueOffsets)
        || chunk.valueOffsets.length <= chunk.length
        || !hasValidArrowNullBitmap(chunk)
      ) {
        return null;
      }
      total += chunk.length;
    }
    if (typeof col.length === 'number' && total !== col.length) return null;
    return chunks;
  }

  function extractArrowUtf8Range(chunks, startOffset, length) {
    var out = new Array(length);
    var localEnd = startOffset + length;
    var chunkStart = 0;
    var outIdx = 0;
    for (var c = 0; c < chunks.length && outIdx < length; ++c) {
      var chunk = chunks[c];
      var chunkEnd = chunkStart + chunk.length;
      if (chunkEnd <= startOffset) {
        chunkStart = chunkEnd;
        continue;
      }
      if (chunkStart >= localEnd) break;
      var subStart = startOffset > chunkStart ? startOffset - chunkStart : 0;
      var subEnd = localEnd < chunkEnd ? localEnd - chunkStart : chunk.length;
      var vo = chunk.valueOffsets;
      var bytes = chunk.values;
      var base = vo[subStart];
      var end = vo[subEnd];
      var byteLen = end - base;
      var nullBitmap = chunk.nullCount > 0 ? chunk.nullBitmap : null;
      var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
      var asciiStr = null;
      if (utf8FatalDecoder && byteLen >= 0) {
        try {
          var decoded = utf8FatalDecoder.decode(bytes.subarray(base, end));
          if (decoded.length === byteLen) asciiStr = decoded;
        } catch (e) { /* fall back to per-entry UTF-8 decode */ }
      }
      var j, bitIdx;
      if (asciiStr !== null) {
        if (!nullBitmap) {
          for (j = subStart; j < subEnd; ++j) {
            out[outIdx++] = asciiStr.slice(vo[j] - base, vo[j + 1] - base);
          }
        } else {
          for (j = subStart; j < subEnd; ++j) {
            bitIdx = chunkOff + j;
            out[outIdx++] = (nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))
              ? asciiStr.slice(vo[j] - base, vo[j + 1] - base)
              : null;
          }
        }
      } else if (!nullBitmap) {
        for (j = subStart; j < subEnd; ++j) {
          out[outIdx++] = utf8Decoder.decode(bytes.subarray(vo[j], vo[j + 1]));
        }
      } else {
        for (j = subStart; j < subEnd; ++j) {
          bitIdx = chunkOff + j;
          out[outIdx++] = (nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))
            ? utf8Decoder.decode(bytes.subarray(vo[j], vo[j + 1]))
            : null;
        }
      }
      chunkStart = chunkEnd;
    }
    return outIdx === length ? out : null;
  }

  function isPureNumericColumnSource(field) {
    if (!n || !columnarBatches.length) return false;
    var expectedStart = 0;
    for (var b = 0; b < columnarBatches.length; ++b) {
      var batch = columnarBatches[b];
      if (batch.start !== expectedStart) return false;
      expectedStart = batch.end;
      var col = batch.columns[field];
      if (isFloatTypedArray(col) || isGuaranteedFiniteTypedArray(col)) {
        continue;
      }
      var arrowChunks = resolveArrowNumericChunks(col);
      if (arrowChunks) {
        for (var c = 0; c < arrowChunks.length; ++c) {
          if (arrowChunks[c].nullCount !== 0) {
            return false;
          }
        }
        continue;
      }
      var temporal = resolveArrowTemporalChunks(col);
      if (temporal) {
        for (var tc = 0; tc < temporal.chunks.length; ++tc) {
          if (temporal.chunks[tc].nullCount !== 0) {
            return false;
          }
        }
        continue;
      }
      return false;
    }
    return expectedStart === n;
  }

  function getActiveRows() {
    if (!filterStore.hasAnyActive()) {
      return null;
    }
    if (activeRowsDirty) {
      activeRowsBuf = ensureUint32Capacity(activeRowsBuf, n);
      var count = filterStore.extractActive(activeRowsBuf, null);
      if (count < 0) {
        activeRowsLength = n;
        activeCountCached = n;
        activeCountDirty = false;
        activeRowsDirty = false;
        return null;
      }
      activeRowsLength = count;
      activeCountCached = count;
      activeCountDirty = false;
      activeRowsDirty = false;
    }
    return { indices: activeRowsBuf, length: activeRowsLength };
  }

  function getExcludedRows(ignoreSlot) {
    if (!filterStore.hasAnyActive()) {
      return { indices: excludedRowsBuf, length: 0 };
    }
    excludedRowsBuf = ensureUint32Capacity(excludedRowsBuf, n);
    var count = filterStore.extractExcluded(excludedRowsBuf, ignoreSlot || null);
    return { indices: excludedRowsBuf, length: count };
  }

  function filteredCount() {
    if (!filterStore.hasAnyActive()) {
      return n;
    }
    if (!activeRowsDirty) {
      return activeRowsLength;
    }
    if (activeCountDirty) {
      if (brushActive && brushFalcon && transientFilterDepth === 0) {
        activeCountCached = brushFalcon.queryCount(brushQueryKind, brushLo, brushHi);
      } else {
        activeCountCached = filterStore.countActive(null);
      }
      activeCountDirty = false;
    }
    return activeCountCached;
  }

  function filteredIndexesSlice(startOffset, limitCount) {
    var start = startOffset && startOffset > 0 ? startOffset : 0;
    var limit = limitCount == null ? n : limitCount;
    var end, len, out, i;
    if (limit <= 0) {
      return [];
    }
    if (!filterStore.hasAnyActive()) {
      if (start >= n) return [];
      end = Math.min(n, start + limit);
      len = end - start;
      out = new Array(len);
      for (i = 0; i < len; ++i) out[i] = start + i;
      return out;
    }
    var active = getActiveRows();
    if (!active) {
      if (start >= n) return [];
      end = Math.min(n, start + limit);
      len = end - start;
      out = new Array(len);
      for (i = 0; i < len; ++i) out[i] = start + i;
      return out;
    }
    if (start >= active.length) return [];
    end = Math.min(active.length, start + limit);
    len = end - start;
    out = new Array(len);
    var indices = active.indices;
    for (i = 0; i < len; ++i) out[i] = indices[start + i];
    return out;
  }

  function collectZeroExceptRows(dimSlot) {
    dimActiveRowsBuf = ensureUint32Capacity(dimActiveRowsBuf, n);
    var count = filterStore.extractActive(dimActiveRowsBuf, dimSlot);
    if (count < 0) {
      return null;
    }
    return { indices: dimActiveRowsBuf, length: count };
  }

  function flushGroups(rawGroups, kpiGroup) {
    if (!n) return;
    var gLen = rawGroups ? rawGroups.length : 0;
    if (!gLen && !kpiGroup) return;

    var kpiInfo = (kpiGroup && typeof kpiGroup._coScanInfo === 'function') ? kpiGroup._coScanInfo() : null;
    var kpiUsed = false;

    // Falcon prefix-sum brush fast path (handles all low/medium-card charts + KPI in O(slots)!)
    if (brushActive && brushDimSlot && transientFilterDepth === 0) {
      var falconTargets = [];
      for (var fgi = 0; fgi < gLen; ++fgi) {
        var fg = rawGroups[fgi];
        if (!fg || typeof fg._coScanInfo !== 'function') continue;
        var finfo = fg._coScanInfo();
        if (finfo && finfo.usesGlobalActive) {
          falconTargets.push(finfo);
        }
      }
      var falconKpi = (kpiInfo && !kpiInfo.unfiltered) ? kpiInfo : null;
      if (!brushFalcon && !brushBuildFailed && (falconTargets.length > 0 || falconKpi)) {
        var baseRows = filterStore.hasOtherActive(brushDimSlot) ? collectZeroExceptRows(brushDimSlot) : null;
        brushFalcon = createFalconBrushCache(brushDimSource(), baseRows, n, falconTargets, falconKpi, getNumericColumn);
        if (!brushFalcon) {
          brushBuildFailed = true;
          brushActive = false;
        }
      }
      if (brushFalcon && (falconTargets.length > 0 || falconKpi)) {
        var fRes = brushFalcon.applyQueryBatch(brushQueryKind, brushLo, brushHi, falconTargets, falconKpi);
        activeCountCached = fRes.totalCount;
        activeCountDirty = false;
        if (fRes.kpiApplied) kpiUsed = true;
        if (fRes.appliedCount === falconTargets.length && (!falconKpi || fRes.kpiApplied)) {
          // Check if any unfiltered or self-filtered dirty groups still remain
          var anyRemaining = false;
          for (var rci = 0; rci < gLen; ++rci) {
            var rg = rawGroups[rci];
            if (rg && typeof rg._coScanInfo === 'function' && rg._coScanInfo()) {
              anyRemaining = true;
              break;
            }
          }
          if (!anyRemaining) return;
        }
      }
    }

    var unfilteredByKey = Object.create(null);
    var unfilteredKeys = [];
    var filteredByKey = Object.create(null);
    var filteredKeys = [];
    var i, info, key, list;

    for (i = 0; i < gLen; ++i) {
      var g = rawGroups[i];
      if (!g || typeof g._coScanInfo !== 'function') continue;
      info = g._coScanInfo();
      if (!info) continue;
      if (info.unfiltered) {
        if (info.tryRestoreUnfiltered()) {
          info.commit(false);
          continue;
        }
        key = info.coScanKey;
        list = unfilteredByKey[key];
        if (!list) {
          list = [];
          unfilteredByKey[key] = list;
          unfilteredKeys.push(key);
        }
        list.push(info);
      } else if (info.usesGlobalActive) {
        key = info.coScanKey;
        list = filteredByKey[key];
        if (!list) {
          list = [];
          filteredByKey[key] = list;
          filteredKeys.push(key);
        }
        list.push(info);
      }
    }

    for (i = 0; i < unfilteredKeys.length; ++i) {
      var uKey = unfilteredKeys[i];
      list = unfilteredByKey[uKey];
      var matchKpiUnf = null;
      if (kpiInfo && !kpiUsed && kpiInfo.unfiltered && kpiInfo.coScanKey === uKey) {
        if (kpiInfo.tryRestoreUnfiltered()) {
          kpiInfo.commit(false);
          kpiUsed = true;
        } else {
          kpiInfo.prepareZero();
          matchKpiUnf = kpiInfo;
          kpiUsed = true;
        }
      }
      if (list.length >= 2 || matchKpiUnf) {
        for (var ui = 0; ui < list.length; ++ui) list[ui].prepareZero();
        reduceMultiGroupsAll(list, matchKpiUnf ? matchKpiUnf.buffers : null, list[0].plan, getNumericColumn, n);
        for (var uc = 0; uc < list.length; ++uc) list[uc].commit(true);
        if (matchKpiUnf) matchKpiUnf.commit(true);
      }
    }

    if (filteredKeys.length > 0) {
      var activeCnt = filteredCount();
      if (activeCnt === 0) {
        for (i = 0; i < filteredKeys.length; ++i) {
          list = filteredByKey[filteredKeys[i]];
          for (var zi = 0; zi < list.length; ++zi) {
            list[zi].prepareZero();
            list[zi].commit(false);
          }
        }
        if (kpiInfo && !kpiUsed && !kpiInfo.unfiltered) {
          kpiInfo.prepareZero();
          kpiInfo.commit(false);
          kpiUsed = true;
        }
        return;
      }

      var tryComp = activeCnt > (n >>> 1);
      var activeRows = null;
      var excludedRows = null;

      for (i = 0; i < filteredKeys.length; ++i) {
        var fKey = filteredKeys[i];
        list = filteredByKey[fKey];
        var plan = list[0].plan;
        var canCompPlan = tryComp && canPlanUseComplement(plan, getNumericColumn);

        var compList = null;
        var directList = null;
        if (canCompPlan) {
          compList = [];
          directList = [];
          for (var fi = 0; fi < list.length; ++fi) {
            if (list[fi].canComplement()) compList.push(list[fi]);
            else directList.push(list[fi]);
          }
        } else {
          directList = list;
        }

        if (compList && compList.length > 0) {
          if (activeCnt === n) {
            for (var ri = 0; ri < compList.length; ++ri) {
              compList[ri].tryRestoreUnfiltered();
              compList[ri].commit(false);
            }
            if (kpiInfo && !kpiUsed && !kpiInfo.unfiltered && kpiInfo.coScanKey === fKey && kpiInfo.canComplement()) {
              kpiInfo.tryRestoreUnfiltered();
              kpiInfo.commit(false);
              kpiUsed = true;
            }
          } else {
            var matchKpiComp = null;
            if (kpiInfo && !kpiUsed && !kpiInfo.unfiltered && kpiInfo.coScanKey === fKey && kpiInfo.canComplement()) {
              kpiInfo.tryRestoreUnfiltered(true);
              matchKpiComp = kpiInfo;
              kpiUsed = true;
            }
            if (compList.length >= 2 || matchKpiComp) {
              if (!excludedRows) excludedRows = getExcludedRows(null);
              for (var ci = 0; ci < compList.length; ++ci) compList[ci].tryRestoreUnfiltered(true);
              reduceMultiGroupsIndexed(compList, matchKpiComp ? matchKpiComp.buffers : null, plan, getNumericColumn, excludedRows.indices, excludedRows.length, -1);
              for (var cc = 0; cc < compList.length; ++cc) {
                compList[cc].cleanupComplement(excludedRows.indices, excludedRows.length);
                compList[cc].commit(false);
              }
              if (matchKpiComp) matchKpiComp.commit(false);
            }
          }
        }

        if (directList && directList.length > 0) {
          var matchKpiDir = null;
          if (kpiInfo && !kpiUsed && !kpiInfo.unfiltered && kpiInfo.coScanKey === fKey) {
            kpiInfo.prepareZero();
            matchKpiDir = kpiInfo;
            kpiUsed = true;
          }
          if (directList.length >= 2 || matchKpiDir) {
            if (!activeRows) activeRows = getActiveRows();
            if (activeRows) {
              for (var di = 0; di < directList.length; ++di) directList[di].prepareZero();
              reduceMultiGroupsIndexed(directList, matchKpiDir ? matchKpiDir.buffers : null, plan, getNumericColumn, activeRows.indices, activeRows.length, 1);
              for (var dc = 0; dc < directList.length; ++dc) directList[dc].commit(false);
              if (matchKpiDir) matchKpiDir.commit(false);
            }
          }
        }
      }
    }
  }

  function fillNumericFromRows(dest, entry, field, start, end) {
    var i, row, raw;
    for (i = start; i < end; ++i) {
      row = getRecord(i);
      raw = row ? row[field] : undefined;
      if (typeof raw === 'number' && raw === raw && raw !== Infinity && raw !== -Infinity) {
        dest[i] = raw;
        if (raw > 1e12 || raw < -1e12) entry.hasExtreme = true;
      } else {
        dest[i] = NaN;
        entry.hasNaN = true;
      }
    }
  }

  function getNumericColumn(field) {
    var entry = numericColumns[field];
    if (!entry) {
      if (n > 0 && columnarBatches.length === 1 && columnarBatches[0].start === 0 && columnarBatches[0].end === n) {
        var onlyCol = columnarBatches[0].columns[field];
        var directF64 = null;
        if (ArrayBuffer.isView(onlyCol) && objToString.call(onlyCol) === '[object Float64Array]') {
          directF64 = onlyCol;
        } else {
          var onlyArrow = resolveArrowNumericChunks(onlyCol);
          if (onlyArrow && onlyArrow.length === 1 && onlyArrow[0].nullCount === 0 && objToString.call(onlyArrow[0].values) === '[object Float64Array]') {
            directF64 = onlyArrow[0].values;
          }
        }
        if (directF64 && directF64.length >= n) {
          var nonFiniteFound = false;
          var extremeFound = false;
          for (var fi = 0; fi < n; ++fi) {
            var fv = directF64[fi];
            if (fv - fv !== 0) {
              nonFiniteFound = true;
              break;
            }
            if (fv > 1e12 || fv < -1e12) extremeFound = true;
          }
          if (!nonFiniteFound) {
            entry = { values: directF64, hasNaN: false, hasExtreme: extremeFound, length: n, shared: true };
            numericColumns[field] = entry;
            return entry;
          }
        }
      }
      var initCap = n < 64 ? 64 : n;
      entry = { values: new Float64Array(initCap), hasNaN: false, hasExtreme: false, length: 0, shared: false };
      numericColumns[field] = entry;
    }
    if (entry.length >= n) {
      return entry;
    }

    var values = entry.values;
    if (entry.shared || values.length < n) {
      var nextCap = values.length || 64;
      while (nextCap < n) nextCap <<= 1;
      var nextValues = new Float64Array(nextCap);
      if (entry.length > 0) {
        nextValues.set(values.subarray(0, entry.length));
      }
      values = entry.values = nextValues;
      entry.shared = false;
    }

    var cursor = entry.length;
    if (!columnarBatches.length) {
      fillNumericFromRows(values, entry, field, cursor, n);
      entry.length = n;
      return entry;
    }

    var batchIndex, batch, segStart, segEnd, localStart, localEnd, col, accessor, i, v, raw;
    for (batchIndex = 0; batchIndex < columnarBatches.length && cursor < n; ++batchIndex) {
      batch = columnarBatches[batchIndex];
      if (batch.end <= cursor) continue;
      if (batch.start >= n) break;
      if (cursor < batch.start) {
        var gapEnd = Math.min(batch.start, n);
        fillNumericFromRows(values, entry, field, cursor, gapEnd);
        cursor = gapEnd;
        if (cursor >= n) break;
      }

      segStart = Math.max(cursor, batch.start);
      segEnd = Math.min(batch.end, n);
      localStart = segStart - batch.start;
      localEnd = segEnd - batch.start;
      col = batch.columns[field];

      if (col != null && isGuaranteedFiniteTypedArray(col)) {
        values.set(col.subarray(localStart, localEnd), segStart);
      } else if (isFloatTypedArray(col)) {
        for (i = localStart; i < localEnd; ++i) {
          v = col[i];
          if (v - v === 0) {
            values[segStart + i - localStart] = v;
            if (v > 1e12 || v < -1e12) entry.hasExtreme = true;
          } else {
            values[segStart + i - localStart] = NaN;
            entry.hasNaN = true;
          }
        }
      } else if (Array.isArray(col)) {
        for (i = localStart; i < localEnd; ++i) {
          raw = col[i];
          if (typeof raw === 'number' && raw - raw === 0) {
            values[segStart + i - localStart] = raw;
            if (raw > 1e12 || raw < -1e12) entry.hasExtreme = true;
          } else {
            values[segStart + i - localStart] = NaN;
            entry.hasNaN = true;
          }
        }
      } else {
        var arrowNumChunks = resolveArrowNumericChunks(col);
        if (arrowNumChunks) {
          var chunkStart = 0;
          for (var cIdx = 0; cIdx < arrowNumChunks.length; ++cIdx) {
            var numChunk = arrowNumChunks[cIdx];
            var chunkEnd = chunkStart + numChunk.length;
            if (chunkEnd <= localStart) {
              chunkStart = chunkEnd;
              continue;
            }
            if (chunkStart >= localEnd) break;
            var subStart = localStart > chunkStart ? localStart - chunkStart : 0;
            var subEnd = localEnd < chunkEnd ? localEnd - chunkStart : numChunk.length;
            var dstBase = segStart + (chunkStart + subStart - localStart);
            var chunkVals = numChunk.values;
            if (numChunk.nullCount === 0) {
              if (isGuaranteedFiniteTypedArray(chunkVals)) {
                values.set(chunkVals.subarray(subStart, subEnd), dstBase);
              } else {
                for (i = subStart; i < subEnd; ++i) {
                  v = chunkVals[i];
                  if (v - v === 0) {
                    values[dstBase + i - subStart] = v;
                    if (v > 1e12 || v < -1e12) entry.hasExtreme = true;
                  } else {
                    values[dstBase + i - subStart] = NaN;
                    entry.hasNaN = true;
                  }
                }
              }
            } else {
              var numNullBitmap = numChunk.nullBitmap;
              var numChunkOff = typeof numChunk.offset === 'number' ? numChunk.offset : 0;
              var isIntChunk = isGuaranteedFiniteTypedArray(chunkVals);
              for (i = subStart; i < subEnd; ++i) {
                var numBitIdx = numChunkOff + i;
                if (!(numNullBitmap[numBitIdx >>> 3] & (1 << (numBitIdx & 7)))) {
                  values[dstBase + i - subStart] = NaN;
                  entry.hasNaN = true;
                } else {
                  v = chunkVals[i];
                  if (isIntChunk || v - v === 0) {
                    values[dstBase + i - subStart] = v;
                    if (!isIntChunk && (v > 1e12 || v < -1e12)) entry.hasExtreme = true;
                  } else {
                    values[dstBase + i - subStart] = NaN;
                    entry.hasNaN = true;
                  }
                }
              }
            }
            chunkStart = chunkEnd;
          }
        } else {
          var arrowTemporal = resolveArrowTemporalChunks(col);
          if (arrowTemporal) {
            var tChunks = arrowTemporal.chunks;
            var tMul = arrowTemporal.scaleMul;
            var tDiv = arrowTemporal.scaleDiv;
            var tChunkStart = 0;
            for (var tcIdx = 0; tcIdx < tChunks.length; ++tcIdx) {
              var tChunk = tChunks[tcIdx];
              var tChunkEnd = tChunkStart + tChunk.length;
              if (tChunkEnd <= localStart) {
                tChunkStart = tChunkEnd;
                continue;
              }
              if (tChunkStart >= localEnd) break;
              var tSubStart = localStart > tChunkStart ? localStart - tChunkStart : 0;
              var tSubEnd = localEnd < tChunkEnd ? localEnd - tChunkStart : tChunk.length;
              var tDstBase = segStart + (tChunkStart + tSubStart - localStart);
              var tVals = tChunk.values;
              var tIsBig = isBigIntTypedArray(tVals);
              if (tChunk.nullCount === 0) {
                for (i = tSubStart; i < tSubEnd; ++i) {
                  v = tIsBig ? Number(tVals[i]) : tVals[i];
                  if (tMul !== 1) v *= tMul;
                  else if (tDiv !== 1) v /= tDiv;
                  if (v - v === 0) {
                    values[tDstBase + i - tSubStart] = v;
                    if (v > 1e12 || v < -1e12) entry.hasExtreme = true;
                  } else {
                    values[tDstBase + i - tSubStart] = NaN;
                    entry.hasNaN = true;
                  }
                }
              } else {
                var tNullBitmap = tChunk.nullBitmap;
                var tChunkOff = typeof tChunk.offset === 'number' ? tChunk.offset : 0;
                for (i = tSubStart; i < tSubEnd; ++i) {
                  var tBitIdx = tChunkOff + i;
                  if (!(tNullBitmap[tBitIdx >>> 3] & (1 << (tBitIdx & 7)))) {
                    values[tDstBase + i - tSubStart] = NaN;
                    entry.hasNaN = true;
                  } else {
                    v = tIsBig ? Number(tVals[i]) : tVals[i];
                    if (tMul !== 1) v *= tMul;
                    else if (tDiv !== 1) v /= tDiv;
                    if (v - v === 0) {
                      values[tDstBase + i - tSubStart] = v;
                      if (v > 1e12 || v < -1e12) entry.hasExtreme = true;
                    } else {
                      values[tDstBase + i - tSubStart] = NaN;
                      entry.hasNaN = true;
                    }
                  }
                }
              }
              tChunkStart = tChunkEnd;
            }
          } else if (batch.accessors && batch.accessors[field]) {
            accessor = batch.accessors[field];
            for (i = localStart; i < localEnd; ++i) {
              raw = accessor(i);
              if (typeof raw === 'number' && raw - raw === 0) {
                values[segStart + i - localStart] = raw;
                if (raw > 1e12 || raw < -1e12) entry.hasExtreme = true;
              } else {
                values[segStart + i - localStart] = NaN;
                entry.hasNaN = true;
              }
            }
          } else if (col != null) {
            for (i = localStart; i < localEnd; ++i) {
              raw = getColumnValue(col, i);
              if (typeof raw === 'number' && raw - raw === 0) {
                values[segStart + i - localStart] = raw;
                if (raw > 1e12 || raw < -1e12) entry.hasExtreme = true;
              } else {
                values[segStart + i - localStart] = NaN;
                entry.hasNaN = true;
              }
            }
          } else {
            for (i = segStart; i < segEnd; ++i) {
              values[i] = NaN;
            }
            entry.hasNaN = true;
          }
        }
      }

      cursor = segEnd;
    }

    if (cursor < n) {
      fillNumericFromRows(values, entry, field, cursor, n);
    }

    entry.length = n;
    return entry;
  }

  function encodeSplitValue(entry, raw) {
    var key = (raw == null || raw === '') ? '__unknown__' : (typeof raw === 'string' ? raw : String(raw));
    var code = entry.valueToCode.get(key);
    if (code === undefined) {
      code = entry.codeToKey.length;
      entry.valueToCode.set(key, code);
      entry.codeToKey.push(key);
    }
    return code;
  }

  function fillSplitFromRows(dest, entry, field, start, end) {
    var i, row;
    for (i = start; i < end; ++i) {
      row = getRecord(i);
      dest[i] = encodeSplitValue(entry, row ? row[field] : undefined);
    }
  }

  function getSplitColumn(field) {
    var entry = splitColumns[field];
    if (!entry) {
      var initCap = n < 64 ? 64 : n;
      entry = {
        codes: new Uint32Array(initCap),
        codeToKey: [],
        dimCodeToSplit: null,
        dimState: null,
        length: 0,
        valueToCode: new Map()
      };
      splitColumns[field] = entry;
    }
    if (entry.length >= n) {
      return entry;
    }

    var codes = entry.codes;
    if (codes.length < n) {
      var nextCap = codes.length || 64;
      while (nextCap < n) nextCap <<= 1;
      var nextCodes = new Uint32Array(nextCap);
      if (entry.length > 0) {
        nextCodes.set(codes.subarray(0, entry.length));
      }
      codes = entry.codes = nextCodes;
    }

    var cursor = entry.length;

    // Item 5: Reuse an existing lazyEncodedState on `field` instead of re-hashing strings!
    var dimRefs = lazyDimensionsByField[field];
    if (dimRefs && dimRefs.length) {
      var dimState = null;
      for (var dri = 0; dri < dimRefs.length; ++dri) {
        var candidate = dimRefs[dri]();
        if (candidate && candidate.codesLength === n) {
          dimState = candidate;
          break;
        }
      }
      if (dimState) {
        var dimCodeToValue = dimState.codeToValue;
        var dimCodeLen = dimCodeToValue.length;
        var dimMap = entry.dimState === dimState ? entry.dimCodeToSplit : null;
        if (!dimMap || dimMap.length < dimCodeLen) {
          var nextMapCap = (dimMap && dimMap.length) ? dimMap.length : 64;
          while (nextMapCap < dimCodeLen) nextMapCap <<= 1;
          var nextDimMap = new Int32Array(nextMapCap);
          nextDimMap.fill(-1);
          if (dimMap) nextDimMap.set(dimMap);
          dimMap = entry.dimCodeToSplit = nextDimMap;
          entry.dimState = dimState;
        }
        var dimCodes = dimState.codes;
        var dc, scCode;
        for (var di = cursor; di < n; ++di) {
          dc = dimCodes[di];
          scCode = dimMap[dc];
          if (scCode < 0) {
            scCode = dimMap[dc] = encodeSplitValue(entry, dimCodeToValue[dc]);
          }
          codes[di] = scCode;
        }
        entry.length = n;
        return entry;
      }
    }

    if (!columnarBatches.length) {
      fillSplitFromRows(codes, entry, field, cursor, n);
      entry.length = n;
      return entry;
    }

    var batchIndex, batch, segStart, segEnd, localStart, localEnd, col, accessor, i;
    for (batchIndex = 0; batchIndex < columnarBatches.length && cursor < n; ++batchIndex) {
      batch = columnarBatches[batchIndex];
      if (batch.end <= cursor) continue;
      if (batch.start >= n) break;
      if (cursor < batch.start) {
        var gapEnd = Math.min(batch.start, n);
        fillSplitFromRows(codes, entry, field, cursor, gapEnd);
        cursor = gapEnd;
        if (cursor >= n) break;
      }

      segStart = Math.max(cursor, batch.start);
      segEnd = Math.min(batch.end, n);
      localStart = segStart - batch.start;
      localEnd = segEnd - batch.start;
      col = batch.columns[field];

      if (Array.isArray(col) || ArrayBuffer.isView(col)) {
        for (i = localStart; i < localEnd; ++i) {
          codes[segStart + i - localStart] = encodeSplitValue(entry, col[i]);
        }
      } else {
        var splitDictChunks = resolveArrowDictionaryChunks(col);
        if (splitDictChunks) {
          var sChunkStart = 0;
          for (var scIdx = 0; scIdx < splitDictChunks.length; ++scIdx) {
            var sChunk = splitDictChunks[scIdx];
            var sChunkEnd = sChunkStart + sChunk.length;
            if (sChunkEnd <= localStart) {
              sChunkStart = sChunkEnd;
              continue;
            }
            if (sChunkStart >= localEnd) break;
            var sSubStart = localStart > sChunkStart ? localStart - sChunkStart : 0;
            var sSubEnd = localEnd < sChunkEnd ? localEnd - sChunkStart : sChunk.length;
            var sDstBase = segStart + (sChunkStart + sSubStart - localStart);
            var sDict = sChunk.dictionary;
            var sDictToCode = new Int32Array(sDict.length);
            sDictToCode.fill(-1);
            var sIndices = sChunk.values;
            var sDIdx, sCode;
            if (sChunk.nullCount === 0) {
              for (i = sSubStart; i < sSubEnd; ++i) {
                sDIdx = sIndices[i];
                sCode = sDictToCode[sDIdx];
                if (sCode < 0) {
                  sCode = sDictToCode[sDIdx] = encodeSplitValue(entry, sDict.get(sDIdx));
                }
                codes[sDstBase + i - sSubStart] = sCode;
              }
            } else {
              var sNullBitmap = sChunk.nullBitmap;
              var sChunkOff = typeof sChunk.offset === 'number' ? sChunk.offset : 0;
              var sNullCode = -1;
              for (i = sSubStart; i < sSubEnd; ++i) {
                var sBitIdx = sChunkOff + i;
                if (!(sNullBitmap[sBitIdx >>> 3] & (1 << (sBitIdx & 7)))) {
                  if (sNullCode < 0) sNullCode = encodeSplitValue(entry, null);
                  codes[sDstBase + i - sSubStart] = sNullCode;
                } else {
                  sDIdx = sIndices[i];
                  sCode = sDictToCode[sDIdx];
                  if (sCode < 0) {
                    sCode = sDictToCode[sDIdx] = encodeSplitValue(entry, sDict.get(sDIdx));
                  }
                  codes[sDstBase + i - sSubStart] = sCode;
                }
              }
            }
            sChunkStart = sChunkEnd;
          }
        } else {
          var splitUtf8Chunks = resolveArrowUtf8Chunks(col);
          var splitUtf8Vals = splitUtf8Chunks ? extractArrowUtf8Range(splitUtf8Chunks, localStart, localEnd - localStart) : null;
          if (splitUtf8Vals) {
            for (i = 0; i < splitUtf8Vals.length; ++i) {
              codes[segStart + i] = encodeSplitValue(entry, splitUtf8Vals[i]);
            }
          } else if (batch.accessors && batch.accessors[field]) {
            accessor = batch.accessors[field];
            for (i = localStart; i < localEnd; ++i) {
              codes[segStart + i - localStart] = encodeSplitValue(entry, accessor(i));
            }
          } else if (col != null) {
            for (i = localStart; i < localEnd; ++i) {
              codes[segStart + i - localStart] = encodeSplitValue(entry, getColumnValue(col, i));
            }
          } else {
            var unknownCode = encodeSplitValue(entry, undefined);
            codes.fill(unknownCode, segStart, segEnd);
          }
        }
      }

      cursor = segEnd;
    }

    if (cursor < n) {
      fillSplitFromRows(codes, entry, field, cursor, n);
    }

    entry.length = n;
    return entry;
  }

  function appendData(newData) {
    var offset = data.length;
    data.length = offset + newData.length;
    var batch = getColumnarBatch(newData);
    if (batch) {
      for (var key in batch.rows) {
        if (Object.prototype.hasOwnProperty.call(batch.rows, key)) {
          data[offset + Number(key)] = batch.rows[key];
          anyRowMaterialized = true;
        }
      }
      return;
    }
    if (newData.length) {
      anyRowMaterialized = true;
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
    return filterStore.hasAnyActive();
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

  // Returns:
  //   0 = no active filter listener outside dimSlot
  //   1 = at least one other listener exists, and ALL are built-in resettable groups
  //   2 = at least one other listener requires exact added/removed delta arrays
  function inspectOtherFilterListeners(dimSlot) {
    var hasResettable = false;
    for (var i = 0; i < filterListeners.length; ++i) {
      var l = filterListeners[i];
      if (l === cr_null) continue;
      if (l._xfilterDimSlot === dimSlot) continue;
      if (l._xfilterResettable === true) {
        hasResettable = true;
      } else {
        return 2;
      }
    }
    return hasResettable ? 1 : 0;
  }

  function notifyFilterListeners(filterSlot, added, removed, forceReset) {
    activeRowsDirty = true;
    activeCountDirty = true;
    if (filterSlot !== brushDimSlot) {
      invalidateBrushState();
    }
    if (transientFilterDepth > 0) {
      return;
    }
    if (batchedFilterDepth > 0) {
      batchedFilterEventPending = true;
      markFilterListenersDirty();
      return;
    }

    var li;
    if (forceReset) {
      for (li = 0; li < filterListeners.length; ++li) {
        filterListeners[li](filterSlot, added, removed, false, true);
      }
    } else {
      for (li = 0; li < filterListeners.length; ++li) {
        filterListeners[li](filterSlot, added, removed);
      }
    }
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

  function withTransientFilters(callback) {
    filterStore.ensureMaterialized(null);
    invalidateBrushState();
    transientFilterDepth += 1;
    try {
      return callback();
    } finally {
      transientFilterDepth -= 1;
      activeRowsDirty = true;
      activeCountDirty = true;
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
    anyRowMaterialized = true;
    return row;
  }

  function materializeRowsByIndex(rowIndexes, fields) {
    var len = rowIndexes ? rowIndexes.length : 0;
    var out = new Array(len);
    var i, j, projected;
    if (!fields || !fields.length) {
      for (i = 0; i < len; ++i) {
        out[i] = getRecord(rowIndexes[i]);
      }
      return out;
    }
    var taken = takeColumns(rowIndexes, fields);
    var cols = taken.columns;
    var fieldCount = fields.length;
    var colList = new Array(fieldCount);
    for (j = 0; j < fieldCount; ++j) {
      colList[j] = cols[fields[j]];
    }
    for (i = 0; i < len; ++i) {
      projected = {};
      for (j = 0; j < fieldCount; ++j) {
        projected[fields[j]] = colList[j][i];
      }
      out[i] = projected;
    }
    return out;
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

  function resolveReduceMetricSpec(add, remove, initial) {
    var metricSpec = add && add._xfilterMetricSpec;
    if (!metricSpec || metricSpec !== (remove && remove._xfilterMetricSpec) || metricSpec !== (initial && initial._xfilterMetricSpec)) {
      return null;
    }
    var splitField = add._xfilterSplitField || null;
    if (splitField && (splitField !== remove._xfilterSplitField || splitField !== initial._xfilterSplitField)) {
      return null;
    }
    return {
      metrics: metricSpec,
      splitField: splitField
    };
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

      var directColumn = batch.columns[field];
      var isDirectIndexable = Array.isArray(directColumn) || ArrayBuffer.isView(directColumn);
      var arrowDictChunks = !isDirectIndexable ? resolveArrowDictionaryChunks(directColumn) : null;
      var arrowUtf8Chunks = !isDirectIndexable && !arrowDictChunks ? resolveArrowUtf8Chunks(directColumn) : null;
      if (!isDirectIndexable && !arrowDictChunks && !arrowUtf8Chunks && (!batch.accessors || !batch.accessors[field])) {
        return null;
      }

      return {
        accessor: batch.accessors ? batch.accessors[field] : null,
        arrowDictChunks: arrowDictChunks,
        arrowUtf8Chunks: arrowUtf8Chunks,
        column: isDirectIndexable ? directColumn : null,
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
      invalidateBrushState();
      appendData(newData);
      rememberColumnarBatch(newData, n0, n1);
      filterStore.lengthen(n += n1);
      activeRowsDirty = true;
      activeCountDirty = true;
      dataListeners.forEach(function(l) { l(newData, n0, n1); });
      triggerOnChange('dataAdded');
    }

    return crossfilter;
  }

  function canCompactColumnarOnRemove() {
    if (!columnarBatches.length || anyRowMaterialized) return false;
    var expectedStart = 0;
    for (var b = 0; b < columnarBatches.length; ++b) {
      var cb = columnarBatches[b];
      if (cb.start !== expectedStart) return false;
      if (!cb.batch || !cb.batch.rowFactory || !cb.batch.rowFactory._xfilterDefaultRowFactory) return false;
      expectedStart = cb.end;
    }
    return expectedStart === n;
  }

  function collectColumnarFields() {
    var seen = Object.create(null);
    var fields = [];
    for (var b = 0; b < columnarBatches.length; ++b) {
      var batchFields = columnarBatches[b].batch.fields;
      for (var f = 0; f < batchFields.length; ++f) {
        var name = batchFields[f];
        if (!seen[name]) {
          seen[name] = true;
          fields.push(name);
        }
      }
    }
    return fields;
  }

  // Removes all records that match the current filters, or if a predicate function is passed,
  // removes all records matching the predicate (ignoring filters).
  function removeData(predicate) {
    filterStore.ensureMaterialized(null);
    invalidateBrushState();
    var usePred = typeof predicate === 'function',
        indexOnlyPred = !usePred || predicate._xfilterIndexOnly === true,
        compactColumnar = indexOnlyPred && canCompactColumnarOnRemove();

    if (!compactColumnar) {
      materializeAllRecords();
    }

    var // Mapping from old record indexes to new indexes (after records removed)
        newIndex = new Array(n),
        removed = [],
        keptIndexes = compactColumnar ? new Uint32Array(n) : null,
        keptCount = 0;

    if (compactColumnar) {
      for (var ci = 0; ci < n; ++ci) {
        var dropRow = usePred ? predicate(undefined, ci) : filterStore.isActive(ci);
        if (dropRow) {
          removed.push(ci);
          newIndex[ci] = REMOVED_INDEX;
        } else {
          newIndex[ci] = keptCount;
          keptIndexes[keptCount++] = ci;
        }
      }
    } else {
      for (var index1 = 0, index2 = 0; index1 < n; ++index1) {
        if (usePred ? predicate(getRecord(index1), index1) : filterStore.isActive(index1)) {
          removed.push(index1);
          newIndex[index1] = REMOVED_INDEX;
        } else {
          newIndex[index1] = index2++;
        }
      }
    }

    // Build compacted columnar batch BEFORE notifying listeners & rewriting filters/data
    var nextColumnarBatch = null;
    if (compactColumnar && keptCount > 0) {
      var allFields = collectColumnarFields();
      var compacted = takeColumns(keptIndexes.subarray(0, keptCount), allFields);
      var compactedProxy = rowsFromColumns(compacted.columns, { fields: allFields, length: keptCount });
      var compactedMeta = getColumnarBatch(compactedProxy);
      nextColumnarBatch = {
        batch: compactedMeta,
        accessors: compactedMeta.accessorsByField,
        columns: compactedMeta.columns,
        start: 0,
        end: keptCount
      };
    }

    // Remove all matching records from groups.
    filterListeners.forEach(function(l) { l(null, [], removed, true); });

    // Update indexes.
    removeDataListeners.forEach(function(l) { l(newIndex); });

    // Remove old filters and data by overwriting.
    if (compactColumnar) {
      filterStore.compact(newIndex, keptCount, REMOVED_INDEX);
      n = keptCount;
      data = new Array(keptCount);
      columnarBatches = nextColumnarBatch ? [nextColumnarBatch] : [];
      anyRowMaterialized = false;
    } else {
      for (var index3 = 0, index4 = 0; index3 < n; ++index3) {
        if (newIndex[index3] !== REMOVED_INDEX) {
          if (index3 !== index4) data[index4] = data[index3];
          ++index4;
        }
      }
      filterStore.compact(newIndex, index4, REMOVED_INDEX);
      data.length = n = index4;
      columnarBatches = [];
    }

    numericColumns = Object.create(null);
    splitColumns = Object.create(null);
    activeRowsDirty = true;
    activeCountDirty = true;
    triggerOnChange('dataRemoved');
  }

  function buildIgnoreIdMap(dimensions) {
    if (!dimensions || !dimensions.length) {
      return null;
    }
    var map = Object.create(null);
    for (var d = 0, len = dimensions.length; d < len; d++) {
      map[dimensions[d].id()] = true;
    }
    return map;
  }

  // Return true if the data element at index i is filtered IN.
  // Optionally, ignore the filters of any dimensions in the ignore_dimensions list.
  function isElementFiltered(i, ignore_dimensions) {
    var ignoreMap = buildIgnoreIdMap(ignore_dimensions);
    return ignoreMap ? filterStore.isActiveIgnoring(i, ignoreMap) : filterStore.isActive(i);
  }

  // Adds a new dimension with the specified value accessor function.
  function dimension(value, iterable) {
    var accessorPath,
        isStringField = typeof value === 'string';

    if (isStringField) {
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
      id: function() { return id; },
      _bounds: readDimensionBounds
    };

    var dimSlot, // 1-bit filter slot in filterStore
        id, // unique ID for this dimension (reused when dimensions are disposed)
        values, // sorted, cached array
        index, // maps sorted value index -> record index (in data)
        newValues, // temporary array storing newly-added values
        newIndex, // temporary array storing newly-added index
        lastAppendedCodes, // temporary: appended codes from lazy preAdd
        iterablesIndexCount,
        iterablesIndexFilterStatus,
        iterablesEmptyRows = [],
        sortRange = function(len) {
          var range = cr_range(len);
          if (len <= 1) return range;
          var first = newValues[0];
          var firstType = typeof first;
          var i, v;
          if (firstType === 'number') {
            var allNum = first === first;
            for (i = 1; allNum && i < len; ++i) {
              v = newValues[i];
              if (typeof v !== 'number' || v !== v) allNum = false;
            }
            if (allNum) {
              return range.sort(function(A, B) {
                var va = newValues[A], vb = newValues[B];
                return va < vb ? -1 : va > vb ? 1 : A - B;
              });
            }
          } else if (firstType === 'string') {
            var allStr = true;
            for (i = 1; i < len; ++i) {
              if (typeof newValues[i] !== 'string') { allStr = false; break; }
            }
            if (allStr) {
              return range.sort(function(A, B) {
                var va = newValues[A], vb = newValues[B];
                return va < vb ? -1 : va > vb ? 1 : A - B;
              });
            }
          } else if (first instanceof Date) {
            var times = new Float64Array(len);
            var t0 = first.getTime();
            var allDate = t0 === t0;
            times[0] = t0;
            for (i = 1; allDate && i < len; ++i) {
              v = newValues[i];
              if (!(v instanceof Date)) { allDate = false; break; }
              var tv = v.getTime();
              if (tv !== tv) { allDate = false; break; }
              times[i] = tv;
            }
            if (allDate) {
              return range.sort(function(A, B) {
                var va = times[A], vb = times[B];
                return va < vb ? -1 : va > vb ? 1 : A - B;
              });
            }
          }
          return range.sort(function(A, B) {
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
        rawNumericState = null,
        deferredInit = false,
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

    function createLazyEncodedStateFromSource(source, accessor, offset, length) {
      if (!accessorPath || iterable) {
        return null;
      }
      // Warm WASM runtime if enabled so runtimeInfo().active stays consistent.
      runtimeController.canUseWasmScan();

      var codesCapacity = length < 64 ? 64 : length,
          codes = new Uint32Array(codesCapacity),
          valueToCode = new Map(),
          codeToValue = [undefined],
          codeCounts = new Uint32Array(64),
          hasUnorderable = false,
          isPureNumeric = true,
          isPureString = true,
          i,
          valueToEncode,
          code;

      if (source) {
        if (offset === 0) {
          for (i = 0; i < length; ++i) {
            valueToEncode = source[i];
            code = valueToCode.get(valueToEncode);
            if (code === undefined) {
              if (!isLazyEncodedValue(valueToEncode)) {
                return null;
              }
              code = codeToValue.length;
              valueToCode.set(valueToEncode, code);
              codeToValue.push(valueToEncode);
              if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
                hasUnorderable = true;
                isPureNumeric = false;
                isPureString = false;
              } else if (typeof valueToEncode === 'number') {
                isPureString = false;
              } else if (typeof valueToEncode === 'string') {
                isPureNumeric = false;
              } else {
                isPureNumeric = false;
                isPureString = false;
              }
              if (code >= codeCounts.length) {
                var nextCountCap0 = codeCounts.length << 1;
                while (nextCountCap0 <= code) nextCountCap0 <<= 1;
                var nextCounts0 = new Uint32Array(nextCountCap0);
                nextCounts0.set(codeCounts);
                codeCounts = nextCounts0;
              }
            }
            codes[i] = code;
            ++codeCounts[code];
          }
        } else {
          for (i = 0; i < length; ++i) {
            valueToEncode = source[offset + i];
            code = valueToCode.get(valueToEncode);
            if (code === undefined) {
              if (!isLazyEncodedValue(valueToEncode)) {
                return null;
              }
              code = codeToValue.length;
              valueToCode.set(valueToEncode, code);
              codeToValue.push(valueToEncode);
              if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
                hasUnorderable = true;
                isPureNumeric = false;
                isPureString = false;
              } else if (typeof valueToEncode === 'number') {
                isPureString = false;
              } else if (typeof valueToEncode === 'string') {
                isPureNumeric = false;
              } else {
                isPureNumeric = false;
                isPureString = false;
              }
              if (code >= codeCounts.length) {
                var nextCountCap1 = codeCounts.length << 1;
                while (nextCountCap1 <= code) nextCountCap1 <<= 1;
                var nextCounts1 = new Uint32Array(nextCountCap1);
                nextCounts1.set(codeCounts);
                codeCounts = nextCounts1;
              }
            }
            codes[i] = code;
            ++codeCounts[code];
          }
        }
      } else {
        for (i = 0; i < length; ++i) {
          valueToEncode = accessor(offset + i);
          code = valueToCode.get(valueToEncode);
          if (code === undefined) {
            if (!isLazyEncodedValue(valueToEncode)) {
              return null;
            }
            code = codeToValue.length;
            valueToCode.set(valueToEncode, code);
            codeToValue.push(valueToEncode);
            if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
              hasUnorderable = true;
              isPureNumeric = false;
              isPureString = false;
            } else if (typeof valueToEncode === 'number') {
              isPureString = false;
            } else if (typeof valueToEncode === 'string') {
              isPureNumeric = false;
            } else {
              isPureNumeric = false;
              isPureString = false;
            }
            if (code >= codeCounts.length) {
              var nextCountCap2 = codeCounts.length << 1;
              while (nextCountCap2 <= code) nextCountCap2 <<= 1;
              var nextCounts2 = new Uint32Array(nextCountCap2);
              nextCounts2.set(codeCounts);
              codeCounts = nextCounts2;
            }
          }
          codes[i] = code;
          ++codeCounts[code];
        }
      }

      var marksCap = codeToValue.length < 64 ? 64 : codeToValue.length;
      return {
        codeCounts: codeCounts,
        codeRank: null,
        codeRankVersion: -1,
        codesLength: length,
        codeToValue: codeToValue,
        codes: codes,
        hasActiveFilterMask: false,
        hasUnorderable: hasUnorderable,
        isPureNumeric: isPureNumeric,
        isPureString: isPureString,
        lastSelectedCount: -1,
        selectionMarkVersion: 1,
        selectionMarks: new Uint32Array(marksCap),
        valueToCode: valueToCode,
        version: 1
      };
    }

    function createLazyEncodedStateFromArrowDict(chunks, startOffset, length) {
      if (!accessorPath || iterable) {
        return null;
      }
      runtimeController.canUseWasmScan();

      var codesCapacity = length < 64 ? 64 : length,
          codes = new Uint32Array(codesCapacity),
          valueToCode = new Map(),
          codeToValue = [undefined],
          codeCounts = new Uint32Array(64),
          hasUnorderable = false,
          isPureNumeric = true,
          isPureString = true,
          localEnd = startOffset + length,
          chunkStart = 0,
          outIdx = 0,
          nullCode = -1,
          c,
          j,
          dIdx,
          code,
          val;

      for (c = 0; c < chunks.length && outIdx < length; ++c) {
        var chunk = chunks[c];
        var chunkEnd = chunkStart + chunk.length;
        if (chunkEnd <= startOffset) {
          chunkStart = chunkEnd;
          continue;
        }
        if (chunkStart >= localEnd) break;
        var subStart = startOffset > chunkStart ? startOffset - chunkStart : 0;
        var subEnd = localEnd < chunkEnd ? localEnd - chunkStart : chunk.length;
        var dict = chunk.dictionary;
        var dictLen = dict.length;
        var dictToCode = new Int32Array(dictLen);
        dictToCode.fill(-1);
        var indices = chunk.values;

        if (chunk.nullCount === 0) {
          for (j = subStart; j < subEnd; ++j) {
            dIdx = indices[j];
            code = dictToCode[dIdx];
            if (!(code >= 0)) {
              if (dIdx < 0 || dIdx >= dictLen) return null;
              val = dict.get(dIdx);
              code = valueToCode.get(val);
              if (code === undefined) {
                if (!isLazyEncodedValue(val)) return null;
                code = codeToValue.length;
                valueToCode.set(val, code);
                codeToValue.push(val);
                if (val === undefined || !(val >= val)) {
                  hasUnorderable = true;
                  isPureNumeric = false;
                  isPureString = false;
                } else if (typeof val === 'number') {
                  isPureString = false;
                } else if (typeof val === 'string') {
                  isPureNumeric = false;
                } else {
                  isPureNumeric = false;
                  isPureString = false;
                }
                if (code >= codeCounts.length) {
                  var nextCapA = codeCounts.length << 1;
                  while (nextCapA <= code) nextCapA <<= 1;
                  var nextCountsA = new Uint32Array(nextCapA);
                  nextCountsA.set(codeCounts);
                  codeCounts = nextCountsA;
                }
              }
              dictToCode[dIdx] = code;
            }
            codes[outIdx++] = code;
            ++codeCounts[code];
          }
        } else {
          var nullBitmap = chunk.nullBitmap;
          var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
          for (j = subStart; j < subEnd; ++j) {
            var bitIdx = chunkOff + j;
            if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
              if (nullCode < 0) {
                code = valueToCode.get(null);
                if (code === undefined) {
                  code = codeToValue.length;
                  valueToCode.set(null, code);
                  codeToValue.push(null);
                  isPureNumeric = false;
                  isPureString = false;
                  if (code >= codeCounts.length) {
                    var nextCapN = codeCounts.length << 1;
                    while (nextCapN <= code) nextCapN <<= 1;
                    var nextCountsN = new Uint32Array(nextCapN);
                    nextCountsN.set(codeCounts);
                    codeCounts = nextCountsN;
                  }
                }
                nullCode = code;
              }
              codes[outIdx++] = nullCode;
              ++codeCounts[nullCode];
            } else {
              dIdx = indices[j];
              code = dictToCode[dIdx];
              if (!(code >= 0)) {
                if (dIdx < 0 || dIdx >= dictLen) return null;
                val = dict.get(dIdx);
                code = valueToCode.get(val);
                if (code === undefined) {
                  if (!isLazyEncodedValue(val)) return null;
                  code = codeToValue.length;
                  valueToCode.set(val, code);
                  codeToValue.push(val);
                  if (val === undefined || !(val >= val)) {
                    hasUnorderable = true;
                    isPureNumeric = false;
                    isPureString = false;
                  } else if (typeof val === 'number') {
                    isPureString = false;
                  } else if (typeof val === 'string') {
                    isPureNumeric = false;
                  } else {
                    isPureNumeric = false;
                    isPureString = false;
                  }
                  if (code >= codeCounts.length) {
                    var nextCapB = codeCounts.length << 1;
                    while (nextCapB <= code) nextCapB <<= 1;
                    var nextCountsB = new Uint32Array(nextCapB);
                    nextCountsB.set(codeCounts);
                    codeCounts = nextCountsB;
                  }
                }
                dictToCode[dIdx] = code;
              }
              codes[outIdx++] = code;
              ++codeCounts[code];
            }
          }
        }
        chunkStart = chunkEnd;
      }

      if (outIdx !== length) {
        return null;
      }

      var marksCap = codeToValue.length < 64 ? 64 : codeToValue.length;
      return {
        codeCounts: codeCounts,
        codeRank: null,
        codeRankVersion: -1,
        codesLength: length,
        codeToValue: codeToValue,
        codes: codes,
        hasActiveFilterMask: false,
        hasUnorderable: hasUnorderable,
        isPureNumeric: isPureNumeric,
        isPureString: isPureString,
        lastSelectedCount: -1,
        selectionMarkVersion: 1,
        selectionMarks: new Uint32Array(marksCap),
        valueToCode: valueToCode,
        version: 1
      };
    }

    function ensureLazySelectionMarksSize(size) {
      if (lazyEncodedState.selectionMarks.length >= size) {
        return;
      }

      var nextCap = lazyEncodedState.selectionMarks.length || 64;
      while (nextCap < size) nextCap <<= 1;
      var nextMarks = new Uint32Array(nextCap);
      nextMarks.set(lazyEncodedState.selectionMarks);
      lazyEncodedState.selectionMarks = nextMarks;
    }

    function getLazyCodes() {
      return lazyEncodedState.codes.length === lazyEncodedState.codesLength
        ? lazyEncodedState.codes
        : lazyEncodedState.codes.subarray(0, lazyEncodedState.codesLength);
    }

    function growLazyCodeCounts(codeCounts, minLength) {
      var nextCap = codeCounts.length || 64;
      while (nextCap < minLength) nextCap <<= 1;
      var nextCounts = new Uint32Array(nextCap);
      nextCounts.set(codeCounts);
      lazyEncodedState.codeCounts = nextCounts;
      return nextCounts;
    }

    function appendLazyEncodedValuesFromSource(source, accessor, offset, length) {
      if (!lazyEncodedState) {
        return null;
      }

      var existingLength = lazyEncodedState.codesLength,
          newLength = existingLength + length,
          codes = lazyEncodedState.codes,
          codeCounts = lazyEncodedState.codeCounts,
          valueToCode = lazyEncodedState.valueToCode,
          codeToValue = lazyEncodedState.codeToValue,
          appendedCodes = new Uint32Array(length),
          hasUnorderable = lazyEncodedState.hasUnorderable,
          isPureNumeric = lazyEncodedState.isPureNumeric,
          isPureString = lazyEncodedState.isPureString,
          i,
          valueToEncode,
          code;

      if (newLength > codes.length) {
        var nextCapacity = codes.length || 64;
        while (nextCapacity < newLength) nextCapacity <<= 1;
        var nextCodes = new Uint32Array(nextCapacity);
        nextCodes.set(codes.subarray(0, existingLength));
        codes = nextCodes;
        lazyEncodedState.codes = codes;
      }

      if (source) {
        if (offset === 0) {
          for (i = 0; i < length; ++i) {
            valueToEncode = source[i];
            code = valueToCode.get(valueToEncode);
            if (code === undefined) {
              if (!isLazyEncodedValue(valueToEncode)) {
                return null;
              }
              code = codeToValue.length;
              valueToCode.set(valueToEncode, code);
              codeToValue.push(valueToEncode);
              if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
                hasUnorderable = true;
                isPureNumeric = false;
                isPureString = false;
              } else if (typeof valueToEncode === 'number') {
                isPureString = false;
              } else if (typeof valueToEncode === 'string') {
                isPureNumeric = false;
              } else {
                isPureNumeric = false;
                isPureString = false;
              }
              if (code >= codeCounts.length) {
                codeCounts = growLazyCodeCounts(codeCounts, code + 1);
              }
            }
            appendedCodes[i] = code;
            codes[existingLength + i] = code;
            ++codeCounts[code];
          }
        } else {
          for (i = 0; i < length; ++i) {
            valueToEncode = source[offset + i];
            code = valueToCode.get(valueToEncode);
            if (code === undefined) {
              if (!isLazyEncodedValue(valueToEncode)) {
                return null;
              }
              code = codeToValue.length;
              valueToCode.set(valueToEncode, code);
              codeToValue.push(valueToEncode);
              if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
                hasUnorderable = true;
                isPureNumeric = false;
                isPureString = false;
              } else if (typeof valueToEncode === 'number') {
                isPureString = false;
              } else if (typeof valueToEncode === 'string') {
                isPureNumeric = false;
              } else {
                isPureNumeric = false;
                isPureString = false;
              }
              if (code >= codeCounts.length) {
                codeCounts = growLazyCodeCounts(codeCounts, code + 1);
              }
            }
            appendedCodes[i] = code;
            codes[existingLength + i] = code;
            ++codeCounts[code];
          }
        }
      } else {
        for (i = 0; i < length; ++i) {
          valueToEncode = accessor(offset + i);
          code = valueToCode.get(valueToEncode);
          if (code === undefined) {
            if (!isLazyEncodedValue(valueToEncode)) {
              return null;
            }
            code = codeToValue.length;
            valueToCode.set(valueToEncode, code);
            codeToValue.push(valueToEncode);
            if (valueToEncode === undefined || !(valueToEncode >= valueToEncode)) {
              hasUnorderable = true;
              isPureNumeric = false;
              isPureString = false;
            } else if (typeof valueToEncode === 'number') {
              isPureString = false;
            } else if (typeof valueToEncode === 'string') {
              isPureNumeric = false;
            } else {
              isPureNumeric = false;
              isPureString = false;
            }
            if (code >= codeCounts.length) {
              codeCounts = growLazyCodeCounts(codeCounts, code + 1);
            }
          }
          appendedCodes[i] = code;
          codes[existingLength + i] = code;
          ++codeCounts[code];
        }
      }

      lazyEncodedState.hasUnorderable = hasUnorderable;
      lazyEncodedState.isPureNumeric = isPureNumeric;
      lazyEncodedState.isPureString = isPureString;
      lazyEncodedState.codesLength = newLength;
      lazyEncodedState.version += 1;
      lazyEncodedState.codeRank = null;
      ensureLazySelectionMarksSize(codeToValue.length);
      return appendedCodes;
    }

    function appendLazyEncodedValuesFromArrowDict(chunks, startOffset, length) {
      if (!lazyEncodedState) {
        return null;
      }

      var existingLength = lazyEncodedState.codesLength,
          newLength = existingLength + length,
          codes = lazyEncodedState.codes,
          codeCounts = lazyEncodedState.codeCounts,
          valueToCode = lazyEncodedState.valueToCode,
          codeToValue = lazyEncodedState.codeToValue,
          appendedCodes = new Uint32Array(length),
          hasUnorderable = lazyEncodedState.hasUnorderable,
          isPureNumeric = lazyEncodedState.isPureNumeric,
          isPureString = lazyEncodedState.isPureString,
          localEnd = startOffset + length,
          chunkStart = 0,
          outIdx = 0,
          nullCode = -1,
          c,
          j,
          dIdx,
          code,
          val;

      if (newLength > codes.length) {
        var nextCapacity = codes.length || 64;
        while (nextCapacity < newLength) nextCapacity <<= 1;
        var nextCodes = new Uint32Array(nextCapacity);
        nextCodes.set(codes.subarray(0, existingLength));
        codes = nextCodes;
        lazyEncodedState.codes = codes;
      }

      for (c = 0; c < chunks.length && outIdx < length; ++c) {
        var chunk = chunks[c];
        var chunkEnd = chunkStart + chunk.length;
        if (chunkEnd <= startOffset) {
          chunkStart = chunkEnd;
          continue;
        }
        if (chunkStart >= localEnd) break;
        var subStart = startOffset > chunkStart ? startOffset - chunkStart : 0;
        var subEnd = localEnd < chunkEnd ? localEnd - chunkStart : chunk.length;
        var dict = chunk.dictionary;
        var dictLen = dict.length;
        var dictToCode = new Int32Array(dictLen);
        dictToCode.fill(-1);
        var indices = chunk.values;

        if (chunk.nullCount === 0) {
          for (j = subStart; j < subEnd; ++j) {
            dIdx = indices[j];
            code = dictToCode[dIdx];
            if (!(code >= 0)) {
              if (dIdx < 0 || dIdx >= dictLen) return null;
              val = dict.get(dIdx);
              code = valueToCode.get(val);
              if (code === undefined) {
                if (!isLazyEncodedValue(val)) return null;
                code = codeToValue.length;
                valueToCode.set(val, code);
                codeToValue.push(val);
                if (val === undefined || !(val >= val)) {
                  hasUnorderable = true;
                  isPureNumeric = false;
                  isPureString = false;
                } else if (typeof val === 'number') {
                  isPureString = false;
                } else if (typeof val === 'string') {
                  isPureNumeric = false;
                } else {
                  isPureNumeric = false;
                  isPureString = false;
                }
                if (code >= codeCounts.length) {
                  codeCounts = growLazyCodeCounts(codeCounts, code + 1);
                }
              }
              dictToCode[dIdx] = code;
            }
            appendedCodes[outIdx] = code;
            codes[existingLength + outIdx] = code;
            ++outIdx;
            ++codeCounts[code];
          }
        } else {
          var nullBitmap = chunk.nullBitmap;
          var chunkOff = typeof chunk.offset === 'number' ? chunk.offset : 0;
          for (j = subStart; j < subEnd; ++j) {
            var bitIdx = chunkOff + j;
            if (!(nullBitmap[bitIdx >>> 3] & (1 << (bitIdx & 7)))) {
              if (nullCode < 0) {
                code = valueToCode.get(null);
                if (code === undefined) {
                  code = codeToValue.length;
                  valueToCode.set(null, code);
                  codeToValue.push(null);
                  isPureNumeric = false;
                  isPureString = false;
                  if (code >= codeCounts.length) {
                    codeCounts = growLazyCodeCounts(codeCounts, code + 1);
                  }
                }
                nullCode = code;
              }
              appendedCodes[outIdx] = nullCode;
              codes[existingLength + outIdx] = nullCode;
              ++outIdx;
              ++codeCounts[nullCode];
            } else {
              dIdx = indices[j];
              code = dictToCode[dIdx];
              if (!(code >= 0)) {
                if (dIdx < 0 || dIdx >= dictLen) return null;
                val = dict.get(dIdx);
                code = valueToCode.get(val);
                if (code === undefined) {
                  if (!isLazyEncodedValue(val)) return null;
                  code = codeToValue.length;
                  valueToCode.set(val, code);
                  codeToValue.push(val);
                  if (val === undefined || !(val >= val)) {
                    hasUnorderable = true;
                    isPureNumeric = false;
                    isPureString = false;
                  } else if (typeof val === 'number') {
                    isPureString = false;
                  } else if (typeof val === 'string') {
                    isPureNumeric = false;
                  } else {
                    isPureNumeric = false;
                    isPureString = false;
                  }
                  if (code >= codeCounts.length) {
                    codeCounts = growLazyCodeCounts(codeCounts, code + 1);
                  }
                }
                dictToCode[dIdx] = code;
              }
              appendedCodes[outIdx] = code;
              codes[existingLength + outIdx] = code;
              ++outIdx;
              ++codeCounts[code];
            }
          }
        }
        chunkStart = chunkEnd;
      }

      if (outIdx !== length) {
        return null;
      }

      lazyEncodedState.hasUnorderable = hasUnorderable;
      lazyEncodedState.isPureNumeric = isPureNumeric;
      lazyEncodedState.isPureString = isPureString;
      lazyEncodedState.codesLength = newLength;
      lazyEncodedState.version += 1;
      lazyEncodedState.codeRank = null;
      ensureLazySelectionMarksSize(codeToValue.length);
      return appendedCodes;
    }

    function buildCodeCounts(codes, length, size) {
      var cap = size < 64 ? 64 : size;
      var codeCounts = new Uint32Array(cap);
      for (var codeIndex = 0; codeIndex < length; ++codeIndex) {
        ++codeCounts[codes[codeIndex]];
      }
      return codeCounts;
    }

    function countLazySelectedRows(targetCodes) {
      if (!lazyEncodedState || !targetCodes || !targetCodes.length) {
        return 0;
      }

      var codeCounts = lazyEncodedState.codeCounts,
          selectedCount = 0;
      for (var codeIndex = 0; codeIndex < targetCodes.length; ++codeIndex) {
        selectedCount += codeCounts[targetCodes[codeIndex]] || 0;
      }
      return selectedCount;
    }

    function nextLazyMarkVersion() {
      ensureLazySelectionMarksSize(lazyEncodedState.codeToValue.length);
      if (lazyEncodedState.selectionMarkVersion === 0xffffffff) {
        lazyEncodedState.selectionMarks.fill(0);
        lazyEncodedState.selectionMarkVersion = 1;
      }
      return lazyEncodedState.selectionMarkVersion++;
    }

    function encodeLazyFilterValues(filterValues) {
      if (!lazyEncodedState) {
        return null;
      }

      var encodedValues = new Uint32Array(filterValues.length),
          count = 0,
          i,
          markVersion = nextLazyMarkVersion(),
          selectionMarks = lazyEncodedState.selectionMarks,
          valueToCode = lazyEncodedState.valueToCode,
          valueToEncode,
          code;

      for (i = 0; i < filterValues.length; ++i) {
        valueToEncode = filterValues[i];
        if (!isLazyEncodedValue(valueToEncode)) {
          return null;
        }
        code = valueToCode.get(valueToEncode);
        if (code === undefined || selectionMarks[code] === markVersion) {
          continue;
        }
        selectionMarks[code] = markVersion;
        encodedValues[count++] = code;
      }

      return encodedValues.subarray(0, count);
    }

    function applyLazyClearFilter() {
      if (!lazyEncodedState.hasActiveFilterMask) {
        return dimension;
      }

      var otherMode = (transientFilterDepth === 0 && batchedFilterDepth === 0 && filterListeners.length > 0)
            ? inspectOtherFilterListeners(dimSlot)
            : 0,
          prevSelected = lazyEncodedState.lastSelectedCount,
          useForceReset = otherMode === 1 && (
            !filterStore.hasOtherActive(dimSlot)
            || (prevSelected >= 0 && (n - prevSelected) > (n >>> 2))
          ),
          needDeltas = otherMode > 0 && !useForceReset;

      lazyEncodedState.hasActiveFilterMask = false;
      lazyEncodedState.lastSelectedCount = -1;

      if (!needDeltas) {
        filterStore.deactivate(dimSlot);
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
        return dimension;
      }

      var useScratch = !deltaBufInUse,
          added = useScratch ? (deltaAddedBuf = ensureUint32Capacity(deltaAddedBuf, n)) : [],
          addedCount;

      if (useScratch) deltaBufInUse = true;
      addedCount = filterStore.clearSlotWithDeltas(dimSlot, added, useScratch);

      if (useScratch) {
        try {
          notifyFilterListeners(dimSlot, added.subarray(0, addedCount), EMPTY_ARRAY);
        } finally {
          deltaBufInUse = false;
        }
      } else {
        notifyFilterListeners(dimSlot, added, EMPTY_ARRAY);
      }
      return dimension;
    }

    function applyLazyEncodedFilter(targetCodes, nextMode) {
      filterMode = nextMode;
      lo0 = 0;
      hi0 = 0;

      if (n === 0) {
        return applyLazyClearFilter();
      }
      var selectedCount = countLazySelectedRows(targetCodes);
      if (selectedCount === n) {
        return applyLazyClearFilter();
      }

      var hadMask = lazyEncodedState.hasActiveFilterMask,
          prevSelected = lazyEncodedState.lastSelectedCount,
          codes = lazyEncodedState.codes,
          targetCount = targetCodes.length,
          otherMode = (transientFilterDepth === 0 && batchedFilterDepth === 0 && filterListeners.length > 0)
            ? inspectOtherFilterListeners(dimSlot)
            : 0,
          useForceReset = otherMode === 1 && (
            !hadMask
              ? ((n - selectedCount) > 1024 || (n - selectedCount) > (n >>> 2))
              : (prevSelected >= 0 && Math.abs(selectedCount - prevSelected) > (n >>> 2))
          ),
          needDeltas = otherMode > 0 && !useForceReset,
          markVersion = 0,
          selectionMarks = null,
          t0 = 0,
          i;

      if (targetCount === 1) {
        t0 = targetCodes[0];
      } else if (targetCount > 1) {
        markVersion = nextLazyMarkVersion();
        selectionMarks = lazyEncodedState.selectionMarks;
        for (i = 0; i < targetCount; ++i) {
          selectionMarks[targetCodes[i]] = markVersion;
        }
      }

      lazyEncodedState.hasActiveFilterMask = true;
      lazyEncodedState.lastSelectedCount = selectedCount;

      var writeMode = targetCount === 0 ? 0 : (targetCount === 1 ? 1 : 2);
      var argA = targetCount === 1 ? t0 : selectionMarks;
      var argB = markVersion;

      if (!needDeltas) {
        filterStore.writePredicateNoDelta(dimSlot, writeMode, codes, argA, argB);
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
        return dimension;
      }

      var useScratch = !deltaBufInUse,
          added,
          removed,
          canBail = otherMode === 1,
          bailLimit = n >>> 2;

      if (useScratch) {
        deltaAddedBuf = ensureUint32Capacity(deltaAddedBuf, n);
        deltaRemovedBuf = ensureUint32Capacity(deltaRemovedBuf, n);
        added = deltaAddedBuf;
        removed = deltaRemovedBuf;
        deltaBufInUse = true;
      } else {
        added = [];
        removed = [];
      }

      var res = filterStore.writePredicateWithDeltas(
        dimSlot, writeMode, codes, argA, argB,
        added, removed, useScratch, canBail, bailLimit
      );

      if (res.bailed) {
        if (useScratch) deltaBufInUse = false;
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, true);
        return dimension;
      }

      if (useScratch) {
        try {
          notifyFilterListeners(
            dimSlot,
            added.subarray(0, res.addedCount),
            removed.subarray(0, res.removedCount)
          );
        } finally {
          deltaBufInUse = false;
        }
      } else {
        notifyFilterListeners(dimSlot, added, removed);
      }
      return dimension;
    }

    function computeLazyRangeCodes(range) {
      var codeToValue = lazyEncodedState.codeToValue,
          rangeCodes = [],
          lo = range[0],
          hi = range[1],
          code,
          v;

      if (lazyEncodedState.isPureNumeric && typeof lo === 'number' && typeof hi === 'number' && lo === lo && hi === hi) {
        for (code = 1; code < codeToValue.length; ++code) {
          v = codeToValue[code];
          if (v >= lo && v < hi) {
            rangeCodes.push(code);
          }
        }
      } else {
        for (code = 1; code < codeToValue.length; ++code) {
          v = codeToValue[code];
          if (compareNaturalOrder(v, lo) >= 0 && compareNaturalOrder(v, hi) < 0) {
            rangeCodes.push(code);
          }
        }
      }

      return new Uint32Array(rangeCodes);
    }

    function resolveLazyTargetCodes() {
      if (!lazyEncodedState || !filterValuePresent || filterMode === 'all') {
        return new Uint32Array(0);
      }

      if (lazyFilterTargetCodes || (filterMode === 'bounds' && Array.isArray(filterValue))) {
        var currentCodeCount = lazyEncodedState.codeToValue.length;
        if (lazyFilterTargetCodes && currentCodeCount === lazyFilterTargetCodesVersion) {
          return lazyFilterTargetCodes;
        }
        lazyFilterTargetCodes = computeLazyRangeCodes(filterValue);
        lazyFilterTargetCodesVersion = currentCodeCount;
        return lazyFilterTargetCodes;
      }

      if (filterMode === 'in') {
        return encodeLazyFilterValues(filterInValues || []);
      }

      return encodeLazyFilterValues([filterValue]);
    }

    function applyLazyFilterToRange(startRow, length) {
      if (!filterValuePresent || filterMode === 'all' || !length) {
        return;
      }

      var targetCodes = resolveLazyTargetCodes();
      if (!targetCodes) {
        materializeLazyEncodedState();
        return;
      }

      var codes = lazyEncodedState.codes,
          targetCount = targetCodes.length,
          endRow = startRow + length,
          maskedAny = false,
          i;

      if (targetCount === 0) {
        for (i = startRow; i < endRow; ++i) {
          filterStore.setSlotExcluded(dimSlot, i);
        }
        maskedAny = true;
      } else if (targetCount === 1) {
        var t0 = targetCodes[0];
        for (i = startRow; i < endRow; ++i) {
          if (codes[i] !== t0) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      } else {
        var markVersion = nextLazyMarkVersion(),
            selectionMarks = lazyEncodedState.selectionMarks;
        for (i = 0; i < targetCount; ++i) {
          selectionMarks[targetCodes[i]] = markVersion;
        }
        for (i = startRow; i < endRow; ++i) {
          if (selectionMarks[codes[i]] !== markVersion) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      }

      if (maskedAny) {
        lazyEncodedState.hasActiveFilterMask = true;
      }
      lazyEncodedState.lastSelectedCount = -1;
    }

    function compactLazyEncodedState(reIndex) {
      var nextLength = 0,
          i,
          nextCodes,
          rowIndex,
          hasActiveMask = false;

      for (i = 0; i < reIndex.length; ++i) {
        if (reIndex[i] !== REMOVED_INDEX) {
          ++nextLength;
        }
      }

      var nextCodesCapacity = nextLength < 64 ? 64 : nextLength;
      nextCodes = new Uint32Array(nextCodesCapacity);

      var existingCodes = lazyEncodedState.codes;
      for (i = 0, rowIndex = 0; i < reIndex.length; ++i) {
        if (reIndex[i] === REMOVED_INDEX) {
          continue;
        }
        nextCodes[rowIndex] = existingCodes[i];
        if (!hasActiveMask && filterStore.isSlotExcluded(dimSlot, i)) {
          hasActiveMask = true;
        }
        ++rowIndex;
      }
      if (!hasActiveMask && dimSlot.active) {
        filterStore.deactivate(dimSlot);
      }

      var codeToValue = lazyEncodedState.codeToValue;
      var codeCounts = buildCodeCounts(nextCodes, nextLength, codeToValue.length);
      var hasUnorderable = false;
      var isPureNumeric = true;
      var isPureString = true;
      for (var c = 1; c < codeToValue.length; ++c) {
        if (codeCounts[c] > 0) {
          var v = codeToValue[c];
          if (v === undefined || !(v >= v)) {
            hasUnorderable = true;
            isPureNumeric = false;
            isPureString = false;
          } else if (typeof v === 'number') {
            isPureString = false;
          } else if (typeof v === 'string') {
            isPureNumeric = false;
          } else {
            isPureNumeric = false;
            isPureString = false;
          }
        }
      }

      lazyEncodedState.codes = nextCodes;
      lazyEncodedState.codesLength = nextLength;
      lazyEncodedState.codeCounts = codeCounts;
      lazyEncodedState.hasActiveFilterMask = hasActiveMask;
      lazyEncodedState.hasUnorderable = hasUnorderable;
      lazyEncodedState.isPureNumeric = isPureNumeric;
      lazyEncodedState.isPureString = isPureString;
      lazyEncodedState.lastSelectedCount = -1;
      lazyEncodedState.version += 1;
      lazyEncodedState.codeRank = null;
      lo0 = 0;
      hi0 = 0;
    }

    function getLazyCodeRank() {
      if (lazyEncodedState.codeRank && lazyEncodedState.codeRankVersion === lazyEncodedState.version) {
        return lazyEncodedState.codeRank;
      }
      var codeToValue = lazyEncodedState.codeToValue,
          codeCounts = lazyEncodedState.codeCounts,
          activeCodes = [],
          c;
      for (c = 1; c < codeToValue.length; ++c) {
        if (codeCounts[c] > 0) {
          activeCodes.push(c);
        }
      }
      var isFastOrder = lazyEncodedState.isPureNumeric || lazyEncodedState.isPureString;
      if (isFastOrder) {
        activeCodes.sort(function(a, b) {
          var va = codeToValue[a], vb = codeToValue[b];
          return va < vb ? -1 : va > vb ? 1 : a - b;
        });
      } else {
        activeCodes.sort(function(a, b) {
          var order = compareNaturalOrder(codeToValue[a], codeToValue[b]);
          return order || a - b;
        });
      }
      var rankArr = new Uint32Array(codeToValue.length);
      var currentRank = 0;
      for (var i = 0; i < activeCodes.length; ++i) {
        if (i > 0) {
          if (isFastOrder) {
            if (codeToValue[activeCodes[i - 1]] !== codeToValue[activeCodes[i]]) {
              ++currentRank;
            }
          } else if (compareNaturalOrder(codeToValue[activeCodes[i - 1]], codeToValue[activeCodes[i]]) !== 0) {
            ++currentRank;
          }
        }
        rankArr[activeCodes[i]] = currentRank;
      }
      lazyEncodedState.codeRank = rankArr;
      lazyEncodedState.codeRankVersion = lazyEncodedState.version;
      return rankArr;
    }

    function upgradeRawNumericToLazy(existingLength) {
      if (!rawNumericState || lazyEncodedState || values) {
        return;
      }
      if (brushDimSlot === dimSlot) {
        filterStore.ensureSlotMaterialized(dimSlot);
        invalidateBrushState();
      }
      var len = existingLength === undefined ? n : existingLength;
      var rawValues = rawNumericState.values;
      var hadMask = rawNumericState.hasActiveFilterMask;
      rawNumericState = null;
      lazyEncodedState = createLazyEncodedStateFromSource(rawValues, null, 0, len);
      if (lazyEncodedState) {
        lazyEncodedState.hasActiveFilterMask = hadMask;
        if (filterValuePresent && filterMode === 'bounds' && Array.isArray(filterValue)) {
          lazyFilterTargetCodes = computeLazyRangeCodes(filterValue);
          lazyFilterTargetCodesVersion = lazyEncodedState.codeToValue.length;
        }
      }
      for (var i = 0; i < dimensionGroups.length; ++i) {
        if (typeof dimensionGroups[i]._onRawNumericUpgrade === 'function') {
          dimensionGroups[i]._onRawNumericUpgrade();
        }
      }
    }

    function applyRawNumericClearFilter() {
      if (!rawNumericState.hasActiveFilterMask) {
        return dimension;
      }
      var otherMode = (transientFilterDepth === 0 && batchedFilterDepth === 0 && filterListeners.length > 0)
            ? inspectOtherFilterListeners(dimSlot)
            : 0,
          useForceReset = otherMode === 1 && (
            !filterStore.hasOtherActive(dimSlot)
            || rawNumericState.lastMaskedCount > (n >>> 2)
          ),
          needDeltas = otherMode > 0 && !useForceReset;
      rawNumericState.hasActiveFilterMask = false;
      rawNumericState.lastMaskedCount = -1;
      if (!needDeltas) {
        filterStore.deactivate(dimSlot);
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
        return dimension;
      }
      var useScratch = !deltaBufInUse,
          added = useScratch ? (deltaAddedBuf = ensureUint32Capacity(deltaAddedBuf, n)) : [],
          addedCount;
      if (useScratch) deltaBufInUse = true;
      addedCount = filterStore.clearSlotWithDeltas(dimSlot, added, useScratch);
      if (useScratch) {
        try {
          notifyFilterListeners(dimSlot, added.subarray(0, addedCount), EMPTY_ARRAY);
        } finally {
          deltaBufInUse = false;
        }
      } else {
        notifyFilterListeners(dimSlot, added, EMPTY_ARRAY);
      }
      return dimension;
    }

    function applyRawNumericPredicate(kind, argA, argB, nextMode) {
      filterMode = nextMode;
      lo0 = 0;
      hi0 = 0;
      if (n === 0) {
        return applyRawNumericClearFilter();
      }
      var hadMask = rawNumericState.hasActiveFilterMask,
          vals = rawNumericState.values,
          otherMode = (transientFilterDepth === 0 && batchedFilterDepth === 0 && filterListeners.length > 0)
            ? inspectOtherFilterListeners(dimSlot)
            : 0,
          useForceReset = otherMode === 1 && !hadMask && n > 1024,
          needDeltas = otherMode > 0 && !useForceReset,
          writeMode = kind === 0 ? 0 : (kind === 1 ? 3 : (kind === 2 ? 4 : 5)),
          matchedCount,
          maskedCount;

      if (!needDeltas) {
        matchedCount = filterStore.writePredicateNoDelta(dimSlot, writeMode, vals, argA, argB);
        maskedCount = n - matchedCount;
        if (maskedCount === 0) {
          filterStore.deactivate(dimSlot);
          rawNumericState.hasActiveFilterMask = false;
          rawNumericState.lastMaskedCount = 0;
          if (!hadMask) {
            return dimension;
          }
          notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
          return dimension;
        }
        rawNumericState.hasActiveFilterMask = true;
        rawNumericState.lastMaskedCount = maskedCount;
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, useForceReset);
        return dimension;
      }

      var useScratch = !deltaBufInUse,
          added = useScratch ? (deltaAddedBuf = ensureUint32Capacity(deltaAddedBuf, n)) : [],
          removed = useScratch ? (deltaRemovedBuf = ensureUint32Capacity(deltaRemovedBuf, n)) : [],
          canBail = otherMode === 1,
          bailLimit = n >>> 2;
      if (useScratch) deltaBufInUse = true;

      var res = filterStore.writePredicateWithDeltas(
        dimSlot, writeMode, vals, argA, argB,
        added, removed, useScratch, canBail, bailLimit
      );
      maskedCount = n - res.matchedCount;
      if (maskedCount === 0) {
        filterStore.deactivate(dimSlot);
      }
      rawNumericState.hasActiveFilterMask = maskedCount > 0;
      rawNumericState.lastMaskedCount = maskedCount;

      if (res.bailed) {
        if (useScratch) deltaBufInUse = false;
        notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, true);
        return dimension;
      }

      if (!hadMask && maskedCount === 0) {
        if (useScratch) deltaBufInUse = false;
        return dimension;
      }
      if (useScratch) {
        try {
          notifyFilterListeners(dimSlot, added.subarray(0, res.addedCount), removed.subarray(0, res.removedCount));
        } finally {
          deltaBufInUse = false;
        }
      } else {
        notifyFilterListeners(dimSlot, added, removed);
      }
      return dimension;
    }

    function applyRawNumericFilterToRange(startRow, length) {
      if (!filterValuePresent || filterMode === 'all' || !length) {
        return;
      }
      var vals = rawNumericState.values,
          endRow = startRow + length,
          maskedAny = false,
          i,
          v;
      if (filterMode === 'in') {
        var inSet = new Set(filterInValues || []);
        for (i = startRow; i < endRow; ++i) {
          if (!inSet.has(vals[i])) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      } else if (Array.isArray(filterValue)) {
        var lo = filterValue[0],
            hi = filterValue[1];
        for (i = startRow; i < endRow; ++i) {
          v = vals[i];
          if (!(v >= lo && v < hi)) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      } else {
        for (i = startRow; i < endRow; ++i) {
          if (vals[i] !== filterValue) {
            filterStore.setSlotExcluded(dimSlot, i);
            maskedAny = true;
          }
        }
      }
      if (maskedAny) {
        rawNumericState.hasActiveFilterMask = true;
      }
      rawNumericState.lastMaskedCount = -1;
    }

    function materializeLazyEncodedState() {
      if (brushDimSlot === dimSlot) {
        filterStore.ensureSlotMaterialized(dimSlot);
        invalidateBrushState();
      }
      if (rawNumericState && !values) {
        upgradeRawNumericToLazy(n);
      }
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

      for (i = 0; i < dimensionGroups.length; ++i) {
        if (typeof dimensionGroups[i]._onDimensionMaterialize === 'function') {
          dimensionGroups[i]._onDimensionMaterialize(lazyCodes);
        }
      }

      lazyEncodedState = null;
    }

    function hasLazyEncodedGroupingSupport() {
      return !!(lazyEncodedState && !values && !iterable && !lazyEncodedState.hasUnorderable);
    }

    function setFilterValuePresent(nextPresent) {
      filterValuePresent = !!nextPresent;
    }

    function hasOtherActiveDimensionFilters() {
      return filterStore.hasOtherActive(dimSlot);
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

      if (!iterable) {
        if (filterMode === 'all') {
          filterStore.deactivate(dimSlot);
        } else {
          if (removed.length > 0 && !dimSlot.active) {
            filterStore.activateAllOnes(dimSlot);
          }
          if (dimSlot.active) {
            filterStore.ensureSlotMaterialized(dimSlot);
            var bits = dimSlot.bitset;
            for (i = 0; i < added.length; i++) {
              row = added[i];
              bits[row >>> 5] |= (1 << (row & 31));
            }
            for (i = 0; i < removed.length; i++) {
              row = removed[i];
              bits[row >>> 5] &= ~(1 << (row & 31));
            }
          }
        }
      } else {
        var newAdded = [];
        var newRemoved = [];

        for (i = 0; i < added.length; i++) {
          iterablesIndexCount[added[i]]++;
          iterablesIndexFilterStatus[valueIndexAdded[i]] = 0;
          if (iterablesIndexCount[added[i]] === 1) {
            filterStore.setSlotIncluded(dimSlot, added[i]);
            newAdded.push(added[i]);
          }
        }
        for (i = 0; i < removed.length; i++) {
          iterablesIndexCount[removed[i]]--;
          iterablesIndexFilterStatus[valueIndexRemoved[i]] = 1;
          if (iterablesIndexCount[removed[i]] === 0) {
            filterStore.setSlotExcluded(dimSlot, removed[i]);
            newRemoved.push(removed[i]);
          }
        }

        added = newAdded;
        removed = newRemoved;

        if (includeEmptyRows) {
          for (i = 0; i < iterablesEmptyRows.length; i++) {
            row = iterablesEmptyRows[i];
            if (filterStore.isSlotExcluded(dimSlot, row)) {
              filterStore.setSlotIncluded(dimSlot, row);
              added.push(row);
            }
          }
        } else {
          for (i = 0; i < iterablesEmptyRows.length; i++) {
            row = iterablesEmptyRows[i];
            if (!filterStore.isSlotExcluded(dimSlot, row)) {
              filterStore.setSlotExcluded(dimSlot, row);
              removed.push(row);
            }
          }
        }
        if (filterMode === 'all') {
          filterStore.deactivate(dimSlot);
        }
      }

      notifyFilterListeners(dimSlot, added, removed);
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

    var lazyStateGetter = null;
    if (accessorPath && !iterable) {
      lazyStateGetter = function() {
        return (!values && lazyEncodedState) ? lazyEncodedState : null;
      };
      if (!lazyDimensionsByField[accessorPath]) {
        lazyDimensionsByField[accessorPath] = [];
      }
      lazyDimensionsByField[accessorPath].push(lazyStateGetter);
    }

    // Allocate a 1-bit filter slot in filterStore (reusing disposed dimension IDs).
    dimSlot = filterStore.allocSlot();
    id = dimSlot.id;

    function ensureDeferredReady() {
      if (!deferredInit) return;
      deferredInit = false;
      preAdd(data, 0, n);
      postAdd(data, 0, n);
    }

    if (isStringField && !iterable && (columnarBatches.length > 0 || n === 0)) {
      deferredInit = true;
      runtimeController.canUseWasmScan();
    } else {
      preAdd(data, 0, n);
      postAdd(data, 0, n);
    }

    // Incorporates the specified new records into this dimension.
    // This function is responsible for updating filters, values, and index.
    function preAdd(newData, n0, n1) {
      if (deferredInit) {
        if (columnarBatches.length > 0 && columnarBatches[columnarBatches.length - 1].end === n) {
          return;
        }
        deferredInit = false;
        if (n0 > 0) {
          preAdd(data, 0, n);
          return;
        }
      }
      var newIterablesIndexCount,
          sourceValues = null,
          columnAccessorSegment = accessorPath && !iterable
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
        if (!rawNumericState && !lazyEncodedState && !n0 && !values) {
          if (n1 > 0 && isPureNumericColumnSource(accessorPath)) {
            var initNumCol = getNumericColumn(accessorPath);
            if (!initNumCol.hasNaN) {
              runtimeController.canUseWasmScan();
              rawNumericState = {
                field: accessorPath,
                hasActiveFilterMask: false,
                lastMaskedCount: -1,
                values: initNumCol.values,
                version: 1
              };
              applyRawNumericFilterToRange(0, n1);
              lastAppendedCodes = null;
              lo0 = 0;
              hi0 = 0;
              return;
            }
          }
          lazyEncodedState = columnAccessorSegment
            ? (columnAccessorSegment.arrowDictChunks
              ? createLazyEncodedStateFromArrowDict(columnAccessorSegment.arrowDictChunks, columnAccessorSegment.offset, n1)
              : (columnAccessorSegment.arrowUtf8Chunks
                ? createLazyEncodedStateFromSource(extractArrowUtf8Range(columnAccessorSegment.arrowUtf8Chunks, columnAccessorSegment.offset, n1), null, 0, n1)
                : createLazyEncodedStateFromSource(columnAccessorSegment.column, columnAccessorSegment.accessor, columnAccessorSegment.offset, n1)))
            : createLazyEncodedStateFromSource(ensureSourceValues(), null, 0, n1);
          if (lazyEncodedState) {
            applyLazyFilterToRange(0, n1);
            lastAppendedCodes = getLazyCodes();
            lo0 = 0;
            hi0 = 0;
            return;
          }
        } else if (rawNumericState && !values) {
          if (isPureNumericColumnSource(accessorPath)) {
            var nextNumCol = getNumericColumn(accessorPath);
            if (!nextNumCol.hasNaN) {
              rawNumericState.values = nextNumCol.values;
              rawNumericState.version += 1;
              applyRawNumericFilterToRange(n0, n1);
              lastAppendedCodes = null;
              lo0 = 0;
              hi0 = 0;
              return;
            }
          }
          upgradeRawNumericToLazy(n0);
          if (lazyEncodedState) {
            var upgradedAppendedCodes = columnAccessorSegment
              ? (columnAccessorSegment.arrowDictChunks
                ? appendLazyEncodedValuesFromArrowDict(columnAccessorSegment.arrowDictChunks, columnAccessorSegment.offset, n1)
                : (columnAccessorSegment.arrowUtf8Chunks
                  ? appendLazyEncodedValuesFromSource(extractArrowUtf8Range(columnAccessorSegment.arrowUtf8Chunks, columnAccessorSegment.offset, n1), null, 0, n1)
                  : appendLazyEncodedValuesFromSource(columnAccessorSegment.column, columnAccessorSegment.accessor, columnAccessorSegment.offset, n1)))
              : appendLazyEncodedValuesFromSource(ensureSourceValues(), null, 0, n1);
            if (upgradedAppendedCodes) {
              applyLazyFilterToRange(n0, n1);
              lastAppendedCodes = upgradedAppendedCodes;
              lo0 = 0;
              hi0 = 0;
              return;
            }
          }
          materializeLazyEncodedState();
        } else if (lazyEncodedState && !values) {
          if (
            !n0
            && n1 > 0
            && lazyEncodedState.codesLength === 0
            && !refilterFunction
            && (!filterValuePresent || filterMode === 'all' || filterMode === 'in' || typeof filterValue === 'number' || (Array.isArray(filterValue) && typeof filterValue[0] === 'number' && typeof filterValue[1] === 'number'))
            && isPureNumericColumnSource(accessorPath)
          ) {
            var canPromoteGroups = true;
            for (var pgi = 0; pgi < dimensionGroups.length; ++pgi) {
              if (!dimensionGroups[pgi]._canPromoteToRawNumeric) {
                canPromoteGroups = false;
                break;
              }
            }
            if (canPromoteGroups) {
              var promotedNumCol = getNumericColumn(accessorPath);
              if (!promotedNumCol.hasNaN) {
                rawNumericState = {
                  field: accessorPath,
                  hasActiveFilterMask: false,
                  lastMaskedCount: -1,
                  values: promotedNumCol.values,
                  version: 1
                };
                lazyEncodedState = null;
                lazyFilterTargetCodes = null;
                lazyFilterTargetCodesVersion = 0;
                for (var pgi2 = 0; pgi2 < dimensionGroups.length; ++pgi2) {
                  if (typeof dimensionGroups[pgi2]._onRawNumericPromote === 'function') {
                    dimensionGroups[pgi2]._onRawNumericPromote();
                  }
                }
                applyRawNumericFilterToRange(0, n1);
                lastAppendedCodes = null;
                lo0 = 0;
                hi0 = 0;
                return;
              }
            }
          }
          var appendedCodes = columnAccessorSegment
            ? (columnAccessorSegment.arrowDictChunks
              ? appendLazyEncodedValuesFromArrowDict(columnAccessorSegment.arrowDictChunks, columnAccessorSegment.offset, n1)
              : (columnAccessorSegment.arrowUtf8Chunks
                ? appendLazyEncodedValuesFromSource(extractArrowUtf8Range(columnAccessorSegment.arrowUtf8Chunks, columnAccessorSegment.offset, n1), null, 0, n1)
                : appendLazyEncodedValuesFromSource(columnAccessorSegment.column, columnAccessorSegment.accessor, columnAccessorSegment.offset, n1)))
            : appendLazyEncodedValuesFromSource(ensureSourceValues(), null, 0, n1);
          if (appendedCodes) {
            applyLazyFilterToRange(n0, n1);
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
      if (iterable) {
        n1 = t;
        if (refilterFunction) {
          for (index2 = 0; index2 < n1; ++index2) {
            if (!refilterFunction(newValues[index2], index2)) {
              if (--newIterablesIndexCount[newIndex[index2]] === 0) {
                filterStore.setSlotExcluded(dimSlot, newIndex[index2] + n0);
              }
              newIterablesIndexFilterStatus[index2] = 1;
            }
          }
        } else {
          for (index3 = 0; index3 < lo1; ++index3) {
            if (--newIterablesIndexCount[newIndex[index3]] === 0) {
              filterStore.setSlotExcluded(dimSlot, newIndex[index3] + n0);
            }
            newIterablesIndexFilterStatus[index3] = 1;
          }
          for (index4 = hi1; index4 < n1; ++index4) {
            if (--newIterablesIndexCount[newIndex[index4]] === 0) {
              filterStore.setSlotExcluded(dimSlot, newIndex[index4] + n0);
            }
            newIterablesIndexFilterStatus[index4] = 1;
          }
        }
      } else {
        if (refilterFunction) {
          for (index2 = 0; index2 < n1; ++index2) {
            if (!refilterFunction(newValues[index2], index2)) {
              filterStore.setSlotExcluded(dimSlot, newIndex[index2] + n0);
            }
          }
        } else {
          for (index3 = 0; index3 < lo1; ++index3) {
            filterStore.setSlotExcluded(dimSlot, newIndex[index3] + n0);
          }
          for (index4 = hi1; index4 < n1; ++index4) {
            filterStore.setSlotExcluded(dimSlot, newIndex[index4] + n0);
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
      if (deferredInit) return;
      indexListeners.forEach(function(l) { l(newValues, newIndex, n0, n1, lastAppendedCodes); });
      newValues = newIndex = null;
      lastAppendedCodes = null;
    }

    function removeData(reIndex) {
      if (deferredInit) return;
      if (rawNumericState && !values) {
        var rLen = 0,
            ri,
            rj,
            rawHasMask = false;
        for (ri = 0; ri < reIndex.length; ++ri) {
          if (reIndex[ri] !== REMOVED_INDEX) ++rLen;
        }
        var nextRawVals = new Float64Array(rLen < 64 ? 64 : rLen);
        var oldRawVals = rawNumericState.values;
        for (ri = 0, rj = 0; ri < reIndex.length; ++ri) {
          if (reIndex[ri] === REMOVED_INDEX) continue;
          nextRawVals[rj++] = oldRawVals[ri];
          if (!rawHasMask && filterStore.isSlotExcluded(dimSlot, ri)) rawHasMask = true;
        }
        if (!rawHasMask && dimSlot.active) {
          filterStore.deactivate(dimSlot);
        }
        rawNumericState.values = nextRawVals;
        rawNumericState.hasActiveFilterMask = rawHasMask;
        rawNumericState.lastMaskedCount = -1;
        rawNumericState.version += 1;
        lo0 = 0;
        hi0 = 0;
        for (ri = 0; ri < dimensionGroups.length; ++ri) {
          if (typeof dimensionGroups[ri]._onRawNumericRemove === 'function') {
            dimensionGroups[ri]._onRawNumericRemove();
          }
        }
        return;
      }
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

    function materializeRawBrushBitset() {
      if (!rawNumericState || values) return;
      var vals = rawNumericState.values;
      var writeMode = brushQueryKind === 'exact' ? 3 : 4;
      var matched = filterStore.writePredicateNoDelta(dimSlot, writeMode, vals, brushLo, brushHi);
      if (matched === n) {
        filterStore.deactivate(dimSlot);
        rawNumericState.hasActiveFilterMask = false;
        rawNumericState.lastMaskedCount = 0;
      } else {
        rawNumericState.hasActiveFilterMask = true;
        rawNumericState.lastMaskedCount = n - matched;
      }
    }

    function materializeLazyBrushBitset() {
      if (!lazyEncodedState || values) return;
      var targetCodes = brushQueryKind === 'exact'
        ? encodeLazyFilterValues([brushLo])
        : computeLazyRangeCodes([brushLo, brushHi]);
      if (!targetCodes) {
        filterStore.writePredicateNoDelta(dimSlot, 0, lazyEncodedState.codes, 0, 0);
        lazyEncodedState.hasActiveFilterMask = true;
        lazyEncodedState.lastSelectedCount = 0;
        return;
      }
      if (brushQueryKind === 'range') {
        lazyFilterTargetCodes = targetCodes;
        lazyFilterTargetCodesVersion = lazyEncodedState.codeToValue.length;
      }
      var selCount = countLazySelectedRows(targetCodes);
      if (selCount === n) {
        filterStore.deactivate(dimSlot);
        lazyEncodedState.hasActiveFilterMask = false;
        lazyEncodedState.lastSelectedCount = -1;
        return;
      }
      var targetCount = targetCodes.length;
      var writeMode = targetCount === 0 ? 0 : (targetCount === 1 ? 1 : 2);
      var argA = targetCount === 1 ? targetCodes[0] : null;
      var argB = 0;
      if (targetCount > 1) {
        argB = nextLazyMarkVersion();
        argA = lazyEncodedState.selectionMarks;
        for (var mi = 0; mi < targetCount; ++mi) argA[targetCodes[mi]] = argB;
      }
      filterStore.writePredicateNoDelta(dimSlot, writeMode, lazyEncodedState.codes, argA, argB);
      lazyEncodedState.hasActiveFilterMask = true;
      lazyEncodedState.lastSelectedCount = selCount;
    }

    function tryEnterFalconBrush(queryKind, lo, hi, isRaw) {
      if (transientFilterDepth > 0 || batchedFilterDepth > 0 || n < 256) {
        return false;
      }
      var otherMode = filterListeners.length > 0 ? inspectOtherFilterListeners(dimSlot) : 0;
      if (otherMode !== 1) {
        return false;
      }
      if (brushDimSlot !== dimSlot) {
        invalidateBrushState();
        brushDimSlot = dimSlot;
        return false;
      }
      if (brushBuildFailed) {
        return false;
      }
      // On exact queries, only use Falcon if discrete mode (raw or lazy); avoid continuous CSR exact scan overhead on single clicks
      if (queryKind === 'exact' && brushFalcon && brushFalcon.mode !== 'discrete') {
        return false;
      }
      filterMode = 'bounds';
      lo0 = 0;
      hi0 = 0;
      brushActive = true;
      brushQueryKind = queryKind;
      brushLo = lo;
      brushHi = hi;
      brushDimSource = isRaw
        ? function() { return { isNumeric: true, rawVals: rawNumericState.values, lazyCodes: null, lazyCodeToValue: null }; }
        : function() { return { isNumeric: lazyEncodedState.isPureNumeric, rawVals: null, lazyCodes: lazyEncodedState.codes, lazyCodeToValue: lazyEncodedState.codeToValue }; };
      dimSlot.materialize = isRaw ? materializeRawBrushBitset : materializeLazyBrushBitset;
      filterStore.markDirty(dimSlot);
      if (isRaw) {
        rawNumericState.hasActiveFilterMask = true;
        rawNumericState.lastMaskedCount = -1;
      } else {
        lazyEncodedState.hasActiveFilterMask = true;
        lazyEncodedState.lastSelectedCount = -1;
      }
      notifyFilterListeners(dimSlot, EMPTY_ARRAY, EMPTY_ARRAY, true);
      return true;
    }

    // Filters this dimension to select the exact value.
    function filterExact(value) {
      ensureDeferredReady();
      lazyFilterTargetCodes = null;
      lazyFilterTargetCodesVersion = 0;
      if (rawNumericState && !values) {
        if (isLazyEncodedValue(value)) {
          filterValue = value;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterExact(bisect, value);
          refilterFunction = null;
          filterInValues = null;
          if (typeof value === 'number' && value === value) {
            if (tryEnterFalconBrush('exact', value, value, true)) {
              return dimension;
            }
            if (brushDimSlot === dimSlot) brushActive = false;
            return applyRawNumericPredicate(1, value, 0, 'bounds');
          }
          if (brushDimSlot === dimSlot) invalidateBrushState();
          return applyRawNumericPredicate(0, 0, 0, 'bounds');
        }
        materializeLazyEncodedState();
      }
      if (lazyEncodedState && !values) {
        var exactCodes = encodeLazyFilterValues([value]);
        if (exactCodes) {
          filterValue = value;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterExact(bisect, value);
          refilterFunction = null;
          filterInValues = null;
          if (
            hasLazyEncodedGroupingSupport()
            && ((lazyEncodedState.isPureNumeric && typeof value === 'number' && value === value)
              || (lazyEncodedState.isPureString && typeof value === 'string'))
            && tryEnterFalconBrush('exact', value, value, false)
          ) {
            return dimension;
          }
          if (brushDimSlot === dimSlot) brushActive = false;
          return applyLazyEncodedFilter(exactCodes, 'bounds');
        }
        materializeLazyEncodedState();
      }

      if (brushDimSlot === dimSlot) invalidateBrushState();
      filterValue = value;
      setFilterValuePresent(true);
      refilter = xfilterFilter.filterExact(bisect, value);
      var range = getExactRange(value);
      return filterIndexBounds(range || [0, 0], false, 'bounds');
    }

    function filterIn(valuesToSelect) {
      ensureDeferredReady();
      if (brushDimSlot === dimSlot) {
        filterStore.ensureSlotMaterialized(dimSlot);
        invalidateBrushState();
      }
      lazyFilterTargetCodes = null;
      lazyFilterTargetCodesVersion = 0;
      if (rawNumericState && !values) {
        var rawExactFilterValues = normalizeExactFilterValues(valuesToSelect),
            allLazy = true,
            numSet = new Set(),
            ri;
        for (ri = 0; ri < rawExactFilterValues.length; ++ri) {
          var rv = rawExactFilterValues[ri];
          if (!isLazyEncodedValue(rv)) {
            allLazy = false;
            break;
          }
          if (typeof rv === 'number' && rv === rv) {
            numSet.add(rv);
          }
        }
        if (allLazy) {
          filterValue = valuesToSelect;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterAll;
          refilterFunction = null;
          filterMode = 'in';
          filterInValues = rawExactFilterValues;
          if (numSet.size === 0) {
            return applyRawNumericPredicate(0, 0, 0, 'in');
          }
          if (numSet.size === 1) {
            return applyRawNumericPredicate(1, numSet.values().next().value, 0, 'in');
          }
          return applyRawNumericPredicate(3, numSet, 0, 'in');
        }
        materializeLazyEncodedState();
      }
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
      ensureDeferredReady();
      if (rawNumericState && !values) {
        var rLo = range[0],
            rHi = range[1];
        if (typeof rLo === 'number' && typeof rHi === 'number' && rLo === rLo && rHi === rHi) {
          filterValue = range;
          setFilterValuePresent(true);
          refilter = xfilterFilter.filterRange(bisect, range);
          refilterFunction = null;
          filterInValues = null;
          if (tryEnterFalconBrush('range', rLo, rHi, true)) {
            return dimension;
          }
          if (brushDimSlot === dimSlot) brushActive = false;
          return applyRawNumericPredicate(2, rLo, rHi, 'bounds');
        }
        upgradeRawNumericToLazy(n);
      }
      if (lazyEncodedState && !values && hasLazyEncodedGroupingSupport()) {
        filterValue = range;
        setFilterValuePresent(true);
        refilter = xfilterFilter.filterRange(bisect, range);
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'bounds';
        if (
          ((lazyEncodedState.isPureNumeric && typeof range[0] === 'number' && typeof range[1] === 'number' && range[0] === range[0] && range[1] === range[1])
            || (lazyEncodedState.isPureString && typeof range[0] === 'string' && typeof range[1] === 'string'))
          && tryEnterFalconBrush('range', range[0], range[1], false)
        ) {
          lazyFilterTargetCodes = null;
          lazyFilterTargetCodesVersion = 0;
          return dimension;
        }
        if (brushDimSlot === dimSlot) brushActive = false;
        lazyFilterTargetCodes = computeLazyRangeCodes(range);
        lazyFilterTargetCodesVersion = lazyEncodedState.codeToValue.length;
        return applyLazyEncodedFilter(lazyFilterTargetCodes, 'bounds');
      }

      if (lazyEncodedState && !values) {
        materializeLazyEncodedState();
      }

      if (brushDimSlot === dimSlot) invalidateBrushState();
      filterValue = range;
      setFilterValuePresent(true);
      return filterIndexBounds((refilter = xfilterFilter.filterRange(bisect, range))(values), false, 'bounds');
    }

    // Clears any filters on this dimension.
    function filterAll() {
      lazyFilterTargetCodes = null;
      lazyFilterTargetCodesVersion = 0;
      if (brushDimSlot === dimSlot) {
        invalidateBrushState();
      }
      if (deferredInit) {
        filterValue = undefined;
        setFilterValuePresent(false);
        refilter = xfilterFilter.filterAll;
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'all';
        return dimension;
      }
      if (rawNumericState && !values) {
        filterValue = undefined;
        setFilterValuePresent(false);
        refilter = xfilterFilter.filterAll;
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'all';
        return applyRawNumericClearFilter();
      }
      if (lazyEncodedState && !values) {
        filterValue = undefined;
        setFilterValuePresent(false);
        refilter = xfilterFilter.filterAll;
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'all';
        return applyLazyClearFilter();
      }

      filterValue = undefined;
      setFilterValuePresent(false);
      refilter = xfilterFilter.filterAll;

      return filterIndexBounds((refilter = xfilterFilter.filterAll)(values), true, 'all');
    }

    // Filters this dimension using an arbitrary function.
    function filterFunction(f) {
      ensureDeferredReady();
      if (brushDimSlot === dimSlot) {
        filterStore.ensureSlotMaterialized(dimSlot);
        invalidateBrushState();
      }
      lazyFilterTargetCodes = null;
      lazyFilterTargetCodesVersion = 0;
      if ((rawNumericState || lazyEncodedState) && !values) {
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

      if (!iterable) {
        for (i = 0; i < indexLength; ++i) {
          k = index[i];
          if (!filterStore.isSlotExcluded(dimSlot, k) ^ !!(x = f(values[i], i))) {
            if (x) added.push(k);
            else removed.push(k);
          }
        }
      }

      if (iterable) {
        for (i = 0; i < indexLength; ++i) {
          if (f(values[i], i)) {
            added.push(index[i]);
            valueIndexAdded.push(i);
          } else {
            removed.push(index[i]);
            valueIndexRemoved.push(i);
          }
        }
      }

      if (!iterable) {
        if (filterAll) {
          filterStore.deactivate(dimSlot);
        } else {
          for (i = 0; i < added.length; i++) {
            filterStore.setSlotIncluded(dimSlot, added[i]);
          }
          for (i = 0; i < removed.length; i++) {
            filterStore.setSlotExcluded(dimSlot, removed[i]);
          }
        }
      } else {
        var newAdded = [];
        var newRemoved = [];
        for (i = 0; i < added.length; i++) {
          if (iterablesIndexFilterStatus[valueIndexAdded[i]] === 1) {
            iterablesIndexCount[added[i]]++;
            iterablesIndexFilterStatus[valueIndexAdded[i]] = 0;
            if (iterablesIndexCount[added[i]] === 1) {
              filterStore.setSlotIncluded(dimSlot, added[i]);
              newAdded.push(added[i]);
            }
          }
        }
        for (i = 0; i < removed.length; i++) {
          if (iterablesIndexFilterStatus[valueIndexRemoved[i]] === 0) {
            iterablesIndexCount[removed[i]]--;
            iterablesIndexFilterStatus[valueIndexRemoved[i]] = 1;
            if (iterablesIndexCount[removed[i]] === 0) {
              filterStore.setSlotExcluded(dimSlot, removed[i]);
              newRemoved.push(removed[i]);
            }
          }
        }

        added = newAdded;
        removed = newRemoved;

        if (filterAll) {
          for (i = 0; i < iterablesEmptyRows.length; i++) {
            k = iterablesEmptyRows[i];
            if (filterStore.isSlotExcluded(dimSlot, k)) {
              filterStore.setSlotIncluded(dimSlot, k);
              added.push(k);
            }
          }
          filterStore.deactivate(dimSlot);
        } else {
          for (i = 0; i < iterablesEmptyRows.length; i++) {
            k = iterablesEmptyRows[i];
            if (!filterStore.isSlotExcluded(dimSlot, k)) {
              filterStore.setSlotExcluded(dimSlot, k);
              removed.push(k);
            }
          }
        }
      }

      notifyFilterListeners(dimSlot, added, removed);
    }

    function currentFilter() {
      return filterValue;
    }

    function hasCurrentFilter() {
      return filterValuePresent;
    }

    function readDimensionBounds() {
      if (iterable) {
        return null;
      }
      ensureDeferredReady();

      if (rawNumericState && !values) {
        var rVals = rawNumericState.values,
            rMin,
            rMax,
            ri,
            rv,
            rActive = getActiveRows();
        if (!rActive) {
          if (!n) return { max: null, min: null };
          rMin = rMax = rVals[0];
          for (ri = 1; ri < n; ++ri) {
            rv = rVals[ri];
            if (rv < rMin) rMin = rv;
            if (rv > rMax) rMax = rv;
          }
          return { max: rMax, min: rMin };
        }
        var rLen = rActive.length,
            rIdx = rActive.indices;
        if (!rLen) return { max: null, min: null };
        rMin = rMax = rVals[rIdx[0]];
        for (ri = 1; ri < rLen; ++ri) {
          rv = rVals[rIdx[ri]];
          if (rv < rMin) rMin = rv;
          if (rv > rMax) rMax = rv;
        }
        return { max: rMax, min: rMin };
      }

      if (lazyEncodedState && !values) {
        var codeToValue = lazyEncodedState.codeToValue,
            codeCounts = lazyEncodedState.codeCounts,
            codes = lazyEncodedState.codes,
            isPureNum = lazyEncodedState.isPureNumeric,
            hasAny = false,
            minVal = null,
            maxVal = null,
            c,
            i,
            v,
            active = getActiveRows();

        if (!active) {
          if (!n) return { max: null, min: null };
          if (isPureNum) {
            for (c = 1; c < codeToValue.length; ++c) {
              if (!codeCounts[c]) continue;
              v = codeToValue[c];
              if (!hasAny) {
                minVal = maxVal = v;
                hasAny = true;
              } else {
                if (v < minVal) minVal = v;
                if (v > maxVal) maxVal = v;
              }
            }
          } else {
            for (c = 1; c < codeToValue.length; ++c) {
              if (!codeCounts[c]) continue;
              v = codeToValue[c];
              if (!hasAny) {
                minVal = maxVal = v;
                hasAny = true;
              } else {
                if (compareNaturalOrder(v, minVal) < 0) minVal = v;
                if (compareNaturalOrder(v, maxVal) > 0) maxVal = v;
              }
            }
          }
          return {
            max: hasAny && maxVal != null ? maxVal : null,
            min: hasAny && minVal != null ? minVal : null
          };
        }

        var activeLen = active.length,
            activeIdx = active.indices;
        if (!activeLen) {
          return { max: null, min: null };
        }

        if (isPureNum) {
          minVal = maxVal = codeToValue[codes[activeIdx[0]]];
          for (i = 1; i < activeLen; ++i) {
            v = codeToValue[codes[activeIdx[i]]];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
          }
          return {
            max: maxVal != null ? maxVal : null,
            min: minVal != null ? minVal : null
          };
        }

        var markVersion = nextLazyMarkVersion(),
            marks = lazyEncodedState.selectionMarks;
        for (i = 0; i < activeLen; ++i) {
          marks[codes[activeIdx[i]]] = markVersion;
        }
        for (c = 1; c < codeToValue.length; ++c) {
          if (marks[c] !== markVersion) continue;
          v = codeToValue[c];
          if (!hasAny) {
            minVal = maxVal = v;
            hasAny = true;
          } else {
            if (compareNaturalOrder(v, minVal) < 0) minVal = v;
            if (compareNaturalOrder(v, maxVal) > 0) maxVal = v;
          }
        }
        return {
          max: hasAny && maxVal != null ? maxVal : null,
          min: hasAny && minVal != null ? minVal : null
        };
      }

      if (!values) {
        return { max: null, min: null };
      }

      var loVal = null,
          hiVal = null,
          idx;
      for (idx = lo0; idx < hi0; ++idx) {
        if (filterStore.isActive(index[idx])) {
          loVal = values[idx];
          break;
        }
      }
      if (idx === hi0) {
        return { max: null, min: null };
      }
      for (idx = hi0 - 1; idx >= lo0; --idx) {
        if (filterStore.isActive(index[idx])) {
          hiVal = values[idx];
          break;
        }
      }
      return {
        max: hiVal == null ? null : hiVal,
        min: loVal == null ? null : loVal
      };
    }

    function lazyTopBottomIndex(k, skipOffset, isTop) {
      if (k <= 0) {
        return [];
      }
      var isRaw = !!(rawNumericState && !lazyEncodedState);
      if (!isRaw && lazyEncodedState.hasUnorderable) {
        return null;
      }

      var toSkip = skipOffset && skipOffset > 0 ? skipOffset : 0,
          need = k + toSkip,
          activeIndices = null,
          rowCount;

      var active = getActiveRows();
      if (!active) {
        rowCount = n;
      } else {
        activeIndices = active.indices;
        rowCount = active.length;
      }

      if (rowCount <= toSkip) {
        return [];
      }

      if (need > 4096 && rowCount > 4096) {
        return null;
      }

      var rawVals = isRaw ? rawNumericState.values : null,
          codes = isRaw ? null : lazyEncodedState.codes,
          useNumeric = isRaw || lazyEncodedState.isPureNumeric,
          keyTable = isRaw ? null : (useNumeric ? lazyEncodedState.codeToValue : getLazyCodeRank()),
          i,
          r,
          v;

      if (need >= rowCount) {
        var allRows = new Array(rowCount);
        if (activeIndices) {
          for (i = 0; i < rowCount; ++i) allRows[i] = activeIndices[i];
        } else {
          for (i = 0; i < rowCount; ++i) allRows[i] = i;
        }
        if (isRaw) {
          allRows.sort(isTop
            ? function(a, b) {
                var va = rawVals[a], vb = rawVals[b];
                return va < vb ? 1 : va > vb ? -1 : b - a;
              }
            : function(a, b) {
                var va = rawVals[a], vb = rawVals[b];
                return va < vb ? -1 : va > vb ? 1 : a - b;
              });
        } else {
          allRows.sort(isTop
            ? function(a, b) {
                var va = keyTable[codes[a]], vb = keyTable[codes[b]];
                return va < vb ? 1 : va > vb ? -1 : b - a;
              }
            : function(a, b) {
                var va = keyTable[codes[a]], vb = keyTable[codes[b]];
                return va < vb ? -1 : va > vb ? 1 : a - b;
              });
        }
        return toSkip > 0 ? allRows.slice(toSkip, toSkip + k) : (allRows.length > k ? allRows.slice(0, k) : allRows);
      }

      var heapRow = new Uint32Array(need),
          heapVal = useNumeric ? new Float64Array(need) : new Uint32Array(need),
          heapSize = 0,
          heapRoot = 0,
          pos,
          parent,
          left,
          right,
          child,
          pv,
          pr,
          cv,
          cr;

      function pushTop(val, row) {
        if (heapSize < need) {
          pos = heapSize++;
          while (pos > 0) {
            parent = (pos - 1) >>> 1;
            pv = heapVal[parent];
            pr = heapRow[parent];
            if (val < pv || (val === pv && row < pr)) {
              heapVal[pos] = pv;
              heapRow[pos] = pr;
              pos = parent;
            } else {
              break;
            }
          }
          heapVal[pos] = val;
          heapRow[pos] = row;
          if (heapSize === need) heapRoot = heapVal[0];
        } else {
          pos = 0;
          while ((left = (pos << 1) + 1) < heapSize) {
            child = left;
            right = left + 1;
            if (right < heapSize) {
              cv = heapVal[right];
              cr = heapRow[right];
              if (cv < heapVal[left] || (cv === heapVal[left] && cr < heapRow[left])) {
                child = right;
              }
            }
            cv = heapVal[child];
            cr = heapRow[child];
            if (cv < val || (cv === val && cr < row)) {
              heapVal[pos] = cv;
              heapRow[pos] = cr;
              pos = child;
            } else {
              break;
            }
          }
          heapVal[pos] = val;
          heapRow[pos] = row;
          heapRoot = heapVal[0];
        }
      }

      function pushBottom(val, row) {
        if (heapSize < need) {
          pos = heapSize++;
          while (pos > 0) {
            parent = (pos - 1) >>> 1;
            pv = heapVal[parent];
            pr = heapRow[parent];
            if (val > pv || (val === pv && row > pr)) {
              heapVal[pos] = pv;
              heapRow[pos] = pr;
              pos = parent;
            } else {
              break;
            }
          }
          heapVal[pos] = val;
          heapRow[pos] = row;
          if (heapSize === need) heapRoot = heapVal[0];
        } else {
          pos = 0;
          while ((left = (pos << 1) + 1) < heapSize) {
            child = left;
            right = left + 1;
            if (right < heapSize) {
              cv = heapVal[right];
              cr = heapRow[right];
              if (cv > heapVal[left] || (cv === heapVal[left] && cr > heapRow[left])) {
                child = right;
              }
            }
            cv = heapVal[child];
            cr = heapRow[child];
            if (cv > val || (cv === val && cr > row)) {
              heapVal[pos] = cv;
              heapRow[pos] = cr;
              pos = child;
            } else {
              break;
            }
          }
          heapVal[pos] = val;
          heapRow[pos] = row;
          heapRoot = heapVal[0];
        }
      }

      if (isTop) {
        if (isRaw) {
          if (!activeIndices) {
            for (i = 0; i < need; ++i) pushTop(rawVals[i], i);
            for (; i < rowCount; ++i) {
              v = rawVals[i];
              if (v >= heapRoot) pushTop(v, i);
            }
          } else {
            for (i = 0; i < need; ++i) { r = activeIndices[i]; pushTop(rawVals[r], r); }
            for (; i < rowCount; ++i) {
              r = activeIndices[i];
              v = rawVals[r];
              if (v >= heapRoot) pushTop(v, r);
            }
          }
        } else if (!activeIndices) {
          for (i = 0; i < need; ++i) pushTop(keyTable[codes[i]], i);
          for (; i < rowCount; ++i) {
            v = keyTable[codes[i]];
            if (v >= heapRoot) pushTop(v, i);
          }
        } else {
          for (i = 0; i < need; ++i) { r = activeIndices[i]; pushTop(keyTable[codes[r]], r); }
          for (; i < rowCount; ++i) {
            r = activeIndices[i];
            v = keyTable[codes[r]];
            if (v >= heapRoot) pushTop(v, r);
          }
        }
      } else {
        if (isRaw) {
          if (!activeIndices) {
            for (i = 0; i < need; ++i) pushBottom(rawVals[i], i);
            for (; i < rowCount; ++i) {
              v = rawVals[i];
              if (v < heapRoot) pushBottom(v, i);
            }
          } else {
            for (i = 0; i < need; ++i) { r = activeIndices[i]; pushBottom(rawVals[r], r); }
            for (; i < rowCount; ++i) {
              r = activeIndices[i];
              v = rawVals[r];
              if (v < heapRoot) pushBottom(v, r);
            }
          }
        } else if (!activeIndices) {
          for (i = 0; i < need; ++i) pushBottom(keyTable[codes[i]], i);
          for (; i < rowCount; ++i) {
            v = keyTable[codes[i]];
            if (v < heapRoot) pushBottom(v, i);
          }
        } else {
          for (i = 0; i < need; ++i) { r = activeIndices[i]; pushBottom(keyTable[codes[r]], r); }
          for (; i < rowCount; ++i) {
            r = activeIndices[i];
            v = keyTable[codes[r]];
            if (v < heapRoot) pushBottom(v, r);
          }
        }
      }

      var result = new Array(heapSize);
      for (i = 0; i < heapSize; ++i) result[i] = heapRow[i];
      if (isRaw) {
        result.sort(isTop
          ? function(a, b) {
              var va = rawVals[a], vb = rawVals[b];
              return va < vb ? 1 : va > vb ? -1 : b - a;
            }
          : function(a, b) {
              var va = rawVals[a], vb = rawVals[b];
              return va < vb ? -1 : va > vb ? 1 : a - b;
            });
      } else {
        result.sort(isTop
          ? function(a, b) {
              var va = keyTable[codes[a]], vb = keyTable[codes[b]];
              return va < vb ? 1 : va > vb ? -1 : b - a;
            }
          : function(a, b) {
              var va = keyTable[codes[a]], vb = keyTable[codes[b]];
              return va < vb ? -1 : va > vb ? 1 : a - b;
            });
      }
      return toSkip > 0 ? result.slice(toSkip, toSkip + k) : (result.length > k ? result.slice(0, k) : result);
    }

    // Returns the top K selected records based on this dimension's order.
    // Note: observes this dimension's filter, unlike group and groupAll.
    function top(k, top_offset) {
      ensureDeferredReady();
      if ((rawNumericState || lazyEncodedState) && !values && !iterable) {
        var lazyRows = lazyTopBottomIndex(k, top_offset, true);
        if (lazyRows !== null) {
          var lazyOut = new Array(lazyRows.length);
          for (var li = 0; li < lazyRows.length; ++li) {
            lazyOut[li] = getRecord(lazyRows[li]);
          }
          return lazyOut;
        }
      }

      materializeLazyEncodedState();

      var array = [],
          i = hi0,
          j,
          toSkip = 0;

      if(top_offset && top_offset > 0) toSkip = top_offset;

      while (--i >= lo0 && k > 0) {
        if (filterStore.isActive(j = index[i])) {
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
          if(filterStore.isActive(j = iterablesEmptyRows[i])) {
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
      ensureDeferredReady();
      if ((rawNumericState || lazyEncodedState) && !values && !iterable) {
        var lazyRows = lazyTopBottomIndex(k, top_offset, true);
        if (lazyRows !== null) {
          return lazyRows;
        }
      }

      materializeLazyEncodedState();

      var array = [],
          i = hi0,
          j,
          toSkip = 0;

      if(top_offset && top_offset > 0) toSkip = top_offset;

      while (--i >= lo0 && k > 0) {
        if (filterStore.isActive(j = index[i])) {
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
          if(filterStore.isActive(j = iterablesEmptyRows[i])) {
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
      ensureDeferredReady();
      if ((rawNumericState || lazyEncodedState) && !values && !iterable) {
        var lazyRows = lazyTopBottomIndex(k, bottom_offset, false);
        if (lazyRows !== null) {
          var lazyOut = new Array(lazyRows.length);
          for (var li = 0; li < lazyRows.length; ++li) {
            lazyOut[li] = getRecord(lazyRows[li]);
          }
          return lazyOut;
        }
      }

      materializeLazyEncodedState();

      var array = [],
          i,
          j,
          toSkip = 0;

      if(bottom_offset && bottom_offset > 0) toSkip = bottom_offset;

      if(iterable) {
        // Add row with empty iterable column at the top
        for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
          if(filterStore.isActive(j = iterablesEmptyRows[i])) {
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
        if (filterStore.isActive(j = index[i])) {
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
      ensureDeferredReady();
      if ((rawNumericState || lazyEncodedState) && !values && !iterable) {
        var lazyRows = lazyTopBottomIndex(k, bottom_offset, false);
        if (lazyRows !== null) {
          return lazyRows;
        }
      }

      materializeLazyEncodedState();

      var array = [],
          i,
          j,
          toSkip = 0;

      if(bottom_offset && bottom_offset > 0) toSkip = bottom_offset;

      if(iterable) {
        for(i = 0; i < iterablesEmptyRows.length && k > 0; i++) {
          if(filterStore.isActive(j = iterablesEmptyRows[i])) {
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
        if (filterStore.isActive(j = index[i])) {
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
      ensureDeferredReady();
      if (arguments.length < 1) key = cr_identity;

      var groupAll = key === cr_null;
      var isPureMonotonicKey = !!(key && key._xfilterPureMonotonic === true);
      var rawBucketMode = !groupAll && isPureMonotonicKey && !!(rawNumericState && !values && !iterable);

      if (rawNumericState && !values && !groupAll && !rawBucketMode) {
        if (key === cr_identity) {
          upgradeRawNumericToLazy(n);
        } else {
          materializeLazyEncodedState();
        }
      }

      var lazyIdentityMode = !rawBucketMode && key === cr_identity && hasLazyEncodedGroupingSupport();
      var lazyBucketMode = !groupAll && !rawBucketMode && !lazyIdentityMode && isPureMonotonicKey && hasLazyEncodedGroupingSupport();

      if (!groupAll && !rawBucketMode && !lazyIdentityMode && !lazyBucketMode) {
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
        remove: dispose, // for backwards-compatibility
        _canPromoteToRawNumeric: !!(groupAll || lazyBucketMode),
        _coScanInfo: coScanInfo,
        _onDimensionMaterialize: onDimensionMaterialize,
        _onRawNumericPromote: onRawNumericPromote,
        _onRawNumericRemove: onRawNumericRemove,
        _onRawNumericUpgrade: onRawNumericUpgrade,
        _readColumnar: readColumnar
      };

      // Ensure that this group will be removed when the dimension is removed.
      dimensionGroups.push(group);

      var groups, // array of {key, value}
          groupIndex, // object id ↦ group id
          groupWidth = 8,
          groupCapacity = capacity(groupWidth),
          k = 0, // cardinality
          lazySortedCodes = null,
          lazyOrderVersion = -1,
          lazyCodeToGroup = null,
          bucketKeys = null,
          bucketKeyToSlot = null,
          bucketCodeToSlot = null,
          bucketOrderVersion = -1,
          bucketCodeCount = 0,
          bucketIndexedLength = 0,
          hasInvalidBucket = false,
          rawBucketKeys = null,
          rawBucketMap = null,
          rawBucketSortedOrder = null,
          rawBucketSlotToGroup = null,
          rawBucketIndexedLength = 0,
          rawBucketVersion = -1,
          rawBucketTimeStep = key && key._xfilterTimeStep ? key._xfilterTimeStep : 0,
          rawBucketTimeOffset = key && key._xfilterTimeOffset ? key._xfilterTimeOffset : 0,
          materializedVersion = 0,
          select,
          heap,
          reduceAdd,
          reduceRemove,
          reduceInitial,
          reduceMetricSpec = null,
          reduceSplitField = null,
          metricPlan = null,
          metricBuffers = null,
          unfilteredData = null,
          unfilteredRowCounts = null,
          unfilteredTmpCounts = null,
          unfilteredSlotCount = 0,
          unfilteredSplitMode = null,
          unfilteredSplitStride = 0,
          unfilteredValid = false,
          buffersHoldUnfiltered = false,
          countBuf = null,
          splitMode = null, // 'dense' | 'sparse'
          splitActiveStride = 0,
          sparsePairGroupIds = null,
          sparseHeadBySlot = null,
          sparseNextPair = null,
          sparsePairSplitCode = null,
          sparsePairMap = null,
          sparsePairCount = 0,
          sparseN = -1,
          sparseSplitStride = -1,
          sparseDimVersion = -1,
          reduceMode = null,
          valuesSynced = false,
          update = cr_null,
          reset = cr_null,
          resetNeeded = true,
          markResetNeeded = registerResetListener(function() {
            resetNeeded = true;
            valuesSynced = false;
          }),
          n0old;

      // The group listens to the crossfilter for when any dimension changes, so
      // that it can update the associated reduce values. It must also listen to
      // the parent dimension for when data is added, and compute new keys.
      filterListeners.push(update);
      indexListeners.push(add);
      removeDataListeners.push(removeData);

      function setFilterListener(nextUpdate, nextReset) {
        var listenerIndex = filterListeners.indexOf(update);
        update = nextUpdate;
        reset = nextReset;
        if (listenerIndex >= 0) {
          filterListeners[listenerIndex] = update;
        }
      }

      function ensureCountBuf(sizeNeeded) {
        if (countBuf && countBuf.length >= sizeNeeded) {
          return countBuf;
        }
        var nextCap = countBuf && countBuf.length ? countBuf.length : 64;
        while (nextCap < sizeNeeded) {
          nextCap = nextCap < 65536 ? nextCap << 1 : sizeNeeded;
        }
        countBuf = new Float64Array(nextCap);
        return countBuf;
      }

      function syncUpdateListenerMeta() {
        var canReset = !iterable && reduceMode !== null;
        updateMany._xfilterDimSlot = dimSlot;
        updateMany._xfilterResettable = canReset;
        updateOne._xfilterDimSlot = dimSlot;
        updateOne._xfilterResettable = canReset;
      }

      function ensureLazyOrder() {
        if (!lazyIdentityMode || !lazyEncodedState) {
          return;
        }
        if (lazyOrderVersion === lazyEncodedState.version) {
          return;
        }
        var codeToValue = lazyEncodedState.codeToValue,
            codeCounts = lazyEncodedState.codeCounts,
            sorted = [],
            c;

        if (!lazyEncodedState.hasUnorderable) {
          for (c = 1; c < codeToValue.length; ++c) {
            if (codeCounts[c] > 0) {
              sorted.push(c);
            }
          }
        } else {
          for (c = 1; c < codeToValue.length; ++c) {
            if (codeCounts[c] > 0 && isNaturallyOrderable(codeToValue[c])) {
              sorted.push(c);
            }
          }
        }
        if (lazyEncodedState.isPureNumeric || lazyEncodedState.isPureString) {
          sorted.sort(function(a, b) {
            var va = codeToValue[a], vb = codeToValue[b];
            return va < vb ? -1 : va > vb ? 1 : a - b;
          });
        } else {
          sorted.sort(function(a, b) {
            var order = compareNaturalOrder(codeToValue[a], codeToValue[b]);
            return order || a - b;
          });
        }

        lazySortedCodes = sorted;
        k = sorted.length;
        lazyOrderVersion = lazyEncodedState.version;
        lazyCodeToGroup = null;
        groups = null;
        valuesSynced = false;
      }

      function ensureLazyIdentityGroups() {
        ensureLazyOrder();
        if (groups && groups.length === k && (!lazyIdentityMode || lazyCodeToGroup)) {
          return;
        }
        var codeToValue = lazyEncodedState.codeToValue,
            len = k,
            arr = new Array(len),
            map = new Int32Array(codeToValue.length),
            i,
            c;
        map.fill(-1);
        for (i = 0; i < len; ++i) {
          c = lazySortedCodes[i];
          arr[i] = { key: codeToValue[c], value: undefined };
          map[c] = i;
        }
        groups = arr;
        lazyCodeToGroup = map;
      }

      function ensureLazyBucketLayout() {
        if (!lazyBucketMode || !lazyEncodedState) {
          return;
        }
        if (bucketOrderVersion === lazyEncodedState.version && bucketIndexedLength === n) {
          return;
        }

        var codeToValue = lazyEncodedState.codeToValue,
            codeCounts = lazyEncodedState.codeCounts,
            codes = lazyEncodedState.codes,
            codeLen = codeToValue.length,
            i,
            c,
            bk;

        // Fast incremental extend when only new rows arrived and no new or reappearing bucket key appeared.
        if (bucketKeyToSlot && bucketCodeToSlot && bucketCodeCount <= codeLen && bucketIndexedLength <= n && bucketOrderVersion > 0 && bucketIndexedLength > 0) {
          var canExtend = true;
          var newCodeToSlot = bucketCodeToSlot;
          if (newCodeToSlot.length < codeLen) {
            var nextMapCap = newCodeToSlot.length || 64;
            while (nextMapCap < codeLen) nextMapCap <<= 1;
            var nextMap = new Uint32Array(nextMapCap);
            nextMap.fill(0xffffffff);
            nextMap.set(bucketCodeToSlot);
            newCodeToSlot = nextMap;
          }
          for (c = bucketCodeCount; c < codeLen; ++c) {
            if (!codeCounts[c]) continue;
            bk = key(codeToValue[c]);
            if (!isNaturallyOrderable(bk)) {
              canExtend = false;
              break;
            }
            var existingSlot = bucketKeyToSlot.get(bk);
            if (existingSlot === undefined) {
              canExtend = false;
              break;
            }
            newCodeToSlot[c] = existingSlot;
          }
          if (canExtend && groupIndex) {
            if (groupIndex.length < n) {
              var nextGroupCap = groupIndex.length || 64;
              while (nextGroupCap < n) nextGroupCap <<= 1;
              groupIndex = xfilterArray.arrayLengthen(groupIndex, nextGroupCap);
            }
            var allMapped = true;
            for (i = bucketIndexedLength; i < n; ++i) {
              var mappedSlot = newCodeToSlot[codes[i]];
              if (mappedSlot === 0xffffffff) {
                allMapped = false;
                break;
              }
              groupIndex[i] = mappedSlot;
            }
            if (allMapped) {
              bucketCodeToSlot = newCodeToSlot;
              bucketCodeCount = codeLen;
              bucketIndexedLength = n;
              bucketOrderVersion = lazyEncodedState.version;
              return;
            }
          }
        }

        var uniqueKeys = [],
            keySet = new Map(),
            codeBuckets = new Array(codeLen),
            invalid = false;

        for (c = 1; c < codeLen; ++c) {
          if (!codeCounts[c]) continue;
          bk = key(codeToValue[c]);
          codeBuckets[c] = bk;
          if (isNaturallyOrderable(bk)) {
            if (!keySet.has(bk)) {
              keySet.set(bk, 1);
              uniqueKeys.push(bk);
            }
          } else {
            invalid = true;
          }
        }

        uniqueKeys.sort(compareNaturalOrder);
        var slotMap = new Map();
        for (i = 0; i < uniqueKeys.length; ++i) {
          slotMap.set(uniqueKeys[i], i);
        }

        var codeToSlot = new Uint32Array(codeLen);
        codeToSlot.fill(0xffffffff);
        var sentinel = uniqueKeys.length;
        for (c = 1; c < codeLen; ++c) {
          if (!codeCounts[c]) continue;
          bk = codeBuckets[c];
          if (isNaturallyOrderable(bk)) {
            codeToSlot[c] = slotMap.get(bk);
          } else {
            codeToSlot[c] = sentinel;
          }
        }

        bucketKeys = uniqueKeys;
        bucketKeyToSlot = slotMap;
        bucketCodeToSlot = codeToSlot;
        bucketCodeCount = codeLen;
        hasInvalidBucket = invalid;
        k = uniqueKeys.length;

        var totalSlots = k + (invalid ? 1 : 0);
        if (totalSlots > 0 && n > 0) {
          groupIndex = cr_index(n, totalSlots);
          for (i = 0; i < n; ++i) {
            groupIndex[i] = codeToSlot[codes[i]];
          }
        } else {
          groupIndex = null;
        }
        bucketIndexedLength = n;
        bucketOrderVersion = lazyEncodedState.version;
        groups = null;
        valuesSynced = false;
      }

      function ensureRawBucketLayout() {
        if (!rawBucketMode || !rawNumericState) {
          return;
        }
        if (rawBucketVersion === rawNumericState.version && rawBucketIndexedLength === n) {
          return;
        }

        var vals = rawNumericState.values,
            step = rawBucketTimeStep,
            timeOff = rawBucketTimeOffset,
            start = rawBucketIndexedLength,
            keysArr = rawBucketKeys,
            bMap = rawBucketMap,
            orderDirty = !rawBucketSortedOrder,
            i,
            bk,
            rawId;

        if (!keysArr) {
          keysArr = rawBucketKeys = [];
          bMap = rawBucketMap = new Map();
          start = 0;
          orderDirty = true;
        }

        if (!groupIndex || groupIndex.length < n) {
          var nextCap = (groupIndex && groupIndex.length) ? groupIndex.length : 64;
          while (nextCap < n) nextCap <<= 1;
          if (groupIndex && groupIndex.length > 0 && start > 0) {
            var grown = new Uint32Array(nextCap);
            grown.set(groupIndex.subarray(0, start));
            groupIndex = grown;
          } else {
            groupIndex = new Uint32Array(nextCap);
          }
        }

        var lastBk = NaN,
            lastId = -1;

        if (step > 0) {
          if (timeOff === 0) {
            for (i = start; i < n; ++i) {
              bk = Math.floor(vals[i] / step) * step;
              if (bk === lastBk) {
                groupIndex[i] = lastId;
                continue;
              }
              rawId = bMap.get(bk);
              if (rawId === undefined) {
                rawId = keysArr.length;
                keysArr.push(bk);
                bMap.set(bk, rawId);
                orderDirty = true;
              }
              lastBk = bk;
              lastId = rawId;
              groupIndex[i] = rawId;
            }
          } else {
            for (i = start; i < n; ++i) {
              bk = Math.floor((vals[i] + timeOff) / step) * step - timeOff;
              if (bk === lastBk) {
                groupIndex[i] = lastId;
                continue;
              }
              rawId = bMap.get(bk);
              if (rawId === undefined) {
                rawId = keysArr.length;
                keysArr.push(bk);
                bMap.set(bk, rawId);
                orderDirty = true;
              }
              lastBk = bk;
              lastId = rawId;
              groupIndex[i] = rawId;
            }
          }
        } else {
          for (i = start; i < n; ++i) {
            bk = key(vals[i]);
            if (!isNaturallyOrderable(bk)) {
              upgradeRawNumericToLazy(n);
              ensureLazyBucketLayout();
              return;
            }
            if (bk === lastBk) {
              groupIndex[i] = lastId;
              continue;
            }
            rawId = bMap.get(bk);
            if (rawId === undefined) {
              rawId = keysArr.length;
              keysArr.push(bk);
              bMap.set(bk, rawId);
              orderDirty = true;
            }
            lastBk = bk;
            lastId = rawId;
            groupIndex[i] = rawId;
          }
        }

        if (orderDirty) {
          var len = keysArr.length;
          var sorted = new Array(len);
          for (i = 0; i < len; ++i) sorted[i] = i;
          sorted.sort(function(a, b) {
            var order = compareNaturalOrder(keysArr[a], keysArr[b]);
            return order || a - b;
          });
          rawBucketSortedOrder = sorted;
          var slotToGroup = new Uint32Array(len);
          for (i = 0; i < len; ++i) slotToGroup[sorted[i]] = i;
          rawBucketSlotToGroup = slotToGroup;
          k = len;
          groups = null;
        }

        rawBucketIndexedLength = n;
        rawBucketVersion = rawNumericState.version;
        valuesSynced = false;
      }

      function onRawNumericPromote() {
        if (groupAll) {
          return;
        }
        lazyBucketMode = false;
        bucketKeys = null;
        bucketKeyToSlot = null;
        bucketCodeToSlot = null;
        bucketOrderVersion = -1;
        bucketCodeCount = 0;
        bucketIndexedLength = 0;
        hasInvalidBucket = false;
        rawBucketMode = true;
        rawBucketKeys = null;
        rawBucketMap = null;
        rawBucketSortedOrder = null;
        rawBucketSlotToGroup = null;
        rawBucketIndexedLength = 0;
        rawBucketVersion = -1;
        groupIndex = null;
        groups = null;
        sparseLayoutVersionReset();
        resetNeeded = true;
        valuesSynced = false;
      }

      function onRawNumericRemove() {
        if (!rawBucketMode) {
          return;
        }
        rawBucketKeys = null;
        rawBucketMap = null;
        rawBucketSortedOrder = null;
        rawBucketSlotToGroup = null;
        rawBucketIndexedLength = 0;
        rawBucketVersion = -1;
        groupIndex = null;
        groups = null;
        sparseLayoutVersionReset();
        resetNeeded = true;
        valuesSynced = false;
      }

      function onRawNumericUpgrade() {
        if (!rawBucketMode) {
          return;
        }
        rawBucketMode = false;
        rawBucketKeys = null;
        rawBucketMap = null;
        rawBucketSortedOrder = null;
        rawBucketSlotToGroup = null;
        rawBucketIndexedLength = 0;
        rawBucketVersion = -1;
        groupIndex = null;
        groups = null;
        lazyBucketMode = !!(lazyEncodedState && !lazyEncodedState.hasUnorderable);
        bucketOrderVersion = -1;
        bucketIndexedLength = 0;
        sparseLayoutVersionReset();
        resetNeeded = true;
        valuesSynced = false;
      }

      function getPrimarySlotArray() {
        if (lazyIdentityMode) {
          return lazyEncodedState.codes;
        }
        return groupIndex;
      }

      function getPrimarySlotCount() {
        if (lazyIdentityMode) {
          return lazyEncodedState ? lazyEncodedState.codeToValue.length : 0;
        }
        if (rawBucketMode) {
          return rawBucketKeys ? rawBucketKeys.length : 0;
        }
        if (lazyBucketMode) {
          return k + (hasInvalidBucket ? 1 : 0);
        }
        return k;
      }

      function ensureSparseSplitLayout(slotArr, primarySlots, splitCol) {
        var stride = splitCol.codeToKey.length;
        var dimVer = rawNumericState
          ? rawNumericState.version
          : (lazyEncodedState ? lazyEncodedState.version : materializedVersion);
        if (
          sparsePairGroupIds
          && sparseN === n
          && sparseSplitStride === stride
          && sparseDimVersion === dimVer
        ) {
          return;
        }

        var splitCodes = splitCol.codes,
            canExtend = (lazyIdentityMode || rawBucketMode)
              && sparsePairGroupIds
              && sparsePairMap
              && sparseN > 0
              && sparseN < n
              && sparseSplitStride === stride,
            startRow = canExtend ? sparseN : 0,
            pairIds = sparsePairGroupIds,
            head,
            cap,
            nextPair,
            pairSplit,
            pairMap,
            pairCount,
            i,
            s,
            sc,
            pairKey,
            pid;

        if (!pairIds || pairIds.length < n) {
          var nextPairCap = (pairIds && pairIds.length) ? pairIds.length : 64;
          while (nextPairCap < n) nextPairCap <<= 1;
          var grownPairIds = new Uint32Array(nextPairCap);
          if (canExtend && pairIds) {
            grownPairIds.set(pairIds.subarray(0, sparseN));
          }
          pairIds = grownPairIds;
        }

        if (canExtend) {
          head = sparseHeadBySlot;
          if (!head || head.length < primarySlots) {
            var nextHeadCap = (head && head.length) ? head.length : 64;
            while (nextHeadCap < primarySlots) nextHeadCap <<= 1;
            var grownHead = new Int32Array(nextHeadCap);
            grownHead.fill(-1);
            if (head) grownHead.set(head);
            head = grownHead;
          }
          nextPair = sparseNextPair;
          pairSplit = sparsePairSplitCode;
          cap = nextPair.length;
          pairMap = sparsePairMap;
          pairCount = sparsePairCount;
        } else {
          head = new Int32Array(primarySlots);
          head.fill(-1);
          cap = primarySlots < 256 ? 256 : primarySlots;
          nextPair = new Int32Array(cap);
          pairSplit = new Uint32Array(cap);
          pairMap = new Map();
          pairCount = 0;
        }

        for (i = startRow; i < n; ++i) {
          s = slotArr[i];
          sc = splitCodes[i];
          pairKey = s * stride + sc;
          pid = pairMap.get(pairKey);
          if (pid === undefined) {
            pid = pairCount++;
            pairMap.set(pairKey, pid);
            if (pid >= cap) {
              cap <<= 1;
              var grownNext = new Int32Array(cap);
              grownNext.set(nextPair);
              nextPair = grownNext;
              var grownSplit = new Uint32Array(cap);
              grownSplit.set(pairSplit);
              pairSplit = grownSplit;
            }
            pairSplit[pid] = sc;
            nextPair[pid] = head[s];
            head[s] = pid;
          }
          pairIds[i] = pid;
        }

        sparsePairGroupIds = pairIds;
        sparseHeadBySlot = head;
        sparseNextPair = nextPair;
        sparsePairSplitCode = pairSplit;
        sparsePairMap = pairMap;
        sparsePairCount = pairCount;
        sparseN = n;
        sparseSplitStride = stride;
        sparseDimVersion = dimVer;
      }

      function syncGroupsFromBuffers() {
        if (valuesSynced) {
          return;
        }
        if (reduceMode === null) {
          valuesSynced = true;
          return;
        }

        var i, slot, state, splitCol, splitKeys, sc, cell, bucket, pid;

        if (groupAll) {
          if (!groups || !groups.length) {
            groups = [{ key: null, value: undefined }];
          }
          if (reduceMode === 'count') {
            groups[0].value = countBuf ? countBuf[0] : 0;
          } else if (reduceMode === 'metricSpec') {
            if (!groups[0].value) groups[0].value = reduceInitial();
            writeMetricSlotToState(groups[0].value, metricPlan, metricBuffers, 0);
          } else if (reduceMode === 'splitMetricSpec') {
            splitCol = getSplitColumn(reduceSplitField);
            splitKeys = splitCol.codeToKey;
            state = reduceInitial();
            for (sc = 0; sc < splitActiveStride; ++sc) {
              if (slotHasAnyActivity(metricPlan, metricBuffers, sc)) {
                bucket = {};
                writeMetricSlotToState(bucket, metricPlan, metricBuffers, sc);
                state[splitKeys[sc]] = bucket;
              }
            }
            state.__version += 1;
            groups[0].value = state;
          }
          valuesSynced = true;
          return;
        }

        if (lazyIdentityMode) {
          ensureLazyIdentityGroups();
        } else if (rawBucketMode) {
          if (!groups || groups.length !== k) {
            groups = new Array(k);
            for (i = 0; i < k; ++i) {
              groups[i] = { key: rawBucketKeys[rawBucketSortedOrder[i]], value: undefined };
            }
          }
        } else if (lazyBucketMode) {
          if (!groups || groups.length !== k) {
            groups = new Array(k);
            for (i = 0; i < k; ++i) {
              groups[i] = { key: bucketKeys[i], value: undefined };
            }
          }
        }

        if (k === 0) {
          groups = [];
          valuesSynced = true;
          return;
        }

        var slotList = lazyIdentityMode ? lazySortedCodes : (rawBucketMode ? rawBucketSortedOrder : null);

        if (reduceMode === 'count') {
          for (i = 0; i < k; ++i) {
            slot = slotList ? slotList[i] : i;
            groups[i].value = countBuf[slot];
          }
        } else if (reduceMode === 'metricSpec') {
          for (i = 0; i < k; ++i) {
            slot = slotList ? slotList[i] : i;
            state = groups[i].value;
            if (!state) {
              state = groups[i].value = reduceInitial();
            }
            writeMetricSlotToState(state, metricPlan, metricBuffers, slot);
          }
        } else if (reduceMode === 'splitMetricSpec') {
          splitCol = getSplitColumn(reduceSplitField);
          splitKeys = splitCol.codeToKey;
          if (splitMode === 'dense') {
            for (i = 0; i < k; ++i) {
              slot = slotList ? slotList[i] : i;
              state = reduceInitial();
              var base = slot * splitActiveStride;
              for (sc = 0; sc < splitActiveStride; ++sc) {
                cell = base + sc;
                if (slotHasAnyActivity(metricPlan, metricBuffers, cell)) {
                  bucket = {};
                  writeMetricSlotToState(bucket, metricPlan, metricBuffers, cell);
                  state[splitKeys[sc]] = bucket;
                }
              }
              state.__version += 1;
              groups[i].value = state;
            }
          } else {
            for (i = 0; i < k; ++i) {
              slot = slotList ? slotList[i] : i;
              state = reduceInitial();
              for (pid = sparseHeadBySlot[slot]; pid !== -1; pid = sparseNextPair[pid]) {
                if (slotHasAnyActivity(metricPlan, metricBuffers, pid)) {
                  bucket = {};
                  writeMetricSlotToState(bucket, metricPlan, metricBuffers, pid);
                  state[splitKeys[sparsePairSplitCode[pid]]] = bucket;
                }
              }
              state.__version += 1;
              groups[i].value = state;
            }
          }
        }

        valuesSynced = true;
      }

      function onDimensionMaterialize(lazyCodes) {
        if (groupAll) {
          return;
        }
        if (!lazyIdentityMode && !lazyBucketMode) {
          return;
        }

        var wasIdentity = lazyIdentityMode;
        lazyIdentityMode = false;
        lazyBucketMode = false;
        lazyOrderVersion = -1;
        bucketOrderVersion = -1;
        bucketKeys = null;
        bucketKeyToSlot = null;
        bucketCodeToSlot = null;
        bucketCodeCount = 0;
        bucketIndexedLength = 0;
        hasInvalidBucket = false;
        sparseLayoutVersionReset();
        resetNeeded = true;
        valuesSynced = false;

        if (wasIdentity && lazyEncodedState && !lazyEncodedState.hasUnorderable) {
          var codeToValue = lazyEncodedState.codeToValue,
              codeCounts = lazyEncodedState.codeCounts,
              sorted = [],
              c,
              i;
          for (c = 1; c < codeToValue.length; ++c) {
            if (codeCounts[c] > 0 && isNaturallyOrderable(codeToValue[c])) {
              sorted.push(c);
            }
          }
          sorted.sort(function(a, b) {
            var order = compareNaturalOrder(codeToValue[a], codeToValue[b]);
            return order || a - b;
          });
          k = sorted.length;
          if (!k) {
            groups = [];
            groupIndex = null;
            setFilterListener(cr_null, cr_null);
            return;
          }
          while (k > groupCapacity) {
            groupWidth <<= 1;
            groupCapacity = capacity(groupWidth);
          }
          groups = new Array(k);
          var codeToGroup = new Uint32Array(codeToValue.length);
          for (i = 0; i < k; ++i) {
            groups[i] = { key: codeToValue[sorted[i]], value: undefined };
            codeToGroup[sorted[i]] = i;
          }
          if (k > 1) {
            groupIndex = cr_index(n, groupCapacity);
            for (i = 0; i < lazyCodes.length; ++i) {
              groupIndex[i] = codeToGroup[lazyCodes[i]];
            }
            setFilterListener(updateMany, resetMany);
          } else {
            groupIndex = null;
            setFilterListener(updateOne, resetOne);
          }
          lazySortedCodes = null;
          lazyCodeToGroup = null;
          materializedVersion += 1;
          return;
        }

        lazySortedCodes = null;
        lazyCodeToGroup = null;
        k = 0;
        groups = [];
        groupIndex = null;
        add(values, index, 0, lazyCodes.length);
        materializedVersion += 1;
      }

      function sparseLayoutVersionReset() {
        sparsePairMap = null;
        sparseDimVersion = -1;
        sparseN = -1;
        sparseSplitStride = -1;
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
      }

      function markBuffersHoldUnfiltered(totalSlots) {
        if (!metricPlan || !metricBuffers || totalSlots <= 0 || totalSlots * metricPlan.stride > 131072) {
          buffersHoldUnfiltered = false;
          unfilteredValid = false;
          return;
        }
        unfilteredSlotCount = totalSlots;
        unfilteredSplitMode = splitMode;
        unfilteredSplitStride = splitActiveStride;
        unfilteredRowCounts = null;
        unfilteredValid = false;
        buffersHoldUnfiltered = true;
      }

      function materializeUnfilteredCacheIfNeeded() {
        if (!buffersHoldUnfiltered) return;
        buffersHoldUnfiltered = false;
        if (unfilteredValid) return;
        if (!metricPlan || !metricBuffers || unfilteredSlotCount <= 0) return;
        var totalDoubles = unfilteredSlotCount * metricPlan.stride;
        if (totalDoubles > 131072) return;
        if (!unfilteredData || unfilteredData.length < totalDoubles) {
          var nextLen = unfilteredData && unfilteredData.length ? unfilteredData.length : totalDoubles;
          while (nextLen < totalDoubles) nextLen <<= 1;
          if (nextLen > 131072) nextLen = totalDoubles;
          unfilteredData = new Float64Array(nextLen);
        }
        unfilteredData.set(metricBuffers.data.subarray(0, totalDoubles));
        unfilteredValid = true;
      }

      function ensureUnfilteredRowCounts(totalSlots, slotArr, splitCodes, splitStride) {
        if (unfilteredRowCounts && unfilteredRowCounts.length >= totalSlots) {
          return unfilteredRowCounts;
        }
        unfilteredRowCounts = new Uint32Array(totalSlots);
        var ci;
        if (splitCodes) {
          for (ci = 0; ci < n; ++ci) {
            unfilteredRowCounts[slotArr[ci] * splitStride + splitCodes[ci]] += 1;
          }
        } else if (slotArr) {
          for (ci = 0; ci < n; ++ci) {
            unfilteredRowCounts[slotArr[ci]] += 1;
          }
        } else {
          unfilteredRowCounts[0] = n;
        }
        return unfilteredRowCounts;
      }

      function hasValidUnfilteredCache(totalSlots) {
        return (unfilteredValid || buffersHoldUnfiltered)
          && unfilteredSlotCount === totalSlots
          && unfilteredSplitMode === splitMode
          && unfilteredSplitStride === splitActiveStride;
      }

      function restoreUnfilteredIntoBuffers(totalSlots, forMutation) {
        if (!hasValidUnfilteredCache(totalSlots)) {
          return false;
        }
        if (buffersHoldUnfiltered) {
          if (forMutation) {
            materializeUnfilteredCacheIfNeeded();
          }
          return true;
        }
        if (!unfilteredData) return false;
        metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, totalSlots, false);
        metricBuffers.data.set(unfilteredData.subarray(0, totalSlots * metricPlan.stride));
        buffersHoldUnfiltered = !forMutation;
        return true;
      }

      function ensureUnfilteredTmpCounts(totalSlots) {
        if (!unfilteredTmpCounts || unfilteredTmpCounts.length < totalSlots) {
          unfilteredTmpCounts = new Uint32Array(totalSlots);
        }
        return unfilteredTmpCounts;
      }

      function coScanInfo() {
        if (!resetNeeded || iterable || groupAll || reduceMode !== 'metricSpec' || !metricPlan || !metricPlan.canCoScan) {
          return null;
        }
        if (lazyIdentityMode) {
          ensureLazyOrder();
        } else if (rawBucketMode) {
          ensureRawBucketLayout();
        } else if (lazyBucketMode) {
          ensureLazyBucketLayout();
        }
        if (k <= 1) {
          return null;
        }
        var slotArr = getPrimarySlotArray();
        var slotCount = getPrimarySlotCount();
        if (!slotArr || slotCount <= 0) {
          return null;
        }
        var applyFilteredRemovals = hasOtherActiveDimensionFilters();
        var info = {
          buffers: metricBuffers,
          canComplement: function() {
            return hasValidUnfilteredCache(slotCount);
          },
          cleanupComplement: function(exclIndices, exclLen) {
            var exCntOff = getExactCountOffset(metricPlan, getNumericColumn);
            var trk = exCntOff < 0 ? ensureUnfilteredRowCounts(slotCount, slotArr, null, 0) : null;
            var tmpC = exCntOff < 0 ? ensureUnfilteredTmpCounts(slotCount) : null;
            cleanupComplementEmptySlots(metricBuffers, metricPlan, exCntOff, slotArr, null, 0, trk, tmpC, exclIndices, exclLen, slotCount);
          },
          coScanKey: metricPlan.coScanKey,
          commit: function(saveCache) {
            if (saveCache) {
              markBuffersHoldUnfiltered(slotCount);
            }
            resetNeeded = false;
            valuesSynced = false;
          },
          ensureBuffers: function() {
            materializeUnfilteredCacheIfNeeded();
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
            info.buffers = metricBuffers;
          },
          groupRef: group,
          plan: metricPlan,
          prepareZero: function() {
            materializeUnfilteredCacheIfNeeded();
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
            zeroMetricBuffers(metricBuffers, slotCount);
            info.buffers = metricBuffers;
          },
          slotArr: slotArr,
          slotCount: slotCount,
          tryRestoreUnfiltered: function(forMutation) {
            if (restoreUnfilteredIntoBuffers(slotCount, !!forMutation)) {
              info.buffers = metricBuffers;
              return true;
            }
            return false;
          },
          unfiltered: !applyFilteredRemovals,
          usesGlobalActive: applyFilteredRemovals && !dimSlot.active
        };
        return info;
      }

      // Incorporate any existing data into the grouping.
      add(values, index, 0, n);

      // Incorporates the specified new values into this group.
      // This function is responsible for updating groups and groupIndex.
      function add(newValues, newIndex, n0, n1, appendedCodes) {
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
        if (groupAll && (rawNumericState || lazyEncodedState) && !values) {
          k = 1;
          if (!groups || !groups.length) {
            groups = [{ key: null, value: resetNeeded ? undefined : reduceInitial() }];
          }
          groupIndex = null;
          resetNeeded = true;
          valuesSynced = false;
          setFilterListener(updateOne, resetOne);
          return;
        }

        if (rawBucketMode && rawNumericState && !values) {
          resetNeeded = true;
          valuesSynced = false;
          setFilterListener(updateMany, resetMany);
          return;
        }

        if (lazyIdentityMode && lazyEncodedState && !values) {
          if (lazyEncodedState.hasUnorderable) {
            materializeLazyEncodedState();
            return;
          }
          resetNeeded = true;
          valuesSynced = false;
          setFilterListener(updateMany, resetMany);
          return;
        }

        if (lazyBucketMode && lazyEncodedState && !values) {
          if (lazyEncodedState.hasUnorderable) {
            materializeLazyEncodedState();
            return;
          }
          resetNeeded = true;
          valuesSynced = false;
          setFilterListener(updateMany, resetMany);
          return;
        }

        if (iterable) {
          n0old = n0;
          n0 = values.length - newValues.length;
          n1 = newValues.length;
        }

        if (reduceMode !== null && !iterable) {
          resetNeeded = true;
          valuesSynced = false;
        }

        var oldGroups = groups,
            reIndex = iterable ? [] : cr_index(k, groupCapacity),
            addFn = reduceAdd,
            removeFn = reduceRemove,
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
        if (resetNeeded) addFn = initial = cr_null;
        if (resetNeeded) removeFn = initial = cr_null;

        // Reset the new groups (k is a lower bound).
        // Also, make sure that groupIndex exists and is long enough.
        groups = new Array(k), k = 0;
        if (iterable) {
          groupIndex = k0 ? groupIndex : [];
        } else {
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
            g = { key: x1, value: initial() }, x = x1;
          }

          // Add the lesser group.
          groups[k] = g;

          // Add any selected records belonging to the added group, while
          // advancing the new key and populating the associated group index.
          while (compareNaturalOrder(x1, x) <= 0) {
            j = newIndex[i1] + (iterable ? n0old : n0);

            if (iterable) {
              if (groupIndex[j]) {
                groupIndex[j].push(k);
              } else {
                groupIndex[j] = [k];
              }
            } else {
              groupIndex[j] = k;
            }

            if (!resetNeeded) {
              if (reduceMode === 'count') {
                g.value += 1;
                if (hasOtherActiveDimensionFilters() && !filterStore.isActiveExcept(j, dimSlot)) {
                  g.value -= 1;
                }
              } else {
                var rowRecord = getRecord(j);
                g.value = addFn(g.value, rowRecord, true);
                if (hasOtherActiveDimensionFilters() && !filterStore.isActiveExcept(j, dimSlot)) g.value = removeFn(g.value, rowRecord, false);
              }
            }
            if (++i1 >= n1) break;
            x1 = key(newValues[i1]);
          }

          groupIncrement();
        }

        // Add any remaining old groups that were greater than all new keys.
        while (i0 < k0) {
          groups[reIndex[i0] = k] = oldGroups[i0++];
          groupIncrement();
        }

        // Fill in gaps with empty arrays where there may have been rows with empty iterables
        if (iterable) {
          for (var index1 = 0; index1 < n; index1++) {
            if (!groupIndex[index1]) {
              groupIndex[index1] = [];
            }
          }
        }

        // If we added any new groups before any old groups,
        // update the group index of all the old records.
        if (k > i0) {
          if (iterable) {
            for (i0 = 0; i0 < n0old; ++i0) {
              for (index1 = 0; index1 < groupIndex[i0].length; index1++) {
                groupIndex[i0][index1] = reIndex[groupIndex[i0][index1]];
              }
            }
          } else {
            for (i0 = 0; i0 < n0; ++i0) {
              groupIndex[i0] = reIndex[groupIndex[i0]];
            }
          }
        }

        materializedVersion += 1;

        if (k > 1 || iterable) {
          setFilterListener(updateMany, resetMany);
        } else {
          if (!k && groupAll) {
            k = 1;
            groups = [{ key: null, value: initial() }];
          }
          if (k === 1) {
            setFilterListener(updateOne, resetOne);
          } else {
            setFilterListener(cr_null, cr_null);
          }
          groupIndex = null;
        }

        function groupIncrement() {
          if (iterable) {
            k++;
            return;
          }
          if (++k === groupCapacity) {
            reIndex = xfilterArray.arrayWiden(reIndex, groupWidth <<= 1);
            groupIndex = xfilterArray.arrayWiden(groupIndex, groupWidth);
            groupCapacity = capacity(groupWidth);
          }
        }
      }

      function removeData(reIndex) {
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
        sparseLayoutVersionReset();

        if (rawBucketMode && rawNumericState && !values) {
          onRawNumericRemove();
          return;
        }

        if (lazyIdentityMode && lazyEncodedState && !values) {
          lazyOrderVersion = -1;
          lazySortedCodes = null;
          lazyCodeToGroup = null;
          groups = null;
          valuesSynced = false;
          resetNeeded = true;
          if (lazyEncodedState.hasUnorderable) {
            materializeLazyEncodedState();
          }
          return;
        }

        if (lazyBucketMode && lazyEncodedState && !values) {
          bucketOrderVersion = -1;
          bucketKeys = null;
          bucketKeyToSlot = null;
          bucketCodeToSlot = null;
          bucketCodeCount = 0;
          bucketIndexedLength = 0;
          hasInvalidBucket = false;
          groups = null;
          groupIndex = null;
          valuesSynced = false;
          resetNeeded = true;
          if (lazyEncodedState.hasUnorderable) {
            materializeLazyEncodedState();
          }
          return;
        }

        if (reduceMode !== null && !iterable) {
          resetNeeded = true;
          valuesSynced = false;
        }
        materializedVersion += 1;

        if (k > 1 || iterable) {
          var oldK = k,
              oldGroups = groups,
              seenGroups = cr_index(oldK, oldK),
              i,
              i0,
              j;

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

          groups = [], k = 0;
          for (i = 0; i < oldK; ++i) {
            if (seenGroups[i]) {
              seenGroups[i] = k++;
              groups.push(oldGroups[i]);
            }
          }

          if (k > 1 || iterable) {
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
          if (k > 1 || iterable) {
            setFilterListener(updateMany, resetMany);
          } else if (k === 1) {
            setFilterListener(updateOne, resetOne);
          } else {
            setFilterListener(cr_null, cr_null);
          }
        } else if (k === 1) {
          if (groupAll) return;
          for (var index3 = 0; index3 < n; ++index3) if (reIndex[index3] !== REMOVED_INDEX) return;
          groups = [], k = 0;
          setFilterListener(cr_null, cr_null);
        }
      }

      // Reduces the specified selected or deselected records.
      function updateMany(filterSlot, added, removed, notFilter, forceReset) {
        if (notFilter) { unfilteredValid = false; buffersHoldUnfiltered = false; }
        if (filterSlot === dimSlot || resetNeeded) return;

        var i,
            j,
            rowIdx,
            len,
            g;

        if (iterable) {
          for (i = 0, len = added.length; i < len; ++i) {
            if (filterStore.isActiveExcept(rowIdx = added[i], dimSlot)) {
              for (j = 0; j < groupIndex[rowIdx].length; j++) {
                g = groups[groupIndex[rowIdx][j]];
                if (reduceMode === 'count') {
                  g.value += 1;
                } else {
                  g.value = reduceAdd(g.value, getRecord(rowIdx), false, j);
                }
              }
            }
          }

          for (i = 0, len = removed.length; i < len; ++i) {
            if (filterStore.isOnlyExcludedByExcept(rowIdx = removed[i], dimSlot, filterSlot)) {
              for (j = 0; j < groupIndex[rowIdx].length; j++) {
                g = groups[groupIndex[rowIdx][j]];
                if (reduceMode === 'count') {
                  g.value -= 1;
                } else {
                  g.value = reduceRemove(g.value, getRecord(rowIdx), notFilter, j);
                }
              }
            }
          }
          return;
        }

        if (reduceMode !== null) {
          if (notFilter || forceReset || added.length + removed.length > (n >>> 2)
            || (reduceMode !== 'count' && removed.length > 0 && metricPlan && !canPlanUseComplement(metricPlan, getNumericColumn))) {
            resetNeeded = true;
            valuesSynced = false;
            return;
          }

          var slotArr = getPrimarySlotArray();
          if (!slotArr || k === 0) {
            return;
          }
          materializeUnfilteredCacheIfNeeded();

          if (reduceMode === 'count') {
            for (i = 0, len = added.length; i < len; ++i) {
              rowIdx = added[i];
              if (filterStore.isActiveExcept(rowIdx, dimSlot)) {
                countBuf[slotArr[rowIdx]] += 1;
              }
            }
            for (i = 0, len = removed.length; i < len; ++i) {
              rowIdx = removed[i];
              if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) {
                countBuf[slotArr[rowIdx]] -= 1;
              }
            }
            valuesSynced = false;
            return;
          }

          var addCount = 0,
              remCount = 0,
              maxWork = added.length > removed.length ? added.length : removed.length;

          if (reduceMode === 'splitMetricSpec') {
            var splitCol = getSplitColumn(reduceSplitField);
            if (splitCol.codeToKey.length !== splitActiveStride) {
              resetNeeded = true;
              valuesSynced = false;
              return;
            }
            if (maxWork > 0) {
              deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, maxWork);
            }
            for (i = 0, len = added.length; i < len; ++i) {
              rowIdx = added[i];
              if (filterStore.isActiveExcept(rowIdx, dimSlot)) {
                deltaWorkBuf[addCount++] = rowIdx;
              }
            }
            if (addCount > 0) {
              if (splitMode === 'dense') {
                reduceSplitDenseIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, splitActiveStride, deltaWorkBuf, addCount, 1, 0);
              } else {
                reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, deltaWorkBuf, addCount, 1, 0);
              }
            }
            for (i = 0, len = removed.length; i < len; ++i) {
              rowIdx = removed[i];
              if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) {
                deltaWorkBuf[remCount++] = rowIdx;
              }
            }
            if (remCount > 0) {
              if (splitMode === 'dense') {
                reduceSplitDenseIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, splitActiveStride, deltaWorkBuf, remCount, -1, 0);
              } else {
                reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, deltaWorkBuf, remCount, -1, 0);
              }
            }
            valuesSynced = false;
            return;
          }

          // reduceMode === 'metricSpec'
          if (maxWork > 0) {
            deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, maxWork);
          }
          for (i = 0, len = added.length; i < len; ++i) {
            rowIdx = added[i];
            if (filterStore.isActiveExcept(rowIdx, dimSlot)) {
              deltaWorkBuf[addCount++] = rowIdx;
            }
          }
          if (addCount > 0) {
            reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, deltaWorkBuf, addCount, 1, 0);
          }
          for (i = 0, len = removed.length; i < len; ++i) {
            rowIdx = removed[i];
            if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) {
              deltaWorkBuf[remCount++] = rowIdx;
            }
          }
          if (remCount > 0) {
            reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, deltaWorkBuf, remCount, -1, 0);
          }
          valuesSynced = false;
          return;
        }

        // Custom reducer path
        var customSlotArr = lazyIdentityMode ? lazyEncodedState.codes : groupIndex;
        for (i = 0, len = added.length; i < len; ++i) {
          if (filterStore.isActiveExcept(rowIdx = added[i], dimSlot)) {
            var ag = lazyIdentityMode
              ? lazyCodeToGroup[customSlotArr[rowIdx]]
              : (rawBucketMode ? rawBucketSlotToGroup[customSlotArr[rowIdx]] : customSlotArr[rowIdx]);
            if (ag >= 0 && ag < k) {
              g = groups[ag];
              g.value = reduceAdd(g.value, getRecord(rowIdx), false);
            }
          }
        }

        for (i = 0, len = removed.length; i < len; ++i) {
          if (filterStore.isOnlyExcludedByExcept(rowIdx = removed[i], dimSlot, filterSlot)) {
            var rg = lazyIdentityMode
              ? lazyCodeToGroup[customSlotArr[rowIdx]]
              : (rawBucketMode ? rawBucketSlotToGroup[customSlotArr[rowIdx]] : customSlotArr[rowIdx]);
            if (rg >= 0 && rg < k) {
              g = groups[rg];
              g.value = reduceRemove(g.value, getRecord(rowIdx), notFilter);
            }
          }
        }
      }

      // Reduces the specified selected or deselected records (cardinality 1).
      function updateOne(filterSlot, added, removed, notFilter, forceReset) {
        if (notFilter) { unfilteredValid = false; buffersHoldUnfiltered = false; }
        if (filterSlot === dimSlot || resetNeeded) return;

        var i,
            rowIdx,
            len,
            g;

        if (reduceMode !== null) {
          if (notFilter || forceReset || added.length + removed.length > (n >>> 2)
            || (reduceMode !== 'count' && removed.length > 0 && metricPlan && !canPlanUseComplement(metricPlan, getNumericColumn))) {
            resetNeeded = true;
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'count') {
            var delta = 0;
            for (i = 0, len = added.length; i < len; ++i) {
              if (filterStore.isActiveExcept(added[i], dimSlot)) ++delta;
            }
            for (i = 0, len = removed.length; i < len; ++i) {
              if (filterStore.isOnlyExcludedByExcept(removed[i], dimSlot, filterSlot)) --delta;
            }
            countBuf[0] += delta;
            valuesSynced = false;
            return;
          }

          var addCount = 0,
              remCount = 0,
              maxWork = added.length > removed.length ? added.length : removed.length;
          if (maxWork > 0) {
            deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, maxWork);
          }

          if (reduceMode === 'splitMetricSpec') {
            var splitCol = getSplitColumn(reduceSplitField);
            if (splitCol.codeToKey.length !== splitActiveStride) {
              resetNeeded = true;
              valuesSynced = false;
              return;
            }
            materializeUnfilteredCacheIfNeeded();
            for (i = 0, len = added.length; i < len; ++i) {
              rowIdx = added[i];
              if (filterStore.isActiveExcept(rowIdx, dimSlot)) deltaWorkBuf[addCount++] = rowIdx;
            }
            if (addCount > 0) {
              reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, deltaWorkBuf, addCount, 1, 0);
            }
            for (i = 0, len = removed.length; i < len; ++i) {
              rowIdx = removed[i];
              if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) deltaWorkBuf[remCount++] = rowIdx;
            }
            if (remCount > 0) {
              reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, deltaWorkBuf, remCount, -1, 0);
            }
            valuesSynced = false;
            return;
          }

          // reduceMode === 'metricSpec'
          materializeUnfilteredCacheIfNeeded();
          for (i = 0, len = added.length; i < len; ++i) {
            rowIdx = added[i];
            if (filterStore.isActiveExcept(rowIdx, dimSlot)) deltaWorkBuf[addCount++] = rowIdx;
          }
          if (addCount > 0) {
            reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, addCount, 1);
          }
          for (i = 0, len = removed.length; i < len; ++i) {
            rowIdx = removed[i];
            if (filterStore.isOnlyExcludedByExcept(rowIdx, dimSlot, filterSlot)) deltaWorkBuf[remCount++] = rowIdx;
          }
          if (remCount > 0) {
            reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, remCount, -1);
          }
          valuesSynced = false;
          return;
        }

        g = groups[0];
        for (i = 0, len = added.length; i < len; ++i) {
          if (filterStore.isActiveExcept(rowIdx = added[i], dimSlot)) {
            g.value = reduceAdd(g.value, getRecord(rowIdx), false);
          }
        }
        for (i = 0, len = removed.length; i < len; ++i) {
          if (filterStore.isOnlyExcludedByExcept(rowIdx = removed[i], dimSlot, filterSlot)) {
            g.value = reduceRemove(g.value, getRecord(rowIdx), notFilter);
          }
        }
      }

      // Recomputes the group reduce values from scratch.
      function resetMany() {
        var i,
            j,
            g,
            applyFilteredRemovals = hasOtherActiveDimensionFilters();

        if (lazyIdentityMode) {
          ensureLazyOrder();
        } else if (rawBucketMode) {
          ensureRawBucketLayout();
        } else if (lazyBucketMode) {
          ensureLazyBucketLayout();
        }

        if (iterable) {
          for (i = 0; i < k; ++i) {
            groups[i].value = reduceInitial();
          }
          for (i = 0; i < n; ++i) {
            for (j = 0; j < groupIndex[i].length; j++) {
              g = groups[groupIndex[i][j]];
              if (reduceMode === 'count') {
                g.value += 1;
              } else {
                var iterableRecord = getRecord(i);
                g.value = reduceAdd(g.value, iterableRecord, true, j);
              }
            }
          }
          if (!applyFilteredRemovals) {
            valuesSynced = true;
            return;
          }
          for (i = 0; i < n; ++i) {
            if (!filterStore.isActiveExcept(i, dimSlot)) {
              for (j = 0; j < groupIndex[i].length; j++) {
                g = groups[groupIndex[i][j]];
                if (reduceMode === 'count') {
                  g.value -= 1;
                } else {
                  var filteredIterableRecord = getRecord(i);
                  g.value = reduceRemove(g.value, filteredIterableRecord, false, j);
                }
              }
            }
          }
          valuesSynced = true;
          return;
        }

        if (k === 0) {
          groups = [];
          valuesSynced = true;
          return;
        }

        if (reduceMode !== null) {
          var slotArr = getPrimarySlotArray(),
              slotCount = getPrimarySlotCount(),
              rows;

          if (reduceMode === 'count') {
            ensureCountBuf(slotCount);
            countBuf.fill(0, 0, slotCount);
            if (!applyFilteredRemovals) {
              if (lazyIdentityMode) {
                var cc = lazyEncodedState.codeCounts;
                for (i = 1; i < slotCount; ++i) {
                  countBuf[i] = cc[i];
                }
              } else {
                for (i = 0; i < n; ++i) {
                  countBuf[slotArr[i]] += 1;
                }
              }
            } else {
              rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
              if (!rows) {
                if (lazyIdentityMode) {
                  var ccAll = lazyEncodedState.codeCounts;
                  for (i = 1; i < slotCount; ++i) {
                    countBuf[i] = ccAll[i];
                  }
                } else {
                  for (i = 0; i < n; ++i) {
                    countBuf[slotArr[i]] += 1;
                  }
                }
              } else {
                var rIdx = rows.indices,
                    rLen = rows.length;
                for (i = 0; i < rLen; ++i) {
                  countBuf[slotArr[rIdx[i]]] += 1;
                }
              }
            }
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'metricSpec') {
            if (!applyFilteredRemovals) {
              if (!restoreUnfilteredIntoBuffers(slotCount, false)) {
                buffersHoldUnfiltered = false;
                unfilteredValid = false;
                metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
                zeroMetricBuffers(metricBuffers, slotCount);
                reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, slotArr, n, slotCount);
                markBuffersHoldUnfiltered(slotCount);
              }
            } else if (brushActive && brushFalcon && transientFilterDepth === 0 && !dimSlot.active && brushFalcon.hasGroup(group)) {
              var singleInfo = {
                buffers: metricBuffers,
                ensureBuffers: function() {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
                  singleInfo.buffers = metricBuffers;
                },
                groupRef: group,
                slotArr: slotArr,
                slotCount: slotCount
              };
              brushFalcon.applyQuerySingle(brushQueryKind, brushLo, brushHi, singleInfo);
            } else {
              var mActCnt = !dimSlot.active ? filteredCount() : filterStore.countActive(dimSlot);
              if (mActCnt === 0) {
                materializeUnfilteredCacheIfNeeded();
                metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
                zeroMetricBuffers(metricBuffers, slotCount);
              } else if (mActCnt === n && restoreUnfilteredIntoBuffers(slotCount, false)) ; else if (mActCnt > (n >>> 1) && hasValidUnfilteredCache(slotCount) && canPlanUseComplement(metricPlan, getNumericColumn)) {
                var mExcl = getExcludedRows(dimSlot.active ? dimSlot : null);
                restoreUnfilteredIntoBuffers(slotCount, true);
                if (mExcl.length > 0) {
                  reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, mExcl.indices, mExcl.length, -1, slotCount);
                  var mExCntOff = getExactCountOffset(metricPlan, getNumericColumn);
                  var mTrk = mExCntOff < 0 ? ensureUnfilteredRowCounts(slotCount, slotArr, null, 0) : null;
                  cleanupComplementEmptySlots(
                    metricBuffers, metricPlan, mExCntOff, slotArr, null, 0,
                    mTrk, mExCntOff < 0 ? ensureUnfilteredTmpCounts(slotCount) : null,
                    mExcl.indices, mExcl.length, slotCount
                  );
                }
              } else {
                materializeUnfilteredCacheIfNeeded();
                metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, slotCount, false);
                zeroMetricBuffers(metricBuffers, slotCount);
                rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
                if (!rows) {
                  reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, slotArr, n, slotCount);
                } else {
                  reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, rows.indices, rows.length, 1, slotCount);
                }
              }
            }
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'splitMetricSpec') {
            var splitCol = getSplitColumn(reduceSplitField),
                stride = splitCol.codeToKey.length;
            splitActiveStride = stride;
            if (stride === 0) {
              splitMode = 'dense';
              buffersHoldUnfiltered = false;
              unfilteredValid = false;
              metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
              zeroMetricBuffers(metricBuffers, 1);
              valuesSynced = false;
              return;
            }
            if (slotCount * stride <= 262144) {
              splitMode = 'dense';
              var totalSlots = slotCount * stride;
              if (!applyFilteredRemovals) {
                if (!restoreUnfilteredIntoBuffers(totalSlots, false)) {
                  buffersHoldUnfiltered = false;
                  unfilteredValid = false;
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, totalSlots, false);
                  zeroMetricBuffers(metricBuffers, totalSlots);
                  reduceSplitDenseAll(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, stride, n, totalSlots);
                  markBuffersHoldUnfiltered(totalSlots);
                }
              } else {
                var sdActCnt = !dimSlot.active ? filteredCount() : filterStore.countActive(dimSlot);
                if (sdActCnt === 0) {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, totalSlots, false);
                  zeroMetricBuffers(metricBuffers, totalSlots);
                } else if (sdActCnt === n && restoreUnfilteredIntoBuffers(totalSlots, false)) ; else if (sdActCnt > (n >>> 1) && hasValidUnfilteredCache(totalSlots) && canPlanUseComplement(metricPlan, getNumericColumn)) {
                  var sdExcl = getExcludedRows(dimSlot.active ? dimSlot : null);
                  restoreUnfilteredIntoBuffers(totalSlots, true);
                  if (sdExcl.length > 0) {
                    reduceSplitDenseIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, stride, sdExcl.indices, sdExcl.length, -1, totalSlots);
                    var sdExCntOff = getExactCountOffset(metricPlan, getNumericColumn);
                    var sdTrk = sdExCntOff < 0 ? ensureUnfilteredRowCounts(totalSlots, slotArr, splitCol.codes, stride) : null;
                    cleanupComplementEmptySlots(
                      metricBuffers, metricPlan, sdExCntOff, slotArr, splitCol.codes, stride,
                      sdTrk, sdExCntOff < 0 ? ensureUnfilteredTmpCounts(totalSlots) : null,
                      sdExcl.indices, sdExcl.length, totalSlots
                    );
                  }
                } else {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, totalSlots, false);
                  zeroMetricBuffers(metricBuffers, totalSlots);
                  rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
                  if (!rows) {
                    reduceSplitDenseAll(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, stride, n, totalSlots);
                  } else {
                    reduceSplitDenseIndexed(metricBuffers, metricPlan, getNumericColumn, slotArr, splitCol.codes, stride, rows.indices, rows.length, 1, totalSlots);
                  }
                }
              }
            } else {
              splitMode = 'sparse';
              ensureSparseSplitLayout(slotArr, slotCount, splitCol);
              var spSlots = sparsePairCount || 1;
              if (!applyFilteredRemovals) {
                if (!restoreUnfilteredIntoBuffers(sparsePairCount, false)) {
                  buffersHoldUnfiltered = false;
                  unfilteredValid = false;
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, spSlots, false);
                  zeroMetricBuffers(metricBuffers, sparsePairCount);
                  reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, n, sparsePairCount);
                  markBuffersHoldUnfiltered(sparsePairCount);
                }
              } else {
                var spActCnt = !dimSlot.active ? filteredCount() : filterStore.countActive(dimSlot);
                if (spActCnt === 0) {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, spSlots, false);
                  zeroMetricBuffers(metricBuffers, sparsePairCount);
                } else if (spActCnt === n && restoreUnfilteredIntoBuffers(sparsePairCount, false)) ; else if (spActCnt > (n >>> 1) && hasValidUnfilteredCache(sparsePairCount) && canPlanUseComplement(metricPlan, getNumericColumn)) {
                  var spExcl = getExcludedRows(dimSlot.active ? dimSlot : null);
                  restoreUnfilteredIntoBuffers(sparsePairCount, true);
                  if (spExcl.length > 0) {
                    reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, spExcl.indices, spExcl.length, -1, sparsePairCount);
                    var spExCntOff = getExactCountOffset(metricPlan, getNumericColumn);
                    var spTrk = spExCntOff < 0 ? ensureUnfilteredRowCounts(sparsePairCount, sparsePairGroupIds, null, 0) : null;
                    cleanupComplementEmptySlots(
                      metricBuffers, metricPlan, spExCntOff, sparsePairGroupIds, null, 0,
                      spTrk, spExCntOff < 0 ? ensureUnfilteredTmpCounts(sparsePairCount) : null,
                      spExcl.indices, spExcl.length, sparsePairCount
                    );
                  }
                } else {
                  materializeUnfilteredCacheIfNeeded();
                  metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, spSlots, false);
                  zeroMetricBuffers(metricBuffers, sparsePairCount);
                  rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
                  if (!rows) {
                    reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, n, sparsePairCount);
                  } else {
                    reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, sparsePairGroupIds, rows.indices, rows.length, 1, sparsePairCount);
                  }
                }
              }
            }
            valuesSynced = false;
            return;
          }
        }

        // Custom reducer path
        if (lazyIdentityMode) {
          ensureLazyIdentityGroups();
        } else if (rawBucketMode) {
          if (!groups || groups.length !== k) {
            groups = new Array(k);
            for (i = 0; i < k; ++i) {
              groups[i] = { key: rawBucketKeys[rawBucketSortedOrder[i]], value: undefined };
            }
          }
        } else if (lazyBucketMode && (!groups || groups.length !== k)) {
          groups = new Array(k);
          for (i = 0; i < k; ++i) {
            groups[i] = { key: bucketKeys[i], value: undefined };
          }
        }

        for (i = 0; i < k; ++i) {
          groups[i].value = reduceInitial();
        }

        var rawToSorted = null;
        if (rawBucketMode) {
          rawToSorted = new Uint32Array(k);
          for (i = 0; i < k; ++i) rawToSorted[rawBucketSortedOrder[i]] = i;
        }

        var customSlotArr = lazyIdentityMode ? lazyEncodedState.codes : groupIndex;
        for (i = 0; i < n; ++i) {
          var ag = lazyIdentityMode
            ? lazyCodeToGroup[customSlotArr[i]]
            : (rawBucketMode ? rawToSorted[customSlotArr[i]] : customSlotArr[i]);
          if (ag >= 0 && ag < k) {
            g = groups[ag];
            g.value = reduceAdd(g.value, getRecord(i), true);
          }
        }
        if (!applyFilteredRemovals) {
          valuesSynced = true;
          return;
        }
        for (i = 0; i < n; ++i) {
          if (!filterStore.isActiveExcept(i, dimSlot)) {
            var rg = lazyIdentityMode
              ? lazyCodeToGroup[customSlotArr[i]]
              : (rawBucketMode ? rawToSorted[customSlotArr[i]] : customSlotArr[i]);
            if (rg >= 0 && rg < k) {
              g = groups[rg];
              g.value = reduceRemove(g.value, getRecord(i), false);
            }
          }
        }
        valuesSynced = true;
      }

      // Recomputes the group reduce values from scratch (cardinality 1).
      function resetOne() {
        var i,
            applyFilteredRemovals = hasOtherActiveDimensionFilters(),
            rows;

        if (reduceMode !== null) {
          if (reduceMode === 'count') {
            ensureCountBuf(1);
            if (!applyFilteredRemovals) {
              countBuf[0] = n;
            } else if (!dimSlot.active) {
              countBuf[0] = filteredCount();
            } else {
              countBuf[0] = filterStore.countActive(dimSlot);
            }
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'metricSpec') {
            buffersHoldUnfiltered = false;
            unfilteredValid = false;
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
            zeroMetricBuffers(metricBuffers, 1);
            if (!applyFilteredRemovals) {
              reduceScalarAll(metricBuffers, metricPlan, getNumericColumn, n);
            } else {
              rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
              if (!rows) {
                reduceScalarAll(metricBuffers, metricPlan, getNumericColumn, n);
              } else {
                reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, rows.indices, rows.length, 1);
              }
            }
            valuesSynced = false;
            return;
          }

          if (reduceMode === 'splitMetricSpec') {
            buffersHoldUnfiltered = false;
            unfilteredValid = false;
            var splitCol = getSplitColumn(reduceSplitField),
                stride = splitCol.codeToKey.length;
            splitMode = 'dense';
            splitActiveStride = stride;
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, stride || 1, false);
            zeroMetricBuffers(metricBuffers, stride);
            if (stride > 0) {
              if (!applyFilteredRemovals) {
                reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, n, stride);
              } else {
                rows = !dimSlot.active ? getActiveRows() : collectZeroExceptRows(dimSlot);
                if (!rows) {
                  reduceGroupedAll(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, n, stride);
                } else {
                  reduceGroupedIndexed(metricBuffers, metricPlan, getNumericColumn, splitCol.codes, rows.indices, rows.length, 1, stride);
                }
              }
            }
            valuesSynced = false;
            return;
          }
        }

        var g = groups[0];
        g.value = reduceInitial();
        for (i = 0; i < n; ++i) {
          g.value = reduceAdd(g.value, getRecord(i), true);
        }
        if (!applyFilteredRemovals) {
          valuesSynced = true;
          return;
        }
        for (i = 0; i < n; ++i) {
          if (!filterStore.isActiveExcept(i, dimSlot)) {
            g.value = reduceRemove(g.value, getRecord(i), false);
          }
        }
        valuesSynced = true;
      }

      function readColumnar() {
        if (iterable || (reduceMode !== 'metricSpec' && reduceMode !== 'splitMetricSpec')) {
          return null;
        }
        if (lazyIdentityMode) {
          ensureLazyOrder();
        } else if (rawBucketMode) {
          ensureRawBucketLayout();
        } else if (lazyBucketMode) {
          ensureLazyBucketLayout();
        }
        if (resetNeeded) {
          reset();
          resetNeeded = false;
        }

        var keySource = null,
            codeToValue = null,
            slotOf = null,
            groupsRef = null;

        if (lazyIdentityMode) {
          codeToValue = lazyEncodedState.codeToValue;
          slotOf = lazySortedCodes;
        } else if (rawBucketMode) {
          codeToValue = rawBucketKeys;
          slotOf = rawBucketSortedOrder;
        } else if (lazyBucketMode) {
          keySource = bucketKeys;
        } else {
          groupsRef = groups;
        }

        if (reduceMode === 'metricSpec') {
          return {
            buffers: metricBuffers,
            codeToValue: codeToValue,
            count: k,
            groups: groupsRef,
            keys: keySource,
            mode: 'flat',
            plan: metricPlan,
            slotOf: slotOf
          };
        }

        var splitCol = getSplitColumn(reduceSplitField);
        if (splitMode === 'dense') {
          return {
            buffers: metricBuffers,
            codeToValue: codeToValue,
            count: k,
            groups: groupsRef,
            keys: keySource,
            mode: 'splitDense',
            plan: metricPlan,
            slotOf: slotOf,
            splitKeys: splitCol.codeToKey,
            splitStride: splitActiveStride
          };
        }

        return {
          buffers: metricBuffers,
          codeToValue: codeToValue,
          count: k,
          groups: groupsRef,
          headBySlot: sparseHeadBySlot,
          keys: keySource,
          mode: 'splitSparse',
          nextPair: sparseNextPair,
          pairSplitCode: sparsePairSplitCode,
          plan: metricPlan,
          slotOf: slotOf,
          splitKeys: splitCol.codeToKey
        };
      }

      // Returns the array of group values, in the dimension's natural order.
      function all() {
        if (resetNeeded) reset(), resetNeeded = false;
        syncGroupsFromBuffers();
        return groups;
      }

      // Returns a new array containing the top K group values, in reduce order.
      function top(k) {
        var top = select(all(), 0, groups.length, k);
        return heap.sort(top, 0, top.length);
      }

      // Sets the reduce behavior for this group to use the specified functions.
      // This method lazily recomputes the reduce values, waiting until needed.
      function reduce(addFn, removeFn, initialFn) {
        reduceAdd = addFn;
        reduceRemove = removeFn;
        reduceInitial = initialFn;
        var resolved = resolveReduceMetricSpec(addFn, removeFn, initialFn);
        reduceMetricSpec = resolved ? resolved.metrics : null;
        reduceSplitField = resolved ? resolved.splitField : null;
        metricPlan = reduceMetricSpec ? compileMetricPlan(reduceMetricSpec) : null;
        metricBuffers = null;
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
        unfilteredData = null;
        unfilteredRowCounts = null;
        unfilteredTmpCounts = null;
        if (brushFalcon && brushFalcon.hasGroup(group)) {
          brushFalcon = null;
          brushBuildFailed = false;
        }
        splitMode = null;
        splitActiveStride = 0;
        reduceMode = null;
        if (reduceMetricSpec && !iterable) {
          reduceMode = reduceSplitField ? 'splitMetricSpec' : 'metricSpec';
        }
        syncUpdateListenerMeta();
        resetNeeded = true;
        valuesSynced = false;
        return group;
      }

      // A convenience method for reducing by count.
      function reduceCount() {
        reduce(xfilterReduce.reduceIncrement, xfilterReduce.reduceDecrement, cr_zero);
        reduceMode = 'count';
        syncUpdateListenerMeta();
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
        if (lazyIdentityMode) {
          ensureLazyOrder();
        } else if (rawBucketMode) {
          ensureRawBucketLayout();
        } else if (lazyBucketMode) {
          ensureLazyBucketLayout();
        }
        return k;
      }

      // Removes this group and associated event listeners.
      function dispose() {
        unfilteredValid = false;
        buffersHoldUnfiltered = false;
        unfilteredData = null;
        unfilteredRowCounts = null;
        unfilteredTmpCounts = null;
        if (brushFalcon && brushFalcon.hasGroup(group)) {
          brushFalcon = null;
          brushBuildFailed = false;
        }
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
      dimensionGroups.slice().forEach(function(group) { group.dispose(); });
      if (lazyStateGetter && accessorPath && lazyDimensionsByField[accessorPath]) {
        var lIdx = lazyDimensionsByField[accessorPath].indexOf(lazyStateGetter);
        if (lIdx >= 0) lazyDimensionsByField[accessorPath].splice(lIdx, 1);
      }
      var i = dataListeners.indexOf(preAdd);
      if (i >= 0) dataListeners.splice(i, 1);
      i = dataListeners.indexOf(postAdd);
      if (i >= 0) dataListeners.splice(i, 1);
      i = removeDataListeners.indexOf(removeData);
      if (i >= 0) removeDataListeners.splice(i, 1);
      filterAll();
      if (brushDimSlot === dimSlot) {
        invalidateBrushState();
      }
      filterStore.freeSlot(dimSlot);
      return dimension;
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
      remove: dispose, // for backwards-compatibility
      _coScanInfo: coScanInfo,
      _readScalar: readScalar
    };

    var reduceValue,
        reduceAdd,
        reduceRemove,
        reduceInitial,
        reduceMetricSpec = null,
        metricPlan = null,
        metricBuffers = null,
        unfilteredData = null,
        unfilteredValid = false,
        reduceMode = null,
        valueSynced = false,
        resetNeeded = true,
        markResetNeeded = registerResetListener(function() {
          resetNeeded = true;
          valueSynced = false;
        });

    function saveUnfilteredScalar() {
      if (!metricPlan || !metricBuffers) return;
      var stride = metricPlan.stride;
      if (!unfilteredData || unfilteredData.length < stride) {
        unfilteredData = new Float64Array(stride);
      }
      unfilteredData.set(metricBuffers.data.subarray(0, stride));
      unfilteredValid = true;
    }

    function restoreUnfilteredScalar() {
      if (!unfilteredValid || !unfilteredData || !metricPlan) return false;
      metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
      metricBuffers.data.set(unfilteredData.subarray(0, metricPlan.stride));
      return true;
    }

    function coScanInfo() {
      if (!resetNeeded || reduceMode !== 'metricSpec' || !metricPlan || !metricPlan.canCoScan) {
        return null;
      }
      var applyFilteredRemovals = hasAnyActiveDimensionFilters();
      var info = {
        buffers: metricBuffers,
        canComplement: function() {
          return unfilteredValid && unfilteredData !== null;
        },
        coScanKey: metricPlan.coScanKey,
        commit: function(saveCache) {
          if (saveCache) saveUnfilteredScalar();
          resetNeeded = false;
          valueSynced = false;
        },
        ensureBuffers: function() {
          metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
          info.buffers = metricBuffers;
        },
        groupRef: group,
        plan: metricPlan,
        prepareZero: function() {
          metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
          zeroMetricBuffers(metricBuffers, 1);
          info.buffers = metricBuffers;
        },
        tryRestoreUnfiltered: function() {
          if (restoreUnfilteredScalar()) {
            info.buffers = metricBuffers;
            return true;
          }
          return false;
        },
        unfiltered: !applyFilteredRemovals
      };
      return info;
    }

    // The group listens to the crossfilter for when any dimension changes, so
    // that it can update the reduce value. It must also listen to the parent
    // dimension for when data is added.
    update._xfilterDimSlot = null;
    update._xfilterResettable = false;
    filterListeners.push(update);
    dataListeners.push(add);

    // For consistency; actually a no-op since resetNeeded is true.
    add(data, 0);

    // Incorporates the specified new values into this group.
    function add(newData, n0) {
      unfilteredValid = false;
      var i,
          applyFilteredRemovals = hasAnyActiveDimensionFilters();

      if (resetNeeded) return;

      if (reduceMode === 'count') {
        if (!applyFilteredRemovals) {
          reduceValue += (n - n0);
        } else {
          for (i = n0; i < n; ++i) {
            if (filterStore.isActive(i)) reduceValue += 1;
          }
        }
        return;
      }

      if (reduceMode === 'metricSpec') {
        var addedLen = n - n0;
        if (!addedLen) return;
        deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, addedLen);
        var count = 0;
        if (!applyFilteredRemovals) {
          for (i = n0; i < n; ++i) deltaWorkBuf[count++] = i;
        } else {
          for (i = n0; i < n; ++i) {
            if (filterStore.isActive(i)) deltaWorkBuf[count++] = i;
          }
        }
        if (count > 0) {
          reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, count, 1);
          valueSynced = false;
        }
        return;
      }

      // Cycle through all the values.
      for (i = n0; i < n; ++i) {
        var rowRecord = getRecord(i);
        reduceValue = reduceAdd(reduceValue, rowRecord, true);
        if (applyFilteredRemovals && !filterStore.isActive(i)) {
          reduceValue = reduceRemove(reduceValue, rowRecord, false);
        }
      }
    }

    // Reduces the specified selected or deselected records.
    function update(filterSlot, added, removed, notFilter, forceReset) {
      if (notFilter) unfilteredValid = false;
      var i,
          k,
          len;

      if (resetNeeded) return;

      if (reduceMode !== null) {
        if (notFilter || forceReset || added.length + removed.length > (n >>> 2)
          || (reduceMode !== 'count' && removed.length > 0 && metricPlan && !canPlanUseComplement(metricPlan, getNumericColumn))) {
          resetNeeded = true;
          valueSynced = false;
          return;
        }

        if (reduceMode === 'count') {
          var delta = 0;
          for (i = 0, len = added.length; i < len; ++i) {
            if (filterStore.isActive(added[i])) ++delta;
          }
          for (i = 0, len = removed.length; i < len; ++i) {
            if (filterStore.isOnlyExcludedBy(removed[i], filterSlot)) --delta;
          }
          reduceValue += delta;
          return;
        }

        // reduceMode === 'metricSpec'
        var maxWork = added.length > removed.length ? added.length : removed.length;
        if (maxWork > 0) {
          deltaWorkBuf = ensureUint32Capacity(deltaWorkBuf, maxWork);
        }
        var addCount = 0;
        for (i = 0, len = added.length; i < len; ++i) {
          k = added[i];
          if (filterStore.isActive(k)) deltaWorkBuf[addCount++] = k;
        }
        if (addCount > 0) {
          reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, addCount, 1);
        }
        var remCount = 0;
        for (i = 0, len = removed.length; i < len; ++i) {
          k = removed[i];
          if (filterStore.isOnlyExcludedBy(k, filterSlot)) deltaWorkBuf[remCount++] = k;
        }
        if (remCount > 0) {
          reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, deltaWorkBuf, remCount, -1);
        }
        valueSynced = false;
        return;
      }

      // Add the added values.
      for (i = 0, len = added.length; i < len; ++i) {
        if (filterStore.isActive(k = added[i])) {
          reduceValue = reduceAdd(reduceValue, getRecord(k), notFilter);
        }
      }

      // Remove the removed values.
      for (i = 0, len = removed.length; i < len; ++i) {
        if (filterStore.isOnlyExcludedBy(k = removed[i], filterSlot)) {
          reduceValue = reduceRemove(reduceValue, getRecord(k), notFilter);
        }
      }
    }

    // Recomputes the group reduce value from scratch.
    function reset() {
      var i,
          applyFilteredRemovals = hasAnyActiveDimensionFilters();

      if (reduceMode === 'count') {
        reduceValue = filteredCount();
        valueSynced = true;
        return;
      }

      if (reduceMode === 'metricSpec') {
        if (!applyFilteredRemovals) {
          if (!restoreUnfilteredScalar()) {
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
            zeroMetricBuffers(metricBuffers, 1);
            reduceScalarAll(metricBuffers, metricPlan, getNumericColumn, n);
            saveUnfilteredScalar();
          }
        } else if (brushActive && brushFalcon && transientFilterDepth === 0 && brushFalcon.hasGroup(group)) {
          var kpiSingle = {
            buffers: metricBuffers,
            ensureBuffers: function() {
              metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
              kpiSingle.buffers = metricBuffers;
            },
            groupRef: group,
            slotArr: null,
            slotCount: 1
          };
          brushFalcon.applyQuerySingle(brushQueryKind, brushLo, brushHi, kpiSingle);
        } else {
          var sActCnt = filteredCount();
          if (sActCnt === 0) {
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
            zeroMetricBuffers(metricBuffers, 1);
          } else if (sActCnt === n && restoreUnfilteredScalar()) ; else if (sActCnt > (n >>> 1) && unfilteredValid && canPlanUseComplement(metricPlan, getNumericColumn)) {
            var sExcl = getExcludedRows(null);
            restoreUnfilteredScalar();
            if (sExcl.length > 0) {
              reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, sExcl.indices, sExcl.length, -1);
            }
          } else {
            metricBuffers = ensureMetricBuffers(metricBuffers, metricPlan, 1, false);
            zeroMetricBuffers(metricBuffers, 1);
            var active = getActiveRows();
            if (!active) {
              reduceScalarAll(metricBuffers, metricPlan, getNumericColumn, n);
            } else {
              reduceScalarIndexed(metricBuffers, metricPlan, getNumericColumn, active.indices, active.length, 1);
            }
          }
        }
        valueSynced = false;
        return;
      }

      reduceValue = reduceInitial();

      for (i = 0; i < n; ++i) {
        var rowRecord = getRecord(i);
        reduceValue = reduceAdd(reduceValue, rowRecord, true);
        if (applyFilteredRemovals && !filterStore.isActive(i)) {
          reduceValue = reduceRemove(reduceValue, rowRecord, false);
        }
      }
      valueSynced = true;
    }

    // Sets the reduce behavior for this group to use the specified functions.
    // This method lazily recomputes the reduce value, waiting until needed.
    function reduce(addFn, removeFn, initialFn) {
      reduceAdd = addFn;
      reduceRemove = removeFn;
      reduceInitial = initialFn;
      var resolved = resolveReduceMetricSpec(addFn, removeFn, initialFn);
      reduceMetricSpec = resolved && !resolved.splitField ? resolved.metrics : null;
      metricPlan = reduceMetricSpec ? compileMetricPlan(reduceMetricSpec) : null;
      metricBuffers = null;
      unfilteredValid = false;
      unfilteredData = null;
      if (brushFalcon && brushFalcon.hasGroup(group)) {
        brushFalcon = null;
        brushBuildFailed = false;
      }
      reduceMode = reduceMetricSpec ? 'metricSpec' : null;
      update._xfilterResettable = reduceMode !== null;
      resetNeeded = true;
      valueSynced = false;
      return group;
    }

    // A convenience method for reducing by count.
    function reduceCount() {
      reduce(xfilterReduce.reduceIncrement, xfilterReduce.reduceDecrement, cr_zero);
      reduceMode = 'count';
      update._xfilterResettable = true;
      return group;
    }

    // A convenience method for reducing by sum(value).
    function reduceSum(value) {
      return reduce(xfilterReduce.reduceAdd(value), xfilterReduce.reduceSubtract(value), cr_zero);
    }

    function readScalar() {
      if (reduceMode !== 'metricSpec') {
        return null;
      }
      if (resetNeeded) reset(), resetNeeded = false;
      return finalizeMetricSlot(metricPlan, metricBuffers, 0);
    }

    // Returns the computed reduce value.
    function value() {
      if (resetNeeded) reset(), resetNeeded = false;
      if (reduceMode === 'metricSpec' && !valueSynced) {
        if (!reduceValue) reduceValue = reduceInitial();
        writeMetricSlotToState(reduceValue, metricPlan, metricBuffers, 0);
        valueSynced = true;
      }
      return reduceValue;
    }

    // Removes this group and associated event listeners.
    function dispose() {
      unfilteredValid = false;
      unfilteredData = null;
      if (brushFalcon && brushFalcon.hasGroup(group)) {
        brushFalcon = null;
        brushBuildFailed = false;
      }
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
        ignoreMap = buildIgnoreIdMap(ignore_dimensions);

    if (!ignoreMap) {
      if (!filterStore.hasAnyActive()) {
        for (i = 0; i < n; i++) array.push(getRecord(i));
        return array;
      }
      var active = getActiveRows();
      if (!active) {
        for (i = 0; i < n; i++) array.push(getRecord(i));
        return array;
      }
      var indices = active.indices,
          len = active.length;
      for (i = 0; i < len; i++) {
        array.push(getRecord(indices[i]));
      }
      return array;
    }

    for (i = 0; i < n; i++) {
      if (filterStore.isActiveIgnoring(i, ignoreMap)) {
        array.push(getRecord(i));
      }
    }

    return array;
  }

  function allFilteredIndexes(ignore_dimensions) {
    var array,
        i = 0,
        ignoreMap;

    if (!ignore_dimensions || !ignore_dimensions.length) {
      if (!filterStore.hasAnyActive()) {
        array = new Array(n);
        for (i = 0; i < n; ++i) array[i] = i;
        return array;
      }
      var active = getActiveRows();
      if (!active) {
        array = new Array(n);
        for (i = 0; i < n; ++i) array[i] = i;
        return array;
      }
      array = new Array(active.length);
      var indices = active.indices;
      for (i = 0; i < active.length; ++i) array[i] = indices[i];
      return array;
    }

    array = [];
    ignoreMap = buildIgnoreIdMap(ignore_dimensions);

    for (i = 0; i < n; i++) {
      if (filterStore.isActiveIgnoring(i, ignoreMap)) {
        array.push(i);
      }
    }

    return array;
  }

  function resolveUniformTypedArrayConstructor(field) {
    if (!columnarBatches.length) return null;
    var expectedStart = 0;
    var ctor = null;
    var firstTag = null;
    var b, batch, col, tag;
    for (b = 0; b < columnarBatches.length; ++b) {
      batch = columnarBatches[b];
      if (batch.start !== expectedStart) return null;
      expectedStart = batch.end;
      col = batch.columns[field];
      if (!ArrayBuffer.isView(col) || typeof col.BYTES_PER_ELEMENT !== 'number') return null;
      tag = objToString.call(col);
      if (ctor === null) {
        ctor = col.constructor;
        firstTag = tag;
      } else if (tag !== firstTag) {
        return null;
      }
    }
    return expectedStart === n ? ctor : null;
  }

  function takeColumns(rowIndexes, fields) {
    var selectedFields = fields && fields.length ? fields.slice() : null;
    var columns = {};
    var rowCount = rowIndexes ? rowIndexes.length : 0;
    var fieldIndex;
    var rowIndex;
    var batchCount = columnarBatches.length;
    var singleFullBatch = batchCount === 1
      && columnarBatches[0].start === 0
      && columnarBatches[0].end === n
      ? columnarBatches[0]
      : null;

    if (!selectedFields) {
      return {
        columns: columns,
        fields: [],
        length: rowCount
      };
    }

    var batchStarts = null;
    var batchEnds = null;
    if (batchCount > 0 && !singleFullBatch) {
      batchStarts = new Uint32Array(batchCount);
      batchEnds = new Uint32Array(batchCount);
      for (var bi0 = 0; bi0 < batchCount; ++bi0) {
        batchStarts[bi0] = columnarBatches[bi0].start;
        batchEnds[bi0] = columnarBatches[bi0].end;
      }
    }

    for (fieldIndex = 0; fieldIndex < selectedFields.length; ++fieldIndex) {
      var field = selectedFields[fieldIndex];
      var typedCtor = resolveUniformTypedArrayConstructor(field);
      var out = typedCtor ? new typedCtor(rowCount) : new Array(rowCount);

      if (singleFullBatch) {
        var srcCol = singleFullBatch.columns[field];
        var srcAcc = singleFullBatch.accessors && singleFullBatch.accessors[field];
        if (ArrayBuffer.isView(srcCol) || Array.isArray(srcCol)) {
          for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
            out[rowIndex] = srcCol[rowIndexes[rowIndex]];
          }
        } else {
          var srcDictChunks = rowCount > 32 ? resolveArrowDictionaryChunks(srcCol) : null;
          if (srcDictChunks && srcDictChunks.length === 1 && srcDictChunks[0].dictionary.length <= rowCount * 2) {
            var dChunk = srcDictChunks[0];
            var dDict = dChunk.dictionary;
            var dLen = dDict.length;
            var dVals = new Array(dLen);
            for (var d = 0; d < dLen; ++d) dVals[d] = dDict.get(d);
            var dIndices = dChunk.values;
            if (dChunk.nullCount === 0) {
              for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                out[rowIndex] = dVals[dIndices[rowIndexes[rowIndex]]];
              }
            } else {
              var dNull = dChunk.nullBitmap;
              var dOff = typeof dChunk.offset === 'number' ? dChunk.offset : 0;
              for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                var dri = rowIndexes[rowIndex];
                var dBitIdx = dOff + dri;
                out[rowIndex] = (dNull[dBitIdx >>> 3] & (1 << (dBitIdx & 7))) ? dVals[dIndices[dri]] : null;
              }
            }
          } else {
            var srcUtf8Chunks = rowCount > 32 ? resolveArrowUtf8Chunks(srcCol) : null;
            if (srcUtf8Chunks && srcUtf8Chunks.length === 1 && rowCount >= (srcUtf8Chunks[0].length >>> 2)) {
              var decodedUtf8 = extractArrowUtf8Range(srcUtf8Chunks, 0, srcUtf8Chunks[0].length);
              if (decodedUtf8) {
                for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                  out[rowIndex] = decodedUtf8[rowIndexes[rowIndex]];
                }
              } else if (srcAcc) {
                for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                  out[rowIndex] = srcAcc(rowIndexes[rowIndex]);
                }
              } else {
                for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                  out[rowIndex] = getFieldValue(rowIndexes[rowIndex], field);
                }
              }
            } else if (srcAcc) {
              for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                out[rowIndex] = srcAcc(rowIndexes[rowIndex]);
              }
            } else {
              for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
                out[rowIndex] = getFieldValue(rowIndexes[rowIndex], field);
              }
            }
          }
        }
      } else if (!batchCount) {
        for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
          var row = data[rowIndexes[rowIndex]];
          out[rowIndex] = row ? row[field] : undefined;
        }
      } else {
        var cachedNum = typedCtor ? numericColumns[field] : null;
        if (cachedNum && cachedNum.length === n && !cachedNum.hasNaN && (isGuaranteedFiniteTypedArray(out) || isFloatTypedArray(out))) {
          var cachedVals = cachedNum.values;
          for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
            out[rowIndex] = cachedVals[rowIndexes[rowIndex]];
          }
        } else {
          var batchDirect = new Array(batchCount);
          var batchDict = new Array(batchCount);
          var batchAcc = new Array(batchCount);
          for (var bi = 0; bi < batchCount; ++bi) {
            var bCol = columnarBatches[bi].columns[field];
            if (ArrayBuffer.isView(bCol) || Array.isArray(bCol)) {
              batchDirect[bi] = bCol;
              batchDict[bi] = null;
              batchAcc[bi] = null;
            } else {
              batchDirect[bi] = null;
              var bDictChunks = rowCount > 32 ? resolveArrowDictionaryChunks(bCol) : null;
              if (bDictChunks && bDictChunks.length === 1 && bDictChunks[0].dictionary.length <= rowCount * 2) {
                var bdChunk = bDictChunks[0];
                var bdDict = bdChunk.dictionary;
                var bdLen = bdDict.length;
                var bdVals = new Array(bdLen);
                for (var bd = 0; bd < bdLen; ++bd) bdVals[bd] = bdDict.get(bd);
                batchDict[bi] = {
                  indices: bdChunk.values,
                  nullBitmap: bdChunk.nullCount > 0 ? bdChunk.nullBitmap : null,
                  offset: typeof bdChunk.offset === 'number' ? bdChunk.offset : 0,
                  vals: bdVals
                };
                batchAcc[bi] = null;
              } else {
                var bUtf8Chunks = rowCount > 32 ? resolveArrowUtf8Chunks(bCol) : null;
                if (bUtf8Chunks && bUtf8Chunks.length === 1 && rowCount >= (bUtf8Chunks[0].length >>> 2)) {
                  var bDecodedUtf8 = extractArrowUtf8Range(bUtf8Chunks, 0, bUtf8Chunks[0].length);
                  if (bDecodedUtf8) {
                    batchDirect[bi] = bDecodedUtf8;
                    batchDict[bi] = null;
                    batchAcc[bi] = null;
                    continue;
                  }
                }
                batchDict[bi] = null;
                batchAcc[bi] = (columnarBatches[bi].accessors && columnarBatches[bi].accessors[field]) || null;
              }
            }
          }
          var lastStart = -1;
          var lastEnd = -1;
          var lastDirect = null;
          var lastDict = null;
          var lastAcc = null;
          for (rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
            var ri = rowIndexes[rowIndex];
            if (ri < lastStart || ri >= lastEnd) {
              var bLo = 0, bHi = batchCount, found = -1;
              while (bLo < bHi) {
                var bMid = (bLo + bHi) >>> 1;
                if (ri < batchStarts[bMid]) bHi = bMid;
                else if (ri >= batchEnds[bMid]) bLo = bMid + 1;
                else { found = bMid; break; }
              }
              if (found >= 0) {
                lastStart = batchStarts[found];
                lastEnd = batchEnds[found];
                lastDirect = batchDirect[found];
                lastDict = batchDict[found];
                lastAcc = batchAcc[found];
              } else {
                lastStart = -1;
                lastEnd = -1;
                lastDirect = null;
                lastDict = null;
                lastAcc = null;
              }
            }
            if (lastDirect) {
              out[rowIndex] = lastDirect[ri - lastStart];
            } else if (lastDict) {
              var locIdx = ri - lastStart;
              if (!lastDict.nullBitmap) {
                out[rowIndex] = lastDict.vals[lastDict.indices[locIdx]];
              } else {
                var mbBit = lastDict.offset + locIdx;
                out[rowIndex] = (lastDict.nullBitmap[mbBit >>> 3] & (1 << (mbBit & 7)))
                  ? lastDict.vals[lastDict.indices[locIdx]]
                  : null;
              }
            } else if (lastAcc) {
              out[rowIndex] = lastAcc(ri - lastStart);
            } else {
              out[rowIndex] = getFieldValue(ri, field);
            }
          }
        }
      }

      columns[field] = out;
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

const version = "3.2.0";

crossfilter.version = version;

module.exports = crossfilter;
