# Optimal client usage

This document describes the fastest supported way to use `crossfilter2` in browser dashboards.

The short version is:

1. Stream Arrow IPC into `createStreamingDashboardWorker(...)`.
2. Keep fetch, Arrow decode, batch append, filters, groups, and KPI reducers in the worker.
3. Send declarative filters in, and read snapshots plus small row slices back out.
4. Use field-name dimensions with `filterExact`, `filterIn`, and `filterRange`.
5. Reuse one long-lived runtime per dashboard.

If you follow that pattern, the main thread only renders UI.

## Preferred browser architecture

For the current engine, the best browser path is:

- `crossfilter.createStreamingDashboardWorker(...)` for worker-owned fetch and streaming decode
- Arrow IPC, not pre-materialized JSON rows
- simple dimension accessors (string or `d => d.field` — both auto-optimized)
- declarative groups and KPI specs through `createDashboardRuntime(...)` / worker runtimes
- `rows(...)` for paged table slices
- `append(records)` or `removeFiltered(...)` for live demo-style data mutation without rebuilding the runtime

The slower fallback paths are still supported, but they leave performance on the table:

- decoding Arrow on the main thread
- building row-object arrays before ingest
- using `filterFunction(...)` for discrete selections
- rebuilding dimensions/groups on each interaction
- returning full row payloads to the UI when the UI only needs aggregates

## Automatic WASM acceleration for function accessors

Function accessors like `cf.dimension(d => d.field)` are now automatically optimized.
The library extracts the property name from simple accessor functions and uses it to enter
the same fast WASM-encoded path that string accessors use. These are all equivalent:

```js
cf.dimension('country');                          // string accessor (original fast path)
cf.dimension(d => d.country);                     // arrow function (now auto-optimized)
cf.dimension(function(d) { return d.country; });  // traditional function (now auto-optimized)
cf.dimension(d => d['country']);                   // bracket notation (now auto-optimized)
```

The auto-extraction only works for simple single-property access. Functions with
transformations, defaults, or multi-level paths fall back to the standard path:

```js
cf.dimension(d => d.field ?? '');      // not extracted (has default)
cf.dimension(d => -d.field);           // not extracted (negation)
cf.dimension(d => d.a.b);             // not extracted (nested path)
```

This means existing code using the classic crossfilter API (dc.js, etc.) gets WASM
acceleration without any changes.

### What the lazy encoded path accelerates

When a dimension enters the lazy encoded path (via string or auto-extracted accessor):

- **filterExact / filterIn**: use WASM-accelerated encoded matching
- **filterRange**: scans the encoded value set instead of materializing and sorting
- **group / groupAll**: build groups directly from encoded values without materialization
- **data.add()**: appends use capacity-growth buffers (amortized O(1)) and incremental
  group updates (O(batchSize) instead of O(n log n) materialization)

The only operations that force materialization back to sorted arrays are:
- `filterFunction(...)` (arbitrary predicates cannot be encoded)
- `top()` / `bottom()` on the dimension itself (need sorted order)
- Non-orderable dimension values (objects, mixed types)

## Dashboard-specific API

The package now exposes a dashboard-oriented API in addition to the classic crossfilter API:

- `crossfilter.createDashboardRuntime(...)`
- `crossfilter.createDashboardWorker(...)`
- `crossfilter.createStreamingDashboardWorker(...)`

These APIs are designed for dashboard workloads:

- declarative filter state
- declarative KPI specs
- declarative group specs
- declarative time bucketing for timeline groups
- worker-backed snapshots and row slices
- direct Arrow / columnar ingest

Use `createDashboardRuntime(...)` when you want the new dashboard API synchronously.

Use `createDashboardWorker(...)` when you already have a full Arrow buffer and want a one-shot worker build.

Use `createStreamingDashboardWorker(...)` when you want the fastest browser path.

## Fastest path: streaming worker runtime

```js
const runtime = await crossfilter.createStreamingDashboardWorker({
  dataUrl: '/api/query-result.arrow',
  crossfilterUrl: '/crossfilter.js',
  arrowRuntimeUrl: '/vendor/apache-arrow/Arrow.es2015.min.js',
  wasm: true,
  emitSnapshots: true,
  progressThrottleMs: 100,
  snapshotThrottleMs: 250,
  batchCoalesceRows: 65536,
  dimensions: ['country', 'event', 'region', 'time'],
  kpis: [
    { id: 'rows', op: 'count' },
    { id: 'avgLatitude', field: 'latitude', op: 'avgNonZero' },
  ],
  groups: [
    {
      id: 'byEvent',
      field: 'event',
      metrics: [{ id: 'rows', op: 'count' }],
    },
    {
      id: 'timeline_month',
      field: 'time',
      bucket: { type: 'timeBucket', granularity: 'month' },
      metrics: [{ id: 'rows', op: 'count' }],
    },
  ],
});
```

Why this is the preferred path:

- the worker owns the network request
- Arrow record batches are decoded incrementally in the worker
- the runtime is created from the first batch, not after the whole payload is buffered
- later batches are appended inside the worker
- small streamed batches are coalesced before append to reduce repeated dimension/group maintenance
- the main thread does not pay Arrow decode or indexing cost

## What the async runtime exposes

Worker-backed runtimes are Promise-based on purpose. That is how browser offloading works without pretending a synchronous main-thread API can magically become background work.

The async runtime exposes:

- `await runtime.ready`
- `runtime.on('progress', listener)`
- `runtime.on('snapshot', listener)`
- `await runtime.query({ filters, rows })`
- `await runtime.snapshot(filters)`
- `await runtime.rows(query)`
- `await runtime.updateFilters(filters)`
- `await runtime.append(records)`
- `await runtime.removeFiltered(selection)`
- `await runtime.reset()`
- `await runtime.dispose()`

Example:

```js
runtime.on('progress', (progress) => {
  console.log(progress.status, progress.fetch.percent, progress.load.rowsLoaded);
});

runtime.on('snapshot', ({ progress, snapshot }) => {
  console.log('partial snapshot', progress.rowsLoaded, snapshot.kpis.rows);
});

await runtime.ready;

const result = await runtime.query({
  filters: {
    country: { type: 'in', values: ['IS', 'UK'] },
    time: { type: 'range', range: [startMs, endMs] },
  },
  rows: {
    sortBy: 'time',
    direction: 'top',
    limit: 50,
    offset: 0,
    fields: ['event', 'country', 'region', 'time'],
  },
});

const snapshot = result.snapshot;
const rows = result.rows;
```

## Canonical demo pattern

`demo/demo.js` is the canonical browser demo.

Its job is still the same as before:

- show interactive crossfiltering
- show linked charts, filters, KPIs, and tables
- show that data mutation still works

What changed is the implementation underneath it:

- the demo now uses `createStreamingDashboardWorker(...)`
- the worker owns fetch, Arrow decode, batch append, filters, groups, and KPIs
- the live demo path uses a single Synmetrix `/api/v1/load` Arrow query so runtime creation starts from the first batch
- the main thread renders snapshots and paged table rows
- the demo uses `runtime.query({ filters, rows })` for the hot interaction path so each filter change uses one worker round-trip for both aggregates and the first table page
- the demo coalesces rapid UI-triggered refreshes per animation frame so the main thread does not spam the worker with redundant requests
- the demo still supports live add/remove behavior by calling `runtime.append(...)` and `runtime.removeFiltered('excluded')`
- the demo shows persistent runtime status from `runtime.on('progress')`, including fetch/load totals and per-source state

That is the intended integration pattern for real applications as well: preserve the dashboard UX, move the heavy work off the main thread.

## Streaming Arrow responses

Yes: `createStreamingDashboardWorker(...)` is built for streaming Arrow responses from a server.

Preferred interface:

```js
const runtime = await crossfilter.createStreamingDashboardWorker({
  dataUrl: '/api/query-result.arrow',
  dataFetchInit: {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  },
  crossfilterUrl: '/crossfilter.js',
  arrowRuntimeUrl: '/vendor/apache-arrow/Arrow.es2015.min.js',
  wasm: true,
  dimensions: ['country', 'event', 'region', 'time'],
  groups: [...],
  kpis: [...],
});
```

What you get:

- worker-owned fetch
- incremental Arrow decode
- runtime creation from the first batch
- progressive append of later batches
- optional partial snapshot emission while loading
- explicit fetch/load progress reporting

Progress payloads separate network progress from data-loading progress:

- `progress.fetch.bytesLoaded`
- `progress.fetch.totalBytes`
- `progress.fetch.percent`
- `progress.load.rowsLoaded`
- `progress.load.batchesLoaded`
- `progress.status`
- `progress.sources` for per-source progress when multiple Arrow sources are used

For high-frequency UI interactions, keep the client side declarative as well:

- send one combined `runtime.query({ filters, rows })` request for each dashboard refresh
- coalesce multiple synchronous UI changes into one scheduled refresh per animation frame
- prefer event delegation for large dynamic filter lists so rerenders do not attach fresh listeners to every item

`batchCoalesceRows` controls the throughput vs. partial-update tradeoff:

- larger values favor ingest throughput
- smaller values favor more frequent intermediate updates

## Multi-source streaming and lookup joins

For split-query dashboards, the streaming worker can consume multiple Arrow sources and join lookup fields in the worker before building the runtime.

This is a supported path, but it is not the fastest path. The fastest browser path remains a single Arrow source streamed directly into the runtime.

```js
const runtime = await crossfilter.createStreamingDashboardWorker({
  crossfilterUrl: '/crossfilter.js',
  arrowRuntimeUrl: '/vendor/apache-arrow/Arrow.es2015.min.js',
  wasm: true,
  dimensions: [
    'semantic_events__event',
    'semantic_events__location_country',
    'semantic_events__location_region',
    'semantic_events__timestamp_minute',
  ],
  kpis: [{ id: 'rows', op: 'count' }],
  groups: [{ id: 'byEvent', field: 'semantic_events__event', metrics: [{ id: 'rows', op: 'count' }] }],
  sources: [
    {
      id: 'primary',
      role: 'base',
      dataUrl: '/api/primary.arrow',
      projection: {
        rename: {
          'semantic_events.event': 'semantic_events__event',
          'semantic_events.location_country': 'semantic_events__location_country',
          'semantic_events.location_region': 'semantic_events__location_region',
          'semantic_events.timestamp.minute': 'semantic_events__timestamp_minute',
        },
        transforms: {
          semantic_events__timestamp_minute: 'timestampMs',
        },
      },
    },
    {
      id: 'detail',
      role: 'lookup',
      dataUrl: '/api/detail.arrow',
      projection: {
        rename: {
          'semantic_events.location_country': 'semantic_events__location_country',
          'semantic_events.location_region': 'semantic_events__location_region',
          'semantic_events.location_label': 'semantic_events__location_label',
          'semantic_events.location_latitude': 'semantic_events__location_latitude',
        },
      },
      lookup: {
        keyFields: [
          'semantic_events__location_country',
          'semantic_events__location_region',
        ],
        valueFields: [
          'semantic_events__location_label',
          'semantic_events__location_latitude',
        ],
      },
    },
  ],
});
```

## Live mutation without rebuilding

The dashboard runtimes now support cheap live data mutation on top of the optimized load path.

Synchronous runtime:

```js
const runtime = crossfilter.createDashboardRuntime({
  columns,
  columnarOptions,
  dimensions: ['country', 'event'],
  kpis: [{ id: 'rows', op: 'count' }],
  wasm: true,
});

runtime.append([{ country: 'IS', event: 'stay' }]);
runtime.removeFiltered('excluded');
```

Async worker runtime:

```js
await runtime.append([{ country: 'IS', event: 'stay' }]);
await runtime.removeFiltered('excluded');
```

`removeFiltered('excluded')` is useful for demo-style "keep only the visible subset" flows without rebuilding the dashboard runtime.

## Recommended synchronous fallback

If you cannot use a worker, the best synchronous path is Arrow + native filters.
Both string and function accessors get full WASM acceleration:

```js
import crossfilter from '@smartdatahq/crossfilter';
import { tableFromIPC } from 'apache-arrow';

const response = await fetch('/data/query-result.arrow');
const buffer = await response.arrayBuffer();
const table = tableFromIPC(new Uint8Array(buffer));

crossfilter.configureRuntime({ wasm: true });
const cf = crossfilter.fromArrowTable(table);

// Both styles are equivalent — function accessors are auto-optimized
const country = cf.dimension('customer_country');
const event = cf.dimension(d => d.event);
const time = cf.dimension(function(d) { return d.timestamp; });
```

Prefer:

```js
country.filterExact('Italy');
country.filterIn(['Italy', 'Hungary']);
time.filterRange([startMs, endMs]);
```

Avoid:

```js
country.filterFunction((value) => selected.has(value));
```

## Use declarative time buckets for timeline groups

Use the runtime’s built-in time bucket groups instead of rebuilding client-side histograms:

```js
const runtime = crossfilter.createDashboardRuntime({
  table,
  wasm: true,
  dimensions: ['time'],
  groups: [
    {
      id: 'timeline_month',
      field: 'time',
      bucket: { type: 'timeBucket', granularity: 'month' },
      metrics: [{ id: 'rows', op: 'count' }],
    },
  ],
  kpis: [{ id: 'rows', op: 'count' }],
});
```

This keeps timeline aggregation inside the optimized engine path and makes worker snapshots simpler.

## Multiple crossfilters on one page

Multiple crossfilter instances and multiple dashboard runtimes can coexist on the same page.

Use instance-scoped runtime configuration when behavior differs per instance:

```js
const cfFast = crossfilter.fromArrowTable(tableA);
const cfCompat = crossfilter.fromArrowTable(tableB);

cfFast.configureRuntime({ wasm: true });
cfCompat.configureRuntime({ wasm: false });
```

Important details:

- `cf.configureRuntime(...)` affects only that instance
- `cf.runtimeInfo()` reports that instance’s runtime
- `crossfilter.configureRuntime(...)` only sets defaults for future instances
- each dashboard runtime / worker runtime is isolated from the others

If your app hosts several dashboards, keep one long-lived runtime per dashboard.

## Practical checklist

Prefer this:

- Arrow IPC input
- `createStreamingDashboardWorker(...)` in the browser
- simple dimension accessors (string or `d => d.field` — both get WASM acceleration)
- `filterExact`, `filterIn`, `filterRange`
- declarative groups and KPIs
- worker snapshots plus paged `rows(...)`
- long-lived runtimes
- `append(...)` / `removeFiltered(...)` for demo-style mutation

Avoid this:

- main-thread Arrow decode when a worker is available
- row-object materialization before ingest
- complex accessor functions that prevent auto-extraction (e.g., `d => d.field ?? ''`, `d => fn(d)`)
- `filterFunction(...)` for discrete selection
- rebuilding crossfilter or dashboard runtimes on each interaction
- returning entire datasets to the UI when aggregates or row slices are enough
