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

var TOOL_DEFINITIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts', 'agent-tools.json'), 'utf8'));

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
    ctx.onConfigGenerated();

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

var AGENT_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'agent-system.md'), 'utf8');

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

  // Track whether generate_dashboard was called this session
  var configGeneratedThisSession = false;

  // Context object shared across all tool calls
  var ctx = {
    metaResponse: metaResponse,
    currentConfig: currentConfig,
    chartTypes: chartTypes,
    chartSupport: chartSupport,
    generateSystemPrompt: schemaGen.generateSystemPrompt,
    generateDashboardSchema: schemaGen.generateDashboardSchema,
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    onConfigGenerated: function () { configGeneratedThisSession = true; },
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
        config: configGeneratedThisSession ? ctx.currentConfig : null,
        usage: buildUsage(ctx, totalToolCalls, iter + 1),
      };
    }

    var msg = choice.message;
    messages.push(msg);

    // If no tool calls, we have the final response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return {
        reply: msg.content || '',
        config: configGeneratedThisSession ? ctx.currentConfig : null,
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
    config: configGeneratedThisSession ? ctx.currentConfig : null,
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
