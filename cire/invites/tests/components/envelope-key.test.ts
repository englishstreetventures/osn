// @vitest-environment node
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { envelopeKeyFor } from "../../src/components/envelope-key";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("envelopeKeyFor", () => {
  // The host's picker tells the organiser guests see no envelope over a hero
  // that is not shown; the key is what puts an envelope on the page at all.
  it("gives no key when the hero is not shown", async () => {
    expect(
      await envelopeKeyFor({ slug: "anita-ben", envelopeId: "wax-seal", heroShown: false }),
    ).toBeNull();
  });

  it("gives no key when the wedding has no envelope, or one outside the catalog", async () => {
    for (const envelopeId of [null, undefined, "", "not-an-envelope", "WAX-SEAL"]) {
      expect(await envelopeKeyFor({ slug: "anita-ben", envelopeId, heroShown: true })).toBeNull();
    }
  });

  it("is the SHA-256 of slug, a colon and the envelope id, never the slug", async () => {
    const key = await envelopeKeyFor({
      slug: "anita-ben",
      envelopeId: "wax-seal",
      heroShown: true,
    });
    expect(key).toBe(sha256("anita-ben:wax-seal"));
    expect(key).not.toContain("anita");
  });
});
