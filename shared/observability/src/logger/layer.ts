import { HashMap, Layer, Logger, LogLevel } from "effect";

import type { LogLevel as ConfigLogLevel, ObservabilityConfig } from "../config";
import { redact } from "./redact";

const LOG_LEVEL_MAP = {
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warning,
  error: LogLevel.Error,
  fatal: LogLevel.Fatal,
} satisfies Record<ConfigLogLevel, LogLevel.LogLevel>;

/**
 * Wrap a base logger so every emitted entry has its `message` and
 * `annotations` passed through the redaction deny-list before serialization.
 *
 * `base` must be a logger that *writes* (`Logger.Logger<unknown, void>`), not
 * one that formats — see the note on `makeLoggerLayer` about `jsonLogger`.
 */
const makeRedactingLogger = (base: Logger.Logger<unknown, void>): Logger.Logger<unknown, void> =>
  Logger.make<unknown, void>((options) =>
    base.log({
      ...options,
      message: redact(options.message),
      annotations: HashMap.map(options.annotations, (value) => redact(value)),
    }),
  );

/**
 * Returns a Layer that:
 * - Replaces Effect's default logger with a redacting logger — pretty only on
 *   a developer's own terminal, JSON everywhere a machine reads the output
 * - Applies the configured minimum log level
 *
 * `dev` gets JSON, not pretty. It reads like a developer tier but it is a
 * deployed one: its logs land in Workers Logs alongside production's, where
 * pretty output is multi-line ANSI that costs several ingested events per
 * entry and cannot be queried by field. `local` is the only tier with a human
 * watching stdout.
 *
 * `Logger.jsonLogger` is wrapped in `Logger.withConsoleLog` because on its own
 * it does not write anywhere: its type is `Logger<unknown, string>` — it
 * *returns* the JSON line and leaves emitting to the caller. TypeScript accepts
 * it where a `Logger<unknown, void>` is wanted (any return type is assignable
 * to `void`), so the mistake type-checks, and every deployed tier goes silent
 * with no error. `Logger.prettyLogger()` writes for itself, which is why local
 * kept working and hid this.
 *
 * Provide this once at the top of the application (via `ObservabilityLive`
 * in `../index.ts`).
 */
export const makeLoggerLayer = (config: ObservabilityConfig): Layer.Layer<never> => {
  const baseLogger =
    config.env === "local" ? Logger.prettyLogger() : Logger.withConsoleLog(Logger.jsonLogger);
  const redacting = makeRedactingLogger(baseLogger);
  return Layer.mergeAll(
    Logger.replace(Logger.defaultLogger, redacting),
    Logger.minimumLogLevel(LOG_LEVEL_MAP[config.logLevel]),
  );
};
