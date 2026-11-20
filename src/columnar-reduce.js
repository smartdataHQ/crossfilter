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
  var firstCountIndex = -1;
  var i, metric, op;

  for (i = 0; i < count; ++i) {
    metric = metricSpec[i];
    ids[i] = metric.id;
    fields[i] = metric.field || null;
    denominators[i] = metric.denominator || null;
    hidden[i] = metric.hidden ? 1 : 0;
    switch (metric.op) {
      case 'count':
        op = OP_COUNT;
        if (firstCountIndex < 0) firstCountIndex = i;
        break;
      case 'sum':
        op = OP_SUM;
        break;
      case 'avg':
        op = OP_AVG;
        break;
      case 'avgNonZero':
        op = OP_AVG_NON_ZERO;
        break;
      case 'ratio':
        op = OP_RATIO;
        break;
      default:
        op = OP_COUNT;
    }
    ops[i] = op;
  }

  return {
    count: count,
    denominators: denominators,
    fields: fields,
    firstCountIndex: firstCountIndex,
    hidden: hidden,
    ids: ids,
    ops: ops,
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

export function reduceGroupedAll(buffers, plan, getNumericColumn, groupIds, n, slotCount) {
  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var firstCountIndex = plan.firstCountIndex;
  var countComputed = false;
  var m, op, acc, acc2, col, col2, vals, vals2, hasNaN, hasNaN2, i, v, v2, g;

  // Compute first count metric up front so non-NaN avg metrics can copy counts directly.
  if (firstCountIndex >= 0) {
    acc = primary[firstCountIndex];
    for (i = 0; i < n; ++i) {
      acc[groupIds[i]] += 1;
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
        for (i = 0; i < n; ++i) {
          acc[groupIds[i]] += 1;
        }
      }
      continue;
    }

    col = getNumericColumn(fields[m]);
    vals = col.values;
    hasNaN = col.hasNaN;

    if (op === OP_SUM) {
      if (!hasNaN) {
        for (i = 0; i < n; ++i) {
          acc[groupIds[i]] += vals[i];
        }
      } else {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v) {
            acc[groupIds[i]] += v;
          }
        }
      }
    } else if (op === OP_AVG) {
      acc2 = secondary[m];
      if (!hasNaN) {
        if (countComputed) {
          for (i = 0; i < n; ++i) {
            acc[groupIds[i]] += vals[i];
          }
          acc2.set(primary[firstCountIndex].subarray(0, slotCount));
        } else {
          for (i = 0; i < n; ++i) {
            g = groupIds[i];
            acc[g] += vals[i];
            acc2[g] += 1;
          }
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
    } else if (op === OP_AVG_NON_ZERO) {
      acc2 = secondary[m];
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
    } else if (op === OP_RATIO) {
      acc2 = secondary[m];
      col2 = getNumericColumn(denominators[m]);
      vals2 = col2.values;
      hasNaN2 = col2.hasNaN;
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
  }
}

export function reduceGroupedIndexed(buffers, plan, getNumericColumn, groupIds, rowIndexes, rowCount, delta, slotCount) {
  if (!rowCount) return;

  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var firstCountIndex = plan.firstCountIndex;
  var add = delta > 0;
  var canShareCount = add && slotCount > 0 && firstCountIndex >= 0;
  var m, op, acc, acc2, col, col2, vals, vals2, hasNaN, hasNaN2, j, idx, v, v2, g;

  if (canShareCount) {
    acc = primary[firstCountIndex];
    for (j = 0; j < rowCount; ++j) {
      acc[groupIds[rowIndexes[j]]] += 1;
    }
  }

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    acc = primary[m];

    if (op === OP_COUNT) {
      if (canShareCount) {
        if (m === firstCountIndex) continue;
        acc.set(primary[firstCountIndex].subarray(0, slotCount));
      } else if (add) {
        for (j = 0; j < rowCount; ++j) {
          acc[groupIds[rowIndexes[j]]] += 1;
        }
      } else {
        for (j = 0; j < rowCount; ++j) {
          acc[groupIds[rowIndexes[j]]] -= 1;
        }
      }
      continue;
    }

    col = getNumericColumn(fields[m]);
    vals = col.values;
    hasNaN = col.hasNaN;

    if (op === OP_SUM) {
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
      } else {
        if (!hasNaN) {
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
    } else if (op === OP_AVG) {
      acc2 = secondary[m];
      if (add) {
        if (!hasNaN) {
          if (canShareCount) {
            for (j = 0; j < rowCount; ++j) {
              idx = rowIndexes[j];
              acc[groupIds[idx]] += vals[idx];
            }
            acc2.set(primary[firstCountIndex].subarray(0, slotCount));
          } else {
            for (j = 0; j < rowCount; ++j) {
              idx = rowIndexes[j];
              g = groupIds[idx];
              acc[g] += vals[idx];
              acc2[g] += 1;
            }
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
      } else {
        if (!hasNaN) {
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
    } else if (op === OP_AVG_NON_ZERO) {
      acc2 = secondary[m];
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
      } else {
        if (!hasNaN) {
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
    } else if (op === OP_RATIO) {
      acc2 = secondary[m];
      col2 = getNumericColumn(denominators[m]);
      vals2 = col2.values;
      hasNaN2 = col2.hasNaN;
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
      } else {
        if (!hasNaN && !hasNaN2) {
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
    }
  }
}

export function reduceSplitDenseAll(buffers, plan, getNumericColumn, groupIds, splitCodes, stride, n, slotCount) {
  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var firstCountIndex = plan.firstCountIndex;
  var countComputed = false;
  var m, op, acc, acc2, col, col2, vals, vals2, hasNaN, hasNaN2, i, v, v2, cell;

  if (firstCountIndex >= 0) {
    acc = primary[firstCountIndex];
    for (i = 0; i < n; ++i) {
      acc[groupIds[i] * stride + splitCodes[i]] += 1;
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
        for (i = 0; i < n; ++i) {
          acc[groupIds[i] * stride + splitCodes[i]] += 1;
        }
      }
      continue;
    }

    col = getNumericColumn(fields[m]);
    vals = col.values;
    hasNaN = col.hasNaN;

    if (op === OP_SUM) {
      if (!hasNaN) {
        for (i = 0; i < n; ++i) {
          acc[groupIds[i] * stride + splitCodes[i]] += vals[i];
        }
      } else {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v) {
            acc[groupIds[i] * stride + splitCodes[i]] += v;
          }
        }
      }
    } else if (op === OP_AVG) {
      acc2 = secondary[m];
      if (!hasNaN) {
        if (countComputed) {
          for (i = 0; i < n; ++i) {
            acc[groupIds[i] * stride + splitCodes[i]] += vals[i];
          }
          acc2.set(primary[firstCountIndex].subarray(0, slotCount));
        } else {
          for (i = 0; i < n; ++i) {
            cell = groupIds[i] * stride + splitCodes[i];
            acc[cell] += vals[i];
            acc2[cell] += 1;
          }
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
    } else if (op === OP_AVG_NON_ZERO) {
      acc2 = secondary[m];
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
    } else if (op === OP_RATIO) {
      acc2 = secondary[m];
      col2 = getNumericColumn(denominators[m]);
      vals2 = col2.values;
      hasNaN2 = col2.hasNaN;
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
  }
}

export function reduceSplitDenseIndexed(buffers, plan, getNumericColumn, groupIds, splitCodes, stride, rowIndexes, rowCount, delta, slotCount) {
  if (!rowCount) return;

  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var firstCountIndex = plan.firstCountIndex;
  var add = delta > 0;
  var canShareCount = add && slotCount > 0 && firstCountIndex >= 0;
  var m, op, acc, acc2, col, col2, vals, vals2, hasNaN, hasNaN2, j, idx, v, v2, cell;

  if (canShareCount) {
    acc = primary[firstCountIndex];
    for (j = 0; j < rowCount; ++j) {
      idx = rowIndexes[j];
      acc[groupIds[idx] * stride + splitCodes[idx]] += 1;
    }
  }

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    acc = primary[m];

    if (op === OP_COUNT) {
      if (canShareCount) {
        if (m === firstCountIndex) continue;
        acc.set(primary[firstCountIndex].subarray(0, slotCount));
      } else if (add) {
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
      continue;
    }

    col = getNumericColumn(fields[m]);
    vals = col.values;
    hasNaN = col.hasNaN;

    if (op === OP_SUM) {
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
      } else {
        if (!hasNaN) {
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
    } else if (op === OP_AVG) {
      acc2 = secondary[m];
      if (add) {
        if (!hasNaN) {
          if (canShareCount) {
            for (j = 0; j < rowCount; ++j) {
              idx = rowIndexes[j];
              acc[groupIds[idx] * stride + splitCodes[idx]] += vals[idx];
            }
            acc2.set(primary[firstCountIndex].subarray(0, slotCount));
          } else {
            for (j = 0; j < rowCount; ++j) {
              idx = rowIndexes[j];
              cell = groupIds[idx] * stride + splitCodes[idx];
              acc[cell] += vals[idx];
              acc2[cell] += 1;
            }
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
      } else {
        if (!hasNaN) {
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
    } else if (op === OP_AVG_NON_ZERO) {
      acc2 = secondary[m];
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
      } else {
        if (!hasNaN) {
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
    } else if (op === OP_RATIO) {
      acc2 = secondary[m];
      col2 = getNumericColumn(denominators[m]);
      vals2 = col2.values;
      hasNaN2 = col2.hasNaN;
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
      } else {
        if (!hasNaN && !hasNaN2) {
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
    }
  }
}

export function reduceScalarAll(buffers, plan, getNumericColumn, n) {
  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var m, op, col, col2, vals, vals2, hasNaN, hasNaN2, i, v, v2, s, s2;

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    if (op === OP_COUNT) {
      primary[m][0] += n;
      continue;
    }

    col = getNumericColumn(fields[m]);
    vals = col.values;
    hasNaN = col.hasNaN;
    s = 0;
    s2 = 0;

    if (op === OP_SUM) {
      if (!hasNaN) {
        for (i = 0; i < n; ++i) s += vals[i];
      } else {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v) s += v;
        }
      }
      primary[m][0] += s;
    } else if (op === OP_AVG) {
      if (!hasNaN) {
        for (i = 0; i < n; ++i) s += vals[i];
        s2 = n;
      } else {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v) {
            s += v;
            s2 += 1;
          }
        }
      }
      primary[m][0] += s;
      secondary[m][0] += s2;
    } else if (op === OP_AVG_NON_ZERO) {
      if (!hasNaN) {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v !== 0) {
            s += v;
            s2 += 1;
          }
        }
      } else {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v && v !== 0) {
            s += v;
            s2 += 1;
          }
        }
      }
      primary[m][0] += s;
      secondary[m][0] += s2;
    } else if (op === OP_RATIO) {
      col2 = getNumericColumn(denominators[m]);
      vals2 = col2.values;
      hasNaN2 = col2.hasNaN;
      if (!hasNaN && !hasNaN2) {
        for (i = 0; i < n; ++i) {
          s += vals[i];
          s2 += vals2[i];
        }
      } else {
        for (i = 0; i < n; ++i) {
          v = vals[i];
          if (v === v) s += v;
          v2 = vals2[i];
          if (v2 === v2) s2 += v2;
        }
      }
      primary[m][0] += s;
      secondary[m][0] += s2;
    }
  }
}

export function reduceScalarIndexed(buffers, plan, getNumericColumn, rowIndexes, rowCount, delta) {
  if (!rowCount) return;

  var ops = plan.ops;
  var fields = plan.fields;
  var denominators = plan.denominators;
  var primary = buffers.primary;
  var secondary = buffers.secondary;
  var metricCount = plan.count;
  var sign = delta > 0 ? 1 : -1;
  var m, op, col, col2, vals, vals2, hasNaN, hasNaN2, j, idx, v, v2, s, s2;

  for (m = 0; m < metricCount; ++m) {
    op = ops[m];
    if (op === OP_COUNT) {
      primary[m][0] += sign * rowCount;
      continue;
    }

    col = getNumericColumn(fields[m]);
    vals = col.values;
    hasNaN = col.hasNaN;
    s = 0;
    s2 = 0;

    if (op === OP_SUM) {
      if (!hasNaN) {
        for (j = 0; j < rowCount; ++j) s += vals[rowIndexes[j]];
      } else {
        for (j = 0; j < rowCount; ++j) {
          v = vals[rowIndexes[j]];
          if (v === v) s += v;
        }
      }
      primary[m][0] += sign * s;
    } else if (op === OP_AVG) {
      if (!hasNaN) {
        for (j = 0; j < rowCount; ++j) s += vals[rowIndexes[j]];
        s2 = rowCount;
      } else {
        for (j = 0; j < rowCount; ++j) {
          v = vals[rowIndexes[j]];
          if (v === v) {
            s += v;
            s2 += 1;
          }
        }
      }
      primary[m][0] += sign * s;
      secondary[m][0] += sign * s2;
    } else if (op === OP_AVG_NON_ZERO) {
      if (!hasNaN) {
        for (j = 0; j < rowCount; ++j) {
          v = vals[rowIndexes[j]];
          if (v !== 0) {
            s += v;
            s2 += 1;
          }
        }
      } else {
        for (j = 0; j < rowCount; ++j) {
          v = vals[rowIndexes[j]];
          if (v === v && v !== 0) {
            s += v;
            s2 += 1;
          }
        }
      }
      primary[m][0] += sign * s;
      secondary[m][0] += sign * s2;
    } else if (op === OP_RATIO) {
      col2 = getNumericColumn(denominators[m]);
      vals2 = col2.values;
      hasNaN2 = col2.hasNaN;
      if (!hasNaN && !hasNaN2) {
        for (j = 0; j < rowCount; ++j) {
          idx = rowIndexes[j];
          s += vals[idx];
          s2 += vals2[idx];
        }
      } else {
        for (j = 0; j < rowCount; ++j) {
          idx = rowIndexes[j];
          v = vals[idx];
          if (v === v) s += v;
          v2 = vals2[idx];
          if (v2 === v2) s2 += v2;
        }
      }
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
