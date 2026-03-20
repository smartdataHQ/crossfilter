// test/dashboard-validation.test.js
import { describe, it, expect } from 'vitest';
import { validateConfig, listSupported, listUnsupported } from '../demo/chart-support.js';
import { allTypeNames } from '../demo/chart-types.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var DASHBOARDS_DIR = path.resolve(__dirname, '../demo/dashboards');

function loadConfig(name) {
  var filePath = path.resolve(DASHBOARDS_DIR, name + '.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('dashboard config validation', function () {
  it('reports overall chart support coverage', function () {
    var supported = listSupported();
    var all = allTypeNames();
    var coverage = ((supported.length / all.length) * 100).toFixed(0);
    console.log('Chart support: ' + supported.length + '/' + all.length + ' types (' + coverage + '%)');
    console.log('Unsupported: ' + listUnsupported().join(', '));
    expect(supported.length).toBeGreaterThan(20);
  });

  it('bluecar-fleet.json tracks support coverage', function () {
    var config = loadConfig('bluecar-fleet');
    var result = validateConfig(config);
    if (result.errors.length > 0) {
      console.log('Unsupported in bluecar-fleet:', result.errors);
    }
    // bluecar-fleet uses: kpi, bar, pie, line, range, table
    // All should now be supported
    expect(result.errors.length).toBe(0);
  });

  it('bluecar-geography.json validates all types', function () {
    var config = loadConfig('bluecar-geography');
    var result = validateConfig(config);
    if (result.errors.length > 0) {
      console.log('Unsupported in bluecar-geography:', result.errors);
    }
    // Geography uses: kpi, bar, pie, line, selector, toggle, table
    // No map types in this config
    expect(result.errors.length).toBe(0);
  });

  it('bluecar-ai-generated.json tracks support coverage', function () {
    var config = loadConfig('bluecar-ai-generated');
    var result = validateConfig(config);
    var totalPanels = 0;
    var sections = config.sections || [];
    for (var s = 0; s < sections.length; ++s) {
      totalPanels += (sections[s].panels || []).length;
    }
    var supportedPanels = totalPanels - result.errors.length;
    var coverage = ((supportedPanels / totalPanels) * 100).toFixed(0);
    console.log('AI-generated dashboard: ' + supportedPanels + '/' + totalPanels + ' panels supported (' + coverage + '%)');
    if (result.errors.length > 0) {
      console.log('Unsupported panels:', result.errors);
    }
  });
});
