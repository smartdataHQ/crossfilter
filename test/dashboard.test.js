import crossfilter from "../main.js";
import { describe, expect, it } from "vitest";

describe("dashboard runtime", () => {
  it("builds KPI and group snapshots from declarative specs", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country", "event", "time"],
      groups: [
        {
          field: "country",
          id: "countries",
          metrics: [
            { id: "rows", op: "count" },
            { field: "total", id: "sumTotal", op: "sum" }
          ]
        }
      ],
      kpis: [
        { id: "rows", op: "count" },
        { field: "total", id: "sumTotal", op: "sum" },
        { field: "latitude", id: "avgLat", op: "avgNonZero" }
      ],
      records: [
        { country: "IS", event: "stay", latitude: 64, time: 10, total: 10 },
        { country: "IS", event: "trip", latitude: 0, time: 20, total: 20 },
        { country: "UK", event: "stay", latitude: 51, time: 30, total: 30 },
        { country: "US", event: "alert", latitude: null, time: 40, total: 40 }
      ]
    });

    expect(runtime.snapshot()).toEqual({
      groups: {
        countries: [
          { key: "IS", value: { rows: 2, sumTotal: 30 } },
          { key: "UK", value: { rows: 1, sumTotal: 30 } },
          { key: "US", value: { rows: 1, sumTotal: 40 } }
        ]
      },
      kpis: {
        avgLat: 57.5,
        rows: 4,
        sumTotal: 100
      },
      runtime: crossfilter.runtimeInfo()
    });

    expect(runtime.snapshot({
      country: { type: "in", values: ["IS", "UK"] },
      event: { type: "exact", value: "stay" },
      time: { type: "range", range: [0, 31] }
    })).toEqual({
      groups: {
        countries: [
          { key: "IS", value: { rows: 1, sumTotal: 10 } },
          { key: "UK", value: { rows: 1, sumTotal: 30 } },
          { key: "US", value: { rows: 0, sumTotal: 0 } }
        ]
      },
      kpis: {
        avgLat: 57.5,
        rows: 2,
        sumTotal: 40
      },
      runtime: crossfilter.runtimeInfo()
    });

    runtime.reset();
    runtime.dispose();
  });

  it("reuses the current filter state across snapshots and rejects unknown dimensions", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country"],
      kpis: [{ id: "rows", op: "count" }],
      records: [
        { country: "IS" },
        { country: "UK" }
      ]
    });

    runtime.updateFilters({
      country: { type: "exact", value: "IS" }
    });

    expect(runtime.snapshot().kpis.rows).toBe(1);
    expect(() => runtime.updateFilters({
      missing: { type: "exact", value: "IS" }
    })).toThrow("Unknown dashboard filter dimension");

    runtime.dispose();
  });

  it("supports appending rows after runtime creation", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country"],
      groups: [{ field: "country", id: "countries", metrics: [{ id: "rows", op: "count" }] }],
      kpis: [{ id: "rows", op: "count" }]
    });

    expect(runtime.size()).toBe(0);
    expect(runtime.append([{ country: "IS" }, { country: "UK" }])).toBe(2);
    expect(runtime.snapshot().kpis.rows).toBe(2);
    expect(runtime.snapshot().groups.countries).toEqual([
      { key: "IS", value: { rows: 1 } },
      { key: "UK", value: { rows: 1 } }
    ]);

    runtime.dispose();
  });

  it("supports removing currently excluded rows without rebuilding the runtime", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country"],
      groups: [{ field: "country", id: "countries", metrics: [{ id: "rows", op: "count" }] }],
      kpis: [{ id: "rows", op: "count" }],
      records: [
        { country: "IS" },
        { country: "UK" },
        { country: "US" }
      ]
    });

    runtime.updateFilters({ country: { type: "in", values: ["IS", "UK"] } });
    expect(runtime.removeFiltered("excluded")).toBe(2);
    expect(runtime.snapshot().kpis.rows).toBe(2);
    expect(runtime.snapshot().groups.countries).toEqual([
      { key: "IS", value: { rows: 1 } },
      { key: "UK", value: { rows: 1 } }
    ]);

    runtime.dispose();
  });

  it("builds dashboard runtimes directly from columns and appends columnar Arrow batches", () => {
    const runtime = crossfilter.createDashboardRuntime({
      columnarOptions: {
        fields: ["country", "total"],
        length: 1,
      },
      columns: {
        country: ["IS"],
        total: [10],
      },
      dimensions: ["country"],
      groups: [{ field: "country", id: "countries", metrics: [{ id: "rows", op: "count" }] }],
      kpis: [{ id: "rows", op: "count" }],
    });

    expect(runtime.size()).toBe(1);
    expect(runtime.appendColumns({ country: ["UK"], total: [20] }, {
      fields: ["country", "total"],
      length: 1,
    })).toBe(2);
    expect(runtime.appendArrowTable({
      getChild(name) {
        return name === "country" ? ["US"] : name === "total" ? [30] : undefined;
      },
      numRows: 1,
      schema: {
        fields: [{ name: "country" }, { name: "total" }],
      },
    })).toBe(3);
    expect(runtime.snapshot()).toEqual({
      groups: {
        countries: [
          { key: "IS", value: { rows: 1 } },
          { key: "UK", value: { rows: 1 } },
          { key: "US", value: { rows: 1 } },
        ],
      },
      kpis: {
        rows: 3,
      },
      runtime: crossfilter.runtimeInfo(),
    });

    runtime.dispose();
  });

  it("merges appended columnar batches with stable mixed-value group ordering", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["region"],
      groups: [{ field: "region", id: "regions", metrics: [{ id: "rows", op: "count" }] }],
      kpis: [{ id: "rows", op: "count" }],
      wasm: true
    });

    runtime.append(crossfilter.rowsFromColumns({ region: [null, "B", "A"] }));
    runtime.append(crossfilter.rowsFromColumns({ region: ["A", null, "B"] }));

    expect(runtime.snapshot().groups.regions).toEqual([
      { key: null, value: { rows: 2 } },
      { key: "A", value: { rows: 2 } },
      { key: "B", value: { rows: 2 } }
    ]);

    runtime.updateFilters({ region: { type: "exact", value: null } });
    expect(runtime.snapshot().kpis.rows).toBe(2);

    runtime.dispose();
  });

  it("supports declarative time-bucket groups and worker-friendly row queries", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country", "time"],
      groups: [
        {
          bucket: { type: "timeBucket", granularity: "day" },
          field: "time",
          id: "days",
          metrics: [{ id: "rows", op: "count" }]
        }
      ],
      kpis: [{ id: "rows", op: "count" }],
      records: [
        { country: "IS", time: Date.UTC(2026, 0, 1, 10) },
        { country: "UK", time: Date.UTC(2026, 0, 1, 12) },
        { country: "US", time: Date.UTC(2026, 0, 2, 9) }
      ]
    });

    expect(runtime.snapshot().groups.days).toEqual([
      { key: Date.UTC(2026, 0, 1), value: { rows: 2 } },
      { key: Date.UTC(2026, 0, 2), value: { rows: 1 } }
    ]);

    expect(runtime.rows({
      fields: ["country", "time"],
      limit: 2,
      sortBy: "time"
    })).toEqual([
      { country: "US", time: Date.UTC(2026, 0, 2, 9) },
      { country: "UK", time: Date.UTC(2026, 0, 1, 12) }
    ]);

    expect(runtime.query({
      filters: { country: { type: "exact", value: "IS" } },
      rows: {
        direction: "bottom",
        fields: ["country", "time"],
        limit: 1,
        sortBy: "time"
      }
    })).toEqual({
      rows: [
        { country: "IS", time: Date.UTC(2026, 0, 1, 10) }
      ],
      snapshot: {
        groups: {
          days: [
            { key: Date.UTC(2026, 0, 1), value: { rows: 1 } },
            { key: Date.UTC(2026, 0, 2), value: { rows: 0 } }
          ]
        },
        kpis: { rows: 1 },
        runtime: crossfilter.runtimeInfo()
      }
    });

    runtime.dispose();
  });

  it("validates worker source options before attempting to spawn a worker", () => {
    function createStubWorker() {
      return {
        addEventListener() {},
        postMessage() {},
        terminate() {}
      };
    }

    expect(() => crossfilter.createDashboardWorker({
      arrowBuffer: new Uint8Array([1, 2, 3]),
      dataUrl: "/query.arrow"
    })).toThrow("exactly one of `arrowBuffer` or `dataUrl`");

    expect(() => crossfilter.createStreamingDashboardWorker({
      arrowBuffer: new Uint8Array([1, 2, 3]),
      dataUrl: "/query.arrow"
    })).toThrow("exactly one of `arrowBuffer`, `dataUrl` or `sources`");

    expect(() => crossfilter.createStreamingDashboardWorker({
      sources: [
        { dataUrl: "/primary.arrow", id: "primary", role: "lookup", lookup: { keyFields: ["country"], valueFields: ["region"] } },
        { dataUrl: "/detail.arrow", id: "detail", role: "lookup", lookup: { keyFields: ["country"], valueFields: ["region"] } },
      ],
      workerFactory: createStubWorker,
    })).toThrow("exactly one base source");

    expect(() => crossfilter.createStreamingDashboardWorker({
      sources: [
        { dataUrl: "/primary.arrow", id: "primary", role: "base" },
        { dataUrl: "/detail.arrow", id: "detail", role: "lookup" },
      ],
      workerFactory: createStubWorker,
    })).toThrow("requires non-empty `lookup.keyFields` and `lookup.valueFields`");
  });
});
