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

import { allTypeNames, getChartType } from '../chart-types.js';
import { buildFullSchema } from './dashboard-schema-base.js';
import { isChartSupported } from '../chart-support.js';

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
  var lines = [];

  lines.push('You are a dashboard configuration generator. You produce JSON configs that define analytical dashboards.');
  lines.push('The output must conform to the provided JSON Schema exactly.');
  lines.push('');

  // Per-cube field catalogs
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

    // Cube-level meta
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

    // Dimensions
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

    // Measures
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

    // Segments
    var segs = cube.segments || [];
    if (segs.length > 0) {
      lines.push('### Segments (' + segs.length + ')');
      for (var s = 0; s < segs.length; ++s) {
        var seg = segs[s];
        var sShort = seg.name.split('.').pop();
        var sTitle = seg.title || sShort;
        // Strip cube title prefix
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

  // Per-cube lazy loading classification
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

    // Classify dimensions by likely cardinality based on type and naming patterns
    var safeDims = [];
    var lazyDims = [];
    var lcDims = lcCube.dimensions || [];

    for (var ld = 0; ld < lcDims.length; ++ld) {
      var ldim = lcDims[ld];
      var lname = ldim.name.split('.').pop();
      var ltype = ldim.type || 'string';
      var lmeta = ldim.meta || {};

      // Boolean and time dims are always safe (booleans are 2-3 values, time is handled specially)
      if (ltype === 'boolean' || ltype === 'time') {
        safeDims.push(lname);
        continue;
      }

      // Dimensions with color_map have known enum values — check count
      if (lmeta.color_map) {
        var enumCount = Object.keys(lmeta.color_map).length;
        if (enumCount <= 20) { safeDims.push(lname); } else { lazyDims.push(lname); }
        continue;
      }

      // Dimensions with color_scale are numeric tiers — usually <10
      if (lmeta.color_scale) {
        safeDims.push(lname);
        continue;
      }

      // Known high-cardinality patterns
      var highCardPatterns = ['name', 'city', 'street', 'postal', 'booking', 'car', 'geohash',
        'model', 'longitude', 'latitude', 'locality', 'municipality', 'zipcode', 'code'];
      var isHighCard = false;
      for (var hp = 0; hp < highCardPatterns.length; ++hp) {
        if (lname.toLowerCase().indexOf(highCardPatterns[hp]) >= 0) { isHighCard = true; break; }
      }

      // Known low-cardinality patterns
      var lowCardPatterns = ['type', 'class', 'tier', 'dow', 'region', 'country', 'division',
        'partition', 'nr', 'category', 'subcategory', 'channel', 'status'];
      var isLowCard = false;
      for (var lp = 0; lp < lowCardPatterns.length; ++lp) {
        if (lname.toLowerCase().indexOf(lowCardPatterns[lp]) >= 0) { isLowCard = true; break; }
      }

      // Number type dimensions are often continuous/high-cardinality
      if (ltype === 'number' && !isLowCard) {
        lazyDims.push(lname);
        continue;
      }

      if (isHighCard) { lazyDims.push(lname); }
      else if (isLowCard) { safeDims.push(lname); }
      else { lazyDims.push(lname); } // default to lazy for unknown string dims
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

  // Chart type catalog
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

  // Dashboard design guidelines
  lines.push('## Dashboard Design Guidelines');
  lines.push('');
  lines.push('### Primary Selector');
  lines.push('Most dashboards have one dimension that is the primary entry point — the thing the user selects first to scope all analysis. Examples: a store selector, a POI selector, a product selector.');
  lines.push('Mark this panel with "primary": true. The engine renders it prominently as a searchable control that drives the entire dashboard.');
  lines.push('- Use chart type "selector" or "dropdown" with primary: true and searchable: true');
  lines.push('- Place the primary selector in the MODELBAR section (location: "modelbar") so it is always visible at the top as a filter control, not buried in the main body');
  lines.push('- Only one panel per dashboard should be primary');
  lines.push('- Choose the dimension that best matches the user\'s stated focus (e.g. "POI analysis" → poi_name is primary, "store performance" → sold_location is primary)');
  lines.push('- If the user\'s request does not imply a single-entity focus, do not set any panel as primary');
  lines.push('');
  lines.push('### Information Hierarchy');
  lines.push('A dashboard has a clear visual hierarchy. The user sees the most important information first and can drill into details on demand.');
  lines.push('');
  lines.push('1. **KPIs at the top** — 3-5 key metrics in a single row (section with columns: 4 or 5). Use chart type "kpi".');
  lines.push('2. **Time series** — a single full-width line chart (width: "full", columns: 1) showing the primary metric over time.');
  lines.push('3. **Primary breakdowns** — 2-3 categorical charts in a 2- or 3-column grid showing the most important dimensions.');
  lines.push('4. **Secondary breakdowns** — additional charts in their own section. Collapse if supplementary.');
  lines.push('5. **Detail/drill-down sections** — high-cardinality dimensions in collapsed sections with selectors.');
  lines.push('6. **Data table** — if included, put it last. Full width.');
  lines.push('The primary selector (if any) is in the modelbar, not in the main body.');
  lines.push('');
  lines.push('### Model Bar (location: "modelbar")');
  lines.push('The model bar is a compact control strip at the top of the dashboard. It holds filter controls that scope the data without taking up dashboard real estate.');
  lines.push('- Boolean dimensions as "toggle" controls (Yes/No/All)');
  lines.push('- Numeric dimensions as "range" controls (dual-handle slider)');
  lines.push('- ALWAYS include at least one modelbar section with relevant boolean toggles and/or numeric ranges from the cube');
  lines.push('- The model bar is NOT for KPIs, charts, or high-cardinality selectors. Keep it to 2-4 compact controls.');
  lines.push('');
  lines.push('### Collapsed Sections');
  lines.push('Use collapsed: true for sections that contain:');
  lines.push('- High-cardinality dimension lists (50+ unique values) that are not the primary focus');
  lines.push('- Secondary analysis that most users do not need on every visit');
  lines.push('- Detail tables');
  lines.push('');
  lines.push('Rules:');
  lines.push('- NEVER collapse a section with fewer than 2 panels — either merge it into another section or leave it expanded');
  lines.push('- NEVER collapse sections that are central to the user\'s stated purpose — if they asked for "POI analysis", the POI section must be expanded');
  lines.push('- NEVER collapse geographic/map sections when the dashboard focus is location-based');
  lines.push('');
  lines.push('### Geographic & Location-Based Dashboards');
  lines.push('When the user\'s request involves locations, places, geography, POIs, or spatial analysis:');
  lines.push('- Include map visualizations in a PROMINENT (not collapsed) section');
  lines.push('- Use map.scatter or map.bubble for point data when the cube has lat/lng dimensions');
  lines.push('- Use map for choropleth when the cube has named regions');
  lines.push('- Use map.heatmap for density visualization of point clusters');
  lines.push('- Use map.lines when the cube has travel/commute source→target coordinate pairs');
  lines.push('- Geographic maps should be full-width or in a 1-2 column layout — they need space to be useful');
  lines.push('');
  lines.push('**NOTE:** Geographic map chart types (map, map.scatter, map.bubble, map.heatmap, map.lines, map.effect) are NOT YET AVAILABLE in the rendering engine. Do not use them. Use bar charts with location dimensions instead until map support is added.');
  lines.push('');

  lines.push('### Travel Chain & Flow Patterns');
  lines.push('When the cube has prev_*/next_* dimension pairs (previous/next location, locality, municipality, region), these represent travel chains — where entities came from and where they went next.');
  lines.push('- Use **sankey** to show flows: source=prev_region, target=region shows travel between regions');
  lines.push('- Use **sankey** at multiple geographic levels: prev_locality→locality, prev_municipality→municipality');
  lines.push('- Use **map.lines** when coordinate pairs are available: sourceLng=prev_longitude, sourceLat=prev_latitude, targetLng=longitude, targetLat=latitude');
  lines.push('- Sankey is ideal for answering "where did visitors come from?" and "where did they go next?"');
  lines.push('- When the user mentions travel patterns, routes, flows, arrivals, departures, or transitions — always include at least one sankey or map.lines panel');
  lines.push('- Pair sankey with a selector for the dimension being analyzed (e.g. select a region, see its inflow/outflow)');
  lines.push('');
  lines.push('### Chart Type Selection');
  lines.push('Choose chart types based on the data shape, not for visual variety. The right chart makes the data self-explanatory.');
  lines.push('');
  lines.push('**Categorical data (dimension → count/measure):**');
  lines.push('- <8 values: **pie** or **pie.donut** (part-to-whole) or **pie.rose** (when values have wide range)');
  lines.push('- 8-30 values: **bar** (vertical, sorted by value) or **bar.horizontal** (long labels)');
  lines.push('- 30+ values: **selector** with searchable: true — NOT a chart');
  lines.push('- Composition/proportion: **pie.half** for single-metric progress, **pie.nested** for two-level breakdown (e.g. category + subcategory)');
  lines.push('');
  lines.push('**Stacked/grouped comparisons:**');
  lines.push('- Absolute stacked: **bar.stacked** (category + stack dimension)');
  lines.push('- 100% composition: **bar.normalized** (shows proportions, not absolutes — ideal for "what percentage of X is Y?")');
  lines.push('- Sequential gains/losses: **bar.waterfall** (shows incremental changes — revenue breakdown, funnel drop-offs)');
  lines.push('');
  lines.push('**Time series:**');
  lines.push('- Standard trend: **line** or **line.smooth**');
  lines.push('- Volume over time: **line.area** (filled area emphasizes magnitude)');
  lines.push('- Discrete steps: **line.step** (rate changes, pricing tiers)');
  lines.push('- Stacked composition over time: **line.area.stacked** (how parts contribute to total over time)');
  lines.push('- Ranking changes over time: **line.bump** (who was #1 each period)');
  lines.push('- One time series per dashboard is usually enough. Two if comparing different measures.');
  lines.push('');
  lines.push('**Numeric relationships:**');
  lines.push('- Two measures correlated: **scatter** (x vs y)');
  lines.push('- Three measures: **scatter.bubble** (x, y, size) — add color dimension for 4th encoding');
  lines.push('- Highlighted points: **scatter.effect** (ripple animation draws attention)');
  lines.push('- Two categorical axes + value: **heatmap** (must be categorical axes, NOT numeric)');
  lines.push('- Date + value density: **heatmap.calendar** (GitHub-style contribution grid)');
  lines.push('');
  lines.push('**Geographic/spatial:**');
  lines.push('- Named regions colored by value: **map** (choropleth)');
  lines.push('- Points on map by lat/lng: **map.scatter** or **map.bubble** (sized by measure)');
  lines.push('- Point density: **map.heatmap**');
  lines.push('- Highlighted locations: **map.effect** (ripple on key points)');
  lines.push('- Routes/flows between coordinates: **map.lines**');
  lines.push('');
  lines.push('**Hierarchical data:**');
  lines.push('- Area-based breakdown: **treemap** (nested rectangles — shows part-to-whole with drill-down)');
  lines.push('- Ring-based breakdown: **sunburst** (concentric rings — better for 3+ levels)');
  lines.push('- Structural relationships: **tree** or **tree.radial** (parent-child, no value encoding)');
  lines.push('');
  lines.push('**Flow/relationship data:**');
  lines.push('- Flow between categories: **sankey** (source → target, width = volume). Ideal for prev_region → region, stage transitions, traffic flows');
  lines.push('- Vertical flow: **sankey.vertical** (top-to-bottom instead of left-to-right)');
  lines.push('- Network connections: **graph** (force-directed layout) or **graph.circular** (nodes in a circle)');
  lines.push('- Circular relationships: **chord** (symmetric flows between categories)');
  lines.push('');
  lines.push('**Single metrics:**');
  lines.push('- Dashboard headline number: **kpi** (big number with label — the default for important metrics)');
  lines.push('- Progress toward target: **gauge.progress** (modern minimal) or **gauge.ring** (donut-style)');
  lines.push('- Classic speedometer: **gauge** (only when the metaphor fits — speed, temperature, pressure)');
  lines.push('');
  lines.push('**Specialized:**');
  lines.push('- Multi-axis comparison: **radar** (comparing entities across multiple measures)');
  lines.push('- Financial OHLC: **candlestick** or **candlestick.ohlc** (open/high/low/close)');
  lines.push('- Statistical distribution: **boxplot** (min/Q1/median/Q3/max)');
  lines.push('- Category volume over time: **themeRiver** (multiple streams flowing over time axis)');
  lines.push('- Multi-dimensional exploration: **parallel** (one axis per dimension)');
  lines.push('- Staged conversion: **funnel** (descending) or **funnel.ascending** (building up)');
  lines.push('');
  lines.push('**Controls (not charts):**');
  lines.push('- Boolean dimension: **toggle** in the modelbar');
  lines.push('- Numeric range: **range** in the modelbar');
  lines.push('- Entity selection: **selector** (searchable list) or **dropdown** (compact select)');
  lines.push('');
  lines.push('### Lazy Sections (CRITICAL for performance)');
  lines.push('The dashboard engine loads ALL non-lazy dimensions into a single Cube.dev query and builds a crossfilter worker from the result.');
  lines.push('When many dimensions are in the main query, the Cartesian product explodes and the dataset becomes too large to load.');
  lines.push('');
  lines.push('**Set `lazy: true` on any section whose panels use high-cardinality dimensions** (50+ unique values) that do NOT need instant cross-filtering with other charts.');
  lines.push('Lazy sections query Cube independently — each panel sends its own small query with only its dimension + count + any active filters.');
  lines.push('This avoids the cross-product explosion of adding high-cardinality dims to the main worker.');
  lines.push('');
  lines.push('**Rules:**');
  lines.push('- Selectors, dropdowns, and lists for high-cardinality dimensions (municipality, locality, poi_name, location_name, vehicle_model, customer_city) MUST be in a lazy section');
  lines.push('- Bar/pie charts for dimensions with 30+ unique values SHOULD be in a lazy section');
  lines.push('- KPIs, gauges, and single-value panels do NOT need lazy (they use measures, not group-by dimensions)');
  lines.push('- Time series (line charts using the time dimension) do NOT need lazy — the time dimension is handled specially');
  lines.push('- Toggles and ranges in the modelbar do NOT need lazy — they become server-side filters, not group-by dimensions');
  lines.push('- Charts using low-cardinality dimensions (<20 unique values: region, fuel_type, drive_type, stay_type, activity_type, car_class) are FINE in the main query');
  lines.push('- Sankey, treemap, sunburst with high-cardinality levels SHOULD be in a lazy section');
  lines.push('- Tables are always lazy-safe — put them in a lazy section');
  lines.push('');
  lines.push('**Example — main vs lazy:**');
  lines.push('- Main: KPIs, line chart (stay_ended_at), bar chart (region — 8 values), pie (fuel_type — 4 values), pie (stay_type — 4 values)');
  lines.push('- Lazy: selector (municipality — 70+ values), selector (poi_name — 1000+ values), bar (vehicle_model — 50+ values), table');
  lines.push('');
  lines.push('**If in doubt, make it lazy.** The only cost is slightly slower refresh on that section (it re-queries Cube). The benefit is preventing data explosion.');
  lines.push('');
  lines.push('### Section Layout');
  lines.push('- KPI sections: columns: 4 or 5 (one KPI per column)');
  lines.push('- Chart sections: columns: 2 or 3');
  lines.push('- Map sections: columns: 1 or 2 (maps need width)');
  lines.push('- Full-width panels (time series, tables, primary selectors): columns: 1 or set width: "full"');
  lines.push('- Collapsed detail sections: columns: 2 or 3');
  lines.push('');
  lines.push('### What NOT to do');
  lines.push('- Do not put KPIs in the modelbar — they belong in a visible KPI row');
  lines.push('- Do not use pie/donut for dimensions with more than 8 values — too many slices');
  lines.push('- Do not use toggle for non-boolean dimensions — toggle is Yes/No/All only');
  lines.push('- Do not put every dimension on the dashboard — select the 5-10 most analytically useful ones');
  lines.push('- Do not create more than 6-7 sections — consolidate related panels');
  lines.push('- Do not leave all sections expanded — use collapsed: true for secondary content');
  lines.push('- Do not collapse a section with only 1 panel — merge it into an adjacent section or leave it expanded');
  lines.push('- Do not use heatmap with two numeric dimensions — heatmap needs categorical axes. Use scatter for numeric×numeric');
  lines.push('- Do not omit the modelbar — every dashboard should have at least one boolean toggle or numeric range control');
  lines.push('- **NEVER put municipality, locality, poi_name, location_name, vehicle_model, customer_city, car, booking, street, or postal_code in a non-lazy section** — these are high-cardinality and WILL crash the dashboard');
  lines.push('');

  // Config rules
  lines.push('## Config Rules');
  lines.push('');
  lines.push('- Simple charts (bar, pie, line, kpi, gauge, selector, toggle, range, dropdown) use "dimension" and "measure" directly on the panel.');
  lines.push('- When measure is null, the engine counts records.');
  lines.push('- When chart is null, the engine defaults to "bar".');
  lines.push('- Complex charts (scatter.bubble, heatmap, sankey, treemap, radar, etc.) use the slot fields (x, y, size, color, source, target, levels, etc.) directly on the panel.');
  lines.push('- Table panels use the "columns" array.');
  lines.push('- Stacked charts (bar.stacked, line.area.stacked) use "dimension", "measure", and "stack".');
  lines.push('- Set primary: true on at most one panel to mark it as the dashboard\'s primary entity selector. Set primary: false on all other panels.');
  lines.push('- Every chart panel supports click-to-filter — this is automatic, not a config option.');
  lines.push('- For multi-cube dashboards, set "cube" on each panel and declare "sharedFilters" for cross-cube filter bridging.');
  lines.push('- **Sections with lazy: true query Cube independently per panel.** Any section containing high-cardinality dimensions (30+ values) MUST have lazy: true. This is not optional — the dashboard will fail to load without it.');
  lines.push('');

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
