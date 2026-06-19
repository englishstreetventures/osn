import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PinterestBoard, resetPinterestConsentForTest } from "./PinterestBoard";

const VALID_URL = "https://www.pinterest.com.au/example/catholic-wedding-guest-moodboard/";
const CONSENT_KEY = "cire:pinterest-consent";

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

// Click the opt-in consent button rendered by default.
function grantConsent(container: HTMLElement) {
  const button = container.querySelector<HTMLButtonElement>("button");
  if (!button) throw new Error("consent button not found");
  fireEvent.click(button);
}

describe("PinterestBoard", () => {
  let scriptHandle: ReturnType<typeof captureScripts>;

  beforeEach(() => {
    localStorage.clear();
    resetPinterestConsentForTest();
    scriptHandle = captureScripts();
  });

  afterEach(() => {
    cleanup();
    scriptHandle.restore();
    localStorage.clear();
    resetPinterestConsentForTest();
    vi.useRealTimers();
  });

  it("renders nothing for an invalid Pinterest URL", () => {
    const { container } = render(() => (
      <PinterestBoard url="https://evil.com/user/board" eventName="Catholic" />
    ));
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(container.textContent ?? "").not.toContain("View moodboard");
    expect(container.textContent ?? "").not.toContain("Load Pinterest board");
  });

  it("shows only the fallback link (no consent prompt, no embed) for a safe-but-un-embeddable pin.it link", () => {
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
    // no consent prompt and no embed anchor — and no tracker script.
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent ?? "").not.toContain("Load Pinterest board");
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(scriptHandle.all()).toHaveLength(0);
  });

  it("renders the fallback link and consent prompt by default, with NO script injected", () => {
    const { container } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic Ceremony" />
    ));

    // Fallback outbound link is always present.
    const link = container.querySelector<HTMLAnchorElement>('a[href="' + VALID_URL + '"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("View moodboard on Pinterest");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toBe("noopener noreferrer");

    // Opt-in consent affordance is shown; the embed anchor is NOT.
    expect(container.textContent ?? "").toContain("Load Pinterest board");
    expect(container.querySelector("button")).not.toBeNull();
    expect(container.querySelector("a[data-pin-do]")).toBeNull();

    // No tracker script injected on mount.
    expect(scriptHandle.all()).toHaveLength(0);
  });

  it("injects pinit_main.js and renders the embed anchor only after consent", () => {
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(scriptHandle.all()).toHaveLength(0);

    grantConsent(container);

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

    // Fallback link stays visible alongside the embed.
    expect(container.textContent ?? "").toContain("View moodboard on Pinterest");
  });

  it("wraps the fixed-width embed in an overflow-contained box so it can't pan the page sideways on mobile", () => {
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    grantConsent(container);

    const anchor = container.querySelector<HTMLAnchorElement>('a[data-pin-do="embedBoard"]');
    expect(anchor).not.toBeNull();
    // The Pinterest widget renders a fixed-pixel-width iframe; on a narrow
    // viewport that overflow must scroll within its own box, never the page.
    const scrollBox = anchor!.closest("div.overflow-x-auto");
    expect(scrollBox).not.toBeNull();
  });

  it("persists consent across visits so a later mount does not re-prompt", () => {
    const first = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    grantConsent(first.container);
    // localStorage (not sessionStorage) so the choice survives the visit.
    expect(localStorage.getItem(CONSENT_KEY)).toBe("granted");
    cleanup();
    // Simulate a brand-new page load: drop the in-memory signal, keep storage.
    resetPinterestConsentForTest();

    // A later visit reads the persisted consent, injects the script, no prompt.
    const second = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(second.container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(second.container.querySelector("button")).toBeNull();
    expect(scriptHandle.all().length).toBeGreaterThan(0);
  });

  it("mounts already-consented (no prompt) when consent was persisted in a previous visit", () => {
    localStorage.setItem(CONSENT_KEY, "granted");
    resetPinterestConsentForTest();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(scriptHandle.all().length).toBeGreaterThan(0);
  });

  it("accepting on one board immediately unlocks other boards on the same page", () => {
    // Two boards mounted at once (different events). Both start gated.
    const a = render(() => <PinterestBoard url={VALID_URL} eventName="Ceremony" />);
    const b = render(() => <PinterestBoard url={VALID_URL} eventName="Reception" />);
    expect(a.container.querySelector("a[data-pin-do]")).toBeNull();
    expect(b.container.querySelector("a[data-pin-do]")).toBeNull();

    // Accept on board A only.
    grantConsent(a.container);

    // Board B reveals its embed reactively — no second click, no re-prompt.
    expect(a.container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(b.container.querySelector('a[data-pin-do="embedBoard"]')).not.toBeNull();
    expect(b.container.querySelector("button")).toBeNull();
  });

  it("defaults to un-consented on a fresh visit (opt-in, not opt-out)", () => {
    expect(localStorage.getItem(CONSENT_KEY)).toBeNull();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(scriptHandle.all()).toHaveLength(0);
  });

  it("falls back to the link when the script errors after consent", async () => {
    const { container, findByText } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic" />
    ));
    grantConsent(container);
    const script = scriptHandle.last();
    script.dispatchEvent(new Event("error"));
    const link = await findByText(/View moodboard on Pinterest/);
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(VALID_URL);
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
  });

  it("does NOT fall back if the anchor was transformed before the timeout elapses", async () => {
    vi.useFakeTimers();
    const { container, queryByText } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic" />
    ));
    grantConsent(container);
    const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
    // Pinit_main strips data-pin-do and stamps data-pin-internal once it processes the anchor.
    anchor.removeAttribute("data-pin-do");
    anchor.setAttribute("data-pin-internal", "true");
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    // The embed anchor was never replaced by the fallback-only state.
    expect(queryByText(/Load Pinterest board\?/)).toBeNull();
  });

  // The regression that proves the fix: on mobile Pinterest's transform can land
  // AFTER the old fixed 2.5s window. The old code blindly marked the board failed
  // at 2.5s and hid it; the new success-observer keeps it shown as long as the
  // transform arrives before the (much longer) cutoff.
  it("keeps the embed when Pinterest transforms the anchor AFTER the old 2.5s window but before the new cutoff (mobile-slow)", async () => {
    vi.useFakeTimers();
    const { container, queryByText } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic" />
    ));
    grantConsent(container);

    const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
    expect(anchor).not.toBeNull();

    // Advance PAST the old 2.5s race — under the old code the board would already
    // be hidden here. It must still be shown (transform hasn't happened yet, but
    // we no longer blindly fail at 2.5s).
    await vi.advanceTimersByTimeAsync(3500);
    expect(container.querySelector("a[data-pin-do]")).not.toBeNull();
    expect(queryByText(/Load Pinterest board\?/)).toBeNull();

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

    expect(queryByText(/Load Pinterest board\?/)).toBeNull();
    // The container still holds the rendered widget node, not the fallback-only state.
    expect(container.querySelector("iframe[data-pin-internal]")).not.toBeNull();
  });

  // No transformation by the cutoff (a downstream pidgets/CDN block that emits no
  // script `error` event) → fall back to the link.
  it("falls back to the link when no transformation is observed by the cutoff", async () => {
    vi.useFakeTimers();
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    grantConsent(container);
    expect(container.querySelector("a[data-pin-do]")).not.toBeNull();

    // Nothing transforms the anchor. Advance past the longest possible cutoff.
    await vi.advanceTimersByTimeAsync(9000);
    vi.useRealTimers();

    // The embed anchor is gone; the always-visible fallback link remains. (Once
    // the embed is marked failed the consent affordance re-appears, mirroring the
    // script-onerror path — the guest can retry, but the board itself is hidden.)
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('a[href="' + VALID_URL + '"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toContain("View moodboard on Pinterest");
  });

  it("clears the fallback timer when the component unmounts", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, "clearTimeout");
    const { container, unmount } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic" />
    ));
    grantConsent(container);
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    // Advancing past the timeout should not throw / touch a torn-down owner.
    await waitFor(() => Promise.resolve());
    vi.advanceTimersByTime(5000);
    vi.useRealTimers();
  });
});
