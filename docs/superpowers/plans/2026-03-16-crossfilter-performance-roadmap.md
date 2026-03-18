# Crossfilter Performance And Async Roadmap

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents are available) or superpowers:executing-plans to implement this roadmap. Steps use checkbox (`- [ ]`) syntax so progress can be tracked in-place.

**Goal:** Improve four things without breaking the existing synchronous crossfilter API contract:
- A. Faster Arrow + WASM loading and incremental append
- B. More work off the main browser thread
- C. Faster filtering, grouping, and query calculations
- D. Lower steady-state memory use

**Constraint:** Existing `crossfilter()` semantics must remain correct and synchronous. Async behavior must be additive, not a silent change to `add()`, `filter*()`, `group().all()`, `top()`, or `bottom()`.

**Current status:**
- A is partially achieved. Columnar Arrow inputs and lazy encoded dimensions improve several hot paths.
- B is only achieved through dashboard worker wrappers. Core crossfilter remains synchronous on the caller thread.
- C is partially achieved. Exact and inclusion filters on eligible dimensions are faster, but several operations still materialize.
- D is partially achieved. Recent lazy-code append work reduces some copies, but the engine can still hold row objects, columnar batches, and encoded state at the same time.

**Important correctness note:** Any new acceleration must preserve crossfilter natural-order semantics. The lazy `filterRange` fast path must not use raw JavaScript comparison for mixed-type data unless the optimization is explicitly gated to safe homogeneous types.

**Primary files likely to change:**
- `src/index.js`
- `src/wasm.js`
- `src/columnar.js`
- `src/dashboard.js`
- `src/dashboard-worker.js`
- `src/dashboard-stream-worker.js`
- `test/crossfilter.test.js`
- `test/columnar.test.js`
- `test/dashboard.test.js`
- `test/benchmark-arrow.mjs`
- `test/benchmark-arrow-browser.mjs`

**Success criteria:**
- No regression in the existing synchronous API.
- All optimization paths are covered by tests that compare accelerated behavior to the materialized fallback behavior.
- Browser-facing heavy workflows have a worker-backed option.
- Benchmarks show measurable improvement on realistic Arrow datasets, not only microbenchmarks.
- Memory use is reduced or at least does not grow materially in the common Arrow + worker path.

---

## Phase 0: Lock Down Semantics Before More Optimization

This phase exists to prevent performance work from drifting away from the crossfilter contract.

- [ ] Add regression tests for mixed-type `filterRange` on accelerated dimensions.
  Files:
  - `test/crossfilter.test.js`
  Cases:
  - numeric + string values in a single dimension
  - boolean + numeric + string values in a single dimension
  - `null`, `undefined`, `NaN`, and symbol-free mixed scalar values
  Acceptance:
  - accelerated and fallback/materialized results match exactly

- [ ] Audit every lazy fast path against the materialized implementation.
  Files:
  - `src/index.js`
  Methods to compare:
  - `filterExact`
  - `filterIn`
  - `filterRange`
  - `filterAll`
  - `group`
  - `groupAll`
  - append while filtered
  - remove while filtered
  Acceptance:
  - each path is either semantically identical or explicitly gated off

- [ ] Narrow the lazy `filterRange` fast path until it is provably safe.
  Files:
  - `src/index.js`
  Options:
  - preferred: use `compareNaturalOrder` semantics when scanning `codeToValue`
  - fallback: only keep the fast path for homogeneous numeric and homogeneous string encoded dimensions
  Acceptance:
  - mixed-type range behavior matches the existing fallback path

- [ ] Add a "semantic safety checklist" comment block near the lazy path entry points.
  Files:
  - `src/index.js`
  Purpose:
  - document that lazy optimization is allowed only when ordering, equality, and filter lifecycle remain identical to the materialized path

---

## Phase 1: Finish The Lazy Encoded Dimension Path

This phase is the highest ROI within the current architecture because it reduces unnecessary materialization while keeping the API intact.

### Workstream 1.1: Keep The Lazy Path Alive Through Append

- [ ] Keep encoded append active when index listeners exist but are themselves lazy-capable.
  Current issue:
  - the original design materialized on append as soon as `indexListeners.length` became nonzero
  Desired behavior:
  - only materialize when an attached listener truly requires `values/index`
  Files:
  - `src/index.js`
  Design:
  - classify listeners into lazy-capable and materialized-only
  - pass encoded append metadata to lazy-capable listeners
  - preserve current `newValues/newIndex` behavior for legacy listeners
  Acceptance:
  - a grouped accelerated dimension can append multiple batches without forcing `values/index`

- [ ] Make lazy append support both "no new groups" and "new groups appear" paths.
  Files:
  - `src/index.js`
  Cases:
  - append only existing encoded keys
  - append one or more previously unseen keys
  - append while another dimension is filtered
  - append while this dimension is filtered
  Acceptance:
  - `group().all()` and `group().top()` remain correct after each append

- [ ] Extend the lazy append plan to `groupAll`.
  Files:
  - `src/index.js`
  Desired behavior:
  - `dimension.groupAll()` should not force full materialization when the dimension remains encoded
  Notes:
  - singleton group state is easier than keyed grouping and should be treated as a first-class optimization target

### Workstream 1.2: Eliminate Repeated O(n) Work On Append

- [ ] Keep amortized-growth `codes` buffers and incremental `codeCounts` updates.
  Files:
  - `src/index.js`
  Requirements:
  - logical length separate from capacity
  - all readers use logical codes length, not backing buffer length
  - remove and compaction paths keep counts consistent
  Acceptance:
  - append no longer rescans the full code array to rebuild counts

- [ ] Reuse scratch buffers where possible in lazy selection updates.
  Files:
  - `src/index.js`
  Targets:
  - `encodeLazyFilterValues`
  - `applyLazySelectionState`
  - `applyLazyFilterToNewRows`
  Goal:
  - reduce transient typed-array allocations during interactive filtering

- [ ] Add low-level tests for capacity growth and compaction correctness.
  Files:
  - `test/crossfilter.test.js`
  Cases:
  - append below capacity
  - append above capacity
  - remove after capacity growth
  - append after remove

### Workstream 1.3: Expand Safe Lazy Filtering

- [ ] Keep `filterExact` and `filterIn` fully encoded when possible.
  Files:
  - `src/index.js`
  Focus:
  - empty target set
  - unknown target value
  - pending filter before first data
  - callback / `onChange` behavior

- [ ] Only keep lazy `filterRange` where ordering is safe.
  Files:
  - `src/index.js`
  Follow-up:
  - if safe mixed-type range support becomes too expensive, keep exact/in lazy and range materialized for non-homogeneous types

- [ ] Do not attempt lazy `filterFunction` in this phase unless a clearly safe representation exists.
  Reason:
  - arbitrary predicates are the least likely to preserve semantics cheaply

---

## Phase 2: Improve Arrow And Columnar Loading

This phase is mostly about goal A and secondarily goal D.

### Workstream 2.1: Avoid Unnecessary Row Materialization

- [ ] Keep Arrow and columnar batches in columnar form for as long as possible.
  Files:
  - `src/index.js`
  - `src/columnar.js`
  Current behavior:
  - `getRecord()` materializes rows into `data[]` on demand
  Improvement target:
  - do not materialize rows for reducers that can use `getFieldValue`
  - delay row creation until APIs actually return row objects

- [ ] Audit reducers and helper methods for row-materialization dependence.
  Files:
  - `src/index.js`
  Methods:
  - `reduceAdd`
  - `reduceRemove`
  - metric-spec reducers
  - `top`
  - `bottom`
  Goal:
  - where possible, pull fields directly from columnar storage instead of creating row objects

- [ ] Add an optional bounded row-cache policy for columnar batches.
  Files:
  - `src/index.js`
  Rationale:
  - repeated `top()` and `bottom()` calls benefit from caching
  - unrestricted caching works against goal D
  Deliverable:
  - configurable or internal LRU-like row cache for materialized columnar rows

### Workstream 2.2: Encode Directly From Columnar Accessors

- [ ] Prefer accessor-driven encoding over extracting temporary JS arrays.
  Files:
  - `src/index.js`
  Existing support:
  - direct accessor path exists for single-column segments
  Gap:
  - row-object accessors that are still simple and scalar may still allocate temporary arrays in some flows

- [ ] Explore a direct row-to-code encoder for row-object sources.
  Files:
  - `src/index.js`
  Goal:
  - avoid building a transient `sourceValues` array before encoding
  Constraints:
  - preserve current error handling for unsupported values
  - do not regress non-columnar inputs

### Workstream 2.3: Make Loading Faster In Practice

- [ ] Benchmark first-add cost separately from steady-state filter cost.
  Files:
  - `test/benchmark-arrow.mjs`
  Metrics:
  - worker init time
  - Arrow parse time
  - first dimension creation time
  - first group build time
  - first snapshot time

- [ ] Separate WASM startup cost from query speed in benchmark reporting.
  Files:
  - `test/benchmark-arrow.mjs`
  Reason:
  - load-time regressions can hide behind faster steady-state filtering

---

## Phase 3: Move Heavy Work Off The Main Thread

This phase is required if goal B is a true product requirement rather than a nice-to-have.

### Principle

Do not make the existing core crossfilter API implicitly asynchronous. That would be an API break in practice. Instead, add worker-backed runtimes that expose async request/response methods while preserving the synchronous core library for current consumers.

### Workstream 3.1: Define A Generic Worker Runtime

- [ ] Introduce a generic worker-backed crossfilter runtime alongside the existing dashboard workers.
  Possible API:
  - `crossfilter.createWorkerRuntime(options)`
  - `crossfilter.createStreamingWorkerRuntime(options)`
  Files:
  - new worker wrapper module, likely modeled after:
    - `src/dashboard-worker.js`
    - `src/dashboard-stream-worker.js`
  Requirements:
  - initialize from rows, columns, or Arrow
  - expose async equivalents of the most valuable operations
  - transfer typed arrays where possible

- [ ] Keep the API additive and explicit.
  Rules:
  - `crossfilter()` remains synchronous
  - worker runtime methods return promises
  - async behavior is opt-in at construction time

- [ ] Define the minimal worker command surface.
  Candidate commands:
  - `init`
  - `add`
  - `appendArrowTable`
  - `updateFilters`
  - `snapshot`
  - `groups`
  - `rows`
  - `rowSets`
  - `removeFiltered`
  - `runtimeInfo`
  - `dispose`

### Workstream 3.2: Streaming And Progressive Results

- [ ] Build on the existing streaming dashboard worker design rather than inventing a second transport model.
  Files:
  - `src/dashboard-stream-worker.js`
  Reuse:
  - request/response correlation
  - progress events
  - typed-array transfer
  - snapshot publishing

- [ ] Add cancellation or versioned-response handling for repeated filter updates.
  Goal:
  - avoid stale worker responses being applied after newer user interactions

- [ ] Decide whether "streaming" means:
  - incremental Arrow ingestion
  - progressive result publication
  - both
  Deliverable:
  - document exact semantics and event model

### Workstream 3.3: Browser Integration

- [ ] Expose worker-ready benchmark and demo paths.
  Files:
  - `test/dashboard-worker-demo.mjs`
  - browser benchmark harness
  Goals:
  - measure main-thread responsiveness
  - compare sync vs worker modes on realistic dashboards

---

## Phase 4: Reduce Memory Use Without Losing Speed

This phase is about goal D and should be measured, not assumed.

### Workstream 4.1: Identify Duplicate Storage

- [ ] Measure overlap between:
  - `data[]`
  - `columnarBatches`
  - `lazyEncodedState.codes`
  - materialized row cache
  Files:
  - benchmark harness
  - browser performance tooling notes

- [ ] Define acceptable storage modes.
  Preferred modes:
  - row-only for classic row-object inputs
  - columnar + encoded for Arrow/columnar pipelines
  - bounded row materialization only when caller needs rows

### Workstream 4.2: Reuse Scratch Memory

- [ ] Centralize reusable typed-array scratch state.
  Files:
  - `src/index.js`
  - `src/wasm.js`
  Good targets:
  - match result scratch
  - selection masks
  - appended match arrays
  - range code buffers

- [ ] Avoid keeping both oversized buffers and exact copies unless required.
  Example:
  - if a backing `codes` buffer is overallocated, do not also keep a second exact-fit copy for routine operations

### Workstream 4.3: Add Optional Memory-Oriented Modes

- [ ] Consider optional runtime knobs for memory-sensitive applications.
  Candidate options:
  - bounded row cache
  - eager compaction after large remove
  - disable certain lazy caches
  Constraint:
  - defaults must preserve current behavior unless the tradeoff is clearly beneficial

---

## Phase 5: Benchmarking, Acceptance Gates, And Rollout

- [ ] Define baseline benchmark datasets.
  Sizes:
  - 50k rows
  - 250k rows
  - 1m rows
  Shapes:
  - Arrow homogeneous numeric
  - Arrow mixed scalar dimensions
  - row-object baseline
  - append-heavy streaming case

- [ ] Define baseline operations.
  Operations:
  - initial load
  - first dimension creation
  - first group build
  - repeated `filterExact`
  - repeated `filterIn`
  - repeated `filterRange`
  - append while filtered
  - append with existing groups
  - `top`
  - `groupAll`
  - worker snapshot round-trip

- [ ] Set hard acceptance gates for landing optimization PRs.
  Suggested gates:
  - no semantic regressions
  - no meaningful regression in small-data cases
  - measurable win in at least one target workload
  - stable memory behavior after repeated filter/appends

- [ ] Roll out in this order:
  1. semantic guardrails and test hardening
  2. lazy append and `groupAll` improvements
  3. Arrow loading and row-materialization reductions
  4. worker-backed generic runtime
  5. optional memory-tuning controls

---

## Recommended Delivery Order

If only a subset can be shipped soon, the order below gives the best balance of value and safety:

- [ ] Ship semantic fixes and regression tests first.
- [ ] Ship lazy append / incremental group support second.
- [ ] Ship safe lazy `groupAll` third.
- [ ] Ship Arrow loading and row-cache improvements fourth.
- [ ] Ship generic async worker runtime fifth.
- [ ] Ship advanced memory tuning last.

---

## Implementation Notes For Future Agents

- Keep all new optimizations behind semantic checks, not only capability checks.
- When behavior differs between lazy and materialized paths, trust the materialized path and either match it or bail out to it.
- Do not convert existing synchronous APIs to promise-returning APIs.
- Prefer adding worker-backed runtimes rather than threading async through the core object model.
- Every optimization PR should include:
  - targeted regression tests
  - benchmark delta
  - a note on memory impact
  - build update if distributables are checked in

