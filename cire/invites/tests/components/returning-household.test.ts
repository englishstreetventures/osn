import { createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWelcomeBack,
  returningHousehold,
  setReturningHousehold,
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

describe("createWelcomeBack", () => {
  it("holds the server's choice until the hero has mounted, even when the household is already known", () => {
    // Hydration keeps the server's attributes, so the first value the hero
    // renders must be the server's, whatever the store holds by the time the
    // hero hydrates. Effects in a root run once its body has returned, which
    // is the hero's mount.
    setReturningHousehold(true);
    let welcomeBack!: () => boolean;
    let beforeMount = true;
    const dispose = createRoot((disposeRoot) => {
      welcomeBack = createWelcomeBack();
      beforeMount = welcomeBack();
      return disposeRoot;
    });

    expect(beforeMount).toBe(false);
    expect(welcomeBack()).toBe(true);
    dispose();
  });

  it("follows the store after mount, both ways", () => {
    let welcomeBack!: () => boolean;
    const dispose = createRoot((disposeRoot) => {
      welcomeBack = createWelcomeBack();
      return disposeRoot;
    });

    expect(welcomeBack()).toBe(false);
    setReturningHousehold(true);
    expect(welcomeBack()).toBe(true);
    // A sign-out clears the household, and the hero goes back to the first-visit copy.
    setReturningHousehold(false);
    expect(welcomeBack()).toBe(false);
    dispose();
  });
});
