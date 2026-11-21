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

export function createFilterBitsetStore() {
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
