# WASM Filter Optimizations Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate unnecessary allocations and copies in the WASM filter hot path (`src/wasm.js`) to reduce per-interaction overhead in coordinated-view dashboards.

**Architecture:** Six targeted optimizations to `src/wasm.js`, all internal to that module — no API changes. The `findEncodedMatches` return type stays `Uint32Array`. Consumers in `src/index.js` iterate results synchronously, so returning WASM memory views (zero-copy) is safe. A reusable scratch buffer replaces per-call allocations in the JS fallback path. Memory growth uses 2x amortization.

**Tech Stack:** JavaScript (ES5-style, `var` declarations per project convention), WebAssembly, Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/wasm.js` | Modify | All six optimizations live here |
| `test/wasm.test.js` | Create | Dedicated unit tests for WASM internals |
| `test/columnar.test.js` | Verify | Existing integration tests must stay green |

---

## Chunk 1: Test Infrastructure + Zero-Copy Return

### Task 1: Create dedicated WASM unit test file

**Files:**
- Create: `test/wasm.test.js`
- Modify: `src/wasm.js` (add named export for `denseLookupMatches` to enable direct testing)

- [ ] **Step 1: Export `denseLookupMatches` for testability**

In `src/wasm.js`, add a named export at the bottom of the file so unit tests can exercise the JS fallback directly:

```js
export { denseLookupMatches as _denseLookupMatches };
```

- [ ] **Step 2: Write baseline correctness tests**

Create `test/wasm.test.js` with tests that pin current behavior before we change internals:

```js
import { createWasmRuntimeController, _denseLookupMatches } from "../src/wasm.js";
import { describe, expect, it } from "vitest";

describe("wasm runtime", () => {
  it("returns empty result for empty target codes", () => {
    var ctrl = createWasmRuntimeController({ wasm: true });
    var result = ctrl.findEncodedMatches(new Uint32Array([0, 1, 2]), []);
    expect(result.length).toBe(0);
  });

  it("finds single target code matches", () => {
    var ctrl = createWasmRuntimeController({ wasm: true });
    var codes = new Uint32Array([0, 1, 2, 1, 0]);
    var result = ctrl.findEncodedMatches(codes, [1]);
    expect(Array.from(result)).toEqual([1, 3]);
  });

  it("finds small target set matches via WASM matchSmall path", () => {
    var ctrl = createWasmRuntimeController({ wasm: true });
    var codes = new Uint32Array([0, 1, 2, 3, 1, 2]);
    var result = ctrl.findEncodedMatches(codes, [1, 2]);
    expect(Array.from(result)).toEqual([1, 2, 4, 5]);
  });

  it("finds large target set matches via WASM matchMarked path", () => {
    var ctrl = createWasmRuntimeController({ wasm: true });
    var codes = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    var targets = [1, 3, 5, 7, 2];
    var result = ctrl.findEncodedMatches(codes, targets);
    expect(Array.from(result)).toEqual([1, 2, 3, 5, 7]);
  });

  it("returns same results with WASM enabled vs disabled", () => {
    var wasmCtrl = createWasmRuntimeController({ wasm: true });
    var jsCtrl = createWasmRuntimeController({ wasm: false });
    var codes = new Uint32Array(200);
    for (var i = 0; i < 200; ++i) codes[i] = i % 20;
    var targets = [0, 5, 10, 15, 19];

    var wasmResult = Array.from(wasmCtrl.findEncodedMatches(codes, targets));
    var jsResult = Array.from(jsCtrl.findEncodedMatches(codes, targets));
    expect(wasmResult).toEqual(jsResult);
  });

  it("handles repeated calls with same codes (cache path)", () => {
    var ctrl = createWasmRuntimeController({ wasm: true });
    var codes = new Uint32Array([0, 1, 2, 3]);

    var r1 = ctrl.findEncodedMatches(codes, [1]);
    var r2 = ctrl.findEncodedMatches(codes, [2]);
    var r3 = ctrl.findEncodedMatches(codes, [1, 2]);

    expect(Array.from(r1)).toEqual([1]);
    expect(Array.from(r2)).toEqual([2]);
    expect(Array.from(r3)).toEqual([1, 2]);
  });

  it("handles filter transitions (different targets, same codes)", () => {
    var ctrl = createWasmRuntimeController({ wasm: true });
    var codes = new Uint32Array([0, 1, 2, 3, 4]);

    var r1 = ctrl.findEncodedMatches(codes, [0, 1]);
    var r2 = ctrl.findEncodedMatches(codes, [2, 3]);
    var r3 = ctrl.findEncodedMatches(codes, [4]);

    expect(Array.from(r1)).toEqual([0, 1]);
    expect(Array.from(r2)).toEqual([2, 3]);
    expect(Array.from(r3)).toEqual([4]);
  });
});

describe("denseLookupMatches (JS fallback)", () => {
  it("finds single target code", () => {
    var state = { marks: new Uint32Array(0), version: 1, scratch: new Uint32Array(0) };
    var codes = new Uint32Array([0, 1, 2, 1, 0]);
    var result = _denseLookupMatches(codes, [1], state);
    expect(Array.from(result)).toEqual([1, 3]);
  });

  it("finds multiple target codes", () => {
    var state = { marks: new Uint32Array(0), version: 1, scratch: new Uint32Array(0) };
    var codes = new Uint32Array([0, 1, 2, 3, 4]);
    var result = _denseLookupMatches(codes, [1, 3], state);
    expect(Array.from(result)).toEqual([1, 3]);
  });

  it("reuses state across calls (version incrementing)", () => {
    var state = { marks: new Uint32Array(0), version: 1, scratch: new Uint32Array(0) };
    var codes = new Uint32Array([0, 1, 2, 3]);

    var r1 = _denseLookupMatches(codes, [1], state);
    expect(Array.from(r1)).toEqual([1]);
    expect(state.version).toBeGreaterThan(1);

    var r2 = _denseLookupMatches(codes, [2, 3], state);
    expect(Array.from(r2)).toEqual([2, 3]);
  });

  it("handles version wraparound", () => {
    var state = { marks: new Uint32Array(8), version: 0xffffffff, scratch: new Uint32Array(0) };
    var codes = new Uint32Array([0, 1, 2, 3]);
    var result = _denseLookupMatches(codes, [1, 3], state);
    expect(Array.from(result)).toEqual([1, 3]);
    expect(state.version).toBe(2);
  });

  it("returns no matches when no codes match", () => {
    var state = { marks: new Uint32Array(0), version: 1, scratch: new Uint32Array(0) };
    var codes = new Uint32Array([0, 1, 2]);
    var result = _denseLookupMatches(codes, [5, 6], state);
    expect(Array.from(result)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the new tests to verify baseline**

Run: `npx vitest run test/wasm.test.js`
Expected: All tests PASS

- [ ] **Step 4: Run full test suite to confirm no regressions**

Run: `npx vitest run`
Expected: All 592+ tests PASS

- [ ] **Step 5: Commit**

```bash
git add test/wasm.test.js src/wasm.js
git commit -m "test: add dedicated wasm unit tests pinning current behavior"
```

---

### Task 2: Zero-copy return from WASM `matchSmall` and `matchMarked`

**Files:**
- Modify: `src/wasm.js:193-224` (the `matchSmall` and `matchMarked` methods in `buildRuntime()`)

**Context:** Both methods currently allocate a new `Uint32Array(count)` and copy from WASM memory into it. Since `findEncodedMatches` is called synchronously and consumers iterate results before any subsequent WASM call, we can return a view directly into WASM memory. However, `syncCodes` caching means a subsequent call could overwrite the buffer. We must either: (a) document this contract, or (b) return a subarray view that the caller can consume immediately. Option (a) is correct here — `src/index.js` consumes matches in a tight loop before returning control.

- [ ] **Step 1: Write a test that validates returned data is correct Uint32Array**

Add to `test/wasm.test.js`:

```js
it("returns a valid Uint32Array even when result is a view", () => {
  var ctrl = createWasmRuntimeController({ wasm: true });
  var codes = new Uint32Array([0, 1, 2, 1, 3]);
  var result = ctrl.findEncodedMatches(codes, [1]);
  expect(result instanceof Uint32Array).toBe(true);
  expect(Array.from(result)).toEqual([1, 3]);
  // Result should be usable with Array.from, iteration, indexing
  var sum = 0;
  for (var i = 0; i < result.length; i++) sum += result[i];
  expect(sum).toBe(4);
});
```

- [ ] **Step 2: Run test to verify it passes with current code**

Run: `npx vitest run test/wasm.test.js`
Expected: PASS (this pins the contract)

- [ ] **Step 3: Replace double-copy with subarray view in `matchSmall`**

In `src/wasm.js`, replace the `matchSmall` method body (lines 193-207):

```js
matchSmall: function(codes, targetCodes) {
  var dataBytes = codes.length * 4;
  var targetBytes = targetCodes.length * 4;
  var outPtr = dataBytes + targetBytes;
  var totalBytes = outPtr + codes.length * 4;
  var buffer = this.ensureCapacity(totalBytes);

  this.syncCodes(buffer, codes);
  new Uint32Array(buffer, dataBytes, targetCodes.length).set(targetCodes);

  var count = this.filterInU32(0, codes.length, dataBytes, targetCodes.length, outPtr);
  // SAFETY: returned view is only valid until next matchSmall/matchMarked call
  return new Uint32Array(buffer, outPtr, count);
},
```

- [ ] **Step 4: Replace double-copy with subarray view in `matchMarked`**

In `src/wasm.js`, replace the `matchMarked` method body (lines 208-224):

```js
matchMarked: function(codes, targetCodes, maxTargetCode) {
  var dataBytes = codes.length * 4;
  var targetBytes = targetCodes.length * 4;
  var marksBytes = (maxTargetCode + 1) * 4;
  var markPtr = dataBytes + targetBytes;
  var outPtr = markPtr + marksBytes;
  var totalBytes = outPtr + codes.length * 4;
  var buffer = this.ensureCapacity(totalBytes);

  this.syncCodes(buffer, codes);
  new Uint32Array(buffer, dataBytes, targetCodes.length).set(targetCodes);

  var count = this.markFilterInU32(0, codes.length, dataBytes, targetCodes.length, markPtr, outPtr);
  // SAFETY: returned view is only valid until next matchSmall/matchMarked call
  return new Uint32Array(buffer, outPtr, count);
},
```

- [ ] **Step 5: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS (both new wasm tests and existing columnar tests)

- [ ] **Step 6: Commit**

```bash
git add src/wasm.js test/wasm.test.js
git commit -m "perf(wasm): return zero-copy views from matchSmall and matchMarked"
```

---

## Chunk 2: Caching and Allocation Reduction

### Task 3: Cache target codes to skip redundant copies

**Files:**
- Modify: `src/wasm.js:167-225` (the `buildRuntime()` return object)

**Context:** In coordinated-view dashboards, when the user brushes dimension A, dimensions B/C/D re-filter with their *existing* targets. This means `findMatches` is called multiple times with the same target values. Currently, target codes are copied into WASM memory unconditionally on every call. We add a cache similar to `syncCodes`.

**Important:** `src/index.js` builds `targetCodes` via `resolveLazyTargetCodes()` → `encodeLazyFilterValues()`, which returns a freshly-allocated array each time. Reference equality will never match. Therefore, the cache must use **content-based comparison** (length + element-wise check).

- [ ] **Step 1: Write test for repeated calls with same targets**

Add to `test/wasm.test.js`:

```js
it("produces correct results when called repeatedly with same target values", () => {
  var ctrl = createWasmRuntimeController({ wasm: true });
  var codes1 = new Uint32Array([0, 1, 2, 3, 4]);
  var codes2 = new Uint32Array([0, 1, 2, 3, 4, 5, 6]);

  // Different array references, same content
  var r1 = ctrl.findEncodedMatches(codes1, [1, 3]);
  expect(Array.from(r1)).toEqual([1, 3]);

  var r2 = ctrl.findEncodedMatches(codes2, [1, 3]);
  expect(Array.from(r2)).toEqual([1, 3]);
});

it("produces correct results when targets change between calls", () => {
  var ctrl = createWasmRuntimeController({ wasm: true });
  var codes = new Uint32Array([0, 1, 2, 3, 4]);

  var r1 = ctrl.findEncodedMatches(codes, [1, 3]);
  expect(Array.from(r1)).toEqual([1, 3]);

  var r2 = ctrl.findEncodedMatches(codes, [0, 2, 4]);
  expect(Array.from(r2)).toEqual([0, 2, 4]);
});
```

- [ ] **Step 2: Run tests to pin current behavior**

Run: `npx vitest run test/wasm.test.js`
Expected: PASS

- [ ] **Step 3: Add target caching to `buildRuntime()`**

In `src/wasm.js`, add cached target state to the runtime object returned by `buildRuntime()`, alongside the existing `cachedCodes`/`cachedCodesLength` fields:

```js
cachedTargets: null,
cachedTargetsLength: 0,
cachedTargetsOffset: 0,
```

Add a content-based comparison helper near the top of the file (after `MAX_WASM_MARK_BYTES`):

```js
function arraysEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
```

Add a `syncTargets` method alongside `syncCodes`:

```js
syncTargets: function(buffer, targetCodes, offset) {
  if (arraysEqual(this.cachedTargets, targetCodes)
      && this.cachedTargetsOffset === offset) {
    return;
  }
  new Uint32Array(buffer, offset, targetCodes.length).set(targetCodes);
  this.cachedTargets = targetCodes.slice ? targetCodes.slice() : Array.prototype.slice.call(targetCodes);
  this.cachedTargetsLength = targetCodes.length;
  this.cachedTargetsOffset = offset;
},
```

Invalidate target cache when capacity changes — in `ensureCapacity`, add after `this.cachedCodesLength = 0;`:

```js
this.cachedTargets = null;
this.cachedTargetsLength = 0;
this.cachedTargetsOffset = 0;
```

Replace the bare `new Uint32Array(buffer, dataBytes, targetCodes.length).set(targetCodes)` lines in both `matchSmall` and `matchMarked` with:

```js
this.syncTargets(buffer, targetCodes, dataBytes);
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/wasm.js test/wasm.test.js
git commit -m "perf(wasm): cache target codes to skip redundant copies"
```

---

### Task 4: Reusable scratch buffer in JS fallback `denseLookupMatches`

**Files:**
- Modify: `src/wasm.js:255-312` (`ensureDenseLookupCapacity` and `denseLookupMatches`)
- Modify: `src/wasm.js:324-385` (`createWasmRuntimeController` — add scratch buffer to state)

**Context:** `denseLookupMatches` allocates a worst-case `new Uint32Array(codes.length)` then `.slice(0, count)` — two allocations per call. Instead, we maintain a reusable scratch buffer on `denseLookupState`, growing it with the same doubling strategy as `marks`.

- [ ] **Step 1: Write test for JS fallback with large dataset**

Add to `test/wasm.test.js`:

```js
it("JS fallback handles large datasets without regression", () => {
  var state = { marks: new Uint32Array(0), version: 1, scratch: new Uint32Array(0) };
  var codes = new Uint32Array(10000);
  for (var i = 0; i < 10000; ++i) codes[i] = i % 50;
  var targets = [0, 10, 20, 30, 40];

  var result = _denseLookupMatches(codes, targets, state);
  expect(result.length).toBe(2000); // 5 targets * 200 each in 10000/50
  expect(result[0]).toBe(0);
  expect(result[1]).toBe(10);
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run test/wasm.test.js`
Expected: PASS

- [ ] **Step 3: Add scratch buffer to `denseLookupState` and `denseLookupMatches`**

In `createWasmRuntimeController`, change the `denseLookupState` initialization:

```js
var denseLookupState = {
  marks: new Uint32Array(0),
  version: 1,
  scratch: new Uint32Array(0)
};
```

Add a capacity helper (place near `ensureDenseLookupCapacity`):

```js
function ensureScratchCapacity(state, size) {
  if (state.scratch.length >= size) {
    return state.scratch;
  }

  var nextSize = state.scratch.length || 256;
  while (nextSize < size) {
    nextSize <<= 1;
  }

  state.scratch = new Uint32Array(nextSize);
  return state.scratch;
}
```

In `denseLookupMatches`, replace `var matches = new Uint32Array(codes.length);` with:

```js
var matches = ensureScratchCapacity(state, codes.length);
```

And replace `return matches.slice(0, count);` with the same (`.slice` creates a copy — this is correct because the caller needs a stable result, and `.slice` on a larger reused buffer is still only one allocation instead of two):

```js
return matches.slice(0, count);
```

**Note:** The single-target fast path (lines 275-283) should also use the scratch buffer. Replace its `var matches = new Uint32Array(codes.length);` similarly.

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/wasm.js test/wasm.test.js
git commit -m "perf(wasm): reuse scratch buffer in JS fallback path"
```

---

## Chunk 3: Memory Growth + Threshold Tuning

### Task 5: Amortized WASM memory growth (2x strategy)

**Files:**
- Modify: `src/wasm.js:173-184` (`ensureCapacity` in `buildRuntime()`)

**Context:** `ensureCapacity` grows to exactly the needed page count. If alternating between `matchSmall` (smaller layout) and `matchMarked` (larger layout due to marks region), this can cause repeated `memory.grow()` calls. Each `memory.grow()` invalidates all TypedArray views and the codes cache. Growing to 2x amortizes this.

- [ ] **Step 1: Write test for alternating small/marked calls**

Add to `test/wasm.test.js`:

```js
it("handles alternating small and large target sets without error", () => {
  var ctrl = createWasmRuntimeController({ wasm: true });
  var codes = new Uint32Array(5000);
  for (var i = 0; i < 5000; ++i) codes[i] = i % 100;

  // Small target — uses matchSmall
  var r1 = ctrl.findEncodedMatches(codes, [1, 2]);
  expect(r1.length).toBe(100);

  // Large target — uses matchMarked, needs more memory for marks
  var bigTargets = [];
  for (var j = 0; j < 50; j++) bigTargets.push(j * 2);
  var r2 = ctrl.findEncodedMatches(codes, bigTargets);
  expect(r2.length).toBe(2500);

  // Back to small — should not re-grow
  var r3 = ctrl.findEncodedMatches(codes, [3]);
  expect(r3.length).toBe(50);
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run test/wasm.test.js`
Expected: PASS

- [ ] **Step 3: Change `ensureCapacity` to grow 2x**

In `src/wasm.js`, replace the `ensureCapacity` method:

```js
ensureCapacity: function(totalBytes) {
  var currentBytes = this.memory.buffer.byteLength;

  if (totalBytes <= currentBytes) {
    return this.memory.buffer;
  }

  var targetBytes = currentBytes;
  while (targetBytes < totalBytes) {
    targetBytes = targetBytes ? targetBytes * 2 : 65536;
  }

  var pagesNeeded = Math.ceil(targetBytes / 65536);
  var currentPages = currentBytes / 65536;

  this.memory.grow(pagesNeeded - currentPages);
  this.cachedCodes = null;
  this.cachedCodesLength = 0;
  this.cachedTargets = null;
  this.cachedTargetsLength = 0;
  this.cachedTargetsOffset = 0;

  return this.memory.buffer;
},
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/wasm.js test/wasm.test.js
git commit -m "perf(wasm): use 2x growth strategy for WASM memory"
```

---

### Task 6: Make `SMALL_TARGET_WASM_THRESHOLD` data-size-aware

**Files:**
- Modify: `src/wasm.js:13,348-374` (threshold constant and `findMatches` function)

**Context:** `matchSmall` uses a nested loop O(n*k). `matchMarked` uses a marks array O(n+k). For large `n`, even k=2 is faster with marks. The crossover is approximately when `n * k > n + k + marks_setup`, which simplifies to: use `matchMarked` when `k > 1` AND `n > ~1000`. We'll keep `matchSmall` for k=1 (single target) and very small datasets, but route larger datasets to `matchMarked` earlier.

- [ ] **Step 1: Write test for correctness at the routing boundary**

Add to `test/wasm.test.js`:

```js
it("routes to correct strategy for 2 targets on large dataset", () => {
  var ctrl = createWasmRuntimeController({ wasm: true });
  var jsCtrl = createWasmRuntimeController({ wasm: false });
  var codes = new Uint32Array(5000);
  for (var i = 0; i < 5000; ++i) codes[i] = i % 100;

  // 2 targets — previously used matchSmall, now should use matchMarked for large n
  var targets = [10, 20];
  var wasmResult = Array.from(ctrl.findEncodedMatches(codes, targets));
  var jsResult = Array.from(jsCtrl.findEncodedMatches(codes, targets));
  expect(wasmResult).toEqual(jsResult);
});

it("still uses matchSmall for tiny datasets with few targets", () => {
  var ctrl = createWasmRuntimeController({ wasm: true });
  var codes = new Uint32Array([0, 1, 2, 3, 4]);
  var result = ctrl.findEncodedMatches(codes, [1, 2, 3]);
  expect(Array.from(result)).toEqual([1, 2, 3]);
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/wasm.test.js`
Expected: PASS

- [ ] **Step 3: Update routing logic in `findMatches`**

In `src/wasm.js`, change the threshold constant:

```js
var SMALL_TARGET_WASM_THRESHOLD = 4;
var SMALL_DATA_WASM_THRESHOLD = 1000;
```

Replace the routing logic in `findMatches` (lines 348-377):

```js
function findMatches(codes, targetCodes) {
  if (!targetCodes.length) {
    return new Uint32Array(0);
  }

  var runtime = getSharedRuntime(enabled);
  var maxTargetCode;

  if (runtime) {
    var useSmall = targetCodes.length <= SMALL_TARGET_WASM_THRESHOLD
      && codes.length <= SMALL_DATA_WASM_THRESHOLD;

    if (useSmall) {
      try {
        return runtime.matchSmall(codes, targetCodes);
      } catch (error) {
        sharedRuntimeState.error = error;
        sharedRuntimeState.runtime = null;
      }
    }
  }

  if (runtime) {
    maxTargetCode = maxCodeValue(targetCodes);
    if ((maxTargetCode + 1) * 4 <= MAX_WASM_MARK_BYTES) {
      try {
        return runtime.matchMarked(codes, targetCodes, maxTargetCode);
      } catch (error) {
        sharedRuntimeState.error = error;
        sharedRuntimeState.runtime = null;
      }
    }
  }

  return denseLookupMatches(codes, targetCodes, denseLookupState);
}
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/wasm.js test/wasm.test.js
git commit -m "perf(wasm): make small-target threshold data-size-aware"
```

---

## Chunk 4: Final Verification

### Task 7: Full integration verification

**Files:**
- Verify: all test files, demo server

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS (592+ original tests + new wasm tests)

- [ ] **Step 2: Run Arrow benchmark to measure improvement**

Run: `npm run benchmark:arrow`
Expected: Benchmark completes without error. Note timing differences for `arrow_wasm` vs `arrow_js` modes.

- [ ] **Step 3: Verify demo server still works**

Run: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3333/`
Expected: `200`

If demo server is not running, start it:
Run: `node demo/proxy-server.mjs &`

- [ ] **Step 4: Build the library**

Run: `npm run build`
Expected: `crossfilter.js` and `crossfilter.min.js` generated without errors.

- [ ] **Step 5: Commit build artifacts if changed**

```bash
git add crossfilter.js crossfilter.min.js
git commit -m "build: rebuild after wasm optimizations"
```
