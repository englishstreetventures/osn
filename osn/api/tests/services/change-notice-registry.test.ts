import { describe, expect, it } from "vitest";

import {
  noticeDigest,
  parseChangeNotices,
  takesEffectSeconds,
} from "../../src/services/change-notice-registry";
import shipped from "../../src/services/change-notices.json";

/**
 * The change-notice registry: the words every account holder will be mailed,
 * which no one can recall once sent. The shipped file must parse, and an entry
 * that would send a wrong link, an impossible day or an unreadable message must
 * be refused before osn-api or the operator ever uses it.
 */

const good = {
  "privacy-2027-01": {
    document: "privacy notice",
    path: "/privacy",
    takesEffect: "2027-01-01",
    changes: ["We now keep sign-in records for 12 months, not 6."],
  },
};

const withEntry = (entry: Record<string, unknown>) => ({
  "privacy-2027-01": { ...good["privacy-2027-01"], ...entry },
});

describe("parseChangeNotices", () => {
  it("parses the registry osn-api ships", () => {
    expect(() => parseChangeNotices(shipped)).not.toThrow();
  });

  it("reads a good entry, and its day as a UTC midnight", () => {
    const notices = parseChangeNotices(good);
    const notice = notices.get("privacy-2027-01");
    expect(notice).toEqual(good["privacy-2027-01"]);
    expect(takesEffectSeconds(notice!)).toBe(Date.UTC(2027, 0, 1) / 1_000);
  });

  it.each([
    ["not an object", []],
    ["null", null],
    ["an entry that is not an object", { "privacy-2027-01": "x" }],
    ["an id with a capital", { Privacy: good["privacy-2027-01"] }],
    ["an id with a slash", { "privacy/2027": good["privacy-2027-01"] }],
    ["an id starting with a dash", { "-privacy": good["privacy-2027-01"] }],
    ["an id of 64 characters", { ["a".repeat(64)]: good["privacy-2027-01"] }],
    ["a document with a capital", withEntry({ document: "Privacy notice" })],
    ["an empty document", withEntry({ document: "" })],
    ["a document of 41 characters", withEntry({ document: "a".repeat(41) })],
    ["a path with no leading slash", withEntry({ path: "privacy" })],
    ["a path to another host", withEntry({ path: "//evil.example/privacy" })],
    ["a path with a query", withEntry({ path: "/privacy?x=1" })],
    ["a day in another format", withEntry({ takesEffect: "1 January 2027" })],
    ["a day that does not exist", withEntry({ takesEffect: "2027-02-30" })],
    ["no change line", withEntry({ changes: [] })],
    ["nine change lines", withEntry({ changes: Array.from({ length: 9 }, () => "A change.") })],
    ["a change line with a break", withEntry({ changes: ["One\nTwo"] })],
    ["an empty change line", withEntry({ changes: [""] })],
    ["a change line of 301 characters", withEntry({ changes: ["a".repeat(301)] })],
    ["a change line that is not text", withEntry({ changes: [42] })],
    ["a field the registry does not know", withEntry({ subject: "Hello" })],
    ["a missing field", { "privacy-2027-01": { document: "privacy notice", path: "/privacy" } }],
  ])("refuses %s", (_, value) => {
    expect(() => parseChangeNotices(value)).toThrow(/change-notice registry/);
  });
});

describe("noticeDigest", () => {
  it("names exactly the words of one notice", async () => {
    const notice = parseChangeNotices(good).get("privacy-2027-01")!;
    const digest = await noticeDigest(notice);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await noticeDigest({ ...notice })).toBe(digest);
    for (const changed of [
      { ...notice, document: "terms" },
      { ...notice, path: "/terms" },
      { ...notice, takesEffect: "2027-01-02" },
      { ...notice, changes: [...notice.changes, "Another change."] },
      { ...notice, changes: ["We now keep sign-in records for 12 months, not 7."] },
    ]) {
      expect(await noticeDigest(changed)).not.toBe(digest);
    }
  });
});
