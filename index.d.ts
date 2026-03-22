export = crossfilter;

declare function crossfilter<T>(records?: T[]): crossfilter.Crossfilter<T>;

declare namespace crossfilter {
  export type ComparableValue = string | number | boolean;

  export interface ComparableObject {
    valueOf(): ComparableValue;
  }

  export type NaturallyOrderedValue = ComparableValue | ComparableObject;

  export type Predicate<T> = (record: T) => boolean;

  export type TSelectorValue = NaturallyOrderedValue | NaturallyOrderedValue[];
  export type OrderedValueSelector<TRecord, TValue extends TSelectorValue = NaturallyOrderedValue> = (
    record: TRecord,
  ) => TValue;

  export type FilterValue =
    | NaturallyOrderedValue
    | [NaturallyOrderedValue, NaturallyOrderedValue]
    | Predicate<NaturallyOrderedValue>;

  export type ColumnSource<TValue = unknown> =
    | ArrayLike<TValue>
    | {
        at?(index: number): TValue;
        get?(index: number): TValue;
        length?: number;
        size?: number;
        [index: number]: TValue;
      };

  export interface ColumnarOptions<TRecord> {
    fields?: string[];
    length?: number;
    rowFactory?: (
      index: number,
      columns: Record<string, ColumnSource>,
      fields: string[],
    ) => TRecord;
    transforms?: Record<string, (value: unknown, index: number) => unknown>;
  }

  export interface ArrowFieldLike {
    name: string;
  }

  export interface ArrowTableLike {
    columnNames?: string[];
    getChild?(name: string): ColumnSource | undefined;
    getChildAt?(index: number): ColumnSource | undefined;
    getColumn?(name: string): ColumnSource | undefined;
    numRows?: number;
    schema?: {
      fields?: ArrowFieldLike[];
    };
    [key: string]: unknown;
  }

  export interface RuntimeOptions {
    wasm?: boolean;
  }

  export interface RuntimeInfo {
    active: 'js' | 'wasm';
    lastError: string | null;
    wasmEnabled: boolean;
    wasmSupported: boolean;
  }

  export interface DashboardMetricSpec {
    field?: string;
    id?: string;
    op: 'count' | 'sum' | 'avg' | 'avgNonZero';
  }

  export type DashboardTimeBucketGranularity = 'minute' | 'hour' | 'day' | 'week' | 'month';

  export interface DashboardGroupBucketSpec {
    granularity?: DashboardTimeBucketGranularity;
    type: 'timeBucket';
  }

  export interface DashboardGroupSpec {
    bucket?: DashboardGroupBucketSpec;
    field: string;
    id?: string;
    metrics?: DashboardMetricSpec[];
  }

  export type DashboardFilter =
    | { type: 'all' }
    | { type: 'exact'; value: NaturallyOrderedValue }
    | { type: 'in'; values: NaturallyOrderedValue[] }
    | { type: 'range'; range: [NaturallyOrderedValue, NaturallyOrderedValue] };

  export type DashboardFilterState = Record<string, DashboardFilter | null | undefined>;

  export type DashboardRowDirection = 'top' | 'bottom';
  export type DashboardRemoveSelection = 'included' | 'excluded';

  export interface DashboardRowQuery {
    direction?: DashboardRowDirection;
    fields?: string[];
    limit?: number;
    offset?: number;
    sortBy?: string;
  }

  export interface DashboardQueryRequest {
    filters?: DashboardFilterState | null;
    rows?: DashboardRowQuery | null;
  }

  export interface DashboardSnapshot {
    groups: Record<
      string,
      Array<{
        key: NaturallyOrderedValue;
        value: Record<string, number | null>;
      }>
    >;
    kpis: Record<string, number | null>;
    runtime: RuntimeInfo;
  }

  export interface DashboardRuntime<TRecord = unknown> {
    append(records: TRecord[]): number;
    appendArrowTable(table: ArrowTableLike, options?: ColumnarOptions<TRecord>): number;
    appendColumns(columns: Record<string, ColumnSource>, options?: ColumnarOptions<TRecord>): number;
    createGroup(spec: DashboardGroupSpec): string;
    dispose(): void;
    disposeGroup(id: string): void;
    query(request?: DashboardQueryRequest): { rows: TRecord[]; snapshot: DashboardSnapshot };
    removeFiltered(selection?: DashboardRemoveSelection): number;
    reset(): RuntimeInfo;
    rows(query?: DashboardRowQuery): TRecord[];
    runtimeInfo(): RuntimeInfo;
    size(): number;
    snapshot(filters?: DashboardFilterState): DashboardSnapshot;
    updateFilters(filters?: DashboardFilterState): RuntimeInfo;
  }

  export interface AsyncDashboardRuntime {
    append(records: Array<Record<string, unknown>>): Promise<number>;
    createGroup(spec: DashboardGroupSpec): Promise<string>;
    dispose(): Promise<void>;
    disposeGroup(id: string): Promise<void>;
    query(request?: DashboardQueryRequest): Promise<{ rows: Array<Record<string, unknown>>; snapshot: DashboardSnapshot }>;
    removeFiltered(selection?: DashboardRemoveSelection): Promise<number>;
    reset(): Promise<RuntimeInfo>;
    rows(query?: DashboardRowQuery): Promise<Array<Record<string, unknown>>>;
    runtimeInfo(): Promise<RuntimeInfo>;
    snapshot(filters?: DashboardFilterState): Promise<DashboardSnapshot>;
    updateFilters(filters?: DashboardFilterState): Promise<RuntimeInfo>;
    workerRuntime: RuntimeInfo;
  }

  export interface DashboardFetchProgress {
    bytesLoaded: number;
    totalBytes: number | null;
    percent: number | null;
    complete: boolean;
  }

  export interface DashboardLoadProgress {
    batchesLoaded: number;
    rowsLoaded: number;
    complete: boolean;
  }

  export type DashboardStreamStatus =
    | 'starting'
    | 'downloading'
    | 'streaming'
    | 'joining'
    | 'building'
    | 'ready'
    | 'error'
    | 'aborted';

  export type DashboardProjectionTransform = 'timestampMs';

  export interface DashboardStreamProjection {
    fields?: string[];
    rename?: Record<string, string>;
    transforms?: Record<string, DashboardProjectionTransform>;
  }

  export interface DashboardStreamLookupSpec {
    keyFields: string[];
    valueFields: string[];
  }

  export interface DashboardStreamSourceProgress {
    batchesLoaded: number;
    bytesLoaded: number;
    rowsLoaded: number;
    status: 'idle' | 'requesting' | 'downloading' | 'streaming' | 'ready' | 'error' | 'aborted';
    totalBytes: number | null;
  }

  export interface DashboardStreamSource {
    arrowBuffer?: ArrayBuffer | ArrayBufferView;
    dataFetchInit?: RequestInit;
    dataUrl?: string;
    id: string;
    lookup?: DashboardStreamLookupSpec;
    projection?: DashboardStreamProjection;
    role?: 'base' | 'lookup';
  }

  export interface DashboardStreamProgress {
    batchesLoaded: number;
    bytesLoaded: number;
    fetch: DashboardFetchProgress;
    load: DashboardLoadProgress;
    rowsLoaded: number;
    runtime: RuntimeInfo;
    sources: Record<string, DashboardStreamSourceProgress>;
    status: DashboardStreamStatus;
    totalBytes: number | null;
    message?: string;
    stack?: string | null;
  }

  export interface DashboardSnapshotEvent {
    progress: DashboardStreamProgress;
    snapshot: DashboardSnapshot;
  }

  export interface AsyncStreamingDashboardRuntime extends AsyncDashboardRuntime {
    workerRuntime: RuntimeInfo | null;
    on(
      eventType: 'progress' | 'ready',
      listener: (payload: DashboardStreamProgress) => void,
    ): () => void;
    on(
      eventType: 'snapshot',
      listener: (payload: DashboardSnapshotEvent) => void,
    ): () => void;
    on(
      eventType: 'error',
      listener: (payload: DashboardStreamProgress) => void,
    ): () => void;
    ready: Promise<DashboardStreamProgress>;
  }

  export interface DashboardRuntimeOptions<TRecord = unknown> {
    columnarOptions?: ColumnarOptions<TRecord>;
    columns?: Record<string, ColumnSource>;
    dimensions?: string[];
    groups?: DashboardGroupSpec[];
    kpis?: DashboardMetricSpec[];
    records?: TRecord[];
    table?: ArrowTableLike;
    wasm?: boolean;
  }

  export interface DashboardWorkerOptions {
    arrowBuffer?: ArrayBuffer | ArrayBufferView;
    arrowRuntimeUrl?: string;
    arrowUrl?: string;
    crossfilterUrl?: string;
    dataFetchInit?: RequestInit;
    dataUrl?: string;
    dimensions?: string[];
    groups?: DashboardGroupSpec[];
    kpis?: DashboardMetricSpec[];
    wasm?: boolean;
    workerFactory?: () => Worker;
  }

  export interface StreamingDashboardWorkerOptions extends DashboardWorkerOptions {
    batchCoalesceRows?: number;
    emitSnapshots?: boolean;
    initialFilters?: DashboardFilterState;
    progressThrottleMs?: number;
    snapshotThrottleMs?: number;
    sources?: DashboardStreamSource[];
  }

  export interface Grouping<TKey extends NaturallyOrderedValue, TValue> {
    key: TKey;
    value: TValue;
  }

  export interface Group<TRecord, TKey extends NaturallyOrderedValue, TValue> {
    top(k: number): Array<Grouping<TKey, TValue>>;
    all(): ReadonlyArray<Grouping<TKey, TValue>>;
    reduce(
      add: (p: TValue, v: TRecord, nf: boolean) => TValue,
      remove: (p: TValue, v: TRecord, nf: boolean) => TValue,
      initial: () => TValue,
    ): Group<TRecord, TKey, TValue>;
    reduceCount(): Group<TRecord, TKey, TValue>;
    reduceSum(selector: (record: TRecord) => number): Group<TRecord, TKey, TValue>;
    order(selector: (value: TValue) => NaturallyOrderedValue): Group<TRecord, TKey, TValue>;
    orderNatural(): Group<TRecord, TKey, TValue>;
    size(): number;
    dispose(): Group<TRecord, TKey, TValue>;
  }

  export interface GroupAll<TRecord, TValue> {
    reduce(
      add: (p: TValue, v: TRecord, nf: boolean) => TValue,
      remove: (p: TValue, v: TRecord, nf: boolean) => TValue,
      initial: () => TValue,
    ): GroupAll<TRecord, TValue>;
    reduceCount(): GroupAll<TRecord, TValue>;
    reduceSum(selector: (record: TRecord) => number): GroupAll<TRecord, TValue>;
    dispose(): GroupAll<TRecord, TValue>;
    value(): TValue;
  }

  export interface Dimension<TRecord, TValue extends NaturallyOrderedValue> {
    filter(filterValue: FilterValue): Dimension<TRecord, TValue>;
    filterExact(value: TValue): Dimension<TRecord, TValue>;
    filterIn(values: TValue[]): Dimension<TRecord, TValue>;
    filterRange(range: [TValue, TValue]): Dimension<TRecord, TValue>;
    filterFunction(predicate: Predicate<TValue>): Dimension<TRecord, TValue>;
    filterAll(): Dimension<TRecord, TValue>;
    currentFilter(): FilterValue | undefined;
    hasCurrentFilter(): boolean;
    top(k: number, offset?: number): TRecord[];
    bottom(k: number, offset?: number): TRecord[];
    group<TKey extends NaturallyOrderedValue, TGroupValue>(
      groupValue?: (value: TValue) => TKey,
    ): Group<TRecord, TKey, TGroupValue>;
    groupAll<TGroupValue>(): GroupAll<TRecord, TGroupValue>;
    dispose(): Dimension<TRecord, TValue>;
    accessor(record: TRecord): NaturallyOrderedValue;
    id(): number;
  }

  export enum EventType {
    DATA_ADDED = 'dataAdded',
    DATA_REMOVED = 'dataRemoved',
    FILTERED = 'filtered',
  }

  export interface Crossfilter<T> {
    add(records: T[]): Crossfilter<T>;
    remove(predicate?: Predicate<T>): void;
    dimension<TValue extends NaturallyOrderedValue>(
      selector: OrderedValueSelector<T, TValue | TValue[]>,
      isArray?: boolean,
    ): Dimension<T, TValue>;
    groupAll<TGroupValue>(): GroupAll<T, TGroupValue>;
    size(): number;
    all(): ReadonlyArray<T>;
    allFiltered(): T[];
    onChange(callback: (type: EventType) => void): () => void;
    isElementFiltered(index: number, ignoreDimensions?: number[]): boolean;
    configureRuntime(options: RuntimeOptions): RuntimeInfo;
    runtimeInfo(): RuntimeInfo;
  }

  export function rowsFromColumns<TRecord>(
    columns: Record<string, ColumnSource>,
    options?: ColumnarOptions<TRecord>,
  ): TRecord[];

  export function fromColumns<TRecord>(
    columns: Record<string, ColumnSource>,
    options?: ColumnarOptions<TRecord>,
  ): Crossfilter<TRecord>;

  export function rowsFromArrowTable<TRecord>(
    table: ArrowTableLike,
    options?: ColumnarOptions<TRecord>,
  ): TRecord[];

  export function fromArrowTable<TRecord>(
    table: ArrowTableLike,
    options?: ColumnarOptions<TRecord>,
  ): Crossfilter<TRecord>;

  export function configureRuntime(options: RuntimeOptions): RuntimeInfo;

  export function runtimeInfo(): RuntimeInfo;

  export function createDashboardRuntime<TRecord = unknown>(
    options: DashboardRuntimeOptions<TRecord>,
  ): DashboardRuntime<TRecord>;

  export function createDashboardWorker(
    options: DashboardWorkerOptions,
  ): Promise<AsyncDashboardRuntime>;

  export function createStreamingDashboardWorker(
    options: StreamingDashboardWorkerOptions,
  ): Promise<AsyncStreamingDashboardRuntime>;

  export type HeapSelector<T> = (records: T[], lo: number, hi: number, k: number) => T[];

  export interface Heap<T> {
    (records: T[], lo: number, hi: number): T[];
    sort(records: T[], lo: number, hi: number): T[];
  }

  export type Sorter<T> = (records: T[], lo: number, hi: number) => T[];

  export type Bisection<T> = (records: T[], record: T, lo: number, hi: number) => number;

  export interface Bisector<T> extends Bisection<T> {
    left: Bisection<T>;
    right: Bisection<T>;
  }

  export const version: string;

  namespace heap {
    export function by<T>(selector: OrderedValueSelector<T>): Heap<T>;
  }

  export function heap<T>(records: T[], lo: number, hi: number): T[];

  namespace heapselect {
    export function by<T>(selector: OrderedValueSelector<T>): HeapSelector<T>;
  }

  export function heapselect<T>(records: T[], lo: number, hi: number, k: number): T[];

  namespace bisect {
    export function by<T>(selector: OrderedValueSelector<T>): Bisector<T>;
  }

  export function bisect<T>(records: T[], record: T, lo: number, hi: number): number;

  export function permute<T>(records: T[], index: number[], deep: number): T[];
}
