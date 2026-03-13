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
});
