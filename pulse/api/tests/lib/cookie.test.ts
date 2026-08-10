import { describe, expect, it } from "vitest";

import {
  buildOidcTxCookie,
  buildWebSessionCookie,
  clearOidcTxCookie,
  clearWebSessionCookie,
  hasWebSessionCookie,
  parseOidcTxCookie,
  parseWebSessionToken,
} from "../../src/lib/cookie";

// The codec itself lives in `@shared/osn-auth-client/cookie` and is tested
// there. What is Pulse's own is the pair of NAMES and the host-scoping
// promise — a stray `Domain=` here would widen the session cookie to every
// sibling subdomain, and a renamed cookie would sign every browser out.

describe("pulse_web_session", () => {
  it("is host-scoped, HttpOnly, Lax and carries the token", () => {
    const cookie = buildWebSessionCookie("tok_abc123", { secure: true, maxAgeSeconds: 604_800 });
    expect(cookie).toContain("pulse_web_session=tok_abc123");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).toContain("Secure");
    // Host-scoped: the API host sets it, only the API host receives it back.
    expect(cookie).not.toContain("Domain=");
  });

  it("drops Secure on a plaintext local tier", () => {
    const cookie = buildWebSessionCookie("tok_abc123", { secure: false, maxAgeSeconds: 60 });
    expect(cookie).not.toContain("Secure");
  });

  it("clears with matching attributes and Max-Age=0", () => {
    const cookie = clearWebSessionCookie({ secure: true });
    expect(cookie).toContain("pulse_web_session=;");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).not.toContain("Domain=");
  });

  it("parses its own value back out of a multi-cookie header", () => {
    expect(parseWebSessionToken("other=1; pulse_web_session=tok_abc123; last=2")).toBe(
      "tok_abc123",
    );
  });

  it("returns null for no header, a missing cookie, or an emptied one", () => {
    expect(parseWebSessionToken(null)).toBeNull();
    expect(parseWebSessionToken("other=1")).toBeNull();
    expect(parseWebSessionToken("pulse_web_session=")).toBeNull();
  });

  it("does not confuse a prefix-sharing cookie name for the session", () => {
    expect(parseWebSessionToken("pulse_web_session_old=tok_abc123")).toBeNull();
  });

  it("hasWebSessionCookie is the origin guard's presence signal", () => {
    expect(hasWebSessionCookie("pulse_web_session=tok_abc123")).toBe(true);
    expect(hasWebSessionCookie("pulse_oidc_tx=payload.sig")).toBe(false);
    expect(hasWebSessionCookie(null)).toBe(false);
  });
});

describe("pulse_oidc_tx", () => {
  it("round-trips the dotted `<payload>.<hmac>` value", () => {
    const value = "eyJhIjoiYiJ9.c2lnbmF0dXJl";
    const cookie = buildOidcTxCookie(value, { secure: true, maxAgeSeconds: 600 });
    expect(cookie).toContain(`pulse_oidc_tx=${value}`);
    expect(cookie).toContain("Max-Age=600");
    expect(parseOidcTxCookie(cookie.split(";")[0] ?? "")).toBe(value);
  });

  it("clears independently of the session cookie", () => {
    const cookie = clearOidcTxCookie({ secure: false });
    expect(cookie).toContain("pulse_oidc_tx=;");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).not.toContain("pulse_web_session");
  });

  it("rejects a value that would corrupt the Set-Cookie header", () => {
    expect(() =>
      buildOidcTxCookie("evil; Domain=example.com", { secure: true, maxAgeSeconds: 60 }),
    ).toThrow(TypeError);
  });

  it("is a different cookie from the session — neither parser reads the other", () => {
    const header = "pulse_web_session=tok_abc123; pulse_oidc_tx=payload.sig";
    expect(parseWebSessionToken(header)).toBe("tok_abc123");
    expect(parseOidcTxCookie(header)).toBe("payload.sig");
  });
});
