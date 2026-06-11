// @vitest-environment happy-dom
import { cleanup, render as _baseRender, waitFor } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wrapRouter } from "../helpers/router";

// Stable params for every render — the page uses `useParams<{id}>()`.
// `wrapRouter` mounts a MemoryRouter that doesn't drive a specific path,
// so we mock @solidjs/router here to inject the event id and a mutable
// `useSearchParams` stub that the source-attribution tests configure.
const mockSearchParams: Record<string, string | undefined> = {};
vi.mock("@solidjs/router", async () => {
  const actual = await vi.importActual<typeof import("@solidjs/router")>("@solidjs/router");
  return {
    ...actual,
    useParams: () => ({ id: "evt_1" }),
    useSearchParams: () => [mockSearchParams, vi.fn()],
  };
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
// Capture the props RsvpSection is rendered with so tests can assert that
// `inboundSource` is plumbed through correctly.
const rsvpSectionProps = vi.fn();
vi.mock("../../src/components/RsvpSection", () => ({
  RsvpSection: (props: unknown) => {
    rsvpSectionProps(props);
    return <div data-testid="rsvp-stub" />;
  },
}));
vi.mock("../../src/components/ShareEventButton", () => ({
  ShareEventButton: () => <div data-testid="share-stub" />,
}));
const mockRecordShareExposure = vi.fn(() => Promise.resolve());
vi.mock("../../src/lib/rsvps", () => ({
  apiBaseUrl: "http://localhost:3001",
  recordShareExposure: (...args: unknown[]) => mockRecordShareExposure(...args),
}));

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

describe("EventDetailPage source-attribution wiring", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockRecordShareExposure.mockClear();
    rsvpSectionProps.mockClear();
    for (const key of Object.keys(mockSearchParams)) delete mockSearchParams[key];
    mockGet.mockResolvedValue({
      data: { event: makeEvent({}) },
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not fire an exposure ping when no ?source= is present", async () => {
    const { findByTestId } = render(() => <EventDetailPage />);
    await findByTestId("rsvp-stub");
    expect(mockRecordShareExposure).not.toHaveBeenCalled();
  });

  it("forwards a known inbound source to RsvpSection and fires the exposure ping", async () => {
    mockSearchParams.source = "tiktok";
    const { findByTestId } = render(() => <EventDetailPage />);
    await findByTestId("rsvp-stub");
    await waitFor(() => {
      expect(mockRecordShareExposure).toHaveBeenCalledWith("evt_1", "tiktok", null);
    });
    const lastProps = rsvpSectionProps.mock.calls.at(-1)?.[0] as {
      inboundSource?: string | null;
    };
    expect(lastProps?.inboundSource).toBe("tiktok");
  });

  it("coerces an unknown ?source= value to 'other' so attribution still records", async () => {
    mockSearchParams.source = "myspace";
    const { findByTestId } = render(() => <EventDetailPage />);
    await findByTestId("rsvp-stub");
    await waitFor(() => {
      expect(mockRecordShareExposure).toHaveBeenCalledWith("evt_1", "other", null);
    });
  });

  it("clears inboundSource on the next render when RsvpSection invokes onSourceConsumed", async () => {
    mockSearchParams.source = "instagram";
    const { findByTestId } = render(() => <EventDetailPage />);
    await findByTestId("rsvp-stub");
    const firstCall = rsvpSectionProps.mock.calls.at(-1)?.[0] as {
      inboundSource?: string | null;
      onSourceConsumed?: () => void;
    };
    expect(firstCall?.inboundSource).toBe("instagram");
    firstCall.onSourceConsumed?.();
    await waitFor(() => {
      const latest = rsvpSectionProps.mock.calls.at(-1)?.[0] as {
        inboundSource?: string | null;
      };
      expect(latest?.inboundSource).toBeNull();
    });
  });
});
