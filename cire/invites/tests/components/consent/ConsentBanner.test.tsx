import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConsentBanner,
  ConsentPreferencesLink,
} from "../../../src/components/consent/ConsentBanner";
import { readConsentFromDocument, writeConsentToDocument } from "../../../src/lib/consent/cookie";
import {
  CONSENT_POLICY_VERSION,
  allGrants,
  defaultGrants,
  encodeConsentRecord,
  makeConsentRecord,
} from "../../../src/lib/consent/record";
import { consentPreferencesOpen } from "../../../src/lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../../../src/lib/consent/testing";
import { onSecureOriginWithJar } from "../../test-support/secure-origin";

const bannerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('section[aria-label="Privacy choices"]');

/**
 * `dialog`, not `[role="dialog"]`: the panel is the platform's own `<dialog>`
 * now, and its dialog role is implicit rather than an attribute.
 */
const dialog = () => document.querySelector("dialog");

/** The first-layer prompt's dialog, told apart from the preferences one by its heading. */
const prompt = () =>
  [...document.querySelectorAll("dialog")].find(
    (candidate) => candidate.querySelector("h2")?.textContent === "Privacy choices",
  ) ?? null;

const buttonLabels = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim());

const buttonOf = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;

/**
 * What both forms of the prompt must say and offer. `within` is the form's
 * root: the banner's `<section>` or the prompt's `<dialog>`.
 */
function sharedPromptContract(mount: () => HTMLElement) {
  it("tells the guest third-party content stays off until they allow it, and names who gets the data", () => {
    // Nothing of Google's or Pinterest's loads before the guest says yes, and
    // the prompt says so — naming both companies and what they would see.
    const text = mount().textContent ?? "";

    expect(text).toContain("Google");
    expect(text).toContain("Pinterest");
    expect(text).toContain("IP address");
    expect(text.toLowerCase()).toContain("stay off until you allow them");
  });

  it("names the answer that allows it", () => {
    // The highlighted answer keeps it off; the copy says which one turns it on,
    // so neither label needs working out.
    expect(mount().querySelector("p")?.textContent).toContain("“Accept all”");
  });

  it("links to both legal pages from the prompt itself", () => {
    const root = mount();
    expect(root.querySelector('a[href="/privacy"]')).not.toBeNull();
    expect(root.querySelector('a[href="/terms"]')).not.toBeNull();
  });

  it("offers 'Accept all', 'Reject all' and 'Choose', in that order, all three alike", () => {
    // Refusing must be exactly as easy and as visible as accepting. One
    // component draws all three, so no answer can be promoted above another by
    // a tweak to one button.
    const root = mount();
    expect(buttonLabels(root)).toEqual(["Accept all", "Reject all", "Choose"]);
    const all = buttonOf(root, "Accept all");
    const reject = buttonOf(root, "Reject all");
    const choose = buttonOf(root, "Choose");
    expect(reject.className).toBe(all.className);
    expect(choose.className).toBe(all.className);
    expect(reject.tagName).toBe(all.tagName);
  });

  it("records a refusal on 'Reject all' — writing a record, not just closing", () => {
    fireEvent.click(buttonOf(mount(), "Reject all"));

    const record = readConsentFromDocument();
    expect(record).not.toBeNull();
    expect(record!.grants.pinterest).toBe(false);
    expect(record!.grants.maps).toBe(false);
    // Necessary storage stays on — it is what remembers this very refusal.
    expect(record!.grants.necessary).toBe(true);
    expect(bannerOf(document.body)).toBeNull();
    expect(prompt()).toBeNull();
  });

  it("records every category on 'Accept all' and goes away", () => {
    fireEvent.click(buttonOf(mount(), "Accept all"));

    const record = readConsentFromDocument()!;
    expect(record.grants.pinterest).toBe(true);
    expect(record.grants.maps).toBe(true);
    expect(bannerOf(document.body)).toBeNull();
    expect(prompt()).toBeNull();
  });

  it("stamps the decision with a timestamp and the current policy version", () => {
    fireEvent.click(buttonOf(mount(), "Reject all"));

    const record = readConsentFromDocument()!;
    expect(Number.isNaN(Date.parse(record.decidedAt))).toBe(false);
    expect(record.policy).toBe(CONSENT_POLICY_VERSION);
  });

  it("hands over to the preferences dialog on 'Choose', leaving one dialog", () => {
    // Two competing sets of answers on screen at once would be ambiguous about
    // which one governs.
    fireEvent.click(buttonOf(mount(), "Choose"));

    expect(consentPreferencesOpen()).toBe(true);
    expect(bannerOf(document.body)).toBeNull();
    expect(prompt()).toBeNull();
    expect(document.querySelectorAll("dialog")).toHaveLength(1);
  });
}

describe("ConsentBanner as a dialog (every invite page)", () => {
  beforeEach(resetConsentForTest);

  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  const mount = () => {
    render(() => <ConsentBanner />);
    return prompt()!;
  };

  sharedPromptContract(mount);

  it("asks in a dialog, with no banner, at whatever width", () => {
    const { container } = render(() => <ConsentBanner />);
    expect(prompt()).not.toBeNull();
    expect(bannerOf(container)).toBeNull();
  });

  it("is named by its visible heading and described by the notice itself", () => {
    const panel = mount();
    const heading = panel.querySelector(`#${cssEscape(panel.getAttribute("aria-labelledby")!)}`);
    expect(heading?.textContent).toBe("Privacy choices");
    const description = panel.querySelector(
      `#${cssEscape(panel.getAttribute("aria-describedby")!)}`,
    );
    expect(description?.textContent).toContain("Google");
  });

  it("asks the browser not to close it on Escape or the back gesture", () => {
    expect(mount().getAttribute("closedby")).toBe("none");
  });

  it("refuses the cancel that Escape fires, where the browser lets it", () => {
    const cancel = new Event("cancel", { cancelable: true });
    mount().dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
  });

  it("comes straight back if the browser closes it anyway, and records nothing", () => {
    // A browser that allows a `cancel` to be refused only after the guest has
    // interacted closes the dialog regardless, which `Modal` reports as
    // `close`. Nothing but an answer may end the prompt.
    const { container } = render(() => <ConsentBanner />);
    const first = prompt()!;
    first.dispatchEvent(new Event("close"));

    const second = prompt();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(readConsentFromDocument()).toBeNull();
    expect(bannerOf(container)).toBeNull();
  });

  it("comes back when the preferences dialog is dismissed without saving", () => {
    fireEvent.click(buttonOf(mount(), "Choose"));
    dialog()!.dispatchEvent(new Event("close"));

    expect(consentPreferencesOpen()).toBe(false);
    expect(prompt()).not.toBeNull();
  });

  it("shows nothing to a guest who already decided", () => {
    seedConsentForTest({ pinterest: false });
    const { container } = render(() => <ConsentBanner />);
    expect(prompt()).toBeNull();
    expect(bannerOf(container)).toBeNull();
  });

  it("asks on https even when a bare cookie says the guest decided", () => {
    // A sibling *.cireweddings.com origin can plant a bare `cire_consent`; on
    // https only the guest's own `__Host-` cookie counts.
    const planted = encodeConsentRecord(makeConsentRecord(allGrants(), new Date()));
    onSecureOriginWithJar(`cire_consent=${planted}`, () => {
      render(() => <ConsentBanner />);
      expect(prompt()).not.toBeNull();
    });
  });

  it("goes away on a page restored from the back/forward cache if the guest answered elsewhere", () => {
    // The guest follows the prompt's privacy link, answers on that page and
    // comes back: the browser shows this page as it was, dialog and all, and
    // only `pageshow` says so.
    render(() => <ConsentBanner />);
    expect(prompt()).not.toBeNull();
    writeConsentToDocument(makeConsentRecord(defaultGrants(), new Date()));

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));

    expect(prompt()).toBeNull();
  });

  it("does not re-read the cookie on an ordinary page show", () => {
    render(() => <ConsentBanner />);
    writeConsentToDocument(makeConsentRecord(defaultGrants(), new Date()));

    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));

    expect(prompt()).not.toBeNull();
  });
});

describe("ConsentBanner as a banner (the legal pages)", () => {
  beforeEach(resetConsentForTest);

  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  const mount = () => bannerOf(render(() => <ConsentBanner prompt="banner" />).container)!;

  sharedPromptContract(mount);

  it("shows the banner, and no dialog, to a guest who has not decided", () => {
    expect(mount()).not.toBeNull();
    expect(dialog()).toBeNull();
  });

  it("does NOT show the banner to a guest who already accepted", () => {
    seedConsentForTest({ pinterest: true });
    expect(mount()).toBeNull();
  });

  it("does NOT show the banner to a guest who already REFUSED", () => {
    // The behaviour that separates a consent prompt from a nag: a refusal is a
    // decision and is remembered, so it is never re-asked on the next page load.
    seedConsentForTest({ pinterest: false });
    expect(mount()).toBeNull();
  });
});

describe("ConsentPreferences dialog", () => {
  beforeEach(() => {
    resetConsentForTest();
    render(() => <ConsentBanner />);
    fireEvent.click(within(prompt()!).getByText("Choose"));
  });

  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  it("is a dialog named by its own visible heading", () => {
    // `aria-modal` is not asserted here and is not set: a `showModal()` dialog
    // is modal to the accessibility tree by construction, and writing the
    // attribute on top of that is the way to end up with one that says modal
    // while the element was opened non-modally. `Modal`'s own browser suite is
    // what checks it actually opens modally.
    const panel = dialog()!;
    expect(panel.tagName).toBe("DIALOG");
    const labelId = panel.getAttribute("aria-labelledby")!;
    expect(panel.querySelector(`#${labelId}`)?.textContent).toContain("privacy choices");
  });

  // Withdrawal stops a vendor's embed and its code; it takes back nothing the
  // vendor already received or stored. The dialog is what the guest reads when
  // they withdraw, so it states that limit in short, and never claims more.
  it("says withdrawal stops a vendor without claiming to take back what it received", () => {
    const text = dialog()!.textContent ?? "";
    expect(text).toContain("Turning something off takes effect at once; the page may reload.");
    expect(text).toContain("Data already sent to that company can't be recalled.");
    expect(text).not.toMatch(/\b(removed|cleared|deleted)\b/i);
  });

  it("offers exactly the two switches and Save", () => {
    // What the site stores to work at all is necessary and lives in the
    // privacy notice; the sheet asks only about the two third parties.
    const panel = dialog()!;
    const labels = [...panel.querySelectorAll("label")].map((l) => (l.textContent ?? "").trim());
    expect(labels).toEqual(["Pinterest moodboards", "Google Maps"]);
    expect(panel.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(buttonLabels(panel)).toEqual(["Save choices"]);
  });

  it("shows both switches off for an undecided guest, matching what loads", () => {
    const panel = dialog()!;
    expect(switchOf(panel, "Pinterest moodboards").checked).toBe(false);
    expect(switchOf(panel, "Google Maps").checked).toBe(false);
  });

  it("does not persist a switch until Save is pressed", () => {
    // A guest who flicks a switch to see what it covers and then closes the
    // sheet must not have changed anything — in either direction.
    fireEvent.click(switchOf(dialog()!, "Google Maps"));

    expect(readConsentFromDocument()).toBeNull();
  });

  it("saves each switch on its own", () => {
    const panel = dialog()!;
    fireEvent.click(switchOf(panel, "Google Maps"));
    fireEvent.click(within(panel).getByText("Save choices"));

    const grants = readConsentFromDocument()!.grants;
    expect(grants.maps).toBe(true);
    expect(grants.pinterest).toBe(false);
  });

  it("saves the other switch on its own too", () => {
    const panel = dialog()!;
    fireEvent.click(switchOf(panel, "Pinterest moodboards"));
    fireEvent.click(within(panel).getByText("Save choices"));

    const grants = readConsentFromDocument()!.grants;
    expect(grants.pinterest).toBe(true);
    expect(grants.maps).toBe(false);
  });

  it("names each switch's company and links its privacy policy", () => {
    const panel = dialog()!;
    const text = panel.textContent ?? "";
    expect(text).toContain("Pinterest");
    expect(text).toContain("Google");
    expect(
      panel.querySelector('a[href="https://policy.pinterest.com/privacy-policy"]'),
    ).not.toBeNull();
    expect(panel.querySelector('a[href="https://policies.google.com/privacy"]')).not.toBeNull();
  });

  it("treats a dismissal as no decision at all, whatever dismissed it", () => {
    // Escape and a backdrop click are the platform's now — `<dialog>` does the
    // key, and `Modal` does the hit-test — so both arrive here as one `close`
    // event, and this asserts what the app owns: the draft is discarded, the
    // store reopens to nothing saved, and the banner is still owed an answer.
    // The two gestures themselves are in the browser tier, where a real
    // `<dialog>` exists to perform them.
    const panel = dialog()!;
    fireEvent.click(switchOf(panel, "Pinterest moodboards"));

    panel.dispatchEvent(new Event("close"));

    expect(consentPreferencesOpen()).toBe(false);
    expect(readConsentFromDocument()).toBeNull();
  });
});

describe("ConsentPreferencesLink", () => {
  beforeEach(resetConsentForTest);

  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  it("opens the dialog for a guest who already decided", () => {
    // The standing withdrawal route. Consent must be as easy to take back as it
    // was to give, and by then the banner is long gone.
    seedConsentForTest({ pinterest: true });
    const { getByText } = render(() => <ConsentPreferencesLink />);

    fireEvent.click(getByText("Privacy choices"));
    expect(dialog()).not.toBeNull();
  });

  it("shows the guest's stored choices, so an allowed switch can be switched off", () => {
    seedConsentForTest({ pinterest: true });
    const { getByText } = render(() => <ConsentPreferencesLink />);
    fireEvent.click(getByText("Privacy choices"));

    const panel = dialog()!;
    const pinterest = switchOf(panel, "Pinterest moodboards");
    expect(pinterest.checked).toBe(true);

    fireEvent.click(pinterest);
    fireEvent.click(within(panel).getByText("Save choices"));

    expect(readConsentFromDocument()!.grants.pinterest).toBe(false);
  });

  it("renders only ONE dialog when a banner is also on the page", () => {
    // Two hosts each rendering their own dialog would give the guest two
    // independent drafts, and whichever was saved last would silently win.
    render(() => <ConsentBanner prompt="banner" />);
    const { getByText } = render(() => <ConsentPreferencesLink />);

    fireEvent.click(getByText("Privacy choices"));
    expect(document.querySelectorAll("dialog")).toHaveLength(1);
  });

  it("accepts a custom label", () => {
    const { getByText } = render(() => <ConsentPreferencesLink label="Open my privacy choices" />);
    expect(getByText("Open my privacy choices")).toBeTruthy();
  });
});

/** The switch whose label reads `label`. */
function switchOf(panel: HTMLElement, label: string): HTMLInputElement {
  return panel.querySelector<HTMLInputElement>("#" + cssEscape(labelledInputId(panel, label)))!;
}

/** Find the checkbox id whose <label> text matches, so tests key on copy, not order. */
function labelledInputId(panel: HTMLElement, labelText: string): string {
  const label = [...panel.querySelectorAll("label")].find((candidate) =>
    (candidate.textContent ?? "").includes(labelText),
  );
  if (!label) throw new Error(`no label matching "${labelText}"`);
  const id = label.getAttribute("for");
  if (!id) throw new Error(`label "${labelText}" has no for=`);
  return id;
}

/** Solid's createUniqueId produces ids that need escaping in a CSS selector. */
function cssEscape(id: string): string {
  return id.replace(/([^\w-])/g, "\\$1");
}
