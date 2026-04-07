// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * T-R1: Register.tsx is the consumer of the entire registration flow. It
 * orchestrates input sanitisation, debounced handle availability, the
 * details/verify/passkey/done step machine, the WebAuthn auto-skip branch,
 * and the adoptSession hand-off. None of those is covered anywhere else.
 *
 * Strategy: mock @osn/client (createRegistrationClient), @osn/client/solid
 * (useAuth → adoptSession spy), and @simplewebauthn/browser (toggleable
 * support flag). The mocks are hoisted via vi.hoisted() so we can flip
 * `webauthnSupported` between tests before importing the component.
 */

const hoisted = vi.hoisted(() => {
  return {
    webauthnSupported: true,
    stub: {
      checkHandle: vi.fn(),
      beginRegistration: vi.fn(),
      completeRegistration: vi.fn(),
      passkeyRegisterBegin: vi.fn(),
      passkeyRegisterComplete: vi.fn(),
    },
    adoptSession: vi.fn(),
    startRegistration: vi.fn(),
  };
});

vi.mock("@osn/client", () => ({
  createRegistrationClient: () => hoisted.stub,
  RegistrationError: class RegistrationError extends Error {},
}));

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    adoptSession: hoisted.adoptSession,
  }),
}));

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => hoisted.webauthnSupported,
  startRegistration: hoisted.startRegistration,
}));

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/auth", () => ({
  OSN_ISSUER_URL: "https://osn.test",
  REDIRECT_URI: () => "http://localhost/callback",
}));

// Import after mocks so the component picks them up.
import { Register } from "../../src/components/Register";

const sampleSession = {
  accessToken: "acc_x",
  refreshToken: null,
  idToken: null,
  expiresAt: Date.now() + 60_000,
  scopes: [],
};

function fillEmail(value: string) {
  const input = screen.getByLabelText(/Email/) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
}

function fillHandle(value: string) {
  const input = screen.getByLabelText(/Handle/) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  return input;
}

describe("Register component", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hoisted.webauthnSupported = true;
    hoisted.stub.checkHandle.mockReset();
    hoisted.stub.beginRegistration.mockReset();
    hoisted.stub.completeRegistration.mockReset();
    hoisted.stub.passkeyRegisterBegin.mockReset();
    hoisted.stub.passkeyRegisterComplete.mockReset();
    hoisted.adoptSession.mockReset();
    hoisted.startRegistration.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  describe("details step", () => {
    it("sanitises handle input: lowercases and strips invalid chars", () => {
      render(() => <Register onCancel={() => {}} />);
      const input = fillHandle("Alice WONDERLAND!");
      expect(input.value).toBe("alicewonderland");
    });

    it("flags handle as invalid format synchronously, no fetch", () => {
      render(() => <Register onCancel={() => {}} />);
      // Empty after sanitisation? No — we want a string that survives
      // sanitisation but fails HANDLE_RE. The sanitiser strips everything
      // except [a-z0-9_], so any input that survives is by construction valid.
      // Instead, drive the "invalid" branch via length: > 30 chars.
      fillHandle("a".repeat(31));
      expect(screen.getByText(/1.30 chars/)).toBeTruthy();
      expect(hoisted.stub.checkHandle).not.toHaveBeenCalled();
    });

    it("debounces availability check and shows 'available'", async () => {
      hoisted.stub.checkHandle.mockResolvedValue({ available: true });
      render(() => <Register onCancel={() => {}} />);
      fillHandle("alice");
      // Synchronously transitions to "checking".
      expect(screen.getByText(/Checking/)).toBeTruthy();
      expect(hoisted.stub.checkHandle).not.toHaveBeenCalled();

      // Advance past the 300ms debounce.
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/@alice is available/)).toBeTruthy();
      });
      expect(hoisted.stub.checkHandle).toHaveBeenCalledWith("alice");
    });

    it("shows 'taken' when the server reports unavailable", async () => {
      hoisted.stub.checkHandle.mockResolvedValue({ available: false });
      render(() => <Register onCancel={() => {}} />);
      fillHandle("taken");
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/@taken is taken/)).toBeTruthy();
      });
    });

    it("submit is disabled while handle status is 'checking'", () => {
      hoisted.stub.checkHandle.mockImplementation(
        () => new Promise(() => {}), // never resolves
      );
      render(() => <Register onCancel={() => {}} />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      // Still "checking" — debounce hasn't fired but the synchronous status
      // change to "checking" is enough to keep detailsValid() false.
      const submit = screen.getByRole("button", {
        name: /Send verification code/i,
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
    });

    it("submit becomes enabled once email + handle are both valid", async () => {
      hoisted.stub.checkHandle.mockResolvedValue({ available: true });
      render(() => <Register onCancel={() => {}} />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        const submit = screen.getByRole("button", {
          name: /Send verification code/i,
        }) as HTMLButtonElement;
        expect(submit.disabled).toBe(false);
      });
    });
  });

  describe("verify step", () => {
    async function advanceToVerify() {
      hoisted.stub.checkHandle.mockResolvedValue({ available: true });
      hoisted.stub.beginRegistration.mockResolvedValue({ sent: true });
      render(() => <Register onCancel={() => {}} />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        const submit = screen.getByRole("button", {
          name: /Send verification code/i,
        }) as HTMLButtonElement;
        expect(submit.disabled).toBe(false);
      });
      const submit = screen.getByRole("button", { name: /Send verification code/i });
      fireEvent.click(submit);
      await waitFor(() => {
        expect(screen.getByText(/We sent a 6-digit code/)).toBeTruthy();
      });
    }

    it("calls beginRegistration with the form values and advances to verify", async () => {
      await advanceToVerify();
      expect(hoisted.stub.beginRegistration).toHaveBeenCalledWith({
        email: "alice@example.com",
        handle: "alice",
        displayName: undefined,
      });
    });

    it("verify submit stays disabled until 6 digits are entered", async () => {
      await advanceToVerify();
      const otp = screen.getByLabelText(/Verification code/) as HTMLInputElement;
      fireEvent.input(otp, { target: { value: "123" } });
      const submit = screen.getByRole("button", {
        name: /Verify email/i,
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);

      fireEvent.input(otp, { target: { value: "123456" } });
      expect(submit.disabled).toBe(false);
    });

    it("OTP input strips non-digits and clamps to 6", async () => {
      await advanceToVerify();
      const otp = screen.getByLabelText(/Verification code/) as HTMLInputElement;
      fireEvent.input(otp, { target: { value: "12ab34cd5678" } });
      expect(otp.value).toBe("123456");
    });
  });

  describe("passkey step (supported)", () => {
    async function reachPasskey() {
      hoisted.stub.checkHandle.mockResolvedValue({ available: true });
      hoisted.stub.beginRegistration.mockResolvedValue({ sent: true });
      hoisted.stub.completeRegistration.mockResolvedValue({
        userId: "usr_abc",
        handle: "alice",
        email: "alice@example.com",
        session: sampleSession,
        enrollmentToken: "enroll_xyz",
      });
      hoisted.adoptSession.mockResolvedValue(undefined);
      render(() => <Register onCancel={() => {}} />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      await vi.advanceTimersByTimeAsync(350);
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/i }));
      await waitFor(() => screen.getByLabelText(/Verification code/));
      fireEvent.input(screen.getByLabelText(/Verification code/), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Verify email/i }));
      await waitFor(() => screen.getByRole("button", { name: /Create passkey/i }));
    }

    it("adopts the session immediately after OTP verify, before any passkey work", async () => {
      await reachPasskey();
      // Crucial: adoptSession was called as soon as the OTP verified, NOT
      // gated on the user clicking "Create passkey". This is the redesign
      // that eliminates the "stranded between verified and logged in" UX
      // dead-end.
      expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      expect(hoisted.stub.passkeyRegisterBegin).not.toHaveBeenCalled();
    });

    it("happy path: enrolls a passkey using the enrollment token", async () => {
      await reachPasskey();
      hoisted.stub.passkeyRegisterBegin.mockResolvedValue({ challenge: "ch" });
      hoisted.startRegistration.mockResolvedValue({ id: "cred", rawId: "raw" });
      hoisted.stub.passkeyRegisterComplete.mockResolvedValue({ passkeyId: "pk_1" });

      fireEvent.click(screen.getByRole("button", { name: /Create passkey/i }));

      await waitFor(() => {
        expect(hoisted.stub.passkeyRegisterComplete).toHaveBeenCalled();
      });
      // Both passkey calls must carry the enrollment token.
      expect(hoisted.stub.passkeyRegisterBegin).toHaveBeenCalledWith({
        userId: "usr_abc",
        enrollmentToken: "enroll_xyz",
      });
      expect(hoisted.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "ch" } });
      expect(hoisted.stub.passkeyRegisterComplete).toHaveBeenCalledWith({
        userId: "usr_abc",
        enrollmentToken: "enroll_xyz",
        attestation: { id: "cred", rawId: "raw" },
      });
    });

    it("'Skip for now' advances to done — user already signed in", async () => {
      await reachPasskey();
      // Reset the call count from reachPasskey() so we only see clicks here.
      hoisted.adoptSession.mockClear();

      fireEvent.click(screen.getByRole("button", { name: /Skip for now/i }));

      // No passkey calls, no second adoptSession (already adopted at OTP step).
      expect(hoisted.stub.passkeyRegisterBegin).not.toHaveBeenCalled();
      expect(hoisted.startRegistration).not.toHaveBeenCalled();
      expect(hoisted.adoptSession).not.toHaveBeenCalled();
    });
  });

  describe("passkey step (unsupported environment)", () => {
    it("submitOtp jumps straight to done; passkey APIs untouched", async () => {
      hoisted.webauthnSupported = false;
      hoisted.stub.checkHandle.mockResolvedValue({ available: true });
      hoisted.stub.beginRegistration.mockResolvedValue({ sent: true });
      hoisted.stub.completeRegistration.mockResolvedValue({
        userId: "usr_abc",
        handle: "alice",
        email: "alice@example.com",
        session: sampleSession,
        enrollmentToken: "enroll_xyz",
      });
      hoisted.adoptSession.mockResolvedValue(undefined);

      render(() => <Register onCancel={() => {}} />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      await vi.advanceTimersByTimeAsync(350);
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/i }));
      await waitFor(() => screen.getByLabelText(/Verification code/));
      fireEvent.input(screen.getByLabelText(/Verification code/), {
        target: { value: "123456" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Verify email/i }));

      // adoptSession is called as part of submitOtp, then we jump to done.
      await waitFor(() => {
        expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      });

      // Crucially, the passkey ceremony APIs were never touched and the
      // "Create passkey" button never appeared in the DOM.
      expect(hoisted.stub.passkeyRegisterBegin).not.toHaveBeenCalled();
      expect(hoisted.startRegistration).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Create passkey/i })).toBeNull();
    });
  });

  it("Cancel button calls onCancel", () => {
    const onCancel = vi.fn();
    render(() => <Register onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
