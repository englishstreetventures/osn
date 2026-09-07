import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { DeploymentEnvironment } from "../src/config";
import { loadConfig } from "../src/config";
import { initObservability, makeObservabilityLayer } from "../src/index";
import { makeLoggerLayer } from "../src/logger/layer";
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
  // nothing at the layer level — which is how the key-vs-value bug survived.
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

    // Both are on the deny-list in redact.ts. Neither was redacted before the
    // key check went in: the logger mapped over each annotation VALUE, and
    // `redact` matches an object's KEYS, so a bare string arrived with no key
    // attached and passed straight through.
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
