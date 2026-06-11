import { describe, it, expect } from "bun:test";

import { buildSessionCookie, clearSessionCookie, parseSessionToken } from "./cookie";

describe("buildSessionCookie", () => {
  it("emits all required attributes for a non-secure cookie", () => {
    const out = buildSessionCookie("abc", { secure: false, maxAgeSeconds: 60 });
    expect(out).toContain("cire_session=abc");
    expect(out).toContain("Path=/");
    expect(out).toContain("HttpOnly");
    expect(out).toContain("SameSite=Lax");
    expect(out).toContain("Max-Age=60");
    expect(out.includes("Secure")).toBe(false);
    expect(out.includes("Domain=")).toBe(false);
  });

  it("appends Secure when requested", () => {
    const out = buildSessionCookie("abc", { secure: true, maxAgeSeconds: 60 });
    expect(out).toContain("Secure");
  });

  it("throws TypeError on a token containing invalid chars", () => {
    expect(() =>
      buildSessionCookie("bad token with spaces", { secure: false, maxAgeSeconds: 60 }),
    ).toThrow(TypeError);
  });

  it("throws TypeError on an empty token", () => {
    expect(() => buildSessionCookie("", { secure: false, maxAgeSeconds: 60 })).toThrow(TypeError);
  });
});

describe("clearSessionCookie", () => {
  it("emits Max-Age=0", () => {
    const out = clearSessionCookie({ secure: false });
    expect(out).toContain("cire_session=");
    expect(out).toContain("Max-Age=0");
    expect(out).toContain("HttpOnly");
    expect(out).toContain("SameSite=Lax");
  });
});

describe("parseSessionToken", () => {
  it("returns null for a null header", () => {
    expect(parseSessionToken(null)).toBeNull();
  });

  it("returns null when cookie is absent", () => {
    expect(parseSessionToken("foo=bar; baz=qux")).toBeNull();
  });

  it("extracts the token when present", () => {
    expect(parseSessionToken("cire_session=abc123")).toBe("abc123");
  });

  it("ignores surrounding cookies", () => {
    expect(parseSessionToken("foo=1; cire_session=abc; bar=2")).toBe("abc");
  });

  it("returns null on empty value", () => {
    expect(parseSessionToken("cire_session=")).toBeNull();
  });
});
