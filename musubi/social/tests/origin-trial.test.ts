import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { withBuildDirectives } from "../vite.config";

/**
 * The Chrome origin-trial tokens `public/_headers` serves on every page, which
 * enrol Musubi in the Email Verification Protocol trial: one for production,
 * one for the dev zone and its subdomains. A token for the wrong origin or
 * feature, a third-party token, or one past its expiry is ignored by Chrome
 * without a word: the sign-up form's token field just never fills, and every
 * sign-up falls back to the emailed link. These checks fail first.
 *
 * Chrome's token format: a version byte, a 64-byte Ed25519 signature, a 4-byte
 * big-endian payload length, then that many bytes of JSON. The signature
 * covers the version byte, the length and the payload.
 */

const ROOT = resolve(import.meta.dirname, "..");
const HEADERS = readFileSync(resolve(ROOT, "public", "_headers"), "utf8");

/** Each origin a token must name, and whether it must match that origin's subdomains. */
const EXPECTED_ORIGINS: Readonly<Record<string, boolean>> = {
  // Production: musubi.social exactly.
  "https://musubi.social:443": false,
  // Dev: the dev zone, so musubi.<DEV_DOMAIN> is covered. A new dev zone needs a new token.
  "https://esv.tools:443": true,
};

/** How long before a token's expiry these tests start to fail: 14 days. */
const RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Chrome's origin-trial public key (`kDefaultPublicKey` in Chromium's
 * `components/embedder_support/origin_trials/origin_trial_policy_impl.cc`),
 * as an Ed25519 SubjectPublicKeyInfo.
 */
const CHROME_KEY = createPublicKey({
  key: Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from("7cc4b89a93ba6ee2d0fd031dfb3266c73b72fd543a07511466aa02534e33a115", "hex"),
  ]),
  format: "der",
  type: "spki",
});

/** Every value of `name` in the `/*` rule of a `_headers` file, in order. */
function ruleHeaders(headers: string, name: string): string[] {
  const lines = headers.split("\n");
  const rule = lines.findIndex((line) => line.trim() === "/*");
  if (rule === -1) return [];
  const values: string[] = [];
  for (let i = rule + 1; /^\s+\S/.test(lines[i] ?? ""); i++) {
    const match = /^\s+([^:]+):\s*(.*)$/.exec(lines[i] ?? "");
    if (match?.[1]?.toLowerCase() === name.toLowerCase()) values.push(match[2]?.trim() ?? "");
  }
  return values;
}

interface Payload {
  readonly origin?: unknown;
  readonly feature?: unknown;
  readonly expiry?: unknown;
  readonly isSubdomain?: unknown;
  readonly isThirdParty?: unknown;
}

/**
 * A token's JSON payload, and whether Chrome's key signed it. Throws when the
 * token's length does not match its own length field, or the payload is not JSON.
 */
function decode(token: string): { payload: Payload; signed: boolean } {
  const bytes = Buffer.from(token, "base64");
  const length = bytes.readUInt32BE(1 + 64);
  if (bytes.length !== 1 + 64 + 4 + length) {
    throw new Error(`token holds ${bytes.length} bytes; its length field implies ${69 + length}`);
  }
  const payload = JSON.parse(bytes.subarray(69).toString("utf8")) as Payload;
  const signed = verify(
    null,
    Buffer.concat([bytes.subarray(0, 1), bytes.subarray(65)]),
    CHROME_KEY,
    bytes.subarray(1, 65),
  );
  return { payload, signed };
}

describe("the Email Verification Protocol origin trial", () => {
  const tokens = ruleHeaders(HEADERS, "Origin-Trial");

  it("serves one token for each expected origin on every page", () => {
    const origins = tokens.map((token) => decode(token).payload.origin);
    expect(origins.toSorted()).toEqual(Object.keys(EXPECTED_ORIGINS).toSorted());
  });

  it("serves only tokens Chrome signed, for this feature", () => {
    for (const token of tokens) {
      const { payload, signed } = decode(token);
      expect({ origin: payload.origin, signed }).toEqual({ origin: payload.origin, signed: true });
      expect(payload.feature).toBe("EmailVerificationProtocol");
    }
  });

  // A header can carry only a first-party token; a third-party one works only
  // from an external script.
  it("matches subdomains only on the dev zone, and is never third-party", () => {
    for (const token of tokens) {
      const { payload } = decode(token);
      const origin = String(payload.origin);
      expect({ origin, isSubdomain: payload.isSubdomain === true }).toEqual({
        origin,
        isSubdomain: EXPECTED_ORIGINS[origin],
      });
      expect(payload).not.toHaveProperty("isThirdParty");
    }
  });

  // The token's own expiry, against the real clock: CI fails 14 days before
  // it, while there is time to renew. Chrome may end the trial sooner, with
  // the rollout of the release after 160; no token shows that.
  it("has more than 14 days left on every token", () => {
    for (const token of tokens) {
      const { payload } = decode(token);
      expect(typeof payload.expiry).toBe("number");
      expect(
        Number(payload.expiry) * 1000 - Date.now(),
        `the ${String(payload.origin)} token lapses within 14 days: register the origin again on the Chrome origin-trials site and replace its line in public/_headers`,
      ).toBeGreaterThan(RENEWAL_WINDOW_MS);
    }
  });

  it("survives the build, which rewrites only the policy line", () => {
    const built = withBuildDirectives(HEADERS, "script-src 'self'; connect-src 'self'");
    expect(ruleHeaders(built, "Origin-Trial")).toEqual(tokens);
  });
});
