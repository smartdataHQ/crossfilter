# @smartdatahq/crossfilter

> **A streaming-first, zero-copy analytics engine for the browser.**

Crossfilter2 is already the fastest way to filter large datasets client-side. This fork turns it into a complete dashboard runtime — data streams in as Arrow IPC, decodes and filters inside a Web Worker (main thread never blocks), WASM accelerates the hot filter scan, and partial snapshots render the UI progressively before the download even finishes.

### What this fork adds to crossfilter2

| Layer | What changed | Why it matters |
|-------|-------------|----------------|
| **Ingest** | Columnar Arrow IPC streaming with batch coalescing, multi-source lookup joins, projection/rename/type-coercion at ingest | Data goes from Cube.dev (or any Arrow source) straight into crossfilter's sorted indexes without ever building intermediate row objects |
| **Filtering** | Inline WASM module for encoded filter scans, automatic function-accessor extraction (`d => d.field` is detected and WASM-routed) | 2-4x faster filterExact/filterIn on large datasets, transparent to existing code |
| **Aggregation** | Declarative KPIs (`count`, `sum`, `avg`, `avgNonZero`), declarative groups with time bucketing and split-field support, incremental group updates on append | One config object replaces dozens of imperative `dimension().group().reduce()` chains; appends are O(batch) not O(n log n) |
| **Worker runtime** | `createStreamingDashboardWorker` owns fetch → decode → filter → reduce → postMessage with Transferable buffers; `createDashboardRuntime` for synchronous fallback | The main thread only renders; a single `query()` round-trip returns filters + aggregations + paged rows |
| **Progressive UI** | Partial snapshot emission during streaming load, configurable throttle intervals, fetch/load progress events | Charts and KPIs appear within seconds even on million-row datasets |
| **Live mutation** | `append()` and `removeFiltered()` without rebuilding the runtime | Dashboards stay live — new data slots into existing indexes incrementally |
| **Demo** | Production-grade stockout dashboard (7 panels, 3 coordinated crossfilter workers, ECharts, Cube.dev meta-driven colors) | Proves the architecture end-to-end: columnar-native rendering, URL-driven state, faceted store selector, peer comparison, sensitivity toggles |

The original crossfilter API (`cf.dimension()`, `group.all()`, etc.) is fully preserved — everything above is additive.

## Installation

```bash
npm install @smartdatahq/crossfilter apache-arrow
```

The streaming worker needs UMD bundles of both libraries available at public HTTP URLs. In a **Next.js** project, copy them into `public/` with a postinstall script:

```json
// package.json
{
  "scripts": {
    "postinstall": "mkdir -p public/vendor && cp node_modules/@smartdatahq/crossfilter/crossfilter.js public/vendor/ && cp node_modules/apache-arrow/Arrow.es2015.min.js public/vendor/"
  }
}
```

Then reference them as absolute paths:

```js
const runtime = await crossfilter.createStreamingDashboardWorker({
  crossfilterUrl: '/vendor/crossfilter.js',
  arrowRuntimeUrl: '/vendor/Arrow.es2015.min.js',
  // ...
});
```

## Quick start

```js
import crossfilter from '@smartdatahq/crossfilter';

const runtime = await crossfilter.createStreamingDashboardWorker({
  crossfilterUrl: '/vendor/crossfilter.js',
  arrowRuntimeUrl: '/vendor/Arrow.es2015.min.js',
  wasm: true,
  emitSnapshots: true,
  batchCoalesceRows: 65536,

  // Declare filterable fields (use post-projection names)
  dimensions: ['event', 'country', 'region', 'time'],

  // Global aggregate metrics
  kpis: [{ id: 'count', field: 'count', op: 'sum' }],

  // Pre-computed group-by aggregations for charts
  groups: [
    { id: 'byEvent', field: 'event', metrics: [{ id: 'count', field: 'count', op: 'sum' }] },
    { id: 'byCountry', field: 'country', metrics: [{ id: 'count', field: 'count', op: 'sum' }] },
    {
      id: 'timeline',
      field: 'time',
      bucket: { type: 'timeBucket', granularity: 'month' },
      metrics: [{ id: 'count', field: 'count', op: 'sum' }],
    },
  ],

  // Arrow IPC source (fetched inside the worker)
  sources: [{
    id: 'primary',
    role: 'base',
    dataUrl: '/api/cube',
    dataFetchInit: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'arrow',
        query: {
          dimensions: ['events.country', 'events.event', 'events.region'],
          measures: ['events.count'],
          timeDimensions: [{ dimension: 'events.timestamp', granularity: 'month' }],
          timezone: 'UTC',
          limit: 1000000,
        },
      }),
    },
    projection: {
      rename: {
        'events.count': 'count',
        'events__count': 'count',
        'events__timestamp_month': 'time',
        'events.event': 'event',
        'events.country': 'country',
        'events.region': 'region',
      },
      transforms: {
        count: 'number',
        time: 'timestampMs',
      },
    },
  }],
});
```

## Progress and streaming snapshots

While data loads, the worker emits progress and partial snapshots so the UI can render progressively:

```js
runtime.on('progress', (progress) => {
  console.log(progress.status, progress.load.rowsLoaded, 'rows');
  console.log(progress.fetch.percent, '% downloaded');
});

runtime.on('snapshot', ({ snapshot }) => {
  renderCharts(snapshot.groups);
  renderKpis(snapshot.kpis);
});

await runtime.ready;
```

## Querying with filters

After load, send declarative filters and get back pre-computed aggregations plus paged row data in a single worker round-trip:

```js
const result = await runtime.query({
  filters: {
    country: { type: 'in', values: ['US', 'UK'] },
    time: { type: 'range', range: [startMs, endMs] },
  },
  rows: {
    sortBy: 'time',
    direction: 'top',
    limit: 50,
    offset: 0,
    fields: ['event', 'country', 'region', 'time', 'count'],
  },
});

result.snapshot.kpis;              // { count: 54321 }
result.snapshot.groups.byEvent;    // [{ key: 'click', value: { count: 30000 } }, ...]
result.snapshot.groups.timeline;   // [{ key: 1704067200000, value: { count: 12000 } }, ...]
result.rows;                       // columnar row data for the table
```

### Filter types

```js
// Exact match
{ type: 'exact', value: 'click' }

// Set membership
{ type: 'in', values: ['click', 'view', 'purchase'] }

// Range (inclusive lower, exclusive upper)
{ type: 'range', range: [startMs, endMs] }

// Clear filter on a field
null
```

## Live data mutation

Append rows or remove filtered records without rebuilding the runtime:

```js
await runtime.append([
  { event: 'click', country: 'US', region: 'CA', time: Date.now(), count: 1 },
]);

await runtime.removeFiltered('excluded');
```

## Synchronous fallback (no worker)

For smaller datasets or environments where workers are unavailable:

```js
import crossfilter from '@smartdatahq/crossfilter';
import { tableFromIPC } from 'apache-arrow';

const buffer = await fetch('/data/result.arrow').then(r => r.arrayBuffer());
const table = tableFromIPC(new Uint8Array(buffer));

const runtime = crossfilter.createDashboardRuntime({
  table,
  wasm: true,
  dimensions: ['country', 'event', 'time'],
  groups: [
    { id: 'byCountry', field: 'country', metrics: [{ id: 'count', op: 'count' }] },
  ],
  kpis: [{ id: 'total', op: 'count' }],
});

const snapshot = runtime.snapshot({
  country: { type: 'in', values: ['US'] },
});
```

## Classic crossfilter API

The original crossfilter API is still fully available:

```js
import crossfilter from '@smartdatahq/crossfilter';

const cf = crossfilter(records);
const country = cf.dimension('country');
country.filterIn(['US', 'UK']);
const group = country.group().reduceCount();
console.log(group.all());
```

## Configuration reference

### `createStreamingDashboardWorker(options)`

| Option | Type | Description |
|--------|------|-------------|
| `crossfilterUrl` | `string` | URL to the UMD build (`crossfilter.js`) |
| `arrowRuntimeUrl` | `string` | URL to Apache Arrow UMD (`Arrow.es2015.min.js`) |
| `sources` | `Array` | Arrow IPC data sources (see below) |
| `dimensions` | `string[]` | Field names to create filterable dimensions on |
| `groups` | `Array` | Declarative group-by specs |
| `kpis` | `Array` | Global aggregate metric specs |
| `wasm` | `boolean` | Enable WASM-accelerated filter scans (default `true`) |
| `emitSnapshots` | `boolean` | Emit partial snapshots during streaming load |
| `batchCoalesceRows` | `number` | Buffer this many rows before flushing to the runtime (default `65536`) |
| `progressThrottleMs` | `number` | Min interval between progress events (default `100`) |
| `snapshotThrottleMs` | `number` | Min interval between snapshot events (default `250`) |
| `workerFactory` | `() => Worker` | Custom worker factory (skips `importScripts` entirely) |

### Source spec

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique source identifier |
| `role` | `'base' \| 'lookup'` | One base source required; lookups are joined in the worker |
| `dataUrl` | `string` | URL to fetch the Arrow IPC stream |
| `dataFetchInit` | `RequestInit` | Fetch options (method, headers, body) |
| `arrowBuffer` | `ArrayBuffer` | Pre-loaded Arrow buffer (alternative to `dataUrl`) |
| `projection.rename` | `Record<string, string>` | Rename Arrow columns to internal field names |
| `projection.transforms` | `Record<string, string>` | Type coercion: `'timestampMs'`, `'number'`, `'constantOne'` |

### Metric spec

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Key in the result (`snapshot.kpis[id]`, `group.value[id]`) |
| `field` | `string` | Column to aggregate (not needed for `'count'`) |
| `op` | `string` | `'count'`, `'sum'`, `'avg'`, `'avgNonZero'` |

### Async runtime methods

| Method | Returns | Description |
|--------|---------|-------------|
| `runtime.ready` | `Promise<Progress>` | Resolves when all data is loaded |
| `runtime.on(event, fn)` | `() => void` | Subscribe to `'progress'`, `'snapshot'`, `'error'` |
| `runtime.query(request)` | `Promise<{ snapshot, rows }>` | Apply filters, return aggregations + row page |
| `runtime.snapshot(filters)` | `Promise<Snapshot>` | Aggregations only, no row data |
| `runtime.rows(query)` | `Promise<RowResult>` | Paged row data only |
| `runtime.updateFilters(filters)` | `Promise` | Update filters without reading results |
| `runtime.append(records)` | `Promise<number>` | Add rows, returns new dataset size |
| `runtime.removeFiltered(selection)` | `Promise<number>` | Remove `'included'` or `'excluded'` rows |
| `runtime.bounds(request)` | `Promise` | Get min/max for fields |
| `runtime.groups(request)` | `Promise` | Ad-hoc group queries |
| `runtime.dispose()` | `Promise` | Terminate the worker |

## Architecture

```
Arrow IPC source (Cube.dev, file, etc.)
    |
    v  HTTP streaming response
Web Worker (owns fetch, decode, crossfilter instance)
    |  Apache Arrow RecordBatchReader
    |  Incremental batch append with projection/rename/transforms
    |  WASM-accelerated encoded filter scans
    v
Declarative filters in, snapshots + row slices out
    |
    v  postMessage with Transferable buffers
Main thread (renders UI only)
```

## Development

```bash
npm install
npm test          # vitest + eslint
npm run build     # rollup -> crossfilter.js + crossfilter.min.js
npm run benchmark
```

## License

[Apache-2.0](LICENSE). Based on the original [crossfilter](https://github.com/crossfilter/crossfilter) by Mike Bostock and Jason Davies.
