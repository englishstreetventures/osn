// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { VenueLineupTimeline } from "../../src/components/VenueLineupTimeline";
import type { LineupSlot } from "../../src/lib/venues";

const slot = (overrides: Partial<LineupSlot>): LineupSlot => ({
  id: "lnp_1",
  eventId: "evt_1",
  artistName: "Artist",
  role: "support",
  slotStart: "2030-06-07T22:00:00.000Z",
  slotEnd: "2030-06-07T23:30:00.000Z",
  orderIndex: 0,
  ...overrides,
});

describe("VenueLineupTimeline", () => {
  afterEach(cleanup);

  it("renders the fallback row when there are no slots", () => {
    const { getByText } = render(() => <VenueLineupTimeline slots={[]} timezone="UTC" />);
    expect(getByText(/Lineup to be announced/i)).toBeTruthy();
  });

  it("formats slot times in the venue's timezone, not the host's", () => {
    // 22:00 UTC → 23:00 in London (BST in June). If the component
    // accidentally falls back to host time the test box (likely UTC)
    // would print "22:00" instead.
    const { getByText } = render(() => (
      <VenueLineupTimeline
        slots={[
          slot({
            slotStart: "2030-06-07T22:00:00.000Z",
            slotEnd: "2030-06-07T23:00:00.000Z",
          }),
        ]}
        timezone="Europe/London"
      />
    ));
    expect(getByText("23:00")).toBeTruthy();
    expect(getByText("00:00")).toBeTruthy();
  });

  it("flags the headliner with a distinct role label and weight", () => {
    const { getByText } = render(() => (
      <VenueLineupTimeline
        slots={[
          slot({ id: "a", artistName: "Mara", role: "resident" }),
          slot({ id: "b", artistName: "Anu", role: "headliner" }),
        ]}
        timezone="UTC"
      />
    ));
    expect(getByText("Headliner")).toBeTruthy();
    expect(getByText("Resident")).toBeTruthy();
    const headliner = getByText("Anu");
    expect(headliner.className).toContain("font-semibold");
  });

  it("renders the heading when provided", () => {
    const { getByText } = render(() => (
      <VenueLineupTimeline slots={[slot({})]} timezone="UTC" heading="Friday Residency" />
    ));
    expect(getByText("Friday Residency")).toBeTruthy();
  });
});
