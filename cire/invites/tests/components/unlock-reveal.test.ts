/**
 * The unlock reveal's guarantees that a browser run cannot reach: what the
 * sequence does when a step never ends, ends early, throws, or runs with no
 * stylesheet, and what it leaves behind. How the reveal looks, frame by frame,
 * is `tests/designs/UnlockReveal.browser.test.ts`.
 *
 * jsdom runs no CSS animation, so `getAnimations` is stood in for: an element
 * the sequence has marked with `data-unlock` reports one animation of that
 * step, ending when the stylesheet's step would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runUnlockReveal, type RevealPack } from "../../src/components/unlock-reveal";

const PACK: RevealPack = { name: "classic", layoutBeatMs: 200 };

/** When each step's animation ends, as classic's block in `global.css` times it. */
const ENDS: Record<string, (el: HTMLElement) => number> = {
  welcome: () => 500,
  shimmer: () => 1200,
  section: () => 500,
  card: (el) => 150 + 120 * Number(el.style.getPropertyValue("--unlock-i") || 0) + 450,
};

type Ending = "finish" | "stall" | "cancel";

let endings: Partial<Record<string, Ending>>;
/** Every step started, in order, with the element it started on. */
let started: { step: string; el: HTMLElement }[];
/** Animations an element carries that are not the reveal's. */
let unrelated: Map<Element, Animation[]>;

function fakeAnimations(this: HTMLElement): Animation[] {
  const own = unrelated.get(this) ?? [];
  const step = this.dataset.unlock;
  if (!step) return own;
  started.push({ step, el: this });
  const endTime = ENDS[step]!(this);
  const ending = endings[step] ?? "finish";
  const finished =
    ending === "finish"
      ? new Promise<void>((resolve) => setTimeout(resolve, endTime))
      : ending === "stall"
        ? new Promise<void>(() => {})
        : Promise.reject(new DOMException("The animation was cancelled", "AbortError"));
  const animation = {
    animationName: `unlock-${step}`,
    finished,
    effect: { getComputedTiming: () => ({ endTime }) },
  };
  return [...own, animation as unknown as Animation];
}

function useAnimations(impl: (this: HTMLElement) => Animation[]) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    value: impl,
    configurable: true,
    writable: true,
  });
}

let welcomeEl: HTMLElement;
let eventsSection: HTMLElement;

function addCards(count: number) {
  for (let i = 0; i < count; i++) {
    const card = document.createElement("div");
    card.setAttribute("data-event-card", "");
    eventsSection.append(card);
  }
  return [...eventsSection.querySelectorAll<HTMLElement>("[data-event-card]")];
}

/** Run the sequence to its end on the fake clock. */
async function runToEnd(hooks?: Parameters<typeof runUnlockReveal>[3]) {
  const run = runUnlockReveal(PACK, welcomeEl, eventsSection, hooks);
  await vi.advanceTimersByTimeAsync(10_000);
  await run;
}

beforeEach(() => {
  vi.useFakeTimers();
  endings = {};
  started = [];
  unrelated = new Map();
  useAnimations(fakeAnimations);
  welcomeEl = document.createElement("div");
  welcomeEl.append(document.createElement("h2"));
  eventsSection = document.createElement("section");
  eventsSection.className = "opacity-0";
  document.body.append(welcomeEl, eventsSection);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
  document.documentElement.style.removeProperty("--motion-scale");
  document.body.replaceChildren();
});

describe("runUnlockReveal", () => {
  // The code form holds a live field and button, so it closes at once rather
  // than fading. `display` on it belongs to SolidJS — an imperative write
  // desynchronises its style binding for the life of the page — so the
  // sequence reports the swap, and does so before the welcome's step, which
  // a hidden welcome could not play.
  it("reports the form hidden once, before any step starts", async () => {
    const stepsWhenReported: string[][] = [];
    const onFormHidden = vi.fn(() => {
      stepsWhenReported.push(started.map((s) => s.step));
    });
    await runToEnd({ onFormHidden });
    expect(onFormHidden).toHaveBeenCalledTimes(1);
    expect(stepsWhenReported).toEqual([[]]);
  });

  it("leaves the welcome's display alone and lifts its opacity", async () => {
    welcomeEl.style.display = "none";
    await runToEnd();
    expect(welcomeEl.style.display).toBe("none");
    expect(welcomeEl.style.opacity).toBe("1");
  });

  it("reveals the events at once with no stylesheet, no hooks and no heading", async () => {
    delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
    welcomeEl.replaceChildren();
    eventsSection.style.display = "none";
    const run = runUnlockReveal(PACK, welcomeEl, eventsSection);
    // Nothing to wait for but the layout beat.
    await vi.advanceTimersByTimeAsync(PACK.layoutBeatMs);
    await run;
    expect(eventsSection.style.display).toBe("");
    expect(eventsSection.style.opacity).toBe("1");
  });

  it("reveals everything when starting a step throws", async () => {
    useAnimations(() => {
      throw new Error("boom");
    });
    const cards = addCards(2);
    const onFormHidden = vi.fn();
    await runToEnd({ onFormHidden });
    expect(onFormHidden).toHaveBeenCalledTimes(1);
    expect(eventsSection.style.display).toBe("");
    expect(eventsSection.style.opacity).toBe("1");
    expect(cards.map((c) => c.style.opacity)).toEqual(["1", "1"]);
  });

  // Six cards stagger to 150 + 5 × 120 + 450 = 1200ms; a flat one-second cap
  // would write the end state with the last cards still moving.
  it("waits out the whole stagger before capping a card step that never ends", async () => {
    endings.card = "stall";
    const cards = addCards(6);
    const run = runUnlockReveal(PACK, welcomeEl, eventsSection);
    // The beat comes first.
    await vi.advanceTimersByTimeAsync(PACK.layoutBeatMs + 2190);
    expect(cards[5]!.style.opacity).toBe("0");
    await vi.advanceTimersByTimeAsync(20);
    await run;
    expect(cards.map((c) => c.style.opacity)).toEqual(["1", "1", "1", "1", "1", "1"]);
  });

  it("moves on at once from a step whose animation is cancelled", async () => {
    endings.section = "cancel";
    endings.card = "cancel";
    const cards = addCards(2);
    let settled = false;
    const run = runUnlockReveal(PACK, welcomeEl, eventsSection).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(PACK.layoutBeatMs);
    expect(settled).toBe(true);
    await run;
    expect(eventsSection.style.opacity).toBe("1");
    expect(cards.map((c) => c.style.opacity)).toEqual(["1", "1"]);
  });

  // Only the section carries `opacity-0`, so a card not hidden first shows at
  // full opacity from the section's first frame until its own delay ends.
  it("hides the cards before the section's step starts", async () => {
    const cards = addCards(2);
    const atSectionStep: string[] = [];
    useAnimations(function (this: HTMLElement) {
      if (this === eventsSection && this.dataset.unlock === "section") {
        atSectionStep.push(cards.map((c) => c.style.opacity).join(","));
      }
      return fakeAnimations.call(this);
    });
    await runToEnd();
    expect(atSectionStep).toEqual(["0,0"]);
  });

  it("writes the end state inline and leaves no step behind", async () => {
    const cards = addCards(3);
    await runToEnd({ onFormHidden: () => {} });
    expect(eventsSection.style.opacity).toBe("1");
    expect(cards.map((c) => c.style.opacity)).toEqual(["1", "1", "1"]);
    const marked = document.querySelectorAll("[data-unlock], [data-unlock-pack]");
    expect(marked).toHaveLength(0);
    expect(cards.map((c) => c.style.getPropertyValue("--unlock-i"))).toEqual(["", "", ""]);
  });

  it("holds the events' step until the cards are ready", async () => {
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = runUnlockReveal(PACK, welcomeEl, eventsSection, {
      waitForEvents: () => ready,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(started.some((s) => s.step === "section")).toBe(false);
    expect(eventsSection.style.opacity).toBe("");

    addCards(1);
    release();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(started.map((s) => s.step)).toContain("card");
    expect(eventsSection.style.opacity).toBe("1");
  });

  it("hides and reveals cards that render during the layout beat", async () => {
    const run = runUnlockReveal(PACK, welcomeEl, eventsSection, {
      waitForEvents: async () => {
        addCards(1);
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    const card = eventsSection.querySelector<HTMLElement>("[data-event-card]")!;
    expect(started.filter((s) => s.step === "card").map((s) => s.el)).toEqual([card]);
    expect(card.style.opacity).toBe("1");
  });

  it("neither waits on nor caps by an animation that is not the reveal's", async () => {
    unrelated.set(eventsSection, [
      {
        animationName: "spin",
        finished: new Promise<void>(() => {}),
        effect: { getComputedTiming: () => ({ endTime: 60_000 }) },
      } as unknown as Animation,
    ]);
    let settled = false;
    const run = runUnlockReveal(PACK, welcomeEl, eventsSection).finally(() => {
      settled = true;
    });
    // The beat, then the section's own 500ms step.
    await vi.advanceTimersByTimeAsync(PACK.layoutBeatMs + 510);
    expect(settled).toBe(true);
    await run;
  });

  // `--motion-scale` slows every time in the stylesheet so a reveal can be
  // judged frame by frame. A beat that kept its own pace would start the
  // events partway through a slowed welcome, a sequence that never ships.
  it("stretches the layout beat with --motion-scale, as the stylesheet's times stretch", async () => {
    document.documentElement.style.setProperty("--motion-scale", "3");
    const run = runUnlockReveal(PACK, welcomeEl, eventsSection);
    await vi.advanceTimersByTimeAsync(3 * PACK.layoutBeatMs - 10);
    expect(started.some((s) => s.step === "section")).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(started.some((s) => s.step === "section")).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
  });

  describe("with prefers-reduced-motion: reduce", () => {
    beforeEach(() => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({ matches: query.includes("prefers-reduced-motion") })),
      );
    });

    it("lands on the end state at once and starts no step", async () => {
      eventsSection.style.display = "none";
      const onFormHidden = vi.fn();
      await runUnlockReveal(PACK, welcomeEl, eventsSection, { onFormHidden });
      expect(onFormHidden).toHaveBeenCalledTimes(1);
      expect(welcomeEl.style.opacity).toBe("1");
      expect(eventsSection.style.display).toBe("");
      expect(eventsSection.style.opacity).toBe("1");
      expect(started).toEqual([]);
      expect(document.querySelectorAll("[data-unlock]")).toHaveLength(0);
    });
  });
});
