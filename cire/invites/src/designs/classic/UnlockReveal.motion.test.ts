import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { animateMock, staggerMock } = vi.hoisted(() => ({
  // Typed with the parameters the real `animate` takes, so a test can assert on
  // the target it was called with — and on the DOM state at that moment.
  animateMock: vi.fn((_target?: unknown, _keyframes?: unknown, _options?: unknown) => ({
    finished: Promise.resolve(),
  })),
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

  // `display` on the form and the welcome banner belongs to SolidJS — the
  // sequence REPORTS the swap and must never perform it, or it desynchronises
  // Solid's style binding for the life of the page. These two pin that split.
  it("reports the login form hidden after fade-out, without touching display", async () => {
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
    const onFormHidden = vi.fn();
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection, { onFormHidden });
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(onFormHidden).toHaveBeenCalledTimes(1);
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
    const h2Calls = animateMock.mock.calls.filter(([, keyframes]) => {
      const frames = keyframes as Record<string, unknown> | undefined;
      return (
        frames?.opacity !== undefined &&
        JSON.stringify(frames.opacity) === JSON.stringify([0.4, 1, 0.85, 1])
      );
    });
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

  it("skips stagger when no event cards exist", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(staggerMock).not.toHaveBeenCalled();
  });

  // The reveal used to write the section's inline `opacity: 1` BEFORE starting
  // the animation. Its base is the `opacity-0` class, so that painted one
  // full-brightness frame of the whole invite, which the animation's first
  // keyframe then dropped back to zero: the events blinked in, vanished, and
  // faded in again. Measured in a real browser as a single frame at
  // `opacity: 1` before the ramp — these two pin the order that avoids it.
  it("never paints the events section at full opacity before animating it", async () => {
    const seen: string[] = [];
    animateMock.mockImplementation((target: unknown) => {
      if (target === eventsSection) seen.push(eventsSection.style.opacity);
      return { finished: Promise.resolve() };
    });
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(seen).toEqual([""]);
  });

  // Nothing hides a card — only their section carries `opacity-0` — so the
  // stagger's 150ms `startDelay` left every card painted at full opacity from
  // the moment the section became visible until Motion committed its first
  // frame. They must be hidden before the section can paint.
  it("hides the event cards before the section becomes visible", async () => {
    eventsSection.innerHTML = "<div data-event-card></div><div data-event-card></div>";
    const cards = [...eventsSection.querySelectorAll<HTMLElement>("[data-event-card]")];
    const seen: string[] = [];
    animateMock.mockImplementation((target: unknown) => {
      if (target === eventsSection) seen.push(cards.map((c) => c.style.opacity).join(","));
      return { finished: Promise.resolve() };
    });
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(seen).toEqual(["0,0"]);
  });

  // Same reason the section keeps an inline end state: Motion v12 reverts to
  // base styles on finish, and a card's base is now the `0` written above.
  it("persists each card's final opacity as an inline style", async () => {
    eventsSection.innerHTML = "<div data-event-card></div><div data-event-card></div>";
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    const cards = [...eventsSection.querySelectorAll<HTMLElement>("[data-event-card]")];
    expect(cards.map((c) => c.style.opacity)).toEqual(["1", "1"]);
  });

  it("reveals the cards even when their animation never settles", async () => {
    eventsSection.innerHTML = "<div data-event-card></div>";
    animateMock.mockImplementation(() => ({ finished: new Promise(() => {}) }));
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    const card = eventsSection.querySelector<HTMLElement>("[data-event-card]");
    expect(card?.style.opacity).toBe("1");
  });

  // The cards come from a `lazy` component, so on a cold cache their chunk can
  // still be in flight when the claim resolves. Revealing then animates an
  // empty section and the cards slam into the layout unanimated when the chunk
  // lands — the "the events just appear" bug.
  describe("waitForEvents", () => {
    it("holds the events step until the cards are ready", async () => {
      eventsSection.style.display = "none";
      let releaseCards: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        releaseCards = resolve;
      });
      const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection, {
        waitForEvents: () => ready,
      });

      await vi.advanceTimersByTimeAsync(1000);
      // Still waiting: nothing has been animated and nothing revealed. The
      // signal is the animation, not `display` — that is cleared before the
      // wait now, so the layout beat can run alongside it rather than after.
      expect(animateMock.mock.calls.some(([target]) => target === eventsSection)).toBe(false);
      expect(eventsSection.style.opacity).toBe("");

      eventsSection.innerHTML = "<div data-event-card></div>";
      releaseCards();
      await vi.advanceTimersByTimeAsync(300);
      await p;
      expect(eventsSection.style.display).toBe("");
      expect(staggerMock).toHaveBeenCalled();
    });

    it("runs the sequence unchanged when no wait is supplied", async () => {
      const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection, {});
      await vi.advanceTimersByTimeAsync(300);
      await p;
      expect(eventsSection.style.opacity).toBe("1");
    });
  });

  // The card stagger's length grows with the number of events, so a flat
  // per-step cap reported it settled — and wrote the inline end state — while
  // cards were still moving. Five events is already 1.08s of stagger in classic.
  it("waits out the whole stagger on an invite with many events", async () => {
    eventsSection.innerHTML = "<div data-event-card></div>".repeat(6);
    const stalled: string[] = [];
    animateMock.mockImplementation((target: unknown) => {
      // Only the card step stalls, so the section's own step cannot mask it.
      if (Array.isArray(target)) {
        stalled.push("cards");
        return { finished: new Promise<void>(() => {}) };
      }
      return { finished: Promise.resolve() };
    });

    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(1200);
    const cards = [...eventsSection.querySelectorAll<HTMLElement>("[data-event-card]")];
    // Past the flat one-animation cap, still inside this stagger's own.
    expect(stalled).toEqual(["cards"]);
    expect(cards[0]?.style.opacity).toBe("0");

    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(cards.map((c) => c.style.opacity)).toEqual(["1", "1", "1", "1", "1", "1"]);
  });

  // The cards can render DURING the layout beat, so the snapshot has to be
  // taken after it — a card missed by the hide loop is a card that arrives at
  // full opacity while its siblings stagger.
  it("hides cards that render during the layout beat", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection, {
      waitForEvents: async () => {
        eventsSection.innerHTML = "<div data-event-card></div>";
      },
    });
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(staggerMock).toHaveBeenCalled();
    const card = eventsSection.querySelector<HTMLElement>("[data-event-card]");
    expect(card?.style.opacity).toBe("1");
  });
});
