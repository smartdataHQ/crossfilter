# crossfilter3

> **A streaming-first, zero-copy analytics engine for the browser.**

Crossfilter3 is built on top of crossfilter2, already the fastest way to filter large datasets client-side. This fork turns it into a complete dashboard runtime — data streams in as Arrow IPC, decodes and filters inside a Web Worker (main thread never blocks), WASM accelerates the hot filter scan, and partial snapshots render the UI progressively before the download even finishes.

### What crossfilter3 adds to crossfilter2

| Layer | What changed | Why it matters |
|-------|-------------|----------------|
| **Ingest** | Columnar Arrow IPC streaming with batch coalescing (default 64K rows), multi-source lookup joins, projection/rename/type-coercion at ingest, zero-copy `Float64Array` fast path for numeric columns, Proxy-backed lazy row arrays via `COLUMNAR_BATCH_KEY` | Data goes from Cube.dev (or any Arrow source) straight into crossfilter's columnar indexes without building intermediate row objects — a 100K-row dataset allocates zero row objects until a panel actually reads one |
| **1-bit columnar filter bitsets** | Per-dimension 1-bit `Uint32Array` bitsets (`src/filter-bitsets.js`) with **no 32-dimension limit**, 32-unrolled word packing, word-level XOR delta extraction with bailout, `Math.clz32` sparse active/excluded row traversal, SWAR `popcount32` for `filteredCount()`, and `O(1)` filter clear | Replaces byte-per-row bitmasks with 1 bit/row per *active* filter (0 bytes when unfiltered), accelerates sparse filter extraction & counting by 2–7×, and supports arbitrarily many dimensions |
| **Lazy dimensions & encoding** | Filter-only string-accessor dimensions defer encoding completely until first filter/group/bounds/sort access; active dimensions use `Uint32Array` dictionary codes (2× amortized growth, incremental `codeCounts`) or raw numeric arrays; inline WASM filter acceleration (`src/wasm.js`) with JS fallback | Wide 20-dimension dashboards build **5–6× faster** because unused filter-only dimensions cost 0 CPU and 0 bytes; streaming appends are `O(batch)` instead of `O(n log n)` |
| **AoS shared-scan & complement reduction** | Interleaved cache-line AoS `Float64Array` metric buffers (`src/columnar-reduce.js`), multi-group shared-scan co-scheduler (`_flushGroups`, up to 5 groups + KPI in a single pass via V8-friendly leaf kernels), Copy-on-Write unfiltered snapshot cache, and complement ("subtract-from-total") reduction when `> 50%` of rows remain active (with `\|v\| > 1e12` cancellation guards and exact empty-slot zeroing) | Clearing filters back to 100% is `O(slots)` (**9× faster** at 100K, **78× faster** at 1M); high-selectivity filters (90–95%) scan only the 5–10% excluded rows (**2–3.3× faster**); multi-chart clicks scan active rows once instead of once per chart |
| **Falcon-style brush cache** | Automatic precomputed active-dimension 1D prefix-sum cubes (`src/falcon-brush.js`) activated on the 2nd consecutive `filterRange`/`filterExact` on the same dimension — discrete `O(slots)` prefix subtraction (`U ≤ 2048`) and continuous 256-bin quantile prefix cubes + CSR boundary bins (`U > 2048`) with deferred bitset materialization | Delivers **< 0.03 ms/frame** discrete brushing (**20× faster** at 100K, **240× faster** at 1M) and **1.6 ms/frame** continuous float brushing at 1M rows — smooth 60fps range sliders with zero overhead on single clicks |
| **Aggregation** | Declarative KPIs (`count`, `sum`, `avg`, `avgNonZero`, `ratio`), declarative groups with time bucketing (`minute`/`hour`/`day`/`week`/`month`), dense & sparse split-field groups for nested aggregates keyed by a secondary dimension, incremental group updates on append | One config object replaces dozens of imperative `dimension().group().reduce()` chains |
| **Worker runtime** | `createStreamingDashboardWorker` owns fetch → decode → filter → reduce → postMessage with Transferable typed-array buffers (zero-copy back to main thread); `createDashboardRuntime` for synchronous fallback; single `query()` round-trip returns filters + snapshot + paged rows + optional `rowCount` and `bounds` | The main thread only renders; structured-clone overhead is eliminated for the largest payloads (column arrays) |
| **Query model** | Declarative filters (`exact`, `in`, `range`), `isolatedFilters` for within-group filtering without affecting global state, `rowSets` for multiple named row slices per query, `bounds` queries for min/max, ad-hoc `groups` queries | One postMessage round-trip replaces what would otherwise be 4–8 separate calls |
| **Progressive UI** | Partial snapshot emission during streaming load (throttled at 250ms default), separate fetch-percent and rows-loaded progress events (throttled at 100ms) | Charts and KPIs appear within seconds even on million-row datasets |
| **Live mutation** | `append()` / `appendColumns()` slot new rows into existing lazy indexes incrementally; `removeFiltered()` compacts columns and bitsets safely and invalidates caches | Dashboards stay live without full rebuild |
| **Instance extensions** | `cf.batch(fn)` for atomic multi-dimension filter updates, `cf.allFilteredIndexes()`, `cf.isElementFiltered(index)`, `cf.takeColumns(indexes, fields)`, `dim.topIndex()`/`dim.bottomIndex()`, `cf.configureRuntime()` / `cf.runtimeInfo()` | Columnar extraction, zero-copy sorting, and atomic multi-filter transitions without materializing rows |

The original crossfilter API (`cf.dimension()`, `group.all()`, etc.) is fully preserved — everything above is additive.

### Performance and memory characteristics

#### Measured dashboard benchmarks (Node.js v22, built `crossfilter.cjs`)

Median timings across a multi-chart dashboard (6 groups × 4 metrics: `count`, `sum(revenue)`, `sum(cost)`, `ratio(clicks, impressions)` + KPIs; 5K high-cardinality SKUs + 365 days + continuous floats):

| Workload | 100K rows | 1M rows | Primary mechanism |
|----------|-----------|---------|-------------------|
| Build + initial snapshot (6 dims, 6 groups) | **12.2 ms** | **108.7 ms** | Lazy encoding + AoS shared-scan |
| Build + initial snapshot (20 dims, 4 groups) | **5.9 ms** | **59.7 ms** | Lazy filter-only dimensions (zero upfront work for unused dims) |
| Single-dim click (10% active) + full snapshot | **0.44 ms** | **2.63 ms** | 1-bit `clz32` sparse scan + AoS multi-group co-scan |
| Clear filter → 100% + full snapshot | **0.23 ms** | **0.23 ms** | Copy-on-Write unfiltered snapshot cache (`O(slots)`) |
| High-selectivity 95% (`in` 19/20) + clear | **0.68 ms** | **2.68 ms** | Complement subtraction (scans only 5% excluded rows) |
| Low-selectivity 0.5% (2 active dims) + clear | **0.78 ms** | **3.83 ms** | 1-bit `AND` + `clz32` extraction + shared-scan |
| Cold `rowCount()` after 2-dim filter change | **0.18 ms** | **1.72 ms** | SWAR `popcount32` over 1-bit bitsets |
| Discrete range brush (60 frames, steady-state) | **0.026 ms/frame** | **0.021 ms/frame** | Falcon 1D prefix-sum cube (`O(slots)`, 0 row scans) |
| Continuous float range brush (60 frames, `revenue`) | **0.26 ms/frame** | **1.61 ms/frame** | Falcon 256-bin quantile prefix cube + CSR boundary bins |

#### Memory footprint per dimension

| Component | Size for N rows | Example (100K rows) | Notes |
|-----------|----------------|---------------------|-------|
| Unused filter-only dimension | **0 bytes** | **0 KB** | Deferred until first filter, group, bounds, or sort access |
| Active filter bitset (1 bit/row) | `N / 8` bytes | **12.5 KB** | Allocated only while a dimension has an active filter; 0 bytes when unfiltered; **no 32-dimension limit** |
| Encoded `codes` (`Uint32Array`) | `4 × N` bytes | 400 KB | Grows 2× amortized on streaming appends |
| `codeCounts` (`Uint32Array`) | `4 × U` bytes | 4 KB (1K distinct) | Maintained incrementally on append |
| `codeToValue` (`Array`) | `~50 × U` bytes | 50 KB (1K distinct) | Shared with `splitField` when field matches a dimension |
| Raw numeric column (`Float64Array`) | `0 bytes` extra | **0 KB** | Zero-copy shared view for single-batch TypedArray/Arrow float64 columns |

#### Row materialization savings

In upstream crossfilter, every record is a JS object from the start. In crossfilter3, columnar ingest creates Proxy-backed arrays — rows materialize only on access.

| Scenario | Upstream (all rows as objects) | Crossfilter3 (columnar + lazy) | Savings |
|----------|-------------------------------|--------------------------------|---------|
| 10K rows, 20 fields, 50 visible | ~5 MB (10K objects × ~500 bytes) | ~25 KB (50 objects) + columnar arrays already in memory | ~5 MB heap, ~10K fewer GC objects |
| 100K rows, 20 fields, 50 visible | ~50 MB | ~25 KB + columnar | ~50 MB heap |
| 1M rows, 20 fields, 100 visible | ~500 MB | ~50 KB + columnar | ~500 MB heap |

The columnar arrays themselves (one typed/string array per field) are the same size either way — the saving is entirely in not creating N row objects with N × fields property slots.

#### Append performance (lazy path)

| Operation | Upstream | Crossfilter3 (lazy encoded) | Why |
|-----------|----------|-----------------------------|-----|
| Append 10K rows to 90K | O(n log n) re-sort + full reduce | O(m) codes extension + incremental `codeCounts` | Codes buffer grows 2× amortized; existing sorted indexes untouched; unused dims stay deferred |
| `groupAll` after append | O(n) full scan | O(m) incremental scalar update | Singleton groups skip sorted-key rebuild |

## Installation

```bash
npm install crossfilter3 apache-arrow
```

The streaming worker needs UMD bundles of both libraries available at public HTTP URLs. In a **Next.js** project, copy them into `public/` with a postinstall script:

```json
// package.json
{
  "scripts": {
    "postinstall": "mkdir -p public/vendor && cp node_modules/crossfilter3/crossfilter.js public/vendor/ && cp node_modules/apache-arrow/Arrow.es2015.min.js public/vendor/"
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
import crossfilter from 'crossfilter3';

const runtime = await crossfilter.createStreamingDashboardWorker({
  crossfilterUrl: '/vendor/crossfilter.js',
  arrowRuntimeUrl: '/vendor/Arrow.es2015.min.js',
  wasm: true,
  emitSnapshots: true,
  batchCoalesceRows: 65536,

  // Declare filterable fields (use post-projection names)
  dimensions: ['event', 'country', 'region', 'time'],

  // Global aggregate metrics
  kpis: [
    { id: 'count', field: 'count', op: 'sum' },
    // A rate re-derived locally from two summed components on every filter:
    { id: 'hitRate', field: 'hits', denominator: 'attempts', op: 'ratio' },
  ],

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
import crossfilter from 'crossfilter3';
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
import crossfilter from 'crossfilter3';

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
| `maxRows` | `number` | Optional positive safe integer limiting total input rows across base and lookup sources, checked before projection/ingestion |
| `maxBytes` | `number` | Optional positive safe integer limiting total encoded input bytes across sources, checked before decoding; bounded fetches require a readable response body |
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
| `projection.transforms` | `Record<string, string>` | Type coercion: `'timestampMs'`, `'number'`, `'boolean'` (`'true'`, `'false'` or null), `'constantOne'` |

### Metric spec

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Key in the result (`snapshot.kpis[id]`, `group.value[id]`) |
| `field` | `string` | Column to aggregate (not needed for `'count'`); the **numerator** column for `'ratio'` |
| `op` | `string` | `'count'`, `'sum'`, `'avg'`, `'avgNonZero'`, `'ratio'` |
| `denominator` | `string` | Required for `'ratio'`: the column summed as the divisor |

**`ratio`** sums the `field` (numerator) and the `denominator` independently and
finalizes to `sum(field) / sum(denominator)` (or `null` when the denominator
sums to zero). Because both components are re-summed on every filter, a rate or
an average can be re-derived from pre-aggregated rows entirely client-side —
no re-query. An average is just `{ op: 'ratio', field: <sum-of-x>, denominator:
<count> }`; a rate is `{ op: 'ratio', field: <numerator-count>, denominator:
<base-count> }`. The two component columns must themselves be summable.

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
| `runtime.createGroup(spec)` | `Promise<string>` | Add a group at runtime, returns its ID |
| `runtime.disposeGroup(id)` | `Promise<void>` | Remove a dynamically created group |
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
    |  Lazy filter-only dims + 1-bit columnar filter bitsets (clz32 + SWAR popcount)
    |  AoS multi-group co-scan + CoW unfiltered/complement cache + Falcon brush cubes
    v
Declarative filters in, snapshots + row slices out
    |
    v  postMessage with Transferable buffers
Main thread (renders UI only)
```

## Development

```bash
npm install
npm test          # vitest + eslint src/
npm run build     # rollup -> crossfilter.js, crossfilter.cjs, crossfilter.min.js
npm run benchmark
```

## License

[Apache-2.0](LICENSE). Based on the original [crossfilter](https://github.com/crossfilter/crossfilter) by Mike Bostock and Jason Davies.
