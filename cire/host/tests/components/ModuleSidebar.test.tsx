// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ModuleSidebar from "../../src/components/ModuleSidebar";
import { MODULE_NAV } from "../../src/lib/module-nav";
import { __resetModuleRowsStore, moduleRowsAccessor } from "../../src/lib/module-rows-store";
import type { Tier } from "../../src/lib/tiers";

// The Upgrade button mounts a dialog, and the dialog reads `useAuth()` and
// prices itself. Neither is what this file is about — the nav's job is to OPEN
// it — so both are stubbed and the dialog's own behaviour is tested next door
// in UpgradeDialog.test.tsx. The locked cards' downloads ask the same
// `authFetch`, so it answers by URL: `moduleRows` is what `/module-rows`
// says, and a CSV path answers a small file.
let moduleRows: () => Response;
const authFetch = vi.fn(async (url: string) => {
  if (url.endsWith("/module-rows")) return moduleRows();
  if (url.endsWith(".csv")) return new Response("Header\r\n", { status: 200 });
  return new Response(JSON.stringify({ upgrades: [] }), { status: 200 });
});
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@shared/toast", () => ({ toast }));
const downloadBlob = vi.fn();
vi.mock("../../src/lib/download", () => ({
  downloadBlob: (name: string, blob: Blob) => downloadBlob(name, blob),
}));

const counts = (body: Partial<{ budgetLines: number; tasks: number; gifts: number }>) => () =>
  new Response(JSON.stringify({ budgetLines: 0, tasks: 0, gifts: 0, ...body }), { status: 200 });

beforeEach(() => {
  moduleRows = counts({ budgetLines: 0, tasks: 0 });
  authFetch.mockClear();
  downloadBlob.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  __resetModuleRowsStore();
});

/** The top tier, which opens every module, so the nav's structural tests are
 *  about the nav rather than about the lock. The locked shape has its own
 *  describe below. */
const TOP: Tier = "crimson";

/**
 * ModuleSidebar is the IA shell's primary nav — a keyboard-accessible <nav> of
 * module buttons with aria-current on the active one. It's presentational: it
 * renders every module and reports selections up. Write gating lives inside
 * each module; tier gating fades the row and offers an upgrade rather than
 * hiding it.
 */
describe("ModuleSidebar", () => {
  afterEach(() => cleanup());

  /** The persistent rail. Both surfaces sit in the DOM — the container query
   *  hides one with `display: none`, which happy-dom doesn't apply — so module
   *  queries are scoped to the rail landmark rather than the document.
   *
   *  Both navs legitimately carry the same accessible name (only one is ever
   *  rendered to a real user), so the rail is picked as the one *outside* the
   *  dialog rather than by name alone — otherwise this helper would start
   *  throwing the moment a test queried it with the sheet open. */
  const rail = () => {
    const navs = screen.getAllByRole("navigation", { name: /Wedding modules/i });
    const found = navs.find((nav) => !nav.closest('[role="dialog"]'));
    if (!found) throw new Error("no module rail outside the sheet");
    return found;
  };

  it("inks the rail's selected label for reading and leaves its icon gold", () => {
    render(() => (
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="guests"
        tier={TOP}
        onSelect={vi.fn()}
      />
    ));
    for (const row of within(rail()).getAllByRole("button")) {
      const active = row.getAttribute("aria-current") === "page";
      // Gold paints about 2.2:1 in the light theme; the label is text and needs
      // the ink. The icon is decoration and keeps the metal.
      expect(row.classList.contains("text-gold-ink")).toBe(active);
      expect(row.classList.contains("text-gold")).toBe(false);
      expect(row.querySelector("svg")!.classList.contains("text-gold")).toBe(active);
    }
    expect(
      within(rail())
        .getAllByRole("button")
        .some((b) => b.hasAttribute("aria-current")),
    ).toBe(true);
  });

  it("inks the sheet's selected label for reading and leaves its icon gold", async () => {
    render(() => (
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="guests"
        tier={TOP}
        onSelect={vi.fn()}
      />
    ));
    fireEvent.click(
      screen.getByRole("button", { name: /Open wedding navigation, currently Guests/ }),
    );
    const sheet = await screen.findByRole("dialog", { name: /Wedding modules/i });
    const selected = within(sheet)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.classList.contains("text-gold-ink")).toBe(true);
    expect(selected[0]!.classList.contains("text-gold")).toBe(false);
    expect(selected[0]!.querySelector("svg")!.classList.contains("text-gold")).toBe(true);
  });

  it("renders every module in workflow order", () => {
    render(() => (
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="overview"
        tier={TOP}
        onSelect={vi.fn()}
      />
    ));
    const labels = within(rail())
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual([
      "Overview",
      "Events",
      "Checklist",
      "Budget",
      "Vendors",
      "Registry",
      "Guests",
      "Invite",
      "Settings",
    ]);
  });

  it("leads every row with one icon at the shared size, hidden from assistive tech", () => {
    render(() => (
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="overview"
        tier="ivory"
        onSelect={vi.fn()}
      />
    ));
    // Locked rows too: an organiser whose tier lacks the module still sees the mark.
    for (const row of within(rail()).getAllByRole("button")) {
      const icons = row.querySelectorAll("svg");
      expect(icons).toHaveLength(1);
      // `size-icon` is what only `ModuleIcon` applies, so this proves the row
      // goes through it rather than drawing an icon at its own size.
      expect(icons[0]!.classList.contains("size-icon")).toBe(true);
      expect(icons[0]!.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("marks the active module with aria-current and no others", () => {
    render(() => (
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="invite"
        tier={TOP}
        onSelect={vi.fn()}
      />
    ));
    const marked = within(rail())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Invite");
  });

  it("opens a sheet listing every module and closes it on a selection", async () => {
    const onSelect = vi.fn();
    render(() => (
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="overview"
        tier={TOP}
        onSelect={onSelect}
      />
    ));

    // The narrow-container surface: a trigger naming the current module, so a
    // guest never has to open the sheet to know where they are. The visible
    // text names only the module; "currently Overview" lives in the
    // accessible name so the button isn't announced as the page it's already on.
    const trigger = screen.getByRole("button", {
      name: /Open wedding navigation, currently Overview/,
    });
    expect(trigger.textContent).toContain("Overview");
    fireEvent.click(trigger);

    const sheet = await screen.findByRole("dialog", { name: /Wedding modules/i });
    const sheetLabels = within(sheet)
      .getAllByRole("button")
      // Drop the close button; keep the module rows.
      .filter((b) => b.getAttribute("aria-label") !== "Close modules")
      .map((b) => b.textContent);
    expect(sheetLabels).toHaveLength(MODULE_NAV.length);
    expect(sheetLabels[0]).toContain("Overview");
    // Every module reachable in one screen — the point of replacing the strip.
    expect(sheetLabels.some((l) => l?.includes("Settings"))).toBe(true);

    // Every sheet row leads with its icon, and only the current module's is
    // tinted full gold — on a phone this list is the only navigation.
    const rows = within(sheet)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-label") !== "Close modules");
    for (const row of rows) {
      const icons = row.querySelectorAll("svg.size-icon");
      expect(icons).toHaveLength(1);
      const active = row.textContent?.startsWith("Overview");
      expect(icons[0]!.classList.contains(active ? "text-gold" : "text-gold-dim")).toBe(true);
    }

    fireEvent.click(within(sheet).getByRole("button", { name: /Budget/ }));
    expect(onSelect).toHaveBeenCalledWith("budget");
    // Picking a module dismisses the sheet rather than leaving it over the panel.
    // Asserted on the trigger's expanded state, not on unmount: Kobalte defers the
    // removal until the exit keyframe ends, and happy-dom applies no stylesheet, so
    // the node lingers here in a way it never would in a browser.
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
  });

  it("reports the selected module up via onSelect", () => {
    const onSelect = vi.fn();
    render(() => (
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="overview"
        tier={TOP}
        onSelect={onSelect}
      />
    ));
    fireEvent.click(within(rail()).getByRole("button", { name: /Settings/ }));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("is a labelled navigation landmark", () => {
    render(() => (
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="overview"
        tier={TOP}
        onSelect={vi.fn()}
      />
    ));
    expect(rail().tagName).toBe("NAV");
    expect(rail().getAttribute("aria-label")).toBe("Wedding modules");
  });

  /**
   * A module the wedding's tier does not include.
   *
   * The row stays in the nav, faded and inert, and offers the upgrade three
   * ways: a three-second pointer dwell, the same delay on keyboard focus, and a
   * click — which is the only path a touch user has, because Kobalte's hover
   * card ignores touch pointers outright.
   */
  describe("a locked module", () => {
    /** Kobalte's popper is floating-ui, which observes its reference and
     *  floating elements. happy-dom ships no `ResizeObserver`, so the card
     *  would throw on open without one; it runs no layout either, so the stub
     *  reports nothing and the card's placement is not what these tests
     *  check. */
    class NoopResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    beforeEach(() => {
      vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    });

    afterEach(() => {
      // Restore the clock even for the tests that never faked it: a leaked fake
      // clock hangs the `findByRole`/`waitFor` in the sheet test above.
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    const lockedRow = () => within(rail()).getByRole("button", { name: /Registry/ });

    it("fades the row, names the lock and its tier, and drops its native tooltip", () => {
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      const row = lockedRow();
      // The lock, and the tier that lifts it, are in the accessible name, so
      // they reach a screen reader while tabbing rather than only after a
      // three-second dwell.
      expect(row.getAttribute("aria-label")).toBe("Registry — locked. Included with Gold.");
      // Never `disabled`: Kobalte's trigger drops its pointer and focus
      // handlers on a disabled trigger, so the card could never open.
      expect(row.hasAttribute("disabled")).toBe(false);
      // And never `aria-disabled`: the row answers a click by opening the
      // offer, so claiming it is inoperable would be a lie to assistive tech.
      expect(row.hasAttribute("aria-disabled")).toBe(false);
      // One token, not a token plus an opacity — both text tokens are already
      // translucent, and multiplying them puts the label under the whole ramp.
      expect(row.getAttribute("class")).toContain("text-text-faint");
      expect(row.getAttribute("class")).not.toContain("opacity-");
      // No `title`: a native tooltip fires well inside the dwell and would race
      // the popover.
      expect(row.hasAttribute("title")).toBe(false);
    });

    it("reports the card's state on the trigger", () => {
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      expect(lockedRow().getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(lockedRow());
      expect(lockedRow().getAttribute("aria-expanded")).toBe("true");
    });

    it("navigates nowhere when clicked, and offers the upgrade instead", async () => {
      const onSelect = vi.fn();
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={onSelect}
        />
      ));
      fireEvent.click(lockedRow());
      expect(onSelect).not.toHaveBeenCalled();
      // The tap path: the same click that does not navigate opens the offer.
      expect(await screen.findByText("Gift registry")).toBeTruthy();
      expect(screen.getByText(/List the gifts you'd like/)).toBeTruthy();
    });

    it("names the tier that includes the module in the card", async () => {
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      fireEvent.click(lockedRow());
      expect(await screen.findByText("Included with Gold")).toBeTruthy();
    });

    it("names Crimson on the Vendors card, the one module Gold does not open", async () => {
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="gold"
          onSelect={vi.fn()}
        />
      ));
      const vendors = within(rail()).getByRole("button", { name: /Vendors/ });
      expect(vendors.getAttribute("aria-label")).toBe("Vendors — locked. Included with Crimson.");
      fireEvent.click(vendors);
      expect(await screen.findByText("Included with Crimson")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: /^upgrade to crimson$/i }));
      // The dialog sells the tier the lock names.
      expect(await screen.findByRole("dialog", { name: /upgrade: crimson/i })).toBeTruthy();
    });

    it("opens nothing until the pointer has rested for three seconds", async () => {
      vi.useFakeTimers();
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      fireEvent.pointerEnter(lockedRow(), { pointerType: "mouse" });

      // Well past Kobalte's own 700ms default, so this asserts the override took
      // rather than merely that some delay exists.
      await vi.advanceTimersByTimeAsync(2900);
      expect(screen.queryByText("Gift registry")).toBeNull();

      await vi.advanceTimersByTimeAsync(200);
      expect(screen.getByText("Gift registry")).toBeTruthy();
    });

    it("offers a live Upgrade button that opens the purchase dialog", async () => {
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      fireEvent.click(lockedRow());
      await screen.findByText("Gift registry");
      // Anchored: the locked row's own accessible name names the tier too.
      const upgrade = screen.getByRole("button", { name: /^upgrade to gold$/i });
      expect((upgrade as HTMLButtonElement).disabled).toBe(false);

      fireEvent.click(upgrade);
      // The popover is anchored to a row the dialog is about to cover, so it
      // closes on the way — what survives is the dialog, selling the tier.
      const dialog = await screen.findByRole("dialog", { name: /upgrade: gold/i });
      expect(dialog).toBeTruthy();
    });

    it("opens after a three-second keyboard focus, not on focus alone", async () => {
      // Kobalte's trigger treats focus like pointer-enter, so this is the whole
      // keyboard path to the card — and it is why the row carries
      // `aria-disabled` rather than `disabled`, which would take the row out of
      // the tab order and drop the handler with it.
      vi.useFakeTimers();
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      fireEvent.focus(lockedRow());

      await vi.advanceTimersByTimeAsync(2900);
      expect(screen.queryByText("Gift registry")).toBeNull();

      await vi.advanceTimersByTimeAsync(200);
      expect(screen.getByText("Gift registry")).toBeTruthy();
    });

    it("opens nothing when the pointer leaves before the dwell is up", async () => {
      // The reason the delay is 3000 and not Kobalte's 700: a pointer merely
      // crossing the rail must not leave a card behind it. A positive-only
      // timing test cannot tell a working cancel from one that never runs —
      // both go green, and the broken one pops the card three seconds after the
      // pointer has moved on.
      vi.useFakeTimers();
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      const row = lockedRow();
      fireEvent.pointerEnter(row, { pointerType: "mouse" });
      await vi.advanceTimersByTimeAsync(2000);
      fireEvent.pointerLeave(row, { pointerType: "mouse" });

      await vi.advanceTimersByTimeAsync(4000);
      expect(screen.queryByText("Gift registry")).toBeNull();
    });

    it("opens nothing for a touch pointer, which is why the click path exists", async () => {
      // Kobalte drops touch pointers in both handlers. Asserting it keeps the
      // click path from being read as redundant and quietly removed.
      vi.useFakeTimers();
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      fireEvent.pointerEnter(lockedRow(), { pointerType: "touch" });

      await vi.advanceTimersByTimeAsync(6000);
      expect(screen.queryByText("Gift registry")).toBeNull();
    });

    it("closes the card on a second tap", async () => {
      // `open` is this component's own signal, so both halves of the round-trip
      // are our code rather than Kobalte's. It has to toggle: a touch user has
      // no pointer-leave, so without this the first tap opens a card that never
      // goes away, and on the sheet that card sits over the nav.
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={vi.fn()}
        />
      ));
      fireEvent.click(lockedRow());
      await screen.findByText("Gift registry");

      fireEvent.click(lockedRow());
      // Asserted on the trigger's expanded state, not on unmount, for the same
      // reason the sheet test is: Kobalte holds the content until the exit
      // keyframe ends, and happy-dom applies no stylesheet, so the node lingers
      // here in a way it never would in a browser.
      await waitFor(() => expect(lockedRow().getAttribute("aria-expanded")).toBe("false"));
    });

    it("locks the sheet's row too, and a tap there offers the upgrade", async () => {
      // The sheet is written independently of the rail, and it is the surface
      // with no dwell at all — invert its `Show` and every rail assertion above
      // still passes while the phone loses its only way in.
      const onSelect = vi.fn();
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier="ivory"
          onSelect={onSelect}
        />
      ));
      fireEvent.click(
        screen.getByRole("button", { name: /Open wedding navigation, currently Overview/ }),
      );
      const sheet = await screen.findByRole("dialog", { name: /Wedding modules/i });

      const row = within(sheet).getByRole("button", { name: /Registry/ });
      expect(row.getAttribute("aria-label")).toBe("Registry — locked. Included with Gold.");
      expect(row.getAttribute("class")).toContain("text-text-faint");

      fireEvent.click(row);
      expect(onSelect).not.toHaveBeenCalled();
      expect(await screen.findByText("Gift registry")).toBeTruthy();
      // The sheet stays open: nothing was navigated to, so there is nothing to
      // close it for.
      expect(screen.getByRole("dialog", { name: /Wedding modules/i })).toBeTruthy();
    });

    it("unlocks the row when the tier rises, without a remount", () => {
      // `MODULE_NAV` never changes, so `For` runs its callback once per module.
      // A ternary between the locked row and the plain button would be resolved
      // then and never revisited, leaving the previous wedding's locks on screen
      // after a wedding switch or a mid-session upgrade.
      const [tier, setTier] = createSignal<Tier>("ivory");
      render(() => (
        <ModuleSidebar
          weddingId="wed_test"
          weddingSlug="test-wedding"
          canManage={false}
          active="overview"
          tier={tier()}
          onSelect={vi.fn()}
        />
      ));
      expect(lockedRow().getAttribute("aria-label")).toContain("locked");

      setTier("gold");
      const row = within(rail()).getByRole("button", { name: /Registry/ });
      expect(row.getAttribute("aria-label")).toBeNull();
      expect(row.getAttribute("title")).toBe("Your gift list and what has arrived");
    });

    it("locks only the modules the tier does not include", () => {
      const lockedOn = (tier: Tier) => {
        const { unmount } = render(() => (
          <ModuleSidebar
            weddingId="wed_test"
            weddingSlug="test-wedding"
            canManage={false}
            active="overview"
            tier={tier}
            onSelect={vi.fn()}
          />
        ));
        const locked = within(rail())
          .getAllByRole("button")
          .filter((b) => (b.getAttribute("aria-label") ?? "").includes("locked"))
          .map((b) => b.textContent);
        unmount();
        return locked;
      };
      expect(lockedOn("ivory")).toEqual(["Checklist", "Budget", "Vendors", "Registry"]);
      expect(lockedOn("gold")).toEqual(["Vendors"]);
      expect(lockedOn("crimson")).toEqual([]);
    });

    /**
     * The rows a wedding holds in a module it can no longer open. The Gold
     * modules refuse a wedding below Gold, reads included, so the owner's card
     * is the one place left to take them from.
     */
    describe("the rows the couple entered before it locked", () => {
      const asOwner = (tier: Tier = "ivory") =>
        render(() => (
          <ModuleSidebar
            weddingId="wed_test"
            weddingSlug="our-day"
            canManage
            active="overview"
            tier={tier}
            onSelect={vi.fn()}
          />
        ));
      const row = (name: RegExp) => within(rail()).getByRole("button", { name });
      const probes = () =>
        authFetch.mock.calls.filter(([url]) => String(url).endsWith("/module-rows"));

      it("asks nothing until an owner opens the card", () => {
        asOwner();
        expect(probes()).toHaveLength(0);
      });

      it("offers the budget as a CSV, with how many lines it holds", async () => {
        moduleRows = counts({ budgetLines: 2, tasks: 0 });
        asOwner();
        fireEvent.click(row(/^Budget/));

        expect(await screen.findByText("Your 2 budget lines are still here.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Download as CSV" }));

        await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
        expect(downloadBlob.mock.calls[0]![0]).toBe("cire-budget-our-day.csv");
        expect(authFetch.mock.calls.map(([url]) => String(url))).toContainEqual(
          expect.stringMatching(/\/api\/organiser\/weddings\/wed_test\/budget\.csv$/),
        );
        expect(toast.success).toHaveBeenCalledWith("Budget downloaded");
      });

      it("offers the checklist as tasks.csv, and names one task as one", async () => {
        moduleRows = counts({ budgetLines: 0, tasks: 1 });
        asOwner();
        fireEvent.click(row(/^Checklist/));

        expect(await screen.findByText("Your 1 task is still here.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Download as CSV" }));
        await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
        expect(downloadBlob.mock.calls[0]![0]).toBe("cire-tasks-our-day.csv");
      });

      it("offers nothing when the module holds no rows", async () => {
        moduleRows = counts({ budgetLines: 0, tasks: 5 });
        asOwner();
        fireEvent.click(row(/^Budget/));
        // The count has landed and says there is nothing to take.
        await waitFor(() => expect(moduleRowsAccessor("wed_test")()).not.toBeNull());
        expect(screen.queryByRole("button", { name: "Download as CSV" })).toBeNull();
        expect(screen.queryByText(/still here/)).toBeNull();
      });

      it("asks once for the wedding, however many cards open", async () => {
        moduleRows = counts({ budgetLines: 3, tasks: 4 });
        asOwner();
        fireEvent.click(row(/^Budget/));
        expect(await screen.findByText("Your 3 budget lines are still here.")).toBeTruthy();
        fireEvent.click(row(/^Checklist/));
        expect(await screen.findByText("Your 4 tasks are still here.")).toBeTruthy();
        expect(probes()).toHaveLength(1);
      });

      // A failed count must not hide the only way back to the rows.
      it("still offers the download when the count cannot be read", async () => {
        moduleRows = () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
        asOwner();
        fireEvent.click(row(/^Budget/));
        expect(await screen.findByText("Anything in your budget is still here.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Download as CSV" })).toBeTruthy();
      });

      it("says so when the download fails, and saves nothing", async () => {
        moduleRows = counts({ budgetLines: 2, tasks: 0 });
        asOwner();
        fireEvent.click(row(/^Budget/));
        await screen.findByText("Your 2 budget lines are still here.");
        authFetch.mockImplementationOnce(
          async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Download as CSV" }));
        await waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith("Budget download failed. Try again."),
        );
        expect(downloadBlob).not.toHaveBeenCalled();
      });

      // Every export is owner-only, so a co-host's card neither asks nor offers.
      it("offers a co-host nothing and asks nothing", async () => {
        moduleRows = counts({ budgetLines: 2, tasks: 2 });
        render(() => (
          <ModuleSidebar
            weddingId="wed_test"
            weddingSlug="our-day"
            canManage={false}
            active="overview"
            tier="ivory"
            onSelect={vi.fn()}
          />
        ));
        fireEvent.click(row(/^Budget/));
        expect(await screen.findByText("Included with Gold")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Download as CSV" })).toBeNull();
        expect(probes()).toHaveLength(0);
      });

      // The sheet is the phone's nav, wired apart from the rail, and on a
      // phone it is the only way to the download.
      it("offers the download from the sheet's locked card too", async () => {
        moduleRows = counts({ budgetLines: 2 });
        asOwner();
        fireEvent.click(
          screen.getByRole("button", { name: /Open wedding navigation, currently Overview/ }),
        );
        const sheet = await screen.findByRole("dialog", { name: /Wedding modules/i });
        fireEvent.click(within(sheet).getByRole("button", { name: /^Budget/ }));

        expect(await screen.findByText("Your 2 budget lines are still here.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Download as CSV" }));
        await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
        expect(downloadBlob.mock.calls[0]![0]).toBe("cire-budget-our-day.csv");
      });

      // A wedding holds gifts only once it has been on Gold, so this is the
      // card a wedding an operator moved back down sees.
      it("offers the gift log as gifts.csv on the Registry card", async () => {
        moduleRows = counts({ gifts: 3 });
        asOwner();
        fireEvent.click(lockedRow());
        expect(await screen.findByText("Your 3 gifts are still here.")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Download as CSV" }));
        await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
        expect(downloadBlob.mock.calls[0]![0]).toBe("cire-gifts-our-day.csv");
        expect(toast.success).toHaveBeenCalledWith("Gift log downloaded");
      });

      it("offers nothing on a card whose module has no export", async () => {
        moduleRows = counts({ budgetLines: 2, tasks: 2, gifts: 2 });
        asOwner("gold");
        fireEvent.click(row(/^Vendors/));
        expect(await screen.findByText("Included with Crimson")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Download as CSV" })).toBeNull();
        expect(probes()).toHaveLength(0);
      });
    });
  });
});
