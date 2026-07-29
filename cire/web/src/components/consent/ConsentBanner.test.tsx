import { cleanup, fireEvent, render, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readConsentFromDocument } from "../../lib/consent/cookie";
import { consentPreferencesOpen } from "../../lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../../lib/consent/testing";
import { ConsentBanner, ConsentPreferencesLink } from "./ConsentBanner";

const bannerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('section[aria-label="Privacy choices"]');

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

const buttonLabels = (root: HTMLElement) =>
  [...root.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim());

describe("ConsentBanner", () => {
  beforeEach(resetConsentForTest);

  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  it("shows the banner to a guest who has not decided", () => {
    const { container } = render(() => <ConsentBanner />);
    expect(bannerOf(container)).not.toBeNull();
  });

  it("does NOT show the banner to a guest who already accepted", () => {
    seedConsentForTest({ embeds: true });
    const { container } = render(() => <ConsentBanner />);
    expect(bannerOf(container)).toBeNull();
  });

  it("does NOT show the banner to a guest who already REFUSED", () => {
    // The behaviour that separates a consent banner from a nag: a refusal is a
    // decision and is remembered, so it is never re-asked on the next page load.
    seedConsentForTest({ embeds: false });
    const { container } = render(() => <ConsentBanner />);
    expect(bannerOf(container)).toBeNull();
  });

  it("offers accept, reject and choose — with reject as reachable as accept", () => {
    const { container } = render(() => <ConsentBanner />);
    const banner = bannerOf(container)!;
    const labels = buttonLabels(banner);

    expect(labels).toContain("Accept all");
    expect(labels).toContain("Reject all");
    expect(labels).toContain("Choose");

    // Reject must not be visually demoted relative to accept. Both are rendered
    // by the same component and therefore carry identical classes — asserting
    // that here is what stops a later "make accept the primary CTA" tweak from
    // quietly turning the banner into a consent funnel.
    const buttons = [...banner.querySelectorAll("button")];
    const accept = buttons.find((b) => b.textContent?.includes("Accept all"))!;
    const reject = buttons.find((b) => b.textContent?.includes("Reject all"))!;
    expect(reject.className).toBe(accept.className);
    expect(reject.tagName).toBe(accept.tagName);
  });

  it("persists every category on 'Accept all' and dismisses the banner", () => {
    const { container } = render(() => <ConsentBanner />);
    fireEvent.click(within(bannerOf(container)!).getByText("Accept all"));

    const record = readConsentFromDocument()!;
    expect(record.grants.embeds).toBe(true);
    expect(record.grants.analytics).toBe(true);
    expect(record.grants.functional).toBe(true);
    expect(bannerOf(container)).toBeNull();
  });

  it("persists a refusal on 'Reject all' — writing a record, not just closing", () => {
    const { container } = render(() => <ConsentBanner />);
    fireEvent.click(within(bannerOf(container)!).getByText("Reject all"));

    const record = readConsentFromDocument();
    expect(record).not.toBeNull();
    expect(record!.grants.embeds).toBe(false);
    expect(record!.grants.analytics).toBe(false);
    // Necessary storage stays on — it is what remembers this very refusal.
    expect(record!.grants.necessary).toBe(true);
    expect(bannerOf(container)).toBeNull();
  });

  it("stamps the decision with a timestamp and the current policy version", () => {
    const { container } = render(() => <ConsentBanner />);
    fireEvent.click(within(bannerOf(container)!).getByText("Reject all"));

    const record = readConsentFromDocument()!;
    expect(Number.isNaN(Date.parse(record.decidedAt))).toBe(false);
    expect(record.policy).toBeTruthy();
  });

  it("opens the preferences dialog on 'Choose' and hides the banner behind it", () => {
    const { container } = render(() => <ConsentBanner />);
    fireEvent.click(within(bannerOf(container)!).getByText("Choose"));

    expect(dialog()).not.toBeNull();
    // Two competing sets of accept/reject controls on screen at once would be
    // ambiguous about which one governs.
    expect(bannerOf(container)).toBeNull();
  });

  it("tells the guest third-party content is ALREADY on, and names who gets the data", () => {
    // Under opt-out the map and moodboard are loading by the time this is read.
    // A banner that asked "may we?" while the request had already gone would be
    // the worst of both postures: no prior consent AND a misleading account of it.
    const { container } = render(() => <ConsentBanner />);
    const text = bannerOf(container)!.textContent ?? "";

    expect(text).toContain("Google");
    expect(text).toContain("Pinterest");
    expect(text.toLowerCase()).toContain("switched on");
    expect(text.toLowerCase()).toContain("turn it off");
  });

  it("links to the privacy notice from the banner itself", () => {
    const { container } = render(() => <ConsentBanner />);
    const link = bannerOf(container)!.querySelector<HTMLAnchorElement>('a[href="/privacy"]');
    expect(link).not.toBeNull();
  });
});

describe("ConsentPreferences dialog", () => {
  beforeEach(() => {
    resetConsentForTest();
    const { container } = render(() => <ConsentBanner />);
    fireEvent.click(within(bannerOf(container)!).getByText("Choose"));
  });

  afterEach(() => {
    cleanup();
    resetConsentForTest();
  });

  it("is an accessible modal dialog with a name", () => {
    const panel = dialog()!;
    expect(panel.getAttribute("aria-modal")).toBe("true");
    const labelId = panel.getAttribute("aria-labelledby")!;
    expect(panel.querySelector(`#${labelId}`)?.textContent).toContain("privacy choices");
  });

  it("locks the strictly-necessary category on", () => {
    const necessary = [
      ...dialog()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ][0]!;
    expect(necessary.checked).toBe(true);
    expect(necessary.disabled).toBe(true);
  });

  it("shows an undecided guest what is ACTUALLY loading, not a row of empty boxes", () => {
    // Opt-out: third-party content and preferences are already on, so their
    // toggles must be ticked. A dialog showing `embeds` unticked while the
    // venue map was on screen would be describing a state the site isn't in.
    const panel = dialog()!;
    const embeds = panel.querySelector<HTMLInputElement>(
      "#" + cssEscape(labelledInputId(panel, "Third-party content")),
    )!;
    const preferences = panel.querySelector<HTMLInputElement>(
      "#" + cssEscape(labelledInputId(panel, "Preferences")),
    )!;
    expect(embeds.checked).toBe(true);
    expect(preferences.checked).toBe(true);
  });

  it("leaves analytics unticked — the one optional category that is opt-in", () => {
    const panel = dialog()!;
    const analytics = panel.querySelector<HTMLInputElement>(
      "#" + cssEscape(labelledInputId(panel, "Analytics")),
    )!;
    expect(analytics.checked).toBe(false);
  });

  it("does not persist a toggle until Save is pressed", () => {
    // A guest who flicks a switch to see what it covers and then closes the
    // dialog must not have changed anything — in either direction.
    const optional = [
      ...dialog()!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([disabled])'),
    ][0]!;
    fireEvent.click(optional);

    expect(readConsentFromDocument()).toBeNull();
  });

  it("persists exactly the categories left switched on when Save is pressed", () => {
    // Start from the opt-out defaults (embeds + preferences on, analytics off),
    // switch embeds OFF and analytics ON, and save. Both directions must stick.
    const panel = dialog()!;
    const embeds = panel.querySelector<HTMLInputElement>(
      "#" + cssEscape(labelledInputId(panel, "Third-party content")),
    )!;
    const analytics = panel.querySelector<HTMLInputElement>(
      "#" + cssEscape(labelledInputId(panel, "Analytics")),
    )!;
    fireEvent.click(embeds);
    fireEvent.click(analytics);
    fireEvent.click(within(panel).getByText("Save choices"));

    const grants = readConsentFromDocument()!.grants;
    expect(grants.embeds).toBe(false);
    expect(grants.analytics).toBe(true);
    // Untouched toggles keep their default.
    expect(grants.functional).toBe(true);
  });

  it("lists the vendors each switch actually governs", () => {
    const text = dialog()!.textContent ?? "";
    expect(text).toContain("This switch controls");
    expect(text).toContain("Pinterest");
    expect(text).toContain("Google Maps");
  });

  it("names the vendors the switch does NOT govern, rather than hiding them", () => {
    // Google Fonts loads from the document head before any choice can apply.
    // Listing it under the toggle would overstate what the toggle does; omitting
    // it would understate what the site loads.
    const text = dialog()!.textContent ?? "";
    expect(text).toContain("Loads on every visit");
    expect(text).toContain("Google Fonts");
  });

  it("offers accept-all and reject-all from inside the dialog too", () => {
    const labels = buttonLabels(dialog()!);
    expect(labels).toContain("Accept all");
    expect(labels).toContain("Reject all");
  });

  it("closes without saving when the backdrop is clicked", () => {
    const backdrop = document.querySelector('[aria-hidden="true"].absolute')!;
    fireEvent.click(backdrop);

    expect(consentPreferencesOpen()).toBe(false);
    expect(readConsentFromDocument()).toBeNull();
  });

  it("closes on Escape without saving", () => {
    fireEvent.keyDown(document, { key: "Escape" });

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
    seedConsentForTest({ embeds: true });
    const { getByText } = render(() => <ConsentPreferencesLink />);

    fireEvent.click(getByText("Privacy choices"));
    expect(dialog()).not.toBeNull();
  });

  it("shows the guest's stored choices, so a granted category can be switched off", () => {
    seedConsentForTest({ embeds: true });
    const { getByText } = render(() => <ConsentPreferencesLink />);
    fireEvent.click(getByText("Privacy choices"));

    const panel = dialog()!;
    const embeds = panel.querySelector<HTMLInputElement>(
      "#" + cssEscape(labelledInputId(panel, "Third-party content")),
    )!;
    expect(embeds.checked).toBe(true);

    fireEvent.click(embeds);
    fireEvent.click(within(panel).getByText("Save choices"));

    expect(readConsentFromDocument()!.grants.embeds).toBe(false);
  });

  it("renders only ONE dialog when a banner is also on the page", () => {
    // Two hosts each rendering their own dialog would give the guest two
    // independent drafts, and whichever was saved last would silently win.
    render(() => <ConsentBanner />);
    const { getByText } = render(() => <ConsentPreferencesLink />);

    fireEvent.click(getByText("Privacy choices"));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("accepts a custom label", () => {
    const { getByText } = render(() => <ConsentPreferencesLink label="Open my privacy choices" />);
    expect(getByText("Open my privacy choices")).toBeTruthy();
  });
});

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
