import { describe, it, expect, vi, beforeEach } from "vitest";

const { animateMock, staggerMock } = vi.hoisted(() => ({
  animateMock: vi.fn(() => ({ finished: Promise.resolve() })),
  staggerMock: vi.fn((duration: number, opts: { start: number }) => duration + opts.start),
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

  it("staggers event cards when present", async () => {
    eventsSection.innerHTML = "<div data-event-card></div><div data-event-card></div>";
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(staggerMock).toHaveBeenCalledWith(0.12, { start: 0.15 });
  });

  it("skips stagger when no event cards exist", async () => {
    const p = unlockRevealSequence(loginForm, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(300);
    await p;
    expect(staggerMock).not.toHaveBeenCalled();
  });
});
