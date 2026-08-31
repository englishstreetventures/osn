// @vitest-environment happy-dom
//
// The lab's own smoke test: every story file in the monorepo must import, and
// every story that claims to work headless must render. It is the only thing
// standing between a renamed export in `pulse/web` and a sidebar row that
// throws when someone clicks it — the lab has no other consumer to break.
//
// This file asks for `happy-dom` by pragma rather than in the config, so the
// pure-function tests beside it keep running in `node`.
import { render } from "solid-js/web";
import { beforeAll, describe, expect, it } from "vitest";

import type { Registry } from "../src/lab/registry.ts";
import { loadRegistry, storyFileCount } from "../src/lab/registry.ts";

describe("the story registry", () => {
  // Loaded once. Every story file in the monorepo goes through Vite's
  // transform on the first call, which is seconds on a cold cache — paying
  // that per test is what makes this file look slow and flaky.
  let registry: Registry;

  beforeAll(async () => {
    registry = await loadRegistry();
  }, 120_000);

  it("finds story files at all", () => {
    // Zero means the globs in `registry.ts` stopped matching — a moved
    // workspace, a renamed directory — and every assertion below would then
    // pass over an empty list.
    expect(storyFileCount).toBeGreaterThan(0);
  });

  it("imports every story file without throwing", () => {
    // Named rather than counted, so the failure output says which file and why.
    expect(registry.failures.map((f) => `${f.file}: ${f.error}`)).toEqual([]);
  });

  it("gives every entry a usable shape", () => {
    const { entries } = registry;
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry.id, `${entry.file} has an empty id`).not.toBe("");
      expect(entry.title, `${entry.id} has an empty title`).not.toBe("");
      expect(entry.name, `${entry.id} has an empty name`).not.toBe("");
      expect(
        entry.id.startsWith(entry.title),
        `${entry.id} does not start with its own title`,
      ).toBe(true);
      expect(["centered", "padded", "fullscreen"]).toContain(entry.layout);
      expect(typeof entry.story.render, `${entry.id} has no render function`).toBe("function");
      expect(typeof entry.headless, `${entry.id} has no headless flag`).toBe("boolean");
    }
  });

  it("gives every entry a unique id", () => {
    const ids = registry.entries.map((e) => e.id);
    // `loadRegistry` disambiguates a collision by appending the file path, so a
    // duplicate here means that fix regressed and the sidebar would open the
    // wrong story.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders every story that claims to work headless", () => {
    const headless = registry.entries.filter((e) => e.headless);
    expect(headless.length).toBeGreaterThan(0);

    for (const entry of headless) {
      const host = document.createElement("div");
      document.body.append(host);
      let dispose: (() => void) | undefined;
      try {
        dispose = render(() => entry.story.render(entry.story.args ?? {}), host);
      } catch (error) {
        throw new Error(
          `${entry.id} (${entry.file}) threw while rendering. Set \`headless: false\` in its ` +
            "`meta` if it genuinely needs a real browser.",
          { cause: error },
        );
      } finally {
        dispose?.();
        host.remove();
      }
    }
  });
});
