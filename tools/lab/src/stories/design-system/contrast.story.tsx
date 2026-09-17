import { CONTRACT_COLOR_TOKENS, contrastPairs, WCAG_TEXT, WCAG_UI } from "@shared/design-tokens";
import { For } from "solid-js";

import type { Story, StoryArgs } from "../../lab/types.ts";
import { ContrastCell, Gallery, Mono, Rule, Section } from "./chrome.tsx";
import { shortName } from "./utilities.ts";

export const meta = { title: "design-system/contrast", layout: "padded" as const };

interface PairsArgs extends StoryArgs {
  sample: string;
}

const GROUNDS: readonly string[] = [
  ...CONTRACT_COLOR_TOKENS.grounds,
  ...CONTRACT_COLOR_TOKENS.surfaces,
];

interface InkRow {
  fg: string;
  min: number;
}

interface FillPair {
  fg: string;
  bg: string;
  min: number;
}

/** The harness's flat pair list, folded into what the matrix renders. */
interface PairMatrix {
  rows: InkRow[];
  onFill: FillPair[];
}

/**
 * `contrastPairs()` is flat: one entry per (fg, bg, floor). The matrix wants
 * one row per ink with the grounds across the top, so the ink rows are folded
 * back out of it — from the export, never retyped — and the three on-fill
 * pairs, whose ground is a fill rather than a page, are kept aside.
 */
function foldPairs(): PairMatrix {
  const rows: InkRow[] = [];
  const onFill: FillPair[] = [];
  for (const pair of contrastPairs()) {
    if (GROUNDS.includes(pair.bg)) {
      if (!rows.some((r) => r.fg === pair.fg)) rows.push({ fg: pair.fg, min: pair.min });
    } else {
      onFill.push(pair);
    }
  }
  return { rows, onFill };
}

/**
 * Every pair the conformance harness checks, measured from the painted cell in
 * the current theme. The ratio is written inside the cell in the ink under
 * test, so an unreadable number is the finding.
 */
export const Pairs: Story<PairsArgs> = {
  args: { sample: "Aa" },
  render: (args) => {
    const { rows, onFill } = foldPairs();
    const total = contrastPairs().length;
    return (
      <Gallery
        title="Contrast, measured"
        intro={
          <>
            These are the {total} pairs <Mono>contrastPairs()</Mono> hands to{" "}
            <Mono>assertContractConformance</Mono>: every ink against every ground and surface,
            because a token that clears 4.5:1 on the page and fails on a raised menu is a real
            defect the naive check — ink against the page alone — never sees. The harness reads the
            stylesheet; this reads the pixels, in whichever theme the toggle is on. Body text needs{" "}
            {WCAG_TEXT}:1, large text and non-text UI {WCAG_UI}:1.
          </>
        }
      >
        <Section
          title="Ink on grounds and surfaces"
          eyebrow={`${rows.length} inks × ${GROUNDS.length} grounds`}
        >
          <div class="overflow-x-auto">
            <table class="border-separate border-spacing-x-3 border-spacing-y-2">
              <thead>
                <tr>
                  <th class="text-left align-bottom">
                    <span class="text-ui-xs tracking-ui-wider text-ui-ink-secondary uppercase">
                      on →
                    </span>
                  </th>
                  <For each={GROUNDS}>
                    {(bg) => (
                      <th class="w-40 text-left align-bottom">
                        <Mono>{shortName(bg)}</Mono>
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={rows}>
                  {(row) => (
                    <tr>
                      <th class="w-44 text-left align-top">
                        <div class="flex flex-col gap-0.5">
                          <Mono>{shortName(row.fg)}</Mono>
                          <span class="text-ui-xs text-ui-ink-secondary">floor {row.min}:1</span>
                        </div>
                      </th>
                      <For each={GROUNDS}>
                        {(bg) => (
                          <td class="align-top">
                            <ContrastCell fg={row.fg} bg={bg} min={row.min} sample={args.sample} />
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Ink on a fill" eyebrow={`${onFill.length} pairs`}>
          <Rule>
            On-fill ink is asserted against the fill it names, never against the page:{" "}
            <Mono>on-accent</Mono> sitting on <Mono>ground</Mono> is a combination no component
            produces, and asserting it would fail honest palettes for no reason.
          </Rule>
          <div class="flex flex-wrap gap-6">
            <For each={onFill}>
              {(pair) => (
                <div class="flex w-44 flex-col gap-2">
                  <div class="flex flex-col">
                    <Mono>{shortName(pair.fg)}</Mono>
                    <Mono muted>on {shortName(pair.bg)}</Mono>
                  </div>
                  <ContrastCell fg={pair.fg} bg={pair.bg} min={pair.min} sample={args.sample} />
                </div>
              )}
            </For>
          </div>
        </Section>

        <Section title="What this cannot see">
          <Rule>
            A translucent ground has nothing behind it that two colours can name, so its cells say
            so rather than print a number. A translucent ink is composited over its ground in sRGB
            first — the same arithmetic the harness uses — and the cell says <em>composited</em>.
            Nothing here checks a component that hard-codes a colour; that is the browser tier's
            job.
          </Rule>
        </Section>
      </Gallery>
    );
  },
};
