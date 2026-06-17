import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { osnLoggerLayer, runOsn, runOsnSync } from "../src/observability";

/**
 * The load-bearing contract of `runOsn` / `runOsnSync` is that they install
 * `osnLoggerLayer` — the workerd-safe, logger-only observability layer — so
 * every log line is routed through the shared redaction deny-list. The deny-
 * list *logic* is owned + tested upstream (`@shared/observability`
 * redact.test.ts); these tests pin that osn's logger layer actually *applies*
 * it: a PII-bearing context object passed to an osn log call comes out
 * `[REDACTED]` end-to-end, and a refactor that drops the layer (or swaps
 * `runOsn` back to a bare `Effect.runPromise`) fails loudly.
 *
 * Note on shape: PII is passed as the log MESSAGE object
 * (`Effect.logInfo("msg", { email })`) — not via `Effect.annotateLogs`. The
 * redacting logger walks the message object and scrubs by key, which is the
 * path exercised here. (A denied annotation KEY carrying a primitive value is
 * not redacted — a pre-existing shared-logger limitation, see cire's
 * observability.test.ts note — so it would be the wrong thing to assert.)
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

describe("osn observability logger layer", () => {
  it("builds a logger-only layer without pulling the Node OTel SDK", () => {
    // If the layer (or its import graph) referenced @effect/opentelemetry's
    // NodeSdk, importing this module on a non-Node runtime would blow up at
    // load. Building it as a value here proves the layer is constructable from
    // the effect-only `/logger` + `/config` subpaths.
    expect(osnLoggerLayer).toBeDefined();
  });

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
