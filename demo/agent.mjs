// demo/agent.mjs
// Dashboard builder agent — GPT-5.4 tool-calling loop with nested
// structured output for config generation.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var ROOT = path.resolve(__dirname, '..');
var DRAFT_PATH = path.join(ROOT, 'demo', 'dashboards', '_draft.json');

// ── String distance ─────────────────────────────────────────────────

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  var prev = [];
  var curr = [];
  for (var j = 0; j <= b.length; ++j) prev[j] = j;
  for (var i = 1; i <= a.length; ++i) {
    curr[0] = i;
    for (var k = 1; k <= b.length; ++k) {
      var cost = a[i - 1] === b[k - 1] ? 0 : 1;
      curr[k] = Math.min(curr[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[b.length];
}

function suggestMatch(input, validOptions, label) {
  // 1. Exact substring match
  var matches = validOptions.filter(function (o) {
    return o.indexOf(input) >= 0 || input.indexOf(o) >= 0;
  });
  // 2. Levenshtein distance <= 2
  if (matches.length === 0) {
    matches = validOptions.filter(function (o) {
      return levenshtein(input, o) <= 2;
    });
  }
  if (matches.length > 0) {
    return label + " '" + input + "' not found. Did you mean: " +
      matches.slice(0, 3).join(', ') + '?';
  }
  return label + " '" + input + "' not found. Available: " +
    validOptions.slice(0, 15).join(', ') +
    (validOptions.length > 15 ? ' (' + validOptions.length + ' total)' : '');
}

// ── .env reader ─────────────────────────────────────────────────────
// Note: duplicated from proxy-server.mjs to keep agent.mjs self-contained

function readEnvConfig() {
  var envPath = path.resolve(ROOT, '.env');
  var config = {};
  if (!fs.existsSync(envPath)) return config;
  var lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (var i = 0; i < lines.length; ++i) {
    var trimmed = lines[i].trim();
    if (!trimmed || trimmed[0] === '#') continue;
    var eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    config[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return config;
}

// ── OpenAI API call ─────────────────────────────────────────────────

function callOpenAI(messages, options) {
  var env = readEnvConfig();
  var apiKey = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Promise.reject(new Error('OPENAI_API_KEY not configured. Set it in .env or environment.'));
  }

  var model = (options && options.model) || env.OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4';
  var body = {
    model: model,
    messages: messages,
  };

  if (options && options.tools) {
    body.tools = options.tools;
    body.parallel_tool_calls = false;
    body.tool_choice = 'auto';
  }

  if (options && options.response_format) {
    body.response_format = options.response_format;
  }

  var bodyStr = JSON.stringify(body);
  var timeout = (options && options.timeout) || 120000;

  return new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var raw = Buffer.concat(chunks).toString();
        if (res.statusCode !== 200) {
          reject(new Error('OpenAI ' + res.statusCode + ': ' + raw.slice(0, 300)));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('Invalid JSON from OpenAI: ' + e.message));
        }
      });
    });
    req.setTimeout(timeout, function () {
      req.destroy(new Error('OpenAI request timeout (' + (timeout / 1000) + 's)'));
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Cube metadata ───────────────────────────────────────────────────

var CUBE_META_API = 'https://dbx.fraios.dev/api/v1/meta';

function loadCubeMeta(metaResponse) {
  // If passed directly (from proxy-server cached version), use it
  if (metaResponse) return Promise.resolve(metaResponse);

  // Try cached file
  var metaCachePath = path.join(ROOT, '.cache', 'cube-meta.json');
  try {
    if (fs.existsSync(metaCachePath)) {
      return Promise.resolve(JSON.parse(fs.readFileSync(metaCachePath, 'utf8')));
    }
  } catch (_) {}

  // Live fetch
  var env = readEnvConfig();
  var token = env.CUBE_TOKEN || process.env.CUBE_TOKEN || '';
  if (token && !token.startsWith('Bearer ')) token = 'Bearer ' + token;
  var datasourceId = env.CUBE_DATASOURCE || process.env.CUBE_DATASOURCE || '';
  var branchId = env.CUBE_BRANCH || process.env.CUBE_BRANCH || '';

  if (!token || !datasourceId || !branchId) {
    return Promise.reject(new Error(
      'Cube metadata not available. Either cache .cache/cube-meta.json or set CUBE_TOKEN, CUBE_DATASOURCE, CUBE_BRANCH in .env.'
    ));
  }

  return new Promise(function (resolve, reject) {
    var req = https.request({
      hostname: new URL(CUBE_META_API).hostname,
      port: 443, path: new URL(CUBE_META_API).pathname, method: 'GET',
      headers: {
        'Authorization': token,
        'x-hasura-datasource-id': datasourceId,
        'x-hasura-branch-id': branchId,
      },
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        if (res.statusCode !== 200) { reject(new Error('Meta fetch HTTP ' + res.statusCode)); return; }
        var parsed = JSON.parse(Buffer.concat(chunks).toString());
        fs.mkdirSync(path.dirname(metaCachePath), { recursive: true });
        fs.writeFileSync(metaCachePath, JSON.stringify(parsed));
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, function () { req.destroy(new Error('Meta fetch timeout')); });
    req.end();
  });
}

function findCube(metaResponse, cubeName) {
  var cubes = metaResponse && metaResponse.cubes || [];
  for (var i = 0; i < cubes.length; ++i) {
    if (cubes[i].name === cubeName) return cubes[i];
  }
  return null;
}

function allCubeNames(metaResponse) {
  return (metaResponse && metaResponse.cubes || []).map(function (c) { return c.name; });
}

// ── Tool definitions ────────────────────────────────────────────────

var TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_cubes',
      description: 'List all available data cubes with their name, title, description, and field counts. Call this first to discover what data is available.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_cube',
      description: 'Get the full field catalog for a cube: all dimensions (with types, descriptions, color maps), all measures (with aggregation type and format), all segments, and cube-level metadata (grain, period, granularity). Call this before generate_dashboard to understand what fields are available.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          cube_name: {
            type: 'string',
            description: 'The exact cube name from list_cubes results.',
          },
        },
        required: ['cube_name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_chart_support',
      description: 'List supported chart types with their data slot requirements. Returns which chart types have working renderers and what data fields each requires. Optionally filter by chart family.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          family: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Filter by chart family: category, time, numeric, single, hierarchy, relation, specialized, tabular, control, geo. Null for all families.',
          },
        },
        required: ['family'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_cube',
      description: 'Run a Cube.dev analytics query to answer data questions — check cardinality, date ranges, distributions, top-N values. Use dimension and measure short names (e.g. "region", "count"), not fully qualified names.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          cube_name: { type: 'string', description: 'The cube to query.' },
          dimensions: {
            type: 'array', items: { type: 'string' },
            description: 'Dimension short names to group by. Empty array for totals only.',
          },
          measures: {
            type: 'array', items: { type: 'string' },
            description: 'Measure short names to aggregate. At least one is required.',
          },
          filters: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    member: { type: 'string', description: 'Dimension or measure short name to filter on.' },
                    operator: {
                      type: 'string',
                      enum: ['equals', 'notEquals', 'contains', 'notContains', 'gt', 'gte', 'lt', 'lte', 'inDateRange', 'beforeDate', 'afterDate'],
                      description: 'Filter operator.',
                    },
                    values: { type: 'array', items: { type: 'string' }, description: 'Filter values as strings.' },
                  },
                  required: ['member', 'operator', 'values'],
                  additionalProperties: false,
                },
              },
              { type: 'null' },
            ],
            description: 'Filters to apply. Null for no filters.',
          },
          limit: { anyOf: [{ type: 'integer' }, { type: 'null' }], description: 'Max rows returned. Default 100, max 1000. Null for default.' },
          order: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Sort field and direction as "field_name:asc" or "field_name:desc". Null for default order.',
          },
        },
        required: ['cube_name', 'dimensions', 'measures', 'filters', 'limit', 'order'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_dashboard',
      description: 'Create or update a dashboard config. Makes a specialized LLM call with the full schema and design guidelines. Returns a guaranteed-valid config and auto-saves it as a draft for preview. For updates, pass current_config: "CURRENT" to modify the last generated config.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          cube_name: { type: 'string', description: 'The cube to build the dashboard for. Must match a name from list_cubes.' },
          title: { type: 'string', description: 'Dashboard title, e.g. "Fleet Overview" or "Tourism Patterns".' },
          purpose: { type: 'string', description: 'What the dashboard should show, which dimensions/measures to focus on, and any specific chart preferences. Be detailed — this drives the entire generation.' },
          current_config: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Pass "CURRENT" to update the last generated config. Pass null to create a new dashboard from scratch.' },
        },
        required: ['cube_name', 'title', 'purpose', 'current_config'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_draft',
      description: 'Save a dashboard config to the draft file for preview. In most cases generate_dashboard auto-saves, so this is only needed for saving manually edited configs.',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            enum: ['CURRENT', 'CUSTOM'],
            description: 'CURRENT: save the last generated config. CUSTOM: save the config provided in custom_config.',
          },
          custom_config: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'When source is CUSTOM: the full dashboard config as a JSON string. Null when source is CURRENT.',
          },
        },
        required: ['source', 'custom_config'],
        additionalProperties: false,
      },
    },
  },
];

// ── Tool implementations ────────────────────────────────────────────

function toolListCubes(args, ctx) {
  var cubes = ctx.metaResponse && ctx.metaResponse.cubes || [];
  return JSON.stringify({
    cubes: cubes.map(function (c) {
      var meta = c.meta || {};
      return {
        name: c.name,
        title: c.title || c.name,
        description: meta.grain_description || c.description || '',
        grain: meta.grain || null,
        dimensions: (c.dimensions || []).length,
        measures: (c.measures || []).length,
        segments: (c.segments || []).length,
      };
    }),
  });
}

function toolDescribeCube(args, ctx) {
  var cube = findCube(ctx.metaResponse, args.cube_name);
  if (!cube) {
    return suggestMatch(args.cube_name, allCubeNames(ctx.metaResponse), 'Cube');
  }

  var meta = cube.meta || {};
  var dims = (cube.dimensions || []).map(function (d) {
    var shortName = d.name.split('.').pop();
    var dm = d.meta || {};
    return {
      name: shortName,
      type: d.type || 'string',
      description: d.description || '',
      color_map: dm.color_map || null,
      color_scale: dm.color_scale || null,
    };
  });

  var measures = (cube.measures || []).map(function (m) {
    var mShort = m.name.split('.').pop();
    return {
      name: mShort,
      type: m.type || 'number',
      agg: m.aggType || '',
      format: m.format || '',
      description: m.description || '',
    };
  });

  var segments = (cube.segments || []).map(function (s) {
    var sShort = s.name.split('.').pop();
    var sTitle = s.title || sShort;
    if (cube.title && sTitle.startsWith(cube.title + ' ')) {
      sTitle = sTitle.slice(cube.title.length + 1);
    }
    return { name: sShort, title: sTitle, description: s.description || '' };
  });

  return JSON.stringify({
    name: cube.name,
    title: cube.title || cube.name,
    grain: meta.grain || null,
    grain_description: meta.grain_description || null,
    time_dimension: meta.time_dimension || null,
    period: meta.period || null,
    granularity: meta.granularity || null,
    dimensions: dims,
    measures: measures,
    segments: segments,
  });
}

function toolGetChartSupport(args, ctx) {
  var allTypes = ctx.chartTypes.allTypeNames();
  var families = ctx.chartTypes.allFamilies();

  if (args.family != null) {
    if (families.indexOf(args.family) < 0) {
      return "Family '" + args.family + "' not found. Available families: " + families.join(', ') + '.';
    }
  }

  var supported = [];
  var unsupported = [];

  for (var i = 0; i < allTypes.length; ++i) {
    var typeName = allTypes[i];
    var entry = ctx.chartTypes.getChartType(typeName);
    if (!entry) continue;
    if (args.family != null && entry.family !== args.family) continue;

    if (ctx.chartSupport.isChartSupported(typeName)) {
      var slotDesc = entry.slots.map(function (s) {
        var desc = s.name + ':' + s.accepts;
        if (s.array) desc += '[]';
        desc += s.required ? '!' : '?';
        return desc;
      }).join(', ');
      supported.push({ type: typeName, family: entry.family, slots: slotDesc });
    } else {
      unsupported.push(typeName);
    }
  }

  var familyLabel = args.family ? ' in ' + args.family + ' family' : '';
  return JSON.stringify({
    supported: supported,
    unsupported: unsupported,
    summary: supported.length + ' supported, ' + unsupported.length + ' unsupported' + familyLabel,
  });
}

function toolQueryCube(args, ctx) {
  var cube = findCube(ctx.metaResponse, args.cube_name);
  if (!cube) {
    return Promise.resolve(suggestMatch(args.cube_name, allCubeNames(ctx.metaResponse), 'Cube'));
  }

  // Build field lookup: short name → full name
  var dimLookup = {};
  var measLookup = {};
  var allFields = {};
  (cube.dimensions || []).forEach(function (d) {
    var short = d.name.split('.').pop();
    dimLookup[short] = d.name;
    allFields[short] = d.name;
  });
  (cube.measures || []).forEach(function (m) {
    var short = m.name.split('.').pop();
    measLookup[short] = m.name;
    allFields[short] = m.name;
  });

  // Validate dimension names
  var fullDims = [];
  for (var di = 0; di < args.dimensions.length; ++di) {
    var dName = args.dimensions[di];
    if (!dimLookup[dName]) {
      return Promise.resolve(suggestMatch(dName, Object.keys(dimLookup), 'Dimension'));
    }
    fullDims.push(dimLookup[dName]);
  }

  // Validate measure names
  var fullMeas = [];
  for (var mi = 0; mi < args.measures.length; ++mi) {
    var mName = args.measures[mi];
    if (!measLookup[mName]) {
      return Promise.resolve(suggestMatch(mName, Object.keys(measLookup), 'Measure'));
    }
    fullMeas.push(measLookup[mName]);
  }

  if (fullMeas.length === 0) {
    return Promise.resolve('At least one measure is required. Available measures: ' +
      Object.keys(measLookup).slice(0, 15).join(', '));
  }

  // Build Cube.dev query
  var cubeQuery = {
    dimensions: fullDims,
    measures: fullMeas,
    limit: Math.min(args.limit || 100, 1000),
  };

  // Translate filters
  if (args.filters && args.filters.length > 0) {
    cubeQuery.filters = [];
    for (var fi = 0; fi < args.filters.length; ++fi) {
      var f = args.filters[fi];
      var fullName = allFields[f.member];
      if (!fullName) {
        return Promise.resolve(suggestMatch(f.member, Object.keys(allFields), 'Field'));
      }
      cubeQuery.filters.push({ member: fullName, operator: f.operator, values: f.values });
    }
  }

  // Translate order (string format: "field_name:asc" or "field_name:desc")
  if (args.order) {
    var orderParts = args.order.split(':');
    var oField = orderParts[0];
    var oDir = orderParts[1] || 'desc';
    if (!allFields[oField]) {
      return Promise.resolve(suggestMatch(oField, Object.keys(allFields), 'Field'));
    }
    cubeQuery.order = {};
    cubeQuery.order[allFields[oField]] = oDir;
  }

  // Execute via Cube.dev API
  var env = readEnvConfig();
  var token = env.CUBE_TOKEN || process.env.CUBE_TOKEN || '';
  if (token && !token.startsWith('Bearer ')) token = 'Bearer ' + token;
  var datasourceId = env.CUBE_DATASOURCE || process.env.CUBE_DATASOURCE || '';
  var branchId = env.CUBE_BRANCH || process.env.CUBE_BRANCH || '';

  if (!token || !datasourceId || !branchId) {
    return Promise.resolve('Cube query requires live credentials. Set CUBE_TOKEN, CUBE_DATASOURCE, CUBE_BRANCH in .env.');
  }

  var bodyStr = JSON.stringify({ query: cubeQuery });
  var startTime = Date.now();

  return new Promise(function (resolve) {
    var req = https.request({
      hostname: 'dbx.fraios.dev',
      port: 443, path: '/api/v1/load', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'x-hasura-datasource-id': datasourceId,
        'x-hasura-branch-id': branchId,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, function (res) {
      var chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        var elapsed = Date.now() - startTime;
        if (res.statusCode !== 200) {
          var errBody = Buffer.concat(chunks).toString().slice(0, 300);
          resolve('Cube query failed (HTTP ' + res.statusCode + '): ' + errBody +
            '. Try simplifying: reduce dimensions or add filters.');
          return;
        }
        try {
          var parsed = JSON.parse(Buffer.concat(chunks).toString());
          var data = parsed.data || [];
          // Map fully qualified keys back to short names
          var rows = data.map(function (row) {
            var mapped = {};
            var keys = Object.keys(row);
            for (var k = 0; k < keys.length; ++k) {
              var short = keys[k].split('.').pop();
              mapped[short] = row[keys[k]];
            }
            return mapped;
          });
          var limit = cubeQuery.limit;
          resolve(JSON.stringify({
            rows: rows,
            rowCount: rows.length,
            truncated: rows.length >= limit,
            query_time_ms: elapsed,
          }));
        } catch (e) {
          resolve('Cube query response parse error: ' + e.message);
        }
      });
    });
    req.setTimeout(30000, function () {
      req.destroy();
      resolve('Cube query timed out after 30s. Try adding a filter to reduce data volume or use fewer dimensions.');
    });
    req.on('error', function (err) {
      resolve('Cube query error: ' + err.message);
    });
    req.write(bodyStr);
    req.end();
  });
}
