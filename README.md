# @smartdatahq/crossfilter

> **A streaming-first, zero-copy analytics engine for the browser.**

Crossfilter2 is already the fastest way to filter large datasets client-side. This fork turns it into a complete dashboard runtime — data streams in as Arrow IPC, decodes and filters inside a Web Worker (main thread never blocks), WASM accelerates the hot filter scan, and partial snapshots render the UI progressively before the download even finishes.

### What this fork adds to crossfilter2

| Layer | What changed | Why it matters |
|-------|-------------|----------------|
| **Ingest** | Columnar Arrow IPC streaming with batch coalescing (default 64K rows), multi-source lookup joins, projection/rename/type-coercion at ingest, Proxy-backed lazy row arrays that defer materialization via `COLUMNAR_BATCH_KEY` | Data goes from Cube.dev (or any Arrow source) straight into crossfilter's sorted indexes without ever building intermediate row objects — a 10K-row dataset allocates zero row objects until a panel actually reads one |
| **Filtering** | Inline WASM module (no external `.wasm` file) with two scan paths: `filterInU32` for small target sets (k ≤ 4) and `markFilterInU32` with dense lookup for larger sets; automatic regex extraction of `d => d.field` and `function(d){ return d.field }` into string paths for WASM routing | Filter scans stay in linear WASM memory instead of JS object traversal — see [performance estimates](#performance-and-memory-estimates) below |
| **Lazy encoded path** | Uint32 code encoding per dimension (code 0 = null, 1..n = distinct values), 2x-amortized codes buffer growth on append, incremental `codeCounts` updates, `filterRange` target-codes caching, `groupAll` O(1) fast path, scratch buffer reuse across filter cycles | Appends are O(batch) not O(n log n) — a 10K append into 90K existing records skips the full re-sort and re-reduce |
| **Aggregation** | Declarative KPIs (`count`, `sum`, `avg`, `avgNonZero`), declarative groups with time bucketing (`minute`/`hour`/`day`/`week`/`month`), split-field groups for nested aggregates keyed by a secondary dimension, incremental group updates on append | One config object replaces dozens of imperative `dimension().group().reduce()` chains |
| **Worker runtime** | `createStreamingDashboardWorker` owns fetch → decode → filter → reduce → postMessage with Transferable typed-array buffers (zero-copy back to main thread); `createDashboardRuntime` for synchronous fallback; single `query()` round-trip returns filters + snapshot + paged rows + optional `rowCount` and `bounds` | The main thread only renders; structured-clone overhead is eliminated for the largest payloads (column arrays) |
| **Query model** | Declarative filters (`exact`, `in`, `range`), `isolatedFilters` for within-group filtering without affecting global state, `rowSets` for multiple named row slices per query, `bounds` queries for min/max, ad-hoc `groups` queries | One postMessage round-trip replaces what would otherwise be 4-8 separate calls |
| **Progressive UI** | Partial snapshot emission during streaming load (throttled at 250ms default), separate fetch-percent and rows-loaded progress events (throttled at 100ms) | Charts and KPIs appear within seconds even on million-row datasets |
| **Live mutation** | `append()` slots new rows into existing lazy indexes incrementally; `removeFiltered()` rebuilds `codeCounts` safely and re-filters | Dashboards stay live without full rebuild |
| **Instance extensions** | `cf.allFilteredIndexes()`, `cf.isElementFiltered(index)`, `cf.takeColumns(indexes, fields)`, `cf.configureRuntime()` / `cf.runtimeInfo()` for per-instance WASM control | Columnar extraction and filter introspection without materializing rows |
| **Demo** | Two production-grade stockout dashboards — a **store manager** view (7 panels, 3 coordinated crossfilter workers, ECharts, Cube.dev meta-driven colors) and an **operator** view (priority queue, focus panel, DOW guidance, category/trend charts) | Proves the architecture end-to-end: columnar-native rendering, URL-driven state, faceted store selector, peer comparison, isolated filters, sensitivity toggles |

The original crossfilter API (`cf.dimension()`, `group.all()`, etc.) is fully preserved — everything above is additive.

### Performance and memory estimates

These are analytical estimates based on the architecture — not synthetic benchmarks. Actual results depend on dataset shape, dimension cardinality, and browser.

#### Filter scan throughput (WASM vs JS)

The WASM module operates on flat `Uint32Array` codes in linear memory. The JS fallback (`denseLookupMatches`) builds a marks array and iterates in JS. Both do the same work — the difference is memory access pattern and JIT overhead.

| Operation | JS fallback | WASM (`markFilterInU32`) | Speedup estimate |
|-----------|------------|--------------------------|------------------|
| `filterIn` on 100K rows, 50 target values | ~2-4ms | ~0.5-1.5ms | ~2-3x |
| `filterIn` on 1M rows, 50 target values | ~20-40ms | ~5-15ms | ~2-4x |
| `filterExact` on 100K rows | ~0.5-1ms | ~0.2-0.5ms | ~2x |

The small-target path (`filterInU32`, k ≤ 4) uses a tight O(n*k) nested loop — effective for `filterExact` and small `filterIn` sets where the marks array setup cost would dominate.

#### Memory footprint per dimension

| Component | Size for N rows | Example (100K rows) |
|-----------|----------------|---------------------|
| `codes` (Uint32Array, 2x capacity) | 4 × 2N bytes | 800 KB |
| `codeCounts` (Uint32Array) | 4 × cardinality bytes | 4 KB (1000 distinct) |
| `codeToValue` (Array) | ~50 × cardinality bytes | 50 KB |
| `selected` (Uint8Array) | N bytes | 100 KB |
| Filter bitmask (Uint8/16/32) | 1-4 × N bytes | 100-400 KB |
| **Total per dimension** | **~6-10 bytes/row** | **~1 MB** |

Adding a dimension costs ~6-10 bytes per row. The 32-dimension limit (bitmask width) means worst-case overhead is ~320 bytes/row.

#### Row materialization savings

In upstream crossfilter, every record is a JS object from the start. In this fork, columnar ingest creates Proxy-backed arrays — rows materialize only on access.

| Scenario | Upstream (all rows as objects) | This fork (columnar + lazy) | Savings |
|----------|-------------------------------|----------------------------|---------|
| 10K rows, 20 fields, 50 visible | ~5 MB (10K objects × ~500 bytes) | ~25 KB (50 objects) + columnar arrays already in memory | ~5 MB heap, ~10K fewer GC objects |
| 100K rows, 20 fields, 50 visible | ~50 MB | ~25 KB + columnar | ~50 MB heap |
| 1M rows, 20 fields, 100 visible | ~500 MB | ~50 KB + columnar | ~500 MB heap |

The columnar arrays themselves (one typed/string array per field) are the same size either way — the saving is entirely in not creating N row objects with N × fields property slots.

#### Worker round-trip savings

The demo's store manager dashboard previously used 4 identical `rowSets` (stockout, forecast, risk, warning) all requesting the same 20+ fields with limit 10,000. Consolidating to a single `rowSet` cuts structured-clone serialization by ~75% per refresh cycle.

| Metric | Before (4 rowSets) | After (1 rowSet) | Savings |
|--------|--------------------|--------------------|---------|
| Structured-clone per refresh | ~4 × columnar payload | 1 × columnar payload | ~75% less serialization |
| postMessage overhead | 4 typed-array transfers | 1 typed-array transfer | 3 fewer Transferable handoffs |

#### Append performance (lazy path)

| Operation | Upstream | This fork (lazy encoded) | Why |
|-----------|----------|--------------------------|-----|
| Append 10K rows to 90K | O(n log n) re-sort + full reduce | O(m) codes extension + incremental codeCounts | Codes buffer grows 2x amortized; existing sorted indexes untouched |
| groupAll after append | O(n) full scan | O(1) mark update | Singleton groups skip sorted-key rebuild |

#### Panel rendering optimizations (demo-stockout)

| Optimization | Per-render savings estimate |
|-------------|---------------------------|
| Direct column rendering (skip `materializeRows`) | Avoid allocating N row objects per render cycle |
| O(1) lookup predicates (vs `String().toUpperCase()`) | ~10-50 µs saved per 10K-row filter pass |
| `colorFor()` memoization | Eliminates repeated meta lookup + threshold scan for same field/value pairs |
| Single-pass `populateSelects` | 1 loop instead of 2 over the same index array |
| Row-outer DOW loop (N×7 vs 7×N) | Better cache locality for columnar access |
| Store filter caching | Avoids re-filtering 4 arrays on every render when store hasn't changed |
| Day button class toggle | DOM class swap instead of full innerHTML rebuild on click |

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
