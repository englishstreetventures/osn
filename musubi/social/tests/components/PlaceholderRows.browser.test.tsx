import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, ErrorBoundary, Show, type Component } from "solid-js";
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
 *
 * The other data pages draw more than one placeholder only on a first load
 * after a failed read, which takes the rows and keeps their count: each lands
 * three rows, fails its next read, and is shown again, and its three blocks
 * are as tall as the three rows that land, gaps included.
 */

const reads = vi.hoisted(() => {
  type Held = { resolve: (value: unknown) => void; reject: (err: unknown) => void };
  const pending = new Map<string, Held>();
  const take = (name: string) => {
    const held = pending.get(name);
    if (!held) throw new Error(`no ${name} read is held`);
    pending.delete(name);
    return held;
  };
  return {
    hold<T>(name: string): Promise<T> {
      return new Promise<T>((resolve, reject) =>
        pending.set(name, { resolve: resolve as (value: unknown) => void, reject }),
      );
    },
    held: (name: string) => pending.has(name),
    release: (name: string, value: unknown) => take(name).resolve(value),
    fail: (name: string) => take(name).reject(new Error(`${name} refused`)),
    clear: () => pending.clear(),
  };
});

vi.mock("../../src/lib/api", () => ({
  graphClient: {
    listConnections: () => reads.hold("connections"),
    listPendingRequests: () => reads.hold("pending"),
    acceptConnection: () => reads.hold("accept"),
  },
  recommendationClient: { suggestConnections: () => reads.hold("suggestions") },
  orgClient: {
    listMyOrgs: () => reads.hold("orgs"),
    getOrg: (handle: string) => reads.hold(`org:${handle}`),
    listMembers: (handle: string) => reads.hold(`members:${handle}`),
  },
}));
vi.mock("../../src/lib/authClients", () => ({
  connectionsClient: { list: () => reads.hold("apps") },
}));
vi.mock("../../src/components/ShellDialogs", () => ({
  useShellDialogs: () => ({ ready: () => true, open: () => {} }),
}));

import { ConnectedAppsSection } from "../../src/components/ConnectedAppsSection";
import { ConnectionsPage } from "../../src/pages/ConnectionsPage";
import { DiscoverPage } from "../../src/pages/DiscoverPage";
import { OrganisationsPage } from "../../src/pages/OrganisationsPage";
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

const person = (handle: string) => ({ handle, displayName: `Person ${handle}` });
const three = ["bob", "carol", "dan"];

const DATA_PAGES: {
  title: string;
  read: string;
  Page: Component;
  rows: unknown;
  last: string;
}[] = [
  {
    title: "Connections",
    read: "connections",
    Page: ConnectionsPage,
    rows: { connections: three.map(person) },
    last: "Person dan",
  },
  {
    title: "Discover",
    read: "suggestions",
    Page: DiscoverPage,
    rows: {
      suggestions: three.map((handle) => ({
        ...person(handle),
        avatarUrl: null,
        mutualCount: 2,
        reason: "mutual_connections",
        sharedOrganisation: null,
      })),
      generatedAt: "2026-11-14T00:00:00Z",
    },
    last: "Person dan",
  },
  {
    title: "Organisations",
    read: "orgs",
    Page: OrganisationsPage,
    rows: {
      organisations: three.map((handle) => ({
        handle,
        name: `Org ${handle}`,
        avatarUrl: null,
        description: "A place to plan things together",
      })),
    },
    last: "Org dan",
  },
  {
    title: "Connected apps",
    read: "apps",
    Page: ConnectedAppsSection,
    rows: {
      connections: three.map((name) => ({
        clientId: `cli_${name}`,
        clientName: `App ${name}`,
        logoUrl: null,
        scope: "openid profile",
      })),
    },
    last: "App dan",
  },
];

describe.each([320, 1440])("three placeholder rows after a failed read, at %ipx", (width) => {
  beforeEach(async () => {
    await page.viewport(width, 2400);
  });

  it.each(DATA_PAGES)("$title", async ({ title, read, Page, rows, last }) => {
    const [shown, setShown] = createSignal(true);
    const showAgain = () => {
      setShown(false);
      setShown(true);
    };
    const path = "/page";
    history.set({ value: path });
    render(() => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the page reads
      <AuthContext.Provider value={auth as any}>
        <MemoryRouter history={history}>
          <Route
            path={path}
            component={() => (
              <Show when={shown()}>
                <ErrorBoundary fallback={<p>The page failed.</p>}>
                  <Page />
                </ErrorBoundary>
              </Show>
            )}
          />
        </MemoryRouter>
      </AuthContext.Provider>
    ));
    await waitFor(() => expect(reads.held(read)).toBe(true));
    reads.release(read, rows);
    await screen.findByText(last);

    // Shown again, the read behind the rows fails: the rows go, the count stays.
    showAgain();
    await waitFor(() => expect(reads.held(read)).toBe(true));
    reads.fail(read);
    await waitFor(() => expect(screen.queryByText(last)).toBeNull());

    showAgain();
    const region = await busyRegion(3);
    await page.screenshot({
      path: `${SHOTS}/three-after-failure-${title.toLowerCase().replace(/ /g, "-")}-${width}.png`,
    });
    const held = region.getBoundingClientRect().height;
    reads.release(read, rows);
    await screen.findByText(last);
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
    expect(region.getBoundingClientRect().height).toBeCloseTo(held, 0);
  });
});

describe("a Pending row at 320px, its Accept busy", () => {
  beforeEach(async () => {
    await page.viewport(320, 800);
  });

  // Busy labels are longer than resting ones; a long name gives way to them
  // rather than pushing the row past the column.
  it("truncates the name and keeps the buttons inside the row", async () => {
    history.set({ value: "/connections" });
    render(() => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the slice of AuthContext the page reads
      <AuthContext.Provider value={auth as any}>
        <MemoryRouter history={history}>
          <Route path="/connections" component={ConnectionsPage} />
        </MemoryRouter>
      </AuthContext.Provider>
    ));
    await waitFor(() => expect(reads.held("connections")).toBe(true));
    reads.release("connections", { connections: [] });
    fireEvent.click(await screen.findByText("Pending"));
    await waitFor(() => expect(reads.held("pending")).toBe(true));
    const name = "Bartholomew Featherstonehaugh-Cholmondeley";
    reads.release("pending", {
      pending: [{ handle: "bartholomew", displayName: name, requestedAt: "2026-11-01T00:00:00Z" }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const accepting = await screen.findByRole("button", { name: "Accepting…" });
    const decline = screen.getByRole("button", { name: "Decline" });
    const text = screen.getByText(name);
    const row = text.closest<HTMLElement>(".rounded-lg")!;
    await page.screenshot({ path: `${SHOTS}/pending-row-busy-320.png` });

    // One line, cut short: the row stays the 60px a connection row is below
    // `md` (`DESIGN.md` §Empty states), the height its placeholder holds.
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(row.getBoundingClientRect().height).toBeCloseTo(60, 0);
    expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(
      accepting.getBoundingClientRect().left,
    );
    expect(decline.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.getBoundingClientRect().right,
    );
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  });
});
