import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import type { Component } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * Every Musubi loading placeholder holds the place of what replaces it, in a
 * real browser: the region that holds the placeholders is the only busy one
 * while the read is out, holds at least one `aria-hidden` block, is exactly as
 * tall as the content that lands in it, and is no longer busy once it has
 * (`DESIGN.md` §Empty states and failed loads). Each fixture lands as many
 * rows as the page draws placeholders, so the region's height covers every
 * block, every row and the gaps between them. Run at a phone width and a
 * desktop width, since a row's buttons grow to the touch height below `md`.
 *
 * Each case shoots the page with its placeholders on screen, into
 * `e2e-artifacts/musubi-loading/`. Each read is held until the test lands it; a lazy section is held the same
 * way, by a wrapper that suspends on its own read until the test lets it go.
 * The factories are written literally: the shared-factory idiom in
 * `test-support/` does not resolve in the browser project.
 */

const reads = vi.hoisted(() => {
  const pending = new Map<string, (value: unknown) => void>();
  return {
    hold<T>(name: string): Promise<T> {
      return new Promise<T>((resolve) => pending.set(name, resolve as (value: unknown) => void));
    },
    held(name: string): boolean {
      return pending.has(name);
    },
    release(name: string, value: unknown): void {
      const resolve = pending.get(name);
      if (!resolve) throw new Error(`no ${name} read is held`);
      pending.delete(name);
      resolve(value);
    },
    clear(): void {
      pending.clear();
    },
  };
});

vi.mock("../../src/lib/api", () => ({
  graphClient: {
    listConnections: () => reads.hold("connections"),
    listPendingRequests: () => reads.hold("pending"),
    listSentRequests: () => reads.hold("sent"),
    listBlocks: () => reads.hold("blocked"),
  },
  recommendationClient: { suggestConnections: () => reads.hold("suggestions") },
  orgClient: {
    listMyOrgs: () => reads.hold("orgs"),
    getOrg: () => reads.hold("org"),
    listMembers: () => reads.hold("members"),
  },
}));
vi.mock("@osn/auth-ui/ProfileOnboarding", () => ({ ProfileOnboarding: () => null }));
vi.mock("../../src/lib/authClients", () => ({
  registrationClient: { checkHandle: () => Promise.resolve({ available: true }) },
  connectionsClient: { list: () => reads.hold("apps") },
  passkeysClient: { list: () => Promise.resolve({ passkeys: [] }) },
  stepUpClient: {},
  totpClient: { status: () => Promise.resolve({ enrolled: false }) },
  recoveryClient: { getRecoveryCodesStatus: () => Promise.resolve({ active: 10, total: 10 }) },
}));
vi.mock("../../src/lib/webauthn-ceremony", () => ({ runPasskeyCeremony: () => {} }));
vi.mock("../../src/lib/webauthn-registration", () => ({ runPasskeyRegistration: () => {} }));
// Each lazy section suspends on its own held read, so its Suspense fallback
// stays on screen until the test lets the section's code "arrive".
vi.mock("../../src/components/ConnectedAppsSection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/components/ConnectedAppsSection")>();
  const { createResource, Show } = await import("solid-js");
  return {
    ConnectedAppsSection: () => {
      const [arrived] = createResource(() => reads.hold<boolean>("apps-chunk"));
      return (
        <Show when={arrived()}>
          <actual.ConnectedAppsSection />
        </Show>
      );
    },
  };
});
vi.mock("../../src/components/SecuritySection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/components/SecuritySection")>();
  const { createResource, Show } = await import("solid-js");
  return {
    default: (props: { profileId: string }) => {
      const [arrived] = createResource(() => reads.hold<boolean>("security-chunk"));
      return (
        <Show when={arrived()}>
          <actual.default profileId={props.profileId} />
        </Show>
      );
    },
  };
});

import { ConnectionsPage } from "../../src/pages/ConnectionsPage";
import { DiscoverPage } from "../../src/pages/DiscoverPage";
import { OrganisationsPage } from "../../src/pages/OrganisationsPage";
import { OrgDetailPage } from "../../src/pages/OrgDetailPage";
import { SettingsPage } from "../../src/pages/SettingsPage";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/musubi-loading";

/** An unsigned access token carrying the `sub` claim Settings reads. */
const ACCESS_TOKEN = `header.${btoa(JSON.stringify({ sub: "prof_1" }))}.signature`;

function authValue() {
  const session = { accessToken: ACCESS_TOKEN, idToken: null, expiresAt: 0, scopes: [] };
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  return { session: resource(session), profiles: resource([]), activeProfileId: () => null };
}

function renderAt(path: string, route: string, component: Component) {
  const history = createMemoryHistory();
  history.set({ value: path });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path={route} component={component} />
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
    const busy = [...document.querySelectorAll<HTMLElement>("[aria-busy]")];
    // The elements themselves, so a failure shows which regions are busy.
    expect(busy.map((el) => el.outerHTML.slice(0, 160))).toHaveLength(1);
    const region = busy[0]!;
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(shownBlocks(region)).toHaveLength(blocks);
    return region;
  });
}

/**
 * Lands `value` on the held `read` and waits for `landed` and for no region to
 * be busy; `el`'s height before and after.
 */
async function land(el: HTMLElement, read: string, value: unknown, landed: string) {
  const held = el.getBoundingClientRect().height;
  reads.release(read, value);
  await screen.findAllByText(landed);
  await waitFor(() => expect(document.querySelector("[aria-busy]")).toBeNull());
  return { held, landed: el.getBoundingClientRect().height };
}

const person = (handle: string, displayName: string) => ({ handle, displayName });

beforeEach(() => {
  reads.clear();
  document.documentElement.classList.remove("dark");
});

afterEach(() => {
  cleanup();
  reads.clear();
});

describe.each([320, 1440])("loading placeholders at %ipx", (width) => {
  beforeEach(async () => {
    // Tall enough that no page scrolls, so no scrollbar takes a column.
    await page.viewport(width, 2400);
  });

  it("Connections: three connection rows", async () => {
    renderAt("/connections", "/connections", ConnectionsPage);
    const region = await busyRegion(3);
    await page.screenshot({ path: `${SHOTS}/connections-${width}.png` });
    const height = await land(
      region,
      "connections",
      {
        connections: [
          person("bob", "Bob Jones"),
          person("carol", "Carol Smith"),
          person("dan", "Dan Brown"),
        ],
      },
      "Bob Jones",
    );
    expect(height.landed).toBeCloseTo(height.held, 0);
  });

  it("Discover: four suggestion cards", async () => {
    renderAt("/discover", "/discover", DiscoverPage);
    const region = await busyRegion(4);
    await page.screenshot({ path: `${SHOTS}/discover-${width}.png` });
    const suggestion = (handle: string, displayName: string) => ({
      ...person(handle, displayName),
      avatarUrl: null,
      mutualCount: 2,
      reason: "mutual_connections",
      sharedOrganisation: null,
    });
    const height = await land(
      region,
      "suggestions",
      {
        suggestions: [
          suggestion("bob", "Bob Jones"),
          suggestion("carol", "Carol Smith"),
          suggestion("dan", "Dan Brown"),
          suggestion("eve", "Eve Green"),
        ],
      },
      "Bob Jones",
    );
    expect(height.landed).toBeCloseTo(height.held, 0);
  });

  it("Organisations: two organisation cards", async () => {
    renderAt("/organisations", "/organisations", OrganisationsPage);
    const region = await busyRegion(2);
    await page.screenshot({ path: `${SHOTS}/organisations-${width}.png` });
    const org = (handle: string, name: string) => ({
      handle,
      name,
      avatarUrl: null,
      description: "A place to plan things together",
    });
    const height = await land(
      region,
      "orgs",
      { organisations: [org("acme", "Acme Inc"), org("globex", "Globex")] },
      "Acme Inc",
    );
    expect(height.landed).toBeCloseTo(height.held, 0);
  });

  it("an organisation: its head, then two member rows", async () => {
    renderAt("/organisations/acme", "/organisations/:handle", OrgDetailPage);
    await busyRegion(2);
    reads.release("org", {
      organisation: { handle: "acme", name: "Acme Inc", avatarUrl: null, description: null },
    });
    await screen.findByRole("heading", { name: "Acme Inc" });
    // The roster's own region, now the page's only busy one. Its rows are the
    // ones a person acts on, each with Remove.
    const region = await busyRegion(2);
    await page.screenshot({ path: `${SHOTS}/org-members-${width}.png` });
    const height = await land(
      region,
      "members",
      {
        members: [
          { ...person("bob", "Bob Jones"), role: "member" },
          { ...person("carol", "Carol Smith"), role: "member" },
        ],
      },
      "Bob Jones",
    );
    expect(height.landed).toBeCloseTo(height.held, 0);
  });

  it("Settings → Connected apps: the section's code, then its one app", async () => {
    renderAt("/settings#apps", "/settings", SettingsPage);
    // While the section's code loads, the Suspense fallback's own wrapper is
    // the busy region, and goes with it.
    const fallback = await busyRegion(1);
    const card = fallback.parentElement!;
    await page.screenshot({ path: `${SHOTS}/connected-apps-${width}.png` });
    const held = card.getBoundingClientRect().height;
    await waitFor(() => expect(reads.held("apps-chunk")).toBe(true));
    reads.release("apps-chunk", true);
    // The section's own placeholder, in the same place, while its list is read.
    await waitFor(() => expect(fallback.isConnected).toBe(false));
    await busyRegion(1);
    expect(card.getBoundingClientRect().height).toBeCloseTo(held, 0);
    const height = await land(
      card,
      "apps",
      {
        connections: [
          {
            clientId: "cli_pulse",
            clientName: "Pulse",
            logoUrl: null,
            scope: "openid profile",
          },
        ],
      },
      "Pulse",
    );
    expect(height.landed).toBeCloseTo(height.held, 0);
  });

  it("Settings → Security: the section's code, then its views", async () => {
    renderAt("/settings#security", "/settings", SettingsPage);
    const fallback = await busyRegion(2);

    await page.screenshot({ path: `${SHOTS}/security-${width}.png` }); // The fallback shows from the moment the lazy import starts; the wrapper
    // holds it once the section's module has loaded.
    await waitFor(() => expect(reads.held("security-chunk")).toBe(true));
    reads.release("security-chunk", true);
    await screen.findByRole("button", { name: "Add a passkey" });
    expect(fallback.isConnected).toBe(false);
    await waitFor(() => expect(document.querySelector("[aria-busy]")).toBeNull());
  });
});
