#!/usr/bin/env node
/**
 * Test: generate a dashboard config via OpenAI structured output.
 *
 * Reads cube metadata (live or cached), builds the JSON Schema + system
 * prompt, calls OpenAI, validates the result, and prints the config.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node demo/schema/test-openai-call.mjs
 *   OPENAI_API_KEY=sk-... node demo/schema/test-openai-call.mjs "travel patterns dashboard"
 *
 * Env vars:
 *   OPENAI_API_KEY  — required
 *   OPENAI_MODEL    — optional, defaults to gpt-4o
 *   CUBE_META_FILE  — optional, path to cached /api/meta JSON
 */

import { generateDashboardSchema, generateSystemPrompt, schemaStats } from './generate-schema.js';
import { validateSlots, getChartType, allSlots } from '../chart-types.js';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var ROOT = path.resolve(__dirname, '../..');

// ── Load cube metadata ──────────────────────────────────────────────

async function loadCubeMeta() {
  // Try cached file first
  var cachedPath = process.env.CUBE_META_FILE || '/tmp/cube-meta.json';
  if (fs.existsSync(cachedPath)) {
    console.error('[meta] Using cached: ' + cachedPath);
    return JSON.parse(fs.readFileSync(cachedPath, 'utf8'));
  }

  // Fall back to live fetch
  console.error('[meta] Fetching live from dbx.fraios.dev...');
  var env = readEnv();
  var token = env.CUBE_TOKEN || process.env.CUBE_TOKEN || '';
  if (token && !token.startsWith('Bearer ')) token = 'Bearer ' + token;
  var datasourceId = env.CUBE_DATASOURCE || process.env.CUBE_DATASOURCE || '';
  var branchId = env.CUBE_BRANCH || process.env.CUBE_BRANCH || '';

  return new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: 'dbx.fraios.dev', port: 443, path: '/api/v1/meta', method: 'GET',
      headers: { 'Authorization': token, 'x-hasura-datasource-id': datasourceId, 'x-hasura-branch-id': branchId },
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        if (res.statusCode !== 200) { reject(new Error('Meta HTTP ' + res.statusCode)); return; }
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readEnv() {
  var envPath = path.resolve(ROOT, '.env');
  var config = {};
  if (!fs.existsSync(envPath)) return config;
  for (var line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    var t = line.trim();
    if (!t || t[0] === '#') continue;
    var eq = t.indexOf('=');
    if (eq <= 0) continue;
    config[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return config;
}

// ── OpenAI call ─────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userPrompt, schema, model) {
  var env = readEnv();
  var apiKey = process.env.OPENAI_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set (check .env or environment)');

  var body = JSON.stringify({
    model: model || process.env.OPENAI_MODEL || 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'dashboard_config',
        strict: true,
        schema: schema,
      },
    },
  });

  return new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body),
      },
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          reject(new Error('OpenAI HTTP ' + res.statusCode + ': ' + raw.slice(0, 500)));
          return;
        }
        try {
          var parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (e) {
          reject(new Error('Invalid JSON from OpenAI: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, function () {
      req.destroy(new Error('OpenAI request timeout (120s)'));
    });
    req.write(body);
    req.end();
  });
}

// ── Validate generated config ───────────────────────────────────────

function validateConfig(config, metaResponse, cubeNames) {
  var errors = [];

  // Check top-level structure
  if (!config.title) errors.push({ path: 'title', error: 'missing', message: 'Title is required' });
  if (!Array.isArray(config.cubes) || config.cubes.length === 0) {
    errors.push({ path: 'cubes', error: 'missing', message: 'At least one cube is required' });
  }
  if (!Array.isArray(config.sections) || config.sections.length === 0) {
    errors.push({ path: 'sections', error: 'missing', message: 'At least one section is required' });
  }

  // Build field lookup from meta
  var validDims = {};
  var validMeasures = {};
  var cubes = metaResponse.cubes || [];
  for (var cn = 0; cn < cubeNames.length; ++cn) {
    var cube = cubes.find(function (c) { return c.name === cubeNames[cn]; });
    if (!cube) continue;
    (cube.dimensions || []).forEach(function (d) { validDims[d.name.split('.').pop()] = true; });
    (cube.measures || []).forEach(function (m) { validMeasures[m.name.split('.').pop()] = true; });
  }
  var validFields = Object.assign({}, validDims, validMeasures);

  // Validate sections and panels
  var sectionIds = {};
  var sections = config.sections || [];
  for (var s = 0; s < sections.length; ++s) {
    var section = sections[s];
    var sPath = 'sections[' + s + ']';

    if (!section.id) errors.push({ path: sPath + '.id', error: 'missing', message: 'Section id is required' });
    if (sectionIds[section.id]) {
      errors.push({ path: sPath + '.id', error: 'duplicate', message: 'Duplicate section id: ' + section.id });
    }
    sectionIds[section.id] = true;

    var panels = section.panels || [];
    for (var p = 0; p < panels.length; ++p) {
      var panel = panels[p];
      var pPath = sPath + '.panels[' + p + ']';
      var label = panel.label || panel.chart || 'unnamed';

      // Validate field references
      if (panel.dimension && !validDims[panel.dimension]) {
        errors.push({
          path: pPath + '.dimension', panel: label, error: 'unknown_field',
          message: 'Dimension "' + panel.dimension + '" not found in cube',
          hint: 'Available dimensions: ' + Object.keys(validDims).slice(0, 10).join(', ') + '...',
        });
      }
      if (panel.measure && !validMeasures[panel.measure]) {
        errors.push({
          path: pPath + '.measure', panel: label, error: 'unknown_field',
          message: 'Measure "' + panel.measure + '" not found in cube',
          hint: 'Available measures: ' + Object.keys(validMeasures).slice(0, 10).join(', ') + '...',
        });
      }

      // Validate slot fields against chart type
      var chartType = panel.chart || 'bar';
      var entry = getChartType(chartType);
      if (panel.chart && !entry) {
        errors.push({
          path: pPath + '.chart', panel: label, error: 'unknown_chart_type',
          message: 'Unknown chart type: ' + panel.chart,
        });
        continue;
      }

      // Check slot field references exist in cube
      var slotDefs = entry ? allSlots(chartType) : [];
      for (var sl = 0; sl < slotDefs.length; ++sl) {
        var slotDef = slotDefs[sl];
        var slotVal = panel[slotDef.name];
        if (slotVal == null) continue;

        if (Array.isArray(slotVal)) {
          for (var sv = 0; sv < slotVal.length; ++sv) {
            if (!validFields[slotVal[sv]]) {
              errors.push({
                path: pPath + '.' + slotDef.name + '[' + sv + ']', panel: label,
                error: 'unknown_field',
                message: 'Field "' + slotVal[sv] + '" not found in cube (slot: ' + slotDef.name + ')',
              });
            }
          }
        } else if (typeof slotVal === 'string' && !validFields[slotVal]) {
          errors.push({
            path: pPath + '.' + slotDef.name, panel: label,
            error: 'unknown_field',
            message: 'Field "' + slotVal + '" not found in cube (slot: ' + slotDef.name + ')',
          });
        }
      }

      // Check required slots are filled
      if (entry) {
        var fieldMap = {};
        for (var sd = 0; sd < slotDefs.length; ++sd) {
          var sn = slotDefs[sd].name;
          // Map simple panel fields to slot names
          if (sn === 'category' || sn === 'name' || sn === 'x' || sn === 'date') {
            fieldMap[sn] = panel[sn] || panel.dimension;
          } else if (sn === 'value' || sn === 'y') {
            fieldMap[sn] = panel[sn] || panel.measure;
          } else {
            fieldMap[sn] = panel[sn];
          }
        }
        var validation = validateSlots(chartType, fieldMap);
        if (!validation.valid) {
          for (var ve = 0; ve < validation.errors.length; ++ve) {
            errors.push({ path: pPath, panel: label, error: 'slot_validation', message: validation.errors[ve] });
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors: errors };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  var cubeNames = ['bluecar_stays'];
  var userPrompt = process.argv[2] || 'Create a comprehensive tourism analytics dashboard showing stay patterns, vehicle fleet breakdown, geographic distribution, and POI analysis. Include KPIs, time series, categorical breakdowns, and filter controls.';

  console.error('=== Dashboard Config Generator Test ===\n');
  console.error('[prompt] ' + userPrompt + '\n');

  // 1. Load cube metadata
  var metaResponse = await loadCubeMeta();

  // 2. Generate schema + prompt
  var schema = generateDashboardSchema(metaResponse, cubeNames);
  var systemPrompt = generateSystemPrompt(metaResponse, cubeNames);
  var stats = schemaStats(schema);

  console.error('[schema] Properties: ' + stats.properties + ', Enums: ' + stats.enumValues +
    ', Depth: ' + stats.maxObjectDepth);
  console.error('[prompt] ' + systemPrompt.length + ' chars');

  // 3. Call OpenAI
  console.error('[openai] Calling API...');
  var startTime = Date.now();
  var response = await callOpenAI(systemPrompt, userPrompt, schema);
  var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  var usage = response.usage || {};
  console.error('[openai] Done in ' + elapsed + 's — ' +
    (usage.prompt_tokens || '?') + ' prompt + ' +
    (usage.completion_tokens || '?') + ' completion tokens');

  // 4. Extract the config
  var choice = response.choices && response.choices[0];
  if (!choice) throw new Error('No choices in response');

  if (choice.finish_reason !== 'stop') {
    console.error('[openai] WARNING: finish_reason = ' + choice.finish_reason);
  }
  if (choice.message && choice.message.refusal) {
    throw new Error('Model refused: ' + choice.message.refusal);
  }

  var configJson = choice.message && choice.message.content;
  if (!configJson) throw new Error('No content in response');

  var config;
  try {
    config = JSON.parse(configJson);
  } catch (e) {
    console.error('[openai] Raw response:\n' + configJson.slice(0, 1000));
    throw new Error('Failed to parse config JSON: ' + e.message);
  }

  // 5. Validate
  console.error('\n[validate] Checking generated config...');
  var validation = validateConfig(config, metaResponse, cubeNames);

  if (validation.valid) {
    console.error('[validate] PASSED — config is valid');
  } else {
    console.error('[validate] FAILED — ' + validation.errors.length + ' error(s):');
    for (var i = 0; i < validation.errors.length; ++i) {
      var err = validation.errors[i];
      console.error('  ' + err.path + ': ' + err.message);
      if (err.hint) console.error('    hint: ' + err.hint);
    }
  }

  // 6. Summary
  var sectionCount = (config.sections || []).length;
  var panelCount = (config.sections || []).reduce(function (sum, s) {
    return sum + (s.panels || []).length;
  }, 0);
  console.error('\n[result] "' + config.title + '" — ' + sectionCount + ' sections, ' + panelCount + ' panels');

  // 7. Print the config to stdout
  console.log(JSON.stringify(config, null, 2));
}

main().catch(function (err) {
  console.error('\n[ERROR] ' + err.message);
  process.exit(1);
});
