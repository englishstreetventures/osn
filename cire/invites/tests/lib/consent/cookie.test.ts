import { afterEach, describe, expect, it } from "vitest";

import {
  CONSENT_COOKIE_MAX_AGE_SECONDS,
  CONSENT_COOKIE_NAME,
  PREFIXED_CONSENT_COOKIE_NAME,
  migrateBareConsentCookie,
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

const NOW = new Date("2026-07-29T10:00:00.000Z");
const record = makeConsentRecord({ ...defaultGrants(), embeds: true }, NOW);
const encoded = encodeConsentRecord(record);

const OTHER_NOW = new Date("2026-07-30T10:00:00.000Z");
const otherRecord = makeConsentRecord({ ...defaultGrants(), embeds: false }, OTHER_NOW);
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
    expect(readConsentCookieValue(header)).toBe(encoded);
  });

  it("finds the value when it is first or last in the string", () => {
    expect(readConsentCookieValue(`${CONSENT_COOKIE_NAME}=${encoded}; x=1`)).toBe(encoded);
    expect(readConsentCookieValue(`x=1; ${CONSENT_COOKIE_NAME}=${encoded}`)).toBe(encoded);
  });

  it("returns null when the cookie is absent, empty, or the header is missing", () => {
    expect(readConsentCookieValue("cire_session=abc123")).toBeNull();
    expect(readConsentCookieValue("")).toBeNull();
    expect(readConsentCookieValue(null)).toBeNull();
    expect(readConsentCookieValue(undefined)).toBeNull();
  });

  it("does not match a cookie whose name merely CONTAINS the consent name", () => {
    // `not_cire_consent` and `cire_consent_backup` are different cookies; a
    // substring match would let an unrelated value be read as the decision.
    const header = `not_${CONSENT_COOKIE_NAME}=tampered; ${CONSENT_COOKIE_NAME}_backup=stale`;
    expect(readConsentCookieValue(header)).toBeNull();
  });

  it("tolerates malformed segments without throwing", () => {
    expect(readConsentCookieValue(`novalue; ; ${CONSENT_COOKIE_NAME}=${encoded}`)).toBe(encoded);
  });

  // osn-tracker#163: precedence between the `__Host-` and bare names. The
  // prefixed name must win whenever it's present — that is what stops a
  // domain cookie planted by a sibling origin under the bare name from
  // overriding a refusal this site actually recorded under the prefixed one.
  describe("prefix precedence (osn-tracker#163)", () => {
    it("reads the bare name when it is the only one present", () => {
      const header = `${CONSENT_COOKIE_NAME}=${encoded}`;
      expect(readConsentCookieValue(header)).toBe(encoded);
    });

    it("reads the prefixed name when it is the only one present", () => {
      const header = `${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`;
      expect(readConsentCookieValue(header)).toBe(encoded);
    });

    it("prefers the prefixed value when both names are present", () => {
      const header = `${CONSENT_COOKIE_NAME}=${otherEncoded}; ${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`;
      expect(readConsentCookieValue(header)).toBe(encoded);
    });

    it("returns null when neither name is present", () => {
      const header = "cire_session=abc123; other=1";
      expect(readConsentCookieValue(header)).toBeNull();
    });
  });
});

describe("readConsentRecord", () => {
  it("parses a record straight out of a cookie header", () => {
    const parsed = readConsentRecord(`a=1; ${CONSENT_COOKIE_NAME}=${encoded}`);
    expect(parsed?.grants.embeds).toBe(true);
  });

  it("returns null for a header carrying a corrupted value", () => {
    expect(readConsentRecord(`${CONSENT_COOKIE_NAME}=garbage`)).toBeNull();
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
    expect(readConsentRecord(header)?.grants).toEqual(allGrants());
  });

  // osn-tracker#163
  describe("cookie name (osn-tracker#163)", () => {
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

describe("writeConsentToDocumentAndVerify (osn-tracker#162 read-back)", () => {
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
 * Drive the module's `isSecureContext()` — it reads `location.protocol`, and
 * jsdom serves the suite over http, so the `__Host-` half of every path below
 * is unreachable without this. Also swaps in a cookie jar we control, because
 * jsdom on http refuses a `Secure` cookie outright and the migration's whole
 * point is what it writes on https.
 */
function onSecureOriginWithJar(initial: string, body: (jar: () => string) => void): void {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const originalCookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  const jar = new Map<string, string>();
  for (const part of initial.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    jar.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    get: () => ({ protocol: "https:" }),
  });
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
    set: (assignment: string) => {
      const [pair, ...attributes] = assignment.split(";");
      const separator = pair!.indexOf("=");
      const name = pair!.slice(0, separator).trim();
      const value = pair!.slice(separator + 1).trim();
      // A browser deletes on Max-Age=0 rather than storing an empty value.
      if (attributes.some((a) => a.trim().toLowerCase() === "max-age=0")) jar.delete(name);
      else jar.set(name, value);
    },
  });
  try {
    body(() => document.cookie);
  } finally {
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    if (originalCookie) Object.defineProperty(document, "cookie", originalCookie);
  }
}

/**
 * S-M1 (found reviewing this branch): preferring the prefixed name on read only
 * helps once this origin has WRITTEN the prefixed name — and for an
 * already-decided guest that write never happens, because their choice reads
 * back fine, the banner stays away, and `saveConsent` is never called again.
 * Without a read-path migration their refusal stays shadowable for the cookie's
 * whole 182 days.
 */
describe("migrateBareConsentCookie (S-M1)", () => {
  it("moves an already-decided guest onto the prefixed name, and drops the bare one", () => {
    onSecureOriginWithJar(`${CONSENT_COOKIE_NAME}=${encoded}`, (jar) => {
      migrateBareConsentCookie();
      expect(jar()).toContain(`${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`);
      expect(readConsentCookieValue(jar())).toBe(encoded);
      // The shadowable name is gone, not merely out-ranked.
      expect(readNamed(jar(), CONSENT_COOKIE_NAME)).toBeNull();
    });
  });

  it("preserves the decision itself, not just the name", () => {
    onSecureOriginWithJar(`${CONSENT_COOKIE_NAME}=${encoded}`, (jar) => {
      migrateBareConsentCookie();
      expect(readConsentRecord(jar())?.grants).toEqual(record.grants);
    });
  });

  it("leaves a guest already on the prefixed name alone", () => {
    onSecureOriginWithJar(`${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`, (jar) => {
      migrateBareConsentCookie();
      expect(jar()).toBe(`${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}`);
    });
  });

  it("prefers the prefixed value and still clears the bare one when both exist", () => {
    // The planted-cookie case: a sibling origin's bare cookie sitting beside
    // ours. The prefixed one already exists, so nothing is rewritten — the read
    // precedence is what defends here, and it does.
    onSecureOriginWithJar(
      `${PREFIXED_CONSENT_COOKIE_NAME}=${encoded}; ${CONSENT_COOKIE_NAME}=${otherEncoded}`,
      (jar) => {
        migrateBareConsentCookie();
        expect(readConsentCookieValue(jar())).toBe(encoded);
      },
    );
  });

  it("does nothing when there is no decision to move", () => {
    onSecureOriginWithJar("", (jar) => {
      migrateBareConsentCookie();
      expect(jar()).toBe("");
    });
  });

  it("does nothing when the bare cookie holds something unparseable", () => {
    onSecureOriginWithJar(`${CONSENT_COOKIE_NAME}=not-a-record`, (jar) => {
      migrateBareConsentCookie();
      // Left exactly as found rather than replaced with a fabricated record.
      expect(jar()).toBe(`${CONSENT_COOKIE_NAME}=not-a-record`);
    });
  });
});

describe("a secure write expires the bare name (S-M1)", () => {
  it("clears a stale bare cookie as a side effect of saving", () => {
    onSecureOriginWithJar(`${CONSENT_COOKIE_NAME}=${otherEncoded}`, (jar) => {
      expect(writeConsentToDocumentAndVerify(record)).toBe(true);
      expect(readNamed(jar(), CONSENT_COOKIE_NAME)).toBeNull();
      expect(readNamed(jar(), PREFIXED_CONSENT_COOKIE_NAME)).toBe(encoded);
    });
  });
});
