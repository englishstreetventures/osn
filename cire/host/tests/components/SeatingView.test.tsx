// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SeatingView from "../../src/components/SeatingView";
import { __resetEventsCache, type EventRow, setCachedEvents } from "../../src/lib/events-store";
import type { SeatingChart, SeatingPlan } from "../../src/lib/seating-api";
import { redirectSpy } from "../test-support/mocks";

// The seating chart's behaviour against a fake organiser API that keeps the
// API's contract: what each control sends, what the chart shows afterwards,
// and what it says. The real-pointer drag and the print stylesheet are in
// SeatingView.browser.test.tsx; these are the paths the mutation run can see.

const authFetch = vi.fn();
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
// The touch feedback each outcome plays: what a host on a phone feels.
const hapticSpy = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/haptics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/haptics")>()),
  haptic: (name: string) => hapticSpy(name),
}));
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

const W = "wed_1";
const API = `https://api.test/api/organiser/weddings/${W}`;

const event = (id: string, name: string, sortOrder: number): EventRow => ({
  id,
  name,
  slug: id,
  sortOrder,
  startAt: "2027-03-01T18:00",
  endAt: "",
  timezone: "Australia/Sydney",
  address: null,
  description: "",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  imageUrl: null,
  imageCrop: null,
});

const guest = (
  id: string,
  firstName: string,
  familyName: string,
  over: Partial<SeatingChart["guests"][number]> = {},
): SeatingChart["guests"][number] => ({
  id,
  firstName,
  lastName: familyName,
  rsvp: "attending",
  withdrawn: false,
  tableId: null,
  ...over,
});

/** Reception, in its one plan "Plan 1": Table 1 (2 seats, full: Bo and Gwen),
 *  Table 2 (8 seats, empty); Ada, Cy and Dot unseated. Gwen's household is
 *  withdrawn and never replied. Ceremony, in its one plan: one table, Ada
 *  alone. Each plan is its event's plan in use. */
function charts(): Record<string, SeatingChart> {
  return {
    e_rec: {
      event: { id: "e_rec", name: "Reception" },
      plans: [{ id: "p_rec", name: "Plan 1", selected: true }],
      planId: "p_rec",
      tables: [
        { id: "t1", name: "Table 1", capacity: 2, sortOrder: 0 },
        { id: "t2", name: "Table 2", capacity: 8, sortOrder: 1 },
      ],
      guests: [
        guest("g_ada", "Ada", "Alpha"),
        guest("g_bo", "Bo", "Alpha", { rsvp: "declined", tableId: "t1" }),
        guest("g_cy", "Cy", "Charlie", { rsvp: "maybe" }),
        guest("g_dot", "Dot", "Delta", { rsvp: null }),
        guest("g_gwen", "Gwen", "Gone", { withdrawn: true, tableId: "t1", rsvp: null }),
      ],
    },
    e_cer: {
      event: { id: "e_cer", name: "Ceremony" },
      plans: [{ id: "p_cer", name: "Plan 1", selected: true }],
      planId: "p_cer",
      tables: [{ id: "t9", name: "Front row", capacity: 4, sortOrder: 0 }],
      guests: [guest("g_ada", "Ada", "Alpha", { tableId: "t9" })],
    },
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

interface FakeOptions {
  /** Answers the next matching request with this error instead; with `raw`,
   *  with that body rather than a JSON one. */
  refuse?: { method: string; status: number; error: string; url?: RegExp; raw?: string };
  /** Holds the answer to the next matching request until `until` settles. */
  hold?: { url: RegExp; until: Promise<void> };
  /** Changes the fixture before the first request. */
  edit?: (state: Record<string, SeatingChart>) => void;
  /** The wedding's events, answered at `/events` when none are cached;
   *  without them that read fails. */
  events?: EventRow[];
}

/** A fake of the seating routes, the events read and the venue file. Each
 *  event in the fixture opens on its plan in use; a plan made here is kept
 *  beside them and served by its id. */
function fakeApi(opts: FakeOptions = {}) {
  const state = charts();
  opts.edit?.(state);
  const calls: Call[] = [];
  const contentTypes: string[] = [];
  let created = 0;
  /** Every plan's chart by plan id, and each plan's event. */
  const byPlan = new Map<string, SeatingChart>();
  const eventOf = new Map<string, string>();
  for (const [eventId, chart] of Object.entries(state)) {
    for (const plan of chart.plans) {
      eventOf.set(plan.id, eventId);
      if (plan.id === chart.planId) byPlan.set(plan.id, chart);
    }
  }
  const plansOf = (eventId: string) => state[eventId]!.plans;
  /** The chart as the API answers it: the plan's own tables and guests, with
   *  the event's plans as they stand now; with no plan, no tables and every
   *  guest unseated, a withdrawn household's left off. */
  const answer = (eventId: string, planId: string | null) => {
    const chart = planId ? byPlan.get(planId) : undefined;
    const base = state[eventId]!;
    return chart
      ? { ...chart, plans: plansOf(eventId), planId }
      : {
          ...base,
          plans: plansOf(eventId),
          planId: null,
          tables: [],
          guests: base.guests
            .filter((g) => !g.withdrawn)
            .map((g) => Object.assign({}, g, { tableId: null })),
        };
  };
  authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    contentTypes.push(`${method} ${new Headers(init.headers).get("content-type") ?? "none"}`);
    if (opts.hold?.url.test(url)) {
      const { until } = opts.hold;
      opts.hold = undefined;
      await until;
    }
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (opts.refuse && opts.refuse.method === method && (opts.refuse.url?.test(url) ?? true)) {
      const refusal = opts.refuse;
      opts.refuse = undefined;
      if (refusal.raw !== undefined) return new Response(refusal.raw, { status: refusal.status });
      return json(refusal.status, { error: refusal.error });
    }
    if (method === "GET" && url === `${API}/events`) {
      return opts.events ? json(200, opts.events) : json(500, { error: "Internal error" });
    }
    if (method === "GET" && url === `${API}/seating.csv`) {
      return new Response("Event,Table,Capacity,Guest,Household,RSVP", {
        status: 200,
        headers: { "Content-Type": "text/csv" },
      });
    }
    const chartMatch = /\/seating\/events\/([^/?]+)(?:\?plan=([^&]+))?$/.exec(url);
    if (method === "GET" && chartMatch) {
      const eventId = chartMatch[1]!;
      const asked = chartMatch[2] ? decodeURIComponent(chartMatch[2]) : null;
      if (asked && eventOf.get(asked) !== eventId) return json(404, { error: "plan_not_found" });
      const inUse = plansOf(eventId).find((plan) => plan.selected)?.id ?? null;
      return json(200, answer(eventId, asked ?? inUse));
    }
    const plansMatch = /\/seating\/events\/([^/]+)\/plans$/.exec(url);
    if (method === "POST" && plansMatch) {
      const eventId = plansMatch[1]!;
      const b = body as { name: string; copyFrom?: string };
      const id = `p_new_${++created}`;
      const plan: SeatingPlan = { id, name: b.name, selected: plansOf(eventId).length === 0 };
      const source = b.copyFrom ? byPlan.get(b.copyFrom) : undefined;
      const ids = new Map(source?.tables.map((t) => [t.id, `${t.id}_${id}`]) ?? []);
      byPlan.set(id, {
        ...state[eventId]!,
        planId: id,
        tables: (source?.tables ?? []).map((t) => Object.assign({}, t, { id: ids.get(t.id)! })),
        guests: (source?.guests ?? state[eventId]!.guests)
          .filter((g) => source || !g.withdrawn || g.tableId === null)
          .map((g) =>
            Object.assign({}, g, { tableId: source && g.tableId ? ids.get(g.tableId)! : null }),
          ),
      });
      eventOf.set(id, eventId);
      state[eventId]!.plans = [...plansOf(eventId), plan];
      return json(200, { plan });
    }
    const selectMatch = /\/seating\/events\/([^/]+)\/selected-plan$/.exec(url);
    if (method === "PUT" && selectMatch) {
      const eventId = selectMatch[1]!;
      const { planId } = body as { planId: string };
      for (const p of plansOf(eventId)) p.selected = p.id === planId;
      return json(200, { ok: true });
    }
    const planMatch = /\/seating\/plans\/([^/]+)$/.exec(url);
    if (planMatch && method === "PATCH") {
      const eventId = eventOf.get(planMatch[1]!)!;
      let saved: SeatingPlan | undefined;
      state[eventId]!.plans = plansOf(eventId).map((p) =>
        p.id === planMatch[1] ? (saved = { ...p, name: (body as { name: string }).name }) : p,
      );
      return json(200, { plan: saved });
    }
    if (planMatch && method === "DELETE") {
      const eventId = eventOf.get(planMatch[1]!)!;
      if (plansOf(eventId).find((p) => p.id === planMatch[1])?.selected) {
        return json(409, { error: "plan_selected" });
      }
      state[eventId]!.plans = plansOf(eventId).filter((p) => p.id !== planMatch[1]);
      byPlan.delete(planMatch[1]!);
      return json(200, { ok: true });
    }
    const seatMatch = /\/seating\/plans\/([^/]+)\/guests\/([^/]+)$/.exec(url);
    if (method === "PUT" && seatMatch) {
      const chart = byPlan.get(seatMatch[1]!)!;
      const g = chart.guests.find((x) => x.id === seatMatch[2]);
      g!.tableId = (body as { tableId: string | null }).tableId;
      return json(200, { guestId: g!.id, tableId: g!.tableId });
    }
    // A table at the event's own address goes in its plan in use, made as
    // "Plan 1" when the event has none.
    const eventTablesMatch = /\/seating\/events\/([^/]+)\/tables$/.exec(url);
    if (method === "POST" && eventTablesMatch) {
      const eventId = eventTablesMatch[1]!;
      let planId = plansOf(eventId).find((p) => p.selected)?.id;
      if (!planId) {
        planId = `p_new_${++created}`;
        state[eventId]!.plans = [{ id: planId, name: "Plan 1", selected: true }];
        eventOf.set(planId, eventId);
        byPlan.set(planId, {
          ...state[eventId]!,
          planId,
          tables: [],
          guests: state[eventId]!.guests.map((g) => Object.assign({}, g, { tableId: null })),
        });
      }
      const chart = byPlan.get(planId)!;
      const b = body as { name: string; capacity: number };
      const table = {
        id: `t_new_${++created}`,
        name: b.name,
        capacity: b.capacity,
        sortOrder: chart.tables.length,
      };
      chart.tables.push(table);
      return json(200, { table });
    }
    const tablesMatch = /\/seating\/plans\/([^/]+)\/tables$/.exec(url);
    if (method === "POST" && tablesMatch) {
      const chart = byPlan.get(tablesMatch[1]!)!;
      const b = body as { name: string; capacity: number };
      const table = {
        id: `t_new_${++created}`,
        name: b.name,
        capacity: b.capacity,
        sortOrder: chart.tables.length,
      };
      chart.tables.push(table);
      return json(200, { table });
    }
    if (method === "PATCH" && url.endsWith("/tables/reorder")) return json(200, { ok: true });
    const tableMatch = /\/seating\/tables\/([^/]+)$/.exec(url);
    if (tableMatch && method === "PATCH") {
      const table = [...byPlan.values()]
        .flatMap((chart) => chart.tables)
        .find((t) => t.id === tableMatch[1])!;
      Object.assign(table, body);
      return json(200, { table });
    }
    if (tableMatch && method === "DELETE") return json(200, { ok: true });
    return json(404, { error: "not_found" });
  });
  return { calls, contentTypes, writes: () => calls.filter((c) => c.method !== "GET") };
}

const table = (name: string) => screen.getByRole("region", { name });
const pool = () => screen.getByRole("region", { name: "Not seated" });

async function renderView(props: { canEdit?: boolean; canManage?: boolean } = {}) {
  const view = render(() => (
    <SeatingView
      weddingId={W}
      weddingSlug="ada-and-bo"
      canEdit={props.canEdit ?? true}
      canManage={props.canManage ?? false}
    />
  ));
  await screen.findByRole("region", { name: "Table 1" });
  return view;
}

/** Open a guest's seat menu and choose `option`. Kobalte opens on pointerdown
 *  and selects on pointerup. */
async function choose(trigger: string | RegExp, option: string | RegExp) {
  fireEvent.pointerDown(screen.getByRole("button", { name: trigger }), { button: 0 });
  const item = await screen.findByRole("menuitemradio", { name: option });
  fireEvent.pointerUp(item, { button: 0 });
}

beforeEach(() => {
  __resetEventsCache();
  authFetch.mockReset();
  hapticSpy.mockClear();
  redirectSpy.mockClear();
  setCachedEvents(W, [event("e_rec", "Reception", 0), event("e_cer", "Ceremony", 1)]);
});

afterEach(async () => {
  cleanup();
  // Kobalte's overlay writes run from a timer then a frame; let them land here
  // rather than in the next test (testing-patterns §Kobalte overlays).
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SeatingView — seating by keyboard", () => {
  it("seats a guest at the table chosen from their menu, and says so", async () => {
    const api = fakeApi();
    await renderView();
    await choose("Seat Ada Alpha", /^Table 2/);
    await waitFor(() => expect(within(table("Table 2")).getByText("Ada Alpha")).toBeTruthy());
    expect(within(pool()).queryByText("Ada Alpha")).toBeNull();
    expect(api.writes()).toEqual([
      { method: "PUT", url: `${API}/seating/plans/p_rec/guests/g_ada`, body: { tableId: "t2" } },
    ]);
    await screen.findByText("Ada Alpha seated at Table 2.");
    expect(hapticSpy).toHaveBeenLastCalledWith("commit");
  });

  it("returns a guest to the unseated list", async () => {
    const api = fakeApi();
    await renderView();
    await choose("Move Bo Alpha", "Not seated");
    await waitFor(() => expect(within(pool()).getByText("Bo Alpha")).toBeTruthy());
    expect(api.writes()).toEqual([
      { method: "PUT", url: `${API}/seating/plans/p_rec/guests/g_bo`, body: { tableId: null } },
    ]);
    await screen.findByText("Bo Alpha is no longer seated.");
  });

  it("offers a full table only to the guests already at it", async () => {
    fakeApi();
    await renderView();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Seat Ada Alpha" }), { button: 0 });
    const full = await screen.findByRole("menuitemradio", { name: /^Table 1/ });
    expect(full.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByRole("menuitemradio", { name: /^Table 2/ }).getAttribute("aria-disabled"),
    ).not.toBe("true");
    expect(full.textContent).toBe("Table 1, 2 of 2");
  });

  it("keeps a full table open to the guests already at it", async () => {
    fakeApi();
    await renderView();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move Bo Alpha" }), { button: 0 });
    const own = await screen.findByRole("menuitemradio", { name: /^Table 1/ });
    expect(own.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("puts the guest back and says why when the server refuses the seat", async () => {
    fakeApi({ refuse: { method: "PUT", status: 409, error: "table_full" } });
    await renderView();
    await choose("Seat Ada Alpha", /^Table 2/);
    await screen.findByText("Table 2 is full, so Ada Alpha was not seated there.");
    expect(within(pool()).getByText("Ada Alpha")).toBeTruthy();
    expect(within(table("Table 2")).queryByText("Ada Alpha")).toBeNull();
    expect(hapticSpy).toHaveBeenLastCalledWith("reject");
  });

  it("names a withdrawn household's refusal, and says any other failure plainly", async () => {
    fakeApi({ refuse: { method: "PUT", status: 409, error: "household_withdrawn" } });
    await renderView();
    await choose("Seat Ada Alpha", /^Table 2/);
    await screen.findByText("Ada Alpha's invitation was withdrawn, so they cannot be seated.");
    cleanup();
    fakeApi({ refuse: { method: "PUT", status: 502, error: "", raw: "<html>Bad gateway</html>" } });
    await renderView();
    await choose("Seat Ada Alpha", /^Table 2/);
    await screen.findByText(
      "Could not change where Ada Alpha sits. Refresh to see the chart as saved.",
    );
    expect(within(pool()).getByText("Ada Alpha")).toBeTruthy();
    cleanup();
    fakeApi({ refuse: { method: "PUT", status: 500, error: "Internal error" } });
    await renderView();
    await choose("Move Bo Alpha", "Not seated");
    await screen.findByText(
      "Could not change where Bo Alpha sits. Refresh to see the chart as saved.",
    );
    expect(within(table("Table 1")).getByText("Bo Alpha")).toBeTruthy();
  });

  it("sends a lapsed session to sign in when a write is refused for it", async () => {
    fakeApi({ refuse: { method: "PUT", status: 401, error: "unauthorized" } });
    await renderView();
    expect(redirectSpy).not.toHaveBeenCalled();
    await choose("Seat Ada Alpha", /^Table 2/);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
  });

  it("sends each write as JSON, and a read with no body type", async () => {
    const api = fakeApi();
    await renderView();
    await choose("Seat Ada Alpha", /^Table 2/);
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.contentTypes).toEqual(["GET none", "PUT application/json"]);
  });
});

describe("SeatingView — guest menus", () => {
  // A mounted menu root marks its trigger with `data-closed` or `data-expanded`.
  const menuRoots = () =>
    document.querySelectorAll("button[data-closed], button[data-expanded]").length;

  it("mounts no menu until a guest's is opened, then that one alone", async () => {
    fakeApi();
    await renderView();
    expect(screen.getAllByRole("button", { name: /^(Seat|Move) \w+ \w+$/ })).toHaveLength(5);
    expect(menuRoots()).toBe(0);
    await choose("Seat Ada Alpha", /^Table 2/);
    await screen.findByText("Ada Alpha seated at Table 2.");
    // Ada's row moved tables and was built again; no row holds a menu now.
    expect(menuRoots()).toBe(0);
    const cy = await waitFor(() => screen.getByRole("button", { name: "Seat Cy Charlie" }));
    fireEvent.pointerDown(cy, { button: 0 });
    await screen.findByRole("menuitemradio", { name: /^Table 2/ });
    expect(menuRoots()).toBe(1);
    // The menu's own trigger keeps the row's name.
    expect(document.querySelector("button[data-expanded]")!.getAttribute("aria-label")).toBe(
      "Seat Cy Charlie",
    );
  });

  it("opens a guest's menu from the keyboard: Enter, Space or an arrow key", async () => {
    for (const key of ["Enter", " ", "ArrowDown", "ArrowUp"]) {
      fakeApi();
      await renderView();
      const trigger = screen.getByRole("button", { name: "Seat Ada Alpha" });
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      // The key is the menu's, not the page's: an arrow does not scroll.
      expect({ key, unhandled: fireEvent.keyDown(trigger, { key }) }).toEqual({
        key,
        unhandled: false,
      });
      expect({ key, open: !!(await screen.findByRole("menu")) }).toEqual({ key, open: true });
      cleanup();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });

  it("opens on a touch's tap, never on the touch that may be a scroll", async () => {
    fakeApi();
    await renderView();
    const trigger = screen.getByRole("button", { name: "Seat Ada Alpha" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "touch" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("keeps focus on the menu's trigger as a key opens it", async () => {
    fakeApi();
    await renderView();
    fireEvent.keyDown(screen.getByRole("button", { name: "Seat Ada Alpha" }), { key: "Enter" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Seat Ada Alpha");
    expect(document.activeElement?.hasAttribute("data-expanded")).toBe(true);
  });

  it("opens on a click no press came before, as a screen reader sends, before and after first use", async () => {
    fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Seat Ada Alpha" }));
    expect(await screen.findByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const trigger = document.querySelector<HTMLButtonElement>("button[data-closed]")!;
    expect(trigger.getAttribute("aria-label")).toBe("Seat Ada Alpha");
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("stays open through the click that follows a mouse press, after first use too", async () => {
    fakeApi();
    await renderView();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Seat Ada Alpha" }), { button: 0 });
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const trigger = document.querySelector<HTMLButtonElement>("button[data-closed]")!;
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.click(trigger, { detail: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  it("opens nothing unasked when an editor's role comes back", async () => {
    fakeApi();
    const [canEdit, setCanEdit] = createSignal(true);
    render(() => (
      <SeatingView weddingId={W} weddingSlug="ada-and-bo" canEdit={canEdit()} canManage={false} />
    ));
    await screen.findByRole("region", { name: "Table 1" });
    await choose("Seat Ada Alpha", "Not seated");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    setCanEdit(false);
    setCanEdit(true);
    // Kobalte clears the closed menu's outside `aria-hidden` from a timer
    // then a frame (testing-patterns §Kobalte overlays); a role query before
    // that finds nothing on a slow runner.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.queryByRole("menu")).toBeNull();
    const trigger = await waitFor(() => screen.getByRole("button", { name: "Seat Ada Alpha" }));
    expect(trigger.hasAttribute("data-closed")).toBe(false);
  });

  it("opens no menu for any other key", async () => {
    fakeApi();
    await renderView();
    fireEvent.keyDown(screen.getByRole("button", { name: "Seat Ada Alpha" }), { key: "a" });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Seat Ada Alpha" }), { button: 2 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuRoots()).toBe(0);
  });
});

describe("SeatingView — what a host sees", () => {
  it("badges every guest who has not said yes, in words", async () => {
    fakeApi();
    await renderView();
    const badgeOf = (name: string) =>
      screen.getByText(name).closest("li")!.querySelector("[data-rsvp-badge]")?.textContent ?? null;
    expect(badgeOf("Ada Alpha")).toBeNull();
    expect(badgeOf("Bo Alpha")).toBe("Declined");
    expect(badgeOf("Cy Charlie")).toBe("Maybe");
    expect(badgeOf("Dot Delta")).toBe("No reply");
    expect(badgeOf("Gwen Gone")).toBe("Invite withdrawn");
    expect(within(table("Table 1")).getByText("2 of 2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Seat Ada Alpha" }).textContent).toBe("Seat");
    expect(screen.getByRole("button", { name: "Move Bo Alpha" }).textContent).toBe("Move");
  });

  it("sums up who is seated, who declined and who to chase, and keeps the sum current", async () => {
    // Ada, Cy and Dot have not replied; Gwen has not either, but her household
    // is withdrawn, so she is not one to chase.
    fakeApi({
      edit: (state) => {
        state.e_rec!.guests[0]!.rsvp = null;
        state.e_rec!.guests[2]!.rsvp = null;
      },
    });
    await renderView();
    expect(screen.getByText("2 of 5 seated · 1 declined · 3 no reply")).toBeTruthy();
    // Nothing has happened yet, so the live region says nothing.
    expect(document.querySelector("output")!.textContent).toBe("");
    await choose("Seat Ada Alpha", /^Table 2/);
    expect(await screen.findByText("3 of 5 seated · 1 declined · 3 no reply")).toBeTruthy();
  });

  it("says what an empty table and an empty unseated list mean", async () => {
    fakeApi();
    await renderView();
    expect(within(table("Table 2")).getByText("Drop guests here.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "e_cer" } });
    await screen.findByRole("region", { name: "Front row" });
    expect(within(pool()).getByText("Everyone is seated.")).toBeTruthy();
    // One table has no order to arrange.
    expect(screen.queryByText("Arrange tables")).toBeNull();
    cleanup();
    fakeApi();
    await renderView({ canEdit: false });
    expect(within(table("Table 2")).getByText("No one seated yet.")).toBeTruthy();
  });

  it("tells an editor how to start an event with no tables, and a viewer that none are set", async () => {
    const noTables = (state: Record<string, SeatingChart>) => {
      state.e_rec!.tables = [];
      for (const g of state.e_rec!.guests) g.tableId = null;
    };
    fakeApi({ edit: noTables });
    render(() => <SeatingView weddingId={W} weddingSlug="ada-and-bo" canEdit canManage={false} />);
    expect(
      await screen.findByText(
        "Add a table, then drag guests onto it or choose their table from their menu.",
      ),
    ).toBeTruthy();
    cleanup();
    fakeApi({ edit: noTables });
    render(() => (
      <SeatingView weddingId={W} weddingSlug="ada-and-bo" canEdit={false} canManage={false} />
    ));
    expect(await screen.findByText("Nobody has set out tables for this event yet.")).toBeTruthy();
  });

  it("lets a withdrawn household's guest only be unseated", async () => {
    fakeApi();
    await renderView();
    const row = screen.getByText("Gwen Gone").closest("li")!;
    expect(row.querySelector("[data-drag-handle]")).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Move Gwen Gone" }), { button: 0 });
    await screen.findByRole("menuitemradio", { name: "Not seated" });
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
  });

  it("shows a viewer the chart with no control that changes it", async () => {
    fakeApi();
    await renderView({ canEdit: false });
    expect(screen.queryByRole("button", { name: /^(Seat|Move) / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add table" })).toBeNull();
    expect(screen.queryByText("Arrange tables")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    expect(document.querySelector("[data-drag-handle]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download seating CSV" })).toBeNull();
    expect(within(table("Table 1")).getByText("Bo Alpha")).toBeTruthy();
  });

  it("offers the venue file to an owner only", async () => {
    fakeApi();
    await renderView({ canManage: true });
    expect(screen.getByRole("button", { name: "Download seating CSV" })).toBeTruthy();
    cleanup();
    fakeApi();
    await renderView({ canManage: false });
    expect(screen.queryByRole("button", { name: "Download seating CSV" })).toBeNull();
  });

  it("loads the other event's chart when the event changes", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "e_cer" } });
    await screen.findByRole("region", { name: "Front row" });
    expect(within(table("Front row")).getByText("Ada Alpha")).toBeTruthy();
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/seating/events/e_rec`,
      `GET ${API}/seating/events/e_cer`,
    ]);
  });
});

describe("SeatingView — tables", () => {
  it("adds a table with its name and seat count", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.input(screen.getByLabelText("Table name"), { target: { value: "Table 3" } });
    fireEvent.input(screen.getByLabelText("Seats"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Add table" }));
    await screen.findByRole("region", { name: "Table 3" });
    expect(api.writes()).toEqual([
      {
        method: "POST",
        url: `${API}/seating/plans/p_rec/tables`,
        body: { name: "Table 3", capacity: 6 },
      },
    ]);
    expect(within(table("Table 3")).getByText("0 of 6")).toBeTruthy();
  });

  it("renames a table and changes its seats", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit Table 2" }));
    fireEvent.input(screen.getByLabelText("Name of Table 2"), { target: { value: "Head table" } });
    fireEvent.input(screen.getByLabelText("Seats at Table 2"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("region", { name: "Head table" });
    expect(api.writes()).toEqual([
      {
        method: "PATCH",
        url: `${API}/seating/tables/t2`,
        body: { name: "Head table", capacity: 10 },
      },
    ]);
  });

  it("deletes a table and returns its guests to the unseated list", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Delete Table 1" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Table 1" })).toBeNull());
    expect(within(pool()).getByText("Bo Alpha")).toBeTruthy();
    expect(api.writes()).toEqual([
      { method: "DELETE", url: `${API}/seating/tables/t1`, body: undefined },
    ]);
  });

  it("keeps a table when the delete is not confirmed", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Delete Table 1" }));
    expect(table("Table 1")).toBeTruthy();
    expect(api.writes()).toEqual([]);
  });

  it("re-orders tables from the arrange list and saves the order", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByText("Arrange tables"));
    fireEvent.click(screen.getByRole("button", { name: "Move Table 2 up" }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(api.writes()[0]).toEqual({
      method: "PATCH",
      url: `${API}/seating/plans/p_rec/tables/reorder`,
      body: { orderedIds: ["t2", "t1"] },
    });
    const cards = screen
      .getAllByRole("region")
      .map((r) => r.getAttribute("aria-label") ?? r.textContent);
    expect(cards.findIndex((c) => c?.includes("Table 2"))).toBeLessThan(
      cards.findIndex((c) => c?.includes("Table 1")),
    );
    expect(screen.getByText("Table 2 moved to position 1 of 2.")).toBeTruthy();
    expect(screen.getByText(/arrow keys to move this table\./)).toBeTruthy();
    expect(screen.getByLabelText("Reorder Table 1, position 2 of 2")).toBeTruthy();
  });
});

describe("SeatingView — table controls", () => {
  it("adds a table by the name typed, clears the name, and says so", async () => {
    const api = fakeApi();
    await renderView();
    const name = screen.getByLabelText("Table name") as HTMLInputElement;
    expect(name.placeholder).toBe("Table 3");
    fireEvent.input(name, { target: { value: "  Sweetheart table " } });
    fireEvent.click(screen.getByRole("button", { name: "Add table" }));
    await screen.findByText("Sweetheart table added.");
    expect(api.writes().map((w) => w.body)).toEqual([{ name: "Sweetheart table", capacity: 10 }]);
    expect(name.value).toBe("");
    expect(name.placeholder).toBe("Table 4");
    expect(hapticSpy).toHaveBeenLastCalledWith("commit");
  });

  it("names an unnamed table by its place, and adds none without a whole number of seats", async () => {
    const api = fakeApi();
    await renderView();
    const seats = screen.getByLabelText("Seats");
    const form = screen.getByRole("button", { name: "Add table" }).closest("form")!;
    for (const value of ["0", "", "2.5"]) {
      fireEvent.input(seats, { target: { value } });
      // Submitting never reloads the page.
      expect(fireEvent.submit(form)).toBe(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.writes()).toEqual([]);
    fireEvent.input(seats, { target: { value: "1" } });
    fireEvent.submit(form);
    await screen.findByRole("region", { name: "Table 3" });
    expect(api.writes().map((w) => w.body)).toEqual([{ name: "Table 3", capacity: 1 }]);
  });

  it("says a table could not be added for any other reason", async () => {
    fakeApi({ refuse: { method: "POST", status: 500, error: "Internal error" } });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Add table" }));
    await screen.findByText("Could not add that table.");
    expect(hapticSpy).toHaveBeenLastCalledWith("reject");
  });

  it("opens the edit form on the table's own values, and closes it on a save", async () => {
    const api = fakeApi();
    await renderView();
    // A save that changes nothing still closes the form.
    fireEvent.click(screen.getByRole("button", { name: "Edit Table 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Table 2 saved.");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit Table 2" }));
    const name = screen.getByLabelText("Name of Table 2") as HTMLInputElement;
    expect(name.value).toBe("Table 2");
    expect((screen.getByLabelText("Seats at Table 2") as HTMLInputElement).value).toBe("8");
    fireEvent.input(name, { target: { value: " Head table " } });
    const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
    expect(fireEvent.submit(form)).toBe(false);
    await screen.findByText("Head table saved.");
    expect(api.writes().map((w) => w.body)).toEqual([
      { name: "Table 2", capacity: 8 },
      { name: "Head table", capacity: 8 },
    ]);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(hapticSpy).toHaveBeenLastCalledWith("commit");
  });

  it("saves no blank name or bad seat count, and Cancel leaves the table as it was", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit Table 2" }));
    const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
    fireEvent.input(screen.getByLabelText("Name of Table 2"), { target: { value: "  " } });
    fireEvent.submit(form);
    fireEvent.input(screen.getByLabelText("Name of Table 2"), { target: { value: "Head table" } });
    for (const value of ["0", "", "1.5"]) {
      fireEvent.input(screen.getByLabelText("Seats at Table 2"), { target: { value } });
      fireEvent.submit(form);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.writes()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Name of Table 2")).toBeNull();
    expect(within(table("Table 2")).getByText("0 of 8")).toBeTruthy();
    expect(api.writes()).toEqual([]);
  });

  it("says a table could not be saved for any other reason", async () => {
    fakeApi({ refuse: { method: "PATCH", status: 500, error: "Internal error" } });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit Table 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Could not save Table 2.");
    expect(hapticSpy).toHaveBeenLastCalledWith("reject");
  });

  it("asks before a delete, naming how many guests it unseats, and keeps other tables' guests", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    fakeApi();
    await renderView();
    await choose("Seat Ada Alpha", /^Table 2/);
    await screen.findByText("Ada Alpha seated at Table 2.");

    fireEvent.click(screen.getByRole("button", { name: "Delete Table 1" }));
    expect(confirm).toHaveBeenLastCalledWith("Delete Table 1? Its 2 guests go back to Not seated.");
    await screen.findByText("Table 1 deleted.");
    expect(hapticSpy).toHaveBeenLastCalledWith("commit");
    expect(within(table("Table 2")).getByText("Ada Alpha")).toBeTruthy();
    expect(within(pool()).getByText("Bo Alpha")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete Table 2" }));
    expect(confirm).toHaveBeenLastCalledWith(
      "Delete Table 2? Its 1 guest goes back to Not seated.",
    );
    await screen.findByText("Table 2 deleted.");

    fireEvent.input(screen.getByLabelText("Table name"), { target: { value: "Spare" } });
    fireEvent.click(screen.getByRole("button", { name: "Add table" }));
    await screen.findByRole("region", { name: "Spare" });
    fireEvent.click(screen.getByRole("button", { name: "Delete Spare" }));
    expect(confirm).toHaveBeenLastCalledWith("Delete Spare?");
  });
});

describe("SeatingView — drag", () => {
  it("seats a guest dropped on a table, lighting the table while over it", async () => {
    const api = fakeApi();
    await renderView();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const id = this.getAttribute("data-table-id");
      const left = id === "t2" ? 400 : id === "t1" ? 200 : 0;
      const width = id ? 150 : 40;
      return {
        left,
        right: left + width,
        top: 0,
        bottom: 150,
        width,
        height: 150,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const handle = screen
      .getByText("Ada Alpha")
      .closest("li")!
      .querySelector("[data-drag-handle]")!;
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(
      document,
      new PointerEvent("pointermove", { pointerId: 1, clientX: 30, clientY: 30 }),
    );
    fireEvent(
      document,
      new PointerEvent("pointermove", { pointerId: 1, clientX: 450, clientY: 50 }),
    );
    expect(table("Table 2").getAttribute("data-over")).toBe("true");
    expect(table("Table 1").getAttribute("data-over")).toBe("false");
    fireEvent(document, new PointerEvent("pointerup", { pointerId: 1, clientX: 450, clientY: 50 }));
    await waitFor(() => expect(within(table("Table 2")).getByText("Ada Alpha")).toBeTruthy());
    expect(api.writes()).toEqual([
      { method: "PUT", url: `${API}/seating/plans/p_rec/guests/g_ada`, body: { tableId: "t2" } },
    ]);
    await screen.findByText("Ada Alpha seated at Table 2.");
  });

  it("does nothing for a drop between tables, or on the table a guest already sits at", async () => {
    const api = fakeApi();
    await renderView();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const id = this.getAttribute("data-table-id");
      const left = id === "t1" ? 200 : 0;
      const width = id === "t1" ? 150 : 40;
      return {
        left,
        right: left + width,
        top: 0,
        bottom: 150,
        width,
        height: 150,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const drop = (name: string, x: number) => {
      const handle = screen.getByText(name).closest("li")!.querySelector("[data-drag-handle]")!;
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      fireEvent(
        document,
        new PointerEvent("pointermove", { pointerId: 1, clientX: 30, clientY: 30 }),
      );
      fireEvent(
        document,
        new PointerEvent("pointermove", { pointerId: 1, clientX: x, clientY: 50 }),
      );
      fireEvent(document, new PointerEvent("pointerup", { pointerId: 1, clientX: x, clientY: 50 }));
    };
    drop("Ada Alpha", 900);
    drop("Bo Alpha", 250);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.writes()).toEqual([]);
  });
  it("unseats a guest dropped on the unseated list, and sends nothing for a drop where they sit", async () => {
    const api = fakeApi();
    await renderView();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const id = this.getAttribute("data-table-id");
      const left = id === "t9" ? 400 : id === "t1" ? 200 : 0;
      const width = id ? 150 : 40;
      return {
        left,
        right: left + width,
        top: 0,
        bottom: 150,
        width,
        height: 150,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const drag = (name: HTMLElement, x: number) => {
      const handle = name.closest("li")!.querySelector("[data-drag-handle]")!;
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      fireEvent(
        document,
        new PointerEvent("pointermove", { pointerId: 1, clientX: 30, clientY: 30 }),
      );
      fireEvent(
        document,
        new PointerEvent("pointermove", { pointerId: 1, clientX: x, clientY: 50 }),
      );
      fireEvent(document, new PointerEvent("pointerup", { pointerId: 1, clientX: x, clientY: 50 }));
    };
    // Bo, not the first guest on the chart, leaves Table 1 for the unseated list.
    drag(within(table("Table 1")).getByText("Bo Alpha"), 20);
    await waitFor(() => expect(within(pool()).getByText("Bo Alpha")).toBeTruthy());
    expect(api.writes()).toEqual([
      { method: "PUT", url: `${API}/seating/plans/p_rec/guests/g_bo`, body: { tableId: null } },
    ]);
    // Ada already sits at the Ceremony's Front row, which has room.
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "e_cer" } });
    await screen.findByRole("region", { name: "Front row" });
    drag(within(table("Front row")).getByText("Ada Alpha"), 450);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.writes()).toHaveLength(1);
  });
});

describe("SeatingView — print", () => {
  it("prints the page as it looks while no chart is on screen", async () => {
    let release!: () => void;
    fakeApi({
      hold: { url: /\/seating\/events\/e_rec$/, until: new Promise<void>((r) => (release = r)) },
    });
    render(() => <SeatingView weddingId={W} weddingSlug="ada-and-bo" canEdit canManage={false} />);
    await screen.findByText("Loading…");
    window.dispatchEvent(new Event("beforeprint"));
    expect(document.documentElement.hasAttribute("data-print-sheet")).toBe(false);
    expect(document.body.querySelector("[data-print-sheet]")).toBeNull();
    window.dispatchEvent(new Event("afterprint"));
    release();
    await screen.findByRole("region", { name: "Table 1" });
  });

  it("takes both print listeners away with the view", async () => {
    fakeApi();
    const view = await renderView();
    const removed = vi.spyOn(window, "removeEventListener");
    view.unmount();
    const events = removed.mock.calls.map(([type]) => type);
    expect(events).toContain("beforeprint");
    expect(events).toContain("afterprint");
  });

  it("builds the print sheet only while the page prints, and marks the page then", async () => {
    fakeApi();
    const view = await renderView();
    const sheet = () => document.body.querySelector("[data-print-sheet]");
    const marked = () => document.documentElement.hasAttribute("data-print-sheet");
    const sections = () =>
      [...sheet()!.querySelectorAll("section")].map((section) => [
        section.querySelector("h2")!.textContent,
        [...section.querySelectorAll("li")].map((li) => li.textContent),
      ]);
    expect(sheet()).toBeNull();
    expect(marked()).toBe(false);

    window.dispatchEvent(new Event("beforeprint"));
    expect(marked()).toBe(true);
    expect(sheet()!.querySelector("h1")!.textContent).toBe("Reception");
    expect(sections()).toEqual([
      ["Table 1 (2 of 2)", ["Bo Alpha (declined)", "Gwen Gone (invite withdrawn)"]],
      ["Table 2 (0 of 8)", []],
    ]);
    window.dispatchEvent(new Event("afterprint"));
    expect(sheet()).toBeNull();
    expect(marked()).toBe(false);

    await choose("Seat Ada Alpha", /^Table 2/);
    await screen.findByText("Ada Alpha seated at Table 2.");
    window.dispatchEvent(new Event("beforeprint"));
    expect(sections()).toEqual([
      ["Table 1 (2 of 2)", ["Bo Alpha (declined)", "Gwen Gone (invite withdrawn)"]],
      ["Table 2 (1 of 8)", ["Ada Alpha"]],
    ]);
    // Leaving the chart mid-print takes the sheet and the mark with it, and
    // the next print of another page is not the chart's.
    view.unmount();
    expect(sheet()).toBeNull();
    expect(marked()).toBe(false);
    window.dispatchEvent(new Event("afterprint"));
    window.dispatchEvent(new Event("beforeprint"));
    expect(marked()).toBe(false);
    window.dispatchEvent(new Event("afterprint"));
  });

  it("prints the page from its Print button", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledTimes(1);
  });
});

describe("SeatingView — the venue file", () => {
  it("saves the file under the wedding's name, and says when it cannot", async () => {
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const api = fakeApi();
    await renderView({ canManage: true });
    fireEvent.click(screen.getByRole("button", { name: "Download seating CSV" }));
    await waitFor(() => expect(saved).toEqual(["cire-seating-ada-and-bo.csv"]));
    expect(api.calls.at(-1)).toMatchObject({ method: "GET", url: `${API}/seating.csv` });
    expect(screen.queryByText("Could not download the seating chart. Try again.")).toBeNull();
    cleanup();
    fakeApi({ refuse: { method: "GET", status: 500, error: "Internal error", url: /csv$/ } });
    await renderView({ canManage: true });
    fireEvent.click(screen.getByRole("button", { name: "Download seating CSV" }));
    await screen.findByText("Could not download the seating chart. Try again.");
    expect(saved).toHaveLength(1);
  });
});

describe("SeatingView — the event list", () => {
  const renderBare = () =>
    render(() => <SeatingView weddingId={W} weddingSlug="ada-and-bo" canEdit canManage={false} />);

  it("loads the events when none are cached, and opens the first in their order", async () => {
    __resetEventsCache();
    let release!: () => void;
    const api = fakeApi({
      events: [event("e_cer", "Ceremony", 1), event("e_rec", "Reception", 0)],
      hold: { url: /\/events$/, until: new Promise<void>((resolve) => (release = resolve)) },
    });
    renderBare();
    expect(await screen.findByText("Loading…")).toBeTruthy();
    release();
    await screen.findByRole("region", { name: "Table 1" });
    const select = screen.getByLabelText("Event") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["Reception", "Ceremony"]);
    expect(select.value).toBe("e_rec");
    // No chart is read before an event is chosen.
    expect(api.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${API}/events`,
      `GET ${API}/seating/events/e_rec`,
    ]);
  });

  it("says the events could not load, and sends a lapsed session to sign in", async () => {
    __resetEventsCache();
    fakeApi();
    renderBare();
    expect(
      await screen.findByText("Couldn't load your events. Refresh to try again."),
    ).toBeTruthy();
    expect(redirectSpy).not.toHaveBeenCalled();
    cleanup();

    __resetEventsCache();
    authFetch.mockImplementation(async () => new Response("{}", { status: 401 }));
    renderBare();
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    cleanup();

    redirectSpy.mockClear();
    __resetEventsCache();
    authFetch.mockImplementation(async () => {
      throw new Error("AuthExpiredError");
    });
    renderBare();
    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Couldn't load your events. Refresh to try again.")).toBeNull();
  });

  it("asks for events first when the wedding has none", async () => {
    __resetEventsCache();
    fakeApi({ events: [] });
    renderBare();
    expect(await screen.findByText("No events yet")).toBeTruthy();
  });

  it("keeps the chosen event when the event list changes", async () => {
    fakeApi();
    await renderView();
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "e_cer" } });
    await screen.findByRole("region", { name: "Front row" });
    setCachedEvents(W, [
      event("e_rec", "Reception", 0),
      event("e_cer", "Ceremony", 1),
      event("e_party", "After-party", 2),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(table("Front row")).toBeTruthy();
    expect((screen.getByLabelText("Event") as HTMLSelectElement).value).toBe("e_cer");
  });

  it("shows only the chart of the event on screen when an earlier answer comes late", async () => {
    let release!: () => void;
    fakeApi({
      hold: {
        url: /\/seating\/events\/e_cer$/,
        until: new Promise<void>((resolve) => (release = resolve)),
      },
    });
    await renderView();
    const select = screen.getByLabelText("Event");
    fireEvent.change(select, { target: { value: "e_cer" } });
    expect(await screen.findByText("Loading…")).toBeTruthy();
    fireEvent.change(select, { target: { value: "e_rec" } });
    await screen.findByRole("region", { name: "Table 1" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("region", { name: "Front row" })).toBeNull();
    expect(table("Table 1")).toBeTruthy();
  });
});

describe("SeatingView — refusals and failures are said", () => {
  it("says a move between tables as a move", async () => {
    fakeApi();
    await renderView();
    await choose("Move Bo Alpha", /^Table 2/);
    expect(await screen.findByText("Bo Alpha moved to Table 2.")).toBeTruthy();
  });

  it("says why a table was not added, and adds no card", async () => {
    fakeApi({ refuse: { method: "POST", status: 409, error: "table_limit" } });
    await renderView();
    fireEvent.input(screen.getByLabelText("Table name"), { target: { value: "Table 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Add table" }));
    await screen.findByText("This plan already has as many tables as it can hold.");
    expect(screen.queryByRole("region", { name: "Table 3" })).toBeNull();
  });

  it("keeps the edit form open and says why a capacity was refused", async () => {
    fakeApi({
      refuse: {
        method: "PATCH",
        status: 409,
        error: "capacity_below_seated",
        url: /\/tables\/t1$/,
      },
    });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit Table 1" }));
    fireEvent.input(screen.getByLabelText("Seats at Table 1"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Table 1 has more guests seated than that. Move some first.");
    expect(screen.getByLabelText("Seats at Table 1")).toBeTruthy();
  });

  it("says a delete failed, and keeps the table", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fakeApi({ refuse: { method: "DELETE", status: 500, error: "Internal error" } });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Delete Table 1" }));
    await screen.findByText("Could not delete Table 1.");
    expect(within(table("Table 1")).getByText("Bo Alpha")).toBeTruthy();
    expect(hapticSpy).toHaveBeenLastCalledWith("reject");
  });

  it("says a reorder failed and reloads the saved order", async () => {
    const api = fakeApi({
      refuse: { method: "PATCH", status: 500, error: "Internal error", url: /reorder$/ },
    });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Move Table 2 up" }));
    await screen.findByText("Could not save the order of the tables.");
    await waitFor(() => expect(api.calls.filter((c) => c.method === "GET")).toHaveLength(2));
    // The move it announced did not hold, so the announcement goes.
    expect(screen.queryByText("Table 2 moved to position 1 of 2.")).toBeNull();
    expect(hapticSpy).toHaveBeenLastCalledWith("reject");
  });

  it("says the chart could not load", async () => {
    authFetch.mockImplementation(async () => new Response("{}", { status: 500 }));
    render(() => <SeatingView weddingId={W} weddingSlug="ada-and-bo" canEdit canManage={false} />);
    expect(
      await screen.findByText("Couldn't load the seating chart. Refresh to try again."),
    ).toBeTruthy();
  });

  it("refuses a drop on a full table without asking the server", async () => {
    const api = fakeApi();
    await renderView();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const id = this.getAttribute("data-table-id");
      const left = id === "t1" ? 200 : 0;
      const width = id === "t1" ? 150 : 40;
      return {
        left,
        right: left + width,
        top: 0,
        bottom: 150,
        width,
        height: 150,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });
    const handle = screen
      .getByText("Ada Alpha")
      .closest("li")!
      .querySelector("[data-drag-handle]")!;
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
    fireEvent(
      document,
      new PointerEvent("pointermove", { pointerId: 1, clientX: 30, clientY: 30 }),
    );
    fireEvent(
      document,
      new PointerEvent("pointermove", { pointerId: 1, clientX: 250, clientY: 50 }),
    );
    fireEvent(document, new PointerEvent("pointerup", { pointerId: 1, clientX: 250, clientY: 50 }));
    await screen.findByText("Table 1 is full, so Ada Alpha was not seated there.");
    expect(api.writes()).toEqual([]);
    expect(within(pool()).getByText("Ada Alpha")).toBeTruthy();
    expect(hapticSpy.mock.calls.map(([name]) => name)).toEqual(["pickup", "reject"]);
  });

  it("keeps a rename form open while the tables are re-ordered", async () => {
    fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Edit Table 1" }));
    fireEvent.input(screen.getByLabelText("Name of Table 1"), { target: { value: "Half-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Move Table 2 up" }));
    await waitFor(() => {
      const regions = screen.getAllByRole("region").map((r) => r.getAttribute("data-table-id"));
      expect(regions.indexOf("t2")).toBeLessThan(regions.indexOf("t1"));
    });
    expect((screen.getByLabelText("Name of Table 1") as HTMLInputElement).value).toBe("Half-typed");
  });
});

describe("SeatingView — plans", () => {
  const picker = () => screen.getByLabelText("Plan") as HTMLSelectElement;
  const pickerOptions = () => [...picker().options].map((option) => option.textContent);
  const planWrites = (api: ReturnType<typeof fakeApi>) =>
    api.writes().filter((call) => /\/plans|selected-plan/.test(call.url));

  it("names the plan on screen and the plan in use, and opens another plan from the picker", async () => {
    const api = fakeApi();
    await renderView();
    expect(pickerOptions()).toEqual(["Plan 1 (in use)"]);
    screen.getByText("This plan is in use: the venue file prints it.");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText("Plan 1 copy made from Plan 1. Changes to it leave Plan 1 as it is.");
    expect(pickerOptions()).toEqual(["Plan 1 (in use)", "Plan 1 copy"]);
    expect(picker().value).toBe("p_new_1");
    screen.getByText("This plan is not in use. The venue file prints Plan 1.");
    fireEvent.change(picker(), { target: { value: "p_rec" } });
    await waitFor(() =>
      expect(api.calls.at(-1)?.url).toBe(`${API}/seating/events/e_rec?plan=p_rec`),
    );
    await screen.findByText("This plan is in use: the venue file prints it.");
  });

  it("copies the plan on screen with its tables and seats, and seats in the copy alone", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Plan 1/);
    expect(planWrites(api)).toEqual([
      {
        method: "POST",
        url: `${API}/seating/events/e_rec/plans`,
        body: { name: "Plan 1 copy", copyFrom: "p_rec" },
      },
    ]);
    // The copy holds the same tables and seats.
    expect(within(table("Table 1")).getByText("Bo Alpha")).toBeTruthy();
    await choose("Seat Ada Alpha", /^Table 2/);
    await screen.findByText("Ada Alpha seated at Table 2.");
    expect(api.writes().at(-1)).toEqual({
      method: "PUT",
      url: `${API}/seating/plans/p_new_1/guests/g_ada`,
      body: { tableId: "t2_p_new_1" },
    });
  });

  it("reloads the copy, not the plan in use, when a reorder in the copy fails", async () => {
    const api = fakeApi({
      refuse: {
        method: "PATCH",
        status: 500,
        error: "Internal error",
        url: /\/plans\/p_new_1\/tables\/reorder$/,
      },
    });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Plan 1/);
    fireEvent.click(screen.getByRole("button", { name: "Move Table 2 up" }));
    await screen.findByText("Could not save the order of the tables.");
    await waitFor(() =>
      expect(api.calls.findLast((c) => c.method === "GET")?.url).toBe(
        `${API}/seating/events/e_rec?plan=p_new_1`,
      ),
    );
    expect(picker().value).toBe("p_new_1");
  });

  it("adds a blank plan under a name no plan has, and opens it", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    await screen.findByText("Plan 2 added, with no tables.");
    expect(planWrites(api)).toEqual([
      { method: "POST", url: `${API}/seating/events/e_rec/plans`, body: { name: "Plan 2" } },
    ]);
    expect(picker().value).toBe("p_new_1");
    screen.getByText("No tables yet");
    // Known without a read: no chart is asked for, every guest is unseated,
    // and the withdrawn guest seated in the other plan is not shown.
    expect(api.calls.filter((c) => c.method === "GET" && c.url.includes("?plan="))).toEqual([]);
    expect(screen.queryByText("Gwen Gone")).toBeNull();
    expect(within(pool()).getByText("Bo Alpha")).toBeTruthy();
  });

  it("keeps the event switched to while a blank plan was being made", async () => {
    let release!: () => void;
    fakeApi({
      hold: { url: /\/plans$/, until: new Promise<void>((resolve) => (release = resolve)) },
    });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "e_cer" } });
    await screen.findByRole("region", { name: "Front row" });
    release();
    // The write settles: the plan controls are free again.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "New plan" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    // The ceremony's chart stays on screen: the reception's blank plan is not
    // painted over it.
    expect(screen.getByRole("region", { name: "Front row" })).toBeTruthy();
    expect(screen.queryByText("No tables yet")).toBeNull();
  });

  it("makes one plan for a double press, and says why a plan was refused", async () => {
    let release!: () => void;
    const api = fakeApi({
      hold: { url: /\/plans$/, until: new Promise<void>((resolve) => (release = resolve)) },
    });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    release();
    await screen.findByText("Plan 2 added, with no tables.");
    expect(planWrites(api)).toHaveLength(1);

    fakeApi({ refuse: { method: "POST", status: 409, error: "plan_limit", url: /\/plans$/ } });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(
      "This event already has as many plans as it can hold. Delete one first.",
    );
    expect(hapticSpy).toHaveBeenLastCalledWith("reject");
    fakeApi({ refuse: { method: "POST", status: 409, error: "copy_budget", url: /\/plans$/ } });
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(
      "This wedding has copied as many tables and seats as it can today. Try again tomorrow, or start a new plan.",
    );
    fakeApi({ refuse: { method: "POST", status: 500, error: "Internal error", url: /\/plans$/ } });
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    await screen.findByText("Could not add a plan.");
  });

  it("renames the plan on screen, and keeps it as it was for a blank name or Cancel", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const name = screen.getByLabelText("Plan name") as HTMLInputElement;
    expect(name.value).toBe("Plan 1");
    fireEvent.input(name, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(planWrites(api)).toEqual([]);
    expect(pickerOptions()).toEqual(["Plan 1 (in use)"]);

    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.input(screen.getByLabelText("Plan name"), { target: { value: " Garden " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Plan 1 renamed Garden.");
    expect(planWrites(api)).toEqual([
      { method: "PATCH", url: `${API}/seating/plans/p_rec`, body: { name: "Garden" } },
    ]);
    expect(pickerOptions()).toEqual(["Garden (in use)"]);
  });

  it("puts another plan in use only once the host confirms, and offers no delete for the plan in use", async () => {
    const api = fakeApi();
    await renderView();
    expect(screen.queryByRole("button", { name: "Use this plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete plan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Plan 1/);

    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.click(screen.getByRole("button", { name: "Use this plan" }));
    expect(confirm).toHaveBeenCalledWith(
      "Use Plan 1 copy for this event? The venue file will print Plan 1 copy instead of Plan 1, which stays saved.",
    );
    expect(planWrites(api)).toHaveLength(1);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Use this plan" }));
    await screen.findByText("Plan 1 copy is now in use. The venue file prints it.");
    expect(planWrites(api).at(-1)).toEqual({
      method: "PUT",
      url: `${API}/seating/events/e_rec/selected-plan`,
      body: { planId: "p_new_1" },
    });
    expect(pickerOptions()).toEqual(["Plan 1 copy (in use)", "Plan 1"]);
    expect(screen.queryByRole("button", { name: "Use this plan" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete plan" })).toBeNull();
  });

  it("deletes a plan not in use once the host confirms, and opens the plan in use", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Plan 1/);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));
    expect(confirm).toHaveBeenCalledWith(
      "Delete Plan 1 copy? Its tables and seats go with it. Plan 1 stays in use.",
    );
    expect(planWrites(api)).toHaveLength(1);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));
    await screen.findByText("Plan 1 copy deleted.");
    expect(planWrites(api).at(-1)).toEqual({
      method: "DELETE",
      url: `${API}/seating/plans/p_new_1`,
      body: undefined,
    });
    expect(pickerOptions()).toEqual(["Plan 1 (in use)"]);
    expect(api.calls.at(-1)?.url).toBe(`${API}/seating/events/e_rec`);
  });

  it("says a delete was refused for the plan in use", async () => {
    fakeApi({ refuse: { method: "DELETE", status: 409, error: "plan_selected" } });
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Plan 1/);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete plan" }));
    expect(
      await screen.findByText("That plan is in use. Choose another plan to use first."),
    ).toBeTruthy();
    expect(hapticSpy).toHaveBeenLastCalledWith("reject");
  });

  it("lists what the plan on screen needs a host to look at, and keeps it current", async () => {
    // Dot said yes too, so one line names two guests.
    fakeApi({ edit: (state) => void (state.e_rec!.guests[3]!.rsvp = "attending") });
    await renderView();
    const review = () => screen.getByText(/^Needs review/).closest("section")!;
    const lines = () => [...review().querySelectorAll("li")].map((li) => li.textContent);
    expect(screen.getByText("Needs review: 4 guests in this plan")).toBeTruthy();
    expect(lines()).toEqual([
      "Seated, but declined (1): Bo Alpha",
      "Seated, but their invitation was withdrawn (1): Gwen Gone",
      "Said yes, but not seated (2): Ada Alpha, Dot Delta",
    ]);
    await choose("Seat Ada Alpha", /^Table 2/);
    await choose("Seat Dot Delta", /^Table 2/);
    await screen.findByText("Needs review: 2 guests in this plan");
    // A kind with nobody in it says nothing.
    expect(lines()).toEqual([
      "Seated, but declined (1): Bo Alpha",
      "Seated, but their invitation was withdrawn (1): Gwen Gone",
    ]);
    await choose("Move Bo Alpha", "Not seated");
    await screen.findByText("Needs review: 1 guest in this plan");
    await choose("Move Gwen Gone", "Not seated");
    await waitFor(() => expect(screen.queryByText(/^Needs review/)).toBeNull());
  });

  it("opens nothing when the plan on screen is chosen again, and shows the plan it opens", async () => {
    const api = fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Plan 1/);
    expect(hapticSpy).toHaveBeenLastCalledWith("commit");
    const reads = () => api.calls.filter((call) => call.method === "GET").length;
    const before = reads();
    fireEvent.change(picker(), { target: { value: "p_new_1" } });
    expect(reads()).toBe(before);
    fireEvent.change(picker(), { target: { value: "p_rec" } });
    await screen.findByText("This plan is in use: the venue file prints it.");
    expect(picker().value).toBe("p_rec");
  });

  it("names a new plan after the plans the event already has, and keeps a copy's name inside 80 characters", async () => {
    const api = fakeApi();
    await renderView();
    const rename = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Rename" }));
      fireEvent.input(screen.getByLabelText("Plan name"), { target: { value: name } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByText(new RegExp(`renamed ${name}\\.$`));
    };
    // "plan 2" is taken whatever its case, so the new plan is Plan 3.
    await rename("plan 2");
    fireEvent.click(screen.getByRole("button", { name: "New plan" }));
    await screen.findByText("Plan 3 added, with no tables.");
    // A name at the cap is cut to leave room for " copy", and loses the space
    // the cut leaves at its end.
    const long = `${"a".repeat(74)} bbbbb`;
    fireEvent.change(picker(), { target: { value: "p_rec" } });
    await screen.findByText("This plan is in use: the venue file prints it.");
    await rename(long);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/ copy made from /);
    expect(
      planWrites(api)
        .filter((call) => call.method === "POST")
        .map((call) => call.body),
    ).toEqual([{ name: "Plan 3" }, { name: `${"a".repeat(74)} copy`, copyFrom: "p_rec" }]);
  });

  it("hands the focus on when a plan control goes away, so a keyboard user keeps their place", async () => {
    fakeApi();
    await renderView();
    const focused = () => document.activeElement;
    const settle = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await settle();
    expect(focused()).toBe(screen.getByLabelText("Plan name"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(focused()).toBe(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.input(screen.getByLabelText("Plan name"), { target: { value: "Garden" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Plan 1 renamed Garden.");
    await settle();
    expect(focused()).toBe(screen.getByRole("button", { name: "Rename" }));

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Garden/);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Use this plan" }));
    await screen.findByText("Garden copy is now in use. The venue file prints it.");
    await settle();
    expect(focused()).toBe(picker());
    fireEvent.change(picker(), { target: { value: "p_rec" } });
    const remove = await screen.findByRole("button", { name: "Delete plan" });
    // Focus starts on the button that goes away, so only the hand-off can put
    // it on the picker.
    remove.focus();
    expect(focused()).toBe(remove);
    fireEvent.click(remove);
    await screen.findByText("Garden deleted.");
    await settle();
    expect(focused()).toBe(picker());
  });

  it("renames one plan of several and leaves the others' names alone", async () => {
    fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Plan 1/);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.input(screen.getByLabelText("Plan name"), { target: { value: "Garden" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Plan 1 copy renamed Garden.");
    expect(pickerOptions()).toEqual(["Plan 1 (in use)", "Garden"]);
  });

  it("says a plan write failed for any other reason, and changes nothing on screen", async () => {
    fakeApi();
    await renderView();
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await screen.findByText(/made from Plan 1/);
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const failing = async (method: string, url: RegExp, act: () => void, said: string) => {
      fakeApi({ refuse: { method, status: 500, error: "Internal error", url } });
      act();
      expect(await screen.findByText(said)).toBeTruthy();
      expect(hapticSpy).toHaveBeenLastCalledWith("reject");
    };
    const pressed = (name: string) => () => fireEvent.click(screen.getByRole("button", { name }));
    await failing("POST", /\/plans$/, pressed("Duplicate"), "Could not copy that plan.");
    await failing(
      "PATCH",
      /\/plans\/p_new_1$/,
      () => {
        pressed("Rename")();
        fireEvent.input(screen.getByLabelText("Plan name"), { target: { value: "Garden" } });
        pressed("Save")();
      },
      "Could not rename Plan 1 copy.",
    );
    pressed("Cancel")();
    await failing(
      "PUT",
      /selected-plan$/,
      pressed("Use this plan"),
      "Could not start using Plan 1 copy.",
    );
    await failing("DELETE", /\/plans\//, pressed("Delete plan"), "Could not delete Plan 1 copy.");
    expect(pickerOptions()).toEqual(["Plan 1 (in use)", "Plan 1 copy"]);
  });

  it("starts an event's first plan with its first table, and puts the table in it", async () => {
    const api = fakeApi({
      edit: (state) => {
        state.e_rec!.plans = [];
        state.e_rec!.planId = null;
        state.e_rec!.tables = [];
        for (const g of state.e_rec!.guests) g.tableId = null;
      },
    });
    render(() => <SeatingView weddingId={W} weddingSlug="ada-and-bo" canEdit canManage={false} />);
    await screen.findByText("No tables yet");
    expect(screen.queryByLabelText("Plan")).toBeNull();
    fireEvent.input(screen.getByLabelText("Table name"), { target: { value: "Head" } });
    fireEvent.click(screen.getByRole("button", { name: "Add table" }));
    await screen.findByText("Head added.");
    expect(api.writes()).toEqual([
      {
        method: "POST",
        url: `${API}/seating/events/e_rec/tables`,
        body: { name: "Head", capacity: 10 },
      },
    ]);
    // The chart is read again, and names the plan the table made.
    await waitFor(() => expect(pickerOptions()).toEqual(["Plan 1 (in use)"]));
    expect(api.calls.at(-1)).toMatchObject({ method: "GET", url: `${API}/seating/events/e_rec` });
    expect(within(table("Head")).getByText("Drop guests here.")).toBeTruthy();
  });

  it("shows a viewer the plans with no control that changes them", async () => {
    fakeApi();
    await renderView({ canEdit: false });
    expect(pickerOptions()).toEqual(["Plan 1 (in use)"]);
    for (const name of ["Duplicate", "New plan", "Rename", "Use this plan", "Delete plan"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("prints the name of the plan on screen", async () => {
    fakeApi();
    await renderView();
    window.dispatchEvent(new Event("beforeprint"));
    expect(document.body.querySelector("[data-print-sheet] p")?.textContent).toBe(
      "Seating chart: Plan 1",
    );
    window.dispatchEvent(new Event("afterprint"));
  });

  it("prints an event with no plan yet as a seating chart with no name", async () => {
    fakeApi({
      edit: (state) => {
        state.e_rec!.plans = [];
        state.e_rec!.planId = null;
      },
    });
    render(() => <SeatingView weddingId={W} weddingSlug="ada-and-bo" canEdit canManage={false} />);
    await screen.findByText("No tables yet");
    window.dispatchEvent(new Event("beforeprint"));
    expect(document.body.querySelector("[data-print-sheet] p")?.textContent).toBe("Seating chart");
    window.dispatchEvent(new Event("afterprint"));
  });

  it("reads a chart from an API before plans as one with no plan, and seats through the event's own address", async () => {
    // The API before plans answers with neither `plans` nor `planId`.
    const { plans: _plans, planId: _planId, ...old } = charts().e_rec!;
    const writes: string[] = [];
    authFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if ((init.method ?? "GET") !== "GET") writes.push(url);
      return new Response(JSON.stringify(old), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await renderView();
    expect(within(table("Table 1")).getByText("Bo Alpha")).toBeTruthy();
    expect(screen.queryByLabelText("Plan")).toBeNull();
    await choose("Seat Ada Alpha", /^Table 2/);
    expect(await screen.findByText("Ada Alpha seated at Table 2.")).toBeTruthy();
    expect(writes).toEqual([`${API}/seating/events/e_rec/guests/g_ada`]);
  });
});
