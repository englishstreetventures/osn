import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every text field on the guest site and the marketing site's demo is
 * `@shared/ui`'s `Input` or `Textarea` with `fill="ink"`: the edge and fill
 * drawn from the scheme's ink, so the field reads on whatever surface the
 * couple chose, at the touch size, so it is never under 44px and its type
 * never under 16px on a phone (`wiki/cire/cire-invite-designs.md`, Fields).
 * A field drawn by hand drifts from that, so this reads every `<input` and
 * `<textarea` under both apps' `src/` and fails on one that is not a choice
 * radio or a checkbox, and on any shared field without the ink fill and the
 * touch size.
 *
 * Static: a JSX `<input>` is self-closing, so its attributes run from `<input`
 * to the next `/>`; a shared part's opening tag runs to the first `>` outside
 * braces and quotes.
 */

const APPS = ["invites", "landing"].map((app) =>
  join(import.meta.dirname, "..", "..", "..", app, "src"),
);

function openingTag(text: string, start: number): string {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (depth === 0 && (ch === '"' || ch === "'")) {
      quote = ch;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    } else if (ch === ">" && depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function tags(pattern: RegExp): Array<{ at: string; tag: string }> {
  const found: Array<{ at: string; tag: string }> = [];
  for (const src of APPS) {
    const app = src.split("/").at(-2)!;
    for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".tsx")) continue;
      const text = readFileSync(join(src, file), "utf8");
      for (const m of text.matchAll(pattern)) {
        const start = text.indexOf("<", m.index);
        const line = text.slice(0, start).split("\n").length;
        found.push({ at: `${app}/${file}:${line}`, tag: openingTag(text, start) });
      }
    }
  }
  return found;
}

describe("guest-site text fields", () => {
  it("are never drawn by hand: a raw input is a choice radio or a checkbox", () => {
    // At the start of a line, as JSX is written, so a comment naming one is not one.
    const raw = [...tags(/^\s*<input(?=[\s/>])/gm), ...tags(/^\s*<textarea(?=[\s/>])/gm)];
    expect(
      raw.filter((t) => !/type=["'](radio|checkbox)["']/.test(t.tag)).map((t) => t.at),
    ).toEqual([]);
  });

  it("take the ink fill at the touch size", () => {
    const shared = tags(/<(Input|Textarea)(?=[\s/>])/g);
    // A scan that found nothing would pass whatever the source says.
    expect(shared.length).toBeGreaterThanOrEqual(11);
    expect(
      shared
        .filter((t) => !(/\bfill="ink"/.test(t.tag) && /\bsize="touch"/.test(t.tag)))
        .map((t) => t.at),
    ).toEqual([]);
  });
});
