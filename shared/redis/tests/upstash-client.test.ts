import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for the security-relevant constructor flag (T-S1).
 *
 * `createUpstashClient` MUST construct `@upstash/redis`'s `Redis` with
 * `automaticDeserialization: false`. Without it, `get` JSON-parses values, so an
 * opaque session family-id like "42" comes back as the number 42 and the
 * `=== familyId` string compare in the rotated-session-store silently fails —
 * breaking reuse detection. The `wrapUpstash` contract tests exercise behaviour
 * against a fake; this test asserts the real client is wired with the flag.
 *
 * `@upstash/redis` is mocked so no network/credentials are needed and we can
 * assert the exact constructor arguments — mirroring the `toHaveBeenCalledWith`
 * style used for `set`'s `{ px }` in `upstash.test.ts`.
 */

// `vi.mock` is hoisted above the module body, so the mock fn must be created
// inside `vi.hoisted` to exist before the factory runs.
const { RedisMock } = vi.hoisted(() => ({
  // A spy whose implementation is a plain (non-arrow) function so it is usable
  // with `new` (the adapter calls `new Redis(config)`).
  RedisMock: vi.fn(function RedisMockImpl(this: Record<string, unknown>) {
    this.eval = vi.fn();
    this.ping = vi.fn();
    this.get = vi.fn();
    this.set = vi.fn();
    this.del = vi.fn();
  }),
}));

vi.mock("@upstash/redis", () => ({
  Redis: RedisMock,
}));

// Import after the mock is registered so the module picks up the mocked `Redis`.
import { createUpstashClient } from "../src/upstash";

describe("createUpstashClient", () => {
  beforeEach(() => {
    RedisMock.mockClear();
  });

  it("constructs Redis with automaticDeserialization disabled (raw strings)", () => {
    createUpstashClient({ url: "https://example.upstash.io", token: "tok" });

    expect(RedisMock).toHaveBeenCalledWith({
      url: "https://example.upstash.io",
      token: "tok",
      automaticDeserialization: false,
    });
  });
});
