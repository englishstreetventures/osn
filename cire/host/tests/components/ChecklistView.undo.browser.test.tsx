import { resetToasts, toast, Toaster, toasts } from "@shared/toast";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A checklist task's ✕, painted: the task leaves at once, a toast offers Undo
 * for five seconds, Undo puts the task back where it stood, and only a toast
 * that goes without Undo sends the `DELETE`. A re-read the open wedding's
 * socket asks for in the meantime must not bring the task back.
 *
 * The three-toast stack is pictured at 390 and 1280px in both ramps into
 * `e2e-artifacts/cire-host/undo-delete/` at the repository root (gitignored).
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch, redirectToLogin } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  redirectToLogin: vi.fn(),
}));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/touch-feedback", () => ({
  haptic: () => {},
  hapticsAvailable: () => false,
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  redirectToLogin,
}));

import { AuthExpiredError } from "@shared/rp-auth";

import ChecklistView from "../../src/components/ChecklistView";
import { TasksChangedContext } from "../../src/lib/tasks-changed";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../../src/lib/tasks-store";

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "a",
  weddingId: "wed_1",
  title: "Book the venue",
  notes: null,
  timeframeBucket: "day_of",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  assigneeHostIds: [],
  ...over,
});

const TASKS = [
  row({ id: "a", title: "Book the venue", sortOrder: 0 }),
  row({ id: "b", title: "Send the invitations", sortOrder: 1 }),
  row({ id: "c", title: "Order the cake", sortOrder: 2 }),
];

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/cire-host/undo-delete";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * The server's tasks: a `DELETE` takes one off unless its id is in `refuse`,
 * or meets an expired session if it is in `expired`; a read answers what is
 * left.
 */
let server: TaskRow[] = [];
let refuse: Set<string>;
let expired: Set<string>;
const deleteCalls = () =>
  authFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
const deletes = () => deleteCalls().map(([url]) => String(url));
const TASK_URL = "https://api.test/api/organiser/weddings/wed_1/tasks/";

beforeEach(() => {
  __resetTasksCache();
  server = structuredClone(TASKS);
  refuse = new Set();
  expired = new Set();
  redirectToLogin.mockReset();
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const one = /\/tasks\/([^/]+)$/.exec(url);
    if (init?.method === "DELETE" && one) {
      if (expired.has(one[1]!)) throw new AuthExpiredError();
      if (refuse.has(one[1]!)) return json({ error: "nope" }, 500);
      server = server.filter((t) => t.id !== one[1]);
      return json({ ok: true });
    }
    if (init?.method === "PATCH" && url.endsWith("/tasks/reorder")) return json({ ok: true });
    if (!init?.method && url.endsWith("/tasks")) return json({ tasks: server });
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
  setCachedTasks("wed_1", structuredClone(TASKS));
});

afterEach(async () => {
  resetToasts();
  cleanup();
  delete document.documentElement.dataset.theme;
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

/** The checklist and the portal's toast mount, with a hand on the socket's signal. */
function mount() {
  const [changed, setChanged] = createSignal(0);
  render(() => (
    <TasksChangedContext.Provider value={changed}>
      <div style={{ padding: "16px" }}>
        <ChecklistView weddingId="wed_1" canEdit={true} />
      </div>
      <Toaster position="bottom-right" topLayer />
    </TasksChangedContext.Provider>
  ));
  return { tasksChanged: () => setChanged((n) => n + 1) };
}

const titles = () =>
  [...screen.getByTestId("tasks-day_of").querySelectorAll(":scope > li")].map(
    (li) => li.querySelector("span.flex-1")?.firstChild?.textContent?.trim() ?? "",
  );
const rowOf = (title: string) => screen.getByRole("checkbox", { name: title }).closest("li")!;
const deleteTask = (title: string) =>
  userEvent.click(within(rowOf(title)).getByRole("button", { name: "Delete task" }));
const toastOf = (title: string) =>
  [...document.querySelectorAll<HTMLElement>(".ui-toast")].find(
    (el) => el.querySelector(".ui-toast__message")?.textContent === `Deleted “${title}”`,
  )!;
const undoButton = (title: string) =>
  within(toastOf(title)).getByRole("button", { name: `Undo deleting “${title}”` });
const undo = (title: string) => userEvent.click(undoButton(title));
/** End one toast's life as its clock would. */
const expire = (title: string) =>
  toast.dismiss(toasts().find((t) => t.message === `Deleted “${title}”`)!.id);

/** What `var(--dur-slow)` resolves to here, in ms. */
function slowRungMs(): number {
  const probe = document.createElement("div");
  probe.style.transitionDuration = "var(--dur-slow)";
  document.body.append(probe);
  const seconds = Number.parseFloat(getComputedStyle(probe).transitionDuration);
  probe.remove();
  return seconds * 1000;
}

describe("deleting a task", () => {
  it("Undo puts the task back where it stood, and nothing is deleted", async () => {
    mount();
    await screen.findByText("Send the invitations");
    // A move first: the row keeps its object across an order-only change, so
    // the copy put back must be the list's, not the row's.
    // The screen reader\'s move button: the grip covers it from the pointer.
    fireEvent.click(screen.getByRole("button", { name: "Move Send the invitations up" }));
    await waitFor(() =>
      expect(titles()).toEqual(["Send the invitations", "Book the venue", "Order the cake"]),
    );

    await deleteTask("Send the invitations");

    expect(titles()).toEqual(["Book the venue", "Order the cake"]);
    expect(toastOf("Send the invitations").getAttribute("role")).toBe("status");

    await undo("Send the invitations");

    await waitFor(() =>
      expect(titles()).toEqual(["Send the invitations", "Book the venue", "Order the cake"]),
    );
    expect(await screen.findByText("Restored “Send the invitations”")).toBeTruthy();
    await new Promise((done) => setTimeout(done, 300));
    expect(deletes()).toEqual([]);
  });

  it("ends the delete's task write on Undo, so the next re-read lands", async () => {
    const socket = mount();
    await screen.findByText("Send the invitations");
    await deleteTask("Send the invitations");
    await undo("Send the invitations");
    await waitFor(() =>
      expect(titles()).toEqual(["Book the venue", "Send the invitations", "Order the cake"]),
    );

    // A co-host adds a task, and the socket says so.
    server = [...server, row({ id: "d", title: "Hire the band", sortOrder: 3 })];
    socket.tasksChanged();

    await waitFor(() =>
      expect(titles()).toEqual([
        "Book the venue",
        "Send the invitations",
        "Order the cake",
        "Hire the band",
      ]),
    );
  });

  it("takes a keyboard press of ✕ to Undo, and Undo back to the task's ✕", async () => {
    mount();
    await screen.findByText("Send the invitations");
    within(rowOf("Send the invitations")).getByRole("button", { name: "Delete task" }).focus();

    await userEvent.keyboard("{Enter}");

    expect(titles()).toEqual(["Book the venue", "Order the cake"]);
    await waitFor(() => expect(document.activeElement).toBe(undoButton("Send the invitations")));

    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(titles()).toEqual(["Book the venue", "Send the invitations", "Order the cake"]),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(rowOf("Send the invitations")).getByRole("button", { name: "Delete task" }),
      ),
    );
    expect(deletes()).toEqual([]);
  });

  it("sends the page-exit DELETE kept alive", async () => {
    mount();
    await screen.findByText("Send the invitations");
    await deleteTask("Send the invitations");

    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));

    await waitFor(() => expect(deletes()).toEqual([`${TASK_URL}b`]));
    expect((deleteCalls()[0]![1] as RequestInit).keepalive).toBe(true);
  });

  it("says so and puts the task back when the server refuses the delete", async () => {
    mount();
    await screen.findByText("Send the invitations");
    refuse.add("b");

    await deleteTask("Send the invitations");
    expire("Send the invitations");

    expect(await screen.findByText("Couldn't delete that task.")).toBeTruthy();
    await waitFor(() =>
      expect(titles()).toEqual(["Book the venue", "Send the invitations", "Order the cake"]),
    );
    expect(deletes()).toEqual([`${TASK_URL}b`]);
  });

  it("sends the organiser to sign in when the delete meets an expired session", async () => {
    mount();
    await screen.findByText("Send the invitations");
    expired.add("b");

    await deleteTask("Send the invitations");
    expire("Send the invitations");

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Couldn't delete that task.")).toBeNull();
  });

  it("sends the DELETE once its toast has gone, and a re-read meanwhile does not bring it back", async () => {
    const socket = mount();
    await screen.findByText("Send the invitations");

    await deleteTask("Send the invitations");
    socket.tasksChanged();
    // The server still holds the task while its toast is up: the re-read waits.
    await new Promise((done) => setTimeout(done, 300));
    expect(titles()).toEqual(["Book the venue", "Order the cake"]);
    expect(deletes()).toEqual([]);

    expire("Send the invitations");

    await waitFor(() =>
      expect(deletes()).toEqual(["https://api.test/api/organiser/weddings/wed_1/tasks/b"]),
    );
    await new Promise((done) => setTimeout(done, 300));
    expect(titles()).toEqual(["Book the venue", "Order the cake"]);
    expect(deletes()).toHaveLength(1);
  });

  it("stacks three toasts for three quick deletes, and each Undo restores its own task", async () => {
    // Wide enough that the stack, in its corner, covers no row's ✕.
    await page.viewport(1280, 800);
    mount();
    await screen.findByText("Send the invitations");

    await deleteTask("Book the venue");
    await deleteTask("Send the invitations");
    await deleteTask("Order the cake");

    expect(document.querySelectorAll(".ui-toast")).toHaveLength(3);
    expect(screen.queryByTestId("tasks-day_of")).toBeNull();

    await undo("Send the invitations");

    await waitFor(() => expect(titles()).toEqual(["Send the invitations"]));
    await undo("Book the venue");
    await waitFor(() => expect(titles()).toEqual(["Book the venue", "Send the invitations"]));

    resetToasts();

    await waitFor(() =>
      expect(deletes()).toEqual(["https://api.test/api/organiser/weddings/wed_1/tasks/c"]),
    );
  });

  it("fades the restored task in on the slow rung, and only once", async () => {
    mount();
    await screen.findByText("Send the invitations");
    await deleteTask("Send the invitations");
    await undo("Send the invitations");

    const back = await waitFor(() => rowOf("Send the invitations"));
    const fade = back
      .getAnimations()
      .find((a) => (a as CSSAnimation).animationName === "row-return");
    expect(fade, "the restored row runs row-return").toBeDefined();
    expect(Number(fade!.effect!.getTiming().duration)).toBeCloseTo(slowRungMs(), 0);
    // Opacity alone: a transform would move the box the sortable measures.
    const moved = new Set(
      (fade!.effect as KeyframeEffect)
        .getKeyframes()
        .flatMap((frame) =>
          Object.keys(frame).filter(
            (key) => !["offset", "computedOffset", "easing", "composite"].includes(key),
          ),
        ),
    );
    expect([...moved]).toEqual(["opacity"]);
    await fade!.finished;
    await waitFor(() => expect(back.classList.contains("row-return")).toBe(false));
    // A row that was never deleted does not fade.
    expect(rowOf("Book the venue").getAnimations()).toHaveLength(0);
  });

  it("puts the task back at once under reduced motion", async () => {
    await commands.emulateMedia({ reducedMotion: "reduce" });
    mount();
    await screen.findByText("Send the invitations");
    await deleteTask("Send the invitations");
    // The fade still runs, so `row-return` still ends; it ends at once.
    const ended: AnimationEvent[] = [];
    const listen = (e: AnimationEvent) => {
      if (e.animationName === "row-return") ended.push(e);
    };
    document.addEventListener("animationend", listen, true);
    try {
      await undo("Send the invitations");

      const back = await waitFor(() => rowOf("Send the invitations"));
      await waitFor(() => expect(ended).toHaveLength(1));
      expect(ended[0]!.target).toBe(back);
      expect(ended[0]!.elapsedTime).toBeLessThanOrEqual(0.001);
      await waitFor(() => expect(back.classList.contains("row-return")).toBe(false));
    } finally {
      document.removeEventListener("animationend", listen, true);
    }
  });
});

describe("the undo stack, pictured", () => {
  for (const viewport of [
    { name: "390", width: 390, height: 844 },
    { name: "1280", width: 1280, height: 800 },
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      it(`three undo toasts at ${viewport.name}px, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        mount();
        await screen.findByText("Send the invitations");

        // Clicked in script, at once: the picture is of the stack, and three
        // pointer clicks under a loaded run can outlast a toast's five seconds.
        // `detail: 1` is a pointer's click, which leaves focus where it is.
        for (const title of ["Book the venue", "Send the invitations", "Order the cake"]) {
          fireEvent.click(within(rowOf(title)).getByRole("button", { name: "Delete task" }), {
            detail: 1,
          });
        }
        const shown = await waitFor(() => {
          const up = [...document.querySelectorAll<HTMLElement>(".ui-toast")].filter(
            (el) => !el.classList.contains("ui-toast--leaving"),
          );
          expect(up).toHaveLength(3);
          return up;
        });
        await Promise.all(shown.flatMap((el) => el.getAnimations().map((a) => a.finished)));
        expect(
          document.querySelectorAll(".ui-toast:not(.ui-toast--leaving)"),
          "no toast left before it was pictured",
        ).toHaveLength(3);

        // Each toast sits inside the window, whole, with its Undo in reach.
        for (const el of shown) {
          const box = el.getBoundingClientRect();
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.right).toBeLessThanOrEqual(viewport.width + 0.5);
          expect(box.bottom).toBeLessThanOrEqual(viewport.height + 0.5);
          const action = within(el)
            .getByRole("button", { name: /^Undo deleting/ })
            .getBoundingClientRect();
          expect(action.height).toBeGreaterThanOrEqual(24);
        }
        await page.screenshot({ path: `${SHOTS}/stack-${viewport.name}-${theme}.png` });
      });
    }
  }
});
