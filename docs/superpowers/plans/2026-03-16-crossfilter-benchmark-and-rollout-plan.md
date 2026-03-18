# Crossfilter Benchmark, Validation, And Rollout Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents are available) or superpowers:executing-plans to implement this validation plan. Steps use checkbox (`- [ ]`) syntax for progress tracking.

**Goal:** Prove that performance work improves real workloads without breaking the crossfilter API, dashboard behavior, or browser responsiveness.

**Companion document:** `docs/superpowers/plans/2026-03-16-crossfilter-performance-roadmap.md`

**What this file covers:**
- semantic regression protection
- benchmark design
- browser responsiveness checks
- worker-runtime acceptance criteria
- memory validation
- staged rollout gates

---

## 1. Validation Principles

- [ ] Every accelerated path must be validated against a known-correct fallback path.
- [ ] Benchmarks must include first-load and repeated-interaction phases separately.
- [ ] Browser responsiveness is a first-class metric, not a side observation.
- [ ] Memory work must be measured with long-running scenarios, not single snapshots.
- [ ] Worker-backed async APIs must be additive and must not silently change the synchronous API contract.

---

## 2. Semantic Regression Matrix

These tests are mandatory before and after each optimization batch.

### 2.1 Core Filter Semantics

- [ ] `filterExact` on present value
- [ ] `filterExact` on absent value
- [ ] `filterExact(null)`
- [ ] `filterExact(undefined)` where supported by current semantics
- [ ] `filterIn` with:
  - one value
  - many values
  - absent values
  - duplicates
- [ ] `filterRange` on:
  - homogeneous numeric data
  - homogeneous string data
  - mixed numeric/string data
  - mixed boolean/numeric/string data
  - ranges that match nothing
  - ranges that match everything
- [ ] `filterAll`
- [ ] `filterFunction`

### 2.2 Filter Lifecycle Cases

- [ ] filter before first `add`
- [ ] filter after first `add`
- [ ] append after active filter
- [ ] append when first batch has zero matches
- [ ] append while another dimension is filtered
- [ ] append while this dimension is filtered
- [ ] remove after filtering
- [ ] filter transitions from filtered-to-filtered, not only all-to-filtered

### 2.3 Grouping Semantics

- [ ] `group().reduceCount()`
- [ ] `group().reduceSum()`
- [ ] custom reduce lifecycle
- [ ] `dimension.groupAll()`
- [ ] top-level `groupAll()`
- [ ] identity grouping on lazy dimensions
- [ ] singleton groups
- [ ] new-key append into existing groups
- [ ] mixed ordering stability after append

### 2.4 Eventing Semantics

- [ ] `onChange("filtered")` fires for lazy exact filters
- [ ] `onChange("dataAdded")` fires for append
- [ ] callback ordering is stable
- [ ] callback removal still works

### 2.5 Iterable And Columnar Cases

- [ ] iterable dimensions with filters
- [ ] iterable `filterExact(null)` semantics
- [ ] columnar Arrow dimensions with lazy filters
- [ ] columnar append with existing groups
- [ ] worker-backed dashboard snapshots match sync runtime snapshots

---

## 3. Benchmark Matrix

The benchmark suite must answer four questions:
- Is loading faster?
- Is interaction faster?
- Is the browser more responsive?
- Is memory lower or at least stable?

### 3.1 Dataset Matrix

- [ ] Small: 50k rows
- [ ] Medium: 250k rows
- [ ] Large: 1m rows
- [ ] Wide: 30+ fields
- [ ] Narrow: 5-10 fields
- [ ] High-cardinality string dimension
- [ ] Low-cardinality string dimension
- [ ] Dense numeric dimensions
- [ ] Mixed scalar dimension for ordering edge cases
- [ ] Append-heavy streaming dataset

### 3.2 Source Matrix

- [ ] row objects
- [ ] `rowsFromColumns`
- [ ] `rowsFromArrowTable`
- [ ] dashboard worker from Arrow buffer
- [ ] streaming dashboard worker from Arrow source(s)

### 3.3 Operation Matrix

- [ ] initial construction
- [ ] first dimension creation
- [ ] first group creation
- [ ] first dashboard snapshot
- [ ] repeated `filterExact`
- [ ] repeated `filterIn`
- [ ] repeated `filterRange`
- [ ] repeated `top`
- [ ] repeated `group().all()`
- [ ] repeated `groupAll().value()`
- [ ] append while unfiltered
- [ ] append while filtered
- [ ] append with existing groups
- [ ] remove filtered rows
- [ ] worker round-trip snapshot
- [ ] worker round-trip group query

### 3.4 Metrics To Capture

- [ ] wall-clock load time
- [ ] first-interaction latency
- [ ] steady-state interaction latency
- [ ] 95th percentile latency
- [ ] main-thread blocking time
- [ ] worker initialization time
- [ ] worker message round-trip time
- [ ] JS heap before load
- [ ] JS heap after load
- [ ] JS heap after 100 repeated filter operations
- [ ] JS heap after repeated append/remove cycles

---

## 4. Browser Responsiveness Plan

Goal B is about the user experience, not only raw compute time.

### 4.1 Main-Thread Measurements

- [ ] Add a browser benchmark mode that measures frame blocking during:
  - load
  - first snapshot
  - repeated filter interactions
  - append bursts
- [ ] Record frame drops or frame budget overruns during 60fps interaction simulations.
- [ ] Compare:
  - sync row baseline
  - sync Arrow + WASM
  - worker-backed dashboard runtime
  - streaming worker runtime

### 4.2 Acceptance Targets

Suggested targets for interactive dashboards:

- [ ] filter interactions should stay under one frame budget for medium datasets where worker mode is enabled
- [ ] repeated worker snapshots should not starve UI input handling
- [ ] initial worker boot must not erase the steady-state advantage

---

## 5. Memory Validation Plan

Goal D needs its own test plan because optimizations can trade time for memory.

### 5.1 Memory Scenarios

- [ ] load Arrow table and never call row-returning APIs
- [ ] load Arrow table and repeatedly call `top()`
- [ ] load Arrow table, group, filter, append, and remove in cycles
- [ ] worker runtime with repeated snapshots
- [ ] streaming worker runtime with many appended batches

### 5.2 Memory Questions To Answer

- [ ] how much memory is used by `data[]` alone?
- [ ] how much is used by `columnarBatches`?
- [ ] how much is used by `lazyEncodedState`?
- [ ] how many rows get permanently materialized by common dashboards?
- [ ] does repeated `top()` keep growing retained row objects?
- [ ] do append/remove cycles leave oversized buffers behind?
- [ ] does worker mode duplicate large buffers unnecessarily?

### 5.3 Memory Acceptance Gates

- [ ] no unbounded retained-row growth in columnar-heavy paths
- [ ] repeated filtering does not steadily increase heap
- [ ] append/remove cycles return to a stable memory envelope
- [ ] worker mode shows either lower main-thread heap or clearly better responsiveness that justifies its memory cost

---

## 6. Async And Worker API Validation

If a generic async worker runtime is introduced, it needs a separate contract from the synchronous API.

### 6.1 Required Worker Behaviors

- [ ] initialization from rows
- [ ] initialization from columns
- [ ] initialization from Arrow buffer
- [ ] append support
- [ ] filter update support
- [ ] grouped query support
- [ ] row query support
- [ ] runtime info reporting
- [ ] clean disposal

### 6.2 Required Worker Semantics

- [ ] worker results match sync runtime results for the same inputs
- [ ] stale responses are not applied after newer requests
- [ ] cancellation or request versioning is in place for rapid UI interaction
- [ ] transferables are used where beneficial
- [ ] failure messages include enough detail to debug runtime or data issues

### 6.3 Worker Benchmark Questions

- [ ] does worker mode reduce main-thread blocking enough to justify serialization overhead?
- [ ] is worker init cost acceptable for one-shot dashboards?
- [ ] do repeated filter changes amortize worker setup cost?
- [ ] does streaming worker mode outperform repeated full snapshots?

---

## 7. Rollout Stages

### Stage 1: Correctness Hardening

- [ ] land semantic regression tests
- [ ] fix any accelerated-path/fallback mismatches
- [ ] require all green tests before more optimization PRs

### Stage 2: Safe Internal Optimizations

- [ ] lazy append improvements
- [ ] `codeCounts` and buffer reuse
- [ ] safe lazy `groupAll`
- [ ] safe row-materialization reductions

### Stage 3: Benchmark-Driven Refinement

- [ ] run benchmark suite before and after each optimization batch
- [ ] keep a markdown record of benchmark deltas in `docs/` or `test/results/`
- [ ] reject optimizations that add complexity without a measurable win

### Stage 4: Additive Async Runtime

- [ ] prototype worker-backed generic runtime
- [ ] validate parity against synchronous runtime
- [ ] benchmark responsiveness and heap behavior
- [ ] only then expose as supported public API

### Stage 5: Productionization

- [ ] finalize docs
- [ ] update demos
- [ ] update benchmark summaries
- [ ] rebuild checked-in bundles if required

---

## 8. Recommended Commands

- [ ] Run full tests:
  - `./node_modules/.bin/vitest run`
- [ ] Run lazy/filter-specific tests:
  - `./node_modules/.bin/vitest run test/crossfilter.test.js`
  - `./node_modules/.bin/vitest run test/columnar.test.js`
  - `./node_modules/.bin/vitest run test/dashboard.test.js`
- [ ] Run lint:
  - `./node_modules/.bin/eslint src/`
- [ ] Run benchmark matrix:
  - `node test/benchmark-arrow.mjs`
- [ ] Build distributables:
  - `npm run build`

---

## 9. Final Ship Checklist

- [ ] accelerated and fallback paths match on semantic edge cases
- [ ] benchmark deltas are recorded
- [ ] browser responsiveness is measured, not assumed
- [ ] memory behavior is measured after long interaction loops
- [ ] async APIs are additive
- [ ] synchronous core API remains untouched in behavior
- [ ] docs and demos are updated

