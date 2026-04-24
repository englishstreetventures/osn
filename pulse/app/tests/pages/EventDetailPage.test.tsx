// @vitest-environment happy-dom
import { cleanup, render as _baseRender, waitFor } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapRouter } from "../helpers/router";

// Stable params for every render — the page uses `useParams<{id}>()`.
// `wrapRouter` mounts a MemoryRouter that doesn't drive a specific path,
// so we mock @solidjs/router here to inject the event id.
vi.mock("@solidjs/router", async () => {
  const actual = await vi.importActual<typeof import("@solidjs/router")>("@solidjs/router");
  return { ...actual, useParams: () => ({ id: "evt_1" }) };
});

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ session: () => null, profiles: () => null, createProfile: vi.fn() }),
}));

// Sub-components pulled in by the page — stub them to simple markers so
// the test focuses on the header card + price badge.
vi.mock("../../src/components/AddToCalendarButton", () => ({
  AddToCalendarButton: () => <div data-testid="cal-stub" />,
}));
vi.mock("../../src/components/CommsSummary", () => ({
  CommsSummary: () => <div data-testid="comms-stub" />,
}));
vi.mock("../../src/components/EventChatPlaceholder", () => ({
  EventChatPlaceholder: () => <div data-testid="chat-stub" />,
}));
vi.mock("../../src/components/MapPreview", () => ({
  MapPreview: () => <div data-testid="map-stub" />,
}));
vi.mock("../../src/components/RsvpSection", () => ({
  RsvpSection: () => <div data-testid="rsvp-stub" />,
}));
vi.mock("../../src/lib/rsvps", () => ({ apiBaseUrl: "http://localhost:3001" }));

type EventShape = {
  id: string;
  title: string;
  status: "upcoming" | "ongoing" | "finished" | "cancelled";
  startTime: string;
  priceAmount: number | null;
  priceCurrency: string | null;
  visibility?: "public" | "private";
  category?: string | null;
};

const mockGet = vi.fn();
vi.mock("../../src/lib/api", () => ({
  api: {
    events: (_params: { id: string }) => ({
      get: (...args: unknown[]) => mockGet(...args),
    }),
  },
}));

import { EventDetailPage } from "../../src/pages/EventDetailPage";

const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

function makeEvent(overrides: Partial<EventShape>): EventShape {
  return {
    id: "evt_1",
    title: "Event",
    status: "upcoming",
    startTime: "2030-06-01T10:00:00.000Z",
    priceAmount: null,
    priceCurrency: null,
    ...overrides,
  };
}

describe("EventDetailPage price badge", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders 'Free' when priceAmount is null", async () => {
    mockGet.mockResolvedValue({
      data: { event: makeEvent({ priceAmount: null, priceCurrency: null }) },
      error: null,
    });
    const { findByText } = render(() => <EventDetailPage />);
    expect(await findByText("Free")).toBeTruthy();
  });

  it("renders 'Free' when priceAmount is 0", async () => {
    mockGet.mockResolvedValue({
      data: { event: makeEvent({ priceAmount: 0, priceCurrency: "USD" }) },
      error: null,
    });
    const { findByText } = render(() => <EventDetailPage />);
    expect(await findByText("Free")).toBeTruthy();
  });

  it("renders formatted USD price from minor units", async () => {
    mockGet.mockResolvedValue({
      data: { event: makeEvent({ priceAmount: 1850, priceCurrency: "USD" }) },
      error: null,
    });
    const { findByText } = render(() => <EventDetailPage />);
    expect(await findByText(/\$18\.50/)).toBeTruthy();
  });

  it("shows 'Event not found' when API returns error", async () => {
    mockGet.mockResolvedValue({ data: null, error: new Error("fail") });
    const { findByText } = render(() => <EventDetailPage />);
    await waitFor(() => {
      expect(findByText(/Event not found/)).toBeTruthy();
    });
  });
});
