// test/chart-support.test.js
import { describe, it, expect } from 'vitest';
import { isChartSupported, listSupported, listUnsupported, validateConfig } from '../demo/chart-support.js';
import { allTypeNames } from '../demo/chart-types.js';

describe('chart-support', function () {
  it('reports bar as supported', function () {
    expect(isChartSupported('bar')).toBe(true);
  });

  it('reports unknown types as unsupported', function () {
    expect(isChartSupported('nonexistent')).toBe(false);
  });

  it('listSupported returns only implemented types', function () {
    var supported = listSupported();
    expect(supported).toContain('bar');
    expect(supported).toContain('kpi');
    expect(supported).toContain('line');
    expect(supported).toContain('heatmap');
    expect(supported).toContain('scatter');
    // Relation charts now implemented
    expect(supported).toContain('sankey');
    expect(supported).toContain('graph');
    // chord uses ecType: 'custom' — not implemented
    expect(supported).not.toContain('chord');
  });

  it('listUnsupported returns types without renderers', function () {
    var unsupported = listUnsupported();
    expect(unsupported.length).toBeGreaterThan(0);
    // Every type is in exactly one list
    var supported = listSupported();
    var all = allTypeNames();
    expect(supported.length + unsupported.length).toBe(all.length);
  });

  it('validateConfig returns errors for unsupported chart types', function () {
    var config = {
      title: 'Test',
      cubes: ['test_cube'],
      sharedFilters: [],
      sections: [{
        id: 's1', label: 'Test', location: 'main', columns: 2, collapsed: false,
        panels: [
          { chart: 'bar', dimension: 'region', cube: 'test_cube', label: 'Region', primary: false, limit: 10, searchable: false, width: null },
          { chart: 'chord', source: 'from', target: 'to', cube: 'test_cube', label: 'Flow', primary: false, limit: null, searchable: false, width: null },
        ],
      }],
    };
    var result = validateConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('chord');
    expect(result.warnings).toEqual([]);
  });

  it('validateConfig passes for all-supported configs', function () {
    var config = {
      title: 'Test',
      cubes: ['test_cube'],
      sharedFilters: [],
      sections: [{
        id: 's1', label: 'KPIs', location: 'main', columns: 3, collapsed: false,
        panels: [
          { chart: 'kpi', value: 'count', cube: 'test_cube', label: 'Total', primary: false, limit: null, searchable: false, width: null },
          { chart: 'bar', category: 'region', cube: 'test_cube', label: 'Region', primary: false, limit: 10, searchable: false, width: null },
        ],
      }],
    };
    var result = validateConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
