import { metrics, type Attributes } from "@opentelemetry/api";

/**
 * Typed metric factory.
 *
 * Every metric in OSN MUST be created via these helpers. Raw
 * `metrics.getMeter().createCounter()` calls are banned — code review /
 * CI will reject them — because they bypass the attribute-type enforcement
 * that keeps cardinality bounded.
 *
 * Usage:
 *
 *   type LoginAttrs = { method: AuthMethod; result: Result };
 *
 *   export const authLoginAttempts = createCounter<LoginAttrs>({
 *     name: "osn.auth.login.attempts",
 *     description: "Login attempts by auth method and outcome",
 *     unit: "{attempt}",
 *   });
 *
 *   // Call site:
 *   authLoginAttempts.inc({ method: "passkey", result: "ok" });
 *
 * The `<LoginAttrs>` generic pins the allowed attribute keys at
 * declaration — TypeScript rejects `authLoginAttempts.inc({ profileId: "u_123" })`
 * at compile time.
 */

const METER_NAME = "@shared/observability";

/**
 * We lazily resolve the meter so tests can install a NoOp meter provider
 * before the first call and module-load ordering doesn't matter.
 */
const getMeter = () => metrics.getMeter(METER_NAME);

export interface Counter<A extends Attributes> {
  /** Add an arbitrary positive value. */
  readonly add: (value: number, attrs: A) => void;
  /** Shortcut for `add(1, attrs)`. */
  readonly inc: (attrs: A) => void;
}

export interface Histogram<A extends Attributes> {
  readonly record: (value: number, attrs: A) => void;
}

export interface UpDownCounter<A extends Attributes> {
  readonly add: (value: number, attrs: A) => void;
  readonly inc: (attrs: A) => void;
  readonly dec: (attrs: A) => void;
}

export interface CounterOpts {
  readonly name: string;
  readonly description: string;
  /** UCUM-style unit, e.g. "{attempt}", "{event}", "s", "By", "1". */
  readonly unit: string;
}

export interface HistogramOpts extends CounterOpts {
  /** Explicit bucket boundaries (seconds/bytes/etc. depending on unit). */
  readonly boundaries?: readonly number[];
}

/**
 * Standard latency bucket boundaries in seconds.
 * Tuned for HTTP APIs: dense at the low end (5ms–100ms), sparse at the high end.
 * Covers 5ms … 10s. Anything > 10s shows up in the +Inf bucket.
 */
export const LATENCY_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

/**
 * Standard byte-size bucket boundaries.
 * Use for request/response body sizes, payload sizes, etc.
 * Covers 64 B … 64 MB.
 */
export const BYTE_BUCKETS: readonly number[] = [
  64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
] as const;

export const createCounter = <A extends Attributes>(opts: CounterOpts): Counter<A> => {
  // Lazy: capture opts, build instrument on first use.
  let instrument: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]> | null = null;
  const get = () => {
    if (!instrument) {
      instrument = getMeter().createCounter(opts.name, {
        description: opts.description,
        unit: opts.unit,
      });
    }
    return instrument;
  };
  return {
    add: (value, attrs) => get().add(value, attrs),
    inc: (attrs) => get().add(1, attrs),
  };
};

export const createHistogram = <A extends Attributes>(opts: HistogramOpts): Histogram<A> => {
  let instrument: ReturnType<ReturnType<typeof metrics.getMeter>["createHistogram"]> | null = null;
  const get = () => {
    if (!instrument) {
      instrument = getMeter().createHistogram(opts.name, {
        description: opts.description,
        unit: opts.unit,
        advice: opts.boundaries ? { explicitBucketBoundaries: [...opts.boundaries] } : undefined,
      });
    }
    return instrument;
  };
  return {
    record: (value, attrs) => get().record(value, attrs),
  };
};

export const createUpDownCounter = <A extends Attributes>(opts: CounterOpts): UpDownCounter<A> => {
  let instrument: ReturnType<ReturnType<typeof metrics.getMeter>["createUpDownCounter"]> | null =
    null;
  const get = () => {
    if (!instrument) {
      instrument = getMeter().createUpDownCounter(opts.name, {
        description: opts.description,
        unit: opts.unit,
      });
    }
    return instrument;
  };
  return {
    add: (value, attrs) => get().add(value, attrs),
    inc: (attrs) => get().add(1, attrs),
    dec: (attrs) => get().add(-1, attrs),
  };
};
