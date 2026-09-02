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
  it("switches every optional category OFF and the required one ON", () => {
    // What "Reject all" writes, and what applies before the stored decision has
    // been read. NOT the no-decision state — see preDecisionGrants.
    expect(defaultGrants()).toEqual({
      necessary: true,
      functional: false,
      embeds: false,
      analytics: false,
    });
  });
});

describe("preDecisionGrants — the opt-out defaults", () => {
  it("switches third-party content and preferences ON for an undecided guest", () => {
    expect(preDecisionGrants().embeds).toBe(true);
    expect(preDecisionGrants().functional).toBe(true);
    expect(preDecisionGrants().necessary).toBe(true);
  });

  it("leaves analytics OFF even though the other optional categories are on", () => {
    // Nothing uses that category yet, so there is nothing a default could be
    // informed about — an analytics tag added later must not inherit consent
    // from guests who were never told it existed.
    expect(preDecisionGrants().analytics).toBe(false);
  });

  it("is strictly more permissive than the floor, and strictly less than accept-all", () => {
    expect(preDecisionGrants()).not.toEqual(defaultGrants());
    expect(preDecisionGrants()).not.toEqual(allGrants());
  });
});

describe("normaliseGrants", () => {
  it("forces required categories on regardless of the input", () => {
    // Nothing — not a stale cookie, not a caller mistake — may switch off the
    // storage the invite needs to function at all.
    expect(normaliseGrants({ necessary: false, embeds: true }).necessary).toBe(true);
  });

  it("drops unknown keys instead of carrying them into the record", () => {
    const grants = normaliseGrants({ embeds: true, marketing: true });
    expect(grants).toEqual({
      necessary: true,
      functional: false,
      embeds: true,
      analytics: false,
    });
    expect("marketing" in grants).toBe(false);
  });

  it("does not pollute Object.prototype from a JSON-parsed __proto__ key", () => {
    // Must go through JSON.parse, not an object literal: in a literal
    // `__proto__:` is a prototype SETTER, so the key never becomes an own
    // property and `Object.entries` never sees it — a test written that way
    // passes even against unsafe code. `JSON.parse` produces a real own
    // property, which is the shape a tampered cookie actually delivers.
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "embeds": true}') as unknown;
    const grants = normaliseGrants(hostile);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((grants as Record<string, unknown>).polluted).toBeUndefined();
    expect(grants.embeds).toBe(true);
  });

  it("treats any non-`true` value as a refusal", () => {
    // A truthy-but-not-true value ("yes", 1) must never be read as consent.
    const grants = normaliseGrants({ embeds: "yes", analytics: 1, functional: null });
    expect(grants.embeds).toBe(false);
    expect(grants.analytics).toBe(false);
    expect(grants.functional).toBe(false);
  });

  it("fills in missing categories as refused", () => {
    expect(normaliseGrants({}).embeds).toBe(false);
  });

  it("returns the safe default for non-object input", () => {
    expect(normaliseGrants(null)).toEqual(defaultGrants());
    expect(normaliseGrants("embeds")).toEqual(defaultGrants());
  });
});

describe("encode/decode round trip", () => {
  it("preserves the grants, the timestamp and both versions", () => {
    const record = makeConsentRecord({ ...defaultGrants(), embeds: true }, NOW);
    const decoded = decodeConsentRecord(encodeConsentRecord(record));

    expect(decoded).not.toBeNull();
    expect(decoded!.grants.embeds).toBe(true);
    expect(decoded!.grants.analytics).toBe(false);
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
    // decode to a record (so we stop asking AND stop loading), not to null —
    // which under opt-out would both re-prompt and silently re-enable embeds.
    const decoded = decodeConsentRecord(
      encodeConsentRecord(makeConsentRecord(defaultGrants(), NOW)),
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.grants.embeds).toBe(false);
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
        '","grants":{"__proto__":{"polluted":true},"embeds":true}}',
    );
    const decoded = decodeConsentRecord(raw);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(decoded!.grants.embeds).toBe(true);
  });

  it("sanitises a tampered record instead of honouring it", () => {
    // A hand-edited cookie claiming every category is on, including one that
    // does not exist, and necessary switched off.
    const tampered = encodeURIComponent(
      JSON.stringify({
        v: CONSENT_RECORD_VERSION,
        policy: CONSENT_POLICY_VERSION,
        decidedAt: NOW.toISOString(),
        grants: { necessary: false, embeds: "yes", marketing: true },
      }),
    );
    const decoded = decodeConsentRecord(tampered)!;
    expect(decoded.grants.necessary).toBe(true);
    expect(decoded.grants.embeds).toBe(false);
    expect("marketing" in decoded.grants).toBe(false);
  });
});

describe("isGranted", () => {
  it("falls back to the opt-out defaults for a null record", () => {
    expect(isGranted(null, "embeds")).toBe(true);
    expect(isGranted(null, "functional")).toBe(true);
    expect(isGranted(null, "necessary")).toBe(true);
    expect(isGranted(null, "analytics")).toBe(false);
  });

  it("honours an explicit refusal over the permissive default", () => {
    // The distinction the opt-out posture turns on: "never asked" allows
    // embeds, "asked and refused" does not, and the two must never collapse.
    const refused = makeConsentRecord(defaultGrants(), NOW);
    expect(isGranted(refused, "embeds")).toBe(false);
    expect(isGranted(null, "embeds")).toBe(true);
  });

  it("reads the stored decision when there is one", () => {
    const record = makeConsentRecord({ ...defaultGrants(), embeds: true }, NOW);
    expect(isGranted(record, "embeds")).toBe(true);
    expect(isGranted(record, "functional")).toBe(false);
  });
});
