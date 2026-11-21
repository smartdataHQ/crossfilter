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

export function ensureMetricBuffers(buffers, plan, required, preserve) {
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

export function zeroMetricBuffers(buffers, slotCount) {
  if (slotCount > 0) {
    buffers.data.fill(0, 0, slotCount * buffers.stride);
  }
}

export function canPlanUseComplement(plan, getNumericColumn) {
  var fields = plan.allUniqueFields;
  for (var i = 0; i < fields.length; ++i) {
    var col = getNumericColumn(fields[i]);
    if (col && col.hasExtreme) {
      return false;
    }
  }
  return true;
}

export function getExactCountOffset(plan, getNumericColumn) {
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

export function reduceMultiGroupsAll(targets, kpiBuffers, plan, getNumericColumn, n) {
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

export function reduceMultiGroupsIndexed(targets, kpiBuffers, plan, getNumericColumn, rowIndexes, rowCount, delta) {
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

export function reduceGroupedAll(buffers, plan, getNumericColumn, groupIds, n, slotCount) {
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

export function reduceGroupedIndexed(buffers, plan, getNumericColumn, groupIds, rowIndexes, rowCount, delta, slotCount) {
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

export function reduceSplitDenseAll(buffers, plan, getNumericColumn, primarySlotArr, splitCodes, splitStride, n, totalSlots) {
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

export function reduceSplitDenseIndexed(buffers, plan, getNumericColumn, primarySlotArr, splitCodes, splitStride, rowIndexes, rowCount, delta, totalSlots) {
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

export function reduceScalarAll(buffers, plan, getNumericColumn, n) {
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

export function reduceScalarIndexed(buffers, plan, getNumericColumn, rowIndexes, rowCount, delta) {
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

export function cleanupComplementEmptySlots(buffers, plan, exactCountOff, slotArr, splitCodes, splitStride, trackedCounts, tmpCounts, rowIndexes, rowCount, totalSlots) {
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

export function writeMetricSlotToState(state, plan, buffers, slot) {
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

export function finalizeMetricSlot(plan, buffers, slot) {
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

export function slotHasAnyActivity(plan, buffers, slot) {
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
