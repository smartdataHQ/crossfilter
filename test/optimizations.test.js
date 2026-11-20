import * as Arrow from "apache-arrow";
import crossfilter from "../main.js";
import { describe, expect, it } from "vitest";

describe("crossfilter3 optimization correctness & zero-materialization invariants", () => {
  it("never materializes row objects for flat groups, splitField groups, single-sum KPI, bounds, rows(columnar), or timeBucket", () => {
    let materializedRows = 0;
    const n = 2000;
    const countries = ["US", "DE", "FR", "JP", "BR"];
    const channels = ["web", "mobile", "retail", "b2b"];
    const dayBase = Date.UTC(2025, 0, 1);

    const country = new Array(n);
    const channel = new Array(n);
    const ts = new Float64Array(n);
    const revenue = new Float64Array(n);
    const cost = new Float64Array(n);
    const discount = new Float64Array(n);

    for (let i = 0; i < n; ++i) {
      country[i] = countries[i % countries.length];
      channel[i] = channels[i % channels.length];
      ts[i] = dayBase + (i % 60) * 86400000 + (i % 24) * 3600000;
      revenue[i] = (i % 100) + 1;
      cost[i] = ((i % 100) + 1) * 0.6;
      discount[i] = i % 5 === 0 ? 0 : 0.1;
    }

    const spyRowFactory = (index, columns, fields, accessors) => {
      materializedRows += 1;
      const row = {};
      for (let f = 0; f < fields.length; ++f) {
        row[fields[f]] = accessors[f](index);
      }
      return row;
    };

    // 1. Standard + splitField + timeBucket + multi-KPI dashboard
    const runtime = crossfilter.createDashboardRuntime({
      columns: { country, channel, ts, revenue, cost, discount },
      columnarOptions: { rowFactory: spyRowFactory },
      dimensions: ["country", "channel", "ts", "revenue"],
      kpis: [
        { id: "rows", op: "count" },
        { id: "rev", op: "sum", field: "revenue" },
        { id: "avgRev", op: "avg", field: "revenue" },
        { id: "avgDisc", op: "avgNonZero", field: "discount" },
        { id: "margin", op: "ratio", field: "cost", denominator: "revenue" },
      ],
      groups: [
        {
          id: "byCountry",
          field: "country",
          metrics: [
            { id: "rows", op: "count" },
            { id: "rev", op: "sum", field: "revenue" },
            { id: "avgRev", op: "avg", field: "revenue" },
            { id: "avgDisc", op: "avgNonZero", field: "discount" },
            { id: "margin", op: "ratio", field: "cost", denominator: "revenue" },
          ],
        },
        {
          id: "countryByChannel",
          field: "country",
          splitField: "channel",
          metrics: [
            { id: "rows", op: "count" },
            { id: "rev", op: "sum", field: "revenue" },
          ],
        },
        {
          id: "byDay",
          field: "ts",
          bucket: { type: "timeBucket", granularity: "day" },
          metrics: [{ id: "rev", op: "sum", field: "revenue" }],
        },
      ],
    });

    const snap0 = runtime.snapshot();
    expect(snap0.kpis.rows).toBe(n);
    expect(snap0.groups.byCountry.length).toBe(5);
    expect(snap0.groups.byDay.length).toBe(60);
    expect(Object.keys(snap0.groups.countryByChannel[0].value).sort()).toEqual(["b2b", "mobile", "retail", "web"]);

    // Filter + bounds + columnar rows + isolatedFilters
    runtime.updateFilters({
      country: { type: "in", values: ["US", "DE"] },
      ts: { type: "range", range: [dayBase, dayBase + 30 * 86400000] },
    });
    const snap1 = runtime.snapshot(null, {
      groups: {
        byCountry: { limit: 3, sort: "desc", sortMetric: "rev", includeTotals: true },
        countryByChannel: { limit: 3, sort: "desc", sortMetric: "rev", includeTotals: true },
        byDay: { sort: "natural", includeTotals: true },
      },
    });
    expect(snap1.groups.byCountry.total).toBe(5);
    expect(snap1.groups.byCountry.entries.length).toBe(3);

    const bounds = runtime.bounds({ fields: ["revenue", "ts", "country"] });
    expect(bounds.revenue.min).toBeGreaterThanOrEqual(1);
    expect(bounds.revenue.max).toBeLessThanOrEqual(100);
    expect(bounds.ts.min).toBeGreaterThanOrEqual(dayBase);
    expect(bounds.ts.max).toBeLessThan(dayBase + 30 * 86400000);
    expect(bounds.country.min).toBe("DE");
    expect(bounds.country.max).toBe("US");

    const topRows = runtime.rows({ columnar: true, fields: ["country", "revenue"], sortBy: "revenue", direction: "top", limit: 10 });
    expect(topRows.length).toBe(10);
    expect(topRows.columns.revenue).toBeInstanceOf(Float64Array);

    const isolated = runtime.query({
      isolatedFilters: { channel: { type: "exact", value: "web" } },
      snapshot: false,
      rowCount: true,
      rows: { columnar: true, fields: ["channel", "revenue"], sortBy: "revenue", direction: "bottom", limit: 5 },
    });
    expect(isolated.rowCount).toBe(500);
    expect(isolated.rows.length).toBe(5);
    expect(isolated.rows.columns.channel.every((v) => v === "web")).toBe(true);

    // 2. Single-sum KPI runtime must also never materialize rows
    const kpiOnly = crossfilter.createDashboardRuntime({
      columns: { country, revenue },
      columnarOptions: { rowFactory: spyRowFactory },
      dimensions: ["country"],
      kpis: [{ id: "rev", op: "sum", field: "revenue" }],
    });
    expect(kpiOnly.snapshot().kpis.rev).toBe(snap0.kpis.rev);
    kpiOnly.updateFilters({ country: { type: "exact", value: "US" } });
    expect(kpiOnly.snapshot().kpis.rev).toBeGreaterThan(0);

    expect(materializedRows).toBe(0);

    runtime.dispose();
    kpiOnly.dispose();
  });

  it("matches materialized crossfilter exactly for topIndex/bottomIndex tie-breaking, offsets, and mixed null/0", () => {
    const numRows = [];
    const numCol = new Float64Array(400);
    const tagCol = new Array(400);
    for (let i = 0; i < 400; ++i) {
      const v = (i * 7) % 15; // heavy ties
      const tag = i % 3 === 0 ? "A" : "B";
      numCol[i] = v;
      tagCol[i] = tag;
      numRows.push({ v, tag });
    }

    const cfRaw = crossfilter.fromColumns({ v: numCol, tag: tagCol });
    const cfMat = crossfilter(numRows);
    const dimRawV = cfRaw.dimension("v");
    const dimRawTag = cfRaw.dimension("tag");
    const dimMatV = cfMat.dimension((d) => d.v);
    const dimMatTag = cfMat.dimension((d) => d.tag);
    // Force materialization on cfMat via filterFunction
    dimMatV.filterFunction(() => true);
    dimMatV.filterAll();

    for (const [k, offset] of [[1, 0], [10, 0], [25, 10], [50, 380], [0, 0], [500, 0]]) {
      expect(dimRawV.topIndex(k, offset)).toEqual(dimMatV.topIndex(k, offset));
      expect(dimRawV.bottomIndex(k, offset)).toEqual(dimMatV.bottomIndex(k, offset));
      expect(dimRawTag.topIndex(k, offset)).toEqual(dimMatTag.topIndex(k, offset));
      expect(dimRawTag.bottomIndex(k, offset)).toEqual(dimMatTag.bottomIndex(k, offset));
    }

    // With active filter
    dimRawTag.filterExact("A");
    dimMatTag.filterExact("A");
    expect(dimRawV.topIndex(20, 5)).toEqual(dimMatV.topIndex(20, 5));
    expect(dimRawV.bottomIndex(20, 5)).toEqual(dimMatV.bottomIndex(20, 5));

    // Mixed null & 0 (natural order treats null == 0, tie-breaking by row index)
    const mixed = [0, null, 1, null, 0, -1, 0, null, 2];
    const cfLazyMixed = crossfilter.fromColumns({ m: mixed });
    const cfMatMixed = crossfilter(mixed.map((m) => ({ m })));
    const dLazy = cfLazyMixed.dimension("m");
    const dMat = cfMatMixed.dimension((d) => d.m);
    dMat.filterFunction(() => true);
    dMat.filterAll();

    expect(dLazy.topIndex(5, 0)).toEqual(dMat.topIndex(5, 0));
    expect(dLazy.bottomIndex(5, 0)).toEqual(dMat.bottomIndex(5, 0));
    expect(dLazy.topIndex(4, 2)).toEqual(dMat.topIndex(4, 2));
    expect(dLazy.bottomIndex(4, 2)).toEqual(dMat.bottomIndex(4, 2));
  });

  it("computes exact timeBucket values across minute, hour, day, week (boundaries & pre-1970), month, and streaming appends", () => {
    const timestamps = new Float64Array([
      Date.UTC(1969, 11, 28, 23, 59, 59, 999), // Sun pre-epoch -> Mon 1969-12-22
      Date.UTC(1969, 11, 29, 0, 0, 0, 0),      // Mon pre-epoch -> Mon 1969-12-29
      Date.UTC(1970, 0, 1, 12, 34, 56, 789),   // Thu epoch -> Mon 1969-12-29
      Date.UTC(1970, 0, 4, 23, 59, 59, 999),   // Sun -> Mon 1969-12-29
      Date.UTC(1970, 0, 5, 0, 0, 0, 0),        // Mon -> Mon 1970-01-05
      Date.UTC(2024, 1, 29, 15, 45, 0, 0),     // Leap day Thu -> Mon 2024-02-26
      Date.UTC(2024, 2, 1, 0, 15, 0, 0),       // Fri after leap day -> Mon 2024-02-26
    ]);
    const revenue = Float64Array.from([10, 20, 30, 40, 50, 60, 70]);

    for (const granularity of ["minute", "hour", "day", "week", "month"]) {
      const runtime = crossfilter.createDashboardRuntime({
        columns: { ts: timestamps, revenue },
        dimensions: ["ts"],
        groups: [{
          id: "g",
          field: "ts",
          bucket: { type: "timeBucket", granularity },
          metrics: [{ id: "rev", op: "sum", field: "revenue" }],
        }],
      });
      const entries = runtime.snapshot().groups.g;
      const totalRev = entries.reduce((acc, e) => acc + e.value.rev, 0);
      expect(totalRev).toBe(280);

      if (granularity === "week") {
        expect(entries.map((e) => [new Date(e.key).toISOString().slice(0, 10), e.value.rev])).toEqual([
          ["1969-12-22", 10],
          ["1969-12-29", 90],
          ["1970-01-05", 50],
          ["2024-02-26", 130],
        ]);
      }
      if (granularity === "month") {
        expect(entries.map((e) => [new Date(e.key).toISOString().slice(0, 10), e.value.rev])).toEqual([
          ["1969-12-01", 30],
          ["1970-01-01", 120],
          ["2024-02-01", 60],
          ["2024-03-01", 70],
        ]);
      }

      // Streaming append with both existing and brand-new bucket keys
      runtime.appendColumns({
        ts: new Float64Array([Date.UTC(2024, 1, 29, 20, 0, 0), Date.UTC(2025, 5, 15, 10, 0, 0)]),
        revenue: new Float64Array([5, 100]),
      });
      const entriesAfter = runtime.snapshot().groups.g;
      expect(entriesAfter.reduce((acc, e) => acc + e.value.rev, 0)).toBe(385);
      runtime.dispose();
    }
  });

  it("handles sparse 2D splitField grids (>262,144 potential cells) across filters, appends, and removals", () => {
    // 600 primary keys x 500 split keys = 300,000 > 262,144 -> forces sparse 2D split mode
    const n = 1200;
    const sku = new Array(n);
    const store = new Array(n);
    const region = new Array(n);
    const rev = new Float64Array(n);
    for (let i = 0; i < n; ++i) {
      sku[i] = `sku_${String(i % 600).padStart(4, "0")}`;
      store[i] = `store_${String(i % 500).padStart(4, "0")}`;
      region[i] = i % 2 === 0 ? "east" : "west";
      rev[i] = i % 10 === 0 ? 0 : 10; // include active zero-sum rows!
    }

    const runtime = crossfilter.createDashboardRuntime({
      columns: { sku, store, region, rev },
      dimensions: ["sku", "region"],
      groups: [{
        id: "skuByStore",
        field: "sku",
        splitField: "store",
        metrics: [{ id: "rev", op: "sum", field: "rev" }],
      }],
    });

    const all0 = runtime.snapshot().groups.skuByStore;
    expect(all0.length).toBe(600);
    // sku_0000 appears at i=0 (store_0000, rev=0, east) and i=600 (store_0100, rev=0, east)
    const sku0 = all0.find((e) => e.key === "sku_0000");
    expect(sku0.value).toEqual({
      store_0000: { rev: 0 },
      store_0100: { rev: 0 },
    });

    // Filter region to "west" -> sku_0000 has 0 rows in both stores -> excluded from split output!
    runtime.updateFilters({ region: { type: "exact", value: "west" } });
    const queried = runtime.groups({
      groups: {
        skuByStore: { limit: 10, sort: "desc", sortMetric: "rev", includeTotals: true, visibleOnly: true },
      },
    });
    expect(queried.skuByStore.total).toBe(300);
    expect(queried.skuByStore.entries.length).toBe(10);

    // Append a new batch adding a brand new split key
    runtime.appendColumns({
      sku: ["sku_0001"],
      store: ["store_9999"],
      region: ["west"],
      rev: new Float64Array([500]),
    });
    const top1 = runtime.groups({
      groups: {
        skuByStore: { limit: 1, sort: "desc", sortMetric: "rev", includeTotals: true },
      },
    });
    expect(top1.skuByStore.entries[0].key).toBe("sku_0001");
    expect(top1.skuByStore.entries[0].value.store_9999).toEqual({ rev: 500 });

    // Remove filtered rows
    runtime.removeFiltered();
    expect(runtime.size()).toBe(600);
    runtime.reset();
    const afterRemove = runtime.groups({
      groups: {
        skuByStore: { limit: 5, sort: "desc", sortMetric: "rev", includeTotals: true },
      },
    });
    expect(afterRemove.skuByStore.total).toBe(300);
    runtime.dispose();
  });

  it("correctly filters appended rows even when a prior lazy/raw filter matched 100% of existing rows", () => {
    // Lazy string dimension
    const cfStr = crossfilter.fromColumns({ city: ["A", "A", "A"], v: new Int32Array([1, 2, 3]) });
    const cityDim = cfStr.dimension("city");
    cityDim.filterExact("A");
    expect(cfStr.allFilteredIndexes()).toEqual([0, 1, 2]);
    cfStr.add(crossfilter.rowsFromColumns({ city: ["A", "B", "A"], v: new Int32Array([4, 5, 6]) }));
    expect(cfStr.allFilteredIndexes()).toEqual([0, 1, 2, 3, 5]);

    // Raw numeric dimension
    const cfNum = crossfilter.fromColumns({ x: new Float64Array([10, 20, 30]) });
    const xDim = cfNum.dimension("x");
    xDim.filterRange([0, 100]);
    expect(cfNum.allFilteredIndexes()).toEqual([0, 1, 2]);
    cfNum.add(crossfilter.rowsFromColumns({ x: new Float64Array([50, 200, 15]) }));
    expect(cfNum.allFilteredIndexes()).toEqual([0, 1, 2, 3, 5]);
  });

  it("handles high-cardinality streaming appends cleanly without O(K^2) regression", () => {
    const cf = crossfilter.fromColumns({
      sku: Array.from({ length: 2000 }, (_, i) => `sku_${i}`),
      v: new Float64Array(2000).fill(1),
    });
    const skuDim = cf.dimension("sku");
    const skuGroup = skuDim.group();
    expect(skuGroup.size()).toBe(2000);

    for (let b = 1; b <= 5; ++b) {
      cf.add(crossfilter.rowsFromColumns({
        sku: Array.from({ length: 2000 }, (_, i) => `sku_${b * 2000 + i}`),
        v: new Float64Array(2000).fill(1),
      }));
    }
    expect(skuGroup.size()).toBe(12000);
    const all = skuGroup.all();
    expect(all.length).toBe(12000);
    expect(all[0]).toEqual({ key: "sku_0", value: 1 });
    expect(all[1]).toEqual({ key: "sku_1", value: 1 });
  });

  it("preserves TypedArrays in takeColumns for uniform columnar sources and plain Arrays for record sources", () => {
    const cfCol = crossfilter.fromColumns({
      a: new Float64Array([1, 2, 3]),
      b: new Int32Array([10, 20, 30]),
      c: ["x", "y", "z"],
    });
    cfCol.add(crossfilter.rowsFromColumns({
      a: new Float64Array([4, 5]),
      b: new Int32Array([40, 50]),
      c: ["w", "v"],
    }));
    const resCol = cfCol.takeColumns([0, 2, 4], ["a", "b", "c"]);
    expect(resCol.columns.a).toBeInstanceOf(Float64Array);
    expect(Array.from(resCol.columns.a)).toEqual([1, 3, 5]);
    expect(resCol.columns.b).toBeInstanceOf(Int32Array);
    expect(Array.from(resCol.columns.b)).toEqual([10, 30, 50]);
    expect(Array.isArray(resCol.columns.c)).toBe(true);
    expect(resCol.columns.c).toEqual(["x", "z", "v"]);

    const cfRec = crossfilter([
      { a: 1, c: "x" },
      { a: 2, c: "y" },
    ]);
    const resRec = cfRec.takeColumns([1, 0], ["a", "c"]);
    expect(Array.isArray(resRec.columns.a)).toBe(true);
    expect(resRec.columns.a).toEqual([2, 1]);
  });

  it("keeps isolatedFilters transient reads exact without perturbing active dashboard groups", () => {
    const runtime = crossfilter.createDashboardRuntime({
      columns: {
        country: ["US", "US", "DE", "DE", "FR", "FR"],
        channel: ["web", "mobile", "web", "mobile", "web", "mobile"],
        rev: new Float64Array([10, 20, 30, 40, 50, 60]),
      },
      dimensions: ["country", "channel", "rev"],
      kpis: [{ id: "rows", op: "count" }, { id: "rev", op: "sum", field: "rev" }],
      groups: [{ id: "byCountry", field: "country", metrics: [{ id: "rev", op: "sum", field: "rev" }] }],
    });

    runtime.updateFilters({ country: { type: "exact", value: "US" } });
    const before = runtime.snapshot();
    expect(before.kpis).toEqual({ rows: 2, rev: 30 });

    // Transient isolated query (different filter, snapshot: false, no groups)
    const transient = runtime.query({
      isolatedFilters: { channel: { type: "exact", value: "mobile" } },
      snapshot: false,
      rowCount: true,
      bounds: { fields: ["rev"] },
      rows: { columnar: true, fields: ["country", "rev"], sortBy: "rev", direction: "top", limit: 2 },
    });
    expect(transient.rowCount).toBe(3);
    expect(transient.bounds.rev).toEqual({ min: 20, max: 60 });
    expect(Array.from(transient.rows.columns.rev)).toEqual([60, 40]);

    // Original filters and group state must remain untouched
    const after = runtime.snapshot();
    expect(after.kpis).toEqual({ rows: 2, rev: 30 });
    expect(after.groups.byCountry).toEqual(before.groups.byCountry);

    // Identical isolatedFilters no-op
    const same = runtime.query({
      isolatedFilters: { country: { type: "exact", value: "US" } },
      snapshot: false,
      rowCount: true,
    });
    expect(same.rowCount).toBe(2);

    // Isolated query WITH snapshot restores prior filter even after reading isolated groups
    const isolatedSnap = runtime.query({
      isolatedFilters: { country: { type: "exact", value: "FR" } },
      snapshot: true,
    });
    expect(isolatedSnap.snapshot.kpis).toEqual({ rows: 2, rev: 110 });
    expect(runtime.snapshot().kpis).toEqual({ rows: 2, rev: 30 });

    runtime.dispose();
  });

  it("handles Arrow IPC tables with dictionary strings and numeric vectors via fromArrowTable", () => {
    const n = 200;
    const cats = ["alpha", "beta", "gamma", "delta"];
    const table = Arrow.tableFromArrays({
      category: Array.from({ length: n }, (_, i) => cats[i % 4]),
      amount: Float64Array.from({ length: n }, (_, i) => i + 1),
      qty: Int32Array.from({ length: n }, (_, i) => (i % 5) + 1),
    });
    const sliced = table.slice(20, 120);
    const runtime = crossfilter.createDashboardRuntime({
      table: sliced,
      dimensions: ["category", "amount"],
      kpis: [
        { id: "rows", op: "count" },
        { id: "sumAmt", op: "sum", field: "amount" },
        { id: "sumQty", op: "sum", field: "qty" },
      ],
      groups: [{
        id: "byCat",
        field: "category",
        metrics: [{ id: "sumAmt", op: "sum", field: "amount" }],
      }],
    });

    const snap = runtime.snapshot();
    expect(snap.kpis.rows).toBe(100);
    // Sum of 21..120 = 100 * 141 / 2 = 7050
    expect(snap.kpis.sumAmt).toBe(7050);
    expect(snap.groups.byCat.length).toBe(4);
    runtime.dispose();
  });
});

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

describe("crossfilter3 differential fuzz oracle & deep edge-case coverage", () => {
  function createPrng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function matchesFilter(val, filter) {
    if (!filter || filter.type === "all") return true;
    if (filter.type === "exact") return Object.is(val, filter.value) || val === filter.value;
    if (filter.type === "in") return filter.values.some((t) => Object.is(val, t) || val === t);
    if (filter.type === "range") return typeof val === "number" && val >= filter.range[0] && val < filter.range[1];
    return true;
  }

  function computeOracleMetrics(rows, metrics) {
    const out = {};
    for (const m of metrics) {
      if (m.op === "count") {
        out[m.id] = rows.length;
      } else if (m.op === "sum") {
        let s = 0;
        for (const r of rows) if (typeof r[m.field] === "number" && Number.isFinite(r[m.field])) s += r[m.field];
        out[m.id] = s;
      } else if (m.op === "avg") {
        let s = 0, c = 0;
        for (const r of rows) if (typeof r[m.field] === "number" && Number.isFinite(r[m.field])) { s += r[m.field]; c += 1; }
        out[m.id] = c ? s / c : null;
      } else if (m.op === "avgNonZero") {
        let s = 0, c = 0;
        for (const r of rows) if (typeof r[m.field] === "number" && Number.isFinite(r[m.field]) && r[m.field] !== 0) { s += r[m.field]; c += 1; }
        out[m.id] = c ? s / c : null;
      } else if (m.op === "ratio") {
        let num = 0, den = 0;
        for (const r of rows) {
          if (typeof r[m.field] === "number" && Number.isFinite(r[m.field])) num += r[m.field];
          if (typeof r[m.denominator] === "number" && Number.isFinite(r[m.denominator])) den += r[m.denominator];
        }
        out[m.id] = den !== 0 ? num / den : null;
      }
    }
    return out;
  }

  function expectCloseRecord(actual, expected) {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) {
      if (expected[k] === null) {
        expect(actual[k]).toBeNull();
      } else {
        expect(actual[k]).toBeCloseTo(expected[k], 7);
      }
    }
  }

  it("matches brute-force oracle across 120 randomized filter/batch/append/remove/isolated/query steps", () => {
    const rnd = createPrng(987654321);
    const countries = ["US", "DE", "FR", "JP", "BR", "CA", "UK", "AU"];
    const channels = ["web", "mobile", "retail", "b2b"];
    const categories = ["alpha", "beta", "gamma", "delta", "epsilon", ""];
    const dayBase = Date.UTC(2025, 0, 1);

    const makeBatch = (count, includeNaN) => {
      const country = new Array(count);
      const channel = new Array(count);
      const category = new Array(count);
      const ts = new Float64Array(count);
      const revenue = new Float64Array(count);
      const cost = new Float64Array(count);
      const discount = new Float64Array(count);
      const rows = new Array(count);
      for (let i = 0; i < count; ++i) {
        const co = countries[(rnd() * countries.length) | 0];
        const ch = channels[(rnd() * channels.length) | 0];
        const ca = categories[(rnd() * categories.length) | 0];
        const t = dayBase + ((rnd() * 30) | 0) * 86400000 + ((rnd() * 24) | 0) * 3600000;
        const rev = includeNaN && rnd() < 0.08
          ? NaN
          : (rnd() < 0.1 ? -Math.round(rnd() * 50) : Math.round(rnd() * 200));
        const c = includeNaN && rnd() < 0.05 ? Infinity : Math.round(rnd() * 100);
        const disc = rnd() < 0.35 ? 0 : Math.round(rnd() * 25) / 100;
        country[i] = co;
        channel[i] = ch;
        category[i] = ca;
        ts[i] = t;
        revenue[i] = rev;
        cost[i] = c;
        discount[i] = disc;
        rows[i] = { country: co, channel: ch, category: ca, ts: t, revenue: rev, cost: c, discount: disc };
      }
      return { columns: { country, channel, category, ts, revenue, cost, discount }, rows };
    };

    const init = makeBatch(350, false);
    let oracleRows = init.rows.slice();
    let activeFilters = {};

    const metrics = [
      { id: "rows", op: "count" },
      { id: "rev", op: "sum", field: "revenue" },
      { id: "avgRev", op: "avg", field: "revenue" },
      { id: "avgDisc", op: "avgNonZero", field: "discount" },
      { id: "margin", op: "ratio", field: "cost", denominator: "revenue" },
    ];

    const runtime = crossfilter.createDashboardRuntime({
      columns: init.columns,
      dimensions: ["country", "channel", "category", "ts", "revenue"],
      kpis: metrics,
      groups: [
        { id: "byCountry", field: "country", metrics },
        { id: "byCategory", field: "category", metrics },
        { id: "countrySplit", field: "country", splitField: "channel", metrics: [{ id: "rows", op: "count" }, { id: "rev", op: "sum", field: "revenue" }] },
        { id: "daySplit", field: "ts", bucket: { type: "timeBucket", granularity: "day" }, splitField: "channel", metrics: [{ id: "rev", op: "sum", field: "revenue" }] },
        { id: "byWeek", field: "ts", bucket: { type: "timeBucket", granularity: "week" }, metrics: [{ id: "rows", op: "count" }, { id: "rev", op: "sum", field: "revenue" }] },
      ],
    });

    const filterRows = (rows, flt, ignoreField) => rows.filter((r) => {
      for (const f of Object.keys(flt)) {
        if (f === ignoreField) continue;
        if (!matchesFilter(r[f], flt[f])) return false;
      }
      return true;
    });

    const verifyAll = () => {
      const snap = runtime.snapshot();
      const filtered = filterRows(oracleRows, activeFilters, null);
      expectCloseRecord(snap.kpis, computeOracleMetrics(filtered, metrics));
      expect(runtime.rowCount()).toBe(filtered.length);

      // Verify bounds
      const b = runtime.bounds({ fields: ["ts", "country"] });
      if (filtered.length === 0) {
        expect(b.ts).toEqual({ min: null, max: null });
        expect(b.country).toEqual({ min: null, max: null });
      } else {
        const tsVals = filtered.map((r) => r.ts);
        expect(b.ts.min).toBe(Math.min(...tsVals));
        expect(b.ts.max).toBe(Math.max(...tsVals));
        const coVals = filtered.map((r) => r.country).sort();
        expect(b.country.min).toBe(coVals[0]);
        expect(b.country.max).toBe(coVals[coVals.length - 1]);
      }

      // Verify byCountry group (ignores country filter!)
      const countryBase = filterRows(oracleRows, activeFilters, "country");
      for (const entry of snap.groups.byCountry) {
        const keyRows = countryBase.filter((r) => r.country === entry.key);
        expectCloseRecord(entry.value, computeOracleMetrics(keyRows, metrics));
      }

      // Verify countrySplit (ignores country filter!)
      for (const entry of snap.groups.countrySplit) {
        const keyRows = countryBase.filter((r) => r.country === entry.key);
        const expectedSplit = {};
        for (const ch of channels) {
          const splitRows = keyRows.filter((r) => r.channel === ch);
          if (splitRows.length > 0) {
            expectedSplit[ch] = computeOracleMetrics(splitRows, [{ id: "rows", op: "count" }, { id: "rev", op: "sum", field: "revenue" }]);
          }
        }
        expect(Object.keys(entry.value).sort()).toEqual(Object.keys(expectedSplit).sort());
        for (const ch of Object.keys(expectedSplit)) {
          expectCloseRecord(entry.value[ch], expectedSplit[ch]);
        }
      }

      // Verify daySplit total revenue matches ts-ignored filtered revenue
      const tsBase = filterRows(oracleRows, activeFilters, "ts");
      const expectedTsRev = computeOracleMetrics(tsBase, [{ id: "rev", op: "sum", field: "revenue" }]).rev;
      let actualDaySplitRev = 0;
      for (const entry of snap.groups.daySplit) {
        for (const ch of Object.keys(entry.value)) {
          actualDaySplitRev += entry.value[ch].rev;
        }
      }
      expect(actualDaySplitRev).toBeCloseTo(expectedTsRev, 6);

      // Verify bounded asc/desc/natural + includeKeys + nonEmptyKeys + search queries
      const catQ = runtime.groups({
        groups: {
          byCategory: {
            sort: "asc",
            sortMetric: "avgRev",
            limit: 3,
            offset: 1,
            includeTotals: true,
            nonEmptyKeys: true,
            includeKeys: ["alpha"],
          },
        },
      }).byCategory;
      expect(catQ.entries.every((e) => e.key !== "")).toBe(true);
      if (oracleRows.some((r) => r.category === "alpha")) {
        expect(catQ.entries.some((e) => e.key === "alpha")).toBe(true);
      }

      // Verify columnar top/bottom rows order
      const topRows = runtime.rows({ columnar: true, fields: ["ts"], sortBy: "ts", direction: "top", limit: 5, offset: 2 });
      const expectedTopTs = filtered.map((r) => r.ts).sort((a, b) => b - a).slice(2, 7);
      expect(Array.from(topRows.columns.ts)).toEqual(expectedTopTs);

      const botRows = runtime.rows({ columnar: true, fields: ["ts"], sortBy: "ts", direction: "bottom", limit: 5, offset: 1 });
      const expectedBotTs = filtered.map((r) => r.ts).sort((a, b) => a - b).slice(1, 6);
      expect(Array.from(botRows.columns.ts)).toEqual(expectedBotTs);
    };

    verifyAll();

    for (let step = 0; step < 120; ++step) {
      const action = rnd();
      if (action < 0.55) {
        // Update 1 to 3 filters randomly
        const next = { ...activeFilters };
        const dimsToTouch = 1 + ((rnd() * 3) | 0);
        for (let d = 0; d < dimsToTouch; ++d) {
          const pick = (rnd() * 4) | 0;
          if (pick === 0) {
            const r = rnd();
            if (r < 0.25) delete next.country;
            else if (r < 0.65) next.country = { type: "exact", value: countries[(rnd() * countries.length) | 0] };
            else next.country = { type: "in", values: [countries[(rnd() * 4) | 0], countries[4 + ((rnd() * 4) | 0)]] };
          } else if (pick === 1) {
            if (rnd() < 0.35) delete next.channel;
            else next.channel = { type: "exact", value: channels[(rnd() * channels.length) | 0] };
          } else if (pick === 2) {
            if (rnd() < 0.35) delete next.category;
            else next.category = { type: "in", values: [categories[(rnd() * 3) | 0], categories[3 + ((rnd() * 3) | 0)]] };
          } else {
            if (rnd() < 0.35) delete next.ts;
            else {
              const d0 = (rnd() * 15) | 0;
              const d1 = d0 + 1 + ((rnd() * 15) | 0);
              next.ts = { type: "range", range: [dayBase + d0 * 86400000, dayBase + d1 * 86400000] };
            }
          }
        }
        activeFilters = next;
        runtime.updateFilters(activeFilters);
      } else if (action < 0.75) {
        // Transient & non-transient isolatedFilters query
        const iso = { channel: { type: "exact", value: channels[(rnd() * channels.length) | 0] } };
        const isoFiltered = filterRows(oracleRows, iso, null);
        const transientRes = runtime.query({
          isolatedFilters: iso,
          snapshot: false,
          rowCount: true,
          rows: { columnar: true, fields: ["ts"], sortBy: "ts", direction: "top", limit: 3 },
        });
        expect(transientRes.rowCount).toBe(isoFiltered.length);
        const snapRes = runtime.query({ isolatedFilters: iso, snapshot: true });
        expectCloseRecord(snapRes.snapshot.kpis, computeOracleMetrics(isoFiltered, metrics));
      } else if (action < 0.90) {
        // Streaming append (some with NaN/Infinity!)
        const batch = makeBatch(40, step > 40);
        runtime.appendColumns(batch.columns);
        oracleRows = oracleRows.concat(batch.rows);
      } else if (oracleRows.length > 100) {
        // Remove filtered rows
        const mode = rnd() < 0.5 ? "included" : "excluded";
        if (mode === "included") {
          oracleRows = oracleRows.filter((r) => !filterRows([r], activeFilters, null).length);
          runtime.removeFiltered();
        } else {
          oracleRows = filterRows(oracleRows, activeFilters, null);
          runtime.removeFiltered("excluded");
        }
      }

      verifyAll();
    }

    runtime.dispose();
  });

  it("exercises streaming worker Arrow IPC fast paths (Int32, Float64, Float32, BigInt64, NaN/null, Dictionary, coalesced batches, transferables)", async () => {
    const source = readFileSync(new URL("../src/dashboard-stream-worker.js", import.meta.url), "utf8");
    const factory = source.slice(source.indexOf("function createWorkerSource("), source.indexOf("export function createStreamingDashboardWorker("));
    const workerSource = runInNewContext(factory + '; createWorkerSource("crossfilter.js", "arrow.js");');

    const dayBase = Date.UTC(2025, 0, 1);
    const makeChunk = (offset, len) => {
      const cat = new Array(len);
      const nullableDict = new Array(len);
      const rev = new Float64Array(len);
      const qty = new Int32Array(len);
      const big = new BigInt64Array(len);
      const tsSec = new Float64Array(len);
      const flag = new Array(len);
      for (let i = 0; i < len; ++i) {
        const idx = offset + i;
        cat[i] = ["alpha", "beta", "gamma"][idx % 3];
        nullableDict[i] = idx % 7 === 0 ? null : ["north", "south"][idx % 2];
        rev[i] = idx % 11 === 0 ? NaN : (idx + 1) * 2.5;
        qty[i] = (idx % 5) + 1;
        big[i] = BigInt((idx % 10) + 1);
        tsSec[i] = Math.floor(dayBase / 1000) + (idx % 10) * 86400; // seconds -> timestampMs multiplies by 1000
        flag[i] = idx % 2 === 0;
      }
      const tbl = Arrow.tableFromArrays({
        cat,
        nullableDict,
        rev,
        qty,
        big,
        tsSec,
        flag,
      });
      return tbl;
    };

    // Build a multi-batch IPC stream (3 batches of 50 rows each = 150 rows, coalesced with batchCoalesceRows: 100)
    const fullTbl = makeChunk(0, 150);
    const batches = [
      ...fullTbl.slice(0, 50).batches,
      ...fullTbl.slice(50, 100).batches,
      ...fullTbl.slice(100, 150).batches,
    ];
    const multiBatchTbl = new Arrow.Table(fullTbl.schema, batches);
    const ipcBytes = Arrow.tableToIPC(multiBatchTbl, "stream");

    const responses = new Map();
    const transferCounts = new Map();
    const snapshots = [];
    let readyResolve;
    const readyPromise = new Promise((resolve) => { readyResolve = resolve; });

    const self = {
      postMessage(message, transferables) {
        if (message.eventType === "snapshot") {
          snapshots.push(message.payload);
          return;
        }
        if (message.eventType === "ready" || message.eventType === "error") {
          readyResolve(message);
          return;
        }
        if (message.id != null) {
          transferCounts.set(message.id, Array.isArray(transferables) ? transferables.length : 0);
          const resolver = responses.get(message.id);
          if (resolver) {
            responses.delete(message.id);
            resolver(message);
          }
        }
      },
    };

    runInNewContext(workerSource, {
      self,
      importScripts() {
        self.Arrow = Arrow;
        self.crossfilter = crossfilter;
      },
      fetch: async () => new Response(ipcBytes),
      AbortController,
      setTimeout,
      clearTimeout,
    });

    const callWorker = (id, type, payload) => new Promise((resolve) => {
      responses.set(id, resolve);
      self.onmessage({ data: { id, type, payload } });
    });

    await callWorker(1, "initStreaming", {
      batchCoalesceRows: 100,
      emitSnapshots: true,
      sources: [{
        id: "base",
        role: "base",
        dataUrl: "https://example.test/multi.arrow",
        projection: {
          fields: ["cat", "nullableDict", "rev", "qty", "big", "tsSec", "flag"],
          transforms: {
            rev: "number",
            big: "number",
            tsSec: "timestampMs",
            flag: "boolean",
          },
        },
      }],
      dimensions: ["cat", "nullableDict", "tsSec", "flag", "qty"],
      kpis: [
        { id: "rows", op: "count" },
        { id: "revSum", op: "sum", field: "rev" },
        { id: "qtySum", op: "sum", field: "qty" },
        { id: "bigSum", op: "sum", field: "big" },
      ],
      groups: [
        { id: "byCat", field: "cat", metrics: [{ id: "rows", op: "count" }, { id: "revSum", op: "sum", field: "rev" }] },
        { id: "byDay", field: "tsSec", bucket: { type: "timeBucket", granularity: "day" }, metrics: [{ id: "rows", op: "count" }] },
      ],
    });

    const readyEvent = await readyPromise;
    expect(readyEvent.eventType).toBe("ready");
    expect(snapshots.length).toBeGreaterThan(0);
    const snapRes = await callWorker(2, "snapshot", {});
    expect(snapRes.ok).toBe(true);
    expect(snapRes.payload.kpis.rows).toBe(150);

    // Expected sums: NaNs normalized to 0 by transform:'number'
    let expectedRev = 0, expectedQty = 0, expectedBig = 0;
    for (let i = 0; i < 150; ++i) {
      if (i % 11 !== 0) expectedRev += (i + 1) * 2.5;
      expectedQty += (i % 5) + 1;
      expectedBig += (i % 10) + 1;
    }
    expect(snapRes.payload.kpis.revSum).toBeCloseTo(expectedRev, 6);
    expect(snapRes.payload.kpis.qtySum).toBe(expectedQty);
    expect(snapRes.payload.kpis.bigSum).toBe(expectedBig);
    expect(snapRes.payload.groups.byDay.length).toBe(10);
    expect(snapRes.payload.groups.byDay[0].key).toBe(dayBase);

    // Verify nullable Dictionary column filtered cleanly
    const nullCheck = await callWorker(3, "query", {
      request: {
        filters: { nullableDict: { type: "exact", value: "north" } },
        snapshot: false,
        rowCount: true,
      },
    });
    expect(nullCheck.ok).toBe(true);
    let expectedNorth = 0;
    for (let i = 0; i < 150; ++i) if (i % 7 !== 0 && i % 2 === 0) expectedNorth += 1;
    expect(nullCheck.payload.rowCount).toBe(expectedNorth);

    // Query columnar rows and verify TypedArray buffers ARE transferred zero-copy!
    const queryRes = await callWorker(4, "query", {
      request: {
        filters: { flag: { type: "exact", value: "true" } },
        snapshot: false,
        rowCount: true,
        rows: { columnar: true, fields: ["cat", "rev", "qty", "tsSec"], sortBy: "rev", direction: "top", limit: 10 },
      },
    });
    expect(queryRes.ok).toBe(true);
    expect(queryRes.payload.rowCount).toBe(75);
    expect(Object.prototype.toString.call(queryRes.payload.rows.columns.rev)).toBe("[object Float64Array]");
    expect(Object.prototype.toString.call(queryRes.payload.rows.columns.qty)).toBe("[object Int32Array]");
    expect(Object.prototype.toString.call(queryRes.payload.rows.columns.tsSec)).toBe("[object Float64Array]");
    // 3 TypedArray columns -> 3 transferable ArrayBuffers!
    expect(transferCounts.get(4)).toBe(3);
  });

  it("works accurately with >32 dimensions (multi-subarray filter bitmasks)", () => {
    const n = 200;
    const cols = { rev: new Float64Array(n), ch: new Array(n) };
    const dimNames = [];
    for (let d = 0; d < 40; ++d) {
      const name = `d_${d}`;
      dimNames.push(name);
      cols[name] = d % 2 === 0
        ? Int32Array.from({ length: n }, (_, i) => i % (d + 2))
        : Array.from({ length: n }, (_, i) => `v_${i % (d + 2)}`);
    }
    for (let i = 0; i < n; ++i) {
      cols.rev[i] = i + 1;
      cols.ch[i] = i % 2 === 0 ? "web" : "app";
    }

    const runtime = crossfilter.createDashboardRuntime({
      columns: cols,
      dimensions: dimNames,
      kpis: [{ id: "rows", op: "count" }, { id: "rev", op: "sum", field: "rev" }],
      groups: [
        { id: "g0", field: "d_0", metrics: [{ id: "rows", op: "count" }, { id: "rev", op: "sum", field: "rev" }] },
        { id: "g38", field: "d_38", splitField: "ch", metrics: [{ id: "rows", op: "count" }, { id: "rev", op: "sum", field: "rev" }] },
      ],
    });

    // Filter across BOTH subarray 0 (d_0, d_1) and subarray 1 (d_35, d_38)
    runtime.updateFilters({
      d_0: { type: "exact", value: 0 },
      d_1: { type: "exact", value: "v_0" },
      d_35: { type: "in", values: ["v_0", "v_2", "v_6"] },
      d_38: { type: "range", range: [0, 20] },
    });

    const expectedIndices = [];
    for (let i = 0; i < n; ++i) {
      if (
        cols.d_0[i] === 0
        && cols.d_1[i] === "v_0"
        && (cols.d_35[i] === "v_0" || cols.d_35[i] === "v_2" || cols.d_35[i] === "v_6")
        && cols.d_38[i] >= 0 && cols.d_38[i] < 20
      ) {
        expectedIndices.push(i);
      }
    }

    const snap = runtime.snapshot();
    expect(snap.kpis.rows).toBe(expectedIndices.length);
    expect(snap.kpis.rev).toBe(expectedIndices.reduce((s, i) => s + cols.rev[i], 0));
    expect(runtime.rowCount()).toBe(expectedIndices.length);

    const bounds = runtime.bounds({ fields: ["d_38"] });
    if (expectedIndices.length) {
      const vals = expectedIndices.map((i) => cols.d_38[i]);
      expect(bounds.d_38).toEqual({ min: Math.min(...vals), max: Math.max(...vals) });
    }
    runtime.dispose();
  });

  it("handles rawNumericState upgrades, non-numeric filters, out-of-range month buckets, wasm:false, and invalid isolatedFilters", () => {
    // 1. rawNumericState with active filterRange -> upgrade via dim.group() -> append new rows
    const cf = crossfilter.fromColumns({
      x: new Float64Array([10, 20, 30, 40]),
      v: new Float64Array([1, 2, 3, 4]),
    });
    const xDim = cf.dimension("x");
    xDim.filterRange([15, 35]);
    expect(cf.allFilteredIndexes()).toEqual([1, 2]);
    // Creating identity group triggers upgradeRawNumericToLazy while filterRange is active
    const xGrp = xDim.group();
    expect(xGrp.all().length).toBe(4);
    cf.add(crossfilter.rowsFromColumns({ x: new Float64Array([25, 50]), v: new Float64Array([5, 6]) }));
    expect(cf.allFilteredIndexes()).toEqual([1, 2, 4]);

    // 2. rawNumericState with non-numeric exact/in filters and NaN append upgrade
    const cf2 = crossfilter.fromColumns({ x: new Float64Array([1, 2, 3]) });
    const d2 = cf2.dimension("x");
    d2.filterExact(null);
    expect(cf2.allFilteredIndexes()).toEqual([]);
    d2.filterIn([]);
    expect(cf2.allFilteredIndexes()).toEqual([]);
    d2.filterIn([2]);
    expect(cf2.allFilteredIndexes()).toEqual([1]);
    d2.filterIn([1, 3]);
    expect(cf2.allFilteredIndexes()).toEqual([0, 2]);
    d2.filterAll();
    // Append NaN -> gracefully upgrades out of rawNumericState
    cf2.add(crossfilter.rowsFromColumns({ x: new Float64Array([NaN, 4]) }));
    expect(d2.topIndex(2)).toEqual([3, 4]); // NaN ranks above finite numbers in compareNaturalOrder or matches materialized

    // 3. rawBucketMode (month) with out-of-range finite timestamp (1e20 -> Date.UTC returns NaN)
    const rtMonth = crossfilter.createDashboardRuntime({
      columns: {
        ts: new Float64Array([Date.UTC(2025, 0, 15), 1e20, Date.UTC(2025, 1, 10)]),
        rev: new Float64Array([10, 999, 20]),
      },
      dimensions: ["ts"],
      groups: [{
        id: "m",
        field: "ts",
        bucket: { type: "timeBucket", granularity: "month" },
        metrics: [{ id: "rev", op: "sum", field: "rev" }],
      }],
    });
    const monthEntries = rtMonth.snapshot().groups.m;
    expect(monthEntries.map((e) => e.value.rev)).toEqual([10, 20]);
    rtMonth.dispose();

    // 4. isolatedFilters with unknown dimension throws even when filter is type:"all"
    const rtIso = crossfilter.createDashboardRuntime({
      columns: { a: ["x", "y"] },
      dimensions: ["a"],
    });
    expect(() => rtIso.query({ isolatedFilters: { bogus: { type: "all" } }, snapshot: false })).toThrow(/Unknown dashboard filter dimension/);
    rtIso.dispose();

    // 5. wasm: false preserves exact results and reports active:"js"
    const rtJs = crossfilter.createDashboardRuntime({
      wasm: false,
      columns: { a: ["x", "y", "x"], v: new Float64Array([10, 20, 30]) },
      dimensions: ["a", "v"],
      kpis: [{ id: "sum", op: "sum", field: "v" }],
      groups: [{ id: "g", field: "a", metrics: [{ id: "sum", op: "sum", field: "v" }] }],
    });
    expect(rtJs.runtimeInfo().active).toBe("js");
    rtJs.updateFilters({ a: { type: "exact", value: "x" } });
    expect(rtJs.snapshot().kpis.sum).toBe(40);
    rtJs.dispose();
  });

  it("built CJS bundle (crossfilter.cjs) passes end-to-end dashboard, splitField, timeBucket, bounds, and isolatedFilters", () => {
    const require = createRequire(import.meta.url);
    const cfCjs = require("../crossfilter.cjs");
    const dayBase = Date.UTC(2025, 0, 1);

    const rt = cfCjs.createDashboardRuntime({
      columns: {
        country: ["US", "DE", "US", "FR"],
        channel: ["web", "web", "app", "app"],
        ts: new Float64Array([dayBase, dayBase, dayBase + 86400000, dayBase + 86400000]),
        rev: new Float64Array([10, 20, 30, 40]),
      },
      dimensions: ["country", "channel", "ts", "rev"],
      kpis: [{ id: "rev", op: "sum", field: "rev" }],
      groups: [
        { id: "split", field: "country", splitField: "channel", metrics: [{ id: "rev", op: "sum", field: "rev" }] },
        { id: "day", field: "ts", bucket: { type: "timeBucket", granularity: "day" }, metrics: [{ id: "rev", op: "sum", field: "rev" }] },
      ],
    });

    const snap = rt.snapshot();
    expect(snap.kpis.rev).toBe(100);
    expect(snap.groups.split.find((e) => e.key === "US").value).toEqual({ web: { rev: 10 }, app: { rev: 30 } });
    expect(rt.bounds({ fields: ["rev"] }).rev).toEqual({ min: 10, max: 40 });
    const iso = rt.query({ isolatedFilters: { channel: { type: "exact", value: "app" } }, snapshot: false, rowCount: true });
    expect(iso.rowCount).toBe(2);
    expect(rt.snapshot().kpis.rev).toBe(100);
    rt.dispose();
  });
});

describe("v3.1.1 systematic correctness fixes and performance fast paths", () => {
  function expectCloseRecord(actual, expected) {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const k of Object.keys(expected)) {
      if (expected[k] === null) {
        expect(actual[k]).toBeNull();
      } else {
        expect(actual[k]).toBeCloseTo(expected[k], 7);
      }
    }
  }

  it("ensureLazyBucketLayout does not alias a reappearing bucket code into slot 0 after remove + add", () => {
    const day0 = Date.UTC(2025, 0, 1);
    const day1 = Date.UTC(2025, 0, 2);
    const day2 = Date.UTC(2025, 0, 3);
    // Use JS array (non-TypedArray) so ts stays in lazyEncodedState + lazyBucketMode
    const cf = crossfilter.fromColumns({
      ts: [day0, day1, day2, day0],
      tag: ["keep", "drop", "keep", "keep"],
      rev: new Float64Array([10, 20, 30, 40]),
    });
    const tsDim = cf.dimension("ts");
    const tagDim = cf.dimension("tag");
    const dayBucket = (v) => Math.floor(v / 86400000) * 86400000;
    dayBucket._xfilterPureMonotonic = true;
    const grp = tsDim.group(dayBucket).reduceCount();

    expect(grp.all()).toEqual([
      { key: day0, value: 2 },
      { key: day1, value: 1 },
      { key: day2, value: 1 },
    ]);

    // Remove all rows belonging to day1 -> code for day1 has count 0
    tagDim.filterExact("drop");
    cf.remove();
    tagDim.filterAll();

    // Trigger full rebuild while day1 has count 0
    expect(grp.all()).toEqual([
      { key: day0, value: 2 },
      { key: day2, value: 1 },
    ]);

    // Re-add rows with day1 (reuses existing code < bucketCodeCount!)
    cf.add(crossfilter.rowsFromColumns({
      ts: [day1, day1, day2],
      tag: ["keep", "keep", "keep"],
      rev: new Float64Array([5, 6, 7]),
    }));

    // day1 must get its own bucket (count 2) and NOT alias into day0 (count must stay 2, not 4!)
    expect(grp.all()).toEqual([
      { key: day0, value: 2 },
      { key: day1, value: 2 },
      { key: day2, value: 2 },
    ]);
  });

  it("dimension.dispose() disposes ALL attached groups without skipping on splice", () => {
    const cf = crossfilter.fromColumns({
      a: ["x", "y", "x", "z"],
      b: ["p", "p", "q", "q"],
      v: new Float64Array([1, 2, 3, 4]),
    });
    const dimA = cf.dimension("a");
    const dimB = cf.dimension("b");
    const calls = [0, 0, 0, 0];
    const groups = [0, 1, 2, 3].map((idx) =>
      dimA.group().reduce(
        (p, d) => { calls[idx] += 1; return p + d.v; },
        (p, d) => { calls[idx] += 1; return p - d.v; },
        () => 0
      )
    );
    // Materialize initial state for all 4 groups
    groups.forEach((g) => g.all());
    const before = calls.slice();

    // Dispose dimA -> must dispose ALL 4 groups (previously skipped every 2nd group)
    dimA.dispose();

    // Filtering dimB or adding new data must invoke ZERO callbacks on any of the 4 disposed groups
    dimB.filterExact("p");
    dimB.filterAll();
    cf.add(crossfilter.rowsFromColumns({ a: ["x"], b: ["p"], v: new Float64Array([99]) }));
    expect(calls).toEqual(before);
  });

  it("metric sum sharing, count-sum fusion, avg-count fusion, and sum-pairing match brute-force oracle across clean and NaN/Infinity data", () => {
    const testCases = [
      { name: "clean", rev: [10, 20, 30, 40, 50, 60, 70, 80], cost: [3, 6, 9, 12, 15, 18, 21, 24], qty: [1, 2, 3, 4, 5, 6, 7, 8] },
      { name: "with NaN/Inf", rev: [10, NaN, 30, Infinity, 50, 60, -Infinity, 80], cost: [3, 6, NaN, 12, 15, Infinity, 21, 24], qty: [1, 2, 3, 4, NaN, 6, 7, 8] },
    ];
    const metricSets = [
      // Heavy sharing: count + sum(rev) + avg(rev) + dup sum(rev) + dup avg(rev) + ratio(cost, rev) + ratio(rev, rev) + ratio(rev, cost)
      [
        { id: "rows", op: "count" },
        { id: "revSum", op: "sum", field: "rev" },
        { id: "revAvg", op: "avg", field: "rev" },
        { id: "revSum2", op: "sum", field: "rev" },
        { id: "revAvg2", op: "avg", field: "rev" },
        { id: "costOverRev", op: "ratio", field: "cost", denominator: "rev" },
        { id: "revOverRev", op: "ratio", field: "rev", denominator: "rev" },
        { id: "revOverCost", op: "ratio", field: "rev", denominator: "cost" },
      ],
      // Avg-only (triggers hidden __rows + firstAvgIndex fusion!)
      [{ id: "avgRev", op: "avg", field: "rev" }],
      // Sum-pair + avg + ratio (no explicit count -> hidden __rows + fused sum + sum-pair)
      [
        { id: "revSum", op: "sum", field: "rev" },
        { id: "qtySum", op: "sum", field: "qty" },
        { id: "avgCost", op: "avg", field: "cost" },
        { id: "ratioRQ", op: "ratio", field: "rev", denominator: "qty" },
      ],
      // Sharing from secondary buffer of an earlier ratio!
      [
        { id: "ratioRC", op: "ratio", field: "rev", denominator: "cost" },
        { id: "costSum", op: "sum", field: "cost" },
        { id: "revSum", op: "sum", field: "rev" },
        { id: "costAvg", op: "avg", field: "cost" },
      ],
    ];

    const cats = ["A", "B", "A", "B", "A", "C", "B", "C"];
    const splits = ["s1", "s1", "s2", "s2", "s1", "s2", "s1", "s2"];
    const flags = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"]; // allows 1-row (<25%) incremental delta!

    for (const tc of testCases) {
      const rows = cats.map((cat, i) => ({
        cat,
        split: splits[i],
        flag: flags[i],
        rev: tc.rev[i],
        cost: tc.cost[i],
        qty: tc.qty[i],
      }));

      const calc = (subset, metrics) => {
        const res = {};
        for (const m of metrics) {
          if (m.op === "count") res[m.id] = subset.length;
          else if (m.op === "sum") res[m.id] = subset.reduce((s, r) => s + (Number.isFinite(r[m.field]) ? r[m.field] : 0), 0);
          else if (m.op === "avg") {
            let s = 0, c = 0;
            for (const r of subset) if (Number.isFinite(r[m.field])) { s += r[m.field]; c += 1; }
            res[m.id] = c ? s / c : null;
          } else if (m.op === "ratio") {
            let n = 0, d = 0;
            for (const r of subset) {
              if (Number.isFinite(r[m.field])) n += r[m.field];
              if (Number.isFinite(r[m.denominator])) d += r[m.denominator];
            }
            res[m.id] = d !== 0 ? n / d : null;
          }
        }
        return res;
      };

      for (const metrics of metricSets) {
        const rt = crossfilter.createDashboardRuntime({
          columns: {
            cat: cats.slice(),
            split: splits.slice(),
            flag: flags.slice(),
            rev: Float64Array.from(tc.rev),
            cost: Float64Array.from(tc.cost),
            qty: Float64Array.from(tc.qty),
          },
          dimensions: ["cat", "split", "flag"],
          kpis: metrics,
          groups: [
            { id: "flat", field: "cat", metrics },
            { id: "dense", field: "cat", splitField: "split", metrics },
          ],
        });

        const verify = (pred) => {
          const snap = rt.snapshot();
          const active = rows.filter(pred);
          expectCloseRecord(snap.kpis, calc(active, metrics));
          for (const entry of snap.groups.flat) {
            const sub = active.filter((r) => r.cat === entry.key);
            expectCloseRecord(entry.value, calc(sub, metrics));
          }
          for (const entry of snap.groups.dense) {
            const bySplit = {};
            for (const sp of ["s1", "s2"]) {
              const sub = active.filter((r) => r.cat === entry.key && r.split === sp);
              if (sub.length) bySplit[sp] = calc(sub, metrics);
            }
            expect(Object.keys(entry.value).sort()).toEqual(Object.keys(bySplit).sort());
            for (const sp of Object.keys(bySplit)) {
              expectCloseRecord(entry.value[sp], bySplit[sp]);
            }
          }
        };

        // 1. Unfiltered reset (reduceGroupedAll / reduceSplitDenseAll / reduceScalarAll)
        verify(() => true);
        // 2. Small incremental removal (<25% delta: exclude 1 of 8 rows via filterIn of 7 flags!)
        rt.updateFilters({ flag: { type: "in", values: flags.slice(1) } });
        verify((r) => r.flag !== "f0");
        // 3. Small incremental add-back + remove (swap f0 back in, drop f1 -> 2/8 = 25% <= n>>>2)
        rt.updateFilters({ flag: { type: "in", values: ["f0", "f2", "f3", "f4", "f5", "f6", "f7"] } });
        verify((r) => r.flag !== "f1");
        // 4. Large filter (>25% forceReset -> reduceGroupedIndexed / reduceSplitDenseIndexed / reduceScalarIndexed reset)
        rt.updateFilters({ split: { type: "exact", value: "s1" } });
        verify((r) => r.split === "s1");
        // 5. Clear back to unfiltered
        rt.updateFilters({});
        verify(() => true);

        rt.dispose();
      }
    }
  });

  it("handles nullable Arrow Dictionary & numeric vectors (including non-byte-aligned slices) in fromArrowTable and streaming worker", async () => {
    const n = 80;
    const cats = Array.from({ length: n }, (_, i) => (i % 7 === 0 ? null : `cat_${i % 5}`));
    const splits = Array.from({ length: n }, (_, i) => (i % 9 === 0 ? null : `ch_${i % 3}`));
    const amts = Array.from({ length: n }, (_, i) => (i % 11 === 0 ? null : (i + 1) * 1.5));
    const ints = Array.from({ length: n }, (_, i) => (i % 6 === 0 ? null : i * 2));
    const tsVals = Array.from({ length: n }, (_, i) => (i % 13 === 0 ? null : BigInt(Date.UTC(2025, 0, 1) + i * 3600000)));

    const dictType = new Arrow.Dictionary(new Arrow.Utf8(), new Arrow.Int32());
    const table = Arrow.tableFromArrays({
      cat: Arrow.vectorFromArray(cats, dictType),
      split: Arrow.vectorFromArray(splits, dictType),
      amt: Arrow.vectorFromArray(amts, new Arrow.Float64()),
      qty: Arrow.vectorFromArray(ints, new Arrow.Int32()),
      ts: Arrow.vectorFromArray(tsVals, new Arrow.Int64()),
    });
    // Non-byte-aligned slice (offset = 7!) exercises nullBitmap bit indexing (chunk.offset + j)
    const sliced = table.slice(7, 67); // 60 rows

    const rt = crossfilter.createDashboardRuntime({
      table: sliced,
      dimensions: ["cat", "split", "amt"],
      kpis: [
        { id: "rows", op: "count" },
        { id: "amtSum", op: "sum", field: "amt" },
        { id: "qtySum", op: "sum", field: "qty" },
      ],
      groups: [
        { id: "byCat", field: "cat", metrics: [{ id: "rows", op: "count" }, { id: "amtSum", op: "sum", field: "amt" }] },
        { id: "byCatSplit", field: "cat", splitField: "split", metrics: [{ id: "rows", op: "count" }, { id: "amtSum", op: "sum", field: "amt" }] },
      ],
    });

    const expectedRows = [];
    for (let i = 7; i < 67; ++i) {
      expectedRows.push({ cat: cats[i], split: splits[i], amt: amts[i], qty: ints[i] });
    }
    const snap = rt.snapshot();
    expect(snap.kpis.rows).toBe(60);
    expect(snap.kpis.amtSum).toBeCloseTo(expectedRows.reduce((s, r) => s + (r.amt ?? 0), 0), 7);
    expect(snap.kpis.qtySum).toBe(expectedRows.reduce((s, r) => s + (r.qty ?? 0), 0));

    // Verify null bucket & every category bucket match exactly
    const nullEntry = snap.groups.byCat.find((e) => e.key === null);
    expect(nullEntry.value.rows).toBe(expectedRows.filter((r) => r.cat === null).length);
    expect(nullEntry.value.amtSum).toBeCloseTo(
      expectedRows.filter((r) => r.cat === null).reduce((s, r) => s + (r.amt ?? 0), 0),
      7
    );

    // Verify splitField __unknown__ bucket for null Arrow Dictionary entries
    const cat0Split = snap.groups.byCatSplit.find((e) => e.key === "cat_0");
    const expectedUnknown = expectedRows.filter((r) => r.cat === "cat_0" && r.split === null).length;
    if (expectedUnknown > 0) {
      expect(cat0Split.value.__unknown__.rows).toBe(expectedUnknown);
    }

    // Verify single-batch Arrow Dictionary takeColumns (>32 rows triggers direct dict decode!)
    const taken = crossfilter.fromArrowTable(sliced).takeColumns(
      Array.from({ length: 60 }, (_, i) => i),
      ["cat", "split", "amt"]
    );
    expect(taken.columns.cat).toEqual(expectedRows.map((r) => r.cat));
    expect(taken.columns.split).toEqual(expectedRows.map((r) => r.split));
    const rtRows = rt.rows({ columnar: true, fields: ["cat", "split", "amt"], limit: 60 });
    expect(rtRows.columns.cat).toEqual(expectedRows.map((r) => r.cat));
    rt.dispose();

    // Also test nullable Arrow IPC + mixed zero-null batch 0 & nullable batch 1 through streaming worker with batchCoalesceRows!
    const b0 = Arrow.tableFromArrays({
      cat: Arrow.vectorFromArray(["a", "b", "a", "c"], dictType),
      amt: Arrow.vectorFromArray([10, 20, 30, 40], new Arrow.Float64()),
      rawNum: Arrow.vectorFromArray([1, 2, 3, 4], new Arrow.Float64()),
      ts: Arrow.vectorFromArray([BigInt(1700000000000), BigInt(1700000001000), BigInt(1700000002000), BigInt(1700000003000)], new Arrow.Int64()),
    });
    const b1 = Arrow.tableFromArrays({
      cat: Arrow.vectorFromArray(["a", null, "b", null], dictType),
      amt: Arrow.vectorFromArray([5, null, 15, 25], new Arrow.Float64()),
      rawNum: Arrow.vectorFromArray([5, null, 7, 8], new Arrow.Float64()),
      ts: Arrow.vectorFromArray([BigInt(1700000004000), null, BigInt(1700000006000), BigInt(1700000007000)], new Arrow.Int64()),
    });
    const ipcBytes = Arrow.tableToIPC(new Arrow.Table([...b0.batches, ...b1.batches]), "stream");

    const workerSrc = readFileSync(new URL("../src/dashboard-stream-worker.js", import.meta.url), "utf8");
    const m = workerSrc.match(/function createWorkerSource\(crossfilterUrl, arrowUrl\)\s*\{\s*return `([\s\S]*?)`;\s*\}/);
    const cfBundle = readFileSync(new URL("../crossfilter.js", import.meta.url), "utf8");
    const resolved = m[1].replace("${JSON.stringify(crossfilterUrl)}", JSON.stringify("cf.js")).replace("${JSON.stringify(arrowUrl)}", JSON.stringify("arrow.js"));

    const responses = new Map();
    let resolveReady;
    const readyPromise = new Promise((r) => { resolveReady = r; });
    const sandbox = {
      console, setTimeout, clearTimeout, URL, TextDecoder, TextEncoder, AbortController,
      ReadableStream, Response, Uint8Array, Int32Array, Float64Array, Float32Array, BigInt64Array, Map, Set, Promise,
      fetch: async () => new Response(ipcBytes, { status: 200 }),
      importScripts: () => { sandbox.Arrow = Arrow; runInNewContext(cfBundle, sandbox); },
      postMessage: (msg) => {
        if (msg.id && responses.has(msg.id)) {
          const { resolve, reject } = responses.get(msg.id);
          responses.delete(msg.id);
          if (msg.ok) resolve(msg.payload);
          else reject(new Error(msg.error?.message || "worker error"));
        } else if (msg.eventType === "ready") {
          resolveReady(msg.payload);
        }
      },
    };
    sandbox.self = sandbox;
    runInNewContext(resolved, sandbox);
    const call = (type, payload) => new Promise((resolve, reject) => {
      const id = `m_${Math.random()}`;
      responses.set(id, { resolve, reject });
      sandbox.onmessage({ data: { id, type, payload } });
    });

    await call("initStreaming", {
      batchCoalesceRows: 100, // forces merging b0 (no nulls) + b1 (with nulls) in mergeProjectedBatches!
      sources: [{
        id: "base",
        role: "base",
        dataUrl: "https://example.test/nullable.arrow",
        projection: {
          fields: ["cat", "amt", "rawNum", "ts"],
          transforms: { amt: "number", ts: "timestampMs" },
        },
      }],
      dimensions: ["cat", "rawNum"],
      kpis: [
        { id: "rows", op: "count" },
        { id: "amtSum", op: "sum", field: "amt" },
      ],
      groups: [{ id: "byCat", field: "cat", metrics: [{ id: "rows", op: "count" }, { id: "amtSum", op: "sum", field: "amt" }] }],
    });
    await readyPromise;

    const q = await call("query", { request: { snapshot: true, rows: { columnar: true, fields: ["cat", "amt", "rawNum", "ts"], limit: 10 } } });
    expect(q.snapshot.kpis).toEqual({ rows: 8, amtSum: 145 });
    expect(q.snapshot.groups.byCat.find((e) => e.key === null).value).toEqual({ rows: 2, amtSum: 25 });
    // Crucial: rawNum null in batch 1 MUST remain null (not coerced to 0 when merged with Float64Array batch 0!)
    expect(q.rows.columns.rawNum[5]).toBeNull();
    expect(q.rows.columns.ts[5]).toBe(0);
    expect(q.rows.columns.ts[0]).toBe(1700000000000);
  });

  it("multi-batch and mixed-batch takeColumns matches brute-force row extraction across sorted, reversed, and shuffled indices", () => {
    const cf = crossfilter([{ k: "obj0", x: 100, f: 1.5 }, { k: "obj1", x: 200, f: 2.5 }]);
    // Mixed object rows + single columnar batch (exercises batchCount === 1 && !singleFullBatch)
    cf.add(crossfilter.rowsFromColumns({
      k: ["b1_0", "b1_1", "b1_2"],
      x: new Int32Array([300, 400, 500]),
      f: new Float64Array([3.5, 4.5, 5.5]),
    }));
    const mixed = cf.takeColumns([4, 0, 2, 1, 3], ["k", "x", "f"]);
    expect(mixed.columns.k).toEqual(["b1_2", "obj0", "b1_0", "obj1", "b1_1"]);
    expect(mixed.columns.x).toEqual([500, 100, 300, 200, 400]);
    expect(mixed.columns.f).toEqual([5.5, 1.5, 3.5, 2.5, 4.5]);

    // 6 uniform columnar batches (exercises cached numericColumns + multi-batch cached cursor!)
    const cfMulti = crossfilter();
    const allK = [], allX = [], allF = [];
    for (let b = 0; b < 6; ++b) {
      const k = [], x = new Int32Array(25), f = new Float64Array(25);
      for (let i = 0; i < 25; ++i) {
        const g = b * 25 + i;
        k.push(`k_${g}`);
        x[i] = g * 3;
        f[i] = g * 0.25;
        allK.push(`k_${g}`);
        allX.push(g * 3);
        allF.push(g * 0.25);
      }
      cfMulti.add(crossfilter.rowsFromColumns({ k, x, f }));
    }
    // Second multi-batch instance with numericColumns["f"] primed via rawNumericState dimension("f")
    const cfMultiPrimed = crossfilter();
    for (let b = 0; b < 6; ++b) {
      cfMultiPrimed.add(crossfilter.rowsFromColumns({
        k: allK.slice(b * 25, (b + 1) * 25),
        x: Int32Array.from(allX.slice(b * 25, (b + 1) * 25)),
        f: Float64Array.from(allF.slice(b * 25, (b + 1) * 25)),
      }));
    }
    cfMultiPrimed.dimension("f");

    const indexOrders = [
      Array.from({ length: 150 }, (_, i) => i), // monotonic
      Array.from({ length: 150 }, (_, i) => 149 - i), // reversed
      [149, 0, 74, 25, 124, 50, 99, 1, 148, 33, 66, 111], // shuffled across batches
    ];
    for (const idxs of indexOrders) {
      for (const inst of [cfMulti, cfMultiPrimed]) {
        const out = inst.takeColumns(idxs, ["k", "x", "f"]);
        expect(out.columns.x).toBeInstanceOf(Int32Array);
        expect(out.columns.f).toBeInstanceOf(Float64Array);
        expect(out.columns.k).toEqual(idxs.map((i) => allK[i]));
        expect(Array.from(out.columns.x)).toEqual(idxs.map((i) => allX[i]));
        expect(Array.from(out.columns.f)).toEqual(idxs.map((i) => allF[i]));
      }
    }
  });

  it("forceReset skips large deltas safely for built-in groups while preserving exact callbacks for custom JS reducers", () => {
    const n = 200;
    const cat = Array.from({ length: n }, (_, i) => `c${i % 10}`);
    const grp = Array.from({ length: n }, (_, i) => `g${i % 4}`);
    const num = Float64Array.from({ length: n }, (_, i) => i);
    const val = Float64Array.from({ length: n }, (_, i) => (i % 7) + 1);

    // Part 1: Built-in only (triggers forceReset on >25% transitions for both lazyEncodedState and rawNumericState)
    const rt = crossfilter.createDashboardRuntime({
      columns: { cat, grp, num, val },
      dimensions: ["cat", "grp", "num"],
      kpis: [{ id: "rows", op: "count" }, { id: "sum", op: "sum", field: "val" }],
      groups: [
        { id: "byCat", field: "cat", metrics: [{ id: "rows", op: "count" }, { id: "sum", op: "sum", field: "val" }] },
        { id: "byGrp", field: "grp", metrics: [{ id: "rows", op: "count" }, { id: "sum", op: "sum", field: "val" }] },
      ],
    });
    const fullCat = rt.snapshot().groups.byCat;
    // Filter cat to 10% (90% masked -> forceReset=true); byCat MUST stay unaffected while byGrp & KPI reflect 10%
    rt.updateFilters({ cat: { type: "exact", value: "c0" } });
    let snap = rt.snapshot();
    expect(snap.groups.byCat).toEqual(fullCat);
    expect(snap.kpis.rows).toBe(20);
    // Switch cat from 10% to 70% (|70%-10%| = 60% > 25% -> forceReset=true)
    rt.updateFilters({ cat: { type: "in", values: ["c0", "c1", "c2", "c3", "c4", "c5", "c6"] } });
    expect(rt.snapshot().kpis.rows).toBe(140);
    // Clear cat (70% -> 100%, 30% > 25% -> forceReset=true)
    rt.updateFilters({});
    expect(rt.snapshot().kpis.rows).toBe(200);
    // rawNumericState range filter (>75% masked -> mid-loop bailout + forceReset=true) and clear!
    rt.updateFilters({ num: { type: "range", range: [0, 30] } });
    expect(rt.snapshot().kpis.rows).toBe(30);
    rt.updateFilters({ num: { type: "range", range: [10, 190] } });
    expect(rt.snapshot().kpis.rows).toBe(180);
    rt.updateFilters({});
    expect(rt.snapshot().kpis.rows).toBe(200);
    rt.dispose();

    // Part 2: Custom JS reducer MUST still receive exact incremental add/remove calls with noPrior === false
    const cf = crossfilter.fromColumns({ cat, grp, num, val });
    const dimCat = cf.dimension("cat");
    const dimNum = cf.dimension("num");
    const dimGrp = cf.dimension("grp");
    let customAdds = 0;
    let customRemoves = 0;
    const customGroup = dimGrp.group().reduce(
      (p, d, nf) => { if (!nf) customAdds += 1; return p + d.val; },
      (p, d, nf) => { if (!nf) customRemoves += 1; return p - d.val; },
      () => 0
    );
    const totalVal = val.reduce((a, b) => a + b, 0);
    expect(customGroup.all().reduce((s, e) => s + e.value, 0)).toBe(totalVal);

    // Filter 90% out via lazyEncodedState -> custom group must receive 180 removes!
    dimCat.filterExact("c0");
    expect(customRemoves).toBe(180);
    expect(customGroup.all().reduce((s, e) => s + e.value, 0)).toBe(
      val.reduce((s, v, i) => s + (cat[i] === "c0" ? v : 0), 0)
    );
    dimCat.filterAll();
    expect(customAdds).toBe(180);
    expect(customGroup.all().reduce((s, e) => s + e.value, 0)).toBe(totalVal);

    // Filter 85% out via rawNumericState -> custom group must receive 170 removes!
    customAdds = 0;
    customRemoves = 0;
    dimNum.filterRange([0, 30]);
    expect(customRemoves).toBe(170);
    expect(customGroup.all().reduce((s, e) => s + e.value, 0)).toBe(
      val.reduce((s, v, i) => s + (i < 30 ? v : 0), 0)
    );
    dimNum.filterAll();
    expect(customAdds).toBe(170);
    expect(customGroup.all().reduce((s, e) => s + e.value, 0)).toBe(totalVal);
  });

  it("promotes empty-initialized numeric dimensions and timeBucket groups to rawNumericState/rawBucketMode on first columnar add", () => {
    const day0 = Date.UTC(2025, 0, 1);
    const rt = crossfilter.createDashboardRuntime({
      records: [],
      dimensions: ["ts", "price"],
      kpis: [{ id: "rows", op: "count" }, { id: "sum", op: "sum", field: "price" }],
      groups: [{
        id: "byDay",
        field: "ts",
        bucket: { type: "timeBucket", granularity: "day" },
        metrics: [{ id: "rows", op: "count" }, { id: "sum", op: "sum", field: "price" }],
      }],
    });
    // Set a numeric range filter BEFORE batch 1 arrives
    rt.updateFilters({ price: { type: "range", range: [10, 50] } });

    // Stream 3 batches (exercises promotion on batch 0 + geometric growth on batches 1..2)
    for (let b = 0; b < 3; ++b) {
      const ts = new Float64Array(40);
      const price = new Float64Array(40);
      for (let i = 0; i < 40; ++i) {
        ts[i] = day0 + ((b * 40 + i) % 5) * 86400000 + i * 1000;
        price[i] = (b * 40 + i) % 60;
      }
      rt.appendColumns({ ts, price });
    }

    const snap = rt.snapshot();
    // 120 rows: prices 0..59 twice -> [10, 50) matches 40 * 2 = 80 rows
    expect(snap.kpis.rows).toBe(80);
    expect(snap.groups.byDay.length).toBe(5);
    expect(snap.groups.byDay.reduce((s, e) => s + e.value.rows, 0)).toBe(80);
    expect(rt.bounds({ fields: ["price"] }).price).toEqual({ min: 10, max: 49 });

    // Appending a NaN later still upgrades cleanly out of rawNumericState/rawBucketMode
    rt.appendColumns({ ts: new Float64Array([day0]), price: new Float64Array([NaN]) });
    rt.updateFilters({});
    expect(rt.snapshot().kpis.rows).toBe(121);
    rt.dispose();
  });

  it("zero-copy Float64Array borrowing never mutates caller buffers and lazy pure-numeric sorting handles +/-Infinity", () => {
    // 1. Finite Float64Array borrowed zero-copy, then extended via cf.add() -> caller buffer untouched
    const callerVals = new Float64Array([10, 20, 30]);
    const cf = crossfilter.fromColumns({ k: ["a", "b", "a"], v: callerVals });
    const rt = crossfilter.createDashboardRuntime({
      columns: { k: ["a", "b", "a"], v: callerVals },
      dimensions: ["k"],
      kpis: [{ id: "sum", op: "sum", field: "v" }],
    });
    expect(rt.snapshot().kpis.sum).toBe(60);
    rt.appendColumns({ k: ["c"], v: new Float64Array([40]) });
    expect(rt.snapshot().kpis.sum).toBe(100);
    expect(Array.from(callerVals)).toEqual([10, 20, 30]);
    rt.dispose();

    // 2. Float64Array containing Infinity -> caller buffer stays Infinity while metric treats it as NaN
    const infVals = new Float64Array([5, Infinity, -Infinity, 15]);
    const rtInf = crossfilter.createDashboardRuntime({
      columns: { k: ["a", "a", "b", "b"], v: infVals },
      dimensions: ["k"],
      kpis: [{ id: "sum", op: "sum", field: "v" }],
    });
    expect(rtInf.snapshot().kpis.sum).toBe(20);
    expect(infVals[1]).toBe(Infinity);
    expect(infVals[2]).toBe(-Infinity);
    rtInf.dispose();

    // 3. Lazy pure-numeric sorting with -Infinity, -10, 0, 10, Infinity (must not produce Infinity - Infinity = NaN!)
    const cfInf = crossfilter.fromColumns({ x: [Infinity, 10, -Infinity, 0, -10, Infinity, -Infinity] });
    const dimX = cfInf.dimension("x");
    const grpX = dimX.group().reduceCount();
    expect(grpX.all()).toEqual([
      { key: -Infinity, value: 2 },
      { key: -10, value: 1 },
      { key: 0, value: 1 },
      { key: 10, value: 1 },
      { key: Infinity, value: 2 },
    ]);
    expect(dimX.topIndex(3).map((i) => [Infinity, 10, -Infinity, 0, -10, Infinity, -Infinity][i])).toEqual([Infinity, Infinity, 10]);
    expect(dimX.bottomIndex(3).map((i) => [Infinity, 10, -Infinity, 0, -10, Infinity, -Infinity][i])).toEqual([-Infinity, -Infinity, -10]);
    cf.dispose && cf.dispose();
  });
});
