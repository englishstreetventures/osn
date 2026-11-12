import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";
import ProfileMenu from "../../src/components/ProfileMenu";
import { setThemePreference } from "../../src/lib/preferences";

/**
 * A theme chosen in the account menu cross-fades the whole page through a view
 * transition (DESIGN.md §4, "A theme change cross-fades"; §6). Only an engine
 * runs the transition, resolves the duration tokens on its pseudo-elements and
 * hit-tests the overlay it draws, so these read the running transition back.
 *
 * The theme radios keep the menu open on select, so the open menu is part of
 * both snapshots. While the transition runs, every press lands on `<html>`, and
 * the menu would close as if clicked outside, so the script drops such a press
 * until the fade ends. A second choice or a resize skips a running fade, which
 * must still land the last choice and raise nothing.
 */

const SESSION = {
  osnProfileId: "usr_1",
  email: "alex@example.com",
  handle: "alex",
  displayName: "Alex Host",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

/** A token's value as an engine resolves it, through a probe element. */
function resolved(property: "animationDuration" | "animationTimingFunction", token: string) {
  const probe = document.createElement("div");
  probe.style[property] = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return value;
}

/** Every animation the running view transition draws, keyed by pseudo-element. */
function transitionAnimations() {
  return document
    .getAnimations()
    .filter((a) => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-"));
}

/**
 * Kobalte's menu sets `aria-hidden` on `<body>` as it opens, and again as an
 * open one unmounts, and clears it in a second timer-then-frame callback. A
 * slow machine can draw the two on different frames, so the menu the last test
 * left open can still be hiding `<body>` when this one renders: the trigger is
 * waited for, not read at once.
 */
async function openMenu() {
  render(() => <ProfileMenu session={SESSION} onSecurity={() => {}} onSignOut={() => {}} />);
  const trigger = await screen.findByRole("button", { name: /account menu/i });
  fireEvent.pointerDown(trigger, { button: 0 });
  const menu = await waitFor(() => screen.getByRole("menu"));
  await Promise.all(menu.getAnimations().map((a) => a.finished));
  return menu;
}

const option = (name: string) => screen.getByRole("menuitemradio", { name });

/** Hold every animation of the running transition at its halfway frame. */
function holdHalfway() {
  const running = transitionAnimations();
  for (const a of running) {
    a.pause();
    a.currentTime = Number(a.effect!.getComputedTiming().duration) / 2;
  }
  return running;
}

/**
 * Every promise rejection nobody handled while `body` ran, read after the
 * browser has had a task in which to report one.
 */
async function unhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const caught: unknown[] = [];
  const onRejection = (event: PromiseRejectionEvent) => {
    caught.push(event.reason);
    event.preventDefault();
  };
  window.addEventListener("unhandledrejection", onRejection);
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    window.removeEventListener("unhandledrejection", onRejection);
  }
  return caught;
}

// No fade unless one is asked for, so each test starts from a known theme.
beforeEach(() => setThemePreference("dark"));

afterEach(async () => {
  vi.restoreAllMocks();
  // A test that failed while holding the fade would leave the overlay up for
  // every test after it.
  for (const a of transitionAnimations()) a.finish();
  cleanup();
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("a theme change cross-fades the page", () => {
  it("runs the root snapshots on --dur-base and --ease-in-out, and ends with them", async () => {
    await openMenu();
    const start = vi.spyOn(document, "startViewTransition");

    await userEvent.click(option("Light"));

    expect(start).toHaveBeenCalledOnce();
    const transition = start.mock.results[0]!.value as ViewTransition;
    await transition.ready;
    expect(document.documentElement.dataset.theme).toBe("light");

    const baseMs = parseFloat(resolved("animationDuration", "--dur-base")) * 1000;
    const inOut = resolved("animationTimingFunction", "--ease-in-out");
    const running = transitionAnimations();
    const byPseudo = new Map(running.map((a) => [(a.effect as KeyframeEffect).pseudoElement, a]));
    for (const pseudo of ["::view-transition-old(root)", "::view-transition-new(root)"]) {
      const snapshot = byPseudo.get(pseudo);
      expect(snapshot, `${pseudo} animates`).toBeDefined();
      expect(snapshot!.effect!.getComputedTiming().duration).toBe(baseMs);
      expect(getComputedStyle(document.documentElement, pseudo).animationTimingFunction).toBe(
        inOut,
      );
    }
    // Nothing in the transition outlasts the fade: the overlay goes when it does.
    const ends = running.map((a) => Number(a.effect!.getComputedTiming().endTime));
    expect(Math.max(...ends)).toBe(baseMs);

    await transition.finished;
  });

  it("holds a press made during the fade, keeps the menu open, and frees the pointer with the fade", async () => {
    const menu = await openMenu();
    const start = vi.spyOn(document, "startViewTransition");

    await userEvent.click(option("Light"));
    const first = start.mock.results[0]!.value as ViewTransition;
    await first.ready;
    // Hold the fade halfway, so the transition is certainly running for what
    // follows.
    const running = holdHalfway();

    const dark = option("Dark");
    const box = dark.getBoundingClientRect();
    const centre = [box.x + box.width / 2, box.y + box.height / 2] as const;
    // The browser hit-tests the snapshot, not the menu: a press lands on <html>.
    expect(document.elementFromPoint(...centre)).toBe(document.documentElement);
    const focused = document.activeElement;
    expect(menu.contains(focused)).toBe(true);

    // `force`: Playwright would otherwise wait for the press to reach the item,
    // which is the wait this test is about.
    const clicked: EventTarget[] = [];
    const onClick = (event: MouseEvent) => clicked.push(event.target!);
    window.addEventListener("click", onClick, true);
    try {
      await userEvent.click(dark, { force: true });
    } finally {
      window.removeEventListener("click", onClick, true);
    }
    expect(menu.isConnected).toBe(true);
    // Only the `pointerdown` is dropped: the click that follows reaches <html>.
    expect(clicked).toEqual([document.documentElement]);
    expect(document.activeElement).toBe(focused);
    expect(dark.getAttribute("aria-checked")).toBe("false");
    expect(start).toHaveBeenCalledOnce();

    for (const a of running) a.play();
    await first.finished;
    expect(document.elementFromPoint(...centre)?.closest('[role="menuitemradio"]')).toBe(dark);

    await userEvent.click(dark);
    expect(start).toHaveBeenCalledTimes(2);
    await (start.mock.results[1]!.value as ViewTransition).finished;
    expect(menu.isConnected).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(dark.getAttribute("aria-checked")).toBe("true");

    // Neither fade left its hold behind: a press on <html> goes through again.
    const later = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    expect(document.documentElement.dispatchEvent(later), "press after the fades").toBe(true);
  });

  it("takes no press mid-fade even with pointer-events: none on the overlay", async () => {
    const rule = document.createElement("style");
    rule.textContent = "::view-transition { pointer-events: none; }";
    document.head.append(rule);
    try {
      await openMenu();
      const start = vi.spyOn(document, "startViewTransition");
      await userEvent.click(option("Light"));
      const transition = start.mock.results[0]!.value as ViewTransition;
      await transition.ready;
      const running = holdHalfway();

      const box = option("Dark").getBoundingClientRect();
      expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(
        document.documentElement,
      );

      for (const a of running) a.play();
      await transition.finished;
    } finally {
      rule.remove();
    }
  });

  it("lands on the last of two quick choices, and the skipped fade raises nothing", async () => {
    await openMenu();
    const start = vi.spyOn(document, "startViewTransition");

    const rejections = await unhandledRejections(async () => {
      // Light, then Dark, inside one fade: a keyboard choice is never held, so
      // two can arrive this close. The second skips the first's fade.
      setThemePreference("light", { fade: true });
      setThemePreference("dark", { fade: true });
      expect(start).toHaveBeenCalledTimes(2);
      await Promise.all(start.mock.results.map((r) => (r.value as ViewTransition).finished));
    });

    expect(rejections).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(option("Dark").getAttribute("aria-checked")).toBe("true");
  });

  it("lands the choice, and raises nothing, when the viewport changes mid-fade", async () => {
    const size = { width: window.innerWidth, height: window.innerHeight };
    await openMenu();
    const start = vi.spyOn(document, "startViewTransition");

    try {
      const rejections = await unhandledRejections(async () => {
        // A phone turned mid-fade. The browser skips a transition whose
        // viewport changes before it starts to animate.
        setThemePreference("light", { fade: true });
        await page.viewport(size.width + 100, size.height);
        await (start.mock.results[0]!.value as ViewTransition).finished;
      });

      expect(rejections).toEqual([]);
      expect(document.documentElement.dataset.theme).toBe("light");
    } finally {
      await page.viewport(size.width, size.height);
    }
  });
});

describe("a theme change with no cross-fade", () => {
  it("changes at once under reduced motion, with no transition", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    await openMenu();
    const start = vi.spyOn(document, "startViewTransition");

    await userEvent.click(option("Light"));

    expect(start).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(transitionAnimations()).toEqual([]);
  });

  it("changes at once, with no error, where the browser has no view transitions", async () => {
    Object.defineProperty(document, "startViewTransition", {
      value: undefined,
      configurable: true,
    });
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener("error", onError);
    try {
      await openMenu();
      await userEvent.click(option("Light"));
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(option("Light").getAttribute("aria-checked")).toBe("true");
    } finally {
      window.removeEventListener("error", onError);
      delete (document as { startViewTransition?: unknown }).startViewTransition;
    }
    expect(errors).toEqual([]);
  });
});
