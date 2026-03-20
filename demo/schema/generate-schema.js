// demo/schema/generate-schema.js
//
// Generates a complete JSON Schema for dashboard configs by merging
// the static base schema with cube-specific enums from /api/meta.
//
// Usage:
//   import { generateDashboardSchema } from './generate-schema.js';
//   var schema = generateDashboardSchema(metaResponse, ['bluecar_stays']);
//
// CLI:
//   node demo/schema/generate-schema.js [cubeName...]
//   Reads .env credentials, fetches meta, prints the schema JSON.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allTypeNames, getChartType } from '../chart-types.js';
import { buildFullSchema } from './dashboard-schema-base.js';
import { isChartSupported } from '../chart-support.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Extract enums from cube metadata ────────────────────────────────

function extractCubeEnums(metaResponse, cubeNames) {
  var cubes = metaResponse && metaResponse.cubes || [];
  var dims = [];
  var measures = [];
  var segments = [];
  var seen = {};

  for (var c = 0; c < cubeNames.length; ++c) {
    var cubeName = cubeNames[c];
    var cube = null;
    for (var i = 0; i < cubes.length; ++i) {
      if (cubes[i].name === cubeName) { cube = cubes[i]; break; }
    }
    if (!cube) {
      throw new Error('Cube "' + cubeName + '" not found in metadata. Available: ' +
        cubes.map(function (x) { return x.name; }).join(', '));
    }

    var cubeDims = cube.dimensions || [];
    for (var d = 0; d < cubeDims.length; ++d) {
      var shortName = cubeDims[d].name.split('.').pop();
      if (!seen['d:' + shortName]) {
        dims.push(shortName);
        seen['d:' + shortName] = true;
      }
    }

    var cubeMeasures = cube.measures || [];
    for (var m = 0; m < cubeMeasures.length; ++m) {
      var mShort = cubeMeasures[m].name.split('.').pop();
      if (!seen['m:' + mShort]) {
        measures.push(mShort);
        seen['m:' + mShort] = true;
      }
    }

    var cubeSegments = cube.segments || [];
    for (var s = 0; s < cubeSegments.length; ++s) {
      var sShort = cubeSegments[s].name.split('.').pop();
      if (!seen['s:' + sShort]) {
        segments.push(sShort);
        seen['s:' + sShort] = true;
      }
    }
  }

  return {
    dimensions: dims.sort(),
    measures: measures.sort(),
    segments: segments.sort(),
    cubes: cubeNames.slice(),
  };
}

// ── Main generator ──────────────────────────────────────────────────

export function generateDashboardSchema(metaResponse, cubeNames, options) {
  var enums = extractCubeEnums(metaResponse, cubeNames);
  var opts = options || {};

  var dimEnum = enums.dimensions;
  var measEnum = enums.measures;
  var cubeEnum = enums.cubes;
  var chartTypeEnum = opts.supportedOnly
    ? allTypeNames().filter(function (t) { return isChartSupported(t); })
    : allTypeNames();

  var schema = buildFullSchema(chartTypeEnum, dimEnum, measEnum, cubeEnum);

  // Add metadata for documentation
  schema.title = 'Dashboard Configuration';
  schema.description =
    'Config for a dashboard backed by cube(s): ' + cubeNames.join(', ') + '. ' +
    'Dimensions: ' + dimEnum.length + ', Measures: ' + measEnum.length + ', ' +
    'Chart types: ' + chartTypeEnum.length + '.';

  return schema;
}

// ── System prompt generator ──────────────────────────────────────────
// Produces a system prompt that gives the LLM full context about the
// cube's fields, their types, known values, and the chart type catalog.
// This is where the semantic intelligence lives — the schema constrains
// structure, the prompt provides meaning.

export function generateSystemPrompt(metaResponse, cubeNames) {
  var cubes = metaResponse && metaResponse.cubes || [];

  // Build dynamic sections
  var cubeCatalogs = buildCubeCatalogs(cubes, cubeNames);
  var lazyClassification = buildLazyClassification(cubes, cubeNames);
  var chartTypes = buildChartTypeCatalog();

  // Load template and inject dynamic sections
  var template = fs.readFileSync(path.resolve(__dirname, '..', 'prompts', 'generator-system.md'), 'utf8');
  return template
    .replace('{{CUBE_CATALOGS}}', cubeCatalogs)
    .replace('{{LAZY_CLASSIFICATION}}', lazyClassification)
    .replace('{{CHART_TYPES}}', chartTypes);
}

// ── Dynamic section builders (used by generateSystemPrompt) ─────────

function buildCubeCatalogs(cubes, cubeNames) {
  var lines = [];
  for (var c = 0; c < cubeNames.length; ++c) {
    var cubeName = cubeNames[c];
    var cube = null;
    for (var i = 0; i < cubes.length; ++i) {
      if (cubes[i].name === cubeName) { cube = cubes[i]; break; }
    }
    if (!cube) continue;

    lines.push('## Cube: ' + cubeName);
    if (cube.title) lines.push('Title: ' + cube.title);
    if (cube.description) lines.push('Description: ' + cube.description.trim());

    var cm = cube.meta || {};
    if (cm.grain) lines.push('Grain: ' + cm.grain + (cm.grain_description ? ' — ' + cm.grain_description : ''));
    if (cm.time_dimension) lines.push('Time dimension: ' + cm.time_dimension);
    if (cm.period) {
      var p = cm.period;
      lines.push('Period: ' + (p.earliest || '?') + ' to ' + (p.latest || 'now') +
        (p.typical_range ? ' (typical: ' + p.typical_range + ')' : ''));
    }
    if (cm.granularity) {
      var g = cm.granularity;
      lines.push('Granularity: ' + (g.available || []).join(', ') + ' (default: ' + (g.default || 'week') + ')');
      if (g.notes) lines.push('  Note: ' + g.notes);
    }
    lines.push('');

    var dims = cube.dimensions || [];
    lines.push('### Dimensions (' + dims.length + ')');
    for (var d = 0; d < dims.length; ++d) {
      var dim = dims[d];
      var shortName = dim.name.split('.').pop();
      var parts = ['- ' + shortName + ': ' + (dim.type || 'string')];
      if (dim.description) parts.push('— ' + dim.description.trim());
      var meta = dim.meta || {};
      if (meta.color_map) {
        parts.push('[values: ' + Object.keys(meta.color_map).join(', ') + ']');
      }
      if (meta.color_scale) {
        var tiers = meta.color_scale.map(function (r) {
          return r.label || (r.gte != null ? '>=' + r.gte : 'default');
        });
        parts.push('[tiers: ' + tiers.join(', ') + ']');
      }
      lines.push(parts.join(' '));
    }
    lines.push('');

    var measures = cube.measures || [];
    lines.push('### Measures (' + measures.length + ')');
    for (var m = 0; m < measures.length; ++m) {
      var meas = measures[m];
      var mShort = meas.name.split('.').pop();
      var mParts = ['- ' + mShort + ': ' + (meas.type || 'number')];
      if (meas.format) mParts.push('(' + meas.format + ')');
      if (meas.description) mParts.push('— ' + meas.description.trim());
      lines.push(mParts.join(' '));
    }
    lines.push('');

    var segs = cube.segments || [];
    if (segs.length > 0) {
      lines.push('### Segments (' + segs.length + ')');
      for (var s = 0; s < segs.length; ++s) {
        var seg = segs[s];
        var sShort = seg.name.split('.').pop();
        var sTitle = seg.title || sShort;
        if (cube.title && sTitle.startsWith(cube.title + ' ')) {
          sTitle = sTitle.slice(cube.title.length + 1);
        }
        var sParts = ['- ' + sShort];
        if (sTitle !== sShort) sParts.push('— ' + sTitle);
        if (seg.description) sParts.push('(' + seg.description.trim() + ')');
        lines.push(sParts.join(' '));
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function buildLazyClassification(cubes, cubeNames) {
  var lines = [];
  lines.push('## Lazy Loading Classification (per cube)');
  lines.push('');
  lines.push('The dashboard engine loads all non-lazy dimensions into ONE query. High-cardinality dimensions cause a Cartesian product explosion.');
  lines.push('Any section containing a high-cardinality dimension MUST have lazy: true. This is MANDATORY — the dashboard will crash without it.');
  lines.push('');

  for (var lc = 0; lc < cubeNames.length; ++lc) {
    var lcCube = null;
    for (var li = 0; li < cubes.length; ++li) {
      if (cubes[li].name === cubeNames[lc]) { lcCube = cubes[li]; break; }
    }
    if (!lcCube) continue;

    // Classify dimensions by cardinality using metadata signals only.
    // No hardcoded field names — this must work for any cube.
    var safeDims = [];
    var lazyDims = [];
    var lcDims = lcCube.dimensions || [];

    for (var ld = 0; ld < lcDims.length; ++ld) {
      var ldim = lcDims[ld];
      var lname = ldim.name.split('.').pop();
      var ltype = ldim.type || 'string';
      var lmeta = ldim.meta || {};

      if (ltype === 'boolean') { safeDims.push(lname); continue; }
      if (ltype === 'time') { safeDims.push(lname); continue; }
      if (lmeta.color_map) {
        var enumCount = Object.keys(lmeta.color_map).length;
        if (enumCount <= 20) { safeDims.push(lname); } else { lazyDims.push(lname); }
        continue;
      }
      if (lmeta.color_scale) { safeDims.push(lname); continue; }
      if (lmeta.cardinality) {
        if (lmeta.cardinality === 'low' || (typeof lmeta.cardinality === 'number' && lmeta.cardinality <= 20)) {
          safeDims.push(lname);
        } else {
          lazyDims.push(lname);
        }
        continue;
      }
      if (ltype === 'number') { lazyDims.push(lname); continue; }
      // String dims: default to lazy (safe default)
      lazyDims.push(lname);
    }

    lines.push('### ' + cubeNames[lc]);
    lines.push('');
    lines.push('**Safe for main query** (low cardinality, <20 values):');
    lines.push(safeDims.join(', '));
    lines.push('');
    lines.push('**MUST be in lazy: true sections** (high cardinality, 30+ values):');
    lines.push(lazyDims.join(', '));
    lines.push('');
    lines.push('If a section contains ANY dimension from the lazy list above, the ENTIRE section must have lazy: true.');
    lines.push('');
  }
  return lines.join('\n');
}

function buildChartTypeCatalog() {
  var lines = [];
  lines.push('## Chart Types');
  lines.push('');

  var families = {};
  var types = allTypeNames();
  for (var t = 0; t < types.length; ++t) {
    var entry = getChartType(types[t]);
    if (!entry) continue;
    if (!families[entry.family]) families[entry.family] = [];
    families[entry.family].push(entry);
  }

  var familyNames = Object.keys(families);
  for (var f = 0; f < familyNames.length; ++f) {
    var familyName = familyNames[f];
    var familyTypes = families[familyName];
    lines.push('### ' + familyName);
    for (var ft = 0; ft < familyTypes.length; ++ft) {
      var fe = familyTypes[ft];
      var slotDesc = fe.slots.map(function (sl) {
        var s = sl.name;
        if (sl.array) s += '[]';
        s += ':' + sl.accepts;
        if (!sl.required) s += '?';
        return s;
      }).join(', ');
      lines.push('- ' + fe.type + ' (' + slotDesc + ')');
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── Schema stats (for checking OpenAI limits) ───────────────────────

export function schemaStats(schema) {
  var propCount = 0;
  var enumCount = 0;
  var enumCharCount = 0;
  var maxObjectDepth = 0;

  function walk(node, objectDepth, visited) {
    if (!node || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);

    // Resolve $defs references
    if (node['$ref'] && schema['$defs']) {
      var refName = node['$ref'].replace('#/$defs/', '');
      if (schema['$defs'][refName]) {
        walk(schema['$defs'][refName], objectDepth, visited);
      }
      return;
    }

    if (node.properties) {
      // This is an object — counts as a nesting level
      if (objectDepth > maxObjectDepth) maxObjectDepth = objectDepth;
      var keys = Object.keys(node.properties);
      propCount += keys.length;
      for (var i = 0; i < keys.length; ++i) {
        walk(node.properties[keys[i]], objectDepth + 1, visited);
      }
    }
    if (node.enum) {
      enumCount += node.enum.length;
      for (var j = 0; j < node.enum.length; ++j) {
        if (node.enum[j] != null) enumCharCount += String(node.enum[j]).length;
      }
    }
    // Array items don't add object depth
    if (node.items) walk(node.items, objectDepth, visited);
    if (node.anyOf) {
      for (var k = 0; k < node.anyOf.length; ++k) {
        walk(node.anyOf[k], objectDepth, visited);
      }
    }
  }

  walk(schema, 1, new Set());

  // Use raised limits (Jan 2026)
  return {
    properties: propCount,
    propertiesLimit: 5000,
    propertiesOk: propCount <= 5000,
    enumValues: enumCount,
    enumLimit: 1000,
    enumOk: enumCount <= 1000,
    enumChars: enumCharCount,
    enumCharsLimit: 120000,
    enumCharsOk: enumCharCount <= 120000,
    maxObjectDepth: maxObjectDepth,
    depthLimit: 5,
    depthOk: maxObjectDepth <= 5,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

async function cli() {
  var fs = await import('node:fs');
  var path = await import('node:path');
  var https = await import('node:https');
  var url = await import('node:url');

  var __dirname = path.dirname(url.fileURLToPath(import.meta.url));
  var ROOT = path.resolve(__dirname, '../..');
  var envPath = path.resolve(ROOT, '.env');

  // Read .env
  var env = {};
  if (fs.existsSync(envPath)) {
    var lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (var i = 0; i < lines.length; ++i) {
      var line = lines[i].trim();
      if (!line || line[0] === '#') continue;
      var eq = line.indexOf('=');
      if (eq <= 0) continue;
      env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }

  var token = env.CUBE_TOKEN || process.env.CUBE_TOKEN || '';
  if (token && !token.startsWith('Bearer ')) token = 'Bearer ' + token;
  var datasourceId = env.CUBE_DATASOURCE || process.env.CUBE_DATASOURCE || '';
  var branchId = env.CUBE_BRANCH || process.env.CUBE_BRANCH || '';

  if (!token || !datasourceId || !branchId) {
    console.error('Missing credentials. Set CUBE_TOKEN, CUBE_DATASOURCE, CUBE_BRANCH in .env');
    process.exit(1);
  }

  // Fetch meta
  var metaResponse = await new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: 'dbx.fraios.dev',
      port: 443,
      path: '/api/v1/meta',
      method: 'GET',
      headers: {
        'Authorization': token,
        'x-hasura-datasource-id': datasourceId,
        'x-hasura-branch-id': branchId,
      },
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
        resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
    req.end();
  });

  // Parse args
  var cubeNames = process.argv.slice(2);
  if (cubeNames.length === 0) {
    cubeNames = ['bluecar_stays'];
  }

  var mode = process.argv.includes('--prompt') ? 'prompt'
           : process.argv.includes('--both') ? 'both'
           : 'schema';

  // Filter cube names from args (skip flags)
  cubeNames = cubeNames.filter(function (n) { return n[0] !== '-'; });
  if (cubeNames.length === 0) cubeNames = ['bluecar_stays'];

  if (mode === 'prompt' || mode === 'both') {
    var prompt = generateSystemPrompt(metaResponse, cubeNames);
    if (mode === 'prompt') {
      console.log(prompt);
      return;
    }
    // both mode: print prompt to stderr so stdout stays clean for schema JSON
    console.error('--- System Prompt (' + prompt.length + ' chars) ---');
    console.error(prompt);
  }

  var schema = generateDashboardSchema(metaResponse, cubeNames);
  var stats = schemaStats(schema);

  console.log(JSON.stringify(schema, null, 2));

  console.error('\n--- Schema Stats ---');
  console.error('Properties: ' + stats.properties + '/' + stats.propertiesLimit +
    (stats.propertiesOk ? ' OK' : ' OVER LIMIT'));
  console.error('Enum values: ' + stats.enumValues + '/' + stats.enumLimit +
    (stats.enumOk ? ' OK' : ' OVER LIMIT'));
  console.error('Enum chars: ' + stats.enumChars + '/' + stats.enumCharsLimit +
    (stats.enumCharsOk ? ' OK' : ' OVER LIMIT'));
  console.error('Object depth: ' + stats.maxObjectDepth + '/' + stats.depthLimit +
    (stats.depthOk ? ' OK' : ' OVER LIMIT'));
}

// Run CLI if executed directly
if (typeof process !== 'undefined' && process.argv[1] &&
    (process.argv[1].includes('generate-schema') || process.argv[1].includes('generate_schema'))) {
  cli().catch(function (err) {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
