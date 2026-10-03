import { createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHeroFallbackTitle,
  HERO_FALLBACK_TITLE,
  returningHousehold,
  setReturningHousehold,
  WELCOME_BACK,
} from "../../src/components/returning-household";

afterEach(() => {
  // Module state outlives each case; put it back.
  setReturningHousehold(false);
});

describe("returningHousehold", () => {
  it("starts false and follows what the panel publishes", () => {
    expect(returningHousehold()).toBe(false);
    setReturningHousehold(true);
    expect(returningHousehold()).toBe(true);
    setReturningHousehold(false);
    expect(returningHousehold()).toBe(false);
  });
});

describe("createHeroFallbackTitle", () => {
  it("reads the server's copy until the hero has mounted, even when the household is already known", () => {
    // Hydration keeps the server's text node for a string it is handed, so the
    // first value the hero renders must be the server's, whatever the store
    // holds by the time the hero hydrates. Effects in a root run once its body
    // has returned, which is the hero's mount.
    setReturningHousehold(true);
    let title!: () => string;
    let beforeMount = "";
    const dispose = createRoot((disposeRoot) => {
      title = createHeroFallbackTitle();
      beforeMount = title();
      return disposeRoot;
    });

    expect(beforeMount).toBe(HERO_FALLBACK_TITLE);
    expect(title()).toBe(WELCOME_BACK);
    dispose();
  });

  it("follows the store after mount, both ways", () => {
    let title!: () => string;
    const dispose = createRoot((disposeRoot) => {
      title = createHeroFallbackTitle();
      return disposeRoot;
    });

    expect(title()).toBe(HERO_FALLBACK_TITLE);
    setReturningHousehold(true);
    expect(title()).toBe(WELCOME_BACK);
    // A sign-out clears the household, and the hero goes back to the first-visit copy.
    setReturningHousehold(false);
    expect(title()).toBe(HERO_FALLBACK_TITLE);
    dispose();
  });
});
