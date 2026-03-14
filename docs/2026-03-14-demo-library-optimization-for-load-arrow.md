# Crossfilter Demo and Library Optimization for Synmetrix `/load` Arrow/CSV

## Purpose

This document describes what should be improved in the `crossfilter` demo and library so the browser integration is optimal for the deployed Synmetrix `/api/v1/load` interface on `dbx.fraios.dev`.

No code changes are included here. This is a developer handoff document.

The target outcome is:

- the demo uses the deployed `/load` API correctly
- the demo is a truthful showcase of direct ClickHouse Arrow streaming
- the library supports the response metadata needed for robust integrations
- the library and demo preserve low latency, low memory usage, and good observability

## Current verified state

The deployed backend is now working on `dbx.fraios.dev` with:

- direct Arrow streaming from ClickHouse to the client via `/api/v1/load`
- `x-synmetrix-arrow-field-mapping`
- `x-synmetrix-arrow-field-mapping-encoding: base64url-json`

For the tested live query, the mapping decodes to:

```json
{
  "semantic_events__count": "semantic_events.count",
  "semantic_events__location_label": "semantic_events.location_label"
}
```

### What the current demo does right

- It hits `/api/v1/load`, not `/run-sql`, via the local proxy in [demo/proxy-server.mjs](/Users/stefanbaxter/Development/crossfilter/demo/proxy-server.mjs#L34).
- It requests `format: 'arrow'` for live mode in [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L572) and [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L583).
- The streaming worker fetches Arrow itself and feeds `response.body` into Arrow `RecordBatchReader` in [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L458) and [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L503).

### What is currently suboptimal

The current live demo uses two Arrow sources:

- `primary`
- `lookup`

That is configured in [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L604).

With one base source, the worker truly streams into the runtime:

- `streamBaseSourceIntoRuntime(...)` in [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L499)
- used only for the single-source case in [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L724)

With multiple sources, the worker does **not** keep the same streaming property:

- it loads all base batches first via `loadProjectedBatchesFromSource(...)`
- it loads all lookup data into indexes via `buildLookupIndexFromSource(...)`
- it waits on `Promise.all(...)`
- it joins after both sources are fully loaded
- it builds the runtime after buffering

That path is in [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L726) through [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L747).

So today:

- the demo uses the right endpoint
- the library can do true streaming
- the demo is **not** using the library in its most streaming-efficient mode

## Recommended end state

The best realistic end state is:

1. The demo uses **one** Arrow `/load` source for the live dashboard.
2. That single source contains every field needed by the dashboard.
3. The worker streams record batches directly into the runtime from the first batch onward.
4. The proxy forwards Synmetrix Arrow metadata headers.
5. The library surfaces source response metadata to the app.
6. The demo uses a canonical internal field schema that does not depend on Cube alias quirks.
7. The multi-source path remains available, but is clearly documented as a different tradeoff until it is improved.

## Priority 0: Make the live demo a true single-source streaming showcase

### What to change

Replace the current split `primary` + `lookup` live Arrow queries with one consolidated Arrow query.

### Where

- [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L565)
- [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L607)

### Why

The current split query is the main reason the demo is not a true streaming showcase.

The live dashboard already pulls most location columns in the base query. The lookup query only adds:

- `semantic_events.location_code`
- `semantic_events.location_latitude`

That means the split is not saving row cardinality. It is only moving two columns to a second request while forcing the worker into the buffered multi-source path.

In this specific demo, the cost of the split is worse than the benefit.

### How

Refactor `buildLiveSources()` in [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L565) so it returns one `base` source instead of a `primary` plus `lookup` source pair.

Recommended approach:

- Extend `CUBE_DIMENSIONS_PRIMARY` in [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L16) to include:
  - `semantic_events.location_code`
  - `semantic_events.location_latitude`
- Delete `CUBE_DIMENSIONS_LOOKUP` entirely if it is no longer needed.
- Delete `detailQuery`.
- Delete the `lookup` source definition.
- Delete lookup-specific join configuration:
  - `lookupKeyFields`
  - `lookup`
  - `valueFields`
- Expand the base source projection rename map to include:
  - `semantic_events.location_code`
  - `semantic_events.location_latitude`

The resulting source should look conceptually like:

```js
{
  id: 'primary',
  role: 'base',
  dataUrl: CUBE_API,
  dataFetchInit: {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(primaryQuery),
  },
  projection: {
    rename: {
      // existing fields
      // plus location_code and location_latitude
    },
    transforms: {
      [FIELDS.time]: 'timestampMs',
    },
  },
}
```

### Expected result

Once the demo sends a single source, `createStreamingDashboardWorker(...)` will use:

- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L724)

instead of the buffering multi-source path.

That gives:

- earlier first snapshot
- lower peak memory
- better demo truthfulness
- simpler runtime wiring

## Priority 1: Forward the Synmetrix Arrow metadata headers through the demo proxy

### What to change

The proxy should forward the Arrow field-mapping headers from Synmetrix.

### Where

- [demo/proxy-server.mjs](/Users/stefanbaxter/Development/crossfilter/demo/proxy-server.mjs#L91)

### Why

Today the proxy only forwards:

- `content-type`
- `content-length`
- `transfer-encoding`

It drops:

- `x-synmetrix-arrow-field-mapping`
- `x-synmetrix-arrow-field-mapping-encoding`
- `content-disposition`
- any future export-path diagnostic headers

That means the browser-side worker cannot inspect the server’s field mapping even though the backend is already emitting it.

### How

Replace the current tiny response-header allowlist in [demo/proxy-server.mjs](/Users/stefanbaxter/Development/crossfilter/demo/proxy-server.mjs#L91) with one of these patterns:

#### Recommended

Forward a safe allowlist that includes:

- `content-type`
- `content-length`
- `transfer-encoding`
- `content-disposition`
- `content-encoding`
- `cache-control`
- `x-synmetrix-arrow-field-mapping`
- `x-synmetrix-arrow-field-mapping-encoding`
- `x-request-id`

#### Acceptable fallback

Forward all upstream response headers except hop-by-hop headers that should not be copied directly.

### Additional improvement

If the demo proxy is expected to be the canonical local dev path, also propagate client aborts to the upstream request. That is lower priority than the header forwarding, but it makes the proxy behave better for large live Arrow requests.

## Priority 1: Let the streaming worker surface response metadata to the app

### What to change

Expose selected response metadata from each source fetch to the caller.

### Where

- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L458)
- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L705)

### Why

Right now the worker uses the response only for:

- `ok`
- `status`
- `statusText`
- `content-length`
- the body stream

The app receives progress and snapshot information, but not useful source-level response metadata such as:

- content type
- field mapping header
- header encoding
- request/response correlation ids

Without that, the app cannot:

- verify native Arrow passthrough from within the demo
- decode server-supplied schema mappings
- show useful diagnostics in the UI

### How

Extend `getSourceInput(...)` in [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L458) so it captures response metadata and stores it in per-source state.

Suggested shape:

```js
sourceProgress.response = {
  contentType: response.headers.get('content-type') || null,
  contentLength: response.headers.get('content-length') || null,
  arrowFieldMapping: response.headers.get('x-synmetrix-arrow-field-mapping') || null,
  arrowFieldMappingEncoding: response.headers.get('x-synmetrix-arrow-field-mapping-encoding') || null,
}
```

Then expose this in:

- progress events
- ready payload

That state should be part of:

- `progress.sources[sourceId]`

The app should not need to own fetch itself just to inspect response headers.

## Priority 1: Stop treating Cube alias names as the demo’s canonical schema

### What to change

The demo should use stable internal field names that are independent of Cube’s alias format.

### Where

- [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L42)
- [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L616)

### Why

Today the internal `FIELDS` object is alias-based:

- `semantic_events__event`
- `semantic_events__location_label`
- etc.

That works with the current ClickHouse Arrow stream, but it tightly couples the demo to one backend aliasing convention.

The demo is currently tolerant of both semantic-name and alias-name responses because the projection rename maps semantic names into alias-style internal names, while alias-name fields pass through unchanged.

That is functional, but not optimal.

The better internal schema is something app-specific and stable, for example:

- `event`
- `customer_country`
- `location_label`
- `location_country`
- `region`
- `division`
- `municipality`
- `locality`
- `postal_code`
- `postal_name`
- `location_code`
- `latitude`
- `time`

### How

Refactor `FIELDS` in [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L42) to use short internal names.

Then make projection rename maps convert from either:

- semantic names
- alias names

into the stable internal names.

Example:

```js
rename: {
  'semantic_events.event': 'event',
  'semantic_events__event': 'event',
}
```

This decouples the demo from backend schema conventions and makes it easier to compare server modes.

## Priority 1: Support header-driven field mapping in the library

### What to change

The library should be able to consume Synmetrix’s Arrow field-mapping header directly.

### Where

- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L458)
- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L225)

### Why

The backend now emits field mapping information that is specifically designed to help browser consumers interpret direct Arrow passthrough safely.

The current library ignores it entirely.

### How

Add an optional source-level feature for response-header-driven projection normalization.

Recommended source option:

```js
{
  headerFieldMapping: {
    header: 'x-synmetrix-arrow-field-mapping',
    encodingHeader: 'x-synmetrix-arrow-field-mapping-encoding',
    encoding: 'base64url-json',
  }
}
```

Implementation outline:

1. In `getSourceInput(...)`, read the mapping headers.
2. Decode the mapping if present.
3. Convert the header payload into a rename map.
4. Merge that rename map into the source projection before `projectBatch(...)`.

Important direction:

- the header maps `actual_arrow_field_name -> semantic_member_name`
- app projection usually wants `incoming_name -> internal_name`

So the library needs either:

- a two-stage rename
- or a merged rename that first normalizes to semantic names, then to app names

A clean design is:

1. apply response-header normalization
2. apply explicit app projection rename
3. apply transforms

## Priority 2: Make multi-source mode genuinely streaming, or document it as non-streaming

### What to change

The multi-source code path should either:

- become a real streaming pipeline
- or be explicitly documented as a buffering join path

### Where

- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L541)
- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L572)
- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L627)
- [src/dashboard-stream-worker.js](/Users/stefanbaxter/Development/crossfilter/src/dashboard-stream-worker.js#L726)

### Why

The current README and docs describe the demo as a canonical streaming Arrow example, but the multi-source path has a very different memory and latency profile than the single-source path.

That is a documentation accuracy problem and a product clarity problem.

### Recommended implementation order

#### Short-term

Document the truth:

- single-source mode is the true streaming fast path
- current multi-source mode is a worker-side buffering and join path

Relevant docs to update:

- [README.md](/Users/stefanbaxter/Development/crossfilter/README.md#L28)
- [docs/optimal-client-usage.md](/Users/stefanbaxter/Development/crossfilter/docs/optimal-client-usage.md#L167)

#### Medium-term

Improve the multi-source algorithm.

Best practical option:

1. Fully load the smaller lookup sources first and build their indexes.
2. Once lookup indexes are ready, stream the base source directly into the runtime.
3. Apply lookup enrichment per batch before append.

That preserves:

- direct base-source streaming
- worker-owned lookup enrichment

while avoiding full buffering of the base source.

This is likely the right compromise for the current design.

#### Harder option

Support unresolved lookup enrichment and backfilling while base batches are already appended.

That would require much more complicated runtime mutation semantics and is probably not worth it for the demo.

### Why the lookup-first strategy is better here

In this repo’s current demo, the lookup source is conceptually a dimension enrichment table. It is a better candidate for pre-indexing than the base event stream is for full buffering.

## Priority 2: Improve the demo proxy’s request/response streaming behavior

### What to change

The proxy should behave more like a transparent HTTP relay for the live Arrow path.

### Where

- [demo/proxy-server.mjs](/Users/stefanbaxter/Development/crossfilter/demo/proxy-server.mjs#L72)

### Why

The proxy currently:

- buffers the incoming request body into a string
- writes a new HTTPS request manually
- forwards only a narrow response header set

This is acceptable for small JSON query bodies, but not ideal as the canonical demo transport layer.

### How

Recommended improvements:

- forward request aborts/cancellation to the upstream request
- forward more response headers
- preserve chunked transfer without rewriting more than necessary
- consider piping the incoming request directly upstream instead of rebuilding it from a buffered string

This is lower priority than fixing the demo’s data source shape, but it is still worthwhile.

## Priority 2: Make the demo show whether it is on the true fast path

### What to change

The UI should explicitly show what kind of live path it is exercising.

### Where

- [demo/demo.js](/Users/stefanbaxter/Development/crossfilter/demo/demo.js#L1418)
- [demo/index.html](/Users/stefanbaxter/Development/crossfilter/demo/index.html#L26)

### Why

The demo currently labels itself as “Streaming Arrow”, but that label is too vague.

A developer should be able to tell:

- single-source direct Arrow stream
- multi-source joined Arrow load
- mapping header present or absent
- first snapshot latency
- total rows and batches

### How

Once response metadata is exposed from the worker:

- add a badge for `content-type`
- add a badge for `mapping header present`
- add a badge for `sources: 1` vs `sources: 2`
- add a note when the worker is on the multi-source buffering path

This makes the demo much more useful during backend integration work.

## Recommended implementation sequence

### Phase 1: Fix the demo shape

1. Collapse the live data source from two Arrow sources to one.
2. Remove lookup join usage from the demo.
3. Keep the worker on the single-source streaming path.

This gives the biggest benefit immediately.

### Phase 2: Improve metadata and compatibility

1. Forward Arrow mapping headers through the proxy.
2. Surface response metadata from the worker.
3. Normalize to stable internal field names.

This makes the integration resilient and easier to debug.

### Phase 3: Improve the library’s multi-source behavior

1. Update docs to describe current tradeoffs accurately.
2. Implement lookup-first plus streamed-base execution.
3. Then decide whether the demo still needs multi-source mode at all.

## Validation checklist after implementation

After the above changes, a developer should validate:

### Demo path

- live mode performs one `/api/v1/load` Arrow request, not two
- first snapshot appears before the full Arrow payload is loaded
- worker progress shows growing `rowsLoaded` and `batchesLoaded` before `ready`

### Metadata path

- the proxy forwards:
  - `x-synmetrix-arrow-field-mapping`
  - `x-synmetrix-arrow-field-mapping-encoding`
- the worker exposes those headers in source progress/ready metadata
- the demo can display whether the mapping header is present

### Schema path

- the demo works whether Arrow fields arrive as:
  - semantic names
  - Cube alias names
- the internal runtime field names are stable and app-defined

### Performance path

- peak memory is lower than the current two-source version
- first interactive snapshot latency is lower
- runtime creation begins from the first Arrow batch instead of after full source buffering

## Summary

The current demo is close, but not yet optimal.

The main issue is not the backend. The backend is already delivering the correct `/load` Arrow path. The main issue is that the demo is using the library’s multi-source buffering path for a case that can and should be a single-source streaming query.

The fastest path to an optimal result is:

1. consolidate the live demo to one Arrow `/load` source
2. forward and surface the Synmetrix Arrow mapping headers
3. normalize the demo to stable internal field names
4. treat multi-source worker ingest as a separate, currently less-streaming path until the library improves it
