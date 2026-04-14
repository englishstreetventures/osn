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

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "solid-toast";

import { CreateProfileForm } from "../../src/auth/CreateProfileForm";

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
      typeof vi.fn<(handle: string) => Promise<{ available: boolean }>>
    >;

    beforeEach(() => {
      mockCheckHandle = vi.fn<(handle: string) => Promise<{ available: boolean }>>();
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
      expect(mockCheckHandle).toHaveBeenCalledWith("alice");
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

  it("shows error toast on createProfile failure", async () => {
    hoisted.createProfile.mockRejectedValue(new Error("Handle taken"));

    render(() => <CreateProfileForm />);
    fireEvent.input(screen.getByLabelText(/Handle/), { target: { value: "taken" } });
    fireEvent.click(screen.getByRole("button", { name: /Create profile/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Handle taken");
    });
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
