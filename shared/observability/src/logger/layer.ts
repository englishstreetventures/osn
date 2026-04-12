import { HashMap, Layer, Logger, LogLevel } from "effect";

import type { LogLevel as ConfigLogLevel, ObservabilityConfig } from "../config";
import { redact } from "./redact";

const LOG_LEVEL_MAP: Record<ConfigLogLevel, LogLevel.LogLevel> = {
  trace: LogLevel.Trace,
  debug: LogLevel.Debug,
  info: LogLevel.Info,
  warn: LogLevel.Warning,
  error: LogLevel.Error,
  fatal: LogLevel.Fatal,
};

/**
 * Wrap a base logger so every emitted entry has its `message` and
 * `annotations` passed through the redaction deny-list before serialization.
 *
 * Keeps the underlying logger's output type — if `base` is `Logger.jsonLogger`
 * (which writes to stdout), the redacting version also writes to stdout;
 * if `base` is pretty, pretty output is redacted first.
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
 * - Replaces Effect's default logger with a redacting logger (json in prod,
 *   pretty in dev)
 * - Applies the configured minimum log level
 *
 * Provide this once at the top of the application (via `ObservabilityLive`
 * in `../index.ts`).
 */
export const makeLoggerLayer = (config: ObservabilityConfig): Layer.Layer<never> => {
  const baseLogger = config.env === "production" ? Logger.jsonLogger : Logger.prettyLogger();
  const redacting = makeRedactingLogger(baseLogger);
  return Layer.mergeAll(
    Logger.replace(Logger.defaultLogger, redacting),
    Logger.minimumLogLevel(LOG_LEVEL_MAP[config.logLevel]),
  );
};
