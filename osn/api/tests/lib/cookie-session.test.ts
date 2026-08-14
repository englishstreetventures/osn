import { describe, it, expect } from "vitest";

import {
  buildClearSessionCookie,
  buildClearSessionCookies,
  buildClearSessionMarkerCookie,
  buildSessionCookie,
  buildSessionCookies,
  buildSessionMarkerCookie,
  cookieName,
  readSessionCookie,
  SESSION_COOKIE_NAMES,
  SESSION_MARKER_COOKIE_NAME,
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

describe("buildSessionMarkerCookie", () => {
  it("is readable by JS — never HttpOnly", () => {
    const cookie = buildSessionMarkerCookie({ secure: true, markerDomain: "musubi.social" });
    expect(cookie).not.toContain("HttpOnly");
  });

  it("carries the marker value and a 30-day Max-Age", () => {
    const cookie = buildSessionMarkerCookie({ secure: false });
    expect(cookie).toContain(`${SESSION_MARKER_COOKIE_NAME}=1`);
    expect(cookie).toContain("Max-Age=2592000");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("sets Domain only when configured, so the apex app can read it", () => {
    expect(buildSessionMarkerCookie({ secure: true, markerDomain: "musubi.social" })).toContain(
      "Domain=musubi.social",
    );
    expect(buildSessionMarkerCookie({ secure: false })).not.toContain("Domain=");
  });

  it("sets Secure only in non-local envs", () => {
    expect(buildSessionMarkerCookie({ secure: true })).toContain("Secure");
    expect(buildSessionMarkerCookie({ secure: false })).not.toContain("Secure");
  });

  it("never takes a __Host-/__Secure- prefix — a prefix would forbid Domain", () => {
    const cookie = buildSessionMarkerCookie({ secure: true, markerDomain: "musubi.social" });
    expect(cookie.startsWith(`${SESSION_MARKER_COOKIE_NAME}=`)).toBe(true);
  });

  it("drops a domain that is not a bare hostname (S-L2)", () => {
    // The value is interpolated straight into a response header. `;` or CR/LF
    // would splice attributes onto the cookie — HttpOnly, a foreign Domain, a
    // second cookie entirely. It comes from wrangler.toml today, which is why
    // this is low and not high, but the check costs one regex and survives the
    // day the value comes from somewhere else.
    const spliced = buildSessionMarkerCookie({
      secure: true,
      markerDomain: "musubi.social; HttpOnly",
    });
    expect(spliced).not.toContain("Domain=");
    expect(spliced).not.toContain("HttpOnly");

    expect(
      buildSessionMarkerCookie({ secure: true, markerDomain: "evil\r\nSet-Cookie: a=b" }),
    ).not.toContain("Domain=");

    // Fail CLOSED, not open: a host-only marker costs a cold-start sign-in on a
    // split-host deployment. A spliced header is a defect.
    expect(buildSessionMarkerCookie({ secure: true, markerDomain: "dev.musubi.social" })).toContain(
      "Domain=dev.musubi.social",
    );
  });
});

describe("buildClearSessionMarkerCookie", () => {
  it("expires the marker with an empty value", () => {
    const cookie = buildClearSessionMarkerCookie({ secure: false });
    expect(cookie).toContain(`${SESSION_MARKER_COOKIE_NAME}=;`);
    expect(cookie).toContain("Max-Age=0");
  });

  it("matches the setter's attributes, or the browser keeps the old cookie", () => {
    const config = { secure: true, markerDomain: "musubi.social" };
    const set = buildSessionMarkerCookie(config);
    const clear = buildClearSessionMarkerCookie(config);
    for (const attr of ["SameSite=Lax", "Path=/", "Domain=musubi.social", "Secure"]) {
      expect(set).toContain(attr);
      expect(clear).toContain(attr);
    }
  });
});

describe("buildSessionCookies", () => {
  it("returns the session cookie and its marker, in that order", () => {
    const config = { secure: true, markerDomain: "musubi.social" };
    expect(buildSessionCookies("ses_abc123", config)).toEqual([
      buildSessionCookie("ses_abc123", config),
      buildSessionMarkerCookie(config),
    ]);
  });

  it("keeps the secret in the HttpOnly cookie only", () => {
    const [session, marker] = buildSessionCookies("ses_abc123", { secure: true });
    expect(session).toContain("HttpOnly");
    expect(session).toContain("ses_abc123");
    expect(marker).not.toContain("ses_abc123");
  });
});

describe("buildClearSessionCookies", () => {
  it("clears both cookies", () => {
    const config = { secure: true, markerDomain: "musubi.social" };
    expect(buildClearSessionCookies(config)).toEqual([
      buildClearSessionCookie(config),
      buildClearSessionMarkerCookie(config),
    ]);
  });
});
