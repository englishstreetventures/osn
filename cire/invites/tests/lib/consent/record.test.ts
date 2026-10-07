import { describe, expect, it } from "vitest";

import {
  allGrants,
  CONSENT_POLICY_VERSION,
  CONSENT_RECORD_VERSION,
  decodeConsentRecord,
  defaultGrants,
  encodeConsentRecord,
  isGranted,
  makeConsentRecord,
  normaliseGrants,
  preDecisionGrants,
} from "../../../src/lib/consent/record";

const NOW = new Date("2026-07-29T10:00:00.000Z");

describe("defaultGrants — the floor", () => {
  it("switches both consent switches OFF and the required category ON", () => {
    // What "Reject all" writes, and what applies before the stored decision has
    // been read.
    expect(defaultGrants()).toEqual({ necessary: true, pinterest: false, maps: false });
  });
});

describe("preDecisionGrants — what applies before the guest decides", () => {
  it("keeps both switches OFF for an undecided guest: nothing loads before a yes", () => {
    // Pinterest and Google see the guest's IP address and browser the moment
    // their embed loads, so nothing of theirs loads until the guest allows it.
    expect(preDecisionGrants()).toEqual({ necessary: true, pinterest: false, maps: false });
  });

  it("is less than accept-all", () => {
    expect(preDecisionGrants()).not.toEqual(allGrants());
  });
});

describe("normaliseGrants", () => {
  it("forces required categories on regardless of the input", () => {
    // Nothing — not a stale cookie, not a caller mistake — may switch off the
    // storage the invite needs to function at all.
    expect(normaliseGrants({ necessary: false, pinterest: true }).necessary).toBe(true);
  });

  it("drops unknown keys instead of carrying them into the record", () => {
    const grants = normaliseGrants({ maps: true, marketing: true });
    expect(grants).toEqual({ necessary: true, pinterest: false, maps: true });
    expect("marketing" in grants).toBe(false);
  });

  it("ignores the keys of categories the site no longer has", () => {
    // `functional`, `analytics` and the single `embeds` switch are gone. A
    // record carrying them still parses; the keys are simply not read.
    const grants = normaliseGrants({ functional: true, analytics: true, embeds: true, maps: true });
    expect(grants).toEqual({ necessary: true, pinterest: false, maps: true });
  });

  it("does not pollute Object.prototype from a JSON-parsed __proto__ key", () => {
    // Must go through JSON.parse, not an object literal: in a literal
    // `__proto__:` is a prototype SETTER, so the key never becomes an own
    // property and the test would pass without exercising anything.
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "pinterest": true}') as unknown;
    const grants = normaliseGrants(hostile);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(grants)).toBe(Object.prototype);
    expect(grants.pinterest).toBe(true);
  });

  it("treats any non-`true` value as a refusal", () => {
    // A tampered or corrupted cookie must fail closed, never open.
    const grants = normaliseGrants({ pinterest: "yes", maps: 1 });
    expect(grants.pinterest).toBe(false);
    expect(grants.maps).toBe(false);
  });

  it("fills in missing categories as refused", () => {
    expect(normaliseGrants({}).pinterest).toBe(false);
    expect(normaliseGrants({}).maps).toBe(false);
  });

  it("returns the safe default for non-object input", () => {
    expect(normaliseGrants(null)).toEqual(defaultGrants());
    expect(normaliseGrants("pinterest")).toEqual(defaultGrants());
  });
});

describe("encode/decode round trip", () => {
  it("preserves the grants, the timestamp and both versions", () => {
    const record = makeConsentRecord({ ...defaultGrants(), pinterest: true }, NOW);
    const decoded = decodeConsentRecord(encodeConsentRecord(record));

    expect(decoded).not.toBeNull();
    expect(decoded!.grants.pinterest).toBe(true);
    expect(decoded!.grants.maps).toBe(false);
    expect(decoded!.decidedAt).toBe(NOW.toISOString());
    expect(decoded!.v).toBe(CONSENT_RECORD_VERSION);
    expect(decoded!.policy).toBe(CONSENT_POLICY_VERSION);
  });

  it("round-trips an accept-all record", () => {
    const decoded = decodeConsentRecord(encodeConsentRecord(makeConsentRecord(allGrants(), NOW)));
    expect(decoded!.grants).toEqual(allGrants());
  });

  it("round-trips a reject-all record as a real decision, not an absence", () => {
    // The distinction the whole design turns on: "refused everything" must
    // decode to a record (so we stop asking), not to null, which would
    // re-prompt a guest who already answered.
    const decoded = decodeConsentRecord(
      encodeConsentRecord(makeConsentRecord(defaultGrants(), NOW)),
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.grants.pinterest).toBe(false);
    expect(decoded!.grants.maps).toBe(false);
  });

  it("loads a current record that still carries keys of removed categories", () => {
    // A stored record with `functional`, `analytics` or `embeds` among its
    // grants still parses: the extra keys are ignored, the switches read.
    const raw = encodeURIComponent(
      JSON.stringify({
        v: CONSENT_RECORD_VERSION,
        policy: CONSENT_POLICY_VERSION,
        decidedAt: NOW.toISOString(),
        grants: { necessary: true, functional: true, analytics: false, embeds: true, maps: true },
      }),
    );
    const decoded = decodeConsentRecord(raw);
    expect(decoded?.grants).toEqual({ necessary: true, pinterest: false, maps: true });
  });
});

describe("decodeConsentRecord — inputs it must refuse to trust", () => {
  it("returns null for absent input", () => {
    expect(decodeConsentRecord(null)).toBeNull();
    expect(decodeConsentRecord(undefined)).toBeNull();
    expect(decodeConsentRecord("")).toBeNull();
  });

  it("returns null for malformed JSON rather than throwing", () => {
    expect(decodeConsentRecord("not-json")).toBeNull();
    expect(decodeConsentRecord(encodeURIComponent("{ broken"))).toBeNull();
  });

  it("returns null for invalid percent-escapes rather than throwing", () => {
    expect(decodeConsentRecord("%E0%A4%A")).toBeNull();
  });

  it("returns null for a non-object payload", () => {
    expect(decodeConsentRecord(encodeURIComponent(JSON.stringify("granted")))).toBeNull();
    expect(decodeConsentRecord(encodeURIComponent(JSON.stringify(null)))).toBeNull();
  });

  it("returns null when the storage version does not match", () => {
    const stale = encodeURIComponent(
      JSON.stringify({
        v: CONSENT_RECORD_VERSION + 1,
        policy: CONSENT_POLICY_VERSION,
        decidedAt: NOW.toISOString(),
        grants: allGrants(),
      }),
    );
    expect(decodeConsentRecord(stale)).toBeNull();
  });

  it("returns null when the POLICY version does not match, so the guest is re-asked", () => {
    // The load-bearing rule: consent given against an older disclosure was never
    // informed about whatever vendor was added since, so it cannot be reused.
    const stale = encodeURIComponent(
      JSON.stringify({
        v: CONSENT_RECORD_VERSION,
        policy: "2020-01-01",
        decidedAt: NOW.toISOString(),
        grants: allGrants(),
      }),
    );
    expect(decodeConsentRecord(stale)).toBeNull();
  });

  it("returns null when the decision timestamp is missing, unparsable, or absurdly long", () => {
    // `decidedAt` is the one field kept as an audit trail, and it comes from a
    // cookie the client can rewrite — so it fails closed like the version
    // fields rather than being carried forward unchecked.
    const withTimestamp = (decidedAt: unknown) =>
      encodeURIComponent(
        JSON.stringify({
          v: CONSENT_RECORD_VERSION,
          policy: CONSENT_POLICY_VERSION,
          decidedAt,
          grants: allGrants(),
        }),
      );

    expect(decodeConsentRecord(withTimestamp(undefined))).toBeNull();
    expect(decodeConsentRecord(withTimestamp("not-a-date"))).toBeNull();
    expect(decodeConsentRecord(withTimestamp(""))).toBeNull();
    expect(decodeConsentRecord(withTimestamp(1234567890))).toBeNull();
    expect(
      decodeConsentRecord(withTimestamp("2026-07-29T00:00:00.000Z".padEnd(200, "0"))),
    ).toBeNull();
    // ...and the real thing still decodes.
    expect(decodeConsentRecord(withTimestamp(NOW.toISOString()))).not.toBeNull();
  });

  it("does not pollute Object.prototype via a tampered cookie", () => {
    const raw = encodeURIComponent(
      '{"v":' +
        CONSENT_RECORD_VERSION +
        ',"policy":"' +
        CONSENT_POLICY_VERSION +
        '","decidedAt":"' +
        NOW.toISOString() +
        '","grants":{"__proto__":{"polluted":true},"pinterest":true}}',
    );
    const decoded = decodeConsentRecord(raw);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(decoded!.grants.pinterest).toBe(true);
  });

  it("sanitises a tampered record instead of honouring it", () => {
    // A hand-edited cookie claiming every category is on, including one that
    // does not exist, and necessary switched off.
    const tampered = encodeURIComponent(
      JSON.stringify({
        v: CONSENT_RECORD_VERSION,
        policy: CONSENT_POLICY_VERSION,
        decidedAt: NOW.toISOString(),
        grants: { necessary: false, pinterest: "yes", marketing: true },
      }),
    );
    const decoded = decodeConsentRecord(tampered)!;
    expect(decoded.grants.necessary).toBe(true);
    expect(decoded.grants.pinterest).toBe(false);
    expect("marketing" in decoded.grants).toBe(false);
  });
});

describe("a record made under the previous disclosure", () => {
  it("is not reused: one switch for all third-party content is not consent to either new switch", () => {
    // The 2026-07-29 policy asked once for Pinterest and Google Maps together.
    // Reading its `embeds` grant as a yes or a no to the separate switches
    // would answer a question the guest was never asked, so they are asked
    // again.
    const raw = encodeURIComponent(
      JSON.stringify({
        v: CONSENT_RECORD_VERSION,
        policy: "2026-07-29",
        decidedAt: NOW.toISOString(),
        grants: { necessary: true, functional: true, embeds: true, analytics: false },
      }),
    );
    expect(decodeConsentRecord(raw)).toBeNull();
  });
});

describe("isGranted", () => {
  it("falls back to the pre-decision defaults for a null record", () => {
    expect(isGranted(null, "pinterest")).toBe(false);
    expect(isGranted(null, "maps")).toBe(false);
    expect(isGranted(null, "necessary")).toBe(true);
  });

  it("reads each switch of the stored decision on its own", () => {
    const record = makeConsentRecord({ ...defaultGrants(), maps: true }, NOW);
    expect(isGranted(record, "maps")).toBe(true);
    expect(isGranted(record, "pinterest")).toBe(false);
  });
});
