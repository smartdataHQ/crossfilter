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
// Metadata is loaded by proxy-server.mjs and passed to runAgentLoop.

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

function toolGenerateDashboard(args, ctx) {
  var cube = findCube(ctx.metaResponse, args.cube_name);
  if (!cube) {
    return Promise.resolve(suggestMatch(args.cube_name, allCubeNames(ctx.metaResponse), 'Cube'));
  }

  // Resolve "CURRENT" sentinel
  var currentConfig = null;
  if (args.current_config === 'CURRENT') {
    if (!ctx.currentConfig) {
      return Promise.resolve(
        'No current config to update. Call generate_dashboard with current_config: null to create a new dashboard first.'
      );
    }
    currentConfig = ctx.currentConfig;
  } else if (args.current_config != null) {
    try {
      currentConfig = JSON.parse(args.current_config);
    } catch (e) {
      return Promise.resolve('current_config is not valid JSON: ' + e.message);
    }
  }

  // Build inner call messages
  var systemPrompt = ctx.generateSystemPrompt(ctx.metaResponse, [args.cube_name]);
  var userContent;
  if (currentConfig) {
    userContent = 'Current dashboard config:\n' + JSON.stringify(currentConfig, null, 2) +
      '\n\nUpdate this dashboard titled "' + args.title + '". Changes requested: ' + args.purpose;
  } else {
    userContent = 'Create a dashboard titled "' + args.title + '" for the "' + args.cube_name +
      '" cube. Purpose: ' + args.purpose;
  }

  var schema = ctx.generateDashboardSchema(ctx.metaResponse, [args.cube_name], { supportedOnly: true });

  return callOpenAI(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'dashboard_config', strict: true, schema: schema },
      },
      timeout: 120000,
    }
  ).then(function (response) {
    var choice = response.choices && response.choices[0];
    if (!choice || !choice.message) {
      return 'No response from config generator.';
    }
    if (choice.message.refusal) {
      return 'Model refused to generate config. Reason: ' + choice.message.refusal + '. Try rephrasing the purpose.';
    }

    var config;
    try {
      config = JSON.parse(choice.message.content);
    } catch (e) {
      return 'Generated config failed to parse. Error: ' + e.message + '. Retrying may help.';
    }

    // Auto-save to _draft.json
    fs.writeFileSync(DRAFT_PATH, JSON.stringify(config, null, 2));

    // Update context
    ctx.currentConfig = config;

    // Track inner call usage
    var usage = response.usage || {};
    ctx.usage.prompt_tokens += usage.prompt_tokens || 0;
    ctx.usage.completion_tokens += usage.completion_tokens || 0;

    var sections = (config.sections || []).length;
    var panels = (config.sections || []).reduce(function (s, sec) { return s + (sec.panels || []).length; }, 0);

    return JSON.stringify({
      config_summary: '"' + config.title + '" — ' + sections + ' sections, ' + panels + ' panels',
      sections: sections,
      panels: panels,
      tokens: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0 },
      saved: { url: '/demo/dashboards/_draft' },
    });
  }).catch(function (err) {
    if (err.message.indexOf('timeout') >= 0) {
      return 'Config generation timed out after 120s. Try a simpler purpose or fewer requirements.';
    }
    return 'Config generation failed: ' + err.message;
  });
}

function toolSaveDraft(args, ctx) {
  var config;

  if (args.source === 'CURRENT') {
    if (!ctx.currentConfig) {
      return 'No current config to save. Call generate_dashboard first.';
    }
    config = ctx.currentConfig;
  } else if (args.source === 'CUSTOM') {
    if (!args.custom_config) {
      return 'source is CUSTOM but custom_config is null. Provide the config JSON string.';
    }
    try {
      config = JSON.parse(args.custom_config);
    } catch (e) {
      return 'Config is not valid JSON: ' + e.message + '. The config must be a JSON object.';
    }
    var required = ['title', 'cubes', 'sharedFilters', 'sections'];
    for (var i = 0; i < required.length; ++i) {
      if (config[required[i]] == null) {
        return 'Config is missing required field "' + required[i] +
          '". A valid config must have: title (string), cubes (array), sharedFilters (array), sections (array).';
      }
    }
    ctx.currentConfig = config;
  } else {
    return 'source must be "CURRENT" or "CUSTOM". Got: "' + args.source + '".';
  }

  fs.writeFileSync(DRAFT_PATH, JSON.stringify(config, null, 2));

  var sections = (config.sections || []).length;
  var panels = (config.sections || []).reduce(function (s, sec) { return s + (sec.panels || []).length; }, 0);

  return JSON.stringify({
    saved: true,
    url: '/demo/dashboards/_draft',
    title: config.title || 'Untitled',
    sections: sections,
    panels: panels,
  });
}

// ── Tool dispatch ───────────────────────────────────────────────────

function executeToolCall(name, argsStr, ctx) {
  var args;
  try {
    args = JSON.parse(argsStr);
  } catch (e) {
    return Promise.resolve('Invalid tool arguments: ' + e.message + '. Arguments must be valid JSON.');
  }

  switch (name) {
    case 'list_cubes': return Promise.resolve(toolListCubes(args, ctx));
    case 'describe_cube': return Promise.resolve(toolDescribeCube(args, ctx));
    case 'get_chart_support': return Promise.resolve(toolGetChartSupport(args, ctx));
    case 'query_cube': return toolQueryCube(args, ctx);
    case 'generate_dashboard': return toolGenerateDashboard(args, ctx);
    case 'save_draft': return Promise.resolve(toolSaveDraft(args, ctx));
    default: return Promise.resolve('Unknown tool: "' + name + '". Available tools: list_cubes, describe_cube, get_chart_support, query_cube, generate_dashboard, save_draft.');
  }
}

// ── Agent system prompt ─────────────────────────────────────────────

var AGENT_SYSTEM_PROMPT = [
  'You are a dashboard builder assistant. You help users create analytical dashboards backed by Cube.dev data models.',
  '',
  '## How you work',
  '',
  'Before generating anything, UNDERSTAND what the user needs:',
  '1. Start every new conversation by calling list_cubes to see what data is available.',
  '2. Ask the user what they want to analyze — what questions should the dashboard answer?',
  '3. Once you know the focus, call describe_cube to understand the fields, types, and metadata.',
  '4. Ask clarifying questions if needed:',
  '   - What is the primary entity they want to browse? (e.g. a region, a POI, a vehicle)',
  '   - Do they want a high-level overview or a deep-dive?',
  '   - Any specific dimensions or metrics they care about?',
  '   - Any time range or segment focus?',
  '5. Use query_cube to check data (cardinality, date ranges, top values) if it helps you design better.',
  '6. Use get_chart_support to verify chart type availability if the user asks about visualization options.',
  '7. Only call generate_dashboard when you have a clear, detailed understanding of the use case.',
  '',
  'You are a CONVERSATIONAL assistant, not a config generator. Talk to the user. Help them think through what they need.',
  'If the user gives a vague request like "make me a dashboard", ask what they want to learn from the data.',
  'If the user gives a specific request, you can move faster — but still discover the cube first.',
  '',
  '## Tools',
  '',
  '- list_cubes: Discover available data models (always call first in a new conversation)',
  '- describe_cube: Full field catalog — dimensions, measures, segments, metadata',
  '- get_chart_support: What chart types are available and their data slot requirements',
  '- query_cube: Run a Cube.dev query to check cardinality, ranges, distributions, top-N values',
  '- generate_dashboard: Create or update a dashboard config (pass current_config: "CURRENT" for updates)',
  '- save_draft: Manually save a config (generate_dashboard auto-saves, so this is rarely needed)',
  '',
  '## When writing the purpose for generate_dashboard',
  '',
  'The purpose string drives the entire generation. Be VERY detailed:',
  '- Name specific dimensions and measures to include',
  '- Specify which dimensions are high-cardinality and should be in lazy sections',
  '- Describe the information hierarchy (KPIs → trends → breakdowns → details)',
  '- Mention any chart type preferences the user expressed',
  '- Note which dimensions are low-cardinality (safe for main query) vs high-cardinality (must be lazy)',
  '',
  '## Data loading architecture (IMPORTANT)',
  '',
  'The dashboard engine loads all non-lazy panel dimensions into ONE Cube.dev query.',
  'If too many dimensions are in the main query, the Cartesian product explodes and the dashboard fails to load.',
  '',
  'When writing the purpose for generate_dashboard, ALWAYS specify which sections should be lazy:',
  '- Dimensions with 30+ unique values → must be in lazy sections',
  '- Dimensions with <20 unique values → safe for main query',
  '- Selectors, tables, and high-cardinality bar charts → always lazy',
  '- KPIs, gauges, time series, low-cardinality charts → main query',
  '- Use describe_cube metadata (color_map = known enum values, color_scale = numeric tiers) to judge cardinality',
  '- When unsure, use query_cube to check actual cardinality before deciding',
  '',
  'If in doubt about cardinality, use query_cube to check before generating.',
  '',
  '## Style',
  '',
  'Be concise but helpful. After generating a dashboard, summarize what was created and invite changes.',
  'When updating, pass current_config: "CURRENT" to generate_dashboard.',
].join('\n');

// ── Agent loop ──────────────────────────────────────────────────────

var MAX_ITERATIONS = 15;

export async function runAgentLoop(userMessages, metaResponse) {
  // Dynamic imports for chart modules (ESM)
  var chartTypes = await import('./chart-types.js');
  var chartSupport = await import('./chart-support.js');
  var schemaGen = await import('./schema/generate-schema.js');

  // Seed currentConfig from _draft.json if it exists
  var currentConfig = null;
  try {
    if (fs.existsSync(DRAFT_PATH)) {
      currentConfig = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
    }
  } catch (_) {}

  // Context object shared across all tool calls
  var ctx = {
    metaResponse: metaResponse,
    currentConfig: currentConfig,
    chartTypes: chartTypes,
    chartSupport: chartSupport,
    generateSystemPrompt: schemaGen.generateSystemPrompt,
    generateDashboardSchema: schemaGen.generateDashboardSchema,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  };

  // Build messages: system + user conversation
  var messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
  ];
  for (var i = 0; i < userMessages.length; ++i) {
    messages.push(userMessages[i]);
  }

  var totalToolCalls = 0;

  for (var iter = 0; iter < MAX_ITERATIONS; ++iter) {
    var response = await callOpenAI(messages, { tools: TOOL_DEFINITIONS });

    var outerUsage = response.usage || {};
    ctx.usage.prompt_tokens += outerUsage.prompt_tokens || 0;
    ctx.usage.completion_tokens += outerUsage.completion_tokens || 0;

    var choice = response.choices && response.choices[0];
    if (!choice || !choice.message) {
      return {
        reply: 'No response from the assistant. Please try again.',
        config: ctx.currentConfig,
        usage: buildUsage(ctx, totalToolCalls, iter + 1),
      };
    }

    var msg = choice.message;
    messages.push(msg);

    // If no tool calls, we have the final response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        reply: msg.content || '',
        config: ctx.currentConfig,
        usage: buildUsage(ctx, totalToolCalls, iter + 1),
      };
    }

    // Execute each tool call
    for (var tc = 0; tc < msg.tool_calls.length; ++tc) {
      var toolCall = msg.tool_calls[tc];
      totalToolCalls++;

      var result;
      try {
        result = await executeToolCall(toolCall.function.name, toolCall.function.arguments, ctx);
      } catch (err) {
        result = 'Tool execution error (' + toolCall.function.name + '): ' + err.message;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
  }

  // Max iterations reached
  return {
    reply: 'I made too many tool calls without producing a response. This usually means the request is too complex. Try breaking it into smaller steps.',
    config: ctx.currentConfig,
    usage: buildUsage(ctx, totalToolCalls, MAX_ITERATIONS),
  };
}

function buildUsage(ctx, toolCalls, iterations) {
  return {
    total_tokens: ctx.usage.prompt_tokens + ctx.usage.completion_tokens,
    prompt_tokens: ctx.usage.prompt_tokens,
    completion_tokens: ctx.usage.completion_tokens,
    tool_calls: toolCalls,
    iterations: iterations,
  };
}
