import crossfilter from "../main.js";
import { describe, expect, it } from "vitest";

describe("columnar helpers", () => {
  it("filters discrete values with filterIn", () => {
    const cf = crossfilter([
      { type: "tab", total: 10 },
      { type: "cash", total: 20 },
      { type: "visa", total: 30 },
      { type: "tab", total: 40 },
    ]);
    const typeDimension = cf.dimension("type");

    typeDimension.filterIn(["tab", "cash"]);
    expect(cf.allFiltered().map((row) => row.total)).toEqual([10, 20, 40]);

    typeDimension.filterIn(["visa"]);
    expect(cf.allFiltered().map((row) => row.total)).toEqual([30]);

    typeDimension.filterAll();
    expect(cf.allFiltered().map((row) => row.total)).toEqual([10, 20, 30, 40]);
  });

  it("builds crossfilters from columnar sources", () => {
    const cf = crossfilter.fromColumns({
      city: ["A", "B", "A"],
      value: new Int32Array([10, 20, 30]),
    });
    const cityDimension = cf.dimension("city");
    const totals = cf.groupAll().reduceSum((row) => row.value);

    expect(totals.value()).toBe(60);

    cityDimension.filterIn(["A"]);
    expect(cf.allFiltered().map((row) => row.value)).toEqual([10, 30]);
  });

  it("supports function accessors on columnar sources", () => {
    const cf = crossfilter.fromColumns({
      city: ["A", "B", "A"],
      value: new Int32Array([10, 20, 30]),
    });
    const cityDimension = cf.dimension((row) => row.city);
    const cityGroup = cityDimension.group();
    const totals = cf.groupAll().reduceSum((row) => row.value);

    expect(cityGroup.all()).toEqual([
      { key: "A", value: 2 },
      { key: "B", value: 1 },
    ]);
    expect(totals.value()).toBe(60);

    cityDimension.filterExact("A");
    expect(cf.allFiltered().map((row) => row.value)).toEqual([10, 30]);
    expect(cityDimension.top(2).map((row) => row.city)).toEqual(["A", "A"]);
  });

  it("keeps count reducers correct on columnar sources across filters and appended batches", () => {
    const cf = crossfilter.fromColumns({
      city: ["A", "B", "A", "C"],
      value: new Int32Array([1, 2, 3, 4]),
    });
    const cityDimension = cf.dimension("city");
    const valueDimension = cf.dimension("value");
    const cityGroup = cityDimension.group();
    const totals = cf.groupAll().reduceCount();

    expect(cityGroup.all()).toEqual([
      { key: "A", value: 2 },
      { key: "B", value: 1 },
      { key: "C", value: 1 },
    ]);
    expect(totals.value()).toBe(4);

    valueDimension.filterRange([2, 5]);
    expect(cityGroup.all()).toEqual([
      { key: "A", value: 1 },
      { key: "B", value: 1 },
      { key: "C", value: 1 },
    ]);
    expect(totals.value()).toBe(3);

    cf.add(crossfilter.rowsFromColumns({
      city: ["B", "D"],
      value: new Int32Array([5, 6]),
    }));

    expect(cityGroup.all()).toEqual([
      { key: "A", value: 1 },
      { key: "B", value: 1 },
      { key: "C", value: 1 },
      { key: "D", value: 0 },
    ]);
    expect(totals.value()).toBe(3);

    valueDimension.filterRange([5, 7]);
    expect(cityGroup.all()).toEqual([
      { key: "A", value: 0 },
      { key: "B", value: 1 },
      { key: "C", value: 0 },
      { key: "D", value: 1 },
    ]);
    expect(totals.value()).toBe(2);
  });

  it("materializes arrow-like tables without a hard dependency", () => {
    const rows = crossfilter.rowsFromArrowTable({
      numRows: 2,
      schema: {
        fields: [{ name: "city" }, { name: "value" }],
      },
      getChild(name) {
        if (name === "city") return ["A", "B"];
        if (name === "value") return new Int32Array([10, 20]);
        return undefined;
      },
    });

    expect(Array.from(rows)).toEqual([
      { city: "A", value: 10 },
      { city: "B", value: 20 },
    ]);
  });

  it("reports runtime information", () => {
    const info = crossfilter.runtimeInfo();

    expect(typeof info.wasmSupported).toBe("boolean");
    expect(typeof info.wasmEnabled).toBe("boolean");
    expect(["js", "wasm"]).toContain(info.active);
  });

  it("keeps runtime configuration scoped to each crossfilter instance", () => {
    const previous = crossfilter.runtimeInfo();

    crossfilter.configureRuntime({ wasm: true });

    try {
      const cfWasm = crossfilter.fromColumns({
        city: ["A", "B", "A"],
        value: new Int32Array([10, 20, 30]),
      });
      const cfJs = crossfilter.fromColumns({
        city: ["A", "B", "A"],
        value: new Int32Array([10, 20, 30]),
      });

      cfWasm.configureRuntime({ wasm: true });
      cfJs.configureRuntime({ wasm: false });

      cfWasm.dimension("city").filterExact("A");
      cfJs.dimension("city").filterExact("A");

      expect(cfWasm.allFiltered().map((row) => row.value)).toEqual([10, 30]);
      expect(cfJs.allFiltered().map((row) => row.value)).toEqual([10, 30]);
      expect(cfWasm.runtimeInfo().wasmEnabled).toBe(true);
      expect(cfJs.runtimeInfo().wasmEnabled).toBe(false);
      expect(cfJs.runtimeInfo().active).toBe("js");

      crossfilter.configureRuntime({ wasm: false });

      expect(cfWasm.runtimeInfo().wasmEnabled).toBe(true);
      expect(cfJs.runtimeInfo().wasmEnabled).toBe(false);
    } finally {
      crossfilter.configureRuntime({ wasm: previous.wasmEnabled });
    }
  });

  it("keeps lazy wasm dimensions compatible with grouping and top", () => {
    const cf = crossfilter([
      { city: "A", total: 10 },
      { city: "B", total: 20 },
      { city: "A", total: 30 },
    ]);
    const cityDimension = cf.dimension("city");

    cityDimension.filterExact("A");
    expect(cf.allFiltered().map((row) => row.total)).toEqual([10, 30]);
    expect(cityDimension.group().all()).toEqual([
      { key: "A", value: 2 },
      { key: "B", value: 1 },
    ]);
    expect(cityDimension.top(2).map((row) => row.city)).toEqual(["A", "A"]);
  });

  it("supports adding data after lazy wasm grouping", () => {
    const cf = crossfilter([
      { city: "A", total: 10 },
      { city: "B", total: 20 },
      { city: "A", total: 30 },
    ]);
    const cityDimension = cf.dimension("city");
    const cityGroup = cityDimension.group();

    expect(cityGroup.all()).toEqual([
      { key: "A", value: 2 },
      { key: "B", value: 1 },
    ]);

    cf.add([{ city: "B", total: 40 }]);

    expect(cityGroup.all()).toEqual([
      { key: "A", value: 2 },
      { key: "B", value: 2 },
    ]);

    cityDimension.filterExact("B");
    expect(cf.allFiltered().map((row) => row.total)).toEqual([20, 40]);
  });

  it("keeps lazy wasm filters correct across filtered-to-filtered transitions", () => {
    const cf = crossfilter.fromColumns({
      city: ["A", "B", "C", "A", "B", "C", "D"],
      total: new Int32Array([10, 20, 30, 40, 50, 60, 70]),
    });
    const cityDimension = cf.dimension("city");
    const cityGroup = cityDimension.group();

    cityDimension.filterIn(["A", "B"]);
    expect(cf.allFiltered().map((row) => row.total)).toEqual([10, 20, 40, 50]);

    cityDimension.filterIn(["B", "C"]);
    expect(cf.allFiltered().map((row) => row.total)).toEqual([20, 30, 50, 60]);
    expect(cityGroup.all()).toEqual([
      { key: "A", value: 2 },
      { key: "B", value: 2 },
      { key: "C", value: 2 },
      { key: "D", value: 1 },
    ]);

    cityDimension.filterExact("C");
    expect(cf.allFiltered().map((row) => row.total)).toEqual([30, 60]);

    cityDimension.filterAll();
    expect(cf.allFiltered().map((row) => row.total)).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it("keeps large lazy wasm filterIn selections aligned with js fallback", () => {
    const cities = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];
    const totals = new Int32Array(cities.length * 2);
    const repeatedCities = [];

    for (let index = 0; index < cities.length * 2; ++index) {
      repeatedCities.push(cities[index % cities.length]);
      totals[index] = index + 1;
    }

    const previous = crossfilter.runtimeInfo();
    const selected = ["A", "C", "E", "G", "I", "K"];

    try {
      const cfWasm = crossfilter.fromColumns({ city: repeatedCities, total: totals });
      const cfJs = crossfilter.fromColumns({ city: repeatedCities, total: totals });
      const wasmDimension = cfWasm.dimension("city");
      const jsDimension = cfJs.dimension("city");

      cfWasm.configureRuntime({ wasm: true });
      cfJs.configureRuntime({ wasm: false });

      wasmDimension.filterIn(selected);
      jsDimension.filterIn(selected);

      expect(cfWasm.allFiltered().map((row) => row.total)).toEqual(
        cfJs.allFiltered().map((row) => row.total)
      );
    } finally {
      crossfilter.configureRuntime({ wasm: previous.wasmEnabled });
    }
  });

  it("can disable wasm acceleration and fall back to js", () => {
    const previous = crossfilter.runtimeInfo();

    crossfilter.configureRuntime({ wasm: false });

    try {
      const info = crossfilter.runtimeInfo();
      const cf = crossfilter.fromColumns({
        city: ["A", "B", "A"],
        value: new Int32Array([10, 20, 30]),
      });
      const cityDimension = cf.dimension("city");

      expect(info.active).toBe("js");
      cityDimension.filterExact("A");
      expect(cf.allFiltered().map((row) => row.value)).toEqual([10, 30]);
    } finally {
      crossfilter.configureRuntime({ wasm: previous.wasmEnabled });
    }
  });
});
