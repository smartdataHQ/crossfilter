import { describe, it, expect } from 'vitest';
import {
  getColumns,
  filterIndices,
  sortIndices,
  materializeRows,
  countByColumn,
  sumColumn,
  countsToOptions,
  columnarToRows,
} from '../demo-stockout/panels/helpers.js';

describe('getColumns', function () {
  it('normalizes {columns, length}', function () {
    var result = getColumns({ columns: { a: [1, 2], b: [3, 4] }, length: 2 });
    expect(result.columns.a).toEqual([1, 2]);
    expect(result.length).toBe(2);
  });

  it('infers length from first column when not provided', function () {
    var result = getColumns({ columns: { x: [10, 20, 30] } });
    expect(result.length).toBe(3);
  });

  it('handles flat column object (no wrapper)', function () {
    var result = getColumns({ a: [1, 2, 3], b: [4, 5, 6] });
    expect(result.length).toBe(3);
    expect(result.columns.a).toEqual([1, 2, 3]);
  });

  it('returns empty for null input', function () {
    var result = getColumns(null);
    expect(result.length).toBe(0);
  });

  it('returns empty for empty columns', function () {
    var result = getColumns({ columns: {} });
    expect(result.length).toBe(0);
  });
});

describe('filterIndices', function () {
  it('returns matching subset', function () {
    var cols = { val: [10, 20, 30, 40] };
    var indices = filterIndices(cols, 4, function (c, i) { return c.val[i] > 15; });
    expect(indices).toEqual([1, 2, 3]);
  });

  it('returns empty for no matches', function () {
    var cols = { val: [1, 2, 3] };
    var indices = filterIndices(cols, 3, function (c, i) { return c.val[i] > 100; });
    expect(indices).toEqual([]);
  });

  it('handles zero-length input', function () {
    var indices = filterIndices({}, 0, function () { return true; });
    expect(indices).toEqual([]);
  });
});

describe('sortIndices', function () {
  it('sorts desc numeric', function () {
    var cols = { score: [10, 40, 20, 30] };
    var indices = [0, 1, 2, 3];
    sortIndices(indices, cols, 'score', -1);
    expect(indices).toEqual([1, 3, 2, 0]);
  });

  it('sorts asc string (case-insensitive)', function () {
    var cols = { name: ['banana', 'Apple', 'cherry'] };
    var indices = [0, 1, 2];
    sortIndices(indices, cols, 'name', 1);
    expect(indices).toEqual([1, 0, 2]);
  });

  it('handles null values in column', function () {
    var cols = { val: [5, null, 3, null, 1] };
    var indices = [0, 1, 2, 3, 4];
    sortIndices(indices, cols, 'val', -1);
    expect(cols.val[indices[0]]).toBe(5);
    expect(cols.val[indices[1]]).toBe(3);
    expect(cols.val[indices[2]]).toBe(1);
  });
});

describe('materializeRows', function () {
  it('materializes subset of indices', function () {
    var cols = { a: [10, 20, 30], b: ['x', 'y', 'z'] };
    var rows = materializeRows(cols, [2, 0]);
    expect(rows).toEqual([
      { a: 30, b: 'z' },
      { a: 10, b: 'x' },
    ]);
  });

  it('supports field projection', function () {
    var cols = { a: [1, 2], b: [3, 4], c: [5, 6] };
    var rows = materializeRows(cols, [0, 1], ['a', 'c']);
    expect(rows).toEqual([
      { a: 1, c: 5 },
      { a: 2, c: 6 },
    ]);
  });

  it('returns empty for empty indices', function () {
    var cols = { a: [1, 2] };
    expect(materializeRows(cols, [])).toEqual([]);
  });
});

describe('countByColumn', function () {
  it('counts mixed values', function () {
    var cols = { cat: ['A', 'B', 'A', 'C', 'B', 'A'] };
    var counts = countByColumn(cols, [0, 1, 2, 3, 4, 5], 'cat');
    expect(counts).toEqual({ A: 3, B: 2, C: 1 });
  });

  it('skips nulls and empty strings', function () {
    var cols = { cat: ['A', null, '', 'B', null] };
    var counts = countByColumn(cols, [0, 1, 2, 3, 4], 'cat');
    expect(counts).toEqual({ A: 1, B: 1 });
  });
});

describe('sumColumn', function () {
  it('sums normal values', function () {
    var cols = { val: [10, 20, 30] };
    expect(sumColumn(cols, [0, 1, 2], 'val')).toBe(60);
  });

  it('handles all-NaN column', function () {
    var cols = { val: ['a', 'b', 'c'] };
    expect(sumColumn(cols, [0, 1, 2], 'val')).toBe(0);
  });

  it('skips NaN values in partial NaN column', function () {
    var cols = { val: [10, 'bad', 30] };
    expect(sumColumn(cols, [0, 1, 2], 'val')).toBe(40);
  });
});

describe('countsToOptions', function () {
  it('converts counts to sorted option HTML', function () {
    var html = countsToOptions({ B: 3, A: 5 });
    expect(html).toContain('A (5)');
    expect(html).toContain('B (3)');
    expect(html.indexOf('A (5)')).toBeLessThan(html.indexOf('B (3)'));
  });
});

describe('columnarToRows (backward compat)', function () {
  it('converts columnar result to row objects', function () {
    var rows = columnarToRows({ columns: { a: [1, 2], b: [3, 4] }, length: 2 });
    expect(rows).toEqual([{ a: 1, b: 3 }, { a: 2, b: 4 }]);
  });

  it('handles null', function () {
    expect(columnarToRows(null)).toEqual([]);
  });
});
