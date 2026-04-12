import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config";

/** Isolate env mutations so tests don't leak into each other. */
const savedEnv: Record<string, string | undefined> = {};
const OSN_KEYS = [
  "OSN_ENV",
  "NODE_ENV",
  "OSN_SERVICE_NAME",
  "OSN_SERVICE_VERSION",
  "OSN_LOG_LEVEL",
  "OSN_TRACE_SAMPLE_RATIO",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
];

describe("loadConfig", () => {
  beforeEach(() => {
    for (const k of OSN_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of OSN_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("defaults to dev env when nothing is set", () => {
    const cfg = loadConfig();
    expect(cfg.env).toBe("dev");
    expect(cfg.logLevel).toBe("info");
    expect(cfg.otlpEndpoint).toBeUndefined();
    expect(cfg.traceSampleRatio).toBe(1.0); // dev default
    expect(cfg.serviceNamespace).toBe("osn");
  });

  it("reads OSN_ENV=production and tightens sample ratio", () => {
    process.env.OSN_ENV = "production";
    const cfg = loadConfig();
    expect(cfg.env).toBe("production");
    expect(cfg.traceSampleRatio).toBe(0.1);
  });

  it("respects OSN_TRACE_SAMPLE_RATIO override", () => {
    process.env.OSN_ENV = "production";
    process.env.OSN_TRACE_SAMPLE_RATIO = "0.5";
    const cfg = loadConfig();
    expect(cfg.traceSampleRatio).toBe(0.5);
  });

  it("clamps invalid sample ratio to env default", () => {
    process.env.OSN_ENV = "production";
    process.env.OSN_TRACE_SAMPLE_RATIO = "99";
    const cfg = loadConfig();
    expect(cfg.traceSampleRatio).toBe(0.1); // fell back to prod default
  });

  it("parses OTEL_EXPORTER_OTLP_HEADERS", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer xyz,x-tenant=acme";
    const cfg = loadConfig();
    expect(cfg.otlpHeaders).toEqual({
      authorization: "Bearer xyz",
      "x-tenant": "acme",
    });
  });

  // S-M1: strict header parser
  it("rejects OTEL_EXPORTER_OTLP_HEADERS with CRLF in values", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "authorization=Bearer\r\nX-Evil: injected";
    expect(() => loadConfig()).toThrow(/invalid value/);
  });

  it("rejects OTEL_EXPORTER_OTLP_HEADERS with control chars in key", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-bad header=ok";
    expect(() => loadConfig()).toThrow(/invalid header name/);
  });

  it("rejects OTEL_EXPORTER_OTLP_HEADERS with a colon in the key", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "x-bad:key=ok";
    expect(() => loadConfig()).toThrow(/invalid header name/);
  });

  // S-L3: production env mismatch guard
  it("throws when OSN_ENV=production but the override disagrees", () => {
    process.env.OSN_ENV = "production";
    expect(() => loadConfig({ env: "dev" })).toThrow(/production/);
  });

  it("does not throw when OSN_ENV is unset and override is dev", () => {
    expect(() => loadConfig({ env: "dev" })).not.toThrow();
  });

  it("uses overrides over env", () => {
    process.env.OSN_SERVICE_NAME = "env-name";
    const cfg = loadConfig({ serviceName: "override-name", serviceVersion: "9.9.9" });
    expect(cfg.serviceName).toBe("override-name");
    expect(cfg.serviceVersion).toBe("9.9.9");
  });

  it("builds a stable service.instance.id", () => {
    const a = loadConfig({ serviceName: "svc-a" });
    const b = loadConfig({ serviceName: "svc-b" });
    expect(a.serviceInstanceId).toContain("svc-a");
    expect(b.serviceInstanceId).toContain("svc-b");
    expect(a.serviceInstanceId).not.toBe(b.serviceInstanceId);
  });

  it("parses OSN_LOG_LEVEL", () => {
    process.env.OSN_LOG_LEVEL = "debug";
    expect(loadConfig().logLevel).toBe("debug");
    process.env.OSN_LOG_LEVEL = "junk";
    expect(loadConfig().logLevel).toBe("info");
  });
});
