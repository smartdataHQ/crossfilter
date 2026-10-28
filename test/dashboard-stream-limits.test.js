import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as Arrow from "apache-arrow";
import crossfilter from "../main.js";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/dashboard-stream-worker.js", import.meta.url), "utf8");
const factory = source.slice(source.indexOf("function createWorkerSource("), source.indexOf("export function createStreamingDashboardWorker("));
const workerSource = runInNewContext(factory + '; createWorkerSource("crossfilter", "arrow");');
const bytes = Arrow.tableToIPC(Arrow.tableFromArrays({ country: ["IS", "UK"], count: [2, 3] }), "stream");

async function execute(options, fetchImpl) {
  let finish;
  const terminal = new Promise(resolve => { finish = resolve; });
  const self = {
    Arrow,
    crossfilter,
    postMessage(message) {
      if (message.eventType === "ready" || message.eventType === "error") finish(message);
    }
  };
  runInNewContext(workerSource, { self, importScripts() {}, fetch: fetchImpl, AbortController, setTimeout, clearTimeout });
  await self.onmessage({ data: { id: 1, type: "initStreaming", payload: {
    arrowBuffer: bytes,
    dimensions: ["country"],
    groups: [],
    kpis: [],
    ...options
  } } });
  return terminal;
}

describe("streaming input budgets", () => {
  it("preserves structured HTTP errors in the worker error event", async () => {
    const result = await execute({ arrowBuffer: null, dataUrl: "https://example.test/data" }, async () =>
      Response.json({ error: "revision changed", code: "revision_changed" }, { status: 409 })
    );
    expect(result.eventType).toBe("error");
    expect(result.payload.status).toBe(409);
    expect(result.payload.code).toBe("revision_changed");
    expect(result.payload.message).toContain("revision changed");
  });

  it("validates optional limits before spawning", () => {
    for (const key of ["maxRows", "maxBytes"]) {
      for (const value of [0, -1, 1.5, Infinity, "2"]) {
        expect(() => crossfilter.createStreamingDashboardWorker({ arrowBuffer: bytes, [key]: value }))
          .toThrow("positive safe integer");
      }
    }
  });

  it("accepts exact limits and rejects overflowing buffers or batches", async () => {
    expect((await execute({})).eventType).toBe("ready");
    expect((await execute({ maxRows: 2, maxBytes: bytes.byteLength })).eventType).toBe("ready");
    const rowsError = (await execute({ maxRows: 1 })).payload;
    expect(rowsError.message).toContain("rows budget exceeded");
    expect(rowsError.code).toBe("dashboard_input_rows_exceeded");
    expect(rowsError.status).toBe(413);
    const bytesError = (await execute({ maxBytes: bytes.byteLength - 1 })).payload;
    expect(bytesError.message).toContain("bytes budget exceeded");
    expect(bytesError.code).toBe("dashboard_input_bytes_exceeded");
    expect(bytesError.status).toBe(413);
  });

  it("cancels an over-budget stream and aborts its fetch", async () => {
    let cancelled = false;
    let signal;
    const result = await execute({ arrowBuffer: null, dataUrl: "https://example.test/data", maxBytes: 1 }, async (_url, init) => {
      signal = init.signal;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(bytes); },
        cancel() { cancelled = true; }
      }));
    });
    expect(result.eventType).toBe("error");
    expect(result.payload.message).toContain("bytes budget exceeded");
    expect(cancelled).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("shares the row budget across base and lookup sources", async () => {
    const result = await execute({ arrowBuffer: null, maxRows: 3, sources: [
      { id: "base", role: "base", arrowBuffer: bytes },
      { id: "lookup", role: "lookup", arrowBuffer: bytes, lookup: { keyFields: ["country"], valueFields: ["count"] } }
    ] });
    expect(result.eventType).toBe("error");
    expect(result.payload.message).toContain("rows budget exceeded (4 > 3)");
  });

  it("does not allocate an unbounded response buffer when streaming is unavailable", async () => {
    let buffered = false;
    const result = await execute({ arrowBuffer: null, dataUrl: "https://example.test/data", maxBytes: 100 }, async () => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer() { buffered = true; return bytes.buffer; }
    }));
    expect(result.payload.message).toContain("requires a readable response body");
    expect(buffered).toBe(false);
  });
});
