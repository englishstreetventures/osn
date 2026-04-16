import { render as _baseRender, cleanup, fireEvent } from "@solidjs/testing-library";
// @vitest-environment happy-dom
import type { JSX } from "solid-js";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { EventList } from "../../src/components/EventList";
import { setShowCreateForm } from "../../src/lib/createEventSignal";
import { wrapRouter } from "../helpers/router";

// EventList renders <EventCard> (which uses `<A>`) and itself uses `<A>`
// for the Settings link, so it needs a Router context. Wrap render once
// so the existing test bodies stay unchanged.
const render: typeof _baseRender = ((factory: () => JSX.Element) =>
  _baseRender(wrapRouter(factory))) as unknown as typeof _baseRender;

vi.mock("solid-toast", async () => {
  const { solidToastMock } = await import("../helpers/toast");
  return solidToastMock();
});
import { mockToastError, mockToastSuccess } from "../helpers/toast";

const mockLogin = vi.fn();
const mockLogout = vi.fn();
let mockSession: () => { accessToken: string } | null = () => null;

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    session: () => mockSession(),
    login: mockLogin,
    logout: mockLogout,
    profiles: () => [
      {
        id: "usr_test",
        handle: "test",
        email: "test@example.com",
        displayName: null,
        avatarUrl: null,
      },
    ],
    activeProfileId: () => "usr_test",
    switchProfile: vi.fn(),
    deleteProfile: vi.fn(),
    createProfile: vi.fn(),
  }),
}));

const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockPost = vi.fn();
vi.mock("../../src/lib/api", () => ({
  api: {
    events: Object.assign(
      ({ id }: { id: string }) => ({ delete: (...args: unknown[]) => mockDelete(id, ...args) }),
      {
        get: (...args: unknown[]) => mockGet(...args),
        post: (...args: unknown[]) => mockPost(...args),
      },
    ),
  },
}));

vi.mock("../../src/lib/authClients", () => ({
  registrationClient: {
    checkHandle: vi.fn(),
    beginRegistration: vi.fn(),
    completeRegistration: vi.fn(),
  },
  loginClient: {
    otpBegin: vi.fn(),
    otpComplete: vi.fn(),
    passkeyBegin: vi.fn(),
    magicBegin: vi.fn(),
  },
}));

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => false,
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

describe("EventList — unauthenticated", () => {
  beforeEach(() => {
    mockSession = () => null;
    mockGet.mockReset();
    mockLogin.mockReset();
    mockLogout.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows 'Loading events…' initially (while mockGet is pending)", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { getByText } = render(() => <EventList />);
    expect(getByText("Loading events…")).toBeTruthy();
  });

  it("shows 'Failed to load events.' when mockGet resolves with an error", async () => {
    // Resolve with an error object — fetchEvents checks `if (error) throw error`
    // which causes createResource to set events.error. This avoids an unhandled
    // rejection race before SolidJS can catch it.
    mockGet.mockResolvedValue({ data: null, error: new Error("network error") });
    const { findByText } = render(() => <EventList />);
    expect(await findByText("Failed to load events.")).toBeTruthy();
  });

  it("shows 'No upcoming events.' when mockGet resolves empty list", async () => {
    mockGet.mockResolvedValue({ data: { events: [] }, error: null });
    const { findByText } = render(() => <EventList />);
    expect(await findByText("No upcoming events.")).toBeTruthy();
  });

  it("renders event cards when mockGet resolves with events", async () => {
    mockGet.mockResolvedValue({
      data: {
        events: [
          {
            id: "evt_1",
            title: "First Event",
            status: "upcoming",
            startTime: "2030-06-01T10:00:00.000Z",
          },
          {
            id: "evt_2",
            title: "Second Event",
            status: "upcoming",
            startTime: "2030-06-02T10:00:00.000Z",
          },
        ],
      },
      error: null,
    });
    const { findByText } = render(() => <EventList />);
    expect(await findByText("First Event")).toBeTruthy();
    expect(await findByText("Second Event")).toBeTruthy();
  });

  // Auth buttons (Sign in, Create account) and header UI moved to Header component.
  // See Header.test.tsx for those tests.
});

// A minimal fake JWT with a decodable payload — no signature verification in client code.
const FAKE_JWT = `header.${btoa(JSON.stringify({ sub: "usr_test", email: "test@example.com" }))}.sig`;

describe("EventList — authenticated", () => {
  beforeEach(() => {
    mockSession = () => ({ accessToken: FAKE_JWT });
    mockGet.mockReset();
    mockLogin.mockReset();
    mockLogout.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    setShowCreateForm(false);
    cleanup();
    vi.unstubAllGlobals();
  });

  // Auth buttons (New Event, Sign out) moved to Header component.
  // See Header.test.tsx for those tests.

  it("shows create form when showCreateForm signal is true", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    setShowCreateForm(true);
    const { getByText } = render(() => <EventList />);
    expect(getByText("Create")).toBeTruthy();
    setShowCreateForm(false);
  });

  it("delete button on event card → calls api.events delete with event id and shows success toast", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mockGet.mockResolvedValue({
      data: {
        events: [
          {
            id: "evt_del",
            title: "Delete Me",
            status: "upcoming",
            startTime: "2030-06-01T10:00:00.000Z",
            createdByProfileId: "usr_test",
          },
        ],
      },
      error: null,
    });
    mockDelete.mockResolvedValue({});

    const { findByText, getByText } = render(() => <EventList />);
    await findByText("Delete Me");
    fireEvent.click(getByText("Delete"));
    expect(mockDelete).toHaveBeenCalledWith(
      "evt_del",
      undefined,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(mockToastSuccess).toHaveBeenCalledWith("Event deleted");
  });

  it("failed delete → toast.error called (catch branch)", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    mockGet.mockResolvedValue({
      data: {
        events: [
          {
            id: "evt_err",
            title: "Fail Delete",
            status: "upcoming",
            startTime: "2030-06-01T10:00:00.000Z",
            createdByProfileId: "usr_test",
          },
        ],
      },
      error: null,
    });
    mockDelete.mockRejectedValue(new Error("delete failed"));

    const { findByText, getByText } = render(() => <EventList />);
    await findByText("Fail Delete");
    fireEvent.click(getByText("Delete"));
    // Flush microtasks so the rejected promise reaches the catch handler
    await Promise.resolve();
    await Promise.resolve();
    expect(mockToastError).toHaveBeenCalledWith("Failed to delete event");
  });

  it("successful form submit hides the form and shows success toast", async () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    mockPost.mockResolvedValue({ error: null });

    setShowCreateForm(true);

    const { getByText, queryByText } = render(() => <EventList />);
    expect(getByText("Create")).toBeTruthy();

    const form = getByText("Create").closest("form")!;
    const titleInput = form.querySelector("#title") as HTMLInputElement;
    const startInput = form.querySelector("#startTime") as HTMLInputElement;
    fireEvent.input(titleInput, { target: { value: "My Event" } });
    fireEvent.input(startInput, { target: { value: "2030-06-01T10:00" } });
    fireEvent.submit(form);

    await Promise.resolve();
    await Promise.resolve();

    expect(queryByText("Create")).toBeNull();
    expect(mockToastSuccess).toHaveBeenCalledWith("Event created");
  });
});
