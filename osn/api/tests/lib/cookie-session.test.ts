import { describe, it, expect } from "vitest";

import {
  buildClearSessionCookie,
  buildSessionCookie,
  cookieName,
  readSessionCookie,
  SESSION_COOKIE_NAMES,
} from "../../src/lib/cookie-session";

describe("cookieName", () => {
  it("returns __Host-osn_session when secure", () => {
    expect(cookieName({ secure: true })).toBe("__Host-osn_session");
  });

  it("returns osn_session when not secure", () => {
    expect(cookieName({ secure: false })).toBe("osn_session");
  });
});

describe("SESSION_COOKIE_NAMES", () => {
  it("contains both cookie names", () => {
    expect(SESSION_COOKIE_NAMES).toContain("__Host-osn_session");
    expect(SESSION_COOKIE_NAMES).toContain("osn_session");
  });
});

describe("buildSessionCookie", () => {
  it("builds a non-secure cookie for local dev", () => {
    const cookie = buildSessionCookie("ses_abc123", { secure: false });
    expect(cookie).toBe("osn_session=ses_abc123; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000");
    expect(cookie).not.toContain("Secure");
  });

  it("builds a secure cookie with __Host- prefix", () => {
    const cookie = buildSessionCookie("ses_abc123", { secure: true });
    expect(cookie).toContain("__Host-osn_session=ses_abc123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("Secure");
  });
});

describe("buildClearSessionCookie", () => {
  it("builds a clear cookie with Max-Age=0", () => {
    const cookie = buildClearSessionCookie({ secure: false });
    expect(cookie).toBe("osn_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  });

  it("includes Secure flag when secure", () => {
    const cookie = buildClearSessionCookie({ secure: true });
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("__Host-osn_session=");
  });
});

describe("readSessionCookie", () => {
  const config = { secure: false };

  it("returns null for undefined cookie header", () => {
    expect(readSessionCookie(undefined, config)).toBeNull();
  });

  it("returns null for empty cookie header", () => {
    expect(readSessionCookie("", config)).toBeNull();
  });

  it("extracts token from single cookie", () => {
    expect(readSessionCookie("osn_session=ses_abc", config)).toBe("ses_abc");
  });

  it("extracts token from multi-cookie header", () => {
    const header = "other=value; osn_session=ses_xyz; third=foo";
    expect(readSessionCookie(header, config)).toBe("ses_xyz");
  });

  it("returns null when cookie name not present", () => {
    expect(readSessionCookie("other=value; foo=bar", config)).toBeNull();
  });

  it("returns null for empty value after =", () => {
    expect(readSessionCookie("osn_session=", config)).toBeNull();
  });

  it("handles secure cookie name", () => {
    const secureConfig = { secure: true };
    expect(readSessionCookie("__Host-osn_session=ses_tok", secureConfig)).toBe("ses_tok");
  });

  it("handles token containing =", () => {
    expect(readSessionCookie("osn_session=ses_abc=def", config)).toBe("ses_abc=def");
  });
});
