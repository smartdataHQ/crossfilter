import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as Arrow from "apache-arrow";
import crossfilter from "../main.js";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/dashboard-stream-worker.js", import.meta.url), "utf8");
const factory = source.slice(source.indexOf("function createWorkerSource("), source.indexOf("export function createStreamingDashboardWorker("));
const workerSource = runInNewContext(factory + '; createWorkerSource("crossfilter.js", "arrow.js");');
const bytes = Arrow.tableToIPC(Arrow.tableFromArrays({ country: ["IS", "UK"], count: [2, 3] }), "stream");

// A worker scope with no libraries until importScripts runs, as in a browser.
function createWorker(fetchImpl, importImpl) {
  const calls = [];
  const events = [];
  const waiters = [];
  const self = {
    postMessage(message) {
      if (message.eventType !== "ready" && message.eventType !== "error") return;
      events.push(message);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
    }
  };
  runInNewContext(workerSource, {
    self,
    importScripts(...urls) {
      calls.push(["importScripts", ...urls]);
      if (importImpl) importImpl();
      self.Arrow = Arrow;
      self.crossfilter = crossfilter;
    },
    fetch(url, init) {
      calls.push(["fetch", url]);
      return fetchImpl(url, init);
    },
    AbortController,
    setTimeout,
    clearTimeout
  });
  return {
    calls,
    async init(payload) {
      const terminal = new Promise(resolve => { waiters.push(resolve); });
      await self.onmessage({ data: { id: 1, type: "initStreaming", payload: { dimensions: ["country"], groups: [], kpis: [], ...payload } } });
      return terminal;
    }
  };
}

describe("streaming worker start", () => {
  it("requests the data before it imports the libraries", async () => {
    const worker = createWorker(async () => new Response(bytes));
    const result = await worker.init({ dataUrl: "https://example.test/data" });
    expect(result.eventType).toBe("ready");
    expect(worker.calls).toEqual([
      ["fetch", "https://example.test/data"],
      ["importScripts", "crossfilter.js", "arrow.js"]
    ]);
  });

  it("imports the libraries for a buffer source too, and only once per worker", async () => {
    const worker = createWorker(async () => new Response(bytes));
    expect((await worker.init({ arrowBuffer: bytes })).eventType).toBe("ready");
    expect((await worker.init({ dataUrl: "https://example.test/second" })).eventType).toBe("ready");
    expect(worker.calls).toEqual([
      ["importScripts", "crossfilter.js", "arrow.js"],
      ["fetch", "https://example.test/second"]
    ]);
  });

  it("asks again on a second start instead of reusing the first input", async () => {
    const worker = createWorker(async () => new Response(bytes));
    expect((await worker.init({ dataUrl: "https://example.test/data" })).eventType).toBe("ready");
    expect((await worker.init({ dataUrl: "https://example.test/data" })).eventType).toBe("ready");
    expect(worker.calls.filter(call => call[0] === "fetch")).toHaveLength(2);
  });

  it("reports a library that fails to load and aborts the request it had issued", async () => {
    let signal;
    const worker = createWorker(
      (_url, init) => { signal = init.signal; return new Promise(() => {}); },
      () => { throw new Error("script failed to load"); }
    );
    const result = await worker.init({ dataUrl: "https://example.test/data" });
    expect(result.eventType).toBe("error");
    expect(result.payload.message).toContain("script failed to load");
    expect(signal.aborted).toBe(true);
  });

  it("reports a failed request that settled before the libraries loaded", async () => {
    const worker = createWorker(async () => Response.json({ error: "gone", code: "gone" }, { status: 410 }));
    const result = await worker.init({ dataUrl: "https://example.test/data" });
    expect(result.eventType).toBe("error");
    expect(result.payload.status).toBe(410);
    expect(result.payload.code).toBe("gone");
  });
});
