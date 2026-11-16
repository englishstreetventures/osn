import { createPublicKey, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  decodeOriginTrialToken,
  ORIGIN_TRIAL_RENEWAL_WINDOW_MS,
  ORIGIN_TRIAL_TOKENS,
  originTrialHeader,
} from "../src/origin-trial";

const SITE_ORIGIN = "https://cireweddings.com:443";
/** The dev tier's zone, `DEV_DOMAIN`. A new dev zone needs new dev tokens. */
const DEV_ZONE_ORIGIN = "https://esv.tools:443";

/** What each token must be: its origin, its feature, and the day it lapses (UTC). */
const EXPECTED = {
  htmlInCanvas: { origin: SITE_ORIGIN, feature: "HTMLInCanvas", expiry: "2027-03-02T00:00:00Z" },
  htmlInCanvasDev: {
    origin: DEV_ZONE_ORIGIN,
    feature: "HTMLInCanvas",
    expiry: "2027-03-02T00:00:00Z",
  },
  webmcp: { origin: SITE_ORIGIN, feature: "WebMCP", expiry: "2027-03-30T00:00:00Z" },
  webmcpDev: { origin: DEV_ZONE_ORIGIN, feature: "WebMCP", expiry: "2027-03-30T00:00:00Z" },
} as const satisfies Record<
  keyof typeof ORIGIN_TRIAL_TOKENS,
  { origin: string; feature: string; expiry: string }
>;

/**
 * Chrome's origin-trial public key (`kDefaultPublicKey` in Chromium's
 * `components/embedder_support/origin_trials/origin_trial_policy_impl.cc`),
 * as an Ed25519 SubjectPublicKeyInfo. The signature covers the version byte,
 * the length and the payload.
 */
const CHROME_KEY = createPublicKey({
  key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from("7cc4b89a93ba6ee2d0fd031dfb3266c73b72fd543a07511466aa02534e33a115", "hex"),
  ]),
  format: "der",
  type: "spki",
});

/** Whether Chrome's key signed `token`: a string damaged in a copy fails here. */
function signedByChrome(token: string): boolean {
  const bytes = Buffer.from(token, "base64");
  return verify(
    null,
    Buffer.concat([bytes.subarray(0, 1), bytes.subarray(65)]),
    CHROME_KEY,
    bytes.subarray(1, 65),
  );
}

/** The payload's JSON as written, with the fields the decoder drops. */
function rawPayload(token: string): Record<string, unknown> {
  const bytes = Buffer.from(token, "base64");
  return JSON.parse(bytes.subarray(69, 69 + bytes.readUInt32BE(65)).toString("utf8")) as Record<
    string,
    unknown
  >;
}

describe("ORIGIN_TRIAL_TOKENS", () => {
  it("holds exactly the tokens this file expects", () => {
    expect(new Set(Object.keys(ORIGIN_TRIAL_TOKENS))).toEqual(new Set(Object.keys(EXPECTED)));
  });

  for (const [key, expected] of Object.entries(EXPECTED)) {
    const token = ORIGIN_TRIAL_TOKENS[key as keyof typeof EXPECTED];

    it(`${key} is registered for ${expected.origin} and its subdomains`, () => {
      const payload = decodeOriginTrialToken(token);
      expect(payload.origin).toBe(expected.origin);
      expect(payload.isSubdomain).toBe(true);
    });

    // A response header can carry only a first-party token.
    it(`${key} is signed by Chrome, and first-party`, () => {
      expect(signedByChrome(token)).toBe(true);
      expect(rawPayload(token)).not.toHaveProperty("isThirdParty");
    });

    it(`${key} enables ${expected.feature} and nothing else`, () => {
      expect(decodeOriginTrialToken(token).feature).toBe(expected.feature);
    });

    it(`${key} lapses on ${expected.expiry}`, () => {
      expect(decodeOriginTrialToken(token).expiry * 1000).toBe(Date.parse(expected.expiry));
    });

    // Fails 14 days before the lapse, not on it: a trial that goes dark with no
    // warning turns an unrelated pull request red. To renew, register the
    // origin again on the Chrome origin-trials site and replace the string in
    // `src/origin-trial.ts` (and, for either WebMCP token, its line in
    // `cire/host/public/_headers`).
    it(`${key} has more than the renewal window left`, () => {
      const msLeft = decodeOriginTrialToken(token).expiry * 1000 - Date.now();
      expect(
        msLeft,
        `${key} lapses within 14 days: register its origin again on the Chrome origin-trials site, then replace the string in cire/build-tools/src/origin-trial.ts (and its line in cire/host/public/_headers for a WebMCP token) and the expiry in this file`,
      ).toBeGreaterThan(ORIGIN_TRIAL_RENEWAL_WINDOW_MS);
    });
  }

  it("warns 14 days ahead", () => {
    expect(ORIGIN_TRIAL_RENEWAL_WINDOW_MS).toBe(1_209_600_000);
  });
});

describe("decodeOriginTrialToken", () => {
  const payload = JSON.stringify({
    origin: SITE_ORIGIN,
    feature: "Example",
    expiry: 1,
    isSubdomain: false,
  });
  const forge = (body: string, signatureLength = 64): string => {
    const bytes = Buffer.concat([
      Buffer.from([2]),
      Buffer.alloc(signatureLength, 7),
      Buffer.from([0, 0, 0, body.length]),
      Buffer.from(body),
    ]);
    return bytes.toString("base64");
  };

  it("reads the JSON that follows the version, signature and length", () => {
    expect(decodeOriginTrialToken(forge(payload))).toEqual({
      origin: SITE_ORIGIN,
      feature: "Example",
      expiry: 1,
      isSubdomain: false,
    });
  });

  it("refuses a token too short to hold a payload", () => {
    expect(() => decodeOriginTrialToken("AAAA")).toThrow(/too short/);
  });

  it("refuses a token with a header and no payload byte", () => {
    expect(() => decodeOriginTrialToken(Buffer.alloc(69).toString("base64"))).toThrow(/too short/);
  });

  it("refuses a payload that is not JSON", () => {
    expect(() => decodeOriginTrialToken(forge("not json"))).toThrow(/not JSON/);
  });

  it("refuses a payload that lacks a field Chrome reads", () => {
    expect(() => decodeOriginTrialToken(forge(JSON.stringify({ origin: SITE_ORIGIN })))).toThrow(
      /feature/,
    );
  });
});

describe("originTrialHeader", () => {
  it("joins tokens with a comma and a space, which Chrome reads as one header per token", () => {
    expect(originTrialHeader("a", "b")).toBe("a, b");
  });
});
