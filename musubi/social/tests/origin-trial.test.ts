import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { withBuildDirectives } from "../vite.config";

/**
 * The Chrome origin-trial token `public/_headers` serves on every page, which
 * enrols the production origin in the Email Verification Protocol trial. A
 * token for the wrong origin or feature, or one past its expiry, is ignored by
 * Chrome without a word: the sign-up form's token field just never fills, and
 * every sign-up falls back to the emailed link. These checks fail first.
 *
 * Chrome's token format: a version byte, a 64-byte signature, a 4-byte
 * big-endian payload length, then that many bytes of JSON.
 */

const ROOT = resolve(import.meta.dirname, "..");
const HEADERS = readFileSync(resolve(ROOT, "public", "_headers"), "utf8");

/** The value of `name` in the `/*` rule of a `_headers` file, or undefined. */
function ruleHeader(headers: string, name: string): string | undefined {
  const lines = headers.split("\n");
  const rule = lines.findIndex((line) => line.trim() === "/*");
  if (rule === -1) return undefined;
  for (let i = rule + 1; /^\s+\S/.test(lines[i] ?? ""); i++) {
    const match = /^\s+([^:]+):\s*(.*)$/.exec(lines[i] ?? "");
    if (match?.[1]?.toLowerCase() === name.toLowerCase()) return match[2]?.trim();
  }
  return undefined;
}

/** The JSON payload of an origin-trial token. */
function payloadOf(token: string): { origin?: string; feature?: string; expiry?: number } {
  const bytes = Buffer.from(token, "base64");
  const length = bytes.readUInt32BE(1 + 64);
  const json = bytes.subarray(1 + 64 + 4, 1 + 64 + 4 + length).toString("utf8");
  return JSON.parse(json) as { origin?: string; feature?: string; expiry?: number };
}

describe("the Email Verification Protocol origin trial", () => {
  const token = ruleHeader(HEADERS, "Origin-Trial");

  it("is served on every page, for musubi.social and this feature", () => {
    expect(token).toBeDefined();
    const payload = payloadOf(token ?? "");
    expect(payload.origin).toBe("https://musubi.social:443");
    expect(payload.feature).toBe("EmailVerificationProtocol");
  });

  // The token's own expiry, against the real clock: CI fails once it has
  // passed, before the page silently loses the API. Chrome may end the trial
  // sooner, with the rollout of the release after 160; no token shows that.
  it("has not expired", () => {
    const { expiry } = payloadOf(token ?? "");
    expect(typeof expiry).toBe("number");
    expect((expiry ?? 0) * 1000).toBeGreaterThan(Date.now());
  });

  it("survives the build, which rewrites only the policy line", () => {
    const built = withBuildDirectives(HEADERS, "script-src 'self'; connect-src 'self'");
    expect(ruleHeader(built, "Origin-Trial")).toBe(token);
  });
});
