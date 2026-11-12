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
function deleteRow(name: string, click?: MouseEvent): Seen {
  const seen: Seen = { hidden: 0, restored: 0, commits: [], raisedAt: performance.now() };
  deleteWithUndo(
    {
      key: `row:${name}`,
      message: `Deleted “${name}”`,
      undoName: `Undo deleting “${name}”`,
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
    },
    click,
  );
  return seen;
}

/**
 * A row's ✕, which deletes `name` with the click that pressed it. It carries
 * `data-undo-key`, as every list's ✕ does, so Undo hands focus back to it
 * before the toast goes. A toast hidden with focus still inside restarts its
 * clock, and `resetToasts()` cannot stop that clock, so it would end a later
 * test's toast.
 */
function mountDeleteButton(name: string, seen: { current?: Seen }) {
  render(() => (
    <>
      <button
        type="button"
        data-undo-key={`row:${name}`}
        onClick={(e) => (seen.current = deleteRow(name, e))}
      >
        Delete {name}
      </button>
      <Toaster position="bottom-right" topLayer />
    </>
  ));
  return screen.getByRole("button", { name: `Delete ${name}` });
}

/** What a CSS custom property resolves to on a probe, as the engine writes `property`. */
function resolved(property: "transitionDuration" | "transitionTimingFunction", token: string) {
  const probe = document.createElement("div");
  probe.style[property] = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return value;
}

/** The toast that names `name`'s delete, or nothing once it has gone. */
const toastOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>(".ui-toast")].find(
    (el) => el.querySelector(".ui-toast__message")?.textContent === `Deleted “${name}”`,
  );

/** What `var(--dur-base)` resolves to here, in seconds as the engine writes it. */
function baseRung(): string {
  const probe = document.createElement("div");
  probe.style.transitionDuration = "var(--dur-base)";
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
    // The stack grows up from the bottom edge, oldest nearest it: each toast
    // stands wholly above the one raised before it.
    const [oldest, middle, newest] = [
      "Book the venue",
      "Order the cake",
      "Send the invitations",
    ].map((name) => toastOf(name)!.getBoundingClientRect());
    expect(middle!.bottom).toBeLessThanOrEqual(oldest!.top + 0.5);
    expect(newest!.bottom).toBeLessThanOrEqual(middle!.top + 0.5);
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

  it("takes a keyboard press of the ✕ to Undo, and holds the delete while focus stays there", async () => {
    const seen: { current?: Seen } = {};
    const cross = mountDeleteButton("Book the venue", seen);
    cross.focus();

    await userEvent.keyboard("{Enter}");

    const undo = within(toastOf("Book the venue")!).getByRole("button", {
      name: "Undo deleting “Book the venue”",
    });
    await waitFor(() => expect(document.activeElement).toBe(undo));

    await sleep(UNDO_MS + 400);

    expect(seen.current!.commits).toHaveLength(0);
    expect(toastOf("Book the venue")).toBeDefined();

    await userEvent.keyboard("{Enter}");

    expect(seen.current!.restored).toBe(1);
    expect(isPendingDelete("row:Book the venue")).toBe(false);
    // Undo hands focus back to the row's ✕, not to the page.
    expect(document.activeElement).toBe(cross);
  }, 15_000);

  it("leaves focus alone when the ✕ is pressed with the pointer", async () => {
    const seen: { current?: Seen } = {};
    const cross = mountDeleteButton("Book the venue", seen);

    await userEvent.click(cross);
    await sleep(50);

    expect(seen.current!.hidden).toBe(1);
    expect(toastOf("Book the venue")!.contains(document.activeElement)).toBe(false);
  });

  it("Undo restores its own row, says so, and that delete never goes", async () => {
    mountToaster();
    const first = deleteRow("Book the venue");
    const second = deleteRow("Order the cake");
    const third = deleteRow("Send the invitations");
    // Each Undo names the row it puts back, so a list of buttons tells them apart.
    expect(
      screen.getAllByRole("button", { name: /^Undo/ }).map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Undo deleting “Book the venue”",
      "Undo deleting “Order the cake”",
      "Undo deleting “Send the invitations”",
    ]);
    const middle = toastOf("Order the cake")!;

    await userEvent.click(
      within(middle).getByRole("button", { name: "Undo deleting “Order the cake”" }),
    );

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

  it("arrives on the base rung and the portal's ease-out, where other toasts keep the package's", async () => {
    mountToaster();
    toast.success("Saved");
    deleteRow("Book the venue");
    const shown = toastOf("Book the venue")!;
    const arriving = getComputedStyle(shown);
    expect(arriving.animationName).toBe("ui-toast-in");
    expect(arriving.animationDuration).toBe(baseRung());
    expect(arriving.animationTimingFunction).toBe(
      resolved("transitionTimingFunction", "--ease-out"),
    );

    const plain = screen.getByText("Saved").closest<HTMLElement>(".ui-toast")!;
    expect(getComputedStyle(plain).animationDuration).toBe("0.16s");
    expect(getComputedStyle(plain).animationTimingFunction).toBe("ease-out");
  });

  it("draws Undo as a portal action: sentence case, normal tracking, a pill, medium weight", () => {
    mountToaster();
    deleteRow("Book the venue");
    const undo = within(toastOf("Book the venue")!).getByRole("button", { name: /^Undo/ });
    const look = getComputedStyle(undo);
    expect(undo.textContent).toBe("Undo");
    expect(look.textTransform).toBe("none");
    expect(["normal", "0px"]).toContain(look.letterSpacing);
    expect(look.fontWeight).toBe("500");
    // 0.72rem, the portal's `xs` type step.
    expect(look.fontSize).toBe("11.52px");
    // A pill: the corner is at least half the height.
    const { height } = undo.getBoundingClientRect();
    expect(Number.parseFloat(look.borderTopLeftRadius)).toBeGreaterThanOrEqual(height / 2);
    expect(height).toBeGreaterThanOrEqual(24);
  });

  it("arrives at once under reduced motion", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    mountToaster();
    deleteRow("Book the venue");
    const shown = toastOf("Book the venue")!;
    expect(getComputedStyle(shown).animationName).toBe("ui-toast-in");
    expect(Number.parseFloat(getComputedStyle(shown).animationDuration)).toBeLessThanOrEqual(
      0.00001,
    );
  });

  it("leaves at once, since it holds Undo", async () => {
    mountToaster();
    deleteRow("Book the venue");

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
