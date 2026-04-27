import { Effect } from "effect";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { streamPulseExport, streamZapExport } from "../../src/services/exportBridges";

/**
 * T-M2 — coverage for the osn/api → pulse/api / zap/api ARC bridges.
 *
 * The bridge must produce a `{degraded, reason}` line on every failure
 * mode and never throw — the orchestrator depends on this contract to
 * downgrade the bundle decision to `partial` rather than aborting the
 * whole stream. We exercise each branch by pointing the bridge at a
 * tiny in-process Bun.serve fixture (the `url` override on `BridgeOpts`).
 */

const ENV_KEY = "INTERNAL_SERVICE_SECRET";

let savedSecret: string | undefined;
beforeEach(() => {
  savedSecret = process.env[ENV_KEY];
  process.env[ENV_KEY] = "test-internal-secret";
});
afterEach(() => {
  if (savedSecret === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedSecret;
});

interface MockServer {
  url: string;
  close: () => void;
}

function startMock(handler: (req: Request) => Response | Promise<Response>): MockServer {
  // Bun.serve picks a free port on `port: 0`. Each test gets its own.
  const server = Bun.serve({ port: 0, fetch: handler });
  return {
    url: `http://localhost:${server.port}/account-export/internal`,
    close: () => server.stop(true),
  };
}

const drain = async (
  iter: AsyncIterable<{ raw: string }>,
): Promise<Array<Record<string, unknown>>> => {
  const out: Array<Record<string, unknown>> = [];
  for await (const l of iter) out.push(JSON.parse(l.raw) as Record<string, unknown>);
  return out;
};

describe("streamPulseExport bridge", () => {
  it("yields a `degraded: pulse` line when INTERNAL_SERVICE_SECRET is unset", async () => {
    delete process.env[ENV_KEY];
    const stream = await Effect.runPromise(
      streamPulseExport({ profileIds: [], url: "http://does-not-matter" }),
    );
    const lines = await drain(stream);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      degraded: "pulse",
      reason: "internal_service_secret_unset",
    });
  });

  it("forwards downstream NDJSON lines verbatim and reports outcome=ok", async () => {
    const mock = startMock(() => {
      const body =
        JSON.stringify({ source: "pulse-api", profileCount: 1 }) +
        "\n" +
        JSON.stringify({ section: "pulse.rsvps", row: { id: "rsvp_a" } }) +
        "\n" +
        JSON.stringify({ end: true }) +
        "\n";
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    });
    try {
      const stream = await Effect.runPromise(
        streamPulseExport({ profileIds: ["usr_a"], url: mock.url }),
      );
      const lines = await drain(stream);
      const sections = lines.map((l) => l.section ?? null).filter((s): s is string => !!s);
      expect(sections).toContain("pulse.rsvps");
      // No degraded lines at any point.
      expect(lines.find((l) => "degraded" in l)).toBeUndefined();
    } finally {
      mock.close();
    }
  });

  it("yields a `degraded` line on HTTP 500 (outcome=error)", async () => {
    const mock = startMock(() => new Response("oops", { status: 500 }));
    try {
      const stream = await Effect.runPromise(
        streamPulseExport({ profileIds: ["usr_a"], url: mock.url }),
      );
      const lines = await drain(stream);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ degraded: "pulse", reason: "http_500" });
    } finally {
      mock.close();
    }
  });

  it("yields `degraded: empty_response` when the downstream returns an empty body", async () => {
    const mock = startMock(() => new Response("", { status: 200 }));
    try {
      const stream = await Effect.runPromise(
        streamPulseExport({ profileIds: ["usr_a"], url: mock.url }),
      );
      const lines = await drain(stream);
      // Empty body → no rows seen → bridge appends a tombstone.
      expect(lines.find((l) => l.reason === "empty_response")).toBeDefined();
    } finally {
      mock.close();
    }
  });

  it("propagates an in-band `degraded` line from the downstream service", async () => {
    const mock = startMock(() => {
      const body =
        JSON.stringify({ source: "pulse-api", profileCount: 1 }) +
        "\n" +
        JSON.stringify({ degraded: "pulse", reason: "stream_error" }) +
        "\n";
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    });
    try {
      const stream = await Effect.runPromise(
        streamPulseExport({ profileIds: ["usr_a"], url: mock.url }),
      );
      const lines = await drain(stream);
      // The bridge re-emits the in-band degraded line so the orchestrator
      // can detect it and flip the bundle decision to "partial".
      expect(
        lines.find((l) => l.degraded === "pulse" && l.reason === "stream_error"),
      ).toBeDefined();
    } finally {
      mock.close();
    }
  });

  it("yields `degraded: network_error` when the URL is unreachable", async () => {
    const stream = await Effect.runPromise(
      streamPulseExport({
        profileIds: ["usr_a"],
        // Port 1 is reserved & nothing listens there → ECONNREFUSED.
        url: "http://127.0.0.1:1/account-export/internal",
      }),
    );
    const lines = await drain(stream);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ degraded: "pulse" });
    // Could be either `network_error` (ECONNREFUSED) or `timeout` if the
    // host stack is slow — both are acceptable failure modes here.
    expect(["network_error", "timeout"]).toContain(lines[0].reason);
  });
});

describe("streamZapExport bridge", () => {
  // We only need one happy-path test for zap — the bridge implementation
  // is shared between pulse + zap, all the other branches are covered
  // by the pulse suite above.
  it("forwards Zap NDJSON verbatim with a clean outcome", async () => {
    const mock = startMock(() => {
      const body =
        JSON.stringify({ source: "zap-api", profileCount: 1 }) +
        "\n" +
        JSON.stringify({
          section: "zap.chats_advisory",
          row: { excluded: "messages.ciphertext", reason: "e2e_encrypted" },
        }) +
        "\n" +
        JSON.stringify({ end: true }) +
        "\n";
      return new Response(body, { status: 200 });
    });
    try {
      const stream = await Effect.runPromise(
        streamZapExport({ profileIds: ["usr_a"], url: mock.url }),
      );
      const lines = await drain(stream);
      expect(lines.find((l) => l.section === "zap.chats_advisory")).toBeDefined();
    } finally {
      mock.close();
    }
  });
});

// Module-level beforeAll to ensure bun's `Bun.serve` is available — the
// test file fails fast with a clearer message than letting the first
// `startMock` call throw if for any reason vitest is run under Node.
beforeAll(() => {
  if (typeof Bun === "undefined") {
    throw new Error("export-bridges tests require the Bun runtime (Bun.serve)");
  }
});
