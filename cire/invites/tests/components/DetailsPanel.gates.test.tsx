import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventSummary } from "../../src/components/types";

// `hasRunOfShow` and `hasGuestPolicy` are the rule the organiser's Events list
// mirrors (`cire/host/src/lib/invite-emptiness.ts`), so the details panel must
// render the two blocks by them and nothing else. Answering "empty" for an
// event full of both proves it does.
vi.mock("../../src/components/invite-emptiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/components/invite-emptiness")>()),
  hasRunOfShow: () => false,
  hasGuestPolicy: () => false,
}));
vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

import { DetailsPanel } from "../../src/components/DetailsPanel";

const EVENT: EventSummary = {
  id: "evt_1",
  name: "Kitchen Tea",
  description: "High tea on the lawn.",
  startAt: "2026-11-20T16:00:00+11:00",
  endAt: "2026-11-20T18:00:00+11:00",
  timezone: "Australia/Sydney",
  address: "124 Sample Avenue",
  runOfShow: [{ time: "16:00", label: "Tea is poured" }],
  childrenPolicy: "adults_only",
  plusOnePolicy: "by_invitation",
  guestPolicyNote: "Babes in arms are welcome.",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

describe("DetailsPanel's run of show and guest policy blocks", () => {
  afterEach(() => cleanup());

  it("render by the invite-emptiness predicates", () => {
    const { container, queryByText } = render(() => (
      <DetailsPanel event={EVENT} siteUrl="https://invite.example.com/abc" />
    ));
    expect(queryByText("Run of show")).toBeNull();
    expect(queryByText("Guest policy")).toBeNull();
    expect(container.textContent).not.toContain("Tea is poured");
    expect(container.textContent).not.toContain("Adults only");
    // The rest of the sheet is unaffected.
    expect(queryByText("High tea on the lawn.")).not.toBeNull();
  });
});
