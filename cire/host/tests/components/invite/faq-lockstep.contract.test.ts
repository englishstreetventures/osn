import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULTS, FAQ_CAPS } from "../../../src/components/invite/model";

/**
 * The builder's FAQ bounds and header copy against the files they mirror.
 *
 * `@cire/host` depends on neither `@cire/api` nor `@cire/invites`, so
 * `FAQ_CAPS` cannot import the API's `FAQ_LIMITS`, and the preview's header
 * cannot import the guest page's. Both are hand-kept copies: a limit changed on
 * the server would leave the builder's counters and its "Add" wrong, and header
 * copy changed on the guest page would leave the preview saying something
 * guests never read. These read the source files and fail when either drifts —
 * a text pin, like `tests/lib/wedding-roles.contract.test.ts`.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** The value a `key: <number>` line in `source` declares, or fails the test. */
function numberIn(source: string, key: string, file: string): number {
  const value = source.match(new RegExp(`\\b${key}: (\\d+)`))?.[1];
  expect(value, `could not read ${key} from ${file}`).toBeTruthy();
  return Number(value);
}

/** The string an `export const NAME = "…"` line in `source` declares, or fails. */
function stringIn(source: string, name: string, file: string): string {
  const value = source.match(new RegExp(`export const ${name} = "([^"]*)"`))?.[1];
  expect(value, `could not read ${name} from ${file}`).toBeTruthy();
  return value ?? "";
}

describe("the FAQ bounds match the API's FAQ_LIMITS", () => {
  const file = "cire/api/src/schemas/invite-faq.ts";
  const api = read("../../../../api/src/schemas/invite-faq.ts");

  it("caps entries, questions and answers at the API's numbers", () => {
    expect(FAQ_CAPS.maxEntries).toBe(numberIn(api, "maxEntries", file));
    expect(FAQ_CAPS.question).toBe(numberIn(api, "questionMax", file));
    expect(FAQ_CAPS.answer).toBe(numberIn(api, "answerMax", file));
  });
});

describe("the preview's FAQ header matches the guest page's", () => {
  const file = "cire/invites/src/components/InviteFaq.tsx";
  const guest = read("../../../../invites/src/components/InviteFaq.tsx");

  it("uses the same eyebrow and heading", () => {
    expect(DEFAULTS.faqEyebrow).toBe(stringIn(guest, "FAQ_EYEBROW", file));
    expect(DEFAULTS.faqHeading).toBe(stringIn(guest, "FAQ_HEADING", file));
  });
});
