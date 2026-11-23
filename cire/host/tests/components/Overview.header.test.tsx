// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Overview screen names itself once.
 *
 * `ModuleShell` renders the panel header — the module's label and the gilt
 * rule, with no hint under the label — for every module; the hint stays in the
 * nav. A panel that also led with its own title would say it twice before any
 * content. This suite is the guard on both, and it
 * needs the shell and the panel rendered together: `Overview.test.tsx` renders
 * `Overview` on its own, where a duplicate of the shell's header is absent
 * rather than singular.
 *
 * Overview is therefore the one real panel here. Every other one the shell can
 * mount is a stub, so a module this file only asks the header about does not
 * fetch for itself.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

vi.mock("../../src/components/GettingStarted", () => ({
  default: () => <div data-testid="getting-started" />,
}));
vi.mock("../../src/components/BudgetView", () => ({ default: () => <div data-testid="budget" /> }));
vi.mock("../../src/components/ChecklistView", () => ({
  default: () => <div data-testid="checklist" />,
}));
vi.mock("../../src/components/DirectoryBrowseView", () => ({
  default: () => <div data-testid="directory-browse" />,
}));
vi.mock("../../src/components/EnquiriesView", () => ({
  default: () => <div data-testid="enquiries-view" />,
}));
vi.mock("../../src/components/EventsEditor", () => ({
  default: () => <div data-testid="events-editor" />,
}));
vi.mock("../../src/components/EventTable", () => ({ default: () => <div data-testid="events" /> }));
vi.mock("../../src/components/GuestsEditor", () => ({
  default: () => <div data-testid="guests-editor" />,
}));
vi.mock("../../src/components/GuestTable", () => ({ default: () => <div data-testid="guests" /> }));
vi.mock("../../src/components/HostsPanel", () => ({ default: () => <div data-testid="hosts" /> }));
vi.mock("../../src/components/ImportPanel", () => ({
  default: () => <div data-testid="import" />,
}));
vi.mock("../../src/components/InviteBuilder", () => ({
  default: () => <div data-testid="invite-design" />,
}));
vi.mock("../../src/components/RegistryView", () => ({
  default: () => <div data-testid="registry" />,
}));
vi.mock("../../src/components/RemintPanel", () => ({ default: () => <div data-testid="codes" /> }));
vi.mock("../../src/components/RsvpView", () => ({ default: () => <div data-testid="rsvps" /> }));
vi.mock("../../src/components/SettingsPanel", () => ({
  default: () => <div data-testid="settings" />,
}));
vi.mock("../../src/components/VendorsView", () => ({
  default: () => <div data-testid="vendors" />,
}));

import ModuleShell from "../../src/components/ModuleShell";
import { __resetBudgetCache } from "../../src/lib/budget-store";
import { defaultSub, type Module } from "../../src/lib/dashboard-route";
import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { MODULE_NAV } from "../../src/lib/module-nav";
import { __resetTasksCache } from "../../src/lib/tasks-store";
import type { Tier } from "../../src/lib/tiers";
import { __resetVendorsCache } from "../../src/lib/vendors-store";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answer Overview's six reads with empty-but-valid payloads. An unrouted
 *  `authFetch` resolves to `undefined`, every read throws on `res.status`, and
 *  the header would then be counted on the soft-fail path by accident rather
 *  than on the one an organiser sees. */
function routeEmpty() {
  authFetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/settings")) return Promise.resolve(json({ wedding: {} }));
    if (url.endsWith("/rsvps")) return Promise.resolve(json({ events: [] }));
    if (url.endsWith("/tasks")) return Promise.resolve(json({ tasks: [] }));
    if (url.endsWith("/vendors")) return Promise.resolve(json({ vendors: [] }));
    return Promise.resolve(json([]));
  });
}

/** The stores are module-level, and a loader writes to them on the way past. */
function resetAll() {
  resetOrganiserMocks();
  __resetBudgetCache();
  __resetEventsCache();
  __resetGuestsCache();
  __resetTasksCache();
  __resetVendorsCache();
}

async function renderShell(module: Module, tier: Tier = "ivory") {
  const utils = render(() => (
    <ModuleShell
      weddingId="wed_1"
      weddingName="R & V"
      weddingSlug="r-and-v"
      callerRole="owner"
      canManage={true}
      canEdit={true}
      module={module}
      sub={defaultSub(module)}
      onModule={() => {}}
      onSub={() => {}}
      tier={tier}
      entitlements={[]}
      guestCap={100}
    />
  ));
  // Overview is the one real panel, so it is the one that has reads to settle:
  // with no events and no guests it lands on the getting-started empty state.
  // Every other panel here is a stub that renders synchronously.
  if (module === "overview") await screen.findByTestId("getting-started");
  return utils;
}

/**
 * Elements whose own text is `text`, minus the two surfaces that print the
 * active module's name as *navigation* rather than as a header. Both have to be
 * subtracted by hand: the rail is a `navigation` landmark, but the narrow
 * container's sheet trigger is a plain button outside every landmark, and
 * happy-dom evaluates no container query — so both are in the DOM at once.
 */
function namesOutsideNav(text: string): HTMLElement[] {
  const rail = screen.getByRole("navigation", { name: /Wedding modules/i });
  const bar = screen.getByRole("navigation", { name: "Main modules" });
  return screen.queryAllByText(text).filter((el) => !rail.contains(el) && !bar.contains(el));
}

describe("Overview header", () => {
  afterEach(() => {
    cleanup();
    resetAll();
  });

  it("names the module once above the content", async () => {
    routeEmpty();
    await renderShell("overview");

    expect(namesOutsideNav("Overview")).toHaveLength(1);
  });

  it("names every module in its shell header, with no hint under the name", async () => {
    // Driven off MODULE_NAV rather than a copied list of strings: the claim is
    // "the shell header names every module and draws no hint", and the header
    // is rendered once for all of them. It pins no layout — a control added to
    // that row leaves this green.
    for (const mod of MODULE_NAV) {
      routeEmpty();
      // A module the wedding's tier does not include is coerced to Overview by
      // the shell, so each locked one is rendered on the tier its lock names.
      await renderShell(mod.id, mod.lock?.tier ?? "ivory");

      expect(namesOutsideNav(mod.label)).toHaveLength(1);
      // The hint stays in the nav — the rail's tooltip, the sheet and the
      // palette — but not under the name.
      const header = screen.getByRole("heading", { name: mod.label, level: 2 }).closest("header")!;
      expect(header.textContent).not.toContain(mod.hint);
      expect(header.querySelectorAll("p")).toHaveLength(0);

      cleanup();
      resetAll();
    }
  });
});
