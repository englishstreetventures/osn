import { describe, expect, it } from "vitest";

import source from "../src/person-avatar.tsx?raw";

/*
 * Vendor's top bar draws its account trigger, `PersonAvatar` inside
 * `avatarTriggerClass`, as a placeholder before the account menu's chunk has
 * loaded. That holds only while the part imports no menu library.
 */
describe("person-avatar.tsx", () => {
  it("loads no menu library", () => {
    expect(source).not.toMatch(/@kobalte/);
  });
});
