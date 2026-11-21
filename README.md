# crossfilter3

> **A streaming-first, columnar analytics and cross-filtering engine for browsers and Node.js.**

[![npm version](https://img.shields.io/npm/v/crossfilter3.svg)](https://www.npmjs.com/package/crossfilter3)
[![license](https://img.shields.io/npm/l/crossfilter3.svg)](LICENSE)
![types](https://img.shields.io/badge/TypeScript-included-3178c6.svg)
![formats](https://img.shields.io/badge/module-ESM%20%7C%20CJS%20%7C%20UMD-4c1.svg)
![size](https://img.shields.io/badge/min%2Bgzip-~64%20kB-informational.svg)

`crossfilter3` builds on [crossfilter2](https://github.com/crossfilter/crossfilter) and re-engineers the core for modern columnar analytics and interactive dashboards. It delivers **sub-millisecond multi-chart cross-filtering** up to 1M+ rows, **60fps range brushing**, **zero row-object materialization**, **unlimited dimensions** (removing the 32-dimension cap), and a **streaming Apache Arrow Web Worker** — while keeping 100% compatibility with the classic crossfilter API.

## Why crossfilter3?

- **Sub-millisecond interactive queries at 100K–1M+ rows** — multi-chart clicks run in `0.4–2.6 ms`, clearing filters takes `0.23 ms`, discrete brushing runs at `< 0.03 ms/frame`, and continuous float brushing runs at `0.39 ms/frame` steady-state at 1M rows.
- **Zero-copy columnar ingest & unlimited dimensions** — ingest TypedArrays, Apache Arrow tables/IPC streams, or plain JS arrays without allocating row objects; per-dimension 1-bit bitsets remove crossfilter2's 32-dimension limit.
- **Declarative dashboard runtime** — configure KPIs (`count`, `sum`, `avg`, `avgNonZero`, `ratio`), grouped charts, time bucketing, split-field breakdowns, top-K group queries, bounds, and paged columnar rows in a single `query()` call.
- **Non-blocking Arrow IPC Web Worker** — streams, decodes, joins lookup tables, and emits progressive partial snapshots off the main thread, returning Transferable TypedArray buffers zero-copy.
- **Drop-in `crossfilter2` compatible** — existing `cf.dimension()`, `group()`, and `reduce()` code works unchanged, with bundled TypeScript definitions (`index.d.ts`) and ESM, CommonJS, and UMD builds (~64 kB min+gzip).

## Performance at a glance

Measured on Node.js v22 using the built `crossfilter.cjs` bundle on a multi-chart dashboard (**6 groups × 4 metrics**: `count`, `sum(revenue)`, `sum(cost)`, `ratio(clicks, impressions)` + KPIs; 5,000 SKUs, 365 days, and continuous floats):

| Workload | 100K rows | 1M rows | How it stays fast |
| --- | ---: | ---: | --- |
| Build + initial snapshot (6 dims, 6 groups) | **12.2 ms** | **108.7 ms** | Columnar dictionary encoding + AoS shared-scan |
| Build + initial snapshot (20 dims, 4 groups) | **5.9 ms** | **59.7 ms** | Lazy filter-only dims (0 CPU / 0 bytes until used) |
| Single-dim click (10% active) + full snapshot | **0.44 ms** | **2.63 ms** | 1-bit `clz32` sparse scan + multi-group co-scan |
| Clear filter → 100% + full snapshot | **0.23 ms** | **0.23 ms** | Copy-on-Write unfiltered snapshot restore (`O(slots)`) |
| High-selectivity 95% (`in` 19/20) + clear | **0.68 ms** | **2.68 ms** | Complement subtraction (scans only 5% excluded rows) |
| Low-selectivity 0.5% (2 active dims) + clear | **0.78 ms** | **3.83 ms** | 1-bit `AND` + `clz32` extraction + shared-scan |
| `rowCount()` alone / with 2-dim filter update | **0.01 / 0.18 ms** | **0.05 / 1.72 ms** | SWAR `popcount32` over 1-bit filter words |
| Discrete range brush (steady-state per frame) | **0.026 ms/f** | **0.021 ms/f** | Falcon 1D prefix-sum cube (`O(slots)`, 0 row scans) |
| Continuous float brush (steady-state / 60f avg) | **0.20 / 0.26 ms/f** | **0.39 / 1.61 ms/f** | Falcon 256-bin quantile prefix cube + CSR boundary bins |

> Compared to pre-columnar `crossfilter3@3.0.3` on the exact same 100K-row suite (identical numeric digests), single/multi-dim clicks are **190×–605× faster**, clear-to-100% is **451× faster**, dashboard init is **13×–27× faster**, and discrete brushing is **120× faster** (over 1,000× faster at 1M rows). See [Under the hood](#under-the-hood) for architecture and memory details.

## Installation

```bash
npm install crossfilter3
```

If you stream or ingest Apache Arrow tables/IPC, install `apache-arrow` alongside it (optional — not required for TypedArray columns or JS object arrays):

```bash
npm install crossfilter3 apache-arrow
```

<details>
<summary><strong>Browser Web Worker setup (Next.js / Vite / static hosting)</strong></summary>

`createStreamingDashboardWorker` loads UMD bundles inside the worker via `importScripts` (unless you supply a custom `workerFactory`). Copy the UMD builds into your static assets directory (e.g. `public/vendor/`):

```json
{
  "scripts": {
    "postinstall": "mkdir -p public/vendor && cp node_modules/crossfilter3/crossfilter.js public/vendor/ && cp node_modules/apache-arrow/Arrow.es2015.min.js public/vendor/"
  }
}
```

Then pass `/vendor/crossfilter.js` and `/vendor/Arrow.es2015.min.js` as `crossfilterUrl` and `arrowRuntimeUrl`.

</details>

## Quick start

### 1. Columnar dashboard runtime (zero dependencies, browser or Node.js)

Pass column arrays directly — no row objects, no Arrow dependency, and instant sub-millisecond cross-filtering:

```js
import crossfilter from 'crossfilter3';

const day = (n) => Date.UTC(2025, 0, 1 + n);

const runtime = crossfilter.createDashboardRuntime({
  columns: {
    country: ['US', 'UK', 'US', 'DE', 'US', 'UK'],
    channel: ['web', 'app', 'app', 'web', 'web', 'web'],
    time: new Float64Array([day(0), day(0), day(1), day(1), day(2), day(2)]),
    revenue: new Float64Array([120, 80, 95, 60, 210, 150]),
    clicks: new Int32Array([12, 8, 9, 4, 21, 15]),
    impressions: new Int32Array([200, 160, 150, 100, 300, 250]),
  },
  // Filter-only dimensions stay deferred (0 cost) until actually filtered or queried
  dimensions: ['country', 'channel', 'time', 'revenue'],
  kpis: [
    { id: 'orders', op: 'count' },
    { id: 'revenue', field: 'revenue', op: 'sum' },
    // Re-derived locally as sum(clicks) / sum(impressions) on every filter
    { id: 'ctr', field: 'clicks', denominator: 'impressions', op: 'ratio' },
  ],
  groups: [
    {
      id: 'byCountry',
      field: 'country',
      metrics: [
        { id: 'orders', op: 'count' },
        { id: 'revenue', field: 'revenue', op: 'sum' },
      ],
    },
    {
      id: 'timelineByChannel',
      field: 'time',
      bucket: { type: 'timeBucket', granularity: 'day' },
      splitField: 'channel',
      metrics: [{ id: 'revenue', field: 'revenue', op: 'sum' }],
    },
  ],
});

// Single atomic query: apply filters + read KPIs, shaped groups, bounds, rowCount, and paged rows
const res = runtime.query({
  filters: {
    country: { type: 'in', values: ['US', 'UK'] },
    time: { type: 'range', range: [day(0), day(2)] },
  },
  snapshot: {
    groups: {
      byCountry: { sort: 'desc', sortMetric: 'revenue', limit: 10, visibleOnly: true, includeTotals: true },
    },
  },
  bounds: { fields: ['revenue'] },
  rowCount: true,
  rows: {
    sortBy: 'revenue',
    direction: 'top',
    limit: 50,
    fields: ['country', 'channel', 'revenue'],
    columnar: true, // returns TypedArray/column slices instead of JS row objects
  },
});

res.snapshot.kpis;                 // { orders: 3, revenue: 295, ctr: 0.05686... }
res.snapshot.groups.byCountry;     // { entries: [...], total: 3, sort: 'desc', ... } (ignores country's own filter)
res.bounds.revenue;                // { min: 80, max: 120 }
res.rowCount;                      // 3
res.rows;                          // { fields: [...], length: 3, columns: { country: [...], ... } }

runtime.dispose();
```

### 2. Streaming Apache Arrow IPC in a Web Worker

Stream large Arrow IPC responses directly inside a Web Worker with progressive snapshots and zero-copy Transferable payloads back to the main thread:

```js
import crossfilter from 'crossfilter3';

const runtime = await crossfilter.createStreamingDashboardWorker({
  crossfilterUrl: '/vendor/crossfilter.js',
  arrowRuntimeUrl: '/vendor/Arrow.es2015.min.js',
  emitSnapshots: true,
  batchCoalesceRows: 65536,

  dimensions: ['event', 'country', 'region', 'time'],
  kpis: [
    { id: 'count', field: 'count', op: 'sum' },
    { id: 'hitRate', field: 'hits', denominator: 'attempts', op: 'ratio' },
  ],
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
  sources: [{
    id: 'primary',
    role: 'base',
    dataUrl: '/api/cube',
    dataFetchInit: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'arrow', query: { /* ... */ } }),
    },
    projection: {
      rename: {
        'events.count': 'count',
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

runtime.on('progress', (progress) => {
  console.log(progress.status, progress.load.rowsLoaded, 'rows', progress.fetch.percent, '%');
});

runtime.on('snapshot', ({ snapshot }) => {
  renderCharts(snapshot.groups);
  renderKpis(snapshot.kpis);
});

await runtime.ready;

const result = await runtime.query({
  filters: {
    country: { type: 'in', values: ['US', 'UK'] },
    time: { type: 'range', range: [startMs, endMs] },
  },
  rows: {
    sortBy: 'time',
    direction: 'top',
    limit: 50,
    fields: ['event', 'country', 'region', 'time', 'count'],
    columnar: true,
  },
});
```

> **Tip:** Send categorical columns as **Arrow Dictionary** vectors whenever your backend supports it — `crossfilter3` ingests Arrow Dictionary codes directly without JS string hashing, cutting 1M-row load time by ~3×.

### 3. Synchronous Arrow table or classic crossfilter API

```js
import crossfilter from 'crossfilter3';
import { tableFromIPC } from 'apache-arrow';

// Synchronous Arrow table runtime (no worker)
const table = tableFromIPC(new Uint8Array(arrowBuffer));
const runtime = crossfilter.createDashboardRuntime({
  table,
  dimensions: ['country', 'event', 'time'],
  groups: [{ id: 'byCountry', field: 'country', metrics: [{ id: 'count', op: 'count' }] }],
  kpis: [{ id: 'total', op: 'count' }],
});
const snap = runtime.snapshot({ country: { type: 'in', values: ['US'] } });
```

```js
import crossfilter from 'crossfilter3';

// Classic crossfilter2 API + columnar & batch extensions
const cf = crossfilter.fromColumns(columns); // or crossfilter(records)
const country = cf.dimension('country');
const revenue = cf.dimension('revenue');
const byCountry = country.group().reduceCount();

// Atomic multi-dimension filter transition (coalesces listener updates)
cf.batch(() => {
  country.filterIn(['US', 'UK']);
  revenue.filterRange([100, 500]);
});

const topIndexes = revenue.topIndex(20);
const topCols = cf.takeColumns(topIndexes, ['country', 'revenue']);
```

## Querying, filtering, and live mutations

### Declarative filter types

```js
{ type: 'exact', value: 'click' }               // exact match
{ type: 'in', values: ['click', 'purchase'] }   // set membership
{ type: 'range', range: [startMs, endMs] }      // half-open [min, max)
{ type: 'all' } // or null                      // clear filter on this field
```

### Advanced `query()` capabilities

A single `runtime.query(...)` call can combine:

- **`filters`** — updates active global filters before reading results.
- **`isolatedFilters`** — evaluates the query under a temporary filter state without mutating the dashboard's active filters (useful for comparison cards or drill-down previews).
- **`snapshot`** — `{ groups: { [groupId]: GroupQuery | false } }` to shape/paginate specific groups, or `false` to skip snapshots entirely.
- **`groups`** — ad-hoc shaped group reads without recomputing KPIs.
- **`rows`** / **`rowSets`** — single or multiple named paged row slices; pass `columnar: true` for zero-copy `{ columns, fields, length }` output (omitting `columnar` returns an array of row objects).
- **`bounds`** — `{ fields: ['revenue', 'time'] }` returns `{ min, max }` across currently filtered rows.
- **`rowCount: true`** — returns the exact filtered row count via SWAR popcount.

### Live data mutation

Append new rows or prune filtered records without rebuilding the runtime:

```js
// Async worker runtime
await runtime.append([
  { event: 'click', country: 'US', region: 'CA', time: Date.now(), count: 1 },
]);
await runtime.removeFiltered('excluded'); // or 'included'

// Sync runtime also supports zero-copy columnar & Arrow appends
runtime.appendColumns(nextColumns);
runtime.appendArrowTable(nextArrowTable);
```

## Configuration & API reference

### `createDashboardRuntime(options)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `columns` | `Record<string, ColumnSource>` | — | Columnar arrays / TypedArrays (mutually exclusive with `table`, `records`) |
| `table` | `ArrowTableLike` | — | Apache Arrow `Table` (mutually exclusive with `columns`, `records`) |
| `records` | `TRecord[]` | — | Plain JS row objects (mutually exclusive with `columns`, `table`) |
| `columnarOptions` | `ColumnarOptions` | — | Optional `{ fields, length, transforms, rowFactory }` |
| `dimensions` | `string[]` | `[]` | Filterable field names (group fields are added automatically) |
| `groups` | `DashboardGroupSpec[]` | `[]` | Declarative group-by specs (see below) |
| `kpis` | `DashboardMetricSpec[]` | `[]` | Global aggregate metric specs (see below) |
| `wasm` | `boolean` | `true` | Enable inline WASM filter acceleration where applicable |

### `createStreamingDashboardWorker(options)`

Accepts `dimensions`, `groups`, `kpis`, and `wasm` above, plus:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `crossfilterUrl` | `string` | — | URL to the UMD build (`crossfilter.js`) |
| `arrowRuntimeUrl` | `string` | — | URL to Apache Arrow UMD (`Arrow.es2015.min.js`) |
| `sources` | `DashboardStreamSource[]` | — | Arrow IPC base and lookup sources (see below) |
| `emitSnapshots` | `boolean` | `false` | Emit throttled partial snapshots during streaming load |
| `initialFilters` | `DashboardFilterState` | `null` | Filters applied as batches stream in |
| `batchCoalesceRows` | `number` | `65536` | Rows buffered before flushing a coalesced batch into crossfilter |
| `maxRows` | `number` | — | Optional positive safe integer cap across base and lookup sources (checked before projection/ingest) |
| `maxBytes` | `number` | — | Optional positive safe integer cap on encoded input bytes (bounded fetches require a readable body) |
| `progressThrottleMs` | `number` | `100` | Minimum interval between `'progress'` events |
| `snapshotThrottleMs` | `number` | `250` | Minimum interval between streaming `'snapshot'` events |
| `workerFactory` | `() => Worker` | — | Custom worker factory (skips `importScripts`) |

### Source spec (`sources[]`)

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique source identifier |
| `role` | `'base' \| 'lookup'` | One `'base'` source required; `'lookup'` sources are joined in the worker |
| `dataUrl` | `string` | URL to fetch the Arrow IPC stream |
| `dataFetchInit` | `RequestInit` | Fetch options (`method`, `headers`, `body`, etc.) |
| `arrowBuffer` | `ArrayBuffer \| ArrayBufferView` | Pre-loaded Arrow IPC buffer (alternative to `dataUrl`) |
| `lookup` | `{ keyFields: string[], valueFields: string[] }` | Join keys and columns to attach for `'lookup'` sources |
| `projection.rename` | `Record<string, string>` | Rename incoming Arrow columns to internal field names |
| `projection.transforms` | `Record<string, Transform>` | Coerce columns: `'timestampMs'`, `'number'`, `'boolean'` (`'true'`/`'false'`/`null`), `'constantOne'` |

### Group spec (`groups[]`)

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Group identifier in `snapshot.groups[id]` (defaults to `group_<index>`) |
| `field` | `string` | Dimension field to group by |
| `bucket` | `{ type: 'timeBucket', granularity: 'minute' \| 'hour' \| 'day' \| 'week' \| 'month' }` | Optional UTC time bucketing |
| `splitField` | `string` | Optional secondary dimension producing nested `{ [splitKey]: metrics }` values |
| `metrics` | `DashboardMetricSpec[]` | Metrics computed per bucket (defaults to row count) |
| `sortMetric` | `string` | Default metric ID used when sorting this group |

### Group query options (`snapshot.groups[id]` / `runtime.groups()`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sort` | `'desc' \| 'asc' \| 'natural'` | `'desc'` | Sort by `sortMetric` or natural key order |
| `sortMetric` | `string` | group default | Metric ID used for `'asc'`/`'desc'` ordering |
| `limit` | `number \| null` | `null` | Max entries returned (uses top-K min/max heap when smaller than cardinality) |
| `offset` | `number` | `0` | Pagination offset |
| `visibleOnly` | `boolean` | `false` | Exclude buckets with zero contributing rows |
| `includeTotals` | `boolean` | `false` | Include `total` count of matching buckets before pagination |
| `nonEmptyKeys` | `boolean` | `false` | Exclude `null`, `undefined`, and `""` keys |
| `keys` | `Array` | — | Restrict output to an allowlist of keys |
| `includeKeys` | `Array` | — | Always include these keys even if outside `limit` (e.g. currently selected items) |
| `search` | `string` | — | Case-insensitive substring filter on bucket keys |

### Metric spec (`kpis[]` / `group.metrics[]`)

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Output key (`snapshot.kpis[id]`, `entry.value[id]`) |
| `op` | `'count' \| 'sum' \| 'avg' \| 'avgNonZero' \| 'ratio'` | Aggregation operator |
| `field` | `string` | Numeric column to aggregate (omitted for `'count'`; numerator for `'ratio'`) |
| `denominator` | `string` | Required for `'ratio'`: numeric column summed as the divisor |

> **`ratio` metrics** sum `field` and `denominator` independently and finalize to `sum(field) / sum(denominator)` (or `null` when the denominator is `0`). Rates and weighted averages re-derive accurately from pre-aggregated rows entirely client-side on every filter with no server re-query.

### Runtime methods

All methods below exist on both `DashboardRuntime` (synchronous return) and `AsyncDashboardRuntime` (returns `Promise<...>`):

| Method | Description |
| --- | --- |
| `query(request)` | Apply filters (or `isolatedFilters`), return `{ snapshot, rows, rowSets, groups, bounds, rowCount }` |
| `snapshot(filters?, options?)` | Compute KPIs and groups without fetching row pages |
| `groups(request?)` | Read/shape one or more groups directly |
| `rows(query?)` / `rowSets(request?)` | Fetch single or multiple named paged row slices (object or columnar) |
| `bounds(request?)` | Compute `{ min, max }` over active rows for requested fields |
| `rowCount(request?)` | Return active row count |
| `updateFilters(filters?)` | Update active filters without reading results |
| `reset()` | Clear all active filters |
| `append(records)` | Append JS row objects and return new dataset size *(sync also exposes `appendColumns`, `appendArrowTable`)* |
| `removeFiltered(selection?)` | Remove `'included'` or `'excluded'` rows and return new dataset size |
| `createGroup(spec)` / `disposeGroup(id)` | Add or remove a group dynamically at runtime |
| `runtimeInfo()` | Inspect active runtime acceleration (`{ active, wasmEnabled, wasmSupported, lastError }`) |
| `dispose()` | Release listeners/caches (and terminate the Web Worker for async runtimes) |
| `ready` / `on(event, fn)` *(streaming worker)* | Promise resolving on load complete; subscribe to `'progress'`, `'snapshot'`, `'ready'`, `'error'` |

## Under the hood

### Architecture

```text
Arrow IPC / TypedArray columns / JS records
    │
    ▼  (optional Web Worker: fetch → Arrow RecordBatchReader → coalesced batch + lookup join)
Columnar Store (zero-copy Float64Array views + lazy Proxy row array)
    │
    ├──► Lazy Filter-Only Dimensions      (0 work until first filter / group / bounds / sort)
    ├──► 1-Bit Columnar Filter Bitsets    (N/8 B per active filter, no 32-dim cap, clz32 + SWAR popcount)
    ├──► Falcon Prefix-Sum Brush Cache    (auto on 2nd consecutive range/exact brush, discrete & continuous)
    └──► AoS Multi-Group Co-Scheduler     (interleaved Float64Array, up to 5 groups + KPI in 1 pass,
                                           CoW unfiltered cache + complement subtraction when >50% active)
    │
    ▼  (postMessage with Transferable TypedArrays in worker mode)
UI / Charts (renders snapshots & columnar row slices only)
```

### Key engine optimizations

1. **1-bit columnar filter bitsets** — Each *active* filter owns a packed `Uint32Array` (1 bit/row, bit `1` = included); clearing a filter is `O(1)`. Sparse row extraction uses `Math.clz32` bit-scanning, `rowCount()` uses branchless SWAR `popcount32`, and there is **no 32-dimension limit**.
2. **Copy-on-Write unfiltered cache + complement subtraction** — Unfiltered group buffers are cached copy-on-write (zero copy during unfiltered streaming appends). Clearing back to 100% is an `O(slots)` restore. When `> 50%` of rows remain active, groups restore the unfiltered cache and subtract only excluded rows, guarded against floating-point cancellation (`abs(v) > 1e12`) and with exact empty-slot zeroing so zero-row buckets never leak FP dust or ghost split keys.
3. **Interleaved AoS buffers + multi-group co-scan** — All metrics for a group slot live contiguously on one cache line in a single `Float64Array`. Dirty groups sharing a metric plan are reduced together (up to 5 groups + KPI per pass) through small specialized leaf kernels for fast V8 JIT tier-up.
4. **Lazy filter-only dimensions** — Declared filter dimensions on columnar data defer dictionary/numeric indexing across init, snapshots, appends, and `dispose()`, materializing transparently on first real access.
5. **Falcon-style prefix-sum brush cache** — Activates automatically on the 2nd consecutive `filterRange`/`filterExact` on the same dimension while other filters stay fixed (0 overhead on single clicks). Discrete dimensions (`≤ 2,048` unique values) answer in `O(slots)` with 0 row scans; continuous float dimensions use 256-bin quantile prefix cubes + CSR boundary bins with deferred bitset materialization.

### Memory footprint

| Component | Size for *N* rows | Example (100K rows) | Notes |
| --- | --- | ---: | --- |
| Unused filter-only dimension | 0 bytes | **0 KB** | Deferred until first filter, group, bounds, or sort access |
| Active filter bitset (1 bit/row) | `N / 8` bytes | **12.5 KB** | Allocated only while filtered; 0 KB when unfiltered; unlimited dims |
| Dictionary `codes` (`Uint32Array`) | `4 × N` bytes | 400 KB | Grows 2× amortized on streaming appends |
| `codeCounts` + `codeToValue` | `~54 × U` bytes | ~54 KB *(1K distinct)* | Shared with `splitField` when field matches a dimension |
| Numeric column (`Float64Array`) | 0 bytes extra | **0 KB** | Zero-copy view for single-batch TypedArray / Arrow float64 columns |
| Row objects (lazy Proxy array) | 0 bytes upfront | **~25 KB** *(50 visible)* | vs. ~50 MB for 100K materialized 20-field JS objects |

## Package entry points

- **ESM:** `import crossfilter from 'crossfilter3'` → `main.js`
- **CommonJS:** `const crossfilter = require('crossfilter3')` → `crossfilter.cjs`
- **Browser UMD / CDN:** `crossfilter.js` / `crossfilter.min.js`
- **TypeScript:** `index.d.ts` (bundled automatically)

## Development & benchmarks

```bash
npm install
npm test                # Vitest suite (684 tests incl. differential fuzzing) + ESLint on src/
npm run build           # Rollup -> crossfilter.js, crossfilter.cjs, crossfilter.min.js
npm run benchmark       # Built-in 100K classic crossfilter benchmark
npm run benchmark:arrow # Arrow ingest & columnar benchmark
```

## License

[Apache-2.0](LICENSE). Based on the original [crossfilter](https://github.com/crossfilter/crossfilter) by Mike Bostock and Jason Davies, and [crossfilter2](https://github.com/crossfilter/crossfilter).
