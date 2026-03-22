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

  it("keeps columnar dashboard metric reducers correct across filters and appends", () => {
    const runtime = crossfilter.createDashboardRuntime({
      columnarOptions: {
        fields: ["country", "latitude", "total"],
        length: 3,
      },
      columns: {
        country: ["IS", "UK", "IS"],
        latitude: new Float64Array([64, 51, 0]),
        total: new Float64Array([10, 20, 30]),
      },
      dimensions: ["country"],
      groups: [{
        field: "country",
        id: "countries",
        metrics: [
          { id: "rows", op: "count" },
          { field: "total", id: "sumTotal", op: "sum" },
          { field: "latitude", id: "avgLat", op: "avgNonZero" }
        ]
      }],
      kpis: [
        { id: "rows", op: "count" },
        { field: "total", id: "sumTotal", op: "sum" },
        { field: "latitude", id: "avgLat", op: "avgNonZero" }
      ],
    });

    expect(runtime.snapshot()).toEqual({
      groups: {
        countries: [
          { key: "IS", value: { rows: 2, sumTotal: 40, avgLat: 64 } },
          { key: "UK", value: { rows: 1, sumTotal: 20, avgLat: 51 } },
        ],
      },
      kpis: {
        rows: 3,
        sumTotal: 60,
        avgLat: 57.5
      },
      runtime: crossfilter.runtimeInfo(),
    });

    runtime.updateFilters({
      country: { type: "exact", value: "IS" }
    });

    expect(runtime.snapshot()).toEqual({
      groups: {
        countries: [
          { key: "IS", value: { rows: 2, sumTotal: 40, avgLat: 64 } },
          { key: "UK", value: { rows: 1, sumTotal: 20, avgLat: 51 } },
        ],
      },
      kpis: {
        rows: 2,
        sumTotal: 40,
        avgLat: 64
      },
      runtime: crossfilter.runtimeInfo(),
    });

    expect(runtime.appendColumns({
      country: ["US"],
      latitude: new Float64Array([35]),
      total: new Float64Array([40]),
    }, {
      fields: ["country", "latitude", "total"],
      length: 1,
    })).toBe(4);

    runtime.reset();

    expect(runtime.snapshot()).toEqual({
      groups: {
        countries: [
          { key: "IS", value: { rows: 2, sumTotal: 40, avgLat: 64 } },
          { key: "UK", value: { rows: 1, sumTotal: 20, avgLat: 51 } },
          { key: "US", value: { rows: 1, sumTotal: 40, avgLat: 35 } },
        ],
      },
      kpis: {
        rows: 4,
        sumTotal: 100,
        avgLat: 50
      },
      runtime: crossfilter.runtimeInfo(),
    });

    runtime.dispose();
  });

  it("supports sum-only dashboard metrics for KPI and grouped reads", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country"],
      groups: [{
        field: "country",
        id: "countries",
        metrics: [{ field: "total", id: "count", op: "sum" }]
      }],
      kpis: [{ field: "total", id: "count", op: "sum" }],
      records: [
        { country: "IS", total: 10 },
        { country: "IS", total: 30 },
        { country: "UK", total: 20 },
        { country: "US", total: 0 }
      ]
    });

    expect(runtime.snapshot()).toEqual({
      groups: {
        countries: [
          { key: "IS", value: { count: 40 } },
          { key: "UK", value: { count: 20 } },
          { key: "US", value: { count: 0 } }
        ]
      },
      kpis: {
        count: 60
      },
      runtime: crossfilter.runtimeInfo()
    });

    expect(runtime.groups({
      groups: {
        countries: {
          includeTotals: true,
          limit: 2,
          nonEmptyKeys: true,
          sort: "desc",
          sortMetric: "count"
        }
      }
    })).toEqual({
      countries: {
        entries: [
          { key: "IS", value: { count: 40 } },
          { key: "UK", value: { count: 20 } }
        ],
        limit: 2,
        offset: 0,
        sort: "desc",
        sortMetric: "count",
        total: 2
      }
    });

    runtime.updateFilters({
      country: { type: "exact", value: "IS" }
    });

    expect(runtime.snapshot().kpis.count).toBe(40);

    runtime.dispose();
  });

  it("returns filtered row counts alongside shaped queries when requested", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country"],
      kpis: [{ field: "total", id: "count", op: "sum" }],
      records: [
        { country: "IS", total: 10 },
        { country: "IS", total: 30 },
        { country: "UK", total: 20 }
      ]
    });

    expect(runtime.query({
      filters: { country: { type: "exact", value: "IS" } },
      rowCount: true,
      snapshot: false
    })).toEqual({
      rowCount: 2,
      rows: [],
      snapshot: null
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

    expect(runtime.rows({
      columnar: true,
      fields: ["country", "time"],
      limit: 2,
      sortBy: "time"
    })).toEqual({
      columns: {
        country: ["US", "UK"],
        time: [Date.UTC(2026, 0, 2, 9), Date.UTC(2026, 0, 1, 12)]
      },
      fields: ["country", "time"],
      length: 2
    });

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

    expect(runtime.query({
      filters: { country: { type: "exact", value: "IS" } },
      rows: {
        columnar: true,
        direction: "bottom",
        fields: ["country", "time"],
        limit: 1,
        sortBy: "time"
      }
    })).toEqual({
      rows: {
        columns: {
          country: ["IS"],
          time: [Date.UTC(2026, 0, 1, 10)]
        },
        fields: ["country", "time"],
        length: 1
      },
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

  it("supports additive bounds and batched row-set queries", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country", "time", "total"],
      kpis: [{ id: "rows", op: "count" }],
      records: [
        { country: "IS", time: 10, total: 100 },
        { country: "UK", time: 20, total: 200 },
        { country: "US", time: 30, total: 300 },
        { country: "ZA", time: 40, total: 400 }
      ]
    });

    expect(runtime.bounds({ fields: ["time", "total"] })).toEqual({
      time: { min: 10, max: 40 },
      total: { min: 100, max: 400 }
    });

    expect(runtime.rowSets({
      latest: {
        columnar: true,
        fields: ["country", "time"],
        limit: 1,
        sortBy: "time"
      },
      oldest: {
        columnar: true,
        direction: "bottom",
        fields: ["country", "time"],
        limit: 1,
        sortBy: "time"
      }
    })).toEqual({
      latest: {
        columns: {
          country: ["ZA"],
          time: [40]
        },
        fields: ["country", "time"],
        length: 1
      },
      oldest: {
        columns: {
          country: ["IS"],
          time: [10]
        },
        fields: ["country", "time"],
        length: 1
      }
    });

    expect(runtime.query({
      bounds: { fields: ["time"] },
      filters: { country: { type: "in", values: ["IS", "UK"] } },
      rowSets: {
        oldest: {
          fields: ["country", "time"],
          limit: 1,
          sortBy: "time",
          direction: "bottom"
        }
      },
      snapshot: false
    })).toEqual({
      bounds: {
        time: { min: 10, max: 20 }
      },
      rowSets: {
        oldest: [
          { country: "IS", time: 10 }
        ]
      },
      rows: [],
      snapshot: null
    });

    runtime.dispose();
  });

  it("supports additive shaped group queries without changing legacy snapshots", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country"],
      groups: [{ field: "country", id: "countries", metrics: [{ id: "rows", op: "count" }] }],
      kpis: [{ id: "rows", op: "count" }],
      records: [
        { country: "IS" },
        { country: "IS" },
        { country: "UK" },
        { country: "US" },
        { country: "ZA" }
      ]
    });

    expect(runtime.snapshot().groups.countries).toEqual([
      { key: "IS", value: { rows: 2 } },
      { key: "UK", value: { rows: 1 } },
      { key: "US", value: { rows: 1 } },
      { key: "ZA", value: { rows: 1 } }
    ]);

    expect(runtime.snapshot(null, {
      groups: {
        countries: {
          includeTotals: true,
          limit: 2,
          nonEmptyKeys: true,
          sort: "desc",
          sortMetric: "rows"
        }
      }
    })).toEqual({
      groups: {
        countries: {
          entries: [
            { key: "IS", value: { rows: 2 } },
            { key: "UK", value: { rows: 1 } }
          ],
          limit: 2,
          offset: 0,
          sort: "desc",
          sortMetric: "rows",
          total: 4
        }
      },
      kpis: { rows: 5 },
      runtime: crossfilter.runtimeInfo()
    });

    expect(runtime.groups({
      groups: {
        countries: {
          includeKeys: ["ZA"],
          includeTotals: true,
          limit: 1,
          search: "i",
          sort: "desc",
          sortMetric: "rows"
        }
      }
    })).toEqual({
      countries: {
        entries: [
          { key: "IS", value: { rows: 2 } },
          { key: "ZA", value: { rows: 1 } }
        ],
        limit: 1,
        offset: 0,
        sort: "desc",
        sortMetric: "rows",
        total: 1
      }
    });

    expect(runtime.query({
      groups: {
        countries: {
          includeTotals: true,
          limit: 1,
          sort: "desc",
          sortMetric: "rows"
        }
      },
      snapshot: { groups: false }
    })).toEqual({
      groups: {
        countries: {
          entries: [{ key: "IS", value: { rows: 2 } }],
          limit: 1,
          offset: 0,
          sort: "desc",
          sortMetric: "rows",
          total: 4
        }
      },
      rows: [],
      snapshot: {
        groups: {},
        kpis: { rows: 5 },
        runtime: crossfilter.runtimeInfo()
      }
    });

    runtime.dispose();
  });

  it("keeps limited shaped group queries correct with offsets and forced keys", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country"],
      groups: [{ field: "country", id: "countries", metrics: [{ id: "rows", op: "count" }] }],
      records: [
        { country: "A" },
        { country: "A" },
        { country: "A" },
        { country: "A" },
        { country: "A" },
        { country: "B" },
        { country: "B" },
        { country: "B" },
        { country: "B" },
        { country: "C" },
        { country: "C" },
        { country: "C" },
        { country: "D" },
        { country: "D" },
        { country: "E" }
      ]
    });

    expect(runtime.groups({
      groups: {
        countries: {
          includeKeys: ["E"],
          includeTotals: true,
          limit: 2,
          offset: 1,
          sort: "desc",
          sortMetric: "rows"
        }
      }
    })).toEqual({
      countries: {
        entries: [
          { key: "B", value: { rows: 4 } },
          { key: "C", value: { rows: 3 } },
          { key: "E", value: { rows: 1 } }
        ],
        limit: 2,
        offset: 1,
        sort: "desc",
        sortMetric: "rows",
        total: 5
      }
    });

    runtime.dispose();
  });

  it("keeps descending limited group queries exact across tied metrics without totals", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country"],
      groups: [{ field: "country", id: "countries", metrics: [{ id: "rows", op: "count" }] }],
      records: [
        { country: "A" },
        { country: "A" },
        { country: "B" },
        { country: "B" },
        { country: "C" },
        { country: "C" },
        { country: "D" }
      ]
    });

    expect(runtime.groups({
      groups: {
        countries: {
          includeTotals: false,
          limit: 1,
          offset: 1,
          sort: "desc",
          sortMetric: "rows"
        }
      }
    })).toEqual({
      countries: {
        entries: [
          { key: "B", value: { rows: 2 } }
        ],
        limit: 1,
        offset: 1,
        sort: "desc",
        sortMetric: "rows"
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

  it("supports dynamic groups in the non-streaming worker runtime", async () => {
    function createStubWorker() {
      const listeners = {
        error: new Set(),
        message: new Set(),
      };

      function emit(type, event) {
        listeners[type].forEach((listener) => {
          listener(event);
        });
      }

      return {
        addEventListener(type, listener) {
          listeners[type].add(listener);
        },
        postMessage(message) {
          queueMicrotask(() => {
            switch (message.type) {
              case "init":
                emit("message", {
                  data: {
                    id: message.id,
                    ok: true,
                    payload: {
                      runtime: {
                        active: "js",
                        lastError: null,
                        wasmEnabled: true,
                        wasmSupported: true,
                      },
                    },
                  },
                });
                return;
              case "createGroup":
                emit("message", {
                  data: {
                    id: message.id,
                    ok: true,
                    payload: "countries",
                  },
                });
                return;
              case "dispose":
              case "disposeGroup":
                emit("message", {
                  data: {
                    id: message.id,
                    ok: true,
                    payload: null,
                  },
                });
                return;
              default:
                emit("message", {
                  data: {
                    id: message.id,
                    ok: true,
                    payload: undefined,
                  },
                });
            }
          });
        },
        terminate() {},
      };
    }

    const runtime = await crossfilter.createDashboardWorker({
      arrowBuffer: new Uint8Array([1, 2, 3]),
      workerFactory: createStubWorker,
    });

    await expect(runtime.createGroup({
      field: "country",
      id: "countries",
      metrics: [{ id: "rows", op: "count" }],
    })).resolves.toBe("countries");
    await expect(runtime.disposeGroup("countries")).resolves.toBeNull();

    await runtime.dispose();
  });

  it("splitField produces nested aggregates keyed by split dimension", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["date", "store", "product"],
      groups: [
        {
          field: "date",
          id: "byDate",
          splitField: "store",
          metrics: [
            { id: "events", field: "qty", op: "sum" },
            { id: "rows", op: "count" },
          ],
        },
      ],
      records: [
        { date: "2026-01-01", store: "A", product: "X", qty: 10 },
        { date: "2026-01-01", store: "A", product: "Y", qty: 5 },
        { date: "2026-01-01", store: "B", product: "X", qty: 7 },
        { date: "2026-01-02", store: "A", product: "X", qty: 3 },
        { date: "2026-01-02", store: "B", product: "X", qty: 8 },
      ],
    });

    const snapshot = runtime.snapshot();
    const entries = snapshot.groups.byDate;

    expect(entries).toHaveLength(2);

    const day1 = entries.find(e => e.key === "2026-01-01");
    expect(day1.value).toEqual({
      A: { events: 15, rows: 2 },
      B: { events: 7, rows: 1 },
    });

    const day2 = entries.find(e => e.key === "2026-01-02");
    expect(day2.value).toEqual({
      A: { events: 3, rows: 1 },
      B: { events: 8, rows: 1 },
    });
  });

  it("splitField excludes empty buckets after filtering", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["date", "store", "product"],
      groups: [
        {
          field: "date",
          id: "byDate",
          splitField: "store",
          metrics: [{ id: "events", field: "qty", op: "sum" }],
        },
      ],
      records: [
        { date: "2026-01-01", store: "A", product: "X", qty: 10 },
        { date: "2026-01-01", store: "B", product: "Y", qty: 7 },
        { date: "2026-01-01", store: "C", product: "X", qty: 3 },
      ],
    });

    // Filter to product X — store B should disappear (has no X)
    runtime.updateFilters({ product: { type: "in", values: ["X"] } });

    const entries = runtime.snapshot().groups.byDate;
    const day1 = entries.find(e => e.key === "2026-01-01");

    expect(day1.value).toEqual({
      A: { events: 10 },
      C: { events: 3 },
    });
    expect(day1.value).not.toHaveProperty("B");
  });

  it("isolatedFilters temporarily overrides filters and restores them", () => {
    const runtime = crossfilter.createDashboardRuntime({
      dimensions: ["country", "event"],
      groups: [
        {
          field: "country",
          id: "countries",
          metrics: [{ id: "rows", op: "count" }],
        },
      ],
      kpis: [{ id: "rows", op: "count" }],
      records: [
        { country: "IS", event: "stay" },
        { country: "IS", event: "trip" },
        { country: "UK", event: "stay" },
        { country: "US", event: "alert" },
      ],
    });

    // Set a persistent filter
    runtime.updateFilters({ country: { type: "in", values: ["IS"] } });
    expect(runtime.snapshot().kpis.rows).toBe(2);

    // Query with isolated filters — different filter, should not persist
    const result = runtime.query({
      isolatedFilters: { event: { type: "in", values: ["stay"] } },
      snapshot: {},
    });

    // Isolated query sees stay events across all countries
    expect(result.snapshot.kpis.rows).toBe(2); // IS+UK stay

    // Original filter should be restored — KPI reflects country=IS
    const afterSnap = runtime.snapshot();
    expect(afterSnap.kpis.rows).toBe(2);

    // Double-check: a fresh query without isolatedFilters should also see IS-only
    const freshResult = runtime.query({ snapshot: {} });
    expect(freshResult.snapshot.kpis.rows).toBe(2);
  });
});
