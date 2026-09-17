// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Overview screen names itself once.
 *
 * `ModuleShell` renders the panel header — the module's label and its `hint` —
 * for every module, so a panel that also leads with its own title says the same
 * two things twice before any content. This suite is the guard on that, and it
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

async function renderShell(module: Module, entitlements: string[] = []) {
  const utils = render(() => (
    <ModuleShell
      weddingId="wed_1"
      weddingName="R & V"
      weddingSlug="r-and-v"
      canManage={true}
      canEdit={true}
      module={module}
      sub={defaultSub(module)}
      onModule={() => {}}
      onSub={() => {}}
      entitlements={entitlements}
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
  const sheetTrigger = screen.getByRole("button", { name: /Open wedding navigation/i });
  return screen
    .queryAllByText(text)
    .filter((el) => !rail.contains(el) && !sheetTrigger.contains(el));
}

describe("Overview header", () => {
  afterEach(() => {
    cleanup();
    resetAll();
  });

  it("prints the module's hint once, not once per header", async () => {
    routeEmpty();
    await renderShell("overview");

    // At most once is the contract. Exactly once is the stronger true statement
    // and the one worth pinning: it also catches a change that leaves the screen
    // with no subtitle at all.
    expect(screen.queryAllByText("Your wedding at a glance")).toHaveLength(1);
  });

  it("names the module once above the content", async () => {
    routeEmpty();
    await renderShell("overview");

    expect(namesOutsideNav("Overview")).toHaveLength(1);
  });

  it("leaves every module's shell header naming its own module", async () => {
    // Driven off MODULE_NAV rather than a copied list of strings: the claim is
    // "the shell header still names every module", and the header is rendered
    // once for all of them. It pins no layout — a control added to that row
    // leaves this green.
    for (const mod of MODULE_NAV) {
      routeEmpty();
      // A module the wedding is not entitled to is coerced to Overview by the
      // shell, so the two locked ones are rendered holding their entitlement.
      await renderShell(mod.id, mod.lock ? [mod.lock.entitlement] : []);

      expect(namesOutsideNav(mod.label)).toHaveLength(1);
      expect(screen.queryAllByText(mod.hint)).toHaveLength(1);

      cleanup();
      resetAll();
    }
  });
});
