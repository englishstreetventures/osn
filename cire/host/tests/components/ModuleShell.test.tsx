// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isModule, isSubOf, type Module } from "../../src/lib/dashboard-route";

/**
 * ModuleShell is the IA replacement for the flat tab bar: a left module rail
 * (Overview / Events / Guests / Invite / Settings) plus, inside a module that
 * has them, a row of sub-tabs. The active module + sub are controlled by the
 * parent (OrganiserApp owns the URL hash). The leaf panels are stubbed to
 * data-testids so this asserts only the shell glue: module navigation + active
 * state, sub-tab routing, role-gated sub visibility, and that a viewer / co-host
 * never reaches a write-only or owner-only sub even via a stale deep link.
 */

// `entitlements` is on the mock deliberately. The shell is the only place its
// two ends meet — Overview's own tests pass the prop directly — and a required
// prop means deleting the pass-down fails typecheck while quietly passing `[]`
// does not. Rendering it here is what makes the wrong value visible.
vi.mock("../../src/components/Overview", () => ({
  default: (p: {
    weddingId: string;
    entitlements: readonly string[];
    onNavigate: (module: "guests", sub?: string) => void;
  }) => (
    <div data-testid="overview" data-entitlements={p.entitlements.join(",")}>
      {p.weddingId}
      <button onClick={() => p.onNavigate("guests", "rsvps")}>overview-to-rsvps</button>
    </div>
  ),
}));
vi.mock("../../src/components/EventTable", () => ({
  default: (p: { weddingId: string }) => <div data-testid="events">{p.weddingId}</div>,
}));
vi.mock("../../src/components/EventsEditor", () => ({
  default: (p: { weddingId: string }) => <div data-testid="events-editor">{p.weddingId}</div>,
}));
vi.mock("../../src/components/GuestsEditor", () => ({
  default: (p: { weddingId: string }) => <div data-testid="guests-editor">{p.weddingId}</div>,
}));
// The three leaves that carry the invite-message links render the slot, so the
// shell's own links — the real component, wired to the shell's navigation — are
// clickable here. An optional slot dropped from the shell is otherwise silent.
vi.mock("../../src/components/GuestTable", () => ({
  default: (p: { weddingId: string; inviteMessageLinks?: JSX.Element }) => (
    <div data-testid="guests">
      {p.weddingId}
      {p.inviteMessageLinks}
    </div>
  ),
}));
vi.mock("../../src/components/ImportPanel", () => ({
  // Surfaces `kind`: the whole point of the split is that the events module gets
  // an events import and the guests module a guests one, and a mock that reads
  // only weddingId would keep passing if both panels asked for the same sheet.
  default: (p: { weddingId: string; kind: string }) => (
    <div data-testid="import" data-kind={p.kind}>
      {p.weddingId}
    </div>
  ),
}));
vi.mock("../../src/components/RsvpView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="rsvps">{p.weddingId}</div>,
}));
// Counts mounts, so a test can tell a move that passed through the builder on
// its way somewhere else from one that never touched it.
let builderMounts = 0;
vi.mock("../../src/components/InviteBuilder", () => ({
  default: (p: {
    weddingId: string;
    initialSection?: string;
    inviteMessageLinks?: JSX.Element;
  }) => {
    builderMounts += 1;
    return (
      <div data-testid="invite-design" data-section={p.initialSection ?? ""}>
        {p.weddingId}
        {p.inviteMessageLinks}
      </div>
    );
  },
}));
vi.mock("../../src/components/RemintPanel", () => ({
  default: (p: { weddingId: string; inviteMessageLinks?: JSX.Element }) => (
    <div data-testid="codes">
      {p.weddingId}
      {p.inviteMessageLinks}
    </div>
  ),
}));
vi.mock("../../src/components/HostsPanel", () => ({
  // Surfaces BOTH flags, for the same reason SettingsPanel surfaces
  // canEditRsvpDeadline below: `canAdd={props.canEdit}` is the one line
  // connecting the API's weddingEditor() gate on POST /hosts to the portal's
  // add form, and with the mock reading only weddingId, reverting it to
  // `props.canManage` — switching the whole capability off for editors — left
  // all 663 organiser tests green.
  default: (p: { weddingId: string; canManage: boolean; canAdd: boolean }) => (
    <div data-testid="hosts" data-can-manage={String(p.canManage)} data-can-add={String(p.canAdd)}>
      {p.weddingId}
    </div>
  ),
}));
vi.mock("../../src/components/SettingsPanel", () => ({
  // Surfaces canEditRsvpDeadline: it is the one line connecting the API's
  // co-host deadline write to a real co-host, and nothing else can see it.
  default: (p: { weddingId: string; canManage: boolean; canEditRsvpDeadline?: boolean }) => (
    <div
      data-testid="settings"
      data-can-manage={String(p.canManage)}
      data-can-edit-rsvp={String(p.canEditRsvpDeadline)}
    >
      {p.weddingId}
    </div>
  ),
}));
vi.mock("../../src/components/VendorsView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="vendors">{p.weddingId}</div>,
}));
vi.mock("../../src/components/RegistryView", () => ({
  // Surfaces `view`: both sub-tabs mount the SAME component, so a mock reading
  // only weddingId would keep passing with the gift list and the gift log wired
  // to the same sub. Surfaces `weddingSlug` too, because the gift-log export
  // names the downloaded file after it and a dropped prop is otherwise silent.
  default: (p: { weddingId: string; view: string; weddingSlug: string }) => (
    <div data-testid="registry" data-view={p.view} data-slug={p.weddingSlug}>
      {p.weddingId}
    </div>
  ),
}));
vi.mock("../../src/components/DirectoryBrowseView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="directory-browse">{p.weddingId}</div>,
}));
vi.mock("../../src/components/ChecklistView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="checklist">{p.weddingId}</div>,
}));
vi.mock("../../src/components/BudgetView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="budget">{p.weddingId}</div>,
}));
vi.mock("../../src/components/EnquiriesView", () => ({
  default: (p: { weddingId: string }) => <div data-testid="enquiries-view">{p.weddingId}</div>,
}));

import ModuleShell, { PANEL_LOADER_KEYS } from "../../src/components/ModuleShell";

/** Render with controllable module + sub signals so a test can drive the
 *  parent's "active view" the way OrganiserApp would on a hash change. */
function renderShell(opts: {
  canManage?: boolean;
  canEdit?: boolean;
  module?: Module;
  sub?: string;
  entitlements?: string[];
  guestCap?: number;
  /** Stand in for a declined unsaved-changes prompt: every module switch is
   *  refused and the route stays where it is. */
  refuseModule?: boolean;
}) {
  const [module, setModule] = createSignal<Module>(opts.module ?? "overview");
  const [sub, setSub] = createSignal(opts.sub ?? "index");
  const onModule = vi.fn((m: Module, next?: string) => {
    if (opts.refuseModule) return;
    setModule(m);
    // Mirror OrganiserApp: a module switch lands on the sub asked for when the
    // module has it, else on the module default.
    setSub(
      next !== undefined && isSubOf(m, next)
        ? next
        : m === "guests" || m === "registry"
          ? "list"
          : m === "invite"
            ? "design"
            : m === "settings"
              ? "wedding"
              : "index",
    );
  });
  const onSub = vi.fn((s: string) => setSub(s));
  const utils = render(() => (
    <ModuleShell
      weddingId="wed_1"
      weddingName="R & V"
      weddingSlug="r-and-v"
      canManage={opts.canManage ?? true}
      canEdit={opts.canEdit ?? true}
      module={module()}
      sub={sub()}
      onModule={onModule}
      onSub={onSub}
      entitlements={opts.entitlements ?? []}
      guestCap={opts.guestCap ?? 100}
    />
  ));
  return { ...utils, onModule, onSub, setModule, setSub };
}

describe("ModuleShell", () => {
  afterEach(() => cleanup());

  /** The persistent rail. The nav also renders a narrow-container sheet trigger,
   *  so module queries are scoped to the rail landmark rather than the document. */
  const rail = () => screen.getByRole("navigation", { name: /Wedding modules/i });

  it("renders the module rail with every module and lands on Overview", () => {
    renderShell({});
    for (const label of ["Overview", "Events", "Guests", "Invite", "Settings"]) {
      expect(within(rail()).getByRole("button", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(screen.getByTestId("overview")).toBeTruthy();
  });

  it("marks the active module with aria-current", () => {
    renderShell({ module: "guests", sub: "list" });
    const guests = within(rail()).getByRole("button", { name: /Guests/ });
    expect(guests.getAttribute("aria-current")).toBe("page");
    const overview = within(rail()).getByRole("button", { name: /Overview/ });
    expect(overview.getAttribute("aria-current")).toBeNull();
  });

  it("reports a module switch up via onModule and follows the controlled prop", () => {
    const { onModule } = renderShell({});
    fireEvent.click(within(rail()).getByRole("button", { name: /Events/ }));
    expect(onModule).toHaveBeenCalledWith("events");
    expect(screen.getByTestId("events")).toBeTruthy();
  });

  it("moves an Overview card's target module and sub in one step", () => {
    const { onModule, onSub } = renderShell({});
    fireEvent.click(screen.getByRole("button", { name: "overview-to-rsvps" }));
    expect(onModule.mock.calls).toEqual([["guests", "rsvps"]]);
    expect(onSub).not.toHaveBeenCalled();
    expect(screen.getByTestId("rsvps")).toBeTruthy();
  });

  it("shows the Events sub-tabs (List + Edit) and switches to the events editor", async () => {
    const { onSub } = renderShell({ module: "events", sub: "list" });
    expect(screen.getByRole("tab", { name: /List/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Edit/ })).toBeTruthy();
    // The read view shows the events table.
    expect(screen.getByTestId("events")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Edit/ }));
    expect(onSub).toHaveBeenCalledWith("edit");
    // `findBy`, not `getBy`: the editor is lazy() — it arrives a microtask after
    // the tab is chosen, behind the panel's Suspense fallback.
    expect(await screen.findByTestId("events-editor")).toBeTruthy();
    expect(screen.queryByTestId("events")).toBeNull();
  });

  it("hides the Events Edit sub from a read-only viewer", () => {
    // A viewer can't edit — the editor-only Edit sub is filtered out, so the
    // sub-tab bar collapses to a single view and the editor is never reachable.
    renderShell({ canManage: false, canEdit: false, module: "events", sub: "edit" });
    expect(screen.queryByRole("tab", { name: /Edit/ })).toBeNull();
    expect(screen.queryByTestId("events-editor")).toBeNull();
    // Falls back to the read events table.
    expect(screen.getByTestId("events")).toBeTruthy();
  });

  it("shows the Guests sub-tabs (Households + RSVPs) and switches between them", () => {
    const { onSub } = renderShell({ module: "guests", sub: "list" });
    expect(screen.getByRole("tab", { name: /Households/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /RSVPs/ })).toBeTruthy();
    // The Households sub is a READ view now — the import moved into Edit.
    expect(screen.getByTestId("guests")).toBeTruthy();
    expect(screen.queryByTestId("import")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /RSVPs/ }));
    expect(onSub).toHaveBeenCalledWith("rsvps");
    expect(screen.getByTestId("rsvps")).toBeTruthy();
    expect(screen.queryByTestId("guests")).toBeNull();
  });

  it("gives an owner the Invite Codes sub", () => {
    renderShell({ canManage: true, module: "invite", sub: "codes" });
    expect(screen.getByRole("tab", { name: /Codes/ })).toBeTruthy();
    expect(screen.getByTestId("codes")).toBeTruthy();
  });

  it("hides the owner-only Codes sub from a co-host and falls a deep link back", async () => {
    // A co-host (editor) deep-linking invite/codes must not see the owner-only
    // Codes panel — it resolves to the invite module's default (Design) sub.
    renderShell({ canManage: false, canEdit: true, module: "invite", sub: "codes" });
    expect(screen.queryByRole("tab", { name: /Codes/ })).toBeNull();
    expect(screen.queryByTestId("codes")).toBeNull();
    // The builder is lazy() — awaited for the same reason the events editor is.
    expect(await screen.findByTestId("invite-design")).toBeTruthy();
  });

  describe("settings profile — RSVP-by is the co-host's one writable field", () => {
    // Without these, swapping canEditRsvpDeadline to props.canManage (or
    // dropping it) leaves the whole feature dead in the portal with every
    // organiser and API test still green.
    it("gives an editor co-host the RSVP-by date but not the rest of the profile", () => {
      renderShell({ canManage: false, canEdit: true, module: "settings", sub: "wedding" });
      const panel = screen.getByTestId("settings");
      expect(panel.getAttribute("data-can-manage")).toBe("false");
      expect(panel.getAttribute("data-can-edit-rsvp")).toBe("true");
    });

    it("gives a viewer co-host neither", () => {
      renderShell({ canManage: false, canEdit: false, module: "settings", sub: "wedding" });
      const panel = screen.getByTestId("settings");
      expect(panel.getAttribute("data-can-manage")).toBe("false");
      expect(panel.getAttribute("data-can-edit-rsvp")).toBe("false");
    });

    it("gives the owner both", () => {
      renderShell({ canManage: true, canEdit: true, module: "settings", sub: "wedding" });
      const panel = screen.getByTestId("settings");
      expect(panel.getAttribute("data-can-manage")).toBe("true");
      expect(panel.getAttribute("data-can-edit-rsvp")).toBe("true");
    });
  });

  describe("co-hosts — adding follows canEdit, managing follows canManage", () => {
    // The additive/subtractive split has to survive the trip from OrganiserApp
    // through this shell: an editor may ADD a co-host (weddingEditor) but not
    // remove or demote one (weddingOwner). Wiring `canAdd` to the wrong flag
    // silently disables the feature with the API still granting it.
    it("gives an editor co-host the add form but not role/remove", () => {
      renderShell({ canManage: false, canEdit: true, module: "settings", sub: "hosts" });
      const panel = screen.getByTestId("hosts");
      expect(panel.getAttribute("data-can-add")).toBe("true");
      expect(panel.getAttribute("data-can-manage")).toBe("false");
    });

    it("gives a viewer co-host neither", () => {
      renderShell({ canManage: false, canEdit: false, module: "settings", sub: "hosts" });
      const panel = screen.getByTestId("hosts");
      expect(panel.getAttribute("data-can-add")).toBe("false");
      expect(panel.getAttribute("data-can-manage")).toBe("false");
    });

    it("gives the owner both", () => {
      renderShell({ canManage: true, canEdit: true, module: "settings", sub: "hosts" });
      const panel = screen.getByTestId("hosts");
      expect(panel.getAttribute("data-can-add")).toBe("true");
      expect(panel.getAttribute("data-can-manage")).toBe("true");
    });
  });

  /**
   * The CSV import moved out of the Guests READ tab (where it sat above the
   * household list carrying BOTH sheets) and into each module's Edit sub, as the
   * alternative to the on-page editor. These pin the two halves that have no
   * visible symptom when they break: that Edit offers the choice at all, and that
   * each module's import is scoped to its OWN sheet.
   */
  describe("chunk prefetch map", () => {
    it("keys PANEL_LOADERS on module:sub pairs that actually exist", () => {
      // `warmPanel` looks these up as `${module}:${sub}` and swallows a miss
      // (`?.()` + `.catch(() => {})`), so a key naming a module or sub that no
      // longer exists is invisible: no error, no failing test, just the hover
      // prefetch quietly dead and `PanelLoading` flashing on every Edit click.
      // The `schedule` → `events` rename is exactly that hazard, and this is the
      // same drift-guard shape the root CLAUDE.md prescribes for any constant
      // that has to agree with a string somewhere else.
      expect(PANEL_LOADER_KEYS.length).toBeGreaterThan(0);
      for (const key of PANEL_LOADER_KEYS) {
        const [module, sub] = key.split(":");
        expect(isModule(module!), `${key}: "${module}" is not a module`).toBe(true);
        expect(isSubOf(module as Module, sub!), `${key}: "${sub}" is not a sub of ${module}`).toBe(
          true,
        );
      }
    });
  });

  describe("edit sub — web editor or spreadsheet import", () => {
    const importMode = () => screen.getByRole("radio", { name: /spreadsheet import/i });

    it("lands on the editor, with import one click away", async () => {
      renderShell({ module: "guests", sub: "edit" });
      expect(await screen.findByTestId("guests-editor")).toBeTruthy();
      expect(screen.queryByTestId("import")).toBeNull();
      expect(importMode().getAttribute("aria-checked")).toBe("false");
    });

    it("swaps the guests editor for a GUESTS import", async () => {
      renderShell({ module: "guests", sub: "edit" });
      await screen.findByTestId("guests-editor");
      fireEvent.click(importMode());
      // `EditWorkspace` now `lazy()`-loads ImportPanel, so the mount lands a
      // tick after the click even though nothing is actually fetched (mocked).
      expect((await screen.findByTestId("import")).getAttribute("data-kind")).toBe("guests");
      expect(screen.queryByTestId("guests-editor")).toBeNull();
    });

    it("swaps the events editor for an EVENTS import", async () => {
      renderShell({ module: "events", sub: "edit" });
      await screen.findByTestId("events-editor");
      fireEvent.click(importMode());
      expect((await screen.findByTestId("import")).getAttribute("data-kind")).toBe("events");
      expect(screen.queryByTestId("events-editor")).toBeNull();
    });

    it("keeps the import out of a viewer's reach entirely", () => {
      // Edit is editor-gated, so a viewer deep-linking it lands on the read view
      // and never sees the mode switch, let alone the import.
      renderShell({ canManage: false, canEdit: false, module: "events", sub: "edit" });
      expect(screen.queryByRole("radiogroup")).toBeNull();
      expect(screen.queryByTestId("import")).toBeNull();
    });
  });

  describe("viewer read-only", () => {
    it("hides the import write surface from the guest list", () => {
      renderShell({ canManage: false, canEdit: false, module: "guests", sub: "list" });
      expect(screen.getByTestId("guests")).toBeTruthy();
      // Import is a pure write surface — a viewer doesn't see it.
      expect(screen.queryByTestId("import")).toBeNull();
    });

    it("shows a read-only fallback instead of the invite builder", () => {
      renderShell({ canManage: false, canEdit: false, module: "invite", sub: "design" });
      expect(screen.queryByTestId("invite-design")).toBeNull();
      expect(screen.getByText(/view-only access/i)).toBeTruthy();
    });

    it("still gives a viewer the read RSVPs view", () => {
      renderShell({ canManage: false, canEdit: false, module: "guests", sub: "rsvps" });
      expect(screen.getByTestId("rsvps")).toBeTruthy();
    });
  });

  /**
   * A locked module has no page. The shell coerces it to Overview, so a deep
   * link or a stale hash naming one lands on a real view rather than on an
   * empty panel — the upgrade is offered on the faded nav row instead.
   */
  describe("entitlement gating — vendors module", () => {
    it("renders Overview instead when the vendors entitlement is absent", () => {
      // No entitlements → vendors module is locked.
      renderShell({ module: "vendors", sub: "index", entitlements: [] });
      expect(screen.getByTestId("overview")).toBeTruthy();
      expect(screen.queryByTestId("vendors")).toBeNull();
      expect(screen.queryByTestId("directory-browse")).toBeNull();
    });

    // The three vendors panels are `lazy()`, like the registry and for the same
    // reason, so a mounted one arrives a microtask after the render. Every
    // positive assertion here has to await it; the NEGATIVE ones deliberately
    // do not, because the point of the locked case is that the chunk is never
    // asked for at all.
    it("renders the vendors feature views when the vendors entitlement is present", async () => {
      renderShell({ module: "vendors", sub: "index", entitlements: ["vendors"] });
      expect(screen.queryByTestId("overview")).toBeNull();
      expect(await screen.findByTestId("vendors")).toBeTruthy();
    });

    it("renders the browse sub-view when entitled and active() is 'browse'", async () => {
      renderShell({ module: "vendors", sub: "browse", entitlements: ["vendors"] });
      expect(screen.queryByTestId("overview")).toBeNull();
      expect(await screen.findByTestId("directory-browse")).toBeTruthy();
    });

    it("coerces on the absent vendors key alone, not on holding some other key", () => {
      // Has other entitlements but not vendors → still locked.
      renderShell({ module: "vendors", sub: "index", entitlements: ["capacity_500", "ai"] });
      expect(screen.getByTestId("overview")).toBeTruthy();
      expect(screen.queryByTestId("vendors")).toBeNull();
    });

    it("headlines the coerced module as Overview rather than as Vendors", () => {
      // The header, the sub-tabs and the rail's active row all read the same
      // coerced module, so nothing on screen claims a module that is not there.
      renderShell({ module: "vendors", sub: "index", entitlements: [] });
      expect(screen.getByRole("heading", { name: /Overview/ })).toBeTruthy();
      expect(screen.queryByRole("tab", { name: /My vendors/ })).toBeNull();
    });

    it("coerces without touching the route", () => {
      // The shell does not own the hash — `Dashboard` does — and pushing
      // history from a render path invites loops. So the hash keeps saying
      // `vendors` while Overview renders: stable, if not self-describing. This
      // is the only falsifiable form of that guarantee.
      const { onModule, onSub } = renderShell({
        module: "vendors",
        sub: "index",
        entitlements: [],
      });
      expect(screen.getByTestId("overview")).toBeTruthy();
      expect(onModule).not.toHaveBeenCalled();
      expect(onSub).not.toHaveBeenCalled();
    });

    it("passes the entitlement set down to Overview", () => {
      // Overview gates its own Vendors card on the same predicate, so a shell
      // that forgot to thread the prop would put a card linking to a locked
      // module on the page the coercion sends you to.
      renderShell({ module: "overview", entitlements: ["registry", "ai"] });
      expect(screen.getByTestId("overview").getAttribute("data-entitlements")).toBe("registry,ai");
    });
  });

  /**
   * `RegistryView` is `lazy()`, so a mounted registry panel arrives a microtask
   * after the render — every positive assertion here has to await it. The
   * NEGATIVE ones do not, and deliberately are not awaited: the point of the
   * locked case is that the chunk is never asked for at all.
   */
  describe("entitlement gating — registry module", () => {
    it("renders Overview instead when the registry entitlement is absent", () => {
      // A wedding without the key answers 402 on every registry route, so the
      // coercion has to keep the views unmounted, or the module fires a
      // guaranteed-failing fetch.
      renderShell({ module: "registry", sub: "list", entitlements: [] });
      expect(screen.getByTestId("overview")).toBeTruthy();
      expect(screen.queryByTestId("registry")).toBeNull();
    });

    it("renders the gift list when the registry entitlement is present", async () => {
      renderShell({ module: "registry", sub: "list", entitlements: ["registry"] });
      expect(screen.queryByTestId("overview")).toBeNull();
      expect((await screen.findByTestId("registry")).getAttribute("data-view")).toBe("list");
    });

    it("renders the gift log on the gifts sub", async () => {
      renderShell({ module: "registry", sub: "gifts", entitlements: ["registry"] });
      const view = await screen.findByTestId("registry");
      expect(view.getAttribute("data-view")).toBe("gifts");
      // The export names its file after the slug, so the shell has to hand it down.
      expect(view.getAttribute("data-slug")).toBe("r-and-v");
    });

    it("stays locked on another module's entitlement", () => {
      // The vendors key unlocks vendors, nothing else.
      renderShell({ module: "registry", sub: "list", entitlements: ["vendors"] });
      expect(screen.getByTestId("overview")).toBeTruthy();
      expect(screen.queryByTestId("registry")).toBeNull();
    });

    it("gives a viewer the module read-only rather than hiding it", async () => {
      // Role and entitlement gate different things: an entitled wedding's
      // viewer gets the read view, with the write controls gated INSIDE
      // RegistryView by canEdit rather than by hiding the module.
      renderShell({
        canManage: false,
        canEdit: false,
        module: "registry",
        sub: "gifts",
        entitlements: ["registry"],
      });
      expect(within(rail()).getByRole("button", { name: /Registry/ })).toBeTruthy();
      expect((await screen.findByTestId("registry")).getAttribute("data-view")).toBe("gifts");
    });

    it("offers both sub-tabs and reports a switch up", async () => {
      const { onSub } = renderShell({
        module: "registry",
        sub: "list",
        entitlements: ["registry"],
      });
      expect(screen.getByRole("tab", { name: /Gift list/ })).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: /Gifts received/ }));
      expect(onSub).toHaveBeenCalledWith("gifts");
      expect((await screen.findByTestId("registry")).getAttribute("data-view")).toBe("gifts");
    });
  });

  /**
   * The sub-tab strip follows the APG tabs pattern with **manual activation**:
   * arrows move focus, Enter/Space selects. That choice is load-bearing rather
   * than stylistic — every panel behind a tab mounts a view that fetches, so
   * selection-follows-focus would fire a request per keypress on the way past.
   * These tests pin the half of the pattern that has no visible symptom when it
   * breaks: the roving tabindex, the wiring between tab and panel, and the fact
   * that moving focus does *not* select.
   */
  describe("sub-tab keyboard semantics (APG tabs, manual activation)", () => {
    /** Guests carries three visible tabs for an editor — Households / Edit /
     *  RSVPs — so Home and End have somewhere to travel that the arrows don't. */
    const tabs = () => screen.getAllByRole("tab");

    it("keeps only the selected tab in the tab order", () => {
      renderShell({ module: "guests", sub: "edit" });
      const order = tabs().map((t) => [t.textContent, t.getAttribute("tabindex")]);
      expect(order).toEqual([
        ["Households", "-1"],
        ["Edit", "0"],
        ["RSVPs", "-1"],
      ]);
    });

    it("points every tab at the module's one panel, and the panel back at the selected tab", () => {
      renderShell({ module: "guests", sub: "rsvps" });
      const panel = screen.getByRole("tabpanel");
      expect(panel.id).toBe("subpanel-guests");
      for (const tab of tabs()) expect(tab.getAttribute("aria-controls")).toBe("subpanel-guests");
      // The panel names itself after whichever tab is selected, so a screen
      // reader entering the panel hears the view it is actually in.
      expect(panel.getAttribute("aria-labelledby")).toBe("subtab-guests-rsvps");
      expect(document.getElementById("subtab-guests-rsvps")?.textContent).toBe("RSVPs");
    });

    it("moves focus with the arrow keys without selecting", () => {
      const { onSub } = renderShell({ module: "guests", sub: "list" });
      const [households, edit] = tabs();
      households!.focus();
      fireEvent.keyDown(households!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(edit);
      // The whole point of manual activation: focus landed on Edit, but the
      // guest editor has not mounted and no sub change was reported.
      expect(onSub).not.toHaveBeenCalled();
      expect(screen.queryByTestId("guests-editor")).toBeNull();
    });

    it("wraps at both ends", () => {
      renderShell({ module: "guests", sub: "list" });
      const list = tabs();
      const [households, , rsvps] = list;
      households!.focus();
      fireEvent.keyDown(households!, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(rsvps);
      fireEvent.keyDown(rsvps!, { key: "ArrowRight" });
      expect(document.activeElement).toBe(households);
    });

    it("jumps to the ends with Home and End", () => {
      renderShell({ module: "guests", sub: "edit" });
      const [households, edit, rsvps] = tabs();
      edit!.focus();
      fireEvent.keyDown(edit!, { key: "End" });
      expect(document.activeElement).toBe(rsvps);
      fireEvent.keyDown(rsvps!, { key: "Home" });
      expect(document.activeElement).toBe(households);
    });

    it("selects the focused tab on click, and only then swaps the panel", async () => {
      const { onSub } = renderShell({ module: "guests", sub: "list" });
      const [, edit] = tabs();
      edit!.focus();
      fireEvent.click(edit!);
      expect(onSub).toHaveBeenCalledWith("edit");
      // The guests editor is lazy() — awaited, like the other two write panels.
      expect(await screen.findByTestId("guests-editor")).toBeTruthy();
      expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(
        "subtab-guests-edit",
      );
    });

    it("claims no tab role at all for a module with a single view", () => {
      // Overview has no sub-tabs. A lone tab is not a tablist, and a panel with
      // nothing to label it must not advertise a tabpanel role — that would
      // promise a strip the host can never find.
      renderShell({ module: "overview" });
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(screen.queryByRole("tab")).toBeNull();
      expect(screen.queryByRole("tabpanel")).toBeNull();
    });

    it("re-mints the tab/panel id pair when the module changes", () => {
      // Ids are derived from the module so the pair can never straddle two
      // modules mid-switch and leave aria-labelledby pointing at a dead node.
      const { setModule, setSub } = renderShell({ module: "guests", sub: "list" });
      expect(screen.getByRole("tabpanel").id).toBe("subpanel-guests");
      setModule("settings");
      setSub("hosts");
      const panel = screen.getByRole("tabpanel");
      expect(panel.id).toBe("subpanel-settings");
      expect(panel.getAttribute("aria-labelledby")).toBe("subtab-settings-hosts");
      expect(document.getElementById("subtab-settings-hosts")).toBeTruthy();
    });
  });

  describe("invite message links", () => {
    const MESSAGE = { name: "Invite, Design, Message" };
    const CODES = { name: "Invite, Codes" };
    const HOUSEHOLDS = { name: "Guests, Households" };

    it("sends the owner from Codes to the builder, open on its Message section", async () => {
      const { onModule, onSub } = renderShell({ module: "invite", sub: "codes" });

      fireEvent.click(within(screen.getByTestId("codes")).getByRole("button", MESSAGE));

      expect(onSub.mock.calls).toEqual([["design"]]);
      expect(onModule).not.toHaveBeenCalled();
      const builder = await screen.findByTestId("invite-design");
      expect(builder.getAttribute("data-section")).toBe("invite-message");
    });

    it("sends a Households reader to the builder, open on its Message section", async () => {
      const { onModule, onSub } = renderShell({ module: "guests", sub: "list" });

      fireEvent.click(within(screen.getByTestId("guests")).getByRole("button", MESSAGE));

      expect(onModule.mock.calls).toEqual([["invite", "design"]]);
      expect(onSub).not.toHaveBeenCalled();
      const builder = await screen.findByTestId("invite-design");
      expect(builder.getAttribute("data-section")).toBe("invite-message");
    });

    it("moves the owner from Households to Codes in one step, never through the builder", async () => {
      // Load the lazy builder first, so a stop at invite/design on the way would
      // mount it synchronously and show up in the count.
      const { onModule, onSub, setModule, setSub } = renderShell({
        module: "invite",
        sub: "design",
      });
      await screen.findByTestId("invite-design");
      setModule("guests");
      setSub("list");
      onSub.mockClear();
      const mountsBefore = builderMounts;

      fireEvent.click(within(screen.getByTestId("guests")).getByRole("button", CODES));

      expect(onModule.mock.calls).toEqual([["invite", "codes"]]);
      expect(onSub).not.toHaveBeenCalled();
      expect(screen.getByTestId("codes")).toBeTruthy();
      expect(builderMounts).toBe(mountsBefore);
    });

    it("sends the message editor's reader to Households", async () => {
      const { onModule } = renderShell({ module: "invite", sub: "design" });

      const builder = await screen.findByTestId("invite-design");
      fireEvent.click(within(builder).getByRole("button", HOUSEHOLDS));

      expect(onModule.mock.calls).toEqual([["guests", "list"]]);
      expect(screen.getByTestId("guests")).toBeTruthy();
    });

    it("asks nothing more when the move is refused", async () => {
      const { onModule, onSub } = renderShell({
        module: "invite",
        sub: "design",
        refuseModule: true,
      });

      const builder = await screen.findByTestId("invite-design");
      fireEvent.click(within(builder).getByRole("button", HOUSEHOLDS));

      expect(onModule).toHaveBeenCalledTimes(1);
      expect(onSub).not.toHaveBeenCalled();
      expect(screen.getByTestId("invite-design")).toBeTruthy();
    });

    it("names Codes without a link for an editor co-host", () => {
      renderShell({ canManage: false, canEdit: true, module: "guests", sub: "list" });

      const households = screen.getByTestId("guests");
      expect(within(households).getByRole("button", MESSAGE)).toBeTruthy();
      expect(within(households).queryByRole("button", CODES)).toBeNull();
    });

    it("opens the builder on its first section again once the organiser has moved on", async () => {
      renderShell({ module: "invite", sub: "codes" });
      fireEvent.click(within(screen.getByTestId("codes")).getByRole("button", MESSAGE));
      expect((await screen.findByTestId("invite-design")).getAttribute("data-section")).toBe(
        "invite-message",
      );

      fireEvent.click(screen.getByRole("tab", { name: "Codes" }));
      fireEvent.click(screen.getByRole("tab", { name: "Design" }));

      expect((await screen.findByTestId("invite-design")).getAttribute("data-section")).toBe("");
    });

    it("moves focus to the new view's heading", () => {
      renderShell({ module: "guests", sub: "list" });

      fireEvent.click(within(screen.getByTestId("guests")).getByRole("button", CODES));

      expect(document.activeElement).toBe(
        screen.getByRole("heading", { level: 2, name: "Invite" }),
      );
    });
  });
});
