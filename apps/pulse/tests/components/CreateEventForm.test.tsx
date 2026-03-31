// @vitest-environment happy-dom
import { render, cleanup, fireEvent } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { CreateEventForm } from "../../src/components/CreateEventForm";

vi.mock("solid-toast", async () => {
  const { solidToastMock } = await import("../helpers/toast");
  return solidToastMock();
});
import { mockToastError } from "../helpers/toast";

const mockPost = vi.fn();
vi.mock("../../src/lib/api", () => ({
  api: {
    events: {
      post: (...args: unknown[]) => mockPost(...args),
    },
  },
}));

// LocationInput uses fetch — stub it to a no-op so it doesn't error
vi.stubGlobal(
  "fetch",
  vi.fn(() => new Promise(() => {})),
);

describe("CreateEventForm", () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockToastError.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders title, start time, end time, location, description fields + Cancel/Create buttons", () => {
    const { getByLabelText, getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={() => {}} onCancel={() => {}} />
    ));
    expect(getByLabelText("Title")).toBeTruthy();
    expect(getByLabelText("Start time")).toBeTruthy();
    expect(getByLabelText("End time")).toBeTruthy();
    expect(getByLabelText("Location")).toBeTruthy();
    expect(getByLabelText("Description")).toBeTruthy();
    expect(getByText("Cancel")).toBeTruthy();
    expect(getByText("Create")).toBeTruthy();
  });

  it("Cancel button calls onCancel", () => {
    const onCancel = vi.fn();
    const { getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={() => {}} onCancel={onCancel} />
    ));
    fireEvent.click(getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("end-time error shown when end ≤ start; hidden when end > start", () => {
    const { getByLabelText, queryByText, getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={() => {}} onCancel={() => {}} />
    ));
    const startInput = getByLabelText("Start time") as HTMLInputElement;
    const endInput = getByLabelText("End time") as HTMLInputElement;

    fireEvent.input(startInput, { target: { value: "2030-06-01T12:00" } });
    fireEvent.input(endInput, { target: { value: "2030-06-01T10:00" } });
    expect(getByText("End time must be after start time")).toBeTruthy();

    fireEvent.input(endInput, { target: { value: "2030-06-01T14:00" } });
    expect(queryByText("End time must be after start time")).toBeNull();
  });

  it("submit with end-time error → does NOT call api.events.post", async () => {
    const { getByLabelText, getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={() => {}} onCancel={() => {}} />
    ));
    const startInput = getByLabelText("Start time") as HTMLInputElement;
    const endInput = getByLabelText("End time") as HTMLInputElement;

    fireEvent.input(startInput, { target: { value: "2030-06-01T12:00" } });
    fireEvent.input(endInput, { target: { value: "2030-06-01T10:00" } });

    const form = getByText("Create").closest("form")!;
    fireEvent.submit(form);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("successful submit → calls api.events.post with correct body → calls onSuccess", async () => {
    mockPost.mockResolvedValue({ error: null });
    const onSuccess = vi.fn();
    const { getByLabelText, getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={onSuccess} onCancel={() => {}} />
    ));

    fireEvent.input(getByLabelText("Title"), { target: { value: "My Event" } });
    fireEvent.input(getByLabelText("Start time"), { target: { value: "2030-06-01T10:00" } });

    const form = getByText("Create").closest("form")!;
    fireEvent.submit(form);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockPost).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My Event" }),
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(onSuccess).toHaveBeenCalled();
  });

  it("accessToken present → sets Authorization header in the post call", async () => {
    mockPost.mockResolvedValue({ error: null });
    const { getByLabelText, getByText } = render(() => (
      <CreateEventForm accessToken="tok_123" onSuccess={() => {}} onCancel={() => {}} />
    ));

    fireEvent.input(getByLabelText("Title"), { target: { value: "Event" } });
    fireEvent.input(getByLabelText("Start time"), { target: { value: "2030-06-01T10:00" } });

    fireEvent.submit(getByText("Create").closest("form")!);
    await Promise.resolve();

    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headers: { Authorization: "Bearer tok_123" } }),
    );
  });

  it("accessToken null → no Authorization header", async () => {
    mockPost.mockResolvedValue({ error: null });
    const { getByLabelText, getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={() => {}} onCancel={() => {}} />
    ));

    fireEvent.input(getByLabelText("Title"), { target: { value: "Event" } });
    fireEvent.input(getByLabelText("Start time"), { target: { value: "2030-06-01T10:00" } });

    fireEvent.submit(getByText("Create").closest("form")!);
    await Promise.resolve();

    expect(mockPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headers: {} }),
    );
  });

  it("submit with endTime set → api called with endTime present", async () => {
    mockPost.mockResolvedValue({ error: null });
    const { getByLabelText, getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={() => {}} onCancel={() => {}} />
    ));

    fireEvent.input(getByLabelText("Title"), { target: { value: "Event" } });
    fireEvent.input(getByLabelText("Start time"), { target: { value: "2030-06-01T10:00" } });
    fireEvent.input(getByLabelText("End time"), { target: { value: "2030-06-01T12:00" } });

    fireEvent.submit(getByText("Create").closest("form")!);
    await Promise.resolve();
    await Promise.resolve();

    const [body] = mockPost.mock.calls[0] as [Record<string, unknown>];
    expect(body.endTime).toBeDefined();
  });

  it("API error → does not call onSuccess; calls toast.error", async () => {
    mockPost.mockResolvedValue({ error: new Error("server error") });
    const onSuccess = vi.fn();
    const { getByLabelText, getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={onSuccess} onCancel={() => {}} />
    ));

    fireEvent.input(getByLabelText("Title"), { target: { value: "Event" } });
    fireEvent.input(getByLabelText("Start time"), { target: { value: "2030-06-01T10:00" } });

    fireEvent.submit(getByText("Create").closest("form")!);
    await Promise.resolve();
    await Promise.resolve();

    expect(onSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Failed to create event");
  });

  it("button shows 'Creating…' while mockPost is pending", async () => {
    // Never-resolving promise
    mockPost.mockReturnValue(new Promise(() => {}));
    const { getByLabelText, getByText } = render(() => (
      <CreateEventForm accessToken={null} onSuccess={() => {}} onCancel={() => {}} />
    ));

    fireEvent.input(getByLabelText("Title"), { target: { value: "Event" } });
    fireEvent.input(getByLabelText("Start time"), { target: { value: "2030-06-01T10:00" } });

    fireEvent.submit(getByText("Create").closest("form")!);
    // Flush microtasks so the async handler sets submitting = true
    await Promise.resolve();

    expect(getByText("Creating…")).toBeTruthy();
  });
});
