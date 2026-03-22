#!/usr/bin/env node
/**
 * Fetch Cube.dev model metadata for the demo datasource ("bluecar").
 *
 * Reads credentials from .env (CUBE_TOKEN, CUBE_DATASOURCE, CUBE_BRANCH)
 * and hits https://dbx.fraios.dev/api/v1/meta to retrieve the full
 * semantic model: cubes, dimensions, measures, joins, and meta annotations.
 *
 * Usage:
 *   node demo/fetch-cube-meta.mjs                  # pretty-print summary
 *   node demo/fetch-cube-meta.mjs --raw             # dump full JSON
 *   node demo/fetch-cube-meta.mjs --cube <name>     # show single cube detail
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var ROOT = path.resolve(__dirname, '..');
var ENV_PATH = path.resolve(ROOT, '.env');
var CUBE_HOST = 'dbx.fraios.dev';
var CUBE_META_PATH = '/api/v1/meta';

// ---------------------------------------------------------------------------
// .env reader
// ---------------------------------------------------------------------------

function readEnv() {
  var config = {};
  if (!fs.existsSync(ENV_PATH)) return config;
  for (var line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    var trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    var eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return config;
}

function withBearer(token) {
  if (!token) return '';
  return token.startsWith('Bearer ') ? token : 'Bearer ' + token;
}

// ---------------------------------------------------------------------------
// HTTPS fetch
// ---------------------------------------------------------------------------

function fetchMeta(auth) {
  return new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: CUBE_HOST,
      port: 443,
      path: CUBE_META_PATH,
      method: 'GET',
      headers: {
        'Authorization': auth.token,
        'x-hasura-datasource-id': auth.datasourceId,
        'x-hasura-branch-id': auth.branchId,
      },
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 500)));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, function () {
      req.destroy(new Error('Request timed out'));
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function dimType(dim) {
  var t = dim.type || 'string';
  if (dim.meta && dim.meta.color_map) t += ' [color_map]';
  if (dim.meta && dim.meta.color_scale) t += ' [color_scale]';
  return t;
}

function printCubeSummary(cube) {
  var dims = cube.dimensions || [];
  var measures = cube.measures || [];
  var segments = cube.segments || [];
  var joins = cube.joins || [];

  console.log('\n' + '='.repeat(72));
  console.log('  CUBE: ' + cube.name);
  if (cube.title) console.log('  Title: ' + cube.title);
  if (cube.description) console.log('  Description: ' + cube.description);
  console.log('='.repeat(72));

  if (dims.length) {
    console.log('\n  Dimensions (' + dims.length + '):');
    console.log('  ' + '-'.repeat(68));
    for (var i = 0; i < dims.length; ++i) {
      var d = dims[i];
      var shortName = d.name.split('.').pop();
      var line = '    ' + shortName.padEnd(40) + dimType(d);
      console.log(line);
      if (d.description) console.log('      ' + d.description);
      if (d.meta) {
        var metaKeys = Object.keys(d.meta);
        for (var mk = 0; mk < metaKeys.length; ++mk) {
          var mkey = metaKeys[mk];
          var mval = d.meta[mkey];
          if (typeof mval === 'object') {
            console.log('      meta.' + mkey + ': ' + JSON.stringify(mval));
          } else {
            console.log('      meta.' + mkey + ': ' + mval);
          }
        }
      }
    }
  }

  if (measures.length) {
    console.log('\n  Measures (' + measures.length + '):');
    console.log('  ' + '-'.repeat(68));
    for (var j = 0; j < measures.length; ++j) {
      var m = measures[j];
      var mShort = m.name.split('.').pop();
      var mLine = '    ' + mShort.padEnd(40) + (m.type || m.aggType || '');
      console.log(mLine);
      if (m.description) console.log('      ' + m.description);
      if (m.format) console.log('      format: ' + m.format);
    }
  }

  if (segments.length) {
    console.log('\n  Segments (' + segments.length + '):');
    for (var s = 0; s < segments.length; ++s) {
      console.log('    ' + segments[s].name.split('.').pop());
    }
  }

  if (joins.length) {
    console.log('\n  Joins (' + joins.length + '):');
    for (var k = 0; k < joins.length; ++k) {
      var jn = joins[k];
      console.log('    -> ' + jn.name + ' (' + (jn.relationship || '') + ')');
    }
  }
}

function printOverview(meta) {
  var cubes = meta.cubes || [];
  console.log('\nCube.dev Model Metadata — ' + CUBE_HOST);
  console.log('Datasource: demo (bluecar)');
  console.log('Cubes found: ' + cubes.length);

  for (var i = 0; i < cubes.length; ++i) {
    var c = cubes[i];
    var nDims = (c.dimensions || []).length;
    var nMeasures = (c.measures || []).length;
    console.log('  ' + (i + 1) + '. ' + c.name + '  (' + nDims + ' dims, ' + nMeasures + ' measures)');
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main() {
  var args = process.argv.slice(2);
  var raw = args.includes('--raw');
  var cubeIdx = args.indexOf('--cube');
  var cubeFilter = cubeIdx >= 0 ? args[cubeIdx + 1] : null;

  var env = readEnv();
  var auth = {
    token: withBearer(env.CUBE_TOKEN || process.env.CUBE_TOKEN || ''),
    datasourceId: env.CUBE_DATASOURCE || process.env.CUBE_DATASOURCE || '',
    branchId: env.CUBE_BRANCH || process.env.CUBE_BRANCH || '',
  };

  if (!auth.token || !auth.datasourceId || !auth.branchId) {
    console.error('Missing credentials. Set CUBE_TOKEN, CUBE_DATASOURCE, CUBE_BRANCH in .env');
    process.exit(1);
  }

  console.log('Fetching model metadata from https://' + CUBE_HOST + CUBE_META_PATH + ' ...');
  var meta = await fetchMeta(auth);

  if (raw) {
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  var cubes = meta.cubes || [];

  if (cubeFilter) {
    var found = cubes.filter(function (c) {
      return c.name === cubeFilter || c.name.includes(cubeFilter);
    });
    if (!found.length) {
      console.error('No cube matching "' + cubeFilter + '". Available: ' + cubes.map(function (c) { return c.name; }).join(', '));
      process.exit(1);
    }
    for (var i = 0; i < found.length; ++i) printCubeSummary(found[i]);
    return;
  }

  printOverview(meta);
  for (var j = 0; j < cubes.length; ++j) printCubeSummary(cubes[j]);
}

main().catch(function (err) {
  console.error('Error: ' + err.message);
  process.exit(1);
});
