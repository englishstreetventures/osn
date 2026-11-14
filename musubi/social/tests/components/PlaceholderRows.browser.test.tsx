import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * A first load draws as many placeholder rows as its page last landed, one
 * when nothing is known, and the count goes with the session that saw it
 * (`DESIGN.md` §Empty states and failed loads). Held on an organisation's
 * roster, the one page whose first loads come often after another of its
 * kind: one row for the first organisation; three for the next, after the
 * first landed three, exactly as tall as the three that land; one again
 * under a new session. Run at a phone width and a desktop width, since a
 * row's Remove grows to the touch height below `md`. Shots go to
 * `e2e-artifacts/musubi-loading/`.
 */

const reads = vi.hoisted(() => {
  const pending = new Map<string, (value: unknown) => void>();
  return {
    hold<T>(name: string): Promise<T> {
      return new Promise<T>((resolve) => pending.set(name, resolve as (value: unknown) => void));
    },
    held: (name: string) => pending.has(name),
    release(name: string, value: unknown): void {
      const resolve = pending.get(name);
      if (!resolve) throw new Error(`no ${name} read is held`);
      pending.delete(name);
      resolve(value);
    },
    clear: () => pending.clear(),
  };
});

vi.mock("../../src/lib/api", () => ({
  graphClient: {},
  recommendationClient: {},
  orgClient: {
    getOrg: (handle: string) => reads.hold(`org:${handle}`),
    listMembers: (handle: string) => reads.hold(`members:${handle}`),
  },
}));
vi.mock("../../src/lib/authClients", () => ({ connectionsClient: {} }));

import { OrgDetailPage } from "../../src/pages/OrgDetailPage";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/musubi-loading";

const newSession = () => ({ accessToken: "a.b.c", idToken: null, expiresAt: 0, scopes: [] });
const [session, setSession] = createSignal(newSession());
const auth = {
  session: Object.defineProperties(() => session(), {
    state: { get: () => "ready" },
    latest: { get: () => session() },
    loading: { get: () => false },
    error: { get: () => undefined },
  }),
};

const history = createMemoryHistory();

function renderAt(path: string) {
  history.set({ value: path });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the page reads
    <AuthContext.Provider value={auth as any}>
      <MemoryRouter history={history}>
        <Route path="/organisations/:handle" component={OrgDetailPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

/** The blocks a reader would see: a block hidden at this width takes no box. */
function shownBlocks(region: HTMLElement): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(
    (block) => block.getClientRects().length > 0,
  );
}

/** The one busy region on the page, once it holds `blocks` blocks a reader sees. */
function busyRegion(blocks: number): Promise<HTMLElement> {
  return waitFor(() => {
    const busy = [...document.querySelectorAll<HTMLElement>('[aria-busy="true"]')];
    expect(busy.map((el) => el.outerHTML.slice(0, 160))).toHaveLength(1);
    expect(shownBlocks(busy[0]!)).toHaveLength(blocks);
    return busy[0]!;
  });
}

const org = (handle: string, name: string) => ({
  organisation: { handle, name, avatarUrl: null, description: null },
});
const roster = (...handles: string[]) => ({
  members: handles.map((handle) => ({ handle, displayName: `Member ${handle}`, role: "member" })),
});

/** Opens `handle`'s page and lands its head; the roster's read stays held. */
async function openOrganisation(handle: string, name: string) {
  history.set({ value: `/organisations/${handle}` });
  await waitFor(() => expect(reads.held(`org:${handle}`)).toBe(true));
  reads.release(`org:${handle}`, org(handle, name));
  await screen.findByRole("heading", { name });
}

beforeEach(() => {
  reads.clear();
  setSession(newSession());
});

afterEach(() => {
  cleanup();
  reads.clear();
});

describe.each([320, 1440])("a roster's placeholder rows at %ipx", (width) => {
  beforeEach(async () => {
    await page.viewport(width, 2400);
  });

  it("one when nothing is known, the last count next, one again under a new session", async () => {
    renderAt("/organisations/acme");
    await waitFor(() => expect(reads.held("org:acme")).toBe(true));
    reads.release("org:acme", org("acme", "Acme Inc"));
    await screen.findByRole("heading", { name: "Acme Inc" });
    await busyRegion(1);
    reads.release("members:acme", roster("bob", "carol", "dan"));
    await screen.findByText("Member dan");

    await openOrganisation("globex", "Globex");
    const region = await busyRegion(3);
    await page.screenshot({ path: `${SHOTS}/roster-last-count-${width}.png` });
    const held = region.getBoundingClientRect().height;
    reads.release("members:globex", roster("erin", "frank", "grace"));
    await screen.findByText("Member grace");
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    expect(region.getBoundingClientRect().height).toBeCloseTo(held, 0);

    // A new session: nothing it has seen, so one row again.
    setSession(newSession());
    await waitFor(() => expect(reads.held("org:globex")).toBe(true));
    reads.release("org:globex", org("globex", "Globex"));
    await screen.findByRole("heading", { name: "Globex" });
    await busyRegion(1);
  });
});
