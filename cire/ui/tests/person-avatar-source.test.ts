import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import source from "../src/person-avatar.tsx?raw";

/*
 * Vendor's top bar draws its account trigger, `PersonAvatar` inside
 * `avatarTriggerClass`, as a placeholder before the account menu's chunk has
 * loaded. That holds only while the part, and the shared `Avatar` it is built
 * on, import no menu library.
 */
/** The shared `Avatar` the part is built on, read as text. */
const avatar = readFileSync(
  new URL("../../../shared/ui/src/ui/avatar.tsx", import.meta.url),
  "utf8",
);

describe("person-avatar.tsx", () => {
  it("loads no menu library", () => {
    expect(source).not.toMatch(/@kobalte/);
    expect(source.match(/from "([^"]+)"/g)).toEqual([
      'from "@shared/ui/ui/avatar"',
      'from "solid-js"',
    ]);
    expect(avatar).not.toMatch(/@kobalte/);
  });
});
