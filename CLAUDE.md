# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Crossfilter3 is a JavaScript library for fast multidimensional filtering of large datasets, commonly used with coordinated visualization views (e.g., dc.js). It uses sorted indexes and bitwise filter arrays for incremental filtering/reducing. Published as `crossfilter3` on npm.

## Commands

- **Test:** `npm test` (runs vitest then eslint on src/)
- **Build:** `npm run build` (rollup → `crossfilter.js` + `crossfilter.min.js`)
- **Benchmark:** `npm run benchmark` or `npm run benchmark:arrow`
- **Single test file:** `npx vitest run test/crossfilter.test.js`
- **Lint only:** `npx eslint src/`

## Architecture

**Entry points:**
- `index.js` — UMD build entry (adds `version` from package.json)
- `main.js` — ESM entry (re-exports `src/index.js`)

**Core (`src/index.js`):** Single ~3300-line file containing the `crossfilter()` factory and the `dimension()` / `group()` / `groupAll()` inner functions. All filtering state (bitmask filters, sorted indexes, data array) is closure-scoped inside the factory. This is the heart of the library. Includes a lazy WASM-encoded path that avoids materialization for simple property accessors (both string and function forms like `d => d.field`).

**Key internal modules:**
- `src/filter.js` — Typed-array filter bitmask (Uint8/16/32 based on dimension count)
- `src/bisect.js`, `src/heap.js`, `src/heapselect.js` — Sorted index operations and top-K selection
- `src/columnar.js` — Columnar/Arrow ingest path: `rowsFromColumns()` and `rowsFromArrowTable()` create Proxy-backed lazy row arrays with a hidden `COLUMNAR_BATCH_KEY` symbol for deferred materialization
- `src/wasm.js` — Optional WebAssembly accelerated filter scan (`findEncodedMatches`), with JS fallback. Builds a tiny WASM module inline (no external .wasm file)

**Static helpers exposed on `crossfilter`:** `crossfilter.heap`, `crossfilter.bisect`, `crossfilter.permute`, `crossfilter.fromColumns()`, `crossfilter.fromArrowTable()`, `crossfilter.configureRuntime()`.

**Build:** Rollup bundles `index.js` into UMD (`crossfilter.js`) and minified (`crossfilter.min.js`). The project is `"type": "module"` in package.json.

**Tests:** Vitest, files in `test/*.test.js`. ESLint config is inline in package.json (eslint:recommended).

## Conventions

- ES module syntax (`import`/`export`) in source, but `var` declarations and ES5-style code throughout (no classes, no arrow functions, no `let`/`const` in src/).
- No external runtime dependencies other than `@ranfdev/deepobj`.
- The filter system uses a compact bitmask per record — dimension count determines the typed array width (8/16/32-bit). Adding dimensions beyond 32 is unsupported.
