import type { EventItem } from "../../src/lib/types";

/**
 * A complete `EventItem`, so tests can name only the fields they assert on.
 *
 * `EventItem` is derived from the Eden treaty response type, which carries
 * every column of the events table. A partial literal type-checks nowhere,
 * and before `tests/` was inside `tsconfig.json`'s `include` nothing caught
 * that — the fixtures here were missing 25 fields each.
 */
const BASE_EVENT: EventItem = {
  id: "evt_1",
  title: "Test Event",
  description: null,
  location: null,
  venue: null,
  venueId: null,
  latitude: null,
  longitude: null,
  category: null,
  startTime: "2030-06-01T10:00:00.000Z",
  endTime: null,
  status: "upcoming",
  imageUrl: null,
  priceAmount: null,
  priceCurrency: null,
  visibility: "public",
  guestListVisibility: "public",
  joinPolicy: "open",
  allowInterested: true,
  commsChannels: '["email"]',
  chatId: null,
  seriesId: null,
  instanceOverride: false,
  createdByProfileId: "prof_1",
  createdByName: null,
  createdByAvatar: null,
  cancelledAt: null,
  hardDeleteAt: null,
  cancellationReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export function makeEvent(overrides: Partial<EventItem> = {}): EventItem {
  return { ...BASE_EVENT, ...overrides };
}
