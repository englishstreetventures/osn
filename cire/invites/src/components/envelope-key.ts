import { isEnvelopeId } from "@cire/envelope";
import { envelopeKey } from "@cire/envelope/boot";

/**
 * The `data-envelope-key` a design pack's `Document.astro` renders on
 * `<html>`, or `null` for none. No key means no envelope on this page.
 *
 * An envelope opens onto the hero, so there is none unless the hero is shown
 * (the same `heroState` the page renders it by): the organiser's picker tells
 * them so, and this holds the guest site to it. The id must be a catalog id;
 * cire-api already serves `null` for anything else and for a wedding no longer
 * entitled to envelopes, and this check keeps a payload from an older or newer
 * API from putting an unknown envelope on the page.
 */
export async function envelopeKeyFor(input: {
  readonly slug: string;
  readonly envelopeId: string | null | undefined;
  readonly heroShown: boolean;
}): Promise<string | null> {
  if (!input.heroShown || !isEnvelopeId(input.envelopeId)) return null;
  return envelopeKey(input.slug, input.envelopeId);
}
