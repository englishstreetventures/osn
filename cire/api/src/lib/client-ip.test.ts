import { describe, it, expect } from "bun:test";

import { isUnresolvedIp } from "@shared/rate-limit";

import { getClientIp } from "./client-ip";

describe("getClientIp (Cloudflare-only, C4)", () => {
  it("returns the validated cf-connecting-ip", () => {
    const headers = new Headers({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "5.6.7.8",
    });
    expect(getClientIp(headers)).toBe("1.2.3.4");
  });

  it("NEVER falls back to x-forwarded-for — fails closed instead", () => {
    const headers = new Headers({
      "x-forwarded-for": "10.0.0.1, 10.0.0.2",
    });
    const ip = getClientIp(headers);
    expect(isUnresolvedIp(ip)).toBe(true);
  });

  it("fails closed when no cf-connecting-ip is present", () => {
    const ip = getClientIp(new Headers());
    expect(isUnresolvedIp(ip)).toBe(true);
  });

  it("fails closed on a malformed cf-connecting-ip", () => {
    const ip = getClientIp(new Headers({ "cf-connecting-ip": "not-an-ip" }));
    expect(isUnresolvedIp(ip)).toBe(true);
  });
});
