import { render, cleanup, fireEvent, screen } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";

import {
  DiscoveryFilters,
  emptyFilters,
  hasActiveFilters,
  type DiscoveryFilterValues,
} from "../../src/explore/DiscoveryFilters";

describe("emptyFilters", () => {
  it("returns a value with every field unset", () => {
    expect(emptyFilters()).toEqual({
      from: null,
      to: null,
      radiusKm: null,
      coords: null,
      priceMin: null,
      priceMax: null,
      friendsOnly: false,
    });
  });
});

describe("hasActiveFilters", () => {
  it("returns false for the empty value", () => {
    expect(hasActiveFilters(emptyFilters())).toBe(false);
  });

  it("returns true when any field is set", () => {
    const cases: Partial<DiscoveryFilterValues>[] = [
      { from: "2026-04-30T00:00" },
      { to: "2026-04-30T00:00" },
      { radiusKm: 25 },
      { priceMin: 10 },
      { priceMax: 50 },
      { friendsOnly: true },
    ];
    for (const c of cases) {
      expect(hasActiveFilters({ ...emptyFilters(), ...c })).toBe(true);
    }
  });

  it("ignores `coords` alone (without a radius the location filter is inert)", () => {
    expect(hasActiveFilters({ ...emptyFilters(), coords: { lat: 51, lng: 0 } })).toBe(false);
  });
});

describe("DiscoveryFilters component", () => {
  afterEach(cleanup);

  it("does not render the dialog body when open=false", () => {
    render(() => (
      <DiscoveryFilters
        open={false}
        onOpenChange={() => {}}
        signedIn={false}
        value={emptyFilters()}
        onApply={() => {}}
      />
    ));
    expect(screen.queryByText("More filters")).toBeNull();
  });

  it("renders the dialog body (via portal) when open=true", () => {
    render(() => (
      <DiscoveryFilters
        open
        onOpenChange={() => {}}
        signedIn={false}
        value={emptyFilters()}
        onApply={() => {}}
      />
    ));
    expect(screen.getByText("More filters")).toBeTruthy();
  });

  it("hides the friends-only checkbox when signedIn=false", () => {
    render(() => (
      <DiscoveryFilters
        open
        onOpenChange={() => {}}
        signedIn={false}
        value={emptyFilters()}
        onApply={() => {}}
      />
    ));
    expect(document.body.textContent).not.toContain("Only events hosted by or RSVPed by friends");
  });

  it("shows the friends-only checkbox when signedIn=true", () => {
    render(() => (
      <DiscoveryFilters
        open
        onOpenChange={() => {}}
        signedIn
        value={emptyFilters()}
        onApply={() => {}}
      />
    ));
    expect(screen.getByText(/Only events hosted by or RSVPed by friends/)).toBeTruthy();
  });

  it("Apply propagates the edited draft to onApply and closes the drawer", () => {
    const onApply = vi.fn();
    const onOpenChange = vi.fn();
    render(() => (
      <DiscoveryFilters
        open
        onOpenChange={onOpenChange}
        signedIn={false}
        value={emptyFilters()}
        onApply={onApply}
      />
    ));
    fireEvent.input(screen.getByLabelText("Price max"), { target: { value: "30" } });
    fireEvent.click(screen.getByText("Apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toMatchObject({ priceMax: 30 });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Clear emits empty filters and closes the drawer", () => {
    const onApply = vi.fn();
    const onOpenChange = vi.fn();
    render(() => (
      <DiscoveryFilters
        open
        onOpenChange={onOpenChange}
        signedIn={false}
        value={{ ...emptyFilters(), priceMax: 50, friendsOnly: false }}
        onApply={onApply}
      />
    ));
    fireEvent.click(screen.getByText("Clear"));
    expect(onApply).toHaveBeenCalledWith(emptyFilters());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("location explainer reflects the granted state when coords are set", () => {
    render(() => (
      <DiscoveryFilters
        open
        onOpenChange={() => {}}
        signedIn={false}
        value={{ ...emptyFilters(), coords: { lat: 51, lng: 0 } }}
        onApply={() => {}}
      />
    ));
    expect(document.body.textContent).toContain("Using your location");
    expect(document.body.textContent).toContain("Update location");
  });

  it("location explainer prompts before consent when coords are null", () => {
    render(() => (
      <DiscoveryFilters
        open
        onOpenChange={() => {}}
        signedIn={false}
        value={emptyFilters()}
        onApply={() => {}}
      />
    ));
    expect(document.body.textContent).toContain("Click 'Use my location' to enable");
    expect(document.body.textContent).toContain("Use my location");
  });
});
