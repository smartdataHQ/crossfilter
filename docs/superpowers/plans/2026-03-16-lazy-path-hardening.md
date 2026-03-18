# Lazy Encoded Path Hardening

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix correctness bugs, close semantic gaps, and reduce per-append allocation overhead in the lazy WASM-encoded dimension path.

**Architecture:** All changes are in `src/index.js` within the `crossfilter()` factory closure, plus new regression tests. No new files. Stays within the ES5/`var` style convention.

**Tech Stack:** Vitest for tests, ESLint for lint, `npm run build` for UMD bundle.

**Commands:**
- Run single test file: `npx vitest run test/crossfilter.test.js`
- Run all tests: `npx vitest run`
- Lint: `npx eslint src/`
- Build: `npm run build`

**References:**
- `docs/superpowers/plans/2026-03-16-crossfilter-performance-roadmap.md` — Phase 0 (semantic safety), Phase 1 workstreams 1.1–1.3
- `docs/superpowers/plans/2026-03-16-crossfilter-benchmark-and-rollout-plan.md` — Section 2 (semantic regression matrix), Stages 1–2

---

## Context: what the previous PR shipped and what it missed

The previous commit (`2d90a23`) introduced:
- Auto-extraction of accessor paths from function accessors (`tryExtractAccessorPath`)
- Capacity-growth codes array with incremental `codeCounts` on append
- Incremental lazy group updates on append (no materialization when no new group keys)
- Lazy `filterRange` for orderable encoded values
- Lazy `dimension.groupAll()` avoids materialization
- Bug fixes for pending lazy filter on first add and onChange delivery

This plan addresses the gaps that remain.

---

## Task 1: Fix `codeCounts` not rebuilt after `compactLazyEncodedState`

**Severity: correctness bug.**

When `data.remove()` is called, `compactLazyEncodedState` (src/index.js:1102) rebuilds the `codes` array but does not rebuild `codeCounts`. After removal, `codeCounts` reflects pre-removal counts. This causes `lazyCodesSelectAllRows` (which sums `codeCounts`) to return wrong answers, and any subsequent filter or append that reads `codeCounts` to produce incorrect results.

Reference: roadmap Phase 1, Workstream 1.2 — "remove and compaction paths keep counts consistent."

**Files:**
- Modify: `src/index.js` — `compactLazyEncodedState` function (line ~1102)
- Test: `test/crossfilter.test.js`

- [ ] **1a: Write regression test for codeCounts after remove**

Add to `test/crossfilter.test.js` in the `describe("add")` block, near the other lazy tests:

```js
it("lazy codeCounts stay correct after data.remove()", function () {
  var cf = crossfilter();
  var dim = cf.dimension(function (d) { return d.type; });
  var other = cf.dimension(function (d) { return d.val; });
  cf.add([
    { type: "a", val: 1 },
    { type: "b", val: 2 },
    { type: "a", val: 3 },
    { type: "c", val: 4 },
  ]);

  // Filter to keep only val >= 3, then remove the rest
  other.filterRange([3, Infinity]);
  cf.remove();
  other.filterAll();

  // After remove, only {type:"a",val:3} and {type:"c",val:4} remain
  assert.equal(cf.size(), 2);

  // filterExact should work correctly (uses codeCounts via lazyCodesSelectAllRows)
  dim.filterExact("a");
  assert.deepStrictEqual(cf.allFiltered(), [{ type: "a", val: 3 }]);
  dim.filterAll();

  // filterIn should work correctly
  dim.filterIn(["a", "c"]);
  assert.equal(cf.allFiltered().length, 2);
  dim.filterAll();

  // Append after remove should work
  cf.add([{ type: "b", val: 5 }]);
  assert.equal(cf.size(), 3);
  dim.filterExact("b");
  assert.deepStrictEqual(cf.allFiltered(), [{ type: "b", val: 5 }]);
  dim.filterAll();
});
```

- [ ] **1b: Run test to verify it fails**

Run: `npx vitest run test/crossfilter.test.js -t "lazy codeCounts stay correct after data.remove"`

Expected: FAIL — codeCounts are stale after remove, causing incorrect filter results.

- [ ] **1c: Rebuild `codeCounts` in `compactLazyEncodedState`**

In `compactLazyEncodedState`, after the line that sets `lazyEncodedState.codesLength = nextLength`, add:

```js
      lazyEncodedState.codeCounts = buildCodeCounts(
        nextCodes.subarray(0, nextLength),
        lazyEncodedState.codeToValue.length
      );
```

Note: this is an O(n) rescan, but `data.remove()` is already O(n). A more efficient approach would decrement counts for removed rows during the compaction loop, but `buildCodeCounts` is simple and correct. If profiling later shows this matters, the decrement approach can replace it. The roadmap allows this: "remove and compaction paths keep counts consistent."

- [ ] **1d: Run all tests**

Run: `npx vitest run`
Expected: all tests pass including the new one.

- [ ] **1e: Commit**

```
fix: rebuild codeCounts after compactLazyEncodedState
```

---

## Task 2: Use `compareNaturalOrder` in lazy `filterRange`

**Severity: correctness risk.**

The lazy `filterRange` at src/index.js:1889 uses raw JS `>=`/`<` to check if encoded values fall within the range. The same raw comparison is used in `resolveLazyTargetCodes` at line 1031. For homogeneous-type dimensions (all numbers or all strings), this matches `compareNaturalOrder` behavior. For dimensions mixing numbers with non-coercible strings, raw JS comparison diverges because JS `<`/`>` produce NaN (false) while `compareNaturalOrder` falls through to `typeRank` (numbers < strings).

Note: `compareNaturalOrder` (src/natural-order.js:72-77) tries JS `<`/`>` first. For coercible strings like `"3"` vs numbers, JS coerces to number and gets a definitive answer — no divergence there. The divergence only occurs with non-coercible strings (like `"a"`) vs numbers, where JS gives NaN for both `<` and `>`, causing `compareNaturalOrder` to fall through to `typeRank`.

Example: `"a" >= 0` is `false` in JS (NaN comparison), but `compareNaturalOrder("a", 0)` is positive (string rank 4 > number rank 2). In the materialized bisect path, `"a"` sorts after all numbers, so `filterRange([0, "z"))` correctly includes `"a"`. The lazy raw comparison excludes it.

Reference: roadmap Phase 0 — "use `compareNaturalOrder` semantics when scanning `codeToValue`"; benchmark plan Section 2.1 — "filterRange on mixed numeric/string data."

**Files:**
- Modify: `src/index.js` — `filterRange` function (line ~1880) and `resolveLazyTargetCodes` (line ~1021)
- Test: `test/crossfilter.test.js`

- [ ] **2a: Write regression test for mixed-type filterRange with non-coercible strings**

```js
it("lazy filterRange matches materialized behavior on non-coercible mixed types", function () {
  // Force materialized path for comparison
  var cfMat = crossfilter();
  var dimMat = cfMat.dimension(function (d) { return d.val; });
  cfMat.add([
    { val: 0 },
    { val: "a" },
    { val: "m" },
    { val: "zz" },
  ]);
  dimMat.filterFunction(function () { return true; });
  dimMat.filterAll();
  dimMat.filterRange([0, "z"]);
  var matFiltered = cfMat.allFiltered();

  // Lazy path
  var cfLazy = crossfilter();
  var dimLazy = cfLazy.dimension(function (d) { return d.val; });
  cfLazy.add([
    { val: 0 },
    { val: "a" },
    { val: "m" },
    { val: "zz" },
  ]);
  dimLazy.filterRange([0, "z"]);
  var lazyFiltered = cfLazy.allFiltered();

  // compareNaturalOrder type rank: number(2) < string(4)
  // So in natural order: 0 < "a" < "m" < "z" < "zz"
  // Range [0, "z") includes: 0, "a", "m" — NOT "zz"
  // With raw JS >=/<, "a" >= 0 is false (NaN), so "a" is wrongly excluded
  assert.deepStrictEqual(lazyFiltered, matFiltered);
  dimLazy.filterAll();
  dimMat.filterAll();
});
```

- [ ] **2b: Run test to verify it fails with current code**

Run: `npx vitest run test/crossfilter.test.js -t "lazy filterRange matches materialized behavior on non-coercible mixed types"`

Expected: FAIL — raw JS `"a" >= 0` is false (NaN), so `"a"` and `"m"` are incorrectly excluded from the lazy path.

- [ ] **2c: Replace raw comparison with `compareNaturalOrder` in `filterRange`**

In `filterRange` (line ~1889), replace:
```js
          if (rangeValue >= range[0] && rangeValue < range[1]) {
```
with:
```js
          if (compareNaturalOrder(rangeValue, range[0]) >= 0 && compareNaturalOrder(rangeValue, range[1]) < 0) {
```

- [ ] **2d: Replace raw comparison in `resolveLazyTargetCodes`**

In `resolveLazyTargetCodes` (line ~1031), replace:
```js
          if (v >= range[0] && v < range[1]) {
```
with:
```js
          if (compareNaturalOrder(v, range[0]) >= 0 && compareNaturalOrder(v, range[1]) < 0) {
```

- [ ] **2e: Run all tests**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **2f: Commit**

```
fix: use compareNaturalOrder in lazy filterRange for mixed-type safety
```

---

## Task 3: Add Phase 0 semantic regression tests

**Severity: safety infrastructure.**

The roadmap Phase 0 and benchmark plan Section 2 require regression tests that compare accelerated and materialized behavior. These tests should catch any future divergence.

Reference: roadmap Phase 0 — all items; benchmark plan Section 2.1 through 2.5.

**Files:**
- Test: `test/crossfilter.test.js`

- [ ] **3a: Add mixed-type dimension filter tests**

Add a new `describe("lazy path semantic parity")` block inside the main `describe("crossfilter")`:

```js
describe("lazy path semantic parity", () => {
  // Helper: run the same operations on two crossfilters — one forced-materialized,
  // one lazy — and compare results.
  function comparePaths(records, dimAccessor, operations) {
    // Lazy path
    var cfLazy = crossfilter();
    var dimLazy = cfLazy.dimension(dimAccessor);
    cfLazy.add(records);

    // Force materialization by using filterFunction (which always materializes)
    var cfMat = crossfilter();
    var dimMat = cfMat.dimension(dimAccessor);
    cfMat.add(records);
    dimMat.filterFunction(function () { return true; });
    dimMat.filterAll();

    operations(dimLazy, cfLazy, dimMat, cfMat);
  }

  it("filterExact matches on homogeneous strings", function () {
    comparePaths(
      [{ v: "a" }, { v: "b" }, { v: "c" }, { v: "a" }],
      function (d) { return d.v; },
      function (lazy, cfL, mat, cfM) {
        lazy.filterExact("a");
        mat.filterExact("a");
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
        lazy.filterExact("z");
        mat.filterExact("z");
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
      }
    );
  });

  it("filterExact(null) intentionally diverges from legacy bisect path", function () {
    // The lazy path uses SameValueZero (Map lookup) where null !== 0.
    // The materialized bisect path uses compareNaturalOrder where null and 0
    // are equivalent via natural coercion. This is an intentional tightening:
    // null means null in the lazy path.
    var cf = crossfilter();
    var dim = cf.dimension(function (d) { return d.v; });
    cf.add([{ v: null }, { v: 0 }, { v: "" }, { v: false }, { v: null }]);
    dim.filterExact(null);
    var filtered = cf.allFiltered();
    // Lazy path: only null records, not 0/false/""
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(function (d) { return d.v === null; }));
    dim.filterAll();
  });

  it("filterIn matches on mixed present/absent values", function () {
    comparePaths(
      [{ v: "a" }, { v: "b" }, { v: "c" }],
      function (d) { return d.v; },
      function (lazy, cfL, mat, cfM) {
        lazy.filterIn(["a", "c", "z"]);
        mat.filterIn(["a", "c", "z"]);
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
      }
    );
  });

  it("filterRange matches on homogeneous numbers", function () {
    comparePaths(
      [{ v: 1 }, { v: 5 }, { v: 10 }, { v: 15 }, { v: 20 }],
      function (d) { return d.v; },
      function (lazy, cfL, mat, cfM) {
        lazy.filterRange([5, 15]);
        mat.filterRange([5, 15]);
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
        lazy.filterRange([0, 100]);
        mat.filterRange([0, 100]);
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
        lazy.filterRange([50, 60]);
        mat.filterRange([50, 60]);
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
      }
    );
  });

  it("filterRange matches on mixed number/non-coercible-string data", function () {
    // Non-coercible strings ("a", "m", "zz") vs numbers — this is where
    // raw JS comparison diverges from compareNaturalOrder (NaN vs typeRank).
    comparePaths(
      [{ v: 0 }, { v: 5 }, { v: "a" }, { v: "m" }, { v: "zz" }],
      function (d) { return d.v; },
      function (lazy, cfL, mat, cfM) {
        lazy.filterRange([0, "z"]);
        mat.filterRange([0, "z"]);
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
      }
    );
  });

  it("filterRange matches on mixed boolean/number/non-coercible-string data", function () {
    comparePaths(
      [{ v: true }, { v: 1 }, { v: "abc" }, { v: false }, { v: 0 }],
      function (d) { return d.v; },
      function (lazy, cfL, mat, cfM) {
        lazy.filterRange([0, "b"]);
        mat.filterRange([0, "b"]);
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
      }
    );
  });

  it("group().all() matches after filterExact", function () {
    comparePaths(
      [{ v: "a", n: 1 }, { v: "b", n: 2 }, { v: "a", n: 3 }],
      function (d) { return d.v; },
      function (lazy, cfL, mat, cfM) {
        var gL = lazy.group().reduceSum(function (d) { return d.n; });
        var gM = mat.group().reduceSum(function (d) { return d.n; });
        assert.deepStrictEqual(gL.all(), gM.all());
        lazy.filterExact("a");
        mat.filterExact("a");
        // Groups show all keys (own filter doesn't affect own groups)
        assert.deepStrictEqual(gL.all(), gM.all());
      }
    );
  });

  it("groupAll().value() matches", function () {
    comparePaths(
      [{ v: "a", n: 10 }, { v: "b", n: 20 }, { v: "a", n: 30 }],
      function (d) { return d.v; },
      function (lazy, cfL, mat, cfM) {
        var gaL = lazy.groupAll().reduceSum(function (d) { return d.n; });
        var gaM = mat.groupAll().reduceSum(function (d) { return d.n; });
        assert.equal(gaL.value(), gaM.value());
      }
    );
  });

  it("append after filter matches", function () {
    comparePaths(
      [{ v: "a" }, { v: "b" }],
      function (d) { return d.v; },
      function (lazy, cfL, mat, cfM) {
        lazy.filterExact("a");
        mat.filterExact("a");
        cfL.add([{ v: "a" }, { v: "c" }]);
        cfM.add([{ v: "a" }, { v: "c" }]);
        assert.deepStrictEqual(cfL.allFiltered(), cfM.allFiltered());
      }
    );
  });
});
```

- [ ] **3b: Run tests**

Run: `npx vitest run`
Expected: all pass (Task 2 must be done first for the mixed-type filterRange tests).

- [ ] **3c: Commit**

```
test: add Phase 0 lazy/materialized semantic parity tests
```

---

## Task 4: Incremental groupAll append without full rebuild

**Severity: performance — medium.**

`dimension.groupAll()` creates a singleton group with `key === cr_null`. The lazy path at line 2335-2339 creates the group correctly but sets `lazyCodeToGroup = null` (line 2339). The incremental fast path at line 2282 requires `lazyCodeToGroup` to be truthy, so every subsequent append falls through to the full lazy rebuild — re-scanning all codes and re-sorting — even though groupAll has exactly one group and never needs `codeToGroup`.

Reference: roadmap Phase 1, Workstream 1.1 — "Extend the lazy append plan to groupAll."

**Files:**
- Modify: `src/index.js` — group `add` function incremental path (line ~2282)
- Test: `test/crossfilter.test.js`

- [ ] **4a: Write test for groupAll incremental append efficiency**

```js
it("lazy groupAll handles incremental append without full rebuild", function () {
  var cf = crossfilter();
  var dim = cf.dimension(function (d) { return d.type; });
  cf.add([{ type: "a", amount: 10 }]);
  var ga = dim.groupAll().reduceSum(function (d) { return d.amount; });
  assert.equal(ga.value(), 10);

  // Append several batches — groupAll should not need lazyCodeToGroup
  cf.add([{ type: "b", amount: 20 }]);
  assert.equal(ga.value(), 30);
  cf.add([{ type: "c", amount: 30 }]);
  assert.equal(ga.value(), 60);

  // Filter and append
  dim.filterExact("a");
  cf.add([{ type: "a", amount: 5 }]);
  assert.equal(ga.value(), 65); // groupAll ignores own filter
  dim.filterAll();
});
```

- [ ] **4b: Modify incremental path to handle groupAll (k === 1, groupIndex === null)**

In the incremental fast path at line ~2282, change the condition to also handle the groupAll case:

```js
        // Incremental lazy append: groups already exist, dimension is still encoded
        if (appendedCodes && lazyEncodedState && !values && k > 0) {
          // groupAll (k=1, no groupIndex): just mark reset needed
          if (groupAll) {
            resetNeeded = true;
            return;
          }

          if (lazyCodeToGroup) {
            var hasNewGroups = false,
                incrCode,
                incrI;
            // ... existing new-group check ...
```

This means groupAll skips both the `lazyCodeToGroup` check and the `sortedCodes` rebuild. It just marks `resetNeeded = true`, which is correct since `resetOne` will rescan all records on next `value()`.

- [ ] **4c: Run all tests**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **4d: Commit**

```
perf: lazy groupAll incremental append skips full rebuild
```

---

## Task 5: Reduce per-append allocation in `applyLazyFilterToNewRows` (narrowed)

**Severity: performance — medium.**

Every call to `applyLazyFilterToNewRows` (src/index.js:1060) allocates:
- `new Uint8Array(n)` for `nextSelected` — O(n) allocation + O(n) copy from `currentSelected`
- `new Uint32Array(matches.length)` for `nextMatches`
- A fresh concat via `concatLazyMatchIndices` — another O(currentMatches + newMatches) allocation

For streaming workloads appending thousands of batches, this is O(n) allocation per batch, growing with the dataset.

Reference: roadmap Phase 1, Workstream 1.2 — "Reuse scratch buffers where possible in lazy selection updates" targeting `applyLazyFilterToNewRows`.

**Scope narrowing (from 3rd-party review):** The original plan proposed capacity-growth on `selected` and `matchIndices` (oversized buffers with separate length). This is unsafe:
- `normalizeLazySelectionMask` (src/index.js:813) iterates `selection.length` to detect "all selected" → collapse to `null`. An oversized buffer with zero-filled spare capacity would always find a 0, preventing the collapse. This is a correctness break.
- `normalizeLazyMatchIndices` (src/index.js:827) uses `matches.length === n` to detect "all matched". Same issue with oversized buffers.

The narrowed approach: check-before-allocate reuse only. Do NOT change the persistent state shape.

**Files:**
- Modify: `src/index.js` — `applyLazyFilterToNewRows` function (line ~1060)

- [ ] **5a: Reuse `selected` array when it is already large enough**

In `applyLazyFilterToNewRows`, replace:
```js
      currentSelected = ensureLazySelection(currentMatches, lazyEncodedState.selected);
      nextSelected = new Uint8Array(n);
      nextSelected.set(currentSelected);
```
with:
```js
      currentSelected = ensureLazySelection(currentMatches, lazyEncodedState.selected);
      if (currentSelected.length >= n) {
        // Buffer is already large enough — reuse it directly.
        // New row slots (n0..n-1) are already 0 from prior allocation.
        nextSelected = currentSelected;
      } else {
        // Must grow — allocate exact size to preserve normalizeLazySelectionMask semantics.
        nextSelected = new Uint8Array(n);
        nextSelected.set(currentSelected);
      }
```

Note: we allocate exact-size (not 2x) because `normalizeLazySelectionMask` uses `.length` to detect the "all selected" case. New row slots in the grown region are 0 (unselected) because `Uint8Array` zero-initializes.

- [ ] **5b: Run all tests**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **5c: Commit**

```
perf: reuse selected buffer in applyLazyFilterToNewRows when large enough
```

**Deferred:** Capacity-growth on `matchIndices` and `selected` requires changing the persistent state contract and auditing all read sites (`normalizeLazySelectionMask`, `normalizeLazyMatchIndices`, `applyLazySelectionState`, `compactLazyEncodedState`, `preAdd`). This is a separate, higher-risk task that should have its own plan.

---

## Task 6: Cache `resolveLazyTargetCodes` for filterRange across appends

**Severity: performance — low.**

When `lazyFilterTargetCodes` is set (filterRange is active), `resolveLazyTargetCodes` currently rescans `codeToValue` on every call (line ~1022). For append-heavy streaming, this is O(cardinality) per append even when no new codes were added.

**Files:**
- Modify: `src/index.js` — `resolveLazyTargetCodes` (line ~1016)

- [ ] **6a: Track `codeToValue` length to skip redundant rescans**

Add a `lazyFilterTargetCodesVersion` variable alongside `lazyFilterTargetCodes`. Set it to `codeToValue.length` when target codes are computed. Only recompute when `codeToValue.length` has grown:

```js
    function resolveLazyTargetCodes() {
      if (!lazyEncodedState || !filterValuePresent || filterMode === 'all') {
        return new Uint32Array(0);
      }

      if (lazyFilterTargetCodes) {
        var currentCodeCount = lazyEncodedState.codeToValue.length;
        if (currentCodeCount === lazyFilterTargetCodesVersion) {
          return lazyFilterTargetCodes;
        }
        // New codes appeared — rescan
        var codeToValue = lazyEncodedState.codeToValue,
            rangeCodes = [],
            code,
            v,
            range = filterValue;

        for (code = 1; code < codeToValue.length; ++code) {
          v = codeToValue[code];
          if (compareNaturalOrder(v, range[0]) >= 0 && compareNaturalOrder(v, range[1]) < 0) {
            rangeCodes.push(code);
          }
        }
        lazyFilterTargetCodes = new Uint32Array(rangeCodes);
        lazyFilterTargetCodesVersion = currentCodeCount;
        return lazyFilterTargetCodes;
      }

      if (filterMode === 'in') {
        return encodeLazyFilterValues(filterInValues || []);
      }

      return encodeLazyFilterValues([filterValue]);
    }
```

Set `lazyFilterTargetCodesVersion` in `filterRange` when computing the initial target codes. Clear both `lazyFilterTargetCodes` and `lazyFilterTargetCodesVersion` in `filterExact`, `filterIn`, `filterAll`, `filterFunction`.

- [ ] **6b: Run all tests**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **6c: Commit**

```
perf: cache filterRange target codes across appends when cardinality is stable
```

---

## Task 7: Add semantic safety comment block

**Severity: documentation.**

Reference: roadmap Phase 0 — "Add a semantic safety checklist comment block near the lazy path entry points."

**Files:**
- Modify: `src/index.js`

- [ ] **7a: Add comment block before `createLazyEncodedState`**

```js
    // ==========================================================================
    // Lazy encoded dimension path — semantic safety contract
    //
    // The lazy path stores dimension values as integer codes and defers
    // materialization of sorted values/index. All optimizations in this path
    // must preserve these invariants:
    //
    // 1. ORDERING: filterRange must use compareNaturalOrder, not raw JS < / >=,
    //    because mixed-type dimensions have type-rank ordering that differs
    //    from JS coercion. The gate is hasLazyEncodedGroupingSupport().
    //
    // 2. EQUALITY: filterExact and filterIn use Map-based code lookup, which
    //    uses SameValueZero. This differs from compareNaturalOrder for null/0
    //    (they are distinct in SameValueZero but equivalent in natural order).
    //    This is an intentional semantic tightening: null means null.
    //
    // 3. FILTER LIFECYCLE: reduce functions receive a third argument (noPrior)
    //    that distinguishes "new data" from "filter toggle." The lazy path
    //    must preserve this via resetNeeded + resetMany/resetOne, not by
    //    skipping reduce calls.
    //
    // 4. NOTIFICATION: filter changes must fire onChange('filtered') even when
    //    no filterListeners (groups) exist. Check callbacks.length too.
    //
    // 5. COUNTS: codeCounts must stay consistent through append, remove, and
    //    compaction. lazyCodesSelectAllRows depends on accurate counts.
    //
    // When in doubt, materialize. The materialized path is always correct.
    // ==========================================================================
```

- [ ] **7b: Commit**

```
docs: add semantic safety contract comment for lazy encoded path
```

---

## Task 8: Final verification and build

- [ ] **8a: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass.

- [ ] **8b: Run lint**

Run: `npx eslint src/`
Expected: clean.

- [ ] **8c: Build distributables**

Run: `npm run build`
Expected: `crossfilter.js` and `crossfilter.min.js` updated.

- [ ] **8d: Commit build artifacts**

```
build: rebuild after lazy path hardening
```

---

## Delivery order

1. Task 1 (codeCounts bug) — **must ship first**, it's a correctness bug
2. Task 2 (filterRange comparison) — **must ship second**, it's a correctness risk
3. Task 3 (semantic parity tests) — validates Tasks 1 and 2, documents intentional divergences
4. Task 7 (safety comments) — documentation, low risk
5. Task 4 (groupAll fast path) — performance, safe
6. Task 6 (filterRange cache) — performance, safe
7. Task 5 (selected buffer reuse) — performance, narrowed to safe check-before-allocate

This order matches the roadmap's recommended delivery order: semantic fixes first, then safe optimizations.

---

## What this plan intentionally defers

The following items from the roadmap are not addressed here. They are either lower priority, require benchmarking infrastructure that doesn't exist yet, or involve larger architectural changes:

- **Incremental reduce on append** (avoiding `resetNeeded = true` entirely): the incremental group path currently marks `resetNeeded` which forces O(n) reset on next read. True incremental reduce for just new rows would be O(batchSize) but requires careful handling of the reduce lifecycle `noPrior` flag across all reduce modes (count, sum, metricSpec, custom). Deferred to a future PR with benchmark validation.

- **Capacity-growth on `selected` and `matchIndices`**: changing these from exact-length-or-null to oversized buffers requires auditing `normalizeLazySelectionMask` (uses `.length` for "all selected" collapse) and `normalizeLazyMatchIndices` (uses `.length === n` for "all matched"). This is a higher-risk contract change that should have its own plan with dedicated tests.

- **Scratch buffer reuse in `encodeLazyFilterValues` and `applyLazySelectionState`**: these allocate fresh typed arrays per filter call. Worth doing but the win is proportional to filter frequency, not dataset size. Deferred.

- **Phase 2+ items** (Arrow row-materialization reduction, bounded row cache, generic worker runtime, memory tuning): these are separate workstreams per the roadmap.
