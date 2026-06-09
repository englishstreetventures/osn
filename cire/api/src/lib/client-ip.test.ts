import { describe, it, expect } from "bun:test";

import { getClientIp } from "./client-ip";

describe("getClientIp", () => {
  it("prefers cf-connecting-ip", () => {
    const headers = new Headers({
      "cf-connecting-ip": "1.2.3.4",
      "x-forwarded-for": "5.6.7.8",
    });
    expect(getClientIp(headers)).toBe("1.2.3.4");
  });

  it("falls back to x-forwarded-for first entry", () => {
    const headers = new Headers({
      "x-forwarded-for": "10.0.0.1, 10.0.0.2",
    });
    expect(getClientIp(headers)).toBe("10.0.0.1");
  });

  it("returns unknown when no IP headers present", () => {
    const headers = new Headers();
    expect(getClientIp(headers)).toBe("unknown");
  });
});
