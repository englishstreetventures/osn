// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ModuleSidebar from "../../src/components/ModuleSidebar";
import { MODULE_NAV } from "../../src/lib/module-nav";

/** Every gated entitlement, so the nav's structural tests are about the nav
 *  rather than about the lock. The locked shape has its own describe below. */
const ENTITLED = ["vendors", "registry"];

/**
 * ModuleSidebar is the IA shell's primary nav — a keyboard-accessible <nav> of
 * module buttons with aria-current on the active one. It's presentational: it
 * renders every module and reports selections up. Write gating lives inside
 * each module; entitlement gating fades the row and offers an upgrade rather
 * than hiding it.
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

  it("renders every module in workflow order", () => {
    render(() => <ModuleSidebar active="overview" entitlements={ENTITLED} onSelect={vi.fn()} />);
    const labels = within(rail())
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(labels).toEqual([
      "◈Overview",
      "◇Events",
      "✓Checklist",
      "$Budget",
      "⬡Vendors",
      "⊞Registry",
      "✎Guests",
      "✦Invite",
      "✧Settings",
    ]);
  });

  it("marks the active module with aria-current and no others", () => {
    render(() => <ModuleSidebar active="invite" entitlements={ENTITLED} onSelect={vi.fn()} />);
    const marked = within(rail())
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-current") === "page");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toContain("Invite");
  });

  it("opens a sheet listing every module and closes it on a selection", async () => {
    const onSelect = vi.fn();
    render(() => <ModuleSidebar active="overview" entitlements={ENTITLED} onSelect={onSelect} />);

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
    render(() => <ModuleSidebar active="overview" entitlements={ENTITLED} onSelect={onSelect} />);
    fireEvent.click(within(rail()).getByRole("button", { name: /Settings/ }));
    expect(onSelect).toHaveBeenCalledWith("settings");
  });

  it("is a labelled navigation landmark", () => {
    render(() => <ModuleSidebar active="overview" entitlements={ENTITLED} onSelect={vi.fn()} />);
    expect(rail().tagName).toBe("NAV");
    expect(rail().getAttribute("aria-label")).toBe("Wedding modules");
  });

  /**
   * A module the wedding is not entitled to.
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

    it("fades the row, names the lock, and drops its native tooltip", () => {
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={vi.fn()} />);
      const row = lockedRow();
      // The lock is in the accessible name, so it reaches a screen reader while
      // tabbing rather than only after a three-second dwell.
      expect(row.getAttribute("aria-label")).toBe("Registry — locked. Upgrade to unlock.");
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
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={vi.fn()} />);
      expect(lockedRow().getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(lockedRow());
      expect(lockedRow().getAttribute("aria-expanded")).toBe("true");
    });

    it("navigates nowhere when clicked, and offers the upgrade instead", async () => {
      const onSelect = vi.fn();
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={onSelect} />);
      fireEvent.click(lockedRow());
      expect(onSelect).not.toHaveBeenCalled();
      // The tap path: the same click that does not navigate opens the offer.
      expect(await screen.findByText("Gift registry")).toBeTruthy();
      expect(screen.getByText(/List the gifts you'd like/)).toBeTruthy();
    });

    it("opens nothing until the pointer has rested for three seconds", async () => {
      vi.useFakeTimers();
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={vi.fn()} />);
      fireEvent.pointerEnter(lockedRow(), { pointerType: "mouse" });

      // Well past Kobalte's own 700ms default, so this asserts the override took
      // rather than merely that some delay exists.
      await vi.advanceTimersByTimeAsync(2900);
      expect(screen.queryByText("Gift registry")).toBeNull();

      await vi.advanceTimersByTimeAsync(200);
      expect(screen.getByText("Gift registry")).toBeTruthy();
    });

    it("offers an Upgrade button that does nothing", async () => {
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={vi.fn()} />);
      fireEvent.click(lockedRow());
      await screen.findByText("Gift registry");
      // Not `/Upgrade/` alone: the locked row's own accessible name says
      // "Upgrade to unlock", so that pattern matches the trigger too.
      const upgrade = screen.getByRole("button", { name: /coming soon/i });
      expect((upgrade as HTMLButtonElement).disabled).toBe(true);
    });

    it("opens after a three-second keyboard focus, not on focus alone", async () => {
      // Kobalte's trigger treats focus like pointer-enter, so this is the whole
      // keyboard path to the card — and it is why the row carries
      // `aria-disabled` rather than `disabled`, which would take the row out of
      // the tab order and drop the handler with it.
      vi.useFakeTimers();
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={vi.fn()} />);
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
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={vi.fn()} />);
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
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={vi.fn()} />);
      fireEvent.pointerEnter(lockedRow(), { pointerType: "touch" });

      await vi.advanceTimersByTimeAsync(6000);
      expect(screen.queryByText("Gift registry")).toBeNull();
    });

    it("closes the card on a second tap", async () => {
      // `open` is this component's own signal, so both halves of the round-trip
      // are our code rather than Kobalte's. It has to toggle: a touch user has
      // no pointer-leave, so without this the first tap opens a card that never
      // goes away, and on the sheet that card sits over the nav.
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={vi.fn()} />);
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
      render(() => <ModuleSidebar active="overview" entitlements={[]} onSelect={onSelect} />);
      fireEvent.click(
        screen.getByRole("button", { name: /Open wedding navigation, currently Overview/ }),
      );
      const sheet = await screen.findByRole("dialog", { name: /Wedding modules/i });

      const row = within(sheet).getByRole("button", { name: /Registry/ });
      expect(row.getAttribute("aria-label")).toBe("Registry — locked. Upgrade to unlock.");
      expect(row.getAttribute("class")).toContain("text-text-faint");

      fireEvent.click(row);
      expect(onSelect).not.toHaveBeenCalled();
      expect(await screen.findByText("Gift registry")).toBeTruthy();
      // The sheet stays open: nothing was navigated to, so there is nothing to
      // close it for.
      expect(screen.getByRole("dialog", { name: /Wedding modules/i })).toBeTruthy();
    });

    it("unlocks the row when the entitlement arrives, without a remount", () => {
      // `MODULE_NAV` never changes, so `For` runs its callback once per module.
      // A ternary between the locked row and the plain button would be resolved
      // then and never revisited, leaving the previous wedding's locks on screen
      // after a wedding switch or a mid-session grant.
      const [held, setHeld] = createSignal<string[]>([]);
      render(() => <ModuleSidebar active="overview" entitlements={held()} onSelect={vi.fn()} />);
      expect(lockedRow().getAttribute("aria-label")).toContain("locked");

      setHeld(["registry"]);
      const row = within(rail()).getByRole("button", { name: /Registry/ });
      expect(row.getAttribute("aria-label")).toBeNull();
      expect(row.getAttribute("title")).toBe("Your gift list and what has arrived");
    });

    it("locks only the modules whose entitlement is missing", () => {
      render(() => (
        <ModuleSidebar active="overview" entitlements={["registry"]} onSelect={vi.fn()} />
      ));
      const locked = within(rail())
        .getAllByRole("button")
        .filter((b) => (b.getAttribute("aria-label") ?? "").includes("locked"))
        .map((b) => b.textContent);
      expect(locked).toEqual(["⬡Vendors"]);
    });
  });
});
