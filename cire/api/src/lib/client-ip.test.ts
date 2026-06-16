import { describe, it, expect } from "bun:test";

import { getClientIp } from "./client-ip";

describe("getClientIp", () => {
  it("uses cf-connecting-ip (the trusted edge header)", () => {
    const headers = new Headers({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "5.6.7.8",
    });
    expect(getClientIp(headers)).toBe("1.2.3.4");
  });

  it("trims surrounding whitespace on cf-connecting-ip", () => {
    const headers = new Headers({ "cf-connecting-ip": "  9.9.9.9  " });
    expect(getClientIp(headers)).toBe("9.9.9.9");
  });

  it("does NOT trust x-forwarded-for — returns null when only XFF is present (C4)", () => {
    // XFF is client-spoofable; trusting it would let an attacker rotate the
    // rate-limit bucket per request. Must fail closed instead.
    const headers = new Headers({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" });
    expect(getClientIp(headers)).toBeNull();
  });

  it("returns null (fail closed) when no trusted IP header is present", () => {
    const headers = new Headers();
    expect(getClientIp(headers)).toBeNull();
  });

  it("returns null when cf-connecting-ip is present but empty", () => {
    const headers = new Headers({ "cf-connecting-ip": "   " });
    expect(getClientIp(headers)).toBeNull();
  });
});
