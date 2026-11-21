# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crossfilter3 is a JavaScript library for fast multidimensional filtering of large datasets, commonly used with coordinated visualization views (e.g., dc.js). It uses sorted indexes and bitwise filter arrays for incremental filtering/reducing. Published as `crossfilter3` on npm.

## Commands

- **Test:** `npm test` (runs vitest then eslint on src/)
- **Build:** `npm run build` (rollup → `crossfilter.js`, `crossfilter.cjs`, `crossfilter.min.js`)
- **Benchmark:** `npm run benchmark` or `npm run benchmark:arrow`
- **Single test file:** `npx vitest run test/crossfilter.test.js`
- **Lint only:** `npx eslint src/`

## Architecture

**Entry points:**
- `index.js` — UMD / CJS build entry (adds `version` from package.json)
- `main.js` — ESM entry (re-exports `src/index.js`)

**Core (`src/index.js`):** Contains the `crossfilter()` factory and the `dimension()` / `group()` / `groupAll()` inner functions. All filtering state (1-bit filter bitset store, lazy/raw columnar dimension state, CoW unfiltered metric caches, Falcon brush controller, sorted indexes, data/columnar batches) is closure-scoped inside the factory. Includes:
- **Lazy filter-only dimensions**: string-accessor dimensions on columnar datasets defer encoding (`deferredInit`) until first filter/group/bounds/sort/JS-add use.
- **Lazy encoded & raw numeric fast paths**: avoids JS-object materialization for simple property accessors (both string paths and extracted `d => d.field` / `function(d) { return d.field }` forms), with zero-copy `Float64Array` sharing on single-batch numeric columns.
- **Copy-on-Write unfiltered cache & complement subtraction**: restores unfiltered totals in `O(slots)` on clear and subtracts excluded rows when `> 50%` active (guarded by `hasExtreme` for `|v| > 1e12` and exact empty-slot zeroing).
- **Multi-group co-scan & Falcon brush coordination**: `_flushGroups(groups, kpiGroup)` routes brushing frames through `src/falcon-brush.js` and batches remaining dirty groups by metric plan through `src/columnar-reduce.js`.

**Key internal modules:**
- `src/filter-bitsets.js` — Columnar 1-bit per-dimension `Uint32Array` bitset store (`createFilterBitsetStore`): unlimited dimensions (no 32-dim cap), `O(1)` deactivate, 32-unrolled word packing, word-level XOR delta extraction with bailout, `Math.clz32` sparse active/excluded row extraction, SWAR `popcount32`, and deferred bitset materialization hooks for Falcon brushing.
- `src/columnar-reduce.js` — Interleaved cache-line AoS `Float64Array` metric buffers, compiled metric plans, fused single-group (`ao1..ao6`, `sd1..sd6`) and multi-group co-scan leaf kernels (`coAll0..6`, `coIdx0..6Add/Sub`, up to 5 groups + KPI in one pass), `canPlanUseComplement` (`|v| <= 1e12`), and exact empty-slot cleanup (`cleanupComplementEmptySlots`, `slotHasAnyActivity`).
- `src/falcon-brush.js` — Active-dimension precomputed 1D prefix-sum brush cache (`createFalconBrushCache`): activates on the 2nd consecutive `filterRange`/`filterExact` on the same dimension with fixed other filters; discrete exact `O(slots)` prefix subtraction (`U <= 2048`) and continuous 256-bin quantile prefix cubes + CSR boundary bins (`U > 2048`).
- `src/dashboard.js` — Declarative `createDashboardRuntime()` (KPIs, groups, time buckets, dense/sparse split fields, `query()`, `snapshot()`, `groups()`, `rows()`, `bounds()`, `isolatedFilters`, `appendColumns()`, `removeFiltered()`).
- `src/dashboard-stream-worker.js`, `src/dashboard-worker.js` — Web Worker streaming Arrow IPC runtime (`createStreamingDashboardWorker()`, `createDashboardWorker()`) with batch coalescing, lookup joins, progressive snapshots, and Transferable zero-copy typed arrays.
- `src/columnar.js` — Columnar/Arrow ingest path: `rowsFromColumns()` and `rowsFromArrowTable()` create Proxy-backed lazy row arrays with a hidden `COLUMNAR_BATCH_KEY` symbol for deferred materialization.
- `src/wasm.js` — Optional inline WebAssembly accelerated filter scan (`findEncodedMatches`), with JS fallback.
- `src/bisect.js`, `src/heap.js`, `src/heapselect.js` — Sorted index operations and top-K selection.

**Static helpers exposed on `crossfilter`:** `crossfilter.heap`, `crossfilter.bisect`, `crossfilter.permute`, `crossfilter.fromColumns()`, `crossfilter.fromArrowTable()`, `crossfilter.rowsFromColumns()`, `crossfilter.rowsFromArrowTable()`, `crossfilter.createDashboardRuntime()`, `crossfilter.createDashboardWorker()`, `crossfilter.createStreamingDashboardWorker()`, `crossfilter.configureRuntime()`, `crossfilter.runtimeInfo()`.

**Build:** Rollup bundles `index.js` into UMD (`crossfilter.js`), CommonJS (`crossfilter.cjs`), and minified UMD (`crossfilter.min.js`). The project is `"type": "module"` in `package.json`.

**Tests:** Vitest (`test/*.test.js`, including exhaustive optimization & randomized differential fuzz suites in `test/optimizations.test.js`). ESLint config is inline in `package.json` (`eslint:recommended`).

## Conventions

- ES module syntax (`import`/`export`) in source, but `var` declarations and ES5-style code throughout `src/` (no classes, no arrow functions, no `let`/`const`, no BigInt literals — enforced by `eslint src/`).
- No external runtime dependencies other than `@ranfdev/deepobj`.
- Active filter masks are stored as columnar 1-bit `Uint32Array` bitsets per active dimension in `src/filter-bitsets.js` — there is no 32-dimension limit.
