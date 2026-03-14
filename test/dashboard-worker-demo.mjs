const crossfilter = globalThis.crossfilter;

if (!crossfilter) {
  throw new Error('Expected `window.crossfilter` from ../crossfilter.js before loading the worker demo.');
}

const FIELDS = {
  country: 'semantic_events__dimensions_customer_country',
  event: 'semantic_events__event',
  region: 'semantic_events__location_region',
  time: 'semantic_events__timestamp_minute',
  latitude: 'semantic_events__location_latitude'
};

const FILTERS = {
  [FIELDS.country]: { type: 'in', values: ['Italy', 'Hungary', 'United States'] },
  [FIELDS.event]: { type: 'in', values: ['Harsh Cornering Alert Created', 'Speeding Alert Created', 'Stay Started'] },
  [FIELDS.region]: { type: 'in', values: ['Höfuðborgarsvæðið', 'Norðurland eystra', 'Austurland'] },
  [FIELDS.time]: { type: 'range', range: [1750163880000, 1760100660001] }
};

export async function runDashboardWorkerDemo(progress) {
  const timings = {};
  let t0 = performance.now();

  progress('Starting streaming dashboard worker...');
  t0 = performance.now();
  const runtime = await crossfilter.createStreamingDashboardWorker({
    arrowRuntimeUrl: '../node_modules/apache-arrow/Arrow.es2015.min.js',
    crossfilterUrl: '../crossfilter.js',
    dataUrl: './data/query-result.arrow',
    dimensions: [FIELDS.country, FIELDS.event, FIELDS.region, FIELDS.time],
    emitSnapshots: true,
    groups: [
      {
        field: FIELDS.event,
        id: 'events',
        metrics: [
          { id: 'rows', op: 'count' },
          { field: FIELDS.latitude, id: 'latSum', op: 'sum' }
        ]
      },
      {
        field: FIELDS.region,
        id: 'regions',
        metrics: [
          { id: 'rows', op: 'count' }
        ]
      }
    ],
    kpis: [
      { id: 'rows', op: 'count' },
      { field: FIELDS.time, id: 'timestampSum', op: 'sum' },
      { field: FIELDS.latitude, id: 'avgLatitudeNonZero', op: 'avgNonZero' }
    ],
    progressThrottleMs: 100,
    snapshotThrottleMs: 500,
    wasm: true
  });
  timings.initWorkerMs = performance.now() - t0;

  const progressEvents = [];
  const snapshotEvents = [];
  const unsubscribeProgress = runtime.on('progress', (payload) => {
    const fetchPercent = payload.fetch.percent == null
      ? 'unknown'
      : `${(payload.fetch.percent * 100).toFixed(1)}%`;

    progressEvents.push(payload);
    progress(
      `stream ${payload.status}: fetch=${fetchPercent} bytes=${payload.fetch.bytesLoaded}/${payload.fetch.totalBytes ?? '?'} rows=${payload.load.rowsLoaded} batches=${payload.load.batchesLoaded}`
    );
  });
  const unsubscribeSnapshot = runtime.on('snapshot', (payload) => {
    snapshotEvents.push({
      progress: payload.progress,
      rows: payload.snapshot.kpis.rows
    });
  });

  try {
    progress('Waiting for streamed data to finish loading...');
    t0 = performance.now();
    const ready = await runtime.ready;
    timings.readyMs = performance.now() - t0;

    progress('Reading initial snapshot in worker...');
    t0 = performance.now();
    const initial = await runtime.snapshot();
    timings.initialSnapshotMs = performance.now() - t0;

    progress('Applying dashboard filters in worker...');
    t0 = performance.now();
    const filtered = await runtime.snapshot(FILTERS);
    timings.filteredSnapshotMs = performance.now() - t0;

    progress('Collecting runtime info...');
    t0 = performance.now();
    const runtimeInfo = await runtime.runtimeInfo();
    timings.runtimeInfoMs = performance.now() - t0;

    return {
      filtered,
      initial,
      progressEvents,
      ready,
      runtimeInfo,
      snapshotEvents,
      timings,
      workerRuntime: runtime.workerRuntime
    };
  } finally {
    unsubscribeProgress();
    unsubscribeSnapshot();
    progress('Disposing worker runtime...');
    t0 = performance.now();
    await runtime.dispose();
    timings.disposeMs = performance.now() - t0;
  }
}
