// Falcon-style active-dimension prefix-sum brush cache.
// Supports both:
//   - 'discrete' mode (<= 2048 unique values): exact 0-boundary-row O(slots) prefix subtraction
//   - 'continuous' mode (> 2048 unique numeric values): exact 256-bin quantile splitters + CSR boundary rows

import {
  canPlanUseComplement,
  reduceGroupedIndexed,
  reduceMultiGroupsIndexed,
  reduceScalarIndexed
} from './columnar-reduce.js';

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

export function createFalconBrushCache(dimSource, baseRows, n, candidateInfos, kpiInfo, getNumericColumn) {
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
