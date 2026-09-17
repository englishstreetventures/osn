import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import "../../../src/styles/global.css";
import { ConsentPreferences } from "../../../src/components/consent/ConsentPreferences";
import { readConsentFromDocument } from "../../../src/lib/consent/cookie";
import { consentPreferencesOpen, openConsentPreferences } from "../../../src/lib/consent/store";
import { resetConsentForTest } from "../../../src/lib/consent/testing";

/**
 * The two dismissal gestures, performed against a real `<dialog>`.
 *
 * `ConsentBanner.test.tsx` asserts what the app owns — a dismissal discards the
 * draft and writes nothing — by dispatching the `close` event the platform
 * would have fired. It cannot press Escape or click the backdrop: jsdom
 * implements no part of `<dialog>`, so there is no top layer, no Escape
 * handling, and every box measures zero, which makes the backdrop hit-test
 * meaningless there.
 *
 * This is the half that needs an engine. It is the consent-specific pairing
 * that matters here, not the gestures themselves — `@shared/ui`'s own modal suite
 * covers those — because a dismissal reaching `closeConsentPreferences` without
 * a stored record is the whole difference between a choice and a nag.
 */
describe("the consent dialog's dismissal gestures", () => {
  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  /**
   * `close` is fired from an element task, not a microtask, so a `close()` or
   * `requestClose()` has not reached `Modal`'s listener yet when the next line
   * runs. A zero timeout is the smallest thing that lands after it.
   */
  const afterTheCloseEvent = () => new Promise((resolve) => setTimeout(resolve, 0));

  function open() {
    resetConsentForTest();
    openConsentPreferences();
    render(() => <ConsentPreferences />);
    const dialog = document.querySelector("dialog")!;
    expect(dialog.matches(":modal")).toBe(true);
    return dialog;
  }

  it("closes on Escape, and saves nothing", async () => {
    const dialog = open();

    // A real Escape, driven through the browser. Not a dispatched
    // `KeyboardEvent`, which a modal dialog ignores because the behaviour is
    // the user agent's; and not `requestClose()`, which goes through the
    // close-watcher budget and quietly stops closing anything once a suite has
    // opened a few dialogs without user activation.
    await userEvent.keyboard("{Escape}");
    await afterTheCloseEvent();

    expect(dialog.open).toBe(false);
    expect(consentPreferencesOpen()).toBe(false);
    expect(readConsentFromDocument()).toBeNull();
  });

  it("closes on a backdrop click, and saves nothing", async () => {
    const dialog = open();
    const box = dialog.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);

    // Outside the panel's own box, which is what makes it the backdrop: the
    // backdrop is a pseudo-element and cannot itself be an event target, so a
    // click on it arrives with the dialog as `target`.
    dialog.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: Math.max(0, box.left - 20),
        clientY: Math.max(0, box.top - 20),
      }),
    );
    await afterTheCloseEvent();

    expect(consentPreferencesOpen()).toBe(false);
    expect(readConsentFromDocument()).toBeNull();
  });
});
