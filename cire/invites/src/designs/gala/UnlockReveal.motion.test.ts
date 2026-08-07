import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { animateMock, staggerMock } = vi.hoisted(() => ({
  animateMock: vi.fn(() => ({ finished: Promise.resolve() })),
  staggerMock: vi.fn(
    (duration: number, opts: { startDelay: number }) => duration + opts.startDelay,
  ),
}));
vi.mock("motion", () => ({ animate: animateMock, stagger: staggerMock }));

import { unlockRevealSequence } from "./UnlockReveal.motion";

describe("unlockRevealSequence (gala)", () => {
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

  // `display` on the form and the welcome banner belongs to SolidJS — the
  // sequence REPORTS the swap and must never perform it, or it desynchronises
  // Solid's style binding for the life of the page. These two pin that split.
  it("reports the claim panel form hidden after fade-out, without touching display", async () => {
    const onFormHidden = vi.fn();
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection, { onFormHidden });
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(onFormHidden).toHaveBeenCalledTimes(1);
    expect(loginForm.style.display).toBe("");
  });

  it("leaves the welcome element's display alone and only lifts its opacity", async () => {
    welcomeEl.style.display = "none";
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    // Untouched — the island's `revealed` signal is what clears this.
    expect(welcomeEl.style.display).toBe("none");
    expect(welcomeEl.style.opacity).toBe("1");
  });

  it("runs without hooks at all", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(eventsSection.style.opacity).toBe("1");
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
  // without an inline end-state the section ends up invisible after the reveal.
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
    const onFormHidden = vi.fn();
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection, { onFormHidden });
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(onFormHidden).toHaveBeenCalledTimes(1);
    expect(eventsSection.style.display).toBe("");
    expect(eventsSection.style.opacity).toBe("1");
  });

  it("still reveals the events section when the fade-out never settles (1s cap)", async () => {
    animateMock.mockImplementation(() => ({ finished: new Promise(() => {}) }));
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(eventsSection.style.opacity).toBe("1");
  });

  // Motion v12 renamed Motion One's `easing` option to `ease` — the old key is
  // silently ignored, which would drop every custom curve in the sequence.
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
      { opacity: [0.5, 1, 0.9, 1] },
      expect.objectContaining({ duration: 1 }),
    );
  });

  it("skips heading shimmer when no h2 exists", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    const h2Calls = animateMock.mock.calls.filter(
      ([, keyframes]: [unknown, Record<string, unknown>]) =>
        keyframes.opacity && JSON.stringify(keyframes.opacity) === JSON.stringify([0.5, 1, 0.9, 1]),
    );
    expect(h2Calls).toHaveLength(0);
  });

  // Gala's column is wider/denser than classic's — the stagger rhythm is
  // tighter (0.08s cadence, 0.1s start) rather than reused verbatim.
  it("staggers event cards with gala's tighter rhythm", async () => {
    eventsSection.innerHTML = "<div data-event-card></div><div data-event-card></div>";
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(staggerMock).toHaveBeenCalledWith(0.08, { startDelay: 0.1 });
  });

  it("skips stagger when no event cards exist", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(staggerMock).not.toHaveBeenCalled();
  });

  // happy-dom has no matchMedia, so every test above exercises the animated
  // path. A reduced-motion guest must land on the SAME end state.
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
      const onFormHidden = vi.fn();
      await unlockRevealSequence(loginForm, welcomeEl, eventsSection, { onFormHidden });
      // Same split as the animated path: reported, not written.
      expect(onFormHidden).toHaveBeenCalledTimes(1);
      expect(loginForm.style.display).toBe("");
      expect(welcomeEl.style.opacity).toBe("1");
      expect(eventsSection.style.display).toBe("");
      expect(eventsSection.style.opacity).toBe("1");
      expect(animateMock).not.toHaveBeenCalled();
      expect(staggerMock).not.toHaveBeenCalled();
    });
  });
});
