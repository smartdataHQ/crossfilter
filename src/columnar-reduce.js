export var OP_COUNT = 0;
export var OP_SUM = 1;
export var OP_AVG = 2;
export var OP_AVG_NON_ZERO = 3;
export var OP_RATIO = 4;

export function compileMetricPlan(metricSpec) {
  var count = metricSpec.length;
  var ops = new Uint8Array(count);
  var ids = new Array(count);
  var fields = new Array(count);
  var denominators = new Array(count);
  var hidden = new Uint8Array(count);
  var primarySumSourceIdx = new Int32Array(count);
  var primarySumSourceSec = new Uint8Array(count);
  var denomSumSourceIdx = new Int32Array(count);
  var denomSumSourceSec = new Uint8Array(count);
  var avgCountSourceIdx = new Int32Array(count);
  var sumSourceByField = Object.create(null);
  var avgSourceByField = Object.create(null);
  var firstCountIndex = -1;
  var fusedSumIndex = -1;
  var firstAvgIndex = -1;
  var i, metric, op, field, denom, src;

  primarySumSourceIdx.fill(-1);
  denomSumSourceIdx.fill(-1);
  avgCountSourceIdx.fill(-1);

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
        break;
      case 'sum':
        op = OP_SUM;
        if (field) {
          src = sumSourceByField[field];
          if (src) {
            primarySumSourceIdx[i] = src.idx;
            primarySumSourceSec[i] = src.sec;
          } else {
            sumSourceByField[field] = { idx: i, sec: 0 };
            if (fusedSumIndex < 0) fusedSumIndex = i;
          }
        }
        break;
      case 'avg':
        op = OP_AVG;
        if (field) {
          src = sumSourceByField[field];
          if (src) {
            primarySumSourceIdx[i] = src.idx;
            primarySumSourceSec[i] = src.sec;
          } else {
            sumSourceByField[field] = { idx: i, sec: 0 };
            if (firstAvgIndex < 0) firstAvgIndex = i;
          }
          if (avgSourceByField[field] !== undefined) {
            avgCountSourceIdx[i] = avgSourceByField[field];
          } else {
            avgSourceByField[field] = i;
          }
        }
        break;
      case 'avgNonZero':
        op = OP_AVG_NON_ZERO;
        break;
      case 'ratio':
        op = OP_RATIO;
        if (field) {
          src = sumSourceByField[field];
          if (src) {
            primarySumSourceIdx[i] = src.idx;
            primarySumSourceSec[i] = src.sec;
          } else {
            sumSourceByField[field] = { idx: i, sec: 0 };
          }
        }
        if (denom) {
          src = sumSourceByField[denom];
          if (src && src.idx < i) {
            denomSumSourceIdx[i] = src.idx;
            denomSumSourceSec[i] = src.sec;
          } else if (!src) {
            sumSourceByField[denom] = { idx: i, sec: 1 };
          }
        }
        break;
      default:
        op = OP_COUNT;
    }
    ops[i] = op;
  }

  return {
    avgCountSourceIdx: avgCountSourceIdx,
    count: count,
    denomSumSourceIdx: denomSumSourceIdx,
    denomSumSourceSec: denomSumSourceSec,
    denominators: denominators,
    fields: fields,
    firstCountIndex: firstCountIndex,
    fusedAvgIndex: firstCountIndex >= 0 && fusedSumIndex < 0 ? firstAvgIndex : -1,
    fusedSumIndex: firstCountIndex >= 0 ? fusedSumIndex : -1,
    hidden: hidden,
    ids: ids,
    ops: ops,
    primarySumSourceIdx: primarySumSourceIdx,
    primarySumSourceSec: primarySumSourceSec,
    spec: metricSpec
  };
}

export function ensureMetricBuffers(buffers, plan, required, preserve) {
  var count = plan.count;
  var ops = plan.ops;
  var i, nextCap, nextPrimary, nextSecondary, copyLen;

  if (buffers && buffers.capacity >= required) {
    return buffers;
  }

  if (buffers && buffers.capacity > 0) {
    nextCap = buffers.capacity;
    while (nextCap < required) {
      nextCap = nextCap < 65536 ? nextCap * 2 : required;
    }
  } else {
    nextCap = required < 64 ? 64 : required;
  }

  var primary = new Array(count);
  var secondary = new Array(count);
  copyLen = preserve && buffers ? buffers.capacity : 0;

  for (i = 0; i < count; ++i) {
    nextPrimary = new Float64Array(nextCap);
    if (copyLen > 0) {
      nextPrimary.set(buffers.primary[i].subarray(0, copyLen));
    }
    primary[i] = nextPrimary;

    if (ops[i] === OP_AVG || ops[i] === OP_AVG_NON_ZERO || ops[i] === OP_RATIO) {
      nextSecondary = new Float64Array(nextCap);
      if (copyLen > 0) {
        nextSecondary.set(buffers.secondary[i].subarray(0, copyLen));
      }
      secondary[i] = nextSecondary;
    } else {
      secondary[i] = null;
    }
  }

  return {
    capacity: nextCap,
    primary: primary,
    secondary: secondary
  };
}

export function zeroMetricBuffers(buffers, slotCount) {
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var i;
  for (i = 0; i < primary.length; ++i) {
    primary[i].fill(0, 0, slotCount);
    if (secondary[i]) {
      secondary[i].fill(0, 0, slotCount);
    }
  }
}

// ============================================================================
// Grouped-All leaf kernels (small functions for immediate V8 JIT compilation)
// ============================================================================

function gCountAll(acc, groupIds, n) {
  for (var i = 0; i < n; ++i) acc[groupIds[i]] += 1;
}

function gCountSumAll(cntAcc, sumAcc, groupIds, vals, hasNaN, n) {
  var i, g, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) {
      g = groupIds[i];
      cntAcc[g] += 1;
      sumAcc[g] += vals[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      g = groupIds[i];
      cntAcc[g] += 1;
      v = vals[i];
      if (v === v) sumAcc[g] += v;
    }
  }
}

function gSumAll(acc, groupIds, vals, hasNaN, n) {
  var i, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) acc[groupIds[i]] += vals[i];
  } else {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v === v) acc[groupIds[i]] += v;
    }
  }
}

function gValidCountAll(acc, groupIds, vals, n) {
  var i, v;
  for (i = 0; i < n; ++i) {
    v = vals[i];
    if (v === v) acc[groupIds[i]] += 1;
  }
}

function gAvgAll(acc, acc2, groupIds, vals, hasNaN, n) {
  var i, g, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) {
      g = groupIds[i];
      acc[g] += vals[i];
      acc2[g] += 1;
    }
  } else {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v === v) {
        g = groupIds[i];
        acc[g] += v;
        acc2[g] += 1;
      }
    }
  }
}

function gAvgNzAll(acc, acc2, groupIds, vals, hasNaN, n) {
  var i, g, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v !== 0) {
        g = groupIds[i];
        acc[g] += v;
        acc2[g] += 1;
      }
    }
  } else {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v === v && v !== 0) {
        g = groupIds[i];
        acc[g] += v;
        acc2[g] += 1;
      }
    }
  }
}

function gRatioAll(acc, acc2, groupIds, vals, hasNaN, vals2, hasNaN2, n) {
  var i, g, v, v2;
  if (!hasNaN && !hasNaN2) {
    for (i = 0; i < n; ++i) {
      g = groupIds[i];
      acc[g] += vals[i];
      acc2[g] += vals2[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      g = groupIds[i];
      v = vals[i];
      if (v === v) acc[g] += v;
      v2 = vals2[i];
      if (v2 === v2) acc2[g] += v2;
    }
  }
}

// ============================================================================
// Grouped-Indexed leaf kernels
// ============================================================================

function gCountIdx(acc, groupIds, rowIndexes, rowCount, add) {
  var j;
  if (add) {
    for (j = 0; j < rowCount; ++j) acc[groupIds[rowIndexes[j]]] += 1;
  } else {
    for (j = 0; j < rowCount; ++j) acc[groupIds[rowIndexes[j]]] -= 1;
  }
}

function gCountSumIdx(cntAcc, sumAcc, groupIds, vals, hasNaN, rowIndexes, rowCount, add) {
  var j, idx, g, v;
  if (add) {
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        g = groupIds[idx];
        cntAcc[g] += 1;
        sumAcc[g] += vals[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        g = groupIds[idx];
        cntAcc[g] += 1;
        v = vals[idx];
        if (v === v) sumAcc[g] += v;
      }
    }
  } else if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      g = groupIds[idx];
      cntAcc[g] -= 1;
      sumAcc[g] -= vals[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      g = groupIds[idx];
      cntAcc[g] -= 1;
      v = vals[idx];
      if (v === v) sumAcc[g] -= v;
    }
  }
}

function gSumIdx(acc, groupIds, vals, hasNaN, rowIndexes, rowCount, add) {
  var j, idx, v;
  if (add) {
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        acc[groupIds[idx]] += vals[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v) acc[groupIds[idx]] += v;
      }
    }
  } else if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      acc[groupIds[idx]] -= vals[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      v = vals[idx];
      if (v === v) acc[groupIds[idx]] -= v;
    }
  }
}

function gValidCountIdx(acc, groupIds, vals, rowIndexes, rowCount) {
  var j, idx, v;
  for (j = 0; j < rowCount; ++j) {
    idx = rowIndexes[j];
    v = vals[idx];
    if (v === v) acc[groupIds[idx]] += 1;
  }
}

function gAvgIdx(acc, acc2, groupIds, vals, hasNaN, rowIndexes, rowCount, add) {
  var j, idx, g, v;
  if (add) {
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        g = groupIds[idx];
        acc[g] += vals[idx];
        acc2[g] += 1;
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v) {
          g = groupIds[idx];
          acc[g] += v;
          acc2[g] += 1;
        }
      }
    }
  } else if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      g = groupIds[idx];
      acc[g] -= vals[idx];
      acc2[g] -= 1;
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      v = vals[idx];
      if (v === v) {
        g = groupIds[idx];
        acc[g] -= v;
        acc2[g] -= 1;
      }
    }
  }
}

function gAvgNzIdx(acc, acc2, groupIds, vals, hasNaN, rowIndexes, rowCount, add) {
  var j, idx, g, v;
  if (add) {
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v !== 0) {
          g = groupIds[idx];
          acc[g] += v;
          acc2[g] += 1;
        }
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v && v !== 0) {
          g = groupIds[idx];
          acc[g] += v;
          acc2[g] += 1;
        }
      }
    }
  } else if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      v = vals[idx];
      if (v !== 0) {
        g = groupIds[idx];
        acc[g] -= v;
        acc2[g] -= 1;
      }
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      v = vals[idx];
      if (v === v && v !== 0) {
        g = groupIds[idx];
        acc[g] -= v;
        acc2[g] -= 1;
      }
    }
  }
}

function gRatioIdx(acc, acc2, groupIds, vals, hasNaN, vals2, hasNaN2, rowIndexes, rowCount, add) {
  var j, idx, g, v, v2;
  if (add) {
    if (!hasNaN && !hasNaN2) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        g = groupIds[idx];
        acc[g] += vals[idx];
        acc2[g] += vals2[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        g = groupIds[idx];
        v = vals[idx];
        if (v === v) acc[g] += v;
        v2 = vals2[idx];
        if (v2 === v2) acc2[g] += v2;
      }
    }
  } else if (!hasNaN && !hasNaN2) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      g = groupIds[idx];
      acc[g] -= vals[idx];
      acc2[g] -= vals2[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      g = groupIds[idx];
      v = vals[idx];
      if (v === v) acc[g] -= v;
      v2 = vals2[idx];
      if (v2 === v2) acc2[g] -= v2;
    }
  }
}

// ============================================================================
// Split-Dense-All leaf kernels
// ============================================================================

function sCountAll(acc, groupIds, splitCodes, stride, n) {
  for (var i = 0; i < n; ++i) acc[groupIds[i] * stride + splitCodes[i]] += 1;
}

function sCountSumAll(cntAcc, sumAcc, groupIds, splitCodes, stride, vals, hasNaN, n) {
  var i, cell, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) {
      cell = groupIds[i] * stride + splitCodes[i];
      cntAcc[cell] += 1;
      sumAcc[cell] += vals[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      cell = groupIds[i] * stride + splitCodes[i];
      cntAcc[cell] += 1;
      v = vals[i];
      if (v === v) sumAcc[cell] += v;
    }
  }
}

function sSumAll(acc, groupIds, splitCodes, stride, vals, hasNaN, n) {
  var i, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) acc[groupIds[i] * stride + splitCodes[i]] += vals[i];
  } else {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v === v) acc[groupIds[i] * stride + splitCodes[i]] += v;
    }
  }
}

function sValidCountAll(acc, groupIds, splitCodes, stride, vals, n) {
  var i, v;
  for (i = 0; i < n; ++i) {
    v = vals[i];
    if (v === v) acc[groupIds[i] * stride + splitCodes[i]] += 1;
  }
}

function sAvgAll(acc, acc2, groupIds, splitCodes, stride, vals, hasNaN, n) {
  var i, cell, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) {
      cell = groupIds[i] * stride + splitCodes[i];
      acc[cell] += vals[i];
      acc2[cell] += 1;
    }
  } else {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v === v) {
        cell = groupIds[i] * stride + splitCodes[i];
        acc[cell] += v;
        acc2[cell] += 1;
      }
    }
  }
}

function sAvgNzAll(acc, acc2, groupIds, splitCodes, stride, vals, hasNaN, n) {
  var i, cell, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v !== 0) {
        cell = groupIds[i] * stride + splitCodes[i];
        acc[cell] += v;
        acc2[cell] += 1;
      }
    }
  } else {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v === v && v !== 0) {
        cell = groupIds[i] * stride + splitCodes[i];
        acc[cell] += v;
        acc2[cell] += 1;
      }
    }
  }
}

function sRatioAll(acc, acc2, groupIds, splitCodes, stride, vals, hasNaN, vals2, hasNaN2, n) {
  var i, cell, v, v2;
  if (!hasNaN && !hasNaN2) {
    for (i = 0; i < n; ++i) {
      cell = groupIds[i] * stride + splitCodes[i];
      acc[cell] += vals[i];
      acc2[cell] += vals2[i];
    }
  } else {
    for (i = 0; i < n; ++i) {
      cell = groupIds[i] * stride + splitCodes[i];
      v = vals[i];
      if (v === v) acc[cell] += v;
      v2 = vals2[i];
      if (v2 === v2) acc2[cell] += v2;
    }
  }
}

// ============================================================================
// Split-Dense-Indexed leaf kernels
// ============================================================================

function sCountIdx(acc, groupIds, splitCodes, stride, rowIndexes, rowCount, add) {
  var j, idx;
  if (add) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      acc[groupIds[idx] * stride + splitCodes[idx]] += 1;
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      acc[groupIds[idx] * stride + splitCodes[idx]] -= 1;
    }
  }
}

function sCountSumIdx(cntAcc, sumAcc, groupIds, splitCodes, stride, vals, hasNaN, rowIndexes, rowCount, add) {
  var j, idx, cell, v;
  if (add) {
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        cell = groupIds[idx] * stride + splitCodes[idx];
        cntAcc[cell] += 1;
        sumAcc[cell] += vals[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        cell = groupIds[idx] * stride + splitCodes[idx];
        cntAcc[cell] += 1;
        v = vals[idx];
        if (v === v) sumAcc[cell] += v;
      }
    }
  } else if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      cell = groupIds[idx] * stride + splitCodes[idx];
      cntAcc[cell] -= 1;
      sumAcc[cell] -= vals[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      cell = groupIds[idx] * stride + splitCodes[idx];
      cntAcc[cell] -= 1;
      v = vals[idx];
      if (v === v) sumAcc[cell] -= v;
    }
  }
}

function sSumIdx(acc, groupIds, splitCodes, stride, vals, hasNaN, rowIndexes, rowCount, add) {
  var j, idx, v;
  if (add) {
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        acc[groupIds[idx] * stride + splitCodes[idx]] += vals[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v) acc[groupIds[idx] * stride + splitCodes[idx]] += v;
      }
    }
  } else if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      acc[groupIds[idx] * stride + splitCodes[idx]] -= vals[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      v = vals[idx];
      if (v === v) acc[groupIds[idx] * stride + splitCodes[idx]] -= v;
    }
  }
}

function sValidCountIdx(acc, groupIds, splitCodes, stride, vals, rowIndexes, rowCount) {
  var j, idx, v;
  for (j = 0; j < rowCount; ++j) {
    idx = rowIndexes[j];
    v = vals[idx];
    if (v === v) acc[groupIds[idx] * stride + splitCodes[idx]] += 1;
  }
}

function sAvgIdx(acc, acc2, groupIds, splitCodes, stride, vals, hasNaN, rowIndexes, rowCount, add) {
  var j, idx, cell, v;
  if (add) {
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        cell = groupIds[idx] * stride + splitCodes[idx];
        acc[cell] += vals[idx];
        acc2[cell] += 1;
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v) {
          cell = groupIds[idx] * stride + splitCodes[idx];
          acc[cell] += v;
          acc2[cell] += 1;
        }
      }
    }
  } else if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      cell = groupIds[idx] * stride + splitCodes[idx];
      acc[cell] -= vals[idx];
      acc2[cell] -= 1;
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      v = vals[idx];
      if (v === v) {
        cell = groupIds[idx] * stride + splitCodes[idx];
        acc[cell] -= v;
        acc2[cell] -= 1;
      }
    }
  }
}

function sAvgNzIdx(acc, acc2, groupIds, splitCodes, stride, vals, hasNaN, rowIndexes, rowCount, add) {
  var j, idx, cell, v;
  if (add) {
    if (!hasNaN) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v !== 0) {
          cell = groupIds[idx] * stride + splitCodes[idx];
          acc[cell] += v;
          acc2[cell] += 1;
        }
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        v = vals[idx];
        if (v === v && v !== 0) {
          cell = groupIds[idx] * stride + splitCodes[idx];
          acc[cell] += v;
          acc2[cell] += 1;
        }
      }
    }
  } else if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      v = vals[idx];
      if (v !== 0) {
        cell = groupIds[idx] * stride + splitCodes[idx];
        acc[cell] -= v;
        acc2[cell] -= 1;
      }
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      v = vals[idx];
      if (v === v && v !== 0) {
        cell = groupIds[idx] * stride + splitCodes[idx];
        acc[cell] -= v;
        acc2[cell] -= 1;
      }
    }
  }
}

function sRatioIdx(acc, acc2, groupIds, splitCodes, stride, vals, hasNaN, vals2, hasNaN2, rowIndexes, rowCount, add) {
  var j, idx, cell, v, v2;
  if (add) {
    if (!hasNaN && !hasNaN2) {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        cell = groupIds[idx] * stride + splitCodes[idx];
        acc[cell] += vals[idx];
        acc2[cell] += vals2[idx];
      }
    } else {
      for (j = 0; j < rowCount; ++j) {
        idx = rowIndexes[j];
        cell = groupIds[idx] * stride + splitCodes[idx];
        v = vals[idx];
        if (v === v) acc[cell] += v;
        v2 = vals2[idx];
        if (v2 === v2) acc2[cell] += v2;
      }
    }
  } else if (!hasNaN && !hasNaN2) {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      cell = groupIds[idx] * stride + splitCodes[idx];
      acc[cell] -= vals[idx];
      acc2[cell] -= vals2[idx];
    }
  } else {
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      cell = groupIds[idx] * stride + splitCodes[idx];
      v = vals[idx];
      if (v === v) acc[cell] -= v;
      v2 = vals2[idx];
      if (v2 === v2) acc2[cell] -= v2;
    }
  }
}

// ============================================================================
// Scalar leaf kernels
// ============================================================================

function scSumAll(vals, hasNaN, n) {
  var s = 0, i, v;
  if (!hasNaN) {
    for (i = 0; i < n; ++i) s += vals[i];
  } else {
    for (i = 0; i < n; ++i) {
      v = vals[i];
      if (v === v) s += v;
    }
  }
  return s;
}

function scValidCountAll(vals, n) {
  var c = 0, i, v;
  for (i = 0; i < n; ++i) {
    v = vals[i];
    if (v === v) c += 1;
  }
  return c;
}

function scSumIdx(vals, hasNaN, rowIndexes, rowCount) {
  var s = 0, j, v;
  if (!hasNaN) {
    for (j = 0; j < rowCount; ++j) s += vals[rowIndexes[j]];
  } else {
    for (j = 0; j < rowCount; ++j) {
      v = vals[rowIndexes[j]];
      if (v === v) s += v;
    }
  }
  return s;
}

function scValidCountIdx(vals, rowIndexes, rowCount) {
  var c = 0, j, v;
  for (j = 0; j < rowCount; ++j) {
    v = vals[rowIndexes[j]];
    if (v === v) c += 1;
  }
  return c;
}

// ============================================================================
// Orchestrators
// ============================================================================

export function reduceGroupedAll(buffers, plan, getNumericColumn, groupIds, n, slotCount) {
  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primarySumSourceIdx = plan.primarySumSourceIdx;
  var primarySumSourceSec = plan.primarySumSourceSec;
  var denomSumSourceIdx = plan.denomSumSourceIdx;
  var denomSumSourceSec = plan.denomSumSourceSec;
  var avgCountSourceIdx = plan.avgCountSourceIdx;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var firstCountIndex = plan.firstCountIndex;
  var fusedSumIndex = plan.fusedSumIndex;
  var fusedAvgIndex = plan.fusedAvgIndex;
  var ranFusedAvg = false;
  var countComputed = false;
  var pendingAcc = null;
  var pendingCol = null;
  var pendingIdx = -1;
  var m, op, acc, acc2, col, col2, srcIdx, denomIdx, srcBuf;

  if (firstCountIndex >= 0) {
    if (fusedSumIndex >= 0) {
      col = getNumericColumn(fields[fusedSumIndex]);
      gCountSumAll(primary[firstCountIndex], primary[fusedSumIndex], groupIds, col.values, col.hasNaN, n);
    } else if (fusedAvgIndex >= 0) {
      col = getNumericColumn(fields[fusedAvgIndex]);
      if (!col.hasNaN) {
        gCountSumAll(primary[firstCountIndex], primary[fusedAvgIndex], groupIds, col.values, false, n);
        secondary[fusedAvgIndex].set(primary[firstCountIndex].subarray(0, slotCount));
        ranFusedAvg = true;
      } else {
        gCountAll(primary[firstCountIndex], groupIds, n);
      }
    } else {
      gCountAll(primary[firstCountIndex], groupIds, n);
    }
    countComputed = true;
  }

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    acc = primary[m];

    if (op === OP_COUNT) {
      if (m === firstCountIndex) continue;
      if (countComputed) {
        acc.set(primary[firstCountIndex].subarray(0, slotCount));
      } else {
        gCountAll(acc, groupIds, n);
      }
      continue;
    }

    if (m === fusedSumIndex || (ranFusedAvg && m === fusedAvgIndex)) continue;

    srcIdx = primarySumSourceIdx[m];
    if (pendingAcc && (srcIdx === pendingIdx || denomSumSourceIdx[m] === pendingIdx)) {
      gSumAll(pendingAcc, groupIds, pendingCol.values, pendingCol.hasNaN, n);
      pendingAcc = null;
      pendingCol = null;
      pendingIdx = -1;
    }

    if (op === OP_SUM) {
      if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, slotCount));
      } else {
        col = getNumericColumn(fields[m]);
        if (pendingAcc) {
          gRatioAll(pendingAcc, acc, groupIds, pendingCol.values, pendingCol.hasNaN, col.values, col.hasNaN, n);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      }
    } else if (op === OP_AVG) {
      acc2 = secondary[m];
      col = getNumericColumn(fields[m]);
      if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, slotCount));
        if (!col.hasNaN && countComputed) {
          acc2.set(primary[firstCountIndex].subarray(0, slotCount));
        } else if (avgCountSourceIdx[m] >= 0) {
          acc2.set(secondary[avgCountSourceIdx[m]].subarray(0, slotCount));
        } else if (!col.hasNaN) {
          gCountAll(acc2, groupIds, n);
        } else {
          gValidCountAll(acc2, groupIds, col.values, n);
        }
      } else if (!col.hasNaN && countComputed) {
        acc2.set(primary[firstCountIndex].subarray(0, slotCount));
        if (pendingAcc) {
          gRatioAll(pendingAcc, acc, groupIds, pendingCol.values, pendingCol.hasNaN, col.values, false, n);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      } else {
        gAvgAll(acc, acc2, groupIds, col.values, col.hasNaN, n);
      }
    } else if (op === OP_AVG_NON_ZERO) {
      col = getNumericColumn(fields[m]);
      gAvgNzAll(acc, secondary[m], groupIds, col.values, col.hasNaN, n);
    } else if (op === OP_RATIO) {
      acc2 = secondary[m];
      denomIdx = denomSumSourceIdx[m];
      if (srcIdx >= 0 && denomIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, slotCount));
        srcBuf = denomSumSourceSec[m] ? secondary[denomIdx] : primary[denomIdx];
        acc2.set(srcBuf.subarray(0, slotCount));
      } else if (denomIdx >= 0) {
        srcBuf = denomSumSourceSec[m] ? secondary[denomIdx] : primary[denomIdx];
        acc2.set(srcBuf.subarray(0, slotCount));
        col = getNumericColumn(fields[m]);
        if (pendingAcc) {
          gRatioAll(pendingAcc, acc, groupIds, pendingCol.values, pendingCol.hasNaN, col.values, col.hasNaN, n);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      } else if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, slotCount));
        col2 = getNumericColumn(denominators[m]);
        if (pendingAcc) {
          gRatioAll(pendingAcc, acc2, groupIds, pendingCol.values, pendingCol.hasNaN, col2.values, col2.hasNaN, n);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc2;
          pendingCol = col2;
          pendingIdx = m;
        }
      } else {
        col = getNumericColumn(fields[m]);
        col2 = getNumericColumn(denominators[m]);
        gRatioAll(acc, acc2, groupIds, col.values, col.hasNaN, col2.values, col2.hasNaN, n);
      }
    }
  }

  if (pendingAcc) {
    gSumAll(pendingAcc, groupIds, pendingCol.values, pendingCol.hasNaN, n);
  }
}

export function reduceGroupedIndexed(buffers, plan, getNumericColumn, groupIds, rowIndexes, rowCount, delta, slotCount) {
  if (!rowCount) return;

  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primarySumSourceIdx = plan.primarySumSourceIdx;
  var primarySumSourceSec = plan.primarySumSourceSec;
  var denomSumSourceIdx = plan.denomSumSourceIdx;
  var denomSumSourceSec = plan.denomSumSourceSec;
  var avgCountSourceIdx = plan.avgCountSourceIdx;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var firstCountIndex = plan.firstCountIndex;
  var fusedSumIndex = plan.fusedSumIndex;
  var fusedAvgIndex = plan.fusedAvgIndex;
  var add = delta > 0;
  var isReset = add && slotCount > 0;
  var canShareCount = isReset && firstCountIndex >= 0;
  var ranFused = false;
  var ranFusedAvg = false;
  var pendingAcc = null;
  var pendingCol = null;
  var pendingIdx = -1;
  var m, op, acc, acc2, col, col2, srcIdx, denomIdx, srcBuf;

  if (firstCountIndex >= 0 && fusedSumIndex >= 0) {
    col = getNumericColumn(fields[fusedSumIndex]);
    gCountSumIdx(primary[firstCountIndex], primary[fusedSumIndex], groupIds, col.values, col.hasNaN, rowIndexes, rowCount, add);
    ranFused = true;
  } else if (canShareCount) {
    if (fusedAvgIndex >= 0) {
      col = getNumericColumn(fields[fusedAvgIndex]);
      if (!col.hasNaN) {
        gCountSumIdx(primary[firstCountIndex], primary[fusedAvgIndex], groupIds, col.values, false, rowIndexes, rowCount, true);
        secondary[fusedAvgIndex].set(primary[firstCountIndex].subarray(0, slotCount));
        ranFusedAvg = true;
      } else {
        gCountIdx(primary[firstCountIndex], groupIds, rowIndexes, rowCount, true);
      }
    } else {
      gCountIdx(primary[firstCountIndex], groupIds, rowIndexes, rowCount, true);
    }
  }

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    acc = primary[m];

    if (op === OP_COUNT) {
      if (m === firstCountIndex && (ranFused || canShareCount)) continue;
      if (canShareCount) {
        acc.set(primary[firstCountIndex].subarray(0, slotCount));
      } else {
        gCountIdx(acc, groupIds, rowIndexes, rowCount, add);
      }
      continue;
    }

    if ((ranFused && m === fusedSumIndex) || (ranFusedAvg && m === fusedAvgIndex)) continue;

    srcIdx = isReset ? primarySumSourceIdx[m] : -1;
    denomIdx = isReset ? denomSumSourceIdx[m] : -1;
    if (pendingAcc && (srcIdx === pendingIdx || denomIdx === pendingIdx)) {
      gSumIdx(pendingAcc, groupIds, pendingCol.values, pendingCol.hasNaN, rowIndexes, rowCount, add);
      pendingAcc = null;
      pendingCol = null;
      pendingIdx = -1;
    }

    if (op === OP_SUM) {
      if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, slotCount));
      } else {
        col = getNumericColumn(fields[m]);
        if (pendingAcc) {
          gRatioIdx(pendingAcc, acc, groupIds, pendingCol.values, pendingCol.hasNaN, col.values, col.hasNaN, rowIndexes, rowCount, add);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      }
    } else if (op === OP_AVG) {
      acc2 = secondary[m];
      col = getNumericColumn(fields[m]);
      if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, slotCount));
        if (!col.hasNaN && canShareCount) {
          acc2.set(primary[firstCountIndex].subarray(0, slotCount));
        } else if (avgCountSourceIdx[m] >= 0) {
          acc2.set(secondary[avgCountSourceIdx[m]].subarray(0, slotCount));
        } else if (!col.hasNaN) {
          gCountIdx(acc2, groupIds, rowIndexes, rowCount, true);
        } else {
          gValidCountIdx(acc2, groupIds, col.values, rowIndexes, rowCount);
        }
      } else if (add && !col.hasNaN && canShareCount) {
        acc2.set(primary[firstCountIndex].subarray(0, slotCount));
        if (pendingAcc) {
          gRatioIdx(pendingAcc, acc, groupIds, pendingCol.values, pendingCol.hasNaN, col.values, false, rowIndexes, rowCount, true);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      } else {
        gAvgIdx(acc, acc2, groupIds, col.values, col.hasNaN, rowIndexes, rowCount, add);
      }
    } else if (op === OP_AVG_NON_ZERO) {
      col = getNumericColumn(fields[m]);
      gAvgNzIdx(acc, secondary[m], groupIds, col.values, col.hasNaN, rowIndexes, rowCount, add);
    } else if (op === OP_RATIO) {
      acc2 = secondary[m];
      if (srcIdx >= 0 && denomIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, slotCount));
        srcBuf = denomSumSourceSec[m] ? secondary[denomIdx] : primary[denomIdx];
        acc2.set(srcBuf.subarray(0, slotCount));
      } else if (denomIdx >= 0) {
        srcBuf = denomSumSourceSec[m] ? secondary[denomIdx] : primary[denomIdx];
        acc2.set(srcBuf.subarray(0, slotCount));
        col = getNumericColumn(fields[m]);
        if (pendingAcc) {
          gRatioIdx(pendingAcc, acc, groupIds, pendingCol.values, pendingCol.hasNaN, col.values, col.hasNaN, rowIndexes, rowCount, true);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      } else if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, slotCount));
        col2 = getNumericColumn(denominators[m]);
        if (pendingAcc) {
          gRatioIdx(pendingAcc, acc2, groupIds, pendingCol.values, pendingCol.hasNaN, col2.values, col2.hasNaN, rowIndexes, rowCount, true);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc2;
          pendingCol = col2;
          pendingIdx = m;
        }
      } else {
        col = getNumericColumn(fields[m]);
        col2 = getNumericColumn(denominators[m]);
        gRatioIdx(acc, acc2, groupIds, col.values, col.hasNaN, col2.values, col2.hasNaN, rowIndexes, rowCount, add);
      }
    }
  }

  if (pendingAcc) {
    gSumIdx(pendingAcc, groupIds, pendingCol.values, pendingCol.hasNaN, rowIndexes, rowCount, add);
  }
}

export function reduceSplitDenseAll(buffers, plan, getNumericColumn, groupIds, splitCodes, stride, n, totalCells) {
  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primarySumSourceIdx = plan.primarySumSourceIdx;
  var primarySumSourceSec = plan.primarySumSourceSec;
  var denomSumSourceIdx = plan.denomSumSourceIdx;
  var denomSumSourceSec = plan.denomSumSourceSec;
  var avgCountSourceIdx = plan.avgCountSourceIdx;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var firstCountIndex = plan.firstCountIndex;
  var fusedSumIndex = plan.fusedSumIndex;
  var fusedAvgIndex = plan.fusedAvgIndex;
  var ranFusedAvg = false;
  var countComputed = false;
  var pendingAcc = null;
  var pendingCol = null;
  var pendingIdx = -1;
  var m, op, acc, acc2, col, col2, srcIdx, denomIdx, srcBuf;

  if (firstCountIndex >= 0) {
    if (fusedSumIndex >= 0) {
      col = getNumericColumn(fields[fusedSumIndex]);
      sCountSumAll(primary[firstCountIndex], primary[fusedSumIndex], groupIds, splitCodes, stride, col.values, col.hasNaN, n);
    } else if (fusedAvgIndex >= 0) {
      col = getNumericColumn(fields[fusedAvgIndex]);
      if (!col.hasNaN) {
        sCountSumAll(primary[firstCountIndex], primary[fusedAvgIndex], groupIds, splitCodes, stride, col.values, false, n);
        secondary[fusedAvgIndex].set(primary[firstCountIndex].subarray(0, totalCells));
        ranFusedAvg = true;
      } else {
        sCountAll(primary[firstCountIndex], groupIds, splitCodes, stride, n);
      }
    } else {
      sCountAll(primary[firstCountIndex], groupIds, splitCodes, stride, n);
    }
    countComputed = true;
  }

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    acc = primary[m];

    if (op === OP_COUNT) {
      if (m === firstCountIndex) continue;
      if (countComputed) {
        acc.set(primary[firstCountIndex].subarray(0, totalCells));
      } else {
        sCountAll(acc, groupIds, splitCodes, stride, n);
      }
      continue;
    }

    if (m === fusedSumIndex || (ranFusedAvg && m === fusedAvgIndex)) continue;

    srcIdx = primarySumSourceIdx[m];
    if (pendingAcc && (srcIdx === pendingIdx || denomSumSourceIdx[m] === pendingIdx)) {
      sSumAll(pendingAcc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, n);
      pendingAcc = null;
      pendingCol = null;
      pendingIdx = -1;
    }

    if (op === OP_SUM) {
      if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, totalCells));
      } else {
        col = getNumericColumn(fields[m]);
        if (pendingAcc) {
          sRatioAll(pendingAcc, acc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, col.values, col.hasNaN, n);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      }
    } else if (op === OP_AVG) {
      acc2 = secondary[m];
      col = getNumericColumn(fields[m]);
      if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, totalCells));
        if (!col.hasNaN && countComputed) {
          acc2.set(primary[firstCountIndex].subarray(0, totalCells));
        } else if (avgCountSourceIdx[m] >= 0) {
          acc2.set(secondary[avgCountSourceIdx[m]].subarray(0, totalCells));
        } else if (!col.hasNaN) {
          sCountAll(acc2, groupIds, splitCodes, stride, n);
        } else {
          sValidCountAll(acc2, groupIds, splitCodes, stride, col.values, n);
        }
      } else if (!col.hasNaN && countComputed) {
        acc2.set(primary[firstCountIndex].subarray(0, totalCells));
        if (pendingAcc) {
          sRatioAll(pendingAcc, acc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, col.values, false, n);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      } else {
        sAvgAll(acc, acc2, groupIds, splitCodes, stride, col.values, col.hasNaN, n);
      }
    } else if (op === OP_AVG_NON_ZERO) {
      col = getNumericColumn(fields[m]);
      sAvgNzAll(acc, secondary[m], groupIds, splitCodes, stride, col.values, col.hasNaN, n);
    } else if (op === OP_RATIO) {
      acc2 = secondary[m];
      denomIdx = denomSumSourceIdx[m];
      if (srcIdx >= 0 && denomIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, totalCells));
        srcBuf = denomSumSourceSec[m] ? secondary[denomIdx] : primary[denomIdx];
        acc2.set(srcBuf.subarray(0, totalCells));
      } else if (denomIdx >= 0) {
        srcBuf = denomSumSourceSec[m] ? secondary[denomIdx] : primary[denomIdx];
        acc2.set(srcBuf.subarray(0, totalCells));
        col = getNumericColumn(fields[m]);
        if (pendingAcc) {
          sRatioAll(pendingAcc, acc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, col.values, col.hasNaN, n);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      } else if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, totalCells));
        col2 = getNumericColumn(denominators[m]);
        if (pendingAcc) {
          sRatioAll(pendingAcc, acc2, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, col2.values, col2.hasNaN, n);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc2;
          pendingCol = col2;
          pendingIdx = m;
        }
      } else {
        col = getNumericColumn(fields[m]);
        col2 = getNumericColumn(denominators[m]);
        sRatioAll(acc, acc2, groupIds, splitCodes, stride, col.values, col.hasNaN, col2.values, col2.hasNaN, n);
      }
    }
  }

  if (pendingAcc) {
    sSumAll(pendingAcc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, n);
  }
}

export function reduceSplitDenseIndexed(buffers, plan, getNumericColumn, groupIds, splitCodes, stride, rowIndexes, rowCount, delta, totalCells) {
  if (!rowCount) return;

  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primarySumSourceIdx = plan.primarySumSourceIdx;
  var primarySumSourceSec = plan.primarySumSourceSec;
  var denomSumSourceIdx = plan.denomSumSourceIdx;
  var denomSumSourceSec = plan.denomSumSourceSec;
  var avgCountSourceIdx = plan.avgCountSourceIdx;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var firstCountIndex = plan.firstCountIndex;
  var fusedSumIndex = plan.fusedSumIndex;
  var fusedAvgIndex = plan.fusedAvgIndex;
  var add = delta > 0;
  var isReset = add && totalCells > 0;
  var canShareCount = isReset && firstCountIndex >= 0;
  var ranFused = false;
  var ranFusedAvg = false;
  var pendingAcc = null;
  var pendingCol = null;
  var pendingIdx = -1;
  var m, op, acc, acc2, col, col2, srcIdx, denomIdx, srcBuf;

  if (firstCountIndex >= 0 && fusedSumIndex >= 0) {
    col = getNumericColumn(fields[fusedSumIndex]);
    sCountSumIdx(primary[firstCountIndex], primary[fusedSumIndex], groupIds, splitCodes, stride, col.values, col.hasNaN, rowIndexes, rowCount, add);
    ranFused = true;
  } else if (canShareCount) {
    if (fusedAvgIndex >= 0) {
      col = getNumericColumn(fields[fusedAvgIndex]);
      if (!col.hasNaN) {
        sCountSumIdx(primary[firstCountIndex], primary[fusedAvgIndex], groupIds, splitCodes, stride, col.values, false, rowIndexes, rowCount, true);
        secondary[fusedAvgIndex].set(primary[firstCountIndex].subarray(0, totalCells));
        ranFusedAvg = true;
      } else {
        sCountIdx(primary[firstCountIndex], groupIds, splitCodes, stride, rowIndexes, rowCount, true);
      }
    } else {
      sCountIdx(primary[firstCountIndex], groupIds, splitCodes, stride, rowIndexes, rowCount, true);
    }
  }

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    acc = primary[m];

    if (op === OP_COUNT) {
      if (m === firstCountIndex && (ranFused || canShareCount)) continue;
      if (canShareCount) {
        acc.set(primary[firstCountIndex].subarray(0, totalCells));
      } else {
        sCountIdx(acc, groupIds, splitCodes, stride, rowIndexes, rowCount, add);
      }
      continue;
    }

    if ((ranFused && m === fusedSumIndex) || (ranFusedAvg && m === fusedAvgIndex)) continue;

    srcIdx = isReset ? primarySumSourceIdx[m] : -1;
    denomIdx = isReset ? denomSumSourceIdx[m] : -1;
    if (pendingAcc && (srcIdx === pendingIdx || denomIdx === pendingIdx)) {
      sSumIdx(pendingAcc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, rowIndexes, rowCount, add);
      pendingAcc = null;
      pendingCol = null;
      pendingIdx = -1;
    }

    if (op === OP_SUM) {
      if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, totalCells));
      } else {
        col = getNumericColumn(fields[m]);
        if (pendingAcc) {
          sRatioIdx(pendingAcc, acc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, col.values, col.hasNaN, rowIndexes, rowCount, add);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      }
    } else if (op === OP_AVG) {
      acc2 = secondary[m];
      col = getNumericColumn(fields[m]);
      if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, totalCells));
        if (!col.hasNaN && canShareCount) {
          acc2.set(primary[firstCountIndex].subarray(0, totalCells));
        } else if (avgCountSourceIdx[m] >= 0) {
          acc2.set(secondary[avgCountSourceIdx[m]].subarray(0, totalCells));
        } else if (!col.hasNaN) {
          sCountIdx(acc2, groupIds, splitCodes, stride, rowIndexes, rowCount, true);
        } else {
          sValidCountIdx(acc2, groupIds, splitCodes, stride, col.values, rowIndexes, rowCount);
        }
      } else if (add && !col.hasNaN && canShareCount) {
        acc2.set(primary[firstCountIndex].subarray(0, totalCells));
        if (pendingAcc) {
          sRatioIdx(pendingAcc, acc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, col.values, false, rowIndexes, rowCount, true);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      } else {
        sAvgIdx(acc, acc2, groupIds, splitCodes, stride, col.values, col.hasNaN, rowIndexes, rowCount, add);
      }
    } else if (op === OP_AVG_NON_ZERO) {
      col = getNumericColumn(fields[m]);
      sAvgNzIdx(acc, secondary[m], groupIds, splitCodes, stride, col.values, col.hasNaN, rowIndexes, rowCount, add);
    } else if (op === OP_RATIO) {
      acc2 = secondary[m];
      if (srcIdx >= 0 && denomIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, totalCells));
        srcBuf = denomSumSourceSec[m] ? secondary[denomIdx] : primary[denomIdx];
        acc2.set(srcBuf.subarray(0, totalCells));
      } else if (denomIdx >= 0) {
        srcBuf = denomSumSourceSec[m] ? secondary[denomIdx] : primary[denomIdx];
        acc2.set(srcBuf.subarray(0, totalCells));
        col = getNumericColumn(fields[m]);
        if (pendingAcc) {
          sRatioIdx(pendingAcc, acc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, col.values, col.hasNaN, rowIndexes, rowCount, true);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc;
          pendingCol = col;
          pendingIdx = m;
        }
      } else if (srcIdx >= 0) {
        srcBuf = primarySumSourceSec[m] ? secondary[srcIdx] : primary[srcIdx];
        acc.set(srcBuf.subarray(0, totalCells));
        col2 = getNumericColumn(denominators[m]);
        if (pendingAcc) {
          sRatioIdx(pendingAcc, acc2, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, col2.values, col2.hasNaN, rowIndexes, rowCount, true);
          pendingAcc = null;
          pendingCol = null;
          pendingIdx = -1;
        } else {
          pendingAcc = acc2;
          pendingCol = col2;
          pendingIdx = m;
        }
      } else {
        col = getNumericColumn(fields[m]);
        col2 = getNumericColumn(denominators[m]);
        sRatioIdx(acc, acc2, groupIds, splitCodes, stride, col.values, col.hasNaN, col2.values, col2.hasNaN, rowIndexes, rowCount, add);
      }
    }
  }

  if (pendingAcc) {
    sSumIdx(pendingAcc, groupIds, splitCodes, stride, pendingCol.values, pendingCol.hasNaN, rowIndexes, rowCount, add);
  }
}

export function reduceScalarAll(buffers, plan, getNumericColumn, n) {
  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primarySumSourceIdx = plan.primarySumSourceIdx;
  var primarySumSourceSec = plan.primarySumSourceSec;
  var denomSumSourceIdx = plan.denomSumSourceIdx;
  var denomSumSourceSec = plan.denomSumSourceSec;
  var avgCountSourceIdx = plan.avgCountSourceIdx;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var m, op, col, col2, vals, hasNaN, i, v, s, s2, srcIdx, denomIdx;

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    if (op === OP_COUNT) {
      primary[m][0] += n;
      continue;
    }

    srcIdx = primarySumSourceIdx[m];
    s = 0;
    s2 = 0;

    if (op === OP_SUM) {
      if (srcIdx >= 0) {
        primary[m][0] = primarySumSourceSec[m] ? secondary[srcIdx][0] : primary[srcIdx][0];
      } else {
        col = getNumericColumn(fields[m]);
        primary[m][0] += scSumAll(col.values, col.hasNaN, n);
      }
    } else if (op === OP_AVG) {
      col = getNumericColumn(fields[m]);
      if (srcIdx >= 0) {
        primary[m][0] = primarySumSourceSec[m] ? secondary[srcIdx][0] : primary[srcIdx][0];
        if (!col.hasNaN) {
          secondary[m][0] += n;
        } else if (avgCountSourceIdx[m] >= 0) {
          secondary[m][0] = secondary[avgCountSourceIdx[m]][0];
        } else {
          secondary[m][0] += scValidCountAll(col.values, n);
        }
      } else if (!col.hasNaN) {
        primary[m][0] += scSumAll(col.values, false, n);
        secondary[m][0] += n;
      } else {
        vals = col.values;
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v) { s += v; s2 += 1; }
        }
        primary[m][0] += s;
        secondary[m][0] += s2;
      }
    } else if (op === OP_AVG_NON_ZERO) {
      col = getNumericColumn(fields[m]);
      vals = col.values;
      hasNaN = col.hasNaN;
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
      primary[m][0] += s;
      secondary[m][0] += s2;
    } else if (op === OP_RATIO) {
      denomIdx = denomSumSourceIdx[m];
      if (srcIdx >= 0) {
        primary[m][0] = primarySumSourceSec[m] ? secondary[srcIdx][0] : primary[srcIdx][0];
      } else {
        col = getNumericColumn(fields[m]);
        primary[m][0] += scSumAll(col.values, col.hasNaN, n);
      }
      if (denomIdx >= 0) {
        secondary[m][0] = denomSumSourceSec[m] ? secondary[denomIdx][0] : primary[denomIdx][0];
      } else {
        col2 = getNumericColumn(denominators[m]);
        secondary[m][0] += scSumAll(col2.values, col2.hasNaN, n);
      }
    }
  }
}

export function reduceScalarIndexed(buffers, plan, getNumericColumn, rowIndexes, rowCount, delta) {
  if (!rowCount) return;

  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primarySumSourceIdx = plan.primarySumSourceIdx;
  var primarySumSourceSec = plan.primarySumSourceSec;
  var denomSumSourceIdx = plan.denomSumSourceIdx;
  var denomSumSourceSec = plan.denomSumSourceSec;
  var avgCountSourceIdx = plan.avgCountSourceIdx;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var sign = delta > 0 ? 1 : -1;
  var stepPrimary = new Float64Array(metricCount);
  var stepSecondary = new Float64Array(metricCount);
  var m, op, col, col2, vals, hasNaN, j, v, s, s2, srcIdx, denomIdx;

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    if (op === OP_COUNT) {
      stepPrimary[m] = rowCount;
      primary[m][0] += sign * rowCount;
      continue;
    }

    srcIdx = primarySumSourceIdx[m];
    s = 0;
    s2 = 0;

    if (op === OP_SUM) {
      if (srcIdx >= 0) {
        s = primarySumSourceSec[m] ? stepSecondary[srcIdx] : stepPrimary[srcIdx];
      } else {
        col = getNumericColumn(fields[m]);
        s = scSumIdx(col.values, col.hasNaN, rowIndexes, rowCount);
      }
      stepPrimary[m] = s;
      primary[m][0] += sign * s;
    } else if (op === OP_AVG) {
      col = getNumericColumn(fields[m]);
      if (srcIdx >= 0) {
        s = primarySumSourceSec[m] ? stepSecondary[srcIdx] : stepPrimary[srcIdx];
        if (!col.hasNaN) {
          s2 = rowCount;
        } else if (avgCountSourceIdx[m] >= 0) {
          s2 = stepSecondary[avgCountSourceIdx[m]];
        } else {
          s2 = scValidCountIdx(col.values, rowIndexes, rowCount);
        }
      } else if (!col.hasNaN) {
        s = scSumIdx(col.values, false, rowIndexes, rowCount);
        s2 = rowCount;
      } else {
        vals = col.values;
        for (j = 0; j < rowCount; ++j) {
          v = vals[rowIndexes[j]];
          if (v === v) { s += v; s2 += 1; }
        }
      }
      stepPrimary[m] = s;
      stepSecondary[m] = s2;
      primary[m][0] += sign * s;
      secondary[m][0] += sign * s2;
    } else if (op === OP_AVG_NON_ZERO) {
      col = getNumericColumn(fields[m]);
      vals = col.values;
      hasNaN = col.hasNaN;
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
      stepPrimary[m] = s;
      stepSecondary[m] = s2;
      primary[m][0] += sign * s;
      secondary[m][0] += sign * s2;
    } else if (op === OP_RATIO) {
      denomIdx = denomSumSourceIdx[m];
      if (srcIdx >= 0) {
        s = primarySumSourceSec[m] ? stepSecondary[srcIdx] : stepPrimary[srcIdx];
      } else {
        col = getNumericColumn(fields[m]);
        s = scSumIdx(col.values, col.hasNaN, rowIndexes, rowCount);
      }
      if (denomIdx >= 0) {
        s2 = denomSumSourceSec[m] ? stepSecondary[denomIdx] : stepPrimary[denomIdx];
      } else {
        col2 = getNumericColumn(denominators[m]);
        s2 = scSumIdx(col2.values, col2.hasNaN, rowIndexes, rowCount);
      }
      stepPrimary[m] = s;
      stepSecondary[m] = s2;
      primary[m][0] += sign * s;
      secondary[m][0] += sign * s2;
    }
  }
}

export function writeMetricSlotToState(state, plan, buffers, slot) {
  var ops = plan.ops;
  var ids = plan.ids;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var m, op, id, sub;

  for (m = 0; m < plan.count; ++m) {
    op = ops[m];
    id = ids[m];
    if (op === OP_AVG || op === OP_AVG_NON_ZERO) {
      sub = state[id];
      if (!sub) {
        state[id] = { count: secondary[m][slot], sum: primary[m][slot] };
      } else {
        sub.sum = primary[m][slot];
        sub.count = secondary[m][slot];
      }
    } else if (op === OP_RATIO) {
      sub = state[id];
      if (!sub) {
        state[id] = { den: secondary[m][slot], num: primary[m][slot] };
      } else {
        sub.num = primary[m][slot];
        sub.den = secondary[m][slot];
      }
    } else {
      state[id] = primary[m][slot];
    }
  }
  if (state.__version !== undefined) {
    state.__version += 1;
  }
}

export function finalizeMetricSlot(plan, buffers, slot) {
  var ops = plan.ops;
  var ids = plan.ids;
  var hidden = plan.hidden;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var result = {};
  var m, op, denom;

  for (m = 0; m < plan.count; ++m) {
    if (hidden[m]) continue;
    op = ops[m];
    if (op === OP_AVG || op === OP_AVG_NON_ZERO) {
      denom = secondary[m][slot];
      result[ids[m]] = denom ? primary[m][slot] / denom : null;
    } else if (op === OP_RATIO) {
      denom = secondary[m][slot];
      result[ids[m]] = denom !== 0 ? primary[m][slot] / denom : null;
    } else {
      result[ids[m]] = primary[m][slot];
    }
  }
  return result;
}

export function slotHasAnyActivity(plan, buffers, slot) {
  var ops = plan.ops;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var m, op;

  for (m = 0; m < plan.count; ++m) {
    op = ops[m];
    if (op === OP_COUNT) {
      if (primary[m][slot] > 0) return true;
    } else if (op === OP_AVG || op === OP_AVG_NON_ZERO) {
      if (secondary[m][slot] > 0) return true;
    } else if (op === OP_RATIO) {
      if (primary[m][slot] !== 0 || secondary[m][slot] !== 0) return true;
    } else {
      if (primary[m][slot] !== 0) return true;
    }
  }
  return false;
}
