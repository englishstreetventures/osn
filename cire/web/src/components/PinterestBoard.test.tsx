import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PinterestBoard } from "./PinterestBoard";

const VALID_URL = "https://www.pinterest.com.au/example/catholic-wedding-guest-moodboard/";

// Capture the most recently appended <script> so individual tests can fire
// its onerror handler or assert against its src.
function captureLastScript() {
  const originalAppend = document.body.appendChild.bind(document.body);
  const scripts: HTMLScriptElement[] = [];
  vi.spyOn(document.body, "appendChild").mockImplementation((node: Node) => {
    if (node instanceof HTMLScriptElement) scripts.push(node);
    // Skip the real append — Pinterest's CDN script must not actually load in jsdom.
    return node;
  });
  return {
    last: () => scripts[scripts.length - 1],
    restore: () => {
      vi.restoreAllMocks();
      document.body.appendChild = originalAppend;
    },
  };
}

describe("PinterestBoard", () => {
  let scriptHandle: ReturnType<typeof captureLastScript>;

  beforeEach(() => {
    scriptHandle = captureLastScript();
  });

  afterEach(() => {
    cleanup();
    scriptHandle.restore();
    vi.useRealTimers();
  });

  it("renders nothing for an invalid Pinterest URL", () => {
    const { container } = render(() => (
      <PinterestBoard url="https://evil.com/user/board" eventName="Catholic" />
    ));
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
    expect(container.textContent ?? "").not.toContain("View moodboard");
  });

  it("renders the data-pin-do anchor placeholder for a valid URL", () => {
    const { container } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic Ceremony" />
    ));
    const anchor = container.querySelector<HTMLAnchorElement>('a[data-pin-do="embedBoard"]');
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe(VALID_URL);
    expect(anchor!.getAttribute("data-pin-board-width")).toBe("400");
    expect(anchor!.getAttribute("aria-label")).toBe("Pinterest board for Catholic Ceremony");
  });

  it("loads pinit_main.js with a cache-busted query keyed to the anchor id", () => {
    const { container } = render(() => <PinterestBoard url={VALID_URL} eventName="Catholic" />);
    const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
    const script = scriptHandle.last();
    expect(script).toBeDefined();
    expect(script.src).toContain("https://assets.pinterest.com/js/pinit_main.js?_=");
    expect(script.src.endsWith(anchor.id)).toBe(true);
  });

  it("falls back to a 'View moodboard on Pinterest' link when the script errors", async () => {
    const { container, findByText } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic" />
    ));
    const script = scriptHandle.last();
    script.dispatchEvent(new Event("error"));
    const link = await findByText(/View moodboard on Pinterest/);
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(VALID_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.querySelector("a[data-pin-do]")).toBeNull();
  });

  it("does NOT fall back if the anchor was transformed before the timeout elapses", async () => {
    vi.useFakeTimers();
    const { container, queryByText } = render(() => (
      <PinterestBoard url={VALID_URL} eventName="Catholic" />
    ));
    const anchor = container.querySelector<HTMLAnchorElement>("a[data-pin-do]")!;
    // Pinit_main strips data-pin-do and stamps data-pin-internal once it processes the anchor.
    anchor.removeAttribute("data-pin-do");
    anchor.setAttribute("data-pin-internal", "true");
    await vi.advanceTimersByTimeAsync(3000);
    vi.useRealTimers();
    expect(queryByText(/View moodboard on Pinterest/)).toBeNull();
  });

  it("clears the fallback timer when the component unmounts", async () => {
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
