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
