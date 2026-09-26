import { describe, expect, it } from "vitest";

import {
  draftFromCustomisation,
  emptyDraft,
  type InviteCustomisation,
  visibilityPayload,
} from "../../../src/components/invite/model";

/**
 * The switches' per-key default, where it is decided. A payload may carry no
 * `visibility`, or only some of its keys (an API that predates a section), and
 * every key it leaves out must read as on — in the draft the builder seeds and
 * in the body it saves.
 */
const BASE: InviteCustomisation = {
  hero: { title: null, subtitle: null, imageUrl: null, imageCrop: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null, imageCrop: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    palettePreset: null,
    palette: {},
    tones: {},
  },
  inviteMessage: null,
};

describe("visibility in the builder draft", () => {
  it("starts every switch on in an empty draft", () => {
    expect(emptyDraft().visibility).toEqual({ hero: true, story: true, footer: true });
  });

  it("reads a payload without visibility as every switch on", () => {
    expect(draftFromCustomisation(BASE).visibility).toEqual({
      hero: true,
      story: true,
      footer: true,
    });
  });

  it("reads a key the payload leaves out as on", () => {
    const draft = draftFromCustomisation({ ...BASE, visibility: { hero: false } });
    expect(draft.visibility).toEqual({ hero: false, story: true, footer: true });
  });

  it("keeps every switch the payload sets", () => {
    const draft = draftFromCustomisation({
      ...BASE,
      visibility: { hero: false, story: false, footer: false },
    });
    expect(draft.visibility).toEqual({ hero: false, story: false, footer: false });
  });
});

describe("visibilityPayload", () => {
  it("always sends every section, in a stable order", () => {
    for (const visibility of [undefined, { story: false }, { footer: false, hero: false }]) {
      const body = visibilityPayload(draftFromCustomisation({ ...BASE, visibility }));
      expect(Object.keys(body)).toEqual(["hero", "story", "footer"]);
    }
    expect(
      visibilityPayload(draftFromCustomisation({ ...BASE, visibility: { story: false } })),
    ).toEqual({ hero: true, story: false, footer: true });
  });
});
