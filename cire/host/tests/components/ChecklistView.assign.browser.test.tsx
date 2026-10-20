import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A checklist row gained a holder line and an Edit button, and a bucket can be
 * as narrow as 22rem. Only a real engine can say the row still holds them: a
 * long title next to two buttons, a long name under it, the "Needs an owner"
 * mark. The task drawer has to be the right-hand drawer the portal's other
 * editors use — pinned to the trailing edge, full height — at phone and desktop
 * width, in both ramps.
 *
 * Each case leaves a screenshot under `__screenshots__/` beside this file
 * (gitignored), so a reviewer can look at what was measured.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import ChecklistView from "../../src/components/ChecklistView";
import { __resetHostsCache, ensureHostsLoaded, type HostSeat } from "../../src/lib/hosts-store";
import { __resetTasksCache, setCachedTasks, type TaskRow } from "../../src/lib/tasks-store";

const row = (over: Partial<TaskRow>): TaskRow => ({
  id: "tsk_1",
  weddingId: "wed_1",
  title: "Book venue",
  notes: null,
  timeframeBucket: "day_of",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  assignedHostId: null,
  ...over,
});

const SEATS: HostSeat[] = [
  {
    hostId: "whost_long",
    osnProfileId: "usr_long",
    handle: "maximiliana",
    displayName: "Maximiliana Featherstonehaugh-Okonkwo",
    role: "helper",
  },
  { hostId: "whost_jo", osnProfileId: "usr_jo", handle: "jo", role: "editor" },
];

const TASKS = [
  row({
    id: "a",
    title: "Collect the corsages and buttonholes from the florist on the high street",
    assignedHostId: "whost_long",
    dueAt: "2027-06-05",
  }),
  row({ id: "b", title: "Hand the rings to the best man", sortOrder: 1 }),
  row({ id: "c", title: "Pack the emergency kit", status: "done", completedAt: 2, sortOrder: 2 }),
];

const VIEWPORTS = [
  { name: "phone", width: 375, height: 812 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const THEMES = ["dark", "light"] as const;

/** Beside this file, in the gitignored `__screenshots__/`. */
const shot = (name: string) => `__screenshots__/ChecklistView.assign.browser.test.tsx/${name}.png`;

const contains = (outer: DOMRect, inner: DOMRect) =>
  inner.left >= outer.left - 0.5 &&
  inner.right <= outer.right + 0.5 &&
  inner.top >= outer.top - 0.5 &&
  inner.bottom <= outer.bottom + 0.5;

beforeEach(() => {
  __resetTasksCache();
  __resetHostsCache();
  authFetch.mockReset();
  authFetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ hosts: SEATS, total: SEATS.length, peopleLimit: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
});

afterEach(() => {
  // A `showModal()` dialog sits in the top layer and survives a render
  // cleanup; the next test would mount behind it with its page inert.
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  cleanup();
  delete document.documentElement.dataset.theme;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("who holds a task, painted", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`keeps each row's holder, mark and buttons inside it, and opens a full-height drawer — ${viewport.name}, ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        setCachedTasks("wed_1", TASKS);
        render(() => (
          <div style={{ padding: "16px" }}>
            <ChecklistView weddingId="wed_1" canEdit={true} />
          </div>
        ));
        const list = await screen.findByTestId("tasks-day_of");
        await waitFor(() =>
          expect(within(list).getByText("Maximiliana Featherstonehaugh-Okonkwo")).toBeTruthy(),
        );

        for (const li of list.querySelectorAll("li")) {
          const box = li.getBoundingClientRect();
          for (const part of li.querySelectorAll("button, input, span")) {
            expect(
              contains(box, part.getBoundingClientRect()),
              `${part.textContent || part.getAttribute("aria-label")} inside its row`,
            ).toBe(true);
          }
        }
        const mark = within(list).getByText("Needs an owner");
        expect(mark.closest("li")?.textContent).toContain("Hand the rings");
        list.scrollIntoView({ block: "center" });
        await page.screenshot({ path: shot(`checklist-${viewport.name}-${theme}`) });

        fireEvent.click(
          within(list).getByRole("button", { name: "Edit Hand the rings to the best man" }),
        );
        const drawer = await screen.findByRole("dialog", { name: "Edit task" });
        const select = await within(drawer).findByLabelText("Assigned to");
        await waitFor(() => expect(select).not.toBeDisabled());
        // Measured where it comes to rest, not part-way through sliding in.
        await Promise.all(drawer.getAnimations({ subtree: true }).map((a) => a.finished));
        const panel = drawer.getBoundingClientRect();
        expect(Math.round(panel.right)).toBe(viewport.width);
        expect(Math.round(panel.top)).toBe(0);
        expect(Math.round(panel.height)).toBe(viewport.height);
        expect(contains(panel, select.getBoundingClientRect())).toBe(true);
        await page.screenshot({ path: shot(`drawer-${viewport.name}-${theme}`) });
      });
    }
  }
});

describe("a task whose seat has gone, in Chrome", () => {
  // Chrome shows a blank select, not its first option, when the value names no
  // option — so the drawer has to pick "Nobody yet" itself. happy-dom falls
  // back to the first option and cannot tell.
  it("selects “Nobody yet”, not a blank", async () => {
    await page.viewport(1440, 900);
    setCachedTasks("wed_1", [
      row({ id: "g", title: "Mind the cake", assignedHostId: "whost_gone" }),
    ]);
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const list = await screen.findByTestId("tasks-day_of");
    await waitFor(() => expect(within(list).getByText("Needs an owner")).toBeTruthy());
    fireEvent.click(within(list).getByRole("button", { name: "Edit Mind the cake" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit task" });
    const select = (await within(drawer).findByLabelText("Assigned to")) as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(select.selectedIndex).toBe(0);
    expect(select.options[0]?.textContent).toBe("Nobody yet");
  });
});

describe("the assignee select, from the keyboard", () => {
  // In Chrome on Windows and Linux, an arrow key on a closed select changes
  // its value and fires `change` at once, so each key press is a pick. The
  // select has to keep its focus through the writes that follow, and the task
  // has to end up with whoever the arrowing stopped on.
  it("keeps the focus through a run of arrow keys and stores the last pick", async () => {
    await page.viewport(1440, 900);
    setCachedTasks("wed_1", TASKS);
    let releaseFirst: () => void = () => {};
    const sent: unknown[] = [];
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/hosts"))
        return json({ hosts: SEATS, total: SEATS.length, peopleLimit: null });
      const body = JSON.parse(String(init?.body)) as { assignedHostId: string | null };
      sent.push(body);
      const answer = json({ task: { ...TASKS[1]!, ...body } });
      // The first write is held until both keys have been pressed.
      return sent.length === 1
        ? new Promise<Response>((resolve) => (releaseFirst = () => resolve(answer)))
        : answer;
    });
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const list = await screen.findByTestId("tasks-day_of");
    fireEvent.click(
      within(list).getByRole("button", { name: "Edit Hand the rings to the best man" }),
    );
    const drawer = await screen.findByRole("dialog", { name: "Edit task" });
    const select = (await within(drawer).findByLabelText("Assigned to")) as HTMLSelectElement;
    await waitFor(() => expect(select).not.toBeDisabled());

    select.focus();
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(sent).toHaveLength(1));
    await userEvent.keyboard("{ArrowDown}");
    expect(select.value).toBe("whost_jo");
    expect(document.activeElement).toBe(select);
    expect(select.disabled).toBe(false);
    expect(select.getAttribute("aria-busy")).toBe("true");

    releaseFirst();
    await waitFor(() => expect(select.hasAttribute("aria-busy")).toBe(false));
    expect(sent).toEqual([{ assignedHostId: "whost_long" }, { assignedHostId: "whost_jo" }]);
    expect(document.activeElement).toBe(select);
    expect(select.value).toBe("whost_jo");
    expect(select.options[select.selectedIndex]?.textContent).toBe("@jo · Editor");
    expect(within(list).getByText("@jo")).toBeTruthy();
    await page.screenshot({ path: shot("drawer-keyboard") });
  });
});

describe("a re-read of the seats while the drawer is open, in Chrome", () => {
  // The first opening of a visit reads the seats again. Chrome shows the first
  // option once the selected one is taken out, so a re-read must not replace
  // the option of whoever holds the task.
  it("keeps the holder selected", async () => {
    await page.viewport(1440, 900);
    await ensureHostsLoaded("wed_1", async () => SEATS);
    setCachedTasks("wed_1", [row({ id: "j", title: "Mind the cake", assignedHostId: "whost_jo" })]);
    const newcomer: HostSeat = {
      hostId: "whost_new",
      osnProfileId: "usr_new",
      handle: "newcomer",
      role: "viewer",
    };
    // New objects, as every read hands back, with one more seat on the end.
    authFetch.mockImplementation(async () =>
      json({ hosts: [...SEATS.map((seat) => ({ ...seat })), newcomer], peopleLimit: null }),
    );
    render(() => <ChecklistView weddingId="wed_1" canEdit={true} />);
    const list = await screen.findByTestId("tasks-day_of");
    fireEvent.click(within(list).getByRole("button", { name: "Edit Mind the cake" }));
    const drawer = await screen.findByRole("dialog", { name: "Edit task" });
    const select = (await within(drawer).findByLabelText("Assigned to")) as HTMLSelectElement;
    expect(select.value).toBe("whost_jo");

    await within(select).findByRole("option", { name: "@newcomer · Viewer" });
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(select.value).toBe("whost_jo");
    expect(select.options[select.selectedIndex]?.textContent).toBe("@jo · Editor");
    await page.screenshot({ path: shot("drawer-reread") });
  });
});
