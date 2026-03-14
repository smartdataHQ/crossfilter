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

  it("returns no matches when no codes match", () => {
    var state = { marks: new Uint32Array(0), version: 1, scratch: new Uint32Array(0) };
    var codes = new Uint32Array([0, 1, 2]);
    var result = _denseLookupMatches(codes, [5, 6], state);
    expect(Array.from(result)).toEqual([]);
  });
});
