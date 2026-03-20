// demo/chart-support.js
// Runtime registry of which chart types have working renderers.
// Used by the engine (warning on unsupported) and builder (validation).

import { allTypeNames, getChartType } from './chart-types.js';

// Set of chart type names that have a working render path in
// dashboard-engine.js. Update this set as new renderers are added.
var SUPPORTED = {
  // category family
  bar: true,
  'bar.horizontal': true,
  pictorialBar: true,
  pie: true,
  'pie.donut': true,
  'pie.rose': true,
  'pie.half': true,
  'pie.nested': true,
  funnel: true,
  'funnel.ascending': true,
  // time family (via renderLineChart + viz picker)
  line: true,
  'line.smooth': true,
  'line.step': true,
  'line.area': true,
  'line.area.stacked': true,
  'line.area.normalized': true,
  'line.bump': true,
  // single family
  kpi: true,
  gauge: true,
  'gauge.progress': true,
  'gauge.ring': true,
  // control family
  selector: true,
  dropdown: true,
  toggle: true,
  range: true,
};

export function isChartSupported(typeName) {
  return SUPPORTED[typeName] === true;
}

export function listSupported() {
  return allTypeNames().filter(function (t) { return SUPPORTED[t] === true; });
}

export function listUnsupported() {
  return allTypeNames().filter(function (t) { return !SUPPORTED[t]; });
}

// Mark a chart type as supported (called when new renderers are registered)
export function registerSupport(typeName) {
  SUPPORTED[typeName] = true;
}

// Validate a dashboard config — returns { valid, errors, warnings }
export function validateConfig(config) {
  var errors = [];
  var warnings = [];
  var sections = config.sections || [];

  for (var s = 0; s < sections.length; ++s) {
    var panels = sections[s].panels || [];
    for (var p = 0; p < panels.length; ++p) {
      var chart = panels[p].chart;
      if (!chart) continue;
      if (!getChartType(chart)) {
        errors.push('Unknown chart type "' + chart + '" in section "' + sections[s].id + '"');
      } else if (!SUPPORTED[chart]) {
        errors.push('Chart type "' + chart + '" is not yet implemented (section "' + sections[s].id + '", panel "' + (panels[p].label || p) + '")');
      }
    }
  }

  return { valid: errors.length === 0, errors: errors, warnings: warnings };
}
