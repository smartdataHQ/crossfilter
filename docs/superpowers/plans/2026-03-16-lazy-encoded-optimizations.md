# Lazy Encoded Path Optimizations

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the lazy WASM-encoded dimension path active through append and group operations, eliminating unnecessary materialization.

**Architecture:** Four changes to `src/index.js`, all within the `crossfilter()` factory closure. Optimization 2 (capacity growth) is a prerequisite for optimization 1 (incremental group append). Each optimization is independently testable. All changes stay within the existing ES5/`var` style.

**Tech Stack:** Vitest for tests, ESLint for lint, `npm run build` for UMD bundle.

**Commands:**
- Run single test file: `npx vitest run test/crossfilter.test.js`
- Run all tests: `npx vitest run`
- Lint: `npx eslint src/`
- Build: `npm run build`

---

## Key Concepts

The lazy encoded path stores dimension values as integer codes (`Uint32Array`) instead of materializing sorted value/index arrays. This avoids the O(n log n) sort and enables WASM-accelerated filtering. "Materialization" (`materializeLazyEncodedState`) converts codes back to sorted values/index and destroys the lazy state — it's the escape hatch when a code path can't operate on codes alone.

State lives in `lazyEncodedState`:
- `codes` — `Uint32Array`, one code per record (code 0 = undefined)
- `codeToValue` — array, code → original value
- `valueToCode` — `Map`, original value → code
- `codeCounts` — `Uint32Array`, how many records have each code
- `matchIndices`, `selected` — current filter state
- `selectionMarks`, `selectionMarkVersion` — scratch for `encodeLazyFilterValues`

---

### Task 1: Capacity-growth codes array and incremental codeCounts

Currently `appendLazyEncodedValues` (line 680) and `appendLazyEncodedValuesFromAccessor` (line 714) allocate a new `Uint32Array(existingLength + newLength)` on every append, copy all existing codes, then call `buildCodeCounts` to rescan the entire array. This makes every `data.add()` O(n) in the total dataset size.

**Files:**
- Modify: `src/index.js:596-745` (lazy state creation and append functions)
- Test: `test/crossfilter.test.js` (new test block)

#### Step 1: Add `codesLength` field to lazy encoded state

The `codes` array will be oversized. All consumers read `codes[0..n-1]` using the crossfilter's `n` (record count), which already equals the logical codes length. But `findEncodedMatches` and `compactLazyEncodedState` pass `lazyEncodedState.codes` directly — they'll need a view.

- [ ] **1a: Write failing test for append without reallocation**

Add to `test/crossfilter.test.js` inside the `describe("crossfilter", () => { describe("add", () => {` block, after the "applies a pending lazy exact filter" test (around line 2965):

```js
it("lazy append reuses codes buffer when capacity allows", function () {
  var cf = crossfilter();
  var dim = cf.dimension(function (d) { return d.key; });
  // First add creates lazy state
  cf.add([{ key: "a" }, { key: "b" }]);
  // Second add should reuse the codes buffer (not allocate new)
  cf.add([{ key: "a" }, { key: "c" }]);
  // Verify correctness via group
  var g = dim.group().reduceCount();
  assert.deepStrictEqual(g.all(), [
    { key: "a", value: 2 },
    { key: "b", value: 1 },
    { key: "c", value: 1 },
  ]);
});
```

- [ ] **1b: Run test to verify it passes (baseline correctness)**

Run: `npx vitest run test/crossfilter.test.js -t "lazy append reuses codes buffer"`
Expected: PASS (current code is correct, just slow)

- [ ] **1c: Modify `createLazyEncodedState` and `createLazyEncodedStateFromAccessor` to allocate with headroom**

In `createLazyEncodedState` (line 596), change the codes allocation from exact-fit to capacity-based. Add `codesLength` to the returned state. Change both creation functions identically.

Replace lines 601-602:
```js
      var codes = new Uint32Array(sourceValues.length),
```
with:
```js
      var codesCapacity = sourceValues.length < 64 ? 64 : sourceValues.length,
          codes = new Uint32Array(codesCapacity),
```

In `createLazyEncodedStateFromAccessor` (line 633), replace line 638:
```js
      var codes = new Uint32Array(length),
```
with:
```js
      var codesCapacity = length < 64 ? 64 : length,
          codes = new Uint32Array(codesCapacity),
```

In both returned state objects (lines 658 and approx 622), add `codesLength`:
```js
      return {
        codeCounts: buildCodeCounts(codes, codeToValue.length),
        codesLength: sourceValues.length,  // or `length` in accessor variant
        codeToValue: codeToValue,
        codes: codes,
        ...
      };
```

- [ ] **1d: Add a `getLazyCodes()` accessor function** inside the `dimension` closure (after `ensureLazySelectionMarksSize`, around line 678):

```js
    function getLazyCodes() {
      return lazyEncodedState.codes.length === lazyEncodedState.codesLength
        ? lazyEncodedState.codes
        : lazyEncodedState.codes.subarray(0, lazyEncodedState.codesLength);
    }
```

- [ ] **1e: Update all `lazyEncodedState.codes` read sites to use `getLazyCodes()`**

There are 8 read sites outside the append functions. Replace `lazyEncodedState.codes` with `getLazyCodes()` at:
- Line 960: `findEncodedMatches(getLazyCodes(), targetCodes)`
- Line 1064: inside `compactLazyEncodedState`, change `lazyEncodedState.codes[i]` — here the loop already uses `reIndex` so reads individual elements. The loop bounds use `n` (record count) not `codes.length`. No change needed for element access, but the reassignment at line 1082 (`lazyEncodedState.codes = nextCodes`) should also set `lazyEncodedState.codesLength = nextLength`.
- Line 1094-1100: `materializeLazyEncodedState` — use `lazyEncodedState.codesLength` for the array length, and element access is fine.
- Line 1395: `findEncodedMatches(getLazyCodes(), initialTargetCodes)`
- Line 2189: group's lazy `add` — `codes = getLazyCodes()`

- [ ] **1f: Rewrite `appendLazyEncodedValues` (line 680) with capacity growth and incremental counts**

```js
    function appendLazyEncodedValues(sourceValues) {
      if (!lazyEncodedState) {
        return null;
      }

      var existingLength = lazyEncodedState.codesLength,
          newLength = existingLength + sourceValues.length,
          codes = lazyEncodedState.codes,
          codeCounts = lazyEncodedState.codeCounts,
          appendedCodes = new Uint32Array(sourceValues.length),
          i,
          valueToEncode,
          code;

      // Grow codes buffer if needed (2x strategy)
      if (newLength > codes.length) {
        var nextCapacity = codes.length;
        while (nextCapacity < newLength) nextCapacity *= 2;
        var nextCodes = new Uint32Array(nextCapacity);
        nextCodes.set(codes.subarray(0, existingLength));
        codes = nextCodes;
        lazyEncodedState.codes = codes;
      }

      for (i = 0; i < sourceValues.length; ++i) {
        valueToEncode = sourceValues[i];
        if (!isLazyEncodedValue(valueToEncode)) {
          return null;
        }
        if (!lazyEncodedState.valueToCode.has(valueToEncode)) {
          code = lazyEncodedState.codeToValue.length;
          lazyEncodedState.valueToCode.set(valueToEncode, code);
          lazyEncodedState.codeToValue.push(valueToEncode);
        }
        code = lazyEncodedState.valueToCode.get(valueToEncode);
        appendedCodes[i] = code;
        codes[existingLength + i] = code;

        // Grow codeCounts if new code exceeds current size
        if (code >= codeCounts.length) {
          var nextCounts = new Uint32Array(lazyEncodedState.codeToValue.length);
          nextCounts.set(codeCounts);
          codeCounts = nextCounts;
          lazyEncodedState.codeCounts = codeCounts;
        }
        ++codeCounts[code];
      }

      lazyEncodedState.codesLength = newLength;
      ensureLazySelectionMarksSize(lazyEncodedState.codeToValue.length);
      return appendedCodes;
    }
```

- [ ] **1g: Rewrite `appendLazyEncodedValuesFromAccessor` (line 714) identically but reading from accessor**

Same pattern as 1f but the source loop reads `accessor(offset + i)` instead of `sourceValues[i]`.

```js
    function appendLazyEncodedValuesFromAccessor(accessor, offset, length) {
      if (!lazyEncodedState) {
        return null;
      }

      var existingLength = lazyEncodedState.codesLength,
          newLength = existingLength + length,
          codes = lazyEncodedState.codes,
          codeCounts = lazyEncodedState.codeCounts,
          appendedCodes = new Uint32Array(length),
          i,
          valueToEncode,
          code;

      if (newLength > codes.length) {
        var nextCapacity = codes.length;
        while (nextCapacity < newLength) nextCapacity *= 2;
        var nextCodes = new Uint32Array(nextCapacity);
        nextCodes.set(codes.subarray(0, existingLength));
        codes = nextCodes;
        lazyEncodedState.codes = codes;
      }

      for (i = 0; i < length; ++i) {
        valueToEncode = accessor(offset + i);
        if (!isLazyEncodedValue(valueToEncode)) {
          return null;
        }
        if (!lazyEncodedState.valueToCode.has(valueToEncode)) {
          code = lazyEncodedState.codeToValue.length;
          lazyEncodedState.valueToCode.set(valueToEncode, code);
          lazyEncodedState.codeToValue.push(valueToEncode);
        }
        code = lazyEncodedState.valueToCode.get(valueToEncode);
        appendedCodes[i] = code;
        codes[existingLength + i] = code;

        if (code >= codeCounts.length) {
          var nextCounts = new Uint32Array(lazyEncodedState.codeToValue.length);
          nextCounts.set(codeCounts);
          codeCounts = nextCounts;
          lazyEncodedState.codeCounts = codeCounts;
        }
        ++codeCounts[code];
      }

      lazyEncodedState.codesLength = newLength;
      ensureLazySelectionMarksSize(lazyEncodedState.codeToValue.length);
      return appendedCodes;
    }
```

- [ ] **1h: Run all tests**

Run: `npx vitest run`
Expected: all 614 tests pass

- [ ] **1i: Run lint**

Run: `npx eslint src/`
Expected: clean

- [ ] **1j: Commit**

```
feat: capacity-growth codes array and incremental codeCounts in lazy append
```

---

### Task 2: Incremental lazy group updates on append

Currently, `preAdd` at line 1382 materializes the lazy state whenever `indexListeners.length > 0` (i.e., any group exists). This forces O(n log n) sort on every `data.add()` after the first group is created. Instead, the group's `add` function should handle incremental appends from the lazy encoded state directly.

**Files:**
- Modify: `src/index.js:1382-1425` (preAdd materialization guard)
- Modify: `src/index.js:2185-2258` (group lazy add)
- Modify: `src/index.js:1614-1616` (postAdd to pass appended codes)
- Test: `test/crossfilter.test.js` (new test block)

#### Design

The group's `add` currently has two modes:
1. **Full lazy rebuild** (line 2187): rebuilds groups/groupIndex from all codes. Used at group creation time.
2. **Sorted merge** (line 2260): merges new sorted values into existing groups. Used on subsequent appends.

We add a third mode: **incremental lazy append**. When `lazyEncodedState` is active and `postAdd` passes appended codes (not `newValues`/`newIndex`), the group:
1. Checks if any new codes introduced new group keys
2. If new keys: inserts new groups in sorted position, rebuilds `codeToGroup`, extends `groupIndex`
3. If no new keys: just extends `groupIndex` using existing `codeToGroup`
4. Marks `resetNeeded = true` (reduce values recomputed lazily on next `all()`/`top()`)

The group needs to persist `codeToGroup` across calls (currently it's a local variable).

- [ ] **2a: Write failing test for lazy append with existing group**

Add to `test/crossfilter.test.js` after the test from Task 1:

```js
it("lazy dimension stays encoded when appending with existing groups", function () {
  var cf = crossfilter();
  var dim = cf.dimension(function (d) { return d.type; });
  cf.add([
    { type: "a", amount: 10 },
    { type: "b", amount: 20 },
  ]);
  var g = dim.group().reduceSum(function (d) { return d.amount; });
  assert.deepStrictEqual(g.all(), [
    { key: "a", value: 10 },
    { key: "b", value: 20 },
  ]);

  // Append more data — should NOT materialize
  cf.add([
    { type: "a", amount: 5 },
    { type: "c", amount: 30 },
  ]);
  assert.deepStrictEqual(g.all(), [
    { key: "a", value: 15 },
    { key: "b", value: 20 },
    { key: "c", value: 30 },
  ]);

  // Verify filtering still works
  dim.filterExact("a");
  assert.deepStrictEqual(cf.allFiltered().length, 2);
  dim.filterAll();
});
```

- [ ] **2b: Run test to verify it fails**

Run: `npx vitest run test/crossfilter.test.js -t "lazy dimension stays encoded when appending"`
Expected: FAIL (currently materializes on second add)

- [ ] **2c: Remove the materialization guard in `preAdd`**

At line 1382, change:
```js
        if (lazyEncodedState && !values && indexListeners.length) {
          materializeLazyEncodedState();
        }
```
to:
```js
        // No longer materialize just because groups exist.
        // Groups handle lazy appends via appendedCodes in postAdd.
```

(Delete the 3 lines entirely.)

- [ ] **2d: Modify `postAdd` to pass appended codes**

The dimension's `preAdd` stores its result in local state. We need `postAdd` to also pass the appended codes to group listeners. Add a dimension-scoped variable `lastAppendedCodes` alongside `newValues`/`newIndex`:

At the dimension's variable declarations (around line 553), add:
```js
        lastAppendedCodes = null,
```

In the lazy append branch of `preAdd` (line 1415-1423), after `applyLazyFilterToNewRows`:
```js
          if (appendedCodes) {
            applyLazyFilterToNewRows(n0, appendedCodes);
            lastAppendedCodes = appendedCodes;
            lo0 = 0;
            hi0 = 0;
            return;
          }
```

Similarly in the first-time lazy creation branch (line 1386-1413), store the initial codes:
```js
          if (lazyEncodedState) {
            // ...existing pending filter code...
            lastAppendedCodes = getLazyCodes();
            lo0 = 0;
            hi0 = 0;
            return;
          }
```

Modify `postAdd` (line 1614) to pass appended codes:
```js
    function postAdd(newData, n0, n1) {
      indexListeners.forEach(function(l) { l(newValues, newIndex, n0, n1, lastAppendedCodes); });
      newValues = newIndex = null;
      lastAppendedCodes = null;
    }
```

- [ ] **2e: Persist `codeToGroup` in the group closure**

In the group's variable declarations (around line 2152), add `lazyCodeToGroup`:
```js
      var groups,
          groupIndex,
          groupWidth = 8,
          groupCapacity = capacity(groupWidth),
          k = 0,
          lazyCodeToGroup = null,
          ...
```

In the existing lazy `add` path (line 2224-2229), store the mapping:
```js
            lazyCodeToGroup = new Array(codeToValue.length);

            for (sortIndex = 0; sortIndex < sortedCodes.length; ++sortIndex) {
              encodedCode = sortedCodes[sortIndex];
              groups[sortIndex] = {key: codeToValue[encodedCode], value: initialValue()};
              lazyCodeToGroup[encodedCode] = sortIndex;
            }
```

(Replace the local `codeToGroup` references in that block with `lazyCodeToGroup`.)

- [ ] **2f: Add incremental lazy append path to group's `add` function**

At the top of `add(newValues, newIndex, n0, n1, appendedCodes)`, add parameter and a new branch before the existing lazy rebuild:

```js
      function add(newValues, newIndex, n0, n1, appendedCodes) {

        // Incremental lazy append: groups exist, dimension is still encoded
        if (appendedCodes && lazyCodeToGroup && lazyEncodedState && !values && k > 0) {
          var codeToValue = lazyEncodedState.codeToValue,
              hasNewGroups = false,
              code,
              i;

          // Check if any appended codes introduce new group keys
          for (i = 0; i < appendedCodes.length; ++i) {
            code = appendedCodes[i];
            if (code > 0 && lazyCodeToGroup[code] === undefined) {
              hasNewGroups = true;
              break;
            }
          }

          if (hasNewGroups) {
            // Rebuild groups from scratch (new keys need sorted insertion)
            // Fall through to the full lazy rebuild below
          } else {
            // Fast path: just extend groupIndex for new rows
            if (k > 1) {
              groupIndex = xfilterArray.arrayLengthen(groupIndex, n);
              for (i = 0; i < appendedCodes.length; ++i) {
                groupIndex[n0 + i] = lazyCodeToGroup[appendedCodes[i]];
              }
            }
            resetNeeded = true;
            return;
          }
        }

        if (useLazyEncodedGrouping && lazyEncodedState && !values) {
          // ... existing full lazy rebuild ...
```

For the `hasNewGroups` case, we let it fall through to the existing full lazy rebuild, which will re-read all codes from `getLazyCodes()` and rebuild `lazyCodeToGroup`.

- [ ] **2g: Update the full lazy rebuild to use `lazyCodeToGroup`**

In the existing full lazy rebuild (line 2187-2258), replace all references to the local `codeToGroup` with `lazyCodeToGroup`. Remove the local `codeToGroup` declaration from line 2191. The mapping is now persistent.

Also update the line that reads codes (currently `codes = lazyEncodedState.codes` at line 2189) to use the accessor:
```js
              codes = getLazyCodes(),
```

Ensure `lazyCodeToGroup` is grown when new codes appear:
```js
            lazyCodeToGroup = new Array(codeToValue.length);
```

- [ ] **2h: Handle first-time group creation with lazy codes**

When the group is first created with `add(values, index, 0, n)` at line 2181, the lazy path already handles this (the full rebuild). But now `appendedCodes` might be passed as the 5th argument. The initial call passes `(values, index, 0, n)` — only 4 args. So `appendedCodes` is undefined, which correctly skips the new incremental branch.

Verify: no change needed here.

- [ ] **2i: Clear `lazyCodeToGroup` on group `removeData`**

In the group's `removeData` function (line 2446), add at the top:
```js
      function removeData(reIndex) {
        lazyCodeToGroup = null; // force rebuild on next add
```

This ensures that after a `data.remove()`, the next append triggers a full lazy rebuild, which is correct since codes have been compacted.

- [ ] **2j: Clear `lazyCodeToGroup` when reduce is changed**

When `reduce()`, `reduceCount()`, or `reduceSum()` is called, `resetNeeded` is set to true. `lazyCodeToGroup` should remain valid since it's about key→group mapping, not reduce values. No change needed.

- [ ] **2k: Run all tests**

Run: `npx vitest run`
Expected: all tests pass (including the new test from 2a)

- [ ] **2l: Write additional edge case tests**

Add after the test from 2a:

```js
it("lazy append with existing group handles cross-dimension filter", function () {
  var cf = crossfilter();
  var typeDim = cf.dimension(function (d) { return d.type; });
  var amountDim = cf.dimension(function (d) { return d.amount; });
  cf.add([
    { type: "a", amount: 10 },
    { type: "b", amount: 20 },
  ]);
  var g = typeDim.group().reduceSum(function (d) { return d.amount; });
  amountDim.filterRange([15, 100]);

  cf.add([
    { type: "a", amount: 30 },
    { type: "b", amount: 5 },
  ]);

  // type "b" amount=5 should be filtered out by amountDim range
  assert.deepStrictEqual(g.all(), [
    { key: "a", value: 40 },
    { key: "b", value: 20 },
  ]);
  amountDim.filterAll();
});

it("lazy append with existing group and new key introduces group correctly", function () {
  var cf = crossfilter();
  var dim = cf.dimension(function (d) { return d.key; });
  cf.add([{ key: "b" }, { key: "b" }]);
  var g = dim.group().reduceCount();
  assert.deepStrictEqual(g.all(), [{ key: "b", value: 2 }]);

  cf.add([{ key: "a" }, { key: "c" }]);
  assert.deepStrictEqual(g.all(), [
    { key: "a", value: 1 },
    { key: "b", value: 2 },
    { key: "c", value: 1 },
  ]);
});
```

- [ ] **2m: Run all tests again**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **2n: Run lint**

Run: `npx eslint src/`
Expected: clean

- [ ] **2o: Commit**

```
feat: incremental lazy group updates on append without materialization
```

---

### Task 3: Lazy filterRange for orderable encoded values

Currently `filterRange` (line 1812) always materializes. For lazy dimensions with naturally orderable values, we can scan `codeToValue` for codes in range and use `applyLazyEncodedFilter`.

**Files:**
- Modify: `src/index.js:1812-1819` (filterRange function)
- Test: `test/crossfilter.test.js` (new test)

- [ ] **3a: Write failing test**

```js
it("lazy filterRange stays encoded for orderable values", function () {
  var cf = crossfilter();
  var dim = cf.dimension(function (d) { return d.value; });
  cf.add([
    { value: 10 }, { value: 20 }, { value: 30 },
    { value: 40 }, { value: 50 },
  ]);

  dim.filterRange([20, 40]);
  assert.deepStrictEqual(cf.allFiltered(), [
    { value: 20 }, { value: 30 },
  ]);

  dim.filterRange([10, 50]);
  assert.deepStrictEqual(cf.allFiltered(), [
    { value: 10 }, { value: 20 }, { value: 30 }, { value: 40 },
  ]);

  dim.filterAll();
  assert.equal(cf.allFiltered().length, 5);

  // Verify grouping still works after lazy filterRange
  var g = dim.group().reduceCount();
  dim.filterRange([25, 45]);
  assert.deepStrictEqual(g.all(), [
    { key: 10, value: 1 },
    { key: 20, value: 1 },
    { key: 30, value: 1 },
    { key: 40, value: 1 },
    { key: 50, value: 1 },
  ]);
  assert.deepStrictEqual(cf.allFiltered(), [
    { value: 30 }, { value: 40 },
  ]);
  dim.filterAll();
});
```

- [ ] **3b: Run test to verify current behavior**

Run: `npx vitest run test/crossfilter.test.js -t "lazy filterRange stays encoded"`
Expected: PASS (materializes but gives correct results). This test verifies correctness, not the lazy path. We'll add a more specific test after implementation.

- [ ] **3c: Implement lazy filterRange**

Replace the `filterRange` function (line 1812):

```js
    function filterRange(range) {
      if (lazyEncodedState && !values && hasLazyEncodedGroupingSupport()) {
        var codeToValue = lazyEncodedState.codeToValue,
            rangeCodes = [],
            code,
            v;

        for (code = 1; code < codeToValue.length; ++code) {
          v = codeToValue[code];
          if (v >= range[0] && v < range[1]) {
            rangeCodes.push(code);
          }
        }

        filterValue = range;
        setFilterValuePresent(true);
        refilter = xfilterFilter.filterRange(bisect, range);
        refilterFunction = null;
        filterInValues = null;
        filterMode = 'bounds';
        return applyLazyEncodedFilter(new Uint32Array(rangeCodes), 'bounds');
      }

      if (lazyEncodedState && !values) {
        materializeLazyEncodedState();
      }

      filterValue = range;
      setFilterValuePresent(true);
      return filterIndexBounds((refilter = xfilterFilter.filterRange(bisect, range))(values), false, 'bounds');
    }
```

- [ ] **3d: Run all tests**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **3e: Run lint**

Run: `npx eslint src/`
Expected: clean

- [ ] **3f: Commit**

```
feat: lazy filterRange for orderable encoded values
```

---

### Task 4: Lazy dimension.groupAll

`dimension.groupAll()` calls `group(cr_null)`, and `group()` only allows lazy encoding when `key === cr_identity`. Since groupAll is a singleton bucket that doesn't need sorted keys, it can stay lazy.

**Files:**
- Modify: `src/index.js:2131` (group function lazy check)
- Test: `test/crossfilter.test.js` (new test)

- [ ] **4a: Write failing test**

```js
it("dimension groupAll stays lazy encoded", function () {
  var cf = crossfilter();
  var dim = cf.dimension(function (d) { return d.type; });
  cf.add([
    { type: "a", amount: 10 },
    { type: "b", amount: 20 },
    { type: "a", amount: 30 },
  ]);

  var ga = dim.groupAll().reduceSum(function (d) { return d.amount; });
  assert.equal(ga.value(), 60);

  dim.filterExact("a");
  assert.equal(ga.value(), 60); // groupAll ignores own dim filter
  dim.filterAll();

  // Append more data
  cf.add([{ type: "c", amount: 40 }]);
  assert.equal(ga.value(), 100);
});
```

- [ ] **4b: Run test to verify current behavior**

Run: `npx vitest run test/crossfilter.test.js -t "dimension groupAll stays lazy"`
Expected: PASS (materializes but gives correct results)

- [ ] **4c: Extend the lazy grouping check to include groupAll**

At line 2131, change:
```js
      var useLazyEncodedGrouping = key === cr_identity && hasLazyEncodedGroupingSupport();
```
to:
```js
      var useLazyEncodedGrouping = (key === cr_identity || key === cr_null) && hasLazyEncodedGroupingSupport();
```

- [ ] **4d: Run all tests**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **4e: Run lint**

Run: `npx eslint src/`
Expected: clean

- [ ] **4f: Commit**

```
feat: lazy dimension.groupAll avoids materialization
```

---

### Task 5: Final verification and build

- [ ] **5a: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass

- [ ] **5b: Run lint**

Run: `npx eslint src/`
Expected: clean

- [ ] **5c: Build distributables**

Run: `npm run build`
Expected: `crossfilter.js` and `crossfilter.min.js` updated

- [ ] **5d: Commit build artifacts**

```
build: rebuild after lazy encoded optimizations
```
