import { describe, expect, it } from "vitest";

import {
  decodeOriginTrialToken,
  ORIGIN_TRIAL_RENEWAL_WINDOW_MS,
  ORIGIN_TRIAL_TOKENS,
  originTrialHeader,
} from "../src/origin-trial";

const SITE_ORIGIN = "https://cireweddings.com:443";

/** What each token must be: its feature, and the day it lapses (UTC). */
const EXPECTED = {
  htmlInCanvas: { feature: "HTMLInCanvas", expiry: "2027-03-02T00:00:00Z" },
  autofillEvent: { feature: "AutofillEvent", expiry: "2027-01-05T00:00:00Z" },
  webmcp: { feature: "WebMCP", expiry: "2027-03-30T00:00:00Z" },
} as const;

describe("ORIGIN_TRIAL_TOKENS", () => {
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const token = ORIGIN_TRIAL_TOKENS[key as keyof typeof EXPECTED];

    it(`${key} is registered for the site and its subdomains`, () => {
      const payload = decodeOriginTrialToken(token);
      expect(payload.origin).toBe(SITE_ORIGIN);
      expect(payload.isSubdomain).toBe(true);
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
    // `src/origin-trial.ts` (and, for WebMCP, `cire/host/public/_headers`).
    it(`${key} has more than the renewal window left`, () => {
      const msLeft = decodeOriginTrialToken(token).expiry * 1000 - Date.now();
      expect(
        msLeft,
        `${key} lapses within 14 days: register the origin again on the Chrome origin-trials site, then replace the string in cire/build-tools/src/origin-trial.ts (and cire/host/public/_headers for WebMCP) and the expiry in this file`,
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
