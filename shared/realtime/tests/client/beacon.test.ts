import { afterEach, describe, expect, it, vi } from "vitest";

import { sendFallbackBeacon } from "../../src/client";

const ENDPOINT = "https://api.example.test/api/realtime/fallback";

type RejectionListener = (reason: unknown) => void;

// Bun and Node report a rejection nobody handled through `process`, not the
// DOM's `unhandledrejection` event, and this type program has no Node types.
const runtime = (
  globalThis as unknown as {
    process: {
      on(event: "unhandledRejection", listener: RejectionListener): void;
      off(event: "unhandledRejection", listener: RejectionListener): void;
    };
  }
).process;

/** Long enough for a rejection nobody handled to reach `unhandledRejection`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendFallbackBeacon", () => {
  it.each(["refused", "exhausted"] as const)(
    "posts %s as a plain body, kept alive, with no credentials",
    (outcome) => {
      const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
      vi.stubGlobal("fetch", fetch);

      expect(sendFallbackBeacon(ENDPOINT, outcome)).toBeUndefined();

      expect(fetch.mock.calls).toEqual([
        [ENDPOINT, { method: "POST", body: outcome, keepalive: true, credentials: "omit" }],
      ]);
    },
  );

  it("swallows a rejected request, leaving no unhandled rejection", async () => {
    const unhandled = vi.fn();
    runtime.on("unhandledRejection", unhandled);
    try {
      // A plain function, not `vi.fn`: a mock records how its returned promise
      // settles, which attaches a handler and would hide a missing one here.
      vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
      expect(() => sendFallbackBeacon(ENDPOINT, "refused")).not.toThrow();
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      runtime.off("unhandledRejection", unhandled);
    }
  });

  it("swallows a fetch that throws before it returns (a URL the browser refuses)", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new TypeError("Failed to parse URL");
      }),
    );
    expect(() => sendFallbackBeacon("not a url", "exhausted")).not.toThrow();
  });

  it("does nothing when the runtime has no fetch", () => {
    vi.stubGlobal("fetch", undefined);
    expect(() => sendFallbackBeacon(ENDPOINT, "exhausted")).not.toThrow();
  });
});
