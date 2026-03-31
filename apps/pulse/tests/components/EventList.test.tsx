// @vitest-environment happy-dom
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventList } from "../../src/components/EventList";

const mockLogin = vi.fn();
const mockLogout = vi.fn();
let mockSession: () => { accessToken: string } | null = () => null;

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    session: () => mockSession(),
    login: mockLogin,
    logout: mockLogout,
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

// auth.ts references window.location.origin — happy-dom provides it, but the
// module is imported at top level, so we just need the env to be ready.

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

  it("shows 'Sign in with OSN' button; no 'New Event' / 'Sign out' buttons", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { getByText, queryByText } = render(() => <EventList />);
    expect(getByText("Sign in with OSN")).toBeTruthy();
    expect(queryByText("New Event")).toBeNull();
    expect(queryByText("Sign out")).toBeNull();
  });
});

describe("EventList — authenticated", () => {
  beforeEach(() => {
    mockSession = () => ({ accessToken: "tok" });
    mockGet.mockReset();
    mockLogin.mockReset();
    mockLogout.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows 'New Event' and 'Sign out' buttons; no 'Sign in' button", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { getByText, queryByText } = render(() => <EventList />);
    expect(getByText("New Event")).toBeTruthy();
    expect(getByText("Sign out")).toBeTruthy();
    expect(queryByText("Sign in with OSN")).toBeNull();
  });

  it("clicking 'New Event' shows the create form; clicking 'Cancel' hides it", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { getByText, queryByText } = render(() => <EventList />);

    // Form not shown initially
    expect(queryByText("Create")).toBeNull();

    // Click "New Event" — button toggles to "Cancel" and form appears
    fireEvent.click(getByText("New Event"));
    expect(getByText("Create")).toBeTruthy();

    // Click the form's Cancel button to dismiss it
    // The header button now reads "Cancel" too — use the form's Cancel button
    const cancelButtons = document.querySelectorAll("button");
    const formCancelBtn = Array.from(cancelButtons).find(
      (b) => b.textContent === "Cancel" && b.type === "button",
    )!;
    fireEvent.click(formCancelBtn);
    expect(queryByText("Create")).toBeNull();
  });

  it("clicking 'Sign out' calls logout", () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    const { getByText } = render(() => <EventList />);
    fireEvent.click(getByText("Sign out"));
    expect(mockLogout).toHaveBeenCalled();
  });

  it("delete button on event card → calls api.events delete with event id", async () => {
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
  });

  it("failed delete → console.error called (catch branch)", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGet.mockResolvedValue({
      data: {
        events: [
          {
            id: "evt_err",
            title: "Fail Delete",
            status: "upcoming",
            startTime: "2030-06-01T10:00:00.000Z",
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
    expect(consoleError).toHaveBeenCalledWith("Failed to delete event:", expect.any(Error));
    consoleError.mockRestore();
  });

  it("successful form submit hides the form (handleFormSuccess)", async () => {
    mockGet.mockReturnValue(new Promise(() => {}));
    mockPost.mockResolvedValue({ error: null });

    const { getByText, queryByText } = render(() => <EventList />);

    fireEvent.click(getByText("New Event"));
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
  });
});
