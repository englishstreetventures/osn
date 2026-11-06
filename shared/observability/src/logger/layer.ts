import { Cause, Formatter, Layer, LogLevel, Logger, References, type Context } from "effect";

import type { LogLevel as ConfigLogLevel, ObservabilityConfig } from "../config";
import { redact } from "./redact";

/**
 * v4 log levels are string literals, not branded constructors. Note `"Warn"`,
 * not v3's `"Warning"` — the two majors spell that one differently.
 */
const LOG_LEVEL_MAP = {
  trace: "Trace",
  debug: "Debug",
  info: "Info",
  warn: "Warn",
  error: "Error",
  fatal: "Fatal",
} satisfies { readonly [K in ConfigLogLevel]: LogLevel.LogLevel };

/**
 * Redaction on the **output** side: resolve an entry to its structured form and
 * scrub the deny-listed values out of it. The loggers below decide how the
 * scrubbed entry reaches the console.
 *
 * This is the seam for any logger whose output we own. `Logger.formatStructured`
 * hands back an object holding the resolved `message` and an `annotations`
 * record, so scrubbing that covers whatever the fiber carried, wherever it came
 * from — which matters in v4, where annotations live on the fiber
 * (`References.CurrentLogAnnotations`) rather than on `Logger.Options`, and each
 * logger reads them for itself.
 *
 * For a logger whose output we do *not* own — `Logger.consolePretty`, which
 * writes to the console and returns `void` — see {@link redactInput} below.
 */
const redactedEntry = Logger.map(Logger.formatStructured, (entry) => ({
  ...entry,
  message: redact(entry.message),
  // The whole record, not a per-value map. `redact` enforces the deny-list
  // against an object's KEYS (see redact.ts §Matching rules), so handing it
  // one annotation value at a time shows it a bare scalar and it passes
  // everything through.
  annotations: redact(entry.annotations),
}));

/**
 * Whether this process is a Cloudflare Worker. workerd sets
 * `navigator.userAgent` to `"Cloudflare-Workers"` under the `global_navigator`
 * flag, on by default since compatibility date 2022-03-21
 * (https://developers.cloudflare.com/workers/runtime-apis/web-standards/).
 */
const onWorkerd = (): boolean =>
  typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";

/**
 * A log line's cause with every failure and defect scrubbed. `Cause.pretty`
 * renders a failure that is not an `Error` as its whole object, and an `Error`
 * with its own fields, so the deny-list runs on each before any logger renders
 * the cause. Interruptions carry nothing and pass through.
 */
const redactCause = (cause: Cause.Cause<unknown>): Cause.Cause<unknown> =>
  cause.reasons.length === 0
    ? cause
    : Cause.fromReasons(
        cause.reasons.map((reason) =>
          Cause.isFailReason(reason)
            ? Cause.makeFailReason(redact(reason.error))
            : Cause.isDieReason(reason)
              ? Cause.makeDieReason(redact(reason.defect))
              : reason,
        ),
      );

/**
 * Redaction on the **input** side: wrap a logger so the entry it receives is
 * already scrubbed, and let it do everything else itself.
 *
 * `Logger.consolePretty()` formats *and writes*, returning `void`, so there is
 * no output object to map over — but there are two inputs, and v4 exposes both:
 *
 *   - `options.message` is the raw argument list handed to `Effect.log*`, and
 *   - annotations are read by the inner logger as
 *     `options.fiber.getRef(References.CurrentLogAnnotations)`.
 *
 * So we shadow the message, and shadow `getRef` for that one reference, then
 * delegate to an untouched `consolePretty`. Everything the pretty logger is
 * wanted for still comes from Effect: ANSI colour, log spans, `LogToStderr`
 * routing, `ConsoleRef`, date formatting and the fiber id — the stand-in fiber
 * has the real one as its prototype, and `getRef` for every other reference
 * (including `ConsoleRef` and `CurrentLogSpans`) is forwarded verbatim.
 *
 * `redact` preserves `Error` instances as real `Error`s (see redact.ts), so the
 * stack traces a developer opens the pretty logger for survive the scrub.
 */
const redactInput = (inner: Logger.Logger<unknown, void>): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    const getRef = <A>(ref: Context.Reference<A>): A =>
      ref === (References.CurrentLogAnnotations as Context.Reference<unknown>)
        ? (redact(options.fiber.getRef(ref)) as A)
        : options.fiber.getRef(ref);
    const fiber = Object.create(options.fiber, {
      getRef: { value: getRef },
    }) as typeof options.fiber;
    return inner.log({
      ...options,
      message: redact(options.message),
      cause: redactCause(options.cause),
      fiber,
    });
  });

/**
 * A logger's input with its cause scrubbed, for the loggers whose message and
 * annotations {@link redactedEntry} scrubs on the output side: by then the
 * cause is already rendered text, which key-based redaction cannot clean.
 */
const withRedactedCause = <Output>(
  inner: Logger.Logger<unknown, Output>,
): Logger.Logger<unknown, Output> =>
  Logger.make((options) => inner.log({ ...options, cause: redactCause(options.cause) }));

/**
 * The redacting pretty logger: `Logger.consolePretty()` with both of its inputs
 * scrubbed. Used by the `local` tier of {@link makeLoggerLayer} and by
 * {@link PrettyLoggerLive}.
 */
const prettyRedactingLogger: Logger.Logger<unknown, void> = redactInput(Logger.consolePretty());

/**
 * The redacting JSON logger: one queryable object per line, for a deployed tier
 * running anywhere but workerd.
 */
const jsonRedactingLogger: Logger.Logger<unknown, void> = Logger.withConsoleLog(
  withRedactedCause(redactedEntry).pipe(Logger.map((entry) => Formatter.formatJson(entry))),
);

/**
 * The redacting Workers Logs logger, for a deployed tier on workerd. It hands
 * the console the scrubbed entry as an object, not a string: Workers Logs
 * extracts and indexes the keys of a logged object and keeps a logged string as
 * one message (https://developers.cloudflare.com/workers/observability/logs/workers-logs/).
 * The console method follows the entry's level (`console.info`, `console.warn`,
 * `console.error`), and Workers Logs records that method as the line's level.
 */
const workersLogsLogger: Logger.Logger<unknown, void> = Logger.withLeveledConsole(
  withRedactedCause(redactedEntry),
);

/**
 * `Logger.tracerLogger` with its inputs scrubbed. The tracer logger copies each
 * line's message and annotations onto the current span as an event, and the
 * Bun OTLP path exports span events, so it sees the same redacted entry as the
 * console loggers.
 */
const redactedTracerLogger: Logger.Logger<unknown, void> = redactInput(Logger.tracerLogger);

/**
 * Returns a Layer that:
 * - Replaces Effect's logger set with a redacting logger — colourised and
 *   readable on a developer's own terminal, a structured object in Workers
 *   Logs, a JSON line anywhere else a machine reads it
 * - Keeps the (redacted) tracer logger alongside it, so log lines stay attached
 *   to their span — except on a deployed Worker, where span events never leave
 *   the process (the Workers trace mirror forwards none) and Workers Logs files
 *   each line under the invocation's trace itself
 * - Applies the configured minimum log level
 *
 * `dev` gets the machine form, not the readable one. It reads like a developer
 * tier but it is a deployed one: its logs land in Workers Logs alongside
 * production's, where multi-line output costs several ingested events per
 * entry and cannot be queried by field. `local` is the only tier with a human
 * watching stdout, and it is the only one that gets the pretty logger. Whether
 * this is workerd is read once, when the layer is built.
 *
 * **`Logger.layer` replaces the whole active set**, where v3's `Logger.replace`
 * swapped a single logger and left the rest standing. The tracer logger is
 * therefore listed explicitly: omit it and log-to-span correlation disappears
 * with no error and no failing type-check. `{ mergeWithExisting: true }` is not
 * the v3 equivalent either — it *adds* to the set, leaving the default logger
 * running alongside so every line is emitted twice.
 *
 * Provide this once at the top of the application (via `ObservabilityLive`
 * in `../index.ts`).
 */
export const makeLoggerLayer = (config: ObservabilityConfig): Layer.Layer<never> =>
  Layer.mergeAll(
    Logger.layer(
      config.env === "local"
        ? [prettyRedactingLogger, redactedTracerLogger]
        : onWorkerd()
          ? [workersLogsLogger]
          : [jsonRedactingLogger, redactedTracerLogger],
    ),
    Layer.succeed(References.MinimumLogLevel, LOG_LEVEL_MAP[config.logLevel]),
  );

/**
 * The dev-server logger: the readable, colourised output plus the tracer
 * logger, and nothing else. Replaces v3's `Logger.pretty`, which was a Layer
 * the `local.ts` entrypoints provided directly.
 *
 * It lives here rather than being spelled out at each call site because
 * `Logger.layer` replaces the **whole** active set. Written inline in eleven
 * places, the tracer logger is one careless edit away from being dropped
 * from one of them — and dropping it costs log-to-span correlation with no
 * error and no failing type-check. One definition, one place to get it right.
 *
 * Redacted, like every other logger here: {@link redactInput} scrubs the
 * message and the annotations before `consolePretty` and the tracer logger see
 * them, and the colour survives because the pretty logger itself is untouched.
 * It carries no minimum log level, which is the one thing {@link makeLoggerLayer}
 * adds — so a deployed entry point wants that, not this.
 */
export const PrettyLoggerLive: Layer.Layer<never> = Logger.layer([
  prettyRedactingLogger,
  redactedTracerLogger,
]);
