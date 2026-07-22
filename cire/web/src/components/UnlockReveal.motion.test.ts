import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { animateMock, staggerMock } = vi.hoisted(() => ({
  animateMock: vi.fn(() => ({ finished: Promise.resolve() })),
  staggerMock: vi.fn(
    (duration: number, opts: { startDelay: number }) => duration + opts.startDelay,
  ),
}));
vi.mock("motion", () => ({ animate: animateMock, stagger: staggerMock }));

import { unlockRevealSequence } from "./UnlockReveal.motion";

describe("unlockRevealSequence", () => {
  let loginForm: HTMLElement;
  let welcomeEl: HTMLElement;
  let eventsSection: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    animateMock.mockClear();
    animateMock.mockImplementation(() => ({ finished: Promise.resolve() }));
    staggerMock.mockClear();
    loginForm = document.createElement("div");
    welcomeEl = document.createElement("div");
    eventsSection = document.createElement("div");
  });

  it("hides the login form after fade-out", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(loginForm.style.display).toBe("none");
  });

  it("reveals the welcome element", async () => {
    welcomeEl.style.display = "none";
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(welcomeEl.style.display).toBe("");
  });

  it("reveals the events section", async () => {
    eventsSection.style.display = "none";
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(eventsSection.style.display).toBe("");
  });

  // Motion v12 reverts an element to its base styles when a keyframe animation
  // finishes — the events section's base is the `opacity-0` utility class, so
  // without an inline end-state the section ends up invisible after the reveal
  // (the prod "no events" bug).
  it("persists the events section's final opacity as an inline style", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(eventsSection.style.opacity).toBe("1");
  });

  it("still reveals everything when animate throws", async () => {
    animateMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(loginForm.style.display).toBe("none");
    expect(welcomeEl.style.display).toBe("");
    expect(eventsSection.style.display).toBe("");
    expect(eventsSection.style.opacity).toBe("1");
  });

  it("still reveals the events section when the fade-out never settles", async () => {
    animateMock.mockImplementation(() => ({ finished: new Promise(() => {}) }));
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(eventsSection.style.opacity).toBe("1");
  });

  // Motion v12 renamed Motion One's `easing` option to `ease` — the old key is
  // silently ignored, which dropped every custom curve in the sequence.
  it("passes v12 `ease` options, never the removed `easing` key", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(animateMock).toHaveBeenCalled();
    for (const call of animateMock.mock.calls) {
      const options = call[2] as Record<string, unknown>;
      expect(options).not.toHaveProperty("easing");
      expect(options).toHaveProperty("ease");
    }
  });

  it("animates heading shimmer when h2 exists", async () => {
    const h2 = document.createElement("h2");
    welcomeEl.appendChild(h2);
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(animateMock).toHaveBeenCalledWith(
      h2,
      { opacity: [0.4, 1, 0.85, 1] },
      expect.objectContaining({ duration: 1.2 }),
    );
  });

  it("skips heading shimmer when no h2 exists", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    const h2Calls = animateMock.mock.calls.filter(
      ([, keyframes]: [unknown, Record<string, unknown>]) =>
        keyframes.opacity &&
        JSON.stringify(keyframes.opacity) === JSON.stringify([0.4, 1, 0.85, 1]),
    );
    expect(h2Calls).toHaveLength(0);
  });

  // Motion One's `{ start }` stagger option is `{ startDelay }` in v12 — the
  // old key was silently ignored too.
  it("staggers event cards when present", async () => {
    eventsSection.innerHTML = "<div data-event-card></div><div data-event-card></div>";
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(staggerMock).toHaveBeenCalledWith(0.12, { startDelay: 0.15 });
  });

  // happy-dom has no matchMedia, so every test above exercises the animated
  // path. A reduced-motion guest must land on the SAME end state — this file's
  // history is a reveal that left the events invisible in production.
  describe("with prefers-reduced-motion: reduce", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({ matches: query.includes("prefers-reduced-motion") })),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("reveals everything with no animation at all", async () => {
      eventsSection.style.display = "none";
      welcomeEl.style.display = "none";
      await unlockRevealSequence(loginForm, welcomeEl, eventsSection);
      expect(loginForm.style.display).toBe("none");
      expect(welcomeEl.style.display).toBe("");
      expect(welcomeEl.style.opacity).toBe("1");
      expect(eventsSection.style.display).toBe("");
      expect(eventsSection.style.opacity).toBe("1");
      expect(animateMock).not.toHaveBeenCalled();
      expect(staggerMock).not.toHaveBeenCalled();
    });
  });

  it("skips stagger when no event cards exist", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(staggerMock).not.toHaveBeenCalled();
  });
});
