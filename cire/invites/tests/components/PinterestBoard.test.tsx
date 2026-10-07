import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PinterestBoard } from "../../src/components/PinterestBoard";
import { readConsentFromDocument } from "../../src/lib/consent/cookie";
import { defaultGrants } from "../../src/lib/consent/record";
import { saveConsent, setReloadPageForTest } from "../../src/lib/consent/store";
import { resetConsentForTest, seedConsentForTest } from "../../src/lib/consent/testing";

const VALID_URL = "https://www.pinterest.com.au/pcvmpasupati/catholic-wedding-guest-moodboard/";

// The legacy, Pinterest-only consent key. Kept here purely so the migration
// test below can assert it is cleaned up and NOT honoured as consent.
const LEGACY_KEY = "cire:pinterest-consent";

// Capture every appended <script> so individual tests can assert the tracker
// was (or was NOT) injected, fire its onerror handler, or inspect its src.
function captureScripts() {
  const originalAppend = document.body.appendChild.bind(document.body);
  const scripts: HTMLScriptElement[] = [];
  vi.spyOn(document.body, "appendChild").mockImplementation((node: Node) => {
    if (node instanceof HTMLScriptElement) {
      // Capture but skip the real append — Pinterest's CDN script must not
      // actually load in jsdom.
      scripts.push(node);
      return node;
    }
    // Everything else (the testing-library render container, Solid's event
    // delegation root) must really attach so clicks dispatch.
    return originalAppend(node);
  });
  return {
    all: () => scripts,
    last: () => scripts[scripts.length - 1],
    restore: () => {
      vi.restoreAllMocks();
      document.body.appendChild = originalAppend;
    },
  };
}

/**
 * Put the store into the "guest switched Pinterest moodboards off" state. An
 * undecided guest gets the same placeholder; this one is a stored refusal.
 */
function refuseThirdPartyContent() {
  seedConsentForTest({ pinterest: false });
}

/**
 * The outbound "View moodboard on Pinterest" link, found by its text. Not by
 * `href`: the embed anchor carries the same one, and once Pinterest strips its
 * `data-pin-do` no attribute selector tells the two apart.
 */
function fallbackLink(container: HTMLElement): HTMLAnchorElement | undefined {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((a) =>
    (a.textContent ?? "").includes("View moodboard on Pinterest"),
  );
}

/**
 * Click the "Allow Pinterest moodboards" button on the blocked-embed
 * placeholder. It is the first button in the placeholder ("Privacy choices",
 * which opens the dialog rather than granting, is the second).
 */
function allowThirdPartyContent(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("consent placeholder button not found");
  expect(button.textContent ?? "").toContain("Allow");
  fireEvent.click(button);
}

describe("PinterestBoard", () => {
  let scriptHandle: ReturnType<typeof captureScripts>;

  beforeEach(() => {
    localStorage.clear();
    resetConsentForTest();
    scriptHandle = captureScripts();
  });

  afterEach(() => {
    cleanup();
    scriptHandle.restore();
    localStorage.clear();
    resetConsentForTest();
    vi.useRealTimers();
  });

  it("renders nothing for an invalid Pinterest URL", () => {
    const { container } = render(() => (
      <PinterestBoard url="https://evil.com/user/board" eventName="Catholic" />
    ));
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(container.textContent ?? "").not.toContain("View moodboard");
    expect(container.textContent ?? "").not.toContain("Allow");
  });

  it("shows only the fallback link (no consent placeholder, no embed) for a safe-but-un-embeddable pin.it link", () => {
    const SHORT_URL = "https://pin.it/3xKp9Qd";
    const { container } = render(() => (
      <PinterestBoard url={SHORT_URL} eventName="Catholic Ceremony" />
    ));

    // The outbound link is present so the guest can still reach the board.
    const link = container.querySelector<HTMLAnchorElement>('a[href="' + SHORT_URL + '"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("View moodboard on Pinterest");
    expect(link!.getAttribute("target")).toBe("_blank");

    // No embed: a short link can't be rendered as a board widget, so there is
    // nothing to consent TO — no request to Pinterest would ever be made. Asking
    // for permission we have no use for would be noise, so no placeholder shows.
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(scriptHandle.all()).toHaveLength(0);
  });

  it("injects nothing before the guest allows it, and offers the placeholder and the link", () => {
    // No consent cookie. Pinterest's script sees the guest's IP address,
    // browser and behaviour, so it waits for the guest's yes; meanwhile the
    // moodboard is still one tap away through the outbound link.
    const { container } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic Ceremony" />
    ));

    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(scriptHandle.all()).toHaveLength(0);
    expect(container.textContent ?? "").toContain("Allow Pinterest moodboards");
    expect(fallbackLink(container)).toBeDefined();
  });

  it("loads the embed, and holds the link back, once the guest has allowed it", () => {
    seedConsentForTest({ pinterest: true });
    const { container } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic Ceremony" />
    ));

    expect(container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(scriptHandle.all()).toHaveLength(1);
    // The board is on its way, so the fallback link is held back.
    expect(fallbackLink(container)).toBeUndefined();
  });

  it("shows the blocked-content placeholder, and injects nothing, once the guest switches it off", () => {
    refuseThirdPartyContent();
    const { container } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic Ceremony" />
    ));

    // The placeholder names Pinterest and what it would do; the embed anchor is
    // NOT mounted and the tracker is never requested.
    expect(container.textContent ?? "").toContain("Pinterest");
    expect(container.textContent ?? "").toContain("Allow Pinterest moodboards");
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(scriptHandle.all()).toHaveLength(0);

    // The moodboard is still reachable — refusing costs the rich embed only.
    expect(container.querySelector('a[href="' + VALID_URL + '"]')).not.toBeNull();
  });

  it("offers a route to the full preferences dialog alongside the one-click allow", () => {
    // Both routes matter: "Allow" alone would be a single-click re-grant with no
    // visible way to see what else that switch covers.
    refuseThirdPartyContent();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(labels.some((label) => label.includes("Allow"))).toBe(true);
    expect(labels.some((label) => label.includes("Privacy choices"))).toBe(true);
  });

  it("injects pinit_main.js and renders the embed anchor when consent is restored", () => {
    refuseThirdPartyContent();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(scriptHandle.all()).toHaveLength(0);

    allowThirdPartyContent(container);

    const anchor = container.querySelector<HTMLAnchorElement>('a[data-pin-do="embedBoard"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe(VALID_URL);
    expect(anchor!.getAttribute("aria-label")).toBe("Pinterest board for Catholic");

    const script = scriptHandle.last();
    expect(script).toBeDefined();
    expect(script.src).toContain("https://assets.pinterest.com/js/pinit_main.js?_=");
    expect(script.src.endsWith(anchor!.id)).toBe(true);
    // No SRI available → no-referrer is the compensating request-time control.
    expect(script.referrerPolicy).toBe("no-referrer");

    // The embed took over from the link the placeholder was showing.
    expect(fallbackLink(container)).toBeUndefined();
  });

  it("writes the granted category to the shared consent record, not a Pinterest-specific key", () => {
    refuseThirdPartyContent();
    // The point of the migration: one site-wide record that the preferences
    // dialog can later show and withdraw, rather than a private key only this
    // component knows about (and which nothing could therefore revoke).
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    allowThirdPartyContent(container);

    const record = readConsentFromDocument();
    expect(record).not.toBeNull();
    expect(record!.grants.pinterest).toBe(true);
    // Allowing the moodboard must not quietly allow the map.
    expect(record!.grants.maps).toBe(false);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("shows an immediate 'Loading board…' affordance the instant consent is granted (no dead blank slot)", () => {
    seedConsentForTest({ pinterest: true });
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);

    // The embed anchor mounted AND the loading status is shown synchronously —
    // the user gets feedback before the (multi-second) script load + transform.
    expect(container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent ?? "").toContain("Loading board");
  });

  it("clears the 'Loading board…' affordance once the embed transform is observed", async () => {
    seedConsentForTest({ pinterest: true });
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    // Pinterest processes the anchor (strips data-pin-do, stamps internal).
    const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
    anchor.removeAttribute("data-pin-do");
    anchor.setAttribute("data-pin-internal", "true");

    // The MutationObserver fires on the attribute change and clears loading.
    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
  });

  it("clears the 'Loading board…' affordance when the script errors (falls back to link)", async () => {
    seedConsentForTest({ pinterest: true });
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    scriptHandle.last().dispatchEvent(new Event("error"));

    await waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
    // Anchor gone, fallback link present.
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(container.textContent ?? "").toContain("View moodboard on Pinterest");
  });

  it("does NOT re-ask for consent after a Pinterest-side failure", async () => {
    seedConsentForTest({ pinterest: true });
    // Consent was given; the embed failing is Pinterest's problem, not a
    // withdrawal. Re-showing the permission prompt would misrepresent a broken
    // third party as the guest's own decision, and invite a pointless re-grant
    // of permission we already hold.
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    scriptHandle.last().dispatchEvent(new Event("error"));

    await waitFor(() => expect(container.querySelector("a[data-pin-do]")).toBeNull());
    expect(container.querySelector("button")).toBeNull();
    expect(readConsentFromDocument()!.grants.pinterest).toBe(true);
  });

  it("wraps the fixed-width embed in an overflow-contained box so it can't pan the page sideways on mobile", () => {
    seedConsentForTest({ pinterest: true });
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);

    const anchor = container.querySelector<HTMLAnchorElement>('a[data-pin-do="embedBoard"]');
    expect(anchor).not.toBeNull();
    // The Pinterest widget renders a fixed-pixel-width iframe; on a narrow
    // viewport that overflow must scroll within its own box, never the page.
    const scrollBox = anchor!.closest("div.overflow-x-auto");
    expect(scrollBox).not.toBeNull();
  });

  it("persists consent across visits so a later mount does not re-prompt", () => {
    refuseThirdPartyContent();
    const first = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    allowThirdPartyContent(first.container);
    // A real cookie (not just an in-memory signal) so the choice survives the visit.
    expect(readConsentFromDocument()?.grants.pinterest).toBe(true);
    cleanup();
    // Simulate a brand-new page load: drop the in-memory store, keep the cookie.
    seedConsentForTest({ pinterest: true });

    // A later visit reads the persisted consent, injects the script, no prompt.
    const second = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(second.container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(second.container.querySelector("button")).toBeNull();
    expect(scriptHandle.all().length).toBeGreaterThan(0);
  });

  it("mounts already-consented (no placeholder) when consent was persisted in a previous visit", () => {
    seedConsentForTest({ pinterest: true });
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(scriptHandle.all().length).toBeGreaterThan(0);
  });

  it("stays blocked for a guest who explicitly refused", () => {
    seedConsentForTest({ pinterest: false });
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(scriptHandle.all()).toHaveLength(0);
  });

  it("clears the legacy Pinterest-only localStorage key without turning it into a decision", () => {
    // A guest who once accepted the old Pinterest-specific gate did so against
    // an older disclosure, so that is not consent to the current one. The key
    // is therefore wiped rather than migrated, and — the part that
    // matters — it does NOT fabricate a stored decision: the guest is still
    // "undecided", so they see the banner and can refuse.
    localStorage.setItem(LEGACY_KEY, "granted");
    resetConsentForTest();
    localStorage.setItem(LEGACY_KEY, "granted");

    render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(readConsentFromDocument()).toBeNull();
  });

  it("allowing on one board immediately unlocks other boards on the same page", () => {
    refuseThirdPartyContent();
    // Two boards mounted at once (different events). Both start gated.
    const a = render(() => <PinterestBoard url={VALID_URL} eventName="Ceremony" />);
    const b = render(() => <PinterestBoard url={VALID_URL} eventName="Reception" />);
    expect(a.container.querySelector("a[data-pin-do]")).toBeNull();
    expect(b.container.querySelector("a[data-pin-do]")).toBeNull();

    // Allow on board A only.
    allowThirdPartyContent(a.container);

    // Board B reveals its embed reactively — no second click, no re-prompt.
    expect(a.container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(b.container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(b.container.querySelector("button")).toBeNull();
  });

  it("never writes a consent record the guest did not actually make", () => {
    // The opt-out defaults apply WITHOUT fabricating a decision. If rendering
    // wrote a record, the banner would stop appearing and the guest would lose
    // the chance to refuse — an implied consent silently promoted to a stored,
    // timestamped one.
    render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(readConsentFromDocument()).toBeNull();
  });

  it("falls back to the link when the script errors after consent", async () => {
    seedConsentForTest({ pinterest: true });
    const { container, findByText } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic" />
    ));
    const script = scriptHandle.last();
    script.dispatchEvent(new Event("error"));
    const link = await findByText(/View moodboard on Pinterest/);
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(VALID_URL);
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
  });

  it("does NOT fall back if the anchor was transformed before the timeout elapses", async () => {
    seedConsentForTest({ pinterest: true });
    vi.useFakeTimers();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
    // Pinit_main strips data-pin-do and stamps data-pin-internal once it processes the anchor.
    anchor.removeAttribute("data-pin-do");
    anchor.setAttribute("data-pin-internal", "true");
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    // The embed slot was never collapsed back to the fallback-only state.
    expect(container.querySelector("[data-pin-internal]")).not.toBeNull();
  });

  // The regression that proves the fix: on mobile Pinterest's transform can land
  // AFTER the old fixed 2.5s window. The old code blindly marked the board failed
  // at 2.5s and hid it; the new success-observer keeps it shown as long as the
  // transform arrives before the (much longer) cutoff.
  it("keeps the embed when Pinterest transforms the anchor AFTER the old 2.5s window but before the new cutoff (mobile-slow)", async () => {
    seedConsentForTest({ pinterest: true });
    vi.useFakeTimers();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);

    const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
    expect(anchor).not.toBeNull();

    // Advance PAST the old 2.5s race — under the old code the board would already
    // be hidden here. It must still be shown (transform hasn't happened yet, but
    // we no longer blindly fail at 2.5s).
    await vi.advanceTimersByTimeAsync(3500);
    expect(container.querySelector("a[data-pin-do]")).not.toBeNull();

    // Now Pinterest finally finishes the transform (slow mobile): it inserts a
    // rendered widget node and processes the anchor.
    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-pin-internal", "true");
    anchor.replaceWith(iframe);
    // Let the MutationObserver microtask fire.
    await vi.advanceTimersByTimeAsync(0);

    // Advance well past the new cutoff: because the transform was observed, the
    // failure timer was cancelled — the embed must NOT fall back.
    await vi.advanceTimersByTimeAsync(10000);
    vi.useRealTimers();

    // The container still holds the rendered widget node, not the fallback-only state.
    expect(container.querySelector("iframe[data-pin-internal]")).not.toBeNull();
    expect(fallbackLink(container)).toBeUndefined();
  });

  // No transformation by the cutoff (a downstream pidgets/CDN block that emits no
  // script `error` event) → fall back to the link.
  it("falls back to the link when no transformation is observed by the cutoff", async () => {
    seedConsentForTest({ pinterest: true });
    vi.useFakeTimers();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(container.querySelector("a[data-pin-do]")).not.toBeNull();

    // Nothing transforms the anchor. Advance past the longest possible cutoff.
    await vi.advanceTimersByTimeAsync(9000);
    vi.useRealTimers();

    // The embed anchor is gone and the fallback link takes its place.
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    const link = fallbackLink(container);
    expect(link).toBeDefined();
    expect(link!.getAttribute("href")).toBe(VALID_URL);
  });

  it("removes the injected tracker tag when the guest withdraws consent", async () => {
    // The highest-risk teardown in the framework. Withdrawal unmounts
    // PinterestEmbed, whose onCleanup must disconnect the MutationObserver,
    // clear the cutoff timer and remove the <script>. A <Show> that failed to
    // dispose would leave Pinterest's tag in the document after the guest
    // switched Pinterest moodboards off — a revocation that revoked nothing.
    seedConsentForTest({ pinterest: true });
    const clearSpy = vi.spyOn(window, "clearTimeout");
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);

    const script = scriptHandle.last();
    expect(script).toBeDefined();
    // The capture harness intercepts the append, so assert removal via the spy
    // on the node itself rather than via the document.
    const removeSpy = vi.spyOn(script, "remove");

    saveConsent({ ...defaultGrants(), pinterest: false });

    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(removeSpy).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
  });

  it("reloads the page when the guest withdraws consent after the board mounted", () => {
    // Removing the tag does not unload what `pinit_main.js` already set up in
    // this page — its globals, listeners and timers. Only a reload does.
    seedConsentForTest({ pinterest: true });
    // After the seed: seeding resets the store, which puts the no-op back.
    const reload = vi.fn();
    setReloadPageForTest(reload);
    render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(scriptHandle.last()).toBeDefined();

    saveConsent({ ...defaultGrants(), pinterest: false });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe("fallback link follows the embed", () => {
    it("shows the link, with safe attributes, when the guest has refused the embed", () => {
      refuseThirdPartyContent();
      const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
      const link = fallbackLink(container);
      expect(link).toBeDefined();
      expect(link!.getAttribute("href")).toBe(VALID_URL);
      expect(link!.getAttribute("target")).toBe("_blank");
      expect(link!.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("hides the link while the embed is loading", () => {
      seedConsentForTest({ pinterest: true });
      const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
      expect(container.querySelector('[role="status"]')).not.toBeNull();
      expect(fallbackLink(container)).toBeUndefined();
    });

    it("keeps the link hidden once the board has rendered", async () => {
      seedConsentForTest({ pinterest: true });
      vi.useFakeTimers();
      const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
      const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
      anchor.removeAttribute("data-pin-do");
      anchor.setAttribute("data-pin-internal", "true");
      await vi.advanceTimersByTimeAsync(0);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(fallbackLink(container)).toBeUndefined();

      // Well past the cutoff: a rendered board never falls back.
      await vi.advanceTimersByTimeAsync(10000);
      expect(fallbackLink(container)).toBeUndefined();
    });

    it("shows the link when the script errors", async () => {
      seedConsentForTest({ pinterest: true });
      const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
      expect(fallbackLink(container)).toBeUndefined();
      scriptHandle.last().dispatchEvent(new Event("error"));
      await waitFor(() => expect(fallbackLink(container)).toBeDefined());
    });

    it("shows the link when nothing renders by the cutoff", async () => {
      seedConsentForTest({ pinterest: true });
      vi.useFakeTimers();
      const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fallbackLink(container)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(4000);
      expect(fallbackLink(container)).toBeDefined();
    });

    it("announces the failure where a screen reader is already listening", async () => {
      seedConsentForTest({ pinterest: true });
      const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
      scriptHandle.last().dispatchEvent(new Event("error"));
      await waitFor(() => expect(fallbackLink(container)).toBeDefined());
      const statuses = Array.from(container.querySelectorAll("[aria-live]"));
      expect(statuses.some((s) => (s.textContent ?? "").includes("could not load"))).toBe(true);
    });

    // The observer normally sees the transform first; this pins the cutoff's own
    // re-check, which must also count a late render as a success.
    it("keeps the link hidden when the cutoff's re-check finds a rendered board", async () => {
      seedConsentForTest({ pinterest: true });
      vi.useFakeTimers();
      vi.stubGlobal(
        "MutationObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
      try {
        const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
        const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
        anchor.removeAttribute("data-pin-do");
        anchor.setAttribute("data-pin-internal", "true");
        await vi.advanceTimersByTimeAsync(9000);
        expect(fallbackLink(container)).toBeUndefined();
        expect(container.querySelector("a[data-pin-internal]")).not.toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // Tests swap the post-revoke page reload for a no-op, so this proves the
    // in-tree path: the gate unmounting the embed hands the board back to the link.
    it("shows the link again when the gate unmounts a rendered embed", () => {
      seedConsentForTest({ pinterest: true });
      const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
      const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
      anchor.removeAttribute("data-pin-do");
      expect(fallbackLink(container)).toBeUndefined();

      saveConsent({ ...defaultGrants(), pinterest: false });

      expect(fallbackLink(container)).toBeDefined();
    });
  });

  it("clears the fallback timer when the component unmounts", async () => {
    seedConsentForTest({ pinterest: true });
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, "clearTimeout");
    const { unmount } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    // Advancing past the timeout should not throw / touch a torn-down owner.
    await waitFor(() => Promise.resolve());
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
  });
});

// Mobile / touch: the embed is no longer desktop-gated. A coarse-pointer /
// no-hover device now gets the SAME consent-gated embed path as desktop
// (previously it got a no-embed link-out card and never loaded the widget).
// matchMedia is mocked to report a touch device on every query, so if anyone
// reintroduces a `matchMedia` capability gate that hides the embed, these fail.
describe("PinterestBoard (mobile / touch — embed enabled)", () => {
  let scriptHandle: ReturnType<typeof captureScripts>;
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
    resetConsentForTest();
    originalMatchMedia = window.matchMedia;
    // Report a touch / coarse-pointer / no-hover device for EVERY media query.
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    scriptHandle = captureScripts();
  });

  afterEach(() => {
    cleanup();
    scriptHandle.restore();
    window.matchMedia = originalMatchMedia;
    localStorage.clear();
    resetConsentForTest();
    vi.useRealTimers();
  });

  it("shows the consent placeholder (not a no-embed link card) on a touch device", () => {
    refuseThirdPartyContent();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);

    // The gate IS shown on touch now — the old touch path showed none, because
    // it never mounted the embed on a coarse-pointer device at all.
    expect(container.querySelector("button")).not.toBeNull();
    expect(container.textContent ?? "").toContain("Pinterest");
    expect(scriptHandle.all()).toHaveLength(0);
    // With the embed refused, the fallback link is the route to the board.
    expect(fallbackLink(container)).toBeDefined();
  });

  it("injects nothing before the guest allows it on touch too", () => {
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(scriptHandle.all()).toHaveLength(0);
    expect(fallbackLink(container)).toBeDefined();
  });

  it("injects the tracker + mounts the embed anchor on consent (touch)", () => {
    refuseThirdPartyContent();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    allowThirdPartyContent(container);

    // After consent the embed anchor mounts and the tracker injects — on touch.
    expect(container.querySelector("a[data-pin-do]")).not.toBeNull();
    expect(scriptHandle.all()).toHaveLength(1);
    expect(scriptHandle.last()!.src).toContain("assets.pinterest.com/js/pinit_main.js");
  });

  it("auto-loads the embed on touch when consent was already persisted", () => {
    seedConsentForTest({ pinterest: true });

    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);

    // Persisted consent now drives the embed on touch too (previously suppressed).
    expect(container.querySelector("a[data-pin-do]")).not.toBeNull();
    expect(scriptHandle.all()).toHaveLength(1);
  });

  it("renders nothing for an unsafe URL on touch too", () => {
    const { container } = render(() => (
      <PinterestBoard url="https://evil.com/user/board" eventName="Catholic" />
    ));
    expect(container.textContent ?? "").not.toContain("View moodboard");
    expect(scriptHandle.all()).toHaveLength(0);
  });
});
