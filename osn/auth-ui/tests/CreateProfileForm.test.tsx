// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => {
  return {
    createProfile: vi.fn(),
  };
});

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    createProfile: hoisted.createProfile,
  }),
}));

vi.mock("@shared/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "@shared/toast";

import { CreateProfileForm } from "../src/CreateProfileForm";
import { DETAILS, WAIT, alertsText, apiError } from "./helpers/errors";

describe("CreateProfileForm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.createProfile.mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("sanitises handle input: lowercases and strips invalid chars", () => {
    render(() => <CreateProfileForm />);
    const input = screen.getByLabelText(/Handle/) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "Alice WONDERLAND!" } });
    expect(input.value).toBe("alicewonderland");
  });

  it("shows validation error for handles exceeding 30 chars", () => {
    render(() => <CreateProfileForm />);
    const input = screen.getByLabelText(/Handle/) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "a".repeat(31) } });
    expect(screen.getByText(/1-30 chars/)).toBeTruthy();
  });

  describe("without checkHandle prop", () => {
    it("submit button enabled when handle passes local validation", () => {
      render(() => <CreateProfileForm />);
      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "alice" } });
      const submit = screen.getByRole("button", { name: /Create profile/i }) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
    });

    it("submit button disabled when handle is empty", () => {
      render(() => <CreateProfileForm />);
      const submit = screen.getByRole("button", { name: /Create profile/i }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
    });
  });

  describe("with checkHandle prop", () => {
    let mockCheckHandle: ReturnType<
      typeof vi.fn<(handle: string, signal?: AbortSignal) => Promise<{ available: boolean }>>
    >;

    beforeEach(() => {
      mockCheckHandle =
        vi.fn<(handle: string, signal?: AbortSignal) => Promise<{ available: boolean }>>();
    });

    it("debounces availability check and shows 'available'", async () => {
      mockCheckHandle.mockResolvedValue({ available: true });
      render(() => <CreateProfileForm checkHandle={mockCheckHandle} />);

      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "alice" } });
      expect(screen.getByText(/Checking/)).toBeTruthy();
      expect(mockCheckHandle).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/@alice is available/)).toBeTruthy();
      });
      expect(mockCheckHandle).toHaveBeenCalledWith("alice", expect.any(AbortSignal));
    });

    it("aborts the previous in-flight check before issuing a new one (P-W10)", async () => {
      mockCheckHandle.mockImplementation(() => new Promise(() => {}));
      render(() => <CreateProfileForm checkHandle={mockCheckHandle} />);

      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "ali" } });
      await vi.advanceTimersByTimeAsync(350);
      expect(mockCheckHandle).toHaveBeenCalledTimes(1);
      const firstSignal = mockCheckHandle.mock.calls[0][1]!;
      expect(firstSignal.aborted).toBe(false);

      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "alice" } });
      await vi.advanceTimersByTimeAsync(350);
      expect(mockCheckHandle).toHaveBeenCalledTimes(2);
      expect(firstSignal.aborted).toBe(true);
      expect(mockCheckHandle.mock.calls[1][1]!.aborted).toBe(false);
    });

    it("shows 'taken' when server reports unavailable", async () => {
      mockCheckHandle.mockResolvedValue({ available: false });
      render(() => <CreateProfileForm checkHandle={mockCheckHandle} />);

      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "taken" } });
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/@taken is taken/)).toBeTruthy();
      });
    });

    it("shows network error when checkHandle throws", async () => {
      mockCheckHandle.mockRejectedValue(new Error("network down"));
      render(() => <CreateProfileForm checkHandle={mockCheckHandle} />);

      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "alice" } });
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/Couldn.t check availability/)).toBeTruthy();
      });
    });

    it("submit disabled while handle status is 'checking'", () => {
      mockCheckHandle.mockImplementation(() => new Promise(() => {}));
      render(() => <CreateProfileForm checkHandle={mockCheckHandle} />);

      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "alice" } });
      const submit = screen.getByRole("button", { name: /Create profile/i }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
    });

    it("submit enabled once handle is available", async () => {
      mockCheckHandle.mockResolvedValue({ available: true });
      render(() => <CreateProfileForm checkHandle={mockCheckHandle} />);

      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "alice" } });
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        const submit = screen.getByRole("button", { name: /Create profile/i }) as HTMLButtonElement;
        expect(submit.disabled).toBe(false);
      });
    });

    it("submit disabled when handle is taken", async () => {
      mockCheckHandle.mockResolvedValue({ available: false });
      render(() => <CreateProfileForm checkHandle={mockCheckHandle} />);

      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "taken" } });
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        const submit = screen.getByRole("button", { name: /Create profile/i }) as HTMLButtonElement;
        expect(submit.disabled).toBe(true);
      });
    });
  });

  it("calls createProfile with handle and optional displayName on submit", async () => {
    hoisted.createProfile.mockResolvedValue({
      id: "p_1",
      handle: "alice",
      email: "a@b.com",
      displayName: "Alice",
      avatarUrl: null,
    });

    const onSuccess = vi.fn();
    render(() => <CreateProfileForm onSuccess={onSuccess} />);

    fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "alice" } });
    fireEvent.input(screen.getByLabelText(/Display name/), { target: { value: "Alice" } });
    fireEvent.click(screen.getByRole("button", { name: /Create profile/i }));

    await waitFor(() => {
      expect(hoisted.createProfile).toHaveBeenCalledWith("alice", "Alice");
    });
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p_1", handle: "alice" }),
      );
    });
    expect(toast.success).toHaveBeenCalledWith("Profile @alice created");
  });

  it.each([
    ["a refusal", apiError("PLANTED Handle taken"), DETAILS, "true"],
    ["a 429", apiError("PLANTED-429", 429, "rate_limited"), WAIT, null],
  ])(
    "shows %s inline, tied to the handle, and raises no error toast",
    async (_, error, sentence, invalid) => {
      hoisted.createProfile.mockRejectedValue(error);

      render(() => <CreateProfileForm />);
      fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "taken" } });
      fireEvent.click(screen.getByRole("button", { name: /Create profile/i }));

      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(sentence));
      const alert = screen.getByRole("alert");
      expect(alertsText()).not.toContain("PLANTED");
      expect(toast.error).not.toHaveBeenCalled();
      const field = screen.getByLabelText(/Handle/);
      expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
      expect(field.getAttribute("aria-invalid")).toBe(invalid);
      // Above the submit, so it is read before the button again.
      const submit = screen.getByRole("button", { name: /Create profile/i });
      expect(alert.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    },
  );

  // Create holds focus through the wait: `busy`, not `disabled`; Cancel waits too.
  it("keeps Create profile busy, not disabled, while it creates", async () => {
    hoisted.createProfile.mockReturnValue(new Promise(() => {}));
    render(() => <CreateProfileForm onCancel={vi.fn()} />);
    fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "alice" } });
    fireEvent.click(screen.getByRole("button", { name: /Create profile/i }));
    await vi.advanceTimersByTimeAsync(0);
    const creating = screen.getByRole("button", { name: "Creating…" }) as HTMLButtonElement;
    expect(creating.getAttribute("aria-busy")).toBe("true");
    expect(creating.disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(creating);
    await vi.advanceTimersByTimeAsync(0);
    expect(hoisted.createProfile).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(() => <CreateProfileForm onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("omits displayName when blank", async () => {
    hoisted.createProfile.mockResolvedValue({
      id: "p_2",
      handle: "bob",
      email: "b@b.com",
      displayName: null,
      avatarUrl: null,
    });

    render(() => <CreateProfileForm />);
    fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: /Create profile/i }));

    await waitFor(() => {
      expect(hoisted.createProfile).toHaveBeenCalledWith("bob", undefined);
    });
  });
});
