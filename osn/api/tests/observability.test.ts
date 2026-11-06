/**
 * Two contracts of osn's Workers observability layer, `osnLoggerLayer`.
 *
 * Redaction: `runOsn` / `runOsnSync` install it, so every log line is routed
 * through the shared redaction deny-list. The deny-list *logic* is owned +
 * tested upstream (`@shared/observability` redact.test.ts); these tests pin
 * that osn's logger layer actually *applies* it: a PII-bearing context object
 * passed to an osn log call comes out `[REDACTED]` end-to-end, and a refactor
 * that drops the layer (or swaps `runOsn` back to a bare `Effect.runPromise`)
 * fails loudly. PII is passed as the log MESSAGE object
 * (`Effect.logInfo("msg", { email })`), the shape osn's call sites use.
 *
 * Trace mirror: the Worker's `fetch` and `scheduled` install their
 * `ctx.tracing`, and a span run on `osnLoggerLayer` (which `appRuntime` merges
 * and every cron sweep runs on, through `runOsn`) then reaches it. Drop the install from either
 * handler, or `WorkersTracingLive` from the layer, and a test below fails.
 */
import type { ExecutionContext, ScheduledController } from "@cloudflare/workers-types";
import { installWorkersTracing } from "@shared/observability/tracing";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { handler, type Env } from "../src/index";
import { osnLoggerLayer, runOsn, runOsnSync } from "../src/observability";

/**
 * Capture everything Effect's logger writes for one run. Effect's default
 * loggers emit through `globalThis.console`, so we temporarily swap those
 * methods for a sink. (`globalThis.console` is used rather than the bare
 * `console` global so the no-console lint rule — which targets production code
 * — isn't tripped by this test-only interception.)
 */
async function captureLogs(run: () => unknown | Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const sink = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  const c = globalThis.console;
  const original = { log: c.log, info: c.info, warn: c.warn, error: c.error, debug: c.debug };
  Object.assign(c, { log: sink, info: sink, warn: sink, error: sink, debug: sink });
  try {
    await run();
  } finally {
    Object.assign(c, original);
  }
  return lines.join("\n");
}

describe("osn observability logger layer", () => {
  it("scrubs PII keys in an osn log message object (runOsn)", async () => {
    const out = await captureLogs(() =>
      runOsn(
        Effect.logInfo("session issued", {
          email: "ivy@example.com",
          accessToken: "tok_raw_secret_value",
          osn_session: "ses_raw_secret_value",
          profileId: "prof_loggable",
        }),
      ),
    );

    // Sensitive values must never reach the log output.
    expect(out).not.toContain("ivy@example.com");
    expect(out).not.toContain("tok_raw_secret_value");
    expect(out).not.toContain("ses_raw_secret_value");
    // The deny-list placeholder proves redaction actually ran.
    expect(out).toContain("[REDACTED]");
    // Non-PII operational context still passes through (negative control).
    // policy: profileId is loggable (see redact.ts PII note).
    expect(out).toContain("prof_loggable");
  });

  it("applies the same redaction on the synchronous path (runOsnSync)", async () => {
    const out = await captureLogs(() =>
      runOsnSync(
        Effect.logError("unhandled request error", {
          accountId: "acc_secret_principal",
          profileId: "prof_sync",
        }),
      ),
    );

    expect(out).not.toContain("acc_secret_principal");
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("prof_sync");
  });
});

describe("osn Workers trace mirror", () => {
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

  const spanOnLayer = () =>
    Effect.runPromise(
      Effect.void.pipe(Effect.withSpan("probe.osn"), Effect.provide(osnLoggerLayer)),
    );

  it("fetch installs ctx.tracing, and a span on osnLoggerLayer reaches it", async () => {
    const { ctx, opened } = recordingContext();
    // No DB: answered 503 before any binding is used.
    const res = await handler.fetch(new Request("https://api.osn.test/"), {} as Env, ctx);
    expect(res.status).toBe(503);

    await spanOnLayer();
    expect(opened).toEqual(["probe.osn"]);
  });

  it("scheduled installs ctx.tracing, and a span on osnLoggerLayer reaches it", async () => {
    const { ctx, opened } = recordingContext();
    // No DB: returns before any sweep.
    await handler.scheduled({} as ScheduledController, {} as Env, ctx);

    await spanOnLayer();
    expect(opened).toEqual(["probe.osn"]);
  });

  it("a cron run's sweeps open their spans on the mirror", async () => {
    const { ctx, opened } = recordingContext();
    const pending: Promise<unknown>[] = [];
    const cronCtx = {
      ...ctx,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise.catch(() => undefined)),
    } as unknown as ExecutionContext;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      // A stub D1 binding: the sweeps fail inside, after opening their spans.
      await handler.scheduled({} as ScheduledController, { DB: {} } as unknown as Env, cronCtx);
      await Promise.all(pending);
    } finally {
      fetchSpy.mockRestore();
    }

    expect(opened).toEqual(
      expect.arrayContaining(["account.deletion.hard", "auth.session.rotated_sweep"]),
    );
  });

  it("a fetch with no context clears the mirror", async () => {
    const { ctx, opened } = recordingContext();
    await handler.fetch(new Request("https://api.osn.test/"), {} as Env, ctx);
    await handler.fetch(new Request("https://api.osn.test/"), {} as Env);

    await spanOnLayer();
    expect(opened).toEqual([]);
  });
});
