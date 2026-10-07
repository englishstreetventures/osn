import { afterEach, describe, expect, it } from "vitest";

import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  PREFIXED_CONSENT_COOKIE_NAME,
  readConsentCookieValue,
  readConsentFromDocument,
  readConsentRecord,
  serialiseConsentCookie,
  writeConsentToDocumentAndVerify,
} from "../../../src/lib/consent/cookie";
import {
  allGrants,
  defaultGrants,
  encodeConsentRecord,
  makeConsentRecord,
} from "../../../src/lib/consent/record";
import { onSecureOriginWithJar } from "../../test-support/secure-origin";

const NOW = new Date("2026-07-29T10:00:00.000Z");
const record = makeConsentRecord({ ...defaultGrants(), pinterest: true }, NOW);
const encoded = encodeConsentRecord(record);

const OTHER_NOW = new Date("2026-07-30T10:00:00.000Z");
const otherRecord = makeConsentRecord({ ...defaultGrants(), pinterest: false }, OTHER_NOW);
const otherEncoded = encodeConsentRecord(otherRecord);

function readNamed(cookieString: string, name: string): string | null {
  for (const part of cookieString.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function clearBothCookies(): void {
  document.cookie = `${CONSENT_COOKIE_NAME}=; Path=/; Max-Age=0`;
  document.cookie = `${PREFIXED_CONSENT_COOKIE_NAME}=; Path=/; Max-Age=0; Secure`;
}

describe("readConsentCookieValue", () => {
  it("finds the value among other cookies", () => {
    const header = `cire_session=abc123; ${CONSENT_COOKIE_NAME}=${encoded}; other=1`;
    expect(readConsentCookieValue(header, false)).toBe(encoded);
  });

  it("finds the value when it is first or last in the string", () => {
    expect(readConsentCookieValue(`${CONSENT_COOKIE_NAME}=${encoded}; x=1`, false)).toBe(encoded);
    expect(readConsentCookieValue(`x=1; ${CONSENT_COOKIE_NAME}=${encoded}`, false)).toBe(encoded);
  });

  it("returns null when the cookie is absent, empty, or the header is missing", () => {
    expect(readConsentCookieValue("cire_session=abc123", false)).toBeNull();
    expect(readConsentCookieValue("", false)).toBeNull();
    expect(readConsentCookieValue(null, false)).toBeNull();
    expect(readConsentCookieValue(undefined, false)).toBeNull();
  });

  it("does not match a cookie whose name merely CONTAINS the consent name", () => {
    // `not_cire_consent` and `cire_consent_backup` are different cookies; a
    // substring match would let an unrelated value be read as the decision.
    const header = `not_${CONSENT_COOKIE_NAME}=tampered; ${CONSENT_COOKIE_NAME}_backup=stale`;
    expect(readConsentCookieValue(header, false)).toBeNull();
  });

  it("tolerates malformed segments without throwing", () => {
    expect(readConsentCookieValue(`novalue; ; ${CONSENT_COOKIE_NAME}=${encoded}`, false)).toBe(
      encoded,
    );
  });

  // Which name is read depends on the origin, and only one ever is. On https
  // the consent cookie is the `__Host-` one, which a sibling
  // *.cireweddings.com origin cannot set; a bare `cire_consent` there may have
  // been planted by one, so it is never read, however it got there. On http
  // (local dev) `__Host-` cannot be set at all, so the bare name is the cookie.
  describe("which name is read", () => {
    it("reads only the __Host- name on https", () => {
      const header = `${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`;
      expect(readConsentCookieValue(header, true)).toBe(encoded);
    });

    it("ignores a bare cookie on https, alone or beside the __Host- one", () => {
      expect(readConsentCookieValue(`${CONSENT_COOKIE_NAME}=${otherEncoded}`, true)).toBeNull();
      const both = `${CONSENT_COOKIE_NAME}=${otherEncoded}; ${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`;
      expect(readConsentCookieValue(both, true)).toBe(encoded);
    });

    it("reads only the bare name on http", () => {
      expect(readConsentCookieValue(`${CONSENT_COOKIE_NAME}=${encoded}`, false)).toBe(encoded);
      expect(
        readConsentCookieValue(`${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`, false),
      ).toBeNull();
    });

    it("returns null when neither name is present", () => {
      const header = "cire_session=abc123; other=1";
      expect(readConsentCookieValue(header, true)).toBeNull();
      expect(readConsentCookieValue(header, false)).toBeNull();
    });
  });
});

describe("readConsentRecord", () => {
  it("parses a record straight out of a cookie header", () => {
    const parsed = readConsentRecord(`a=1; ${CONSENT_COOKIE_NAME}=${encoded}`, false);
    expect(parsed?.grants.pinterest).toBe(true);
  });

  it("returns null for a header carrying a corrupted value", () => {
    expect(readConsentRecord(`${CONSENT_COOKIE_NAME}=garbage`, false)).toBeNull();
  });
});

describe("serialiseConsentCookie", () => {
  it("scopes the cookie to the whole site with a six-month lifetime", () => {
    const serialised = serialiseConsentCookie(record, false);
    expect(serialised.startsWith(`${CONSENT_COOKIE_NAME}=${encoded}`)).toBe(true);
    expect(serialised).toContain("Path=/");
    expect(serialised).toContain(`Max-Age=${CONSENT_COOKIE_MAX_AGE_SECONDS}`);
    expect(CONSENT_COOKIE_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 182);
  });

  it("uses SameSite=Lax so a guest arriving from the emailed link keeps their decision", () => {
    // SameSite=Strict would withhold the cookie on the cross-site top-level
    // navigation from the couple's email — re-prompting someone who already chose.
    expect(serialiseConsentCookie(record, true)).toContain("SameSite=Lax");
  });

  it("adds Secure on https and omits it otherwise", () => {
    // A Secure cookie is silently dropped on http://localhost, which would make
    // consent look like it doesn't persist in dev while working in production.
    expect(serialiseConsentCookie(record, true)).toContain("; Secure");
    expect(serialiseConsentCookie(record, false)).not.toContain("Secure");
  });

  it("round-trips through a cookie header", () => {
    const serialised = serialiseConsentCookie(makeConsentRecord(allGrants(), NOW), false);
    const header = serialised.split(";")[0]!;
    expect(readConsentRecord(header, false)?.grants).toEqual(allGrants());
  });

  // Written as `__Host-cire_consent` when secure so a script on a sibling
  // *.cireweddings.com origin can't set a same-named Domain-scoped cookie
  // that silently overrides a guest's stored refusal; falls back to the bare
  // name on http dev, where `__Host-` cookies are rejected outright.
  describe("cookie name", () => {
    it("writes the __Host- prefixed name when secure", () => {
      const serialised = serialiseConsentCookie(record, true);
      expect(serialised.startsWith(`${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`)).toBe(true);
    });

    it("writes the bare name when not secure", () => {
      // __Host- cookies are rejected outright without Secure; falling back to
      // the bare name is what keeps consent persisting on http://localhost.
      const serialised = serialiseConsentCookie(record, false);
      expect(serialised.startsWith(`${CONSENT_COOKIE_NAME}=${encoded}`)).toBe(true);
      expect(serialised.startsWith(PREFIXED_CONSENT_COOKIE_NAME)).toBe(false);
    });
  });
});

describe("writeConsentToDocumentAndVerify read-back", () => {
  afterEach(clearBothCookies);

  it("returns true and leaves the record readable when the write actually lands", () => {
    clearBothCookies();
    expect(writeConsentToDocumentAndVerify(record)).toBe(true);
    expect(readConsentFromDocument()?.grants).toEqual(record.grants);
  });

  it("returns false when the read-back does not show the new value", () => {
    // Simulate a blocked/overridden write: something else holds the bare name
    // to a DIFFERENT value than the one we're about to try to write, and
    // `document.cookie` here (jsdom, http) never accepts the prefixed name
    // because it isn't secure — so the write can't land on the plain
    // assignment path and the read-back has to catch it.
    clearBothCookies();
    const originalCookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => `${CONSENT_COOKIE_NAME}=${otherEncoded}`,
      set: () => {
        // Swallow the write entirely — nothing lands, exactly like a browser
        // configured to block cookies outright.
      },
    });
    try {
      expect(writeConsentToDocumentAndVerify(record)).toBe(false);
    } finally {
      if (originalCookieDescriptor) {
        Object.defineProperty(document, "cookie", originalCookieDescriptor);
      }
    }
  });
});

/**
 * On https a bare `cire_consent` may have been planted by a sibling
 * *.cireweddings.com origin as a `Domain=.cireweddings.com` cookie, so it is
 * never honoured and never carried over onto the `__Host-` name. A guest whose
 * choice exists only under the bare name is asked again.
 */
describe("on a secure origin", () => {
  it("ignores a planted bare cookie: no decision is read", () => {
    onSecureOriginWithJar(`${CONSENT_COOKIE_NAME}=${encoded}`, () => {
      expect(readConsentFromDocument()).toBeNull();
    });
  });

  it("writes and reads back the __Host- name, leaving any bare cookie unread", () => {
    onSecureOriginWithJar(`${CONSENT_COOKIE_NAME}=${otherEncoded}`, (jar) => {
      expect(writeConsentToDocumentAndVerify(record)).toBe(true);
      expect(readNamed(jar(), PREFIXED_CONSENT_COOKIE_NAME)).toBe(encoded);
      expect(readConsentFromDocument()?.grants).toEqual(record.grants);
    });
  });
});
