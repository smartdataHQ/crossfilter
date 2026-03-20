# Builder Tool-Calling Agent Design

**Date:** 2026-03-20
**Status:** Draft
**Scope:** Replace the single-shot OpenAI call in the Dashboard Builder with a multi-turn agent loop using GPT-5.4 tool calling + structured output for config generation.

## Problem

The current builder (`demo/builder.html`) makes a single OpenAI API call with `response_format: { type: 'json_schema' }`. The LLM has no ability to:

- Progressively discover available cubes and their fields
- Ask clarifying questions or explore the data
- Validate its own output
- Run queries to answer data-related questions
- Iterate on a config with targeted updates

The LLM gets the entire cube schema and system prompt in one shot and must produce a complete dashboard config blind.

## Solution

A server-side agent loop where GPT-5.4 uses tools to discover data models, explore chart capabilities, query data, and generate/update dashboard configs. The config generation step uses a **nested LLM call** with structured output, keeping the main agent lightweight and the config generation specialized.

## Architecture

### Two-Layer LLM Pattern

```
Frontend (builder.html)
  │
  POST /api/dashboard/agent { messages: [...] }
  │
  ▼
Server Agent Loop (proxy-server.mjs or agent.mjs)
  │
  GPT-5.4 + 6 tools, parallel_tool_calls: false
  │
  ├─ list_cubes()              → cube summaries from /api/meta cache
  ├─ describe_cube(name)       → full field catalog from metadata
  ├─ get_chart_support(family?) → live chart type registry
  ├─ query_cube(...)           → proxied Cube.dev query
  ├─ generate_dashboard(...)   ─┐
  │                              │  INNER GPT-5.4 CALL
  │                              │  response_format: json_schema
  │                              │  Full system prompt + schema
  │                              │  Returns guaranteed-valid config
  │                             ◄┘
  ├─ save_draft(config)        → writes _draft.json
  │
  Loop until finish_reason === "stop" (max 15 iterations)
  │
  ▼
Response { reply: "...", config?: {...}, usage: {...} }
```

### Main Agent (Outer Loop)

**Role:** Conversational router. Discovers data, answers questions, delegates config generation.

**System prompt** (~500 tokens, intentionally small):

```
You are a dashboard builder assistant. You help users create analytical
dashboards by discovering data models and generating configurations.

Your workflow:
1. Use list_cubes to discover available data models
2. Use describe_cube to understand a model's fields, types, and metadata
3. Use get_chart_support to see what chart types are available and their data slots
4. Use query_cube to answer data questions (cardinality, ranges, distributions)
5. Use generate_dashboard to create or update dashboard configs
6. Use save_draft to save configs for live preview in the iframe

When creating a new dashboard, discover the cube first (list_cubes, describe_cube) so you
can write a detailed purpose for generate_dashboard. If the user names a specific cube,
you can skip list_cubes and go directly to describe_cube.
When updating, pass current_config: "CURRENT" to generate_dashboard.
generate_dashboard auto-saves the draft — no need to call save_draft separately.
```

**API call configuration:**

```javascript
{
  model: "gpt-5.4",
  messages: [systemPrompt, ...conversationHistory],
  tools: toolDefinitions,      // 6 tools, each with strict: true
  parallel_tool_calls: false,  // required for strict mode
  tool_choice: "auto"
}
```

### Config Generator (Inner Call)

**Role:** Specialized dashboard config producer. Gets the full cube context and design intelligence.

**Triggered by:** The `generate_dashboard` tool execution on the server.

**System prompt:** `generateSystemPrompt(metaResponse, [cubeName])` — the existing 370+ line prompt with field catalogs, chart type guide, and design guidelines.

**Schema:** `generateDashboardSchema(metaResponse, [cubeName], { supportedOnly: true })` — the existing schema with `anyOf` panel branches, dim/measure enums, `$defs`.

**API call:**

```javascript
{
  model: "gpt-5.4",
  messages: [
    { role: "system", content: generateSystemPrompt(meta, [cubeName]) },
    { role: "user", content: userPromptForGeneration }
  ],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "dashboard_config",
      strict: true,
      schema: generateDashboardSchema(meta, [cubeName], { supportedOnly: true })
    }
  }
  // NO tools — pure structured output
}
```

**User prompt varies by mode:**

- **New dashboard:** `"Create a dashboard titled '{title}' for the '{cubeName}' cube. Purpose: {purpose}"`
- **Update:** `"Current dashboard config:\n{JSON}\n\nUpdate this dashboard. Changes requested: {purpose}"`

**Schema stats (verified):** 293 properties, 245 enum values, 3,116 enum chars, depth 3. All well within GPT-5.4 limits (5,000 / 1,000 / 120,000 / 5).

## Tool Definitions

All tools use `strict: true` on their parameter schemas. All properties listed in `required`. All objects have `additionalProperties: false`.

### 1. `list_cubes`

**Purpose:** Progressive discovery — names and descriptions only. The first tool the agent should call.

**Parameters:** None (empty object).

**Returns:**

```json
{
  "cubes": [
    {
      "name": "bluecar_stays",
      "title": "BlueCar Stays",
      "description": "One row per car stay (Stop Ended event)",
      "grain": "stay_event",
      "dimensions": 91,
      "measures": 54,
      "segments": 10
    }
  ]
}
```

**Errors:** Only if cube metadata is unavailable (auth issue → descriptive message with .env setup instructions).

### 2. `describe_cube`

**Purpose:** Full field catalog for one cube. Gives the agent enough context to have an informed conversation and to call `generate_dashboard` with a good purpose.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `cube_name` | string | yes | "The exact cube name from list_cubes results" |

**Returns:**

```json
{
  "name": "bluecar_stays",
  "title": "BlueCar Stays",
  "grain": "stay_event",
  "grain_description": "One row per car stay (Stop Ended event)",
  "time_dimension": "stay_ended_at",
  "period": { "earliest": "2024-05-01", "latest": "now", "typical_range": "last_90_days" },
  "granularity": { "available": ["day","week","month","quarter","year"], "default": "week" },
  "dimensions": [
    { "name": "region", "type": "string", "description": "Region name", "color_map": null },
    { "name": "has_poi_match", "type": "boolean", "description": "Whether the stay matched a POI" },
    ...
  ],
  "measures": [
    { "name": "count", "type": "number", "agg": "count", "description": "Number of stays" },
    { "name": "avg_stay_duration_hours", "type": "number", "agg": "avg", "format": "hours" },
    ...
  ],
  "segments": [
    { "name": "poi_stops_only", "title": "POI Stops Only", "description": "..." },
    ...
  ]
}
```

**Errors:**

- Unknown cube → `"Cube 'bluecar_stay' not found. Available cubes: bluecar_stays, semantic_events. Did you mean 'bluecar_stays'?"`

### 3. `get_chart_support`

**Purpose:** Expose the live chart type registry. Built dynamically from `allTypeNames()` + `getChartType()` + `isChartSupported()` — the same functions that feed the structured output schema.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `family` | string or null | yes | "Filter by chart family: category, time, numeric, single, hierarchy, relation, specialized, tabular, control, geo. Null for all families." |

**Returns:**

```json
{
  "supported": [
    { "type": "bar", "family": "category", "slots": "category:dimension!, value:measure?" },
    { "type": "sankey", "family": "relation", "slots": "source:dimension!, target:dimension!, value:measure?" }
  ],
  "unsupported": ["map", "map.scatter", "map.bubble", "map.heatmap", "map.lines", "map.effect"],
  "summary": "50 supported, 6 unsupported (geo family not yet implemented)"
}
```

**Errors:**

- Unknown family → `"Family 'geographic' not found. Available families: category, time, numeric, single, hierarchy, relation, specialized, tabular, control, geo."`

### 4. `query_cube`

**Purpose:** Run a Cube.dev query to answer data questions — cardinality, date ranges, distributions, top-N values. Helps the LLM make informed decisions about chart types and field selections.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `cube_name` | string | yes | "The cube to query" |
| `dimensions` | string[] | yes | "Dimension short names to group by. Empty array for totals only." |
| `measures` | string[] | yes | "Measure short names to aggregate. At least one required." |
| `filters` | array of filter objects or null | yes | "Filters to apply. Null for no filters. Each filter: { member, operator, values }." |
| `limit` | integer or null | yes | "Max rows returned. Default 100, max 1000." |
| `order` | object or null | yes | "Sort order: { field: 'asc' or 'desc' }. Null for default." |

**Note on nullable parameters:** All `or null` parameters use `type: ["string", "null"]` (or `["integer", "null"]`, `["array", "null"]`, `["object", "null"]`) in the strict JSON Schema to satisfy OpenAI's structured output requirements.

Filter object schema:

```json
{
  "member": "string — dimension or measure short name",
  "operator": "string — equals, notEquals, contains, notContains, gt, gte, lt, lte, inDateRange, beforeDate, afterDate",
  "values": ["string — filter values"]
}
```

The `member` field aligns with the Cube.dev filter API. Both dimensions and measures can be filtered (e.g., "show regions where count > 1000").

**Short name → fully qualified name translation:** The tool implementation resolves short names to Cube.dev's `{cubeName}.{fieldName}` format using the `fullName` field from `buildCubeRegistry()` in `dashboard-meta.js`. The LLM always works with short names; the server handles translation. Example: `dimensions: ["region"]` → Cube.dev query `dimensions: ["bluecar_stays.region"]`. Response rows are mapped back to short names for the LLM.

**Returns:**

```json
{
  "rows": [
    { "region": "Capital Region", "count": 12456 },
    { "region": "South", "count": 8234 }
  ],
  "rowCount": 8,
  "truncated": false,
  "query_time_ms": 340
}
```

**Errors:**

- Unknown field → `"Field 'municpality' not found in cube 'bluecar_stays'. Did you mean 'municipality'? Available dimensions: municipality, locality, region, ... Available measures: count, avg_stay_duration_hours, ..."`
- Unknown measure → same pattern with measure suggestions
- Cube.dev error → `"Cube query failed: {upstream error}. Try simplifying: reduce dimensions or add filters."`
- Timeout → `"Cube query timed out after 30s. Try adding a filter to reduce data volume or use fewer dimensions."`

### 5. `generate_dashboard`

**Purpose:** Create or update a dashboard config via a nested structured output call. This is the only path to config generation — it always produces a valid config. Automatically saves the result as `_draft.json` for immediate preview.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `cube_name` | string | yes | "The cube to build the dashboard for. Must match a name from list_cubes." |
| `title` | string | yes | "Dashboard title, e.g. 'Fleet Overview' or 'Tourism Patterns'" |
| `purpose` | string | yes | "What the dashboard should show, which dimensions/measures to focus on, and any specific chart preferences. Be detailed." |
| `current_config` | string or null | yes | "Pass 'CURRENT' to use the last generated config for updates. Pass null when creating a new dashboard." |

**Note on nullable parameters:** `current_config` uses `type: ["string", "null"]` in the strict schema.

**Server-side `currentConfig` tracking:** The `runAgentLoop` function maintains a `currentConfig` variable (outside the conversation messages) that is set whenever `generate_dashboard` succeeds. On loop startup, `currentConfig` is seeded by reading `demo/dashboards/_draft.json` if it exists — this ensures the "CURRENT" sentinel works across separate requests (user sends message 1 to generate, then message 2 to update in a new request). When the LLM passes `current_config: "CURRENT"`, the server substitutes the actual config JSON. This avoids the LLM re-serializing a multi-KB JSON string in a tool call argument — it simply passes the sentinel `"CURRENT"` and the server handles the rest.

**Auto-save:** On success, the config is automatically written to `demo/dashboards/_draft.json`. This eliminates the need for a separate `save_draft` call in the common case — one tool call generates and saves.

**Returns:**

```json
{
  "config": { ... },
  "sections": 5,
  "panels": 18,
  "tokens": { "prompt": 8200, "completion": 1400 },
  "saved": { "url": "/demo/dashboards/_draft" }
}
```

**Errors:**

- Unknown cube → fuzzy match suggestion
- `current_config: "CURRENT"` but no prior config exists → `"No current config to update. Call generate_dashboard with current_config: null to create a new dashboard first."`
- OpenAI refusal → `"Model refused to generate config. Reason: {refusal}. Try rephrasing the purpose."`
- OpenAI timeout → `"Config generation timed out after 120s. Try a simpler purpose or fewer requirements."`
- Invalid JSON from model (shouldn't happen with strict mode) → `"Generated config failed to parse. This is unexpected with structured output. Error: {detail}. Retrying may help."`

### 6. `save_draft`

**Purpose:** Save a dashboard config to `_draft.json` manually. Useful when the LLM wants to save a config that was not just generated (e.g., after manual edits discussed in conversation). In the common case, `generate_dashboard` auto-saves and this tool is not needed.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | string | yes | "Pass 'CURRENT' to save the last generated config, or 'CUSTOM' to provide a config." |
| `custom_config` | string or null | yes | "When source is 'CUSTOM': the full dashboard config as a JSON string. Null when source is 'CURRENT'." |

**Note on nullable parameters:** `custom_config` uses `type: ["string", "null"]` in the strict schema.

**Server-side:** When `source` is `"CURRENT"`, uses the `currentConfig` variable from the agent loop. No need for the LLM to re-serialize the config.

**Returns:**

```json
{
  "saved": true,
  "url": "/demo/dashboards/_draft",
  "title": "Fleet Overview",
  "sections": 5,
  "panels": 18
}
```

**Errors:**

- `source: "CURRENT"` but no config exists → `"No current config to save. Call generate_dashboard first."`
- `source: "CUSTOM"` with invalid JSON → `"Config is not valid JSON: {parse error}. The config must be a JSON object."`
- Missing required fields → `"Config is missing required field 'sections'. A valid config must have: title (string), cubes (array), sharedFilters (array), sections (array)."`

## Error Handling Strategy

### Three Tiers

**Tier 1 — Fuzzy match recovery.** For cube names, field names, family names — find the closest match using substring/Levenshtein and suggest it. Always list valid options.

```javascript
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
```

**Tier 2 — Structural guidance.** When a tool call is structurally wrong, explain what's expected and what fields are required.

**Tier 3 — Upstream passthrough with context.** For Cube.dev and OpenAI errors, wrap with actionable advice (simplify query, add filters, rephrase purpose).

### Agent Loop Safety

- Max 15 iterations before returning an error to the frontend
- Each tool execution is try/caught — errors become tool results, not crashes
- The LLM sees the error and can retry or try a different approach

### Latency Characteristics

The agent loop makes 3-6 API calls per user message, with the `generate_dashboard` inner call taking 10-30 seconds. Total response time: **15-60 seconds** typically. The existing `proxy-server.mjs` has a 5-minute server timeout (line 517), which is sufficient. The frontend shows a typing indicator during this time. No streaming — the full response is returned when the loop completes.

### Levenshtein Implementation

The `suggestMatch` helper requires a simple Levenshtein distance function. Since the project has no external runtime dependencies, a minimal inline implementation (~15 lines) is included in `agent.mjs`.

### Token Usage Aggregation

The `usage` field in the response aggregates across all API calls in the loop (outer iterations + inner `generate_dashboard` call). Fields: `{ total_tokens, prompt_tokens, completion_tokens, tool_calls, iterations }`. This gives the user visibility into cost.

## Server Changes

### New Endpoint

`POST /api/dashboard/agent` — replaces (or lives alongside) `/api/dashboard/generate`.

**Request:** `{ messages: [{ role, content }] }`

**Response:** `{ reply: string, config?: object, usage: { total_tokens, tool_calls, iterations } }`

The response includes `reply` (the agent's final text message to the user) and optionally `config` (if a dashboard was generated/updated this turn).

### New Module: `demo/agent.mjs`

Extracted from `proxy-server.mjs` for clarity. Contains:

- `runAgentLoop(messages, metaResponse)` — the main loop
- `executeToolCall(name, args, metaResponse)` — tool dispatch + error handling
- `callOpenAI(messages, options)` — shared helper for both outer and inner calls
- Tool implementation functions
- `suggestMatch()` and other error helpers

### Changes to `proxy-server.mjs`

- New route: `POST /api/dashboard/agent` → imports and calls `runAgentLoop`
- Existing `/api/dashboard/generate` route remains for backwards compatibility
- Shared cube metadata caching (already exists)

## Frontend Changes

### `builder.html`

Minimal changes:

1. **Endpoint:** Change `fetch('/api/dashboard/generate', ...)` to `fetch('/api/dashboard/agent', ...)`
2. **Response handling:** Parse `{ reply, config, usage }` instead of `{ config, usage }`
3. **Display `reply`:** Show the agent's text response as an assistant message (the agent may respond conversationally without generating a config)
4. **Config handling:** If `config` is present, update preview iframe and show config summary
5. **Remove:** The client-side chart-support validation (the agent handles this now)
6. **Remove:** The client-side config context injection on subsequent turns (the agent manages its own context via tools)

The cube selector dropdown can remain for convenience but is no longer required — the agent discovers cubes via `list_cubes`.

## Data Flow: New Dashboard

```
User: "Create a dashboard showing tourism patterns in Iceland"

Agent turn 1:
  → calls list_cubes()
  ← [{name: "bluecar_stays", title: "BlueCar Stays", ...}]

Agent turn 2:
  → calls describe_cube("bluecar_stays")
  ← {dimensions: [...91], measures: [...54], ...}

Agent turn 3:
  → calls generate_dashboard(
      cube_name: "bluecar_stays",
      title: "Iceland Tourism Patterns",
      purpose: "Tourism stay patterns: KPIs for stay count and duration,
               time series of stays, geographic breakdown by region and
               municipality, POI analysis, vehicle fleet distribution.
               Include modelbar with boolean toggles and duration range.",
      current_config: null
    )
  ← {config: {...}, sections: 6, panels: 22, saved: {url: "/demo/dashboards/_draft"}}

Agent responds:
  "I've created 'Iceland Tourism Patterns' with 6 sections and 22 panels.
   The preview is loading in the iframe. Let me know if you'd like
   any changes."
```

Note: only 3 tool calls — `generate_dashboard` auto-saves the draft.

## Data Flow: Update Dashboard

```
User: "Make the time series a stacked area and add a sankey for travel flows"

Agent turn 1:
  → calls generate_dashboard(
      cube_name: "bluecar_stays",
      title: "Iceland Tourism Patterns",
      purpose: "Change the time series chart to line.area.stacked with
               a stack dimension. Add a new section with a sankey chart
               showing travel flows using prev_region → region.",
      current_config: "CURRENT"
    )
  ← {config: {...updated...}, saved: {url: "/demo/dashboards/_draft"}}

Agent responds:
  "Updated — the time series is now a stacked area chart and I've added
   a travel flows section with a sankey showing region-to-region movement."
```

Note: single tool call. The server substitutes "CURRENT" with the actual config from the previous generation, and auto-saves the result.

## Data Flow: Data Question

```
User: "How many unique regions are there?"

Agent turn 1:
  → calls query_cube(
      cube_name: "bluecar_stays",
      dimensions: ["region"],
      measures: ["count"],
      filters: null,
      limit: 50,
      order: null
    )
  ← {rows: [{region: "Capital Region", count: 45000}, ...], rowCount: 8}

Agent responds:
  "There are 8 regions. Capital Region has the most stays (45,000),
   followed by South (12,000) and..."
```

## Files Changed

| File | Change |
|------|--------|
| `demo/agent.mjs` | **New.** Agent loop, tool implementations, error handling, OpenAI helpers. |
| `demo/proxy-server.mjs` | Add `POST /api/dashboard/agent` route. Import from `agent.mjs`. |
| `demo/builder.html` | Switch to `/api/dashboard/agent` endpoint. Handle `{ reply, config }` response. Remove client-side chart validation and config injection. |

## Conversation Management

The frontend sends the full `messages[]` array each request (matching the current pattern). The server does not persist conversation state between requests — each `/api/dashboard/agent` call is stateless except for the `currentConfig` variable within a single loop execution.

For long sessions with multiple generate/update cycles, the conversation array grows with embedded config summaries in tool results. Tool results should be kept concise — `generate_dashboard` returns section/panel counts rather than the full config in its tool result message, keeping token usage manageable. The full config is tracked server-side via `currentConfig` and saved to `_draft.json`.

## Graceful Degradation

- **Sparse cube metadata:** Not all cubes have rich `meta` fields (grain, period, granularity). `describe_cube` returns `null` for missing metadata. The auto-generated `semantic_events` cube has minimal meta — the tool should still return a useful response with available fields.
- **Missing .env credentials:** `list_cubes` and `describe_cube` can fall back to the cached metadata file (`.cache/cube-meta.json`) if Cube.dev credentials are unavailable. `query_cube` requires live credentials and returns a clear error if unconfigured.
- **Unsupported chart types in prompts:** The `get_chart_support` tool reports unsupported types (currently the `geo` family: map, map.scatter, etc.). The system prompt in `generateSystemPrompt()` still documents these with a "NOT YET AVAILABLE" warning. This is a pre-existing minor inconsistency that does not affect config generation since the structured output schema filters to `supportedOnly: true`.

## Dependencies

- No new npm dependencies. Raw `https.request` to OpenAI, matching existing codebase style.
- GPT-5.4 model (`gpt-5.4` model ID).
- Existing: `generate-schema.js`, `chart-types.js`, `chart-support.js`, `dashboard-meta.js` — all consumed by tool implementations, no changes needed.
