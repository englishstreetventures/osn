import { resetToasts, toast, Toaster, toasts } from "@shared/toast";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The undo window every one-click delete in the portal shares: the row leaves
 * at once, the toast offers Undo for its life, and only a toast that goes
 * without Undo sends the delete. Run against the real toast store and the
 * portal's own `Toaster` mount, so the window is the toast's own clock — hover
 * included — and the toast's look is the portal's stylesheet.
 *
 * Two cases wait out the real five seconds: the window is the thing under test.
 */

vi.mock("../../src/lib/touch-feedback", () => ({
  haptic: () => {},
  hapticsAvailable: () => false,
}));

import { deleteWithUndo, isPendingDelete, UNDO_MS } from "../../src/lib/undo-delete";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Seen {
  hidden: number;
  restored: number;
  commits: { keepalive: boolean; at: number }[];
  raisedAt: number;
}

/** Delete one made-up row through the helper, and count what it asks of the list. */
function deleteRow(name: string): Seen {
  const seen: Seen = { hidden: 0, restored: 0, commits: [], raisedAt: performance.now() };
  deleteWithUndo({
    key: `row:${name}`,
    message: `Deleted “${name}”`,
    restored: `Restored “${name}”`,
    hide: () => {
      seen.hidden += 1;
    },
    restore: () => {
      seen.restored += 1;
    },
    commit: ({ keepalive }) => {
      seen.commits.push({ keepalive, at: performance.now() });
    },
  });
  return seen;
}

/** The toast that names `name`'s delete, or nothing once it has gone. */
const toastOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".ui-toast")].find(
    (el) => el.querySelector(".ui-toast__message")?.textContent === `Deleted “${name}”`,
  );

/** What `var(--dur-slow)` resolves to here, in seconds as the engine writes it. */
function slowRung(): string {
  const probe = document.createElement("div");
  probe.style.transitionDuration = "var(--dur-slow)";
  document.body.append(probe);
  const value = getComputedStyle(probe).transitionDuration;
  probe.remove();
  return value;
}

const mountToaster = () => render(() => <Toaster position="bottom-right" topLayer />);

afterEach(async () => {
  // Ends every toast still up, which settles its delete against this test's
  // spies rather than the next test's.
  resetToasts();
  cleanup();
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("the undo window", () => {
  it("sends nothing while a toast is up, then each delete once, oldest first", async () => {
    mountToaster();
    const first = deleteRow("Book the venue");
    await sleep(250);
    const second = deleteRow("Order the cake");
    await sleep(250);
    const third = deleteRow("Send the invitations");

    for (const seen of [first, second, third]) expect(seen.hidden).toBe(1);
    expect([first, second, third].map((s) => s.commits.length)).toEqual([0, 0, 0]);
    // Raise order is queue order, and the three stand apart rather than on top
    // of one another.
    expect(toasts().map((t) => t.message)).toEqual([
      "Deleted “Book the venue”",
      "Deleted “Order the cake”",
      "Deleted “Send the invitations”",
    ]);
    const boxes = ["Book the venue", "Order the cake", "Send the invitations"].map((name) =>
      toastOf(name)!.getBoundingClientRect(),
    );
    const byTop = boxes.toSorted((a, b) => a.top - b.top);
    for (let k = 1; k < byTop.length; k += 1) {
      expect(byTop[k]!.top).toBeGreaterThanOrEqual(byTop[k - 1]!.bottom - 0.5);
    }
    expect(isPendingDelete("row:Order the cake")).toBe(true);

    await waitFor(() => expect(third.commits).toHaveLength(1), { timeout: UNDO_MS + 2_000 });

    for (const seen of [first, second, third]) {
      expect(seen.commits).toHaveLength(1);
      expect(seen.commits[0]!.keepalive).toBe(false);
      expect(seen.commits[0]!.at - seen.raisedAt).toBeGreaterThanOrEqual(UNDO_MS);
      expect(seen.restored).toBe(0);
    }
    expect(first.commits[0]!.at).toBeLessThan(second.commits[0]!.at);
    expect(second.commits[0]!.at).toBeLessThan(third.commits[0]!.at);
    expect(isPendingDelete("row:Order the cake")).toBe(false);
  }, 15_000);

  it("holds the delete while the pointer rests on its toast", async () => {
    mountToaster();
    const seen = deleteRow("Book the venue");
    await userEvent.hover(toastOf("Book the venue")!);

    await sleep(UNDO_MS + 400);

    expect(seen.commits).toHaveLength(0);
    expect(toastOf("Book the venue")).toBeDefined();
  }, 15_000);

  it("Undo restores its own row, says so, and that delete never goes", async () => {
    mountToaster();
    const first = deleteRow("Book the venue");
    const second = deleteRow("Order the cake");
    const third = deleteRow("Send the invitations");
    const middle = toastOf("Order the cake")!;

    await userEvent.click(within(middle).getByRole("button", { name: "Undo" }));

    expect([first.restored, second.restored, third.restored]).toEqual([0, 1, 0]);
    expect(isPendingDelete("row:Order the cake")).toBe(false);
    // The restore is announced through a toast of its own, in its own live region.
    const said = await screen.findByText("Restored “Order the cake”");
    expect(said.closest(".ui-toast")!.getAttribute("role")).toBe("status");
    expect(said.closest(".ui-toast")!.getAttribute("aria-live")).toBe("polite");

    resetToasts();

    expect(second.commits).toHaveLength(0);
    expect(first.commits).toHaveLength(1);
    expect(third.commits).toHaveLength(1);
  });

  it("arrives on the slow rung and leaves at once, since it holds Undo", async () => {
    mountToaster();
    deleteRow("Book the venue");
    const shown = toastOf("Book the venue")!;
    const arriving = getComputedStyle(shown);
    expect(arriving.animationName).toBe("ui-toast-in");
    expect(arriving.animationDuration).toBe(slowRung());

    toast.dismiss(toasts()[0]!.id);
    // A leaving toast is a new object, so the Toaster draws it as a new node.
    const leaving = await waitFor(() => {
      const el = toastOf("Book the venue");
      expect(el?.classList.contains("ui-toast--leaving")).toBe(true);
      return el!;
    });

    // Gone in the frame it starts leaving: no fade keeps a live Undo on screen.
    expect(getComputedStyle(leaving).display).toBe("none");
  });

  it("sends every pending delete as the page goes, kept alive, and only once", async () => {
    mountToaster();
    const first = deleteRow("Book the venue");
    const second = deleteRow("Order the cake");

    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));

    expect(first.commits.map((c) => c.keepalive)).toEqual([true]);
    expect(second.commits.map((c) => c.keepalive)).toEqual([true]);
    expect(toasts()).toHaveLength(0);

    resetToasts();
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));

    expect(first.commits).toHaveLength(1);
    expect(second.commits).toHaveLength(1);
  });
});
