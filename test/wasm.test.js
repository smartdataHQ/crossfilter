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

    var r1 = Array.from(ctrl.findEncodedMatches(codes, [1]));
    var r2 = Array.from(ctrl.findEncodedMatches(codes, [2]));
    var r3 = Array.from(ctrl.findEncodedMatches(codes, [1, 2]));

    expect(r1).toEqual([1]);
    expect(r2).toEqual([2]);
    expect(r3).toEqual([1, 2]);
  });

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

  it("handles filter transitions (different targets, same codes)", () => {
    var ctrl = createWasmRuntimeController({ wasm: true });
    var codes = new Uint32Array([0, 1, 2, 3, 4]);

    var r1 = Array.from(ctrl.findEncodedMatches(codes, [0, 1]));
    var r2 = Array.from(ctrl.findEncodedMatches(codes, [2, 3]));
    var r3 = Array.from(ctrl.findEncodedMatches(codes, [4]));

    expect(r1).toEqual([0, 1]);
    expect(r2).toEqual([2, 3]);
    expect(r3).toEqual([4]);
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
    // single-target path does not increment version; multi-target does
    var versionBefore = state.version;

    var r2 = _denseLookupMatches(codes, [2, 3], state);
    expect(Array.from(r2)).toEqual([2, 3]);
    expect(state.version).toBeGreaterThan(versionBefore);
  });

  it("handles version wraparound", () => {
    var state = { marks: new Uint32Array(8), version: 0xffffffff, scratch: new Uint32Array(0) };
    var codes = new Uint32Array([0, 1, 2, 3]);
    var result = _denseLookupMatches(codes, [1, 3], state);
    expect(Array.from(result)).toEqual([1, 3]);
    expect(state.version).toBe(2);
  });

  it("JS fallback handles large datasets without regression", () => {
    var state = { marks: new Uint32Array(0), version: 1, scratch: new Uint32Array(0) };
    var codes = new Uint32Array(10000);
    for (var i = 0; i < 10000; ++i) codes[i] = i % 50;
    var targets = [0, 10, 20, 30, 40];

    var result = _denseLookupMatches(codes, targets, state);
    expect(result.length).toBe(1000); // 5 targets * 200 each in 10000/50
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(10);
  });

  it("returns no matches when no codes match", () => {
    var state = { marks: new Uint32Array(0), version: 1, scratch: new Uint32Array(0) };
    var codes = new Uint32Array([0, 1, 2]);
    var result = _denseLookupMatches(codes, [5, 6], state);
    expect(Array.from(result)).toEqual([]);
  });
});
