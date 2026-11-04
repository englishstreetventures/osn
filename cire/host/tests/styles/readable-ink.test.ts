import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Gold is metal and `gold-ink` is ink (`DESIGN.md` §2): `--gold`, `--gold-dim`
 * and `--gold-hi` have no contrast contract, and `--text-faint` is for large
 * text, ornament and the disabled only. So no word or number a host or vendor
 * reads is drawn in any of them, nor in the `@cire/ui` names that point at
 * them (`ui-accent`, `ui-accent-soft`, `ui-accent-strong`, `ui-ink-tertiary`),
 * under any variant — a hover that turns a word gold is the same break.
 *
 * Static, and an inventory rather than a guess: every line under the two
 * portals' `src/` and `@cire/ui`'s `src/` that names one of those inks, as a
 * text colour, must be one this file lists with what it paints and why that
 * is not a word. A class held in a constant, a `classList` key or a template
 * string is a line like any other. A new line fails until it is listed or
 * moved to readable ink, and a listed line that is gone fails too, so the list
 * stays the truth. Comment lines are skipped: they paint nothing.
 *
 * `readable-gold.browser.test.tsx` measures the painted ratio of the words
 * the 2026-11-04 audit named.
 */

const REPO = join(import.meta.dirname, "..", "..", "..", "..");
const SOURCES = ["cire/host/src", "cire/vendor/src", "cire/ui/src"];

/** A text colour in an ink with no 4.5:1 contract, under any variant prefix. */
const UNREADABLE_INK =
  /(?<![\w-])(?:[\w-]+:)*text-(?:gold(?:-dim|-hi)?|ui-accent(?:-soft|-strong)?|text-faint|ui-ink-tertiary)(?:\/\d+)?(?![\w-])/;

/** What may still name one: a glyph or an icon beside words, or a graphic held to 3:1. */
const ORNAMENT: readonly { file: string; line: string; why: string }[] = [
  {
    file: "cire/host/src/components/CommandPalette.tsx",
    line: '<span aria-hidden="true" class="text-gold text-ui-base shrink-0">',
    why: "the ⌘ before the search field, hidden",
  },
  {
    file: "cire/host/src/components/DatePicker.tsx",
    line: 'class="text-gold-dim h-4 w-4 shrink-0"',
    why: "the calendar icon in the date field, beside the date",
  },
  {
    file: "cire/host/src/components/GuestTable.tsx",
    line: '<span aria-hidden="true" class="text-text-faint mr-1.5">',
    why: "the hidden dot between two event names",
  },
  {
    file: "cire/host/src/components/ModuleSidebar.tsx",
    line: 'const rowLocked = "text-text-faint cursor-default";',
    why: "a locked row's icon, a graphic at 3:1; its label is set in --text-muted",
  },
  {
    file: "cire/host/src/components/ModuleSidebar.tsx",
    line: 'isActive() ? "text-gold opacity-80" : "opacity-80"',
    why: "the rail's icon beside its label",
  },
  {
    file: "cire/host/src/components/ModuleSidebar.tsx",
    line: '<ModuleIcon icon={current().icon} class="text-gold" />',
    why: "the phone menu button's icon beside the module's name",
  },
  {
    file: "cire/host/src/components/ModuleSidebar.tsx",
    line: '<ModuleIcon icon={Menu} class="text-gold" />',
    why: "the phone menu button's icon beside its words",
  },
  {
    file: "cire/host/src/components/ModuleSidebar.tsx",
    line: 'class={isActive() ? "text-gold" : "text-gold-dim"}',
    why: "the phone sheet's icons, each beside its module's name",
  },
  {
    file: "cire/host/src/components/SeatingView.tsx",
    line: 'class="text-text-faint hover:text-text min-h-6 min-w-6 cursor-grab touch-none active:cursor-grabbing"',
    why: "a guest's drag grip, a graphic at 3:1 beside the name",
  },
  {
    file: "cire/host/src/components/TaskHolders.tsx",
    line: 'class="text-text-faint size-3.5 shrink-0"',
    why: "the magnifier inside the holder search field",
  },
  {
    file: "cire/host/src/components/WeddingSwitcher.tsx",
    line: 'class="text-text-faint group-hover:text-gold text-ui-xs transition-ui-colors shrink-0',
    why: "the switcher's hidden ▾ beside the wedding's name",
  },
  {
    file: "cire/ui/src/dietary-presets.tsx",
    line: '<span aria-hidden="true" class="text-ui-accent text-ui-xs leading-none">',
    why: "a diet chip's hidden ✓ or + beside its label; the chip's edge and wash mark it",
  },
];

/** Every non-comment line under the sources naming an ink with no contract. */
function inkLines(): { file: string; at: string; text: string }[] {
  const found: { file: string; at: string; text: string }[] = [];
  for (const source of SOURCES) {
    const root = join(REPO, source);
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.(tsx|ts|astro)$/.test(f),
    );
    for (const name of files) {
      const file = `${source}/${name}`;
      readFileSync(join(root, name), "utf8")
        .split("\n")
        .forEach((text, i) => {
          const bare = text.trim();
          if (/^(?:\/\/|\/?\*|\{\/\*)/.test(bare)) return;
          if (UNREADABLE_INK.test(text)) found.push({ file, at: `${file}:${i + 1}`, text: bare });
        });
    }
  }
  return found;
}

describe("the portals' inks", () => {
  it("draw no word or number in an ink with no 4.5:1 contract", () => {
    const lines = inkLines();
    // A scan that read nothing would pass whatever the source says.
    expect(lines.length).toBeGreaterThan(5);
    const unlisted = lines
      .filter((l) => !ORNAMENT.some((o) => o.file === l.file && l.text.includes(o.line)))
      .map((l) => `${l.at}  ${l.text}`);
    expect(unlisted).toEqual([]);
  });

  it("lists only ornament the source still draws", () => {
    const lines = inkLines();
    const stale = ORNAMENT.filter(
      (o) => !lines.some((l) => l.file === o.file && l.text.includes(o.line)),
    ).map((o) => `${o.file}: ${o.why}`);
    expect(stale).toEqual([]);
  });
});
