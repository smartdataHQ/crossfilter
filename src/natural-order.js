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

export function compareNaturalOrder(left, right) {
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

export function isNaturallyOrderable(value) {
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
