/**
 * Effect spans mirrored into Cloudflare Workers traces.
 *
 * Workers trace every invocation themselves: the handler span, each outbound
 * `fetch`, each D1, KV, R2 and Durable Object call. This adds the
 * application's own `Effect.withSpan` spans to that trace as custom spans,
 * through the runtime's `tracing.startSpan`
 * (https://developers.cloudflare.com/workers/observability/traces/custom-spans/).
 *
 * What a Workers trace shows, and what it does not:
 *
 * - A mirrored span is a direct child of the invocation's handler span, beside
 *   the native D1 and `fetch` spans. `startSpan` returns a span that is never
 *   active, so the Effect tree's own nesting is not kept; timing still shows it.
 * - Attributes: string, number and boolean values only, and a key on the
 *   logger's deny-list (`../logger/redact.ts`) carries the placeholder.
 * - A failure sets `error.type` to the error's `_tag` (or an `Error`'s
 *   `name`) and the span's status to error. Never the message, which is free
 *   text the deny-list cannot clean, and never `recordException`, which also
 *   writes an error-level line to Workers Logs for every span a failure passes
 *   through.
 * - Span events (the tracer logger's copy of each log line) and links stay in
 *   the process; the Workers span has no API for either.
 * - Sampling is Cloudflare's (`observability.traces.head_sampling_rate`).
 *
 * Each Worker installs its handler's `ctx.tracing` at the top of every
 * invocation. Any invocation's `ctx.tracing` records into whichever invocation
 * is current, so the installed value can be shared by concurrent requests.
 */
import { Cause, Exit, Layer, Tracer } from "effect";

import { REDACT_KEYS, REDACTION_PLACEHOLDER } from "../logger/redact";

/** The part of a Workers `Span` the mirror uses. */
export interface WorkersSpan {
  /** `false` when the invocation records no telemetry. */
  readonly isTraced?: boolean;
  setAttribute(key: string, value: string | number | boolean): void;
  /** Absent from runtimes and type packages that predate it. */
  setStatus?(status: { readonly code: "error" }): void;
  end(): void;
}

/** The part of the Workers `tracing` API (`ctx.tracing`) the mirror uses. */
export interface WorkersTracing {
  startSpan(name: string): WorkersSpan;
}

let installed: WorkersTracing | undefined;

const isWorkersTracing = (value: unknown): value is WorkersTracing =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { readonly startSpan?: unknown }).startSpan === "function";

/**
 * Point the mirror at a Workers `tracing` object, or turn it off.
 *
 * Always overwrites. An object with a `startSpan` function installs; anything
 * else (`undefined`, or a runtime's `tracing` that predates `startSpan`)
 * clears, so every mirrored span in the isolate stays in-process until the
 * next install.
 */
export const installWorkersTracing = (tracing: unknown): void => {
  installed = isWorkersTracing(tracing) ? tracing : undefined;
};

/** Telemetry must never fail the work it describes. */
const guarded = (call: () => void): void => {
  try {
    call();
  } catch {
    // A refused telemetry call drops that one record and nothing else.
  }
};

const forwardable = (key: string, value: unknown): string | number | boolean | undefined => {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }
  return REDACT_KEYS.has(key.toLowerCase()) ? REDACTION_PLACEHOLDER : value;
};

const nameOf = (value: unknown): string => {
  if (typeof value === "object" && value !== null) {
    const tag = (value as { readonly _tag?: unknown })._tag;
    if (typeof tag === "string") return tag;
  }
  return value instanceof Error ? value.name : "Error";
};

/** The `error.type` for a span's exit, or `undefined` when it did not fail. */
const failureName = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return undefined;
  for (const reason of exit.cause.reasons) {
    if (Cause.isFailReason(reason)) return nameOf(reason.error);
    if (Cause.isDieReason(reason)) return nameOf(reason.defect);
  }
  return "Error";
};

type SpanOptions = ConstructorParameters<typeof Tracer.NativeSpan>[0];

/** Effect's own span, with each attribute and its end copied to a Workers span. */
class MirroredSpan extends Tracer.NativeSpan {
  readonly #mirror: WorkersSpan;

  constructor(options: SpanOptions, mirror: WorkersSpan) {
    super(options);
    this.#mirror = mirror;
  }

  override attribute(key: string, value: unknown): void {
    if (this.status._tag === "Ended") return;
    super.attribute(key, value);
    const forwarded = forwardable(key, value);
    if (forwarded !== undefined) guarded(() => this.#mirror.setAttribute(key, forwarded));
  }

  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    if (this.status._tag === "Ended") return;
    super.end(endTime, exit);
    const mirror = this.#mirror;
    const errorType = failureName(exit);
    guarded(() => {
      if (errorType !== undefined) {
        mirror.setAttribute("error.type", errorType);
        mirror.setStatus?.({ code: "error" });
      }
      mirror.end();
    });
  }
}

/** A traced Workers span for `name`, or `undefined` when there is none to write to. */
const startMirror = (tracing: WorkersTracing, name: string): WorkersSpan | undefined => {
  let span: WorkersSpan;
  try {
    span = tracing.startSpan(name);
  } catch {
    return undefined;
  }
  if (span.isTraced === false) {
    guarded(() => span.end());
    return undefined;
  }
  return span;
};

const workersTracer: Tracer.Tracer = Tracer.make({
  span: (options) => {
    const tracing = installed;
    if (tracing === undefined || !options.sampled) return new Tracer.NativeSpan(options);
    const mirror = startMirror(tracing, options.name);
    return mirror === undefined
      ? new Tracer.NativeSpan(options)
      : new MirroredSpan(options, mirror);
  },
});

/**
 * The tracer for a Worker's layer graph. Reads the installed `tracing` on each
 * span, so it can be built before the first invocation installs one; with
 * nothing installed (Bun, tests) it behaves as Effect's default tracer.
 */
export const WorkersTracingLive: Layer.Layer<never> = Layer.succeed(Tracer.Tracer)(workersTracer);
