import { afterEach, describe, expect, it } from "bun:test";

import { installWorkersTracing } from "@shared/observability/tracing";
import { Effect } from "effect";

import handler, { type Env } from "../src/index";
import { runCire, runCireSync } from "../src/observability";
import { captureLogs } from "./test-helpers/capture-logs";

/**
 * The load-bearing contract of `runCire` / `runCireSync` is that they
 * install `cireLoggerLayer`, so every log line is routed through the shared
 * redaction deny-list. The deny-list *logic* is owned + tested upstream
 * (`@shared/observability` redact.test.ts); these tests pin that cire actually
 * *applies* it — i.e. a PII-bearing context object passed to a cire log call
 * comes out `[REDACTED]` end-to-end, and a refactor that drops the layer (or
 * swaps `runCire` back to a bare `Effect.runPromise`) fails loudly.
 *
 * Note on shape: cire logs context as the log message argument
 * (`Effect.logError("msg", { weddingId })`) — never via `Effect.annotateLogs`.
 * `redact()` walks that message object and scrubs by key, which is the path
 * exercised here.
 */
describe("runCire / runCireSync redaction wiring", () => {
  it("scrubs PII keys in a cire log message object", async () => {
    const out = await captureLogs(() =>
      runCire(
        Effect.logInfo("guest claimed invite", {
          firstName: "Ivy",
          cire_session: "ses_raw_secret_value",
          publicId: "SHARMA-IVY-QM42",
          weddingId: "wed_loggable",
        }),
      ),
    );

    // Sensitive values must never reach the log output.
    expect(out).not.toContain("Ivy");
    expect(out).not.toContain("ses_raw_secret_value");
    expect(out).not.toContain("SHARMA-IVY-QM42");
    // The deny-list placeholder proves redaction actually ran.
    expect(out).toContain("[REDACTED]");
    // Non-PII operational context still passes through (negative control).
    expect(out).toContain("wed_loggable");
  });

  it("applies the same redaction on the synchronous path (app.ts onError / local.ts)", async () => {
    const out = await captureLogs(() =>
      runCireSync(
        Effect.logError("unhandled request error", { dietary: "coeliac", weddingId: "wed_sync" }),
      ),
    );

    expect(out).not.toContain("coeliac");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("wed_sync");
  });
});

/**
 * The Worker's `fetch` and `scheduled` install their `ctx.tracing` as the
 * Workers trace mirror, and a span run through `runCire` (the runtime every
 * route and cron sweep uses) then reaches it. Drop the install from either
 * handler, or `WorkersTracingLive` from `cireLoggerLayer`, and a test fails.
 */
describe("cire Workers trace mirror", () => {
  afterEach(() => {
    installWorkersTracing(undefined);
  });

  /** A stand-in for `ctx.tracing` that records the names of the spans it opens. */
  const recordingContext = () => {
    const opened: string[] = [];
    const tracing = {
      startSpan: (name: string) => {
        opened.push(name);
        return { isTraced: true, setAttribute: () => undefined, end: () => undefined };
      },
    };
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      tracing,
    } as unknown as ExecutionContext;
    return { ctx, opened };
  };

  const spanOnRunCire = () => runCire(Effect.void.pipe(Effect.withSpan("probe.cire")));

  it("fetch installs ctx.tracing, and a span through runCire reaches it", async () => {
    const { ctx, opened } = recordingContext();
    // No DB: answered 503 before any binding is used.
    const res = await handler.fetch!(
      new Request("https://api.example.test/") as Parameters<NonNullable<typeof handler.fetch>>[0],
      {} as Env,
      ctx,
    );
    expect(res.status).toBe(503);

    await spanOnRunCire();
    expect(opened).toEqual(["probe.cire"]);
  });

  it("scheduled installs ctx.tracing, and a span through runCire reaches it", async () => {
    const { ctx, opened } = recordingContext();
    // No DB: returns before any sweep.
    await handler.scheduled!({} as ScheduledController, {} as Env, ctx);

    await spanOnRunCire();
    expect(opened).toEqual(["probe.cire"]);
  });
});
