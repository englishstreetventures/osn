import { Effect, Logger } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { DeploymentEnvironment } from "../src/config";
import { loadConfig } from "../src/config";
import { initObservability, makeObservabilityLayer } from "../src/index";
import { makeLoggerLayer, PrettyLoggerLive } from "../src/logger/layer";
import { makeTracingLayer, otlpExporterUrl } from "../src/tracing/layer";
import { NoopTracingLive } from "../src/tracing/noop";

/**
 * Layer-construction smoke tests. These don't spin up a real OTel
 * collector — the goal is just to prove:
 *   1. Every factory builds a non-throwing Layer for dev/staging/prod.
 *   2. `initObservability()` returns a usable config + layer pair.
 *   3. The redacting logger actually scrubs annotations end-to-end
 *      (not just the pure `redact()` function, which is tested
 *      separately).
 */
describe("makeLoggerLayer", () => {
  it("builds without throwing in dev mode", () => {
    const config = loadConfig({ serviceName: "test", env: "dev" });
    expect(() => makeLoggerLayer(config)).not.toThrow();
  });

  it("builds without throwing in production mode", () => {
    const config = loadConfig({ serviceName: "test", env: "production" });
    expect(() => makeLoggerLayer(config)).not.toThrow();
  });

  it("builds without throwing in staging mode", () => {
    const config = loadConfig({ serviceName: "test", env: "staging" });
    expect(() => makeLoggerLayer(config)).not.toThrow();
  });

  // The real end-to-end redaction test. The case this replaced was named for
  // this behaviour but did not check it: it built `makeLoggerLayer` into an
  // unused `_loggerLayer`, provided a RAW capture logger with no redaction in
  // the chain, and then asserted the annotation came through unredacted. So
  // redaction was covered by `redact.test.ts` at the pure-function level and by
  // nothing at all at the layer level — which is how the per-value bug below
  // survived.
  //
  // This runs the actual layer and reads what reached stdout.
  it("end-to-end: secret annotations are redacted in the emitted entry", async () => {
    const written: string[] = [];
    const original = globalThis.console.log;
    globalThis.console.log = (...args: unknown[]) => {
      written.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const config = loadConfig({ serviceName: "test", env: "production" });
      await Effect.runPromise(
        Effect.logInfo("login attempt").pipe(
          Effect.annotateLogs({
            accessToken: "eyJsecret",
            email: "alice@example.com",
            profileId: "u_123",
          }),
          Effect.provide(makeLoggerLayer(config)),
        ),
      );
    } finally {
      globalThis.console.log = original;
    }

    const entry = JSON.parse(written.join("\n")) as {
      message: unknown;
      annotations: Record<string, unknown>;
    };

    // `accessToken` and `email` are both on the deny-list in redact.ts.
    // Under v3 neither was redacted here: the redacting logger mapped over
    // each annotation VALUE, and `redact` matches an object's KEYS, so a bare
    // string reached it with no key attached and passed straight through.
    expect(entry.annotations.accessToken).toBe("[REDACTED]");
    expect(entry.annotations.email).toBe("[REDACTED]");

    // Not on the deny-list — proves this is the deny-list at work and not a
    // blanket scrub of every annotation.
    expect(entry.annotations.profileId).toBe("u_123");

    expect(entry.message).toBe("login attempt");
  });
});

describe("makeLoggerLayer output format", () => {
  // Runs one `Effect.logInfo` through the real layer for a tier and returns
  // whatever reached stdout. Both loggers write via console.log, so the shape
  // of that string is the only observable difference between them — and an
  // empty string means the tier emitted nothing at all, which is the failure
  // these tests exist to catch.
  const emit = async (env: DeploymentEnvironment): Promise<string> => {
    const written: string[] = [];
    const original = globalThis.console.log;
    globalThis.console.log = (...args: unknown[]) => {
      written.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const config = loadConfig({ serviceName: "test", env });
      await Effect.runPromise(
        Effect.logInfo("hello").pipe(Effect.provide(makeLoggerLayer(config))),
      );
    } finally {
      globalThis.console.log = original;
    }
    return written.join("\n");
  };

  it("writes machine-readable JSON on every deployed tier", async () => {
    // `dev` belongs in this list. It reads like a developer tier but it is
    // deployed, and its logs land in Workers Logs beside production's — where
    // pretty output is multi-line ANSI, costs several ingested events per
    // entry, and cannot be queried by field. It used to get prettyLogger.
    //
    // The emptiness assertion is the load-bearing one. `Logger.jsonLogger` is
    // `Logger<unknown, string>` — it formats and returns, it does not write —
    // and TypeScript accepts it where a `Logger<unknown, void>` is wanted, so
    // for as long as the deployed tiers used it bare they emitted *nothing*
    // and nothing complained. Only `local` (prettyLogger, which writes for
    // itself) ever produced output, which is exactly why no one noticed.
    for (const env of ["dev", "staging", "production"] as const) {
      const line = await emit(env);
      expect(line, `${env} emitted no log line at all`).not.toBe("");
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect((JSON.parse(line) as { message: unknown }).message).toBe("hello");
    }
  });

  it("writes pretty output only on local, where a human is watching stdout", async () => {
    const line = await emit("local");
    expect(() => JSON.parse(line) as unknown).toThrow(SyntaxError);
    expect(line).toContain("hello");
  });
});

/**
 * The pretty logger is redactable, and these tests are the proof.
 *
 * `Logger.consolePretty()` writes and returns `void`, so there is no output to
 * map over — but v4 exposes both of its inputs: `options.message`, and the
 * annotations it reads for itself as
 * `options.fiber.getRef(References.CurrentLogAnnotations)`. `redactInput`
 * shadows those two and delegates to an untouched pretty logger, which is why
 * colour, spans and date formatting survive the scrub.
 */
describe("PrettyLoggerLive", () => {
  /** Capture everything the pretty logger writes for one `Effect.log*` call. */
  const capture = async (run: () => Promise<unknown>): Promise<string> => {
    const lines: string[] = [];
    const { log, error, group, groupEnd } = globalThis.console;
    const sink = (...args: unknown[]) => {
      // An `Error` argument is kept identifiable, since preserving it as a real
      // Error (rather than a `{ name, message }` record) is the point.
      lines.push(
        args
          .map((a) =>
            typeof a === "string"
              ? a
              : a instanceof Error
                ? `Error<${a.name}:${a.message}>${JSON.stringify(a)}`
                : JSON.stringify(a),
          )
          .join(" "),
      );
    };
    globalThis.console.log = sink;
    globalThis.console.error = sink;
    globalThis.console.group = () => undefined;
    globalThis.console.groupEnd = () => undefined;
    try {
      await run();
    } finally {
      Object.assign(globalThis.console, { log, error, group, groupEnd });
    }
    return lines.join("\n");
  };

  it("redacts a deny-listed annotation key", async () => {
    const out = await capture(() =>
      Effect.runPromise(
        Effect.logInfo("login attempt").pipe(
          Effect.annotateLogs({ accessToken: "eyJ-secret", profileId: "u_123" }),
          Effect.provide(PrettyLoggerLive),
        ),
      ),
    );

    expect(out).not.toContain("eyJ-secret");
    expect(out).toContain("[REDACTED]");
    // The deny-list at work, not a blanket scrub.
    expect(out).toContain("u_123");
    expect(out).toContain("login attempt");
  });

  it("redacts a deny-listed key inside a message argument", async () => {
    const out = await capture(() =>
      Effect.runPromise(
        Effect.logInfo("inbound request", { email: "alice@example.com", profileId: "u_123" }).pipe(
          Effect.provide(PrettyLoggerLive),
        ),
      ),
    );

    expect(out).not.toContain("alice@example.com");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("u_123");
  });

  it("scrubs an Error's fields while keeping it a real Error with its stack", async () => {
    const err = new Error("registration failed") as Error & {
      accessToken?: string;
      profileId?: string;
    };
    err.accessToken = "eyJ-secret";
    err.profileId = "u_123";

    const out = await capture(() =>
      Effect.runPromise(
        Effect.logError("zap-api: failed to register", err).pipe(Effect.provide(PrettyLoggerLive)),
      ),
    );

    // Still an Error when it reaches the console — a `{ name, message }` record
    // would have no frames, and local stack traces are what this logger is for.
    expect(out).toContain("Error<Error:registration failed>");
    expect(out).not.toContain("eyJ-secret");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("u_123");
  });

  it("keeps Logger.tracerLogger in the active set", async () => {
    // `Logger.layer` REPLACES the whole set, so dropping the tracer logger from
    // the list costs log-to-span correlation with no error and no failing
    // type-check. Both layers that ship a logger are checked.
    const activeSet = (layer: typeof PrettyLoggerLive) =>
      Effect.runPromise(
        Effect.service(Logger.CurrentLoggers).pipe(
          Effect.map((loggers) => loggers.has(Logger.tracerLogger)),
          Effect.provide(layer),
        ),
      );

    await expect(activeSet(PrettyLoggerLive)).resolves.toBe(true);
    await expect(
      activeSet(makeLoggerLayer(loadConfig({ serviceName: "test", env: "production" }))),
    ).resolves.toBe(true);
  });

  it("still emits ANSI colour when stdout is a TTY", async () => {
    // Colour was the cost the migration paid for redaction, on the belief that
    // `consolePretty` had no seam to redact through. It has one, so there is no
    // trade to make — but `consolePretty()` samples `process.stdout.isTTY` at
    // CONSTRUCTION time, and layer.ts constructs it at module eval. Hence
    // resetModules + a fresh import rather than a plain assertion.
    const stdout = process.stdout as { isTTY?: boolean };
    const prevIsTTY = stdout.isTTY;
    stdout.isTTY = true;
    vi.resetModules();
    try {
      const fresh = await import("../src/logger/layer");
      const out = await capture(() =>
        Effect.runPromise(Effect.logInfo("hello").pipe(Effect.provide(fresh.PrettyLoggerLive))),
      );
      // eslint-disable-next-line no-control-regex
      expect(out).toMatch(/\[\d+m/);
      expect(out).toContain("hello");
    } finally {
      stdout.isTTY = prevIsTTY;
      vi.resetModules();
    }
  });
});

describe("otlpExporterUrl", () => {
  it("suffixes the per-signal path onto the base endpoint", () => {
    expect(otlpExporterUrl("https://otlp.grafana.net/otlp", "traces")).toBe(
      "https://otlp.grafana.net/otlp/v1/traces",
    );
    expect(otlpExporterUrl("https://otlp.grafana.net/otlp", "metrics")).toBe(
      "https://otlp.grafana.net/otlp/v1/metrics",
    );
  });

  it("collapses a trailing slash so it never emits //v1", () => {
    expect(otlpExporterUrl("http://localhost:4318/", "traces")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("returns undefined when no endpoint is configured", () => {
    expect(otlpExporterUrl(undefined, "traces")).toBeUndefined();
  });
});

describe("makeTracingLayer", () => {
  it("is a true no-op (NoopTracingLive) when no OTLP endpoint is configured", () => {
    const config = loadConfig({ serviceName: "test", env: "dev" });
    expect(config.otlpEndpoint).toBeUndefined();
    // An unset endpoint must NOT spin up the NodeSdk pointed at
    // localhost:4318 — it must return the empty no-op layer so there are
    // zero export attempts. Identity check pins exactly that.
    expect(makeTracingLayer(config)).toBe(NoopTracingLive);
  });

  it("honours the endpoint from env and builds a real exporter layer", () => {
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp.grafana.net/otlp";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer test-token";
    try {
      const config = loadConfig({ serviceName: "test", env: "dev" });
      // The endpoint + auth header are read straight from env.
      expect(config.otlpEndpoint).toBe("https://otlp.grafana.net/otlp");
      expect(config.otlpHeaders).toEqual({ authorization: "Bearer test-token" });
      // With an endpoint set we get the real NodeSdk layer, not the no-op.
      const layer = makeTracingLayer(config);
      expect(layer).not.toBe(NoopTracingLive);
      expect(layer).toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
      if (prevHeaders === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
      else process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
    }
  });

  it("builds without throwing in production mode with tight sampling", () => {
    const prev = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otlp.grafana.net/otlp";
    try {
      const config = loadConfig({ serviceName: "test", env: "production" });
      expect(config.traceSampleRatio).toBe(0.1);
      expect(() => makeTracingLayer(config)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = prev;
    }
  });
});

describe("initObservability", () => {
  it("returns both config and layer", () => {
    const { config, layer } = initObservability({ serviceName: "init-test" });
    expect(config.serviceName).toBe("init-test");
    expect(config.serviceNamespace).toBe("osn");
    expect(layer).toBeDefined();
  });

  it("makeObservabilityLayer merges logger + tracing without throwing", () => {
    const config = loadConfig({ serviceName: "test", env: "dev" });
    expect(() => makeObservabilityLayer(config)).not.toThrow();
  });
});
