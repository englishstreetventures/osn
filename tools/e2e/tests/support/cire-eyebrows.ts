/**
 * An eyebrow over a heading, read from the page: the small-caps line drawn
 * straight above a title. Cire draws one only where it says something the
 * screen does not already — a count, a state, the tier, the portal's name —
 * and never one that repeats the module, the tab or the heading itself
 * (`cire/host/DESIGN.md` §3, "An eyebrow over a heading says what the screen
 * does not").
 *
 * The reader is the one the portals' browser tests use
 * (`cire/host/tests/test-support/eyebrow-over.ts`), run in the page.
 */

import type { Locator } from "@playwright/test";

import { eyebrowOver as readEyebrowOver } from "../../../../cire/host/tests/test-support/eyebrow-over";

/** The text of the eyebrow straight above `heading`, or "" when there is none. */
export function eyebrowOver(heading: Locator): Promise<string> {
  return heading.evaluate(readEyebrowOver);
}
