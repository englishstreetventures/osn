/**
 * Unit tests for the OIDC browser-binding cookie helpers (S-M1 oidc).
 *
 * The route tests only run under the non-secure local config, so the
 * `__Host-` secure branch — the one production uses — is pinned here: name
 * prefix, Secure attribute on set AND clear, and the set/read/clear naming
 * contract staying in lockstep. Mirrors `cookie-session.test.ts`.
 */

import { describe, it, expect } from "vitest";

import {
  buildBindingCookie,
  buildClearBindingCookie,
  readBindingCookie,
} from "../../src/lib/oidc-binding-cookie";

const REQUEST_ID = "oar_0123456789ab";
const SECRET = "oab_test_secret_value";

describe("buildBindingCookie", () => {
  it("builds a non-secure cookie for local dev", () => {
    const cookie = buildBindingCookie(REQUEST_ID, SECRET, { secure: false });
    expect(cookie).toBe(`osn_${REQUEST_ID}=${SECRET}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);
    expect(cookie).not.toContain("Secure");
  });

  it("builds a secure cookie with the __Host- prefix and no Domain", () => {
    const cookie = buildBindingCookie(REQUEST_ID, SECRET, { secure: true });
    expect(cookie).toContain(`__Host-osn_${REQUEST_ID}=${SECRET}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("Secure");
    // __Host- forbids a Domain attribute — adding one silently kills the cookie.
    expect(cookie).not.toContain("Domain");
  });
});

describe("buildClearBindingCookie", () => {
  it("clears with Max-Age=0 under the same non-secure name", () => {
    const cookie = buildClearBindingCookie(REQUEST_ID, { secure: false });
    expect(cookie).toBe(`osn_${REQUEST_ID}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  });

  it("clears under the same __Host- name with Secure", () => {
    const cookie = buildClearBindingCookie(REQUEST_ID, { secure: true });
    expect(cookie).toContain(`__Host-osn_${REQUEST_ID}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
  });
});

describe("readBindingCookie", () => {
  it("round-trips what buildBindingCookie set, secure and non-secure", () => {
    for (const secure of [false, true]) {
      const setCookie = buildBindingCookie(REQUEST_ID, SECRET, { secure });
      const header = setCookie.split(";")[0]!;
      expect(readBindingCookie(header, REQUEST_ID, { secure })).toBe(SECRET);
    }
  });

  it("returns null for a missing header", () => {
    expect(readBindingCookie(undefined, REQUEST_ID, { secure: false })).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(readBindingCookie(`osn_${REQUEST_ID}=`, REQUEST_ID, { secure: false })).toBeNull();
  });

  it("finds the binding among other cookies", () => {
    const header = `osn_session=ses_x; osn_${REQUEST_ID}=${SECRET}; other=1`;
    expect(readBindingCookie(header, REQUEST_ID, { secure: false })).toBe(SECRET);
  });

  it("does not read another request's binding", () => {
    const header = `osn_oar_ffffffffffff=${SECRET}`;
    expect(readBindingCookie(header, REQUEST_ID, { secure: false })).toBeNull();
  });

  it("does not read a non-secure cookie under the secure config", () => {
    const header = `osn_${REQUEST_ID}=${SECRET}`;
    expect(readBindingCookie(header, REQUEST_ID, { secure: true })).toBeNull();
  });
});
