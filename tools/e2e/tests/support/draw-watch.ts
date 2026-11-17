/**
 * What a page draws between an action and a read: whether a loading
 * placeholder ever appeared, which words were ever drawn, and what the
 * document held the moment a given heading first appeared.
 *
 * Playwright's `expect` polls, so it cannot say a placeholder was never drawn,
 * or that a word never showed for one frame. A `MutationObserver` on
 * `document.body`, which outlives every page's `<main>`, files every node
 * added and every text written in place from the moment the watch starts.
 * Its callback runs before the page paints, so a word or placeholder it
 * never saw was in no frame. It waits on the read itself, never on a clock
 * (`tests/flows.test.ts` forbids timeouts).
 *
 * The watch goes in before the action, and one watch runs at a time: starting
 * one stops the last.
 */

import type { Page } from "@playwright/test";

/** A loading placeholder (`@shared/ui`'s `Skeleton`): hidden from readers, the sunk well's fill. */
export const PLACEHOLDER = '[aria-hidden="true"][class*="bg-ui-surface-sunk"]';

/** What the watch saw, read once with `stop`. */
export interface Drawn {
  /** A placeholder was drawn. */
  placeholder: boolean;
  /** Which of the watched words were drawn, in the order first seen. */
  words: string[];
  /**
   * The watched words the document held, and whether it held a placeholder,
   * in the first batch of changes that drew the heading; `null` when it was
   * never drawn.
   */
  firstFrame: { words: string[]; placeholder: boolean } | null;
}

interface InPage {
  observer: MutationObserver;
  file: (records: MutationRecord[]) => void;
  drawn: Drawn;
}

/**
 * Starts watching `page`. `words` are the texts to look for; `heading` is the
 * text of the heading whose first appearance `firstFrame` records.
 */
export async function watchDraws(
  page: Page,
  options: { words?: readonly string[]; heading?: string } = {},
): Promise<{ stop: () => Promise<Drawn> }> {
  await page.evaluate(
    ({ selector, words, heading }) => {
      const w = window as unknown as { __drawWatch?: InPage };
      w.__drawWatch?.observer.disconnect();
      const drawn: Drawn = { placeholder: false, words: [], firstFrame: null };
      const holds = (text: string) => words.filter((word) => text.includes(word));
      const file = (records: MutationRecord[]) => {
        for (const record of records) {
          const nodes = record.type === "characterData" ? [record.target] : [...record.addedNodes];
          for (const node of nodes) {
            for (const word of holds(node.textContent ?? "")) {
              if (!drawn.words.includes(word)) drawn.words.push(word);
            }
            if (!(node instanceof Element)) continue;
            if (node.matches(selector) || node.querySelector(selector)) drawn.placeholder = true;
            if (
              heading !== undefined &&
              drawn.firstFrame === null &&
              [node, ...node.querySelectorAll("h1, h2, h3")].some(
                (el) => /^H[123]$/.test(el.tagName) && el.textContent?.trim() === heading,
              )
            ) {
              drawn.firstFrame = {
                words: holds(document.body.textContent ?? ""),
                placeholder: document.querySelector(selector) !== null,
              };
            }
          }
        }
      };
      const observer = new MutationObserver(file);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      w.__drawWatch = { observer, file, drawn };
    },
    { selector: PLACEHOLDER, words: [...(options.words ?? [])], heading: options.heading },
  );
  return {
    stop: () =>
      page.evaluate(() => {
        const w = window as unknown as { __drawWatch: InPage };
        const watch = w.__drawWatch;
        watch.file(watch.observer.takeRecords());
        watch.observer.disconnect();
        return watch.drawn;
      }),
  };
}

/** Watches `page` for a loading placeholder being drawn, from now until `seen` is read. */
export async function watchPlaceholders(page: Page): Promise<{ seen: () => Promise<boolean> }> {
  const watch = await watchDraws(page);
  return { seen: async () => (await watch.stop()).placeholder };
}
