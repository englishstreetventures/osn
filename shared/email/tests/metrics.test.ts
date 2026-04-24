import { describe, it, expect } from "vitest";

import { classifyHttpStatus, EMAIL_METRICS } from "../src/metrics";

/**
 * The metric recording helpers (`metricEmailSendAttempt`, ...) are exercised
 * end-to-end via `cloudflare.test.ts` + `log.test.ts`. These tests lock the
 * two pieces that don't surface on that path: the `classifyHttpStatus`
 * boundary behaviour (cardinality-critical) and the canonical metric names
 * (dashboards + alerts reference them as string literals).
 */

describe("classifyHttpStatus", () => {
  // The function maps real HTTP codes to a fixed {2xx|4xx|5xx|network}
  // union. Any regression here changes dashboard cardinality or silently
  // re-classifies failures, so the boundary values are pinned:
  const cases: Array<{ status: number; expected: ReturnType<typeof classifyHttpStatus> }> = [
    // 2xx
    { status: 200, expected: "2xx" },
    { status: 202, expected: "2xx" },
    { status: 299, expected: "2xx" },
    // below 2xx → "network" (informational / unexpected)
    { status: 0, expected: "network" },
    { status: 100, expected: "network" },
    { status: 199, expected: "network" },
    // 3xx is intentionally not a bucket — CloudflareEmailLive uses
    // `response.ok` + the 429/5xx branches, so 3xx arriving here means
    // something unusual happened and we keep cardinality bounded by
    // dropping it into "network".
    { status: 300, expected: "network" },
    { status: 399, expected: "network" },
    // 4xx
    { status: 400, expected: "4xx" },
    { status: 422, expected: "4xx" },
    { status: 429, expected: "4xx" },
    { status: 499, expected: "4xx" },
    // 5xx
    { status: 500, expected: "5xx" },
    { status: 503, expected: "5xx" },
    { status: 599, expected: "5xx" },
    // above 5xx → "network" again
    { status: 600, expected: "network" },
    { status: 999, expected: "network" },
    // negative status (some HTTP libraries use -1 for "no response")
    { status: -1, expected: "network" },
  ];
  for (const { status, expected } of cases) {
    it(`${String(status)} → ${expected}`, () => {
      expect(classifyHttpStatus(status)).toBe(expected);
    });
  }
});

describe("EMAIL_METRICS canonical names", () => {
  // Grafana panels + alerts reference these strings. A rename is a breaking
  // change for ops, not just for code — pin the exact literals so the
  // rename has to go through review.
  it("are the documented `osn.email.*` names", () => {
    expect(EMAIL_METRICS).toEqual({
      sendAttempts: "osn.email.send.attempts",
      sendDuration: "osn.email.send.duration",
      renderDuration: "osn.email.render.duration",
      dispatchStatus: "osn.email.dispatch.http_status",
    });
  });
});
