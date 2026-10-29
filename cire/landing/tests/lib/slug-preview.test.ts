import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_DISPLAY_NAME, slugifyDisplayName } from "../../../api/src/lib/slug";
import { MAX_NAME_LENGTH, slugPreview } from "../../src/lib/slug-preview";

/**
 * The closing field previews the link a couple would get. Cire-api makes the
 * real slug (`cire/api/src/lib/slug.ts`), so the preview is only true while
 * this site's copy of the rule gives the same answer on every kind of name.
 * The field's length cap is held to the API's, and so is the organiser
 * portal's, which takes the name the field carries over.
 */

const CORPUS = [
  "Amara & Sam",
  "Nadia & Sam",
  "Pádraig's Big Day",
  "José y María",
  "Zoë + Søren",
  "Ngozi   and    Chidi",
  "  --Hello--  ",
  "...Amara & Sam!!!",
  "🎉💍",
  "Amara 💍 Sam",
  "",
  "   ",
  "ÅÉÎÕÜ ñ ç",
  "Ｆｕｌｌ Ｗｉｄｔｈ",
  "a".repeat(120),
  `${"Amara & Sam ".repeat(10)}`.trim(),
  "x".repeat(59) + " y",
];

describe("the claim field's slug preview", () => {
  it("makes the slug cire-api makes, for every name in the corpus", () => {
    expect(CORPUS.map((name) => slugPreview(name))).toEqual(
      CORPUS.map((name) => slugifyDisplayName(name)),
    );
  });

  it("compares against a real function, not a missing export", () => {
    expect(typeof slugifyDisplayName).toBe("function");
    expect(slugifyDisplayName("Amara & Sam")).toBe("amara-sam");
  });

  it("caps the field at the length cire-api and the portal accept", () => {
    const portal = readFileSync(
      join(import.meta.dirname, "../../../host/src/components/CreateWeddingForm.tsx"),
      "utf8",
    ).match(/const MAX_DISPLAY_NAME = (\d+);/)?.[1];
    if (portal === undefined) {
      throw new Error("CreateWeddingForm.tsx no longer declares `const MAX_DISPLAY_NAME = <n>;`");
    }
    expect([MAX_NAME_LENGTH, Number(portal)]).toEqual([MAX_DISPLAY_NAME, MAX_DISPLAY_NAME]);
  });
});
