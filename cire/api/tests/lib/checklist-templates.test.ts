import { describe, expect, it } from "bun:test";

import { TIMEFRAME_BUCKET_KEYS } from "../../src/lib/checklist-buckets";
import { STARTER_OFFSET_DAYS } from "../../src/lib/checklist-starter";
import { CHECKLIST_TEMPLATES } from "../../src/lib/checklist-templates";
import { MAX_TITLE_CHARS } from "../../src/schemas/tasks";

// The template is content someone edits by hand. These are the edits that would
// break a wedding's checklist without any other test noticing.

describe.each(Object.entries(CHECKLIST_TEMPLATES))("the %s template", (_id, items) => {
  it("gives every item its own key, so none is skipped as already applied", () => {
    const keys = items.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keys every item with lower-case words joined by hyphens", () => {
    for (const item of items) expect(item.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("titles every item within the limit a task title can be saved at", () => {
    for (const item of items) {
      expect(item.title.trim().length, item.key).toBeGreaterThan(0);
      expect(item.title.length, item.key).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    }
  });

  it("dates no item after the wedding", () => {
    for (const item of items) {
      if (item.offsetDays !== null) expect(item.offsetDays, item.key).toBeLessThanOrEqual(0);
    }
  });
});

describe("the starter's offsets", () => {
  it("come closer to the wedding date bucket by bucket, ending on the day", () => {
    const offsets = TIMEFRAME_BUCKET_KEYS.map((bucket) => STARTER_OFFSET_DAYS[bucket]);
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]!, TIMEFRAME_BUCKET_KEYS[i]).toBeGreaterThan(offsets[i - 1]!);
    }
    expect(STARTER_OFFSET_DAYS.day_of).toBe(0);
  });
});
