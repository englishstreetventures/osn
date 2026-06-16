import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import { runCire, runCireSync } from "./observability";

/**
 * T-U1: the load-bearing contract of `runCire` / `runCireSync` is that they
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
 * exercised here. (Annotation VALUES are redacted by the shared logger too, but
 * a denied annotation KEY carrying a primitive is not — a pre-existing shared
 * limitation cire does not exercise; tracked as a follow-up.)
 */

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
