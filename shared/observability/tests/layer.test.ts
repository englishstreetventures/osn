import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Effect, Layer, ManagedRuntime, Tracer } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeploymentEnvironment, ObservabilityConfig } from "../src/config";
import { loadConfig } from "../src/config";
import { makeLoggerLayer, PrettyLoggerLive } from "../src/logger/layer";
import { makeTracingLayer, otlpExporterUrl } from "../src/tracing/layer";
import { NoopTracingLive } from "../src/tracing/noop";

/**
 * Layer tests. These don't spin up a real OTel collector — the goal is to
 * prove the redacting logger actually scrubs annotations end-to-end (not just
 * the pure `redact()` function, which is tested separately), that each tier
 * gets the output format it needs, and that tracing is a true no-op without
 * an endpoint.
 */
describe("makeLoggerLayer", () => {
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

  it("hands the console an object, through its level's method, on workerd", async () => {
    // Workers Logs indexes the keys of a logged object and stores a logged
    // string as one opaque message, so a deployed Worker must log the object.
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
    const c = globalThis.console;
    const original = { log: c.log, info: c.info, warn: c.warn, error: c.error, debug: c.debug };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      c[method] = (...args: unknown[]) => {
        calls.push({ method, args });
      };
    }
    try {
      const layer = makeLoggerLayer(loadConfig({ serviceName: "test", env: "dev" }));
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* Effect.logInfo("guest looked up");
          yield* Effect.logError("lookup failed");
        }).pipe(
          Effect.annotateLogs({ email: "alice@example.com", weddingId: "wed_1" }),
          Effect.provide(layer),
        ),
      );
    } finally {
      Object.assign(c, original);
      vi.unstubAllGlobals();
    }

    expect(calls.map((call) => call.method)).toEqual(["info", "error"]);
    for (const { args } of calls) {
      expect(args).toHaveLength(1);
      expect(typeof args[0]).toBe("object");
      const entry = args[0] as { annotations: Record<string, unknown> };
      expect(entry.annotations["email"]).toBe("[REDACTED]");
      expect(entry.annotations["weddingId"]).toBe("wed_1");
    }
    expect((calls[0]!.args[0] as { message: unknown }).message).toBe("guest looked up");
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
describe("a logged cause", () => {
  // A failure that is not an `Error` renders as its whole object in the
  // cause text, so the cause must be scrubbed before any sink renders it.
  const failure = { _tag: "LookupFailed", email: "alice@example.com", reason: "no row" };
  const logWithCause = (layer: typeof PrettyLoggerLive) =>
    Effect.runPromise(
      Effect.fail(failure).pipe(
        Effect.tapCause((cause) => Effect.logError("lookup failed", cause)),
        Effect.catchCause(() => Effect.void),
        Effect.withSpan("probe.cause"),
        Effect.provide(layer),
      ),
    );

  const sinks = (): string[] => {
    const lines: string[] = [];
    const sink = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    const c = globalThis.console;
    const original = { log: c.log, error: c.error, group: c.group, groupEnd: c.groupEnd };
    Object.assign(c, { log: sink, error: sink, group: () => undefined, groupEnd: () => undefined });
    afterAllRestore = () => Object.assign(c, original);
    return lines;
  };
  let afterAllRestore = () => {};

  it("carries no deny-listed field to the JSON line, the Workers Logs object or the pretty logger", async () => {
    for (const make of [
      () => makeLoggerLayer(loadConfig({ serviceName: "test", env: "production" })),
      () => {
        vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
        return makeLoggerLayer(loadConfig({ serviceName: "test", env: "production" }));
      },
      () => PrettyLoggerLive,
    ]) {
      const lines = sinks();
      try {
        await logWithCause(make());
      } finally {
        afterAllRestore();
        vi.unstubAllGlobals();
      }
      const out = lines.join("\n");
      expect(out).toContain("lookup failed");
      expect(out).not.toContain("alice@example.com");
      expect(out).toContain("[REDACTED]");
    }
  });

  it("carries no deny-listed field to the span event the tracer logger writes", async () => {
    const spans: Tracer.NativeSpan[] = [];
    const recording = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    sinks();
    try {
      await logWithCause(
        Layer.merge(
          makeLoggerLayer(loadConfig({ serviceName: "test", env: "production" })),
          Layer.succeed(Tracer.Tracer)(recording),
        ),
      );
    } finally {
      afterAllRestore();
    }
    const events = spans.flatMap((span) => span.events);
    expect(events).toHaveLength(1);
    const text = JSON.stringify(events, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    );
    expect(text).toContain("LookupFailed");
    expect(text).not.toContain("alice@example.com");
  });
});

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

  it("turns a log line inside a span into a span event carrying the redacted message and annotations", async () => {
    // `Logger.layer` REPLACES the whole set, so dropping the tracer logger from
    // the list costs log-to-span correlation with no error and no failing
    // type-check. The tracer logger copies a line's message and annotations
    // onto the span, which the Bun OTLP path exports, so it must see them
    // redacted like every other sink. Both layers that ship a logger are checked.
    const eventsFor = async (layer: typeof PrettyLoggerLive) => {
      const spans: Tracer.NativeSpan[] = [];
      const recording = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      await capture(() =>
        Effect.runPromise(
          Effect.logInfo("guest looked up", { email: "alice@example.com" }).pipe(
            Effect.annotateLogs({ accessToken: "eyJ-secret", profileId: "u_123" }),
            Effect.withSpan("probe.span"),
            Effect.provide(Layer.merge(layer, Layer.succeed(Tracer.Tracer)(recording))),
          ),
        ),
      );
      return spans.flatMap((span) => span.events);
    };

    for (const layer of [
      PrettyLoggerLive,
      makeLoggerLayer(loadConfig({ serviceName: "test", env: "production" })),
    ]) {
      const events = await eventsFor(layer);
      expect(events).toHaveLength(1);
      const [name, , attributes] = events[0]!;
      expect(name).toContain("guest looked up");
      expect(name).not.toContain("alice@example.com");
      expect(attributes["accessToken"]).toBe("[REDACTED]");
      expect(attributes["profileId"]).toBe("u_123");
    }
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
});

describe("makeTracingLayer sampling", () => {
  // A local collector that accepts every OTLP POST and records its path.
  // Releasing the layer flushes the span processor and the metric reader; an
  // endpoint that refused connections would make both retry up to the
  // shutdown cap on every test.
  let server: Server;
  let endpoint: string;
  const posted: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      posted.push(req.url ?? "");
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    posted.length = 0;
  });

  // Runs one root span under the layer the Bun entry points install, releases
  // the layer so everything sampled is exported, and returns the sampling
  // decision the span carried.
  const rootSpanSampled = async (traceSampleRatio: number): Promise<boolean> => {
    const config: ObservabilityConfig = {
      ...loadConfig({ serviceName: "test", env: "dev" }),
      otlpEndpoint: endpoint,
      traceSampleRatio,
    };
    const runtime = ManagedRuntime.make(makeTracingLayer(config));
    try {
      return await runtime.runPromise(
        Effect.currentSpan.pipe(
          Effect.map((span) => span.sampled),
          Effect.withSpan("probe.root"),
        ),
      );
    } finally {
      await runtime.dispose();
    }
  };

  it("samples and exports no root trace at a ratio of 0", async () => {
    expect(await rootSpanSampled(0)).toBe(false);
    expect(posted.filter((path) => path === "/v1/traces")).toEqual([]);
  });

  it("samples and exports every root trace at a ratio of 1", async () => {
    // Also proves the ratio-0 result is the sampler's: Effect's no-op span
    // reports `sampled: false` as well, and exports nothing.
    expect(await rootSpanSampled(1)).toBe(true);
    expect(posted).toContain("/v1/traces");
  });
});
