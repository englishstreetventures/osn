// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Register.tsx is the consumer of the entire registration flow. It
 * orchestrates input sanitisation, debounced handle availability, the
 * details/verify/passkey/done step machine, the WebAuthn auto-skip branch,
 * and the adoptSession hand-off. None of those is covered anywhere else.
 *
 * Strategy: inject a stub RegistrationClient directly via the `client` prop,
 * mock @osn/client/solid (useAuth → adoptSession spy), and mock
 * @simplewebauthn/browser (toggleable support flag). The WebAuthn mock is
 * hoisted via vi.hoisted() so tests can flip `webauthnSupported` between
 * renders before the component imports it.
 */

const hoisted = vi.hoisted(() => {
  return {
    webauthnSupported: true,
    adoptSession: vi.fn(),
    startRegistration: vi.fn(),
  };
});

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

import type { RegistrationClient } from "@osn/client";

// Import after mocks so the component picks them up.
import { Register } from "../../src/auth/Register";

interface ClientStub {
  checkHandle: ReturnType<typeof vi.fn>;
  beginRegistration: ReturnType<typeof vi.fn>;
  completeRegistration: ReturnType<typeof vi.fn>;
  passkeyRegisterBegin: ReturnType<typeof vi.fn>;
  passkeyRegisterComplete: ReturnType<typeof vi.fn>;
}

function makeClientStub(): ClientStub {
  return {
    checkHandle: vi.fn(),
    beginRegistration: vi.fn(),
    completeRegistration: vi.fn(),
    passkeyRegisterBegin: vi.fn(),
    passkeyRegisterComplete: vi.fn(),
  };
}

// Cast site: the stub shape intentionally loosens RegistrationClient's
// precise function signatures (each method is a plain vi.fn) so tests can
// mock return values without dealing with mock-type gymnastics. The
// component only ever reads from `props.client`, so the runtime shape is
// all that matters.
const asClient = (s: ClientStub): RegistrationClient => s as unknown as RegistrationClient;

let stub: ClientStub;

const sampleSession = {
  accessToken: "acc_x",
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
    stub = makeClientStub();
    hoisted.adoptSession.mockReset();
    hoisted.startRegistration.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  describe("details step", () => {
    it("sanitises handle input: lowercases and strips invalid chars", () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
      const input = fillHandle("Alice WONDERLAND!");
      expect(input.value).toBe("alicewonderland");
    });

    it("flags handle as invalid format synchronously, no fetch", () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
      // Empty after sanitisation? No — we want a string that survives
      // sanitisation but fails HANDLE_RE. The sanitiser strips everything
      // except [a-z0-9_], so any input that survives is by construction valid.
      // Instead, drive the "invalid" branch via length: > 30 chars.
      fillHandle("a".repeat(31));
      expect(screen.getByText(/1.30 chars/)).toBeTruthy();
      expect(stub.checkHandle).not.toHaveBeenCalled();
    });

    it("debounces availability check and shows 'available'", async () => {
      stub.checkHandle.mockResolvedValue({ available: true });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
      fillHandle("alice");
      // Synchronously transitions to "checking".
      expect(screen.getByText(/Checking/)).toBeTruthy();
      expect(stub.checkHandle).not.toHaveBeenCalled();

      // Advance past the 300ms debounce.
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/@alice is available/)).toBeTruthy();
      });
      expect(stub.checkHandle).toHaveBeenCalledWith("alice");
    });

    it("shows 'taken' when the server reports unavailable", async () => {
      stub.checkHandle.mockResolvedValue({ available: false });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
      fillHandle("taken");
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/@taken is taken/)).toBeTruthy();
      });
    });

    it("shows a network error (not a format error) when checkHandle throws", async () => {
      // Regression: a thrown checkHandle used to flip the status to "invalid",
      // which rendered the "1–30 chars…" format error even though the user's
      // input was perfectly valid. Network/server failures must surface
      // separately so the user isn't told their handle is the wrong shape.
      stub.checkHandle.mockRejectedValue(new Error("network down"));
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
      fillHandle("alice");
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/Couldn.t check availability/)).toBeTruthy();
      });
      expect(screen.queryByText(/1.30 chars/)).toBeNull();
    });

    it("submit is disabled while handle status is 'checking'", () => {
      stub.checkHandle.mockImplementation(
        () => new Promise(() => {}), // never resolves
      );
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
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
      stub.checkHandle.mockResolvedValue({ available: true });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
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
      stub.checkHandle.mockResolvedValue({ available: true });
      stub.beginRegistration.mockResolvedValue({ sent: true });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
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

    /** Type digits into the individual OTP boxes. */
    function fillOtpDigits(digits: string) {
      for (let i = 0; i < digits.length && i < 6; i++) {
        const input = screen.getByLabelText(`Digit ${i + 1}`) as HTMLInputElement;
        fireEvent.input(input, { target: { value: digits[i] } });
      }
    }

    it("calls beginRegistration with the form values and advances to verify", async () => {
      await advanceToVerify();
      expect(stub.beginRegistration).toHaveBeenCalledWith({
        email: "alice@example.com",
        handle: "alice",
        displayName: undefined,
      });
    });

    it("submit stays disabled until 6 digits are entered, then enables", async () => {
      await advanceToVerify();
      fillOtpDigits("123");
      const submit = screen.getByRole("button", {
        name: /Verify email/i,
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);

      fillOtpDigits("123456");
      expect(submit.disabled).toBe(false);
    });

    it("OTP input rejects non-digit characters", async () => {
      stub.completeRegistration.mockResolvedValue({
        profileId: "usr_abc",
        session: sampleSession,
      });
      await advanceToVerify();
      // Type non-digits into each box — completeRegistration should never fire.
      for (let i = 0; i < 6; i++) {
        const input = screen.getByLabelText(`Digit ${i + 1}`) as HTMLInputElement;
        fireEvent.input(input, { target: { value: "a" } });
      }
      expect(stub.completeRegistration).not.toHaveBeenCalled();
    });
  });

  describe("passkey step (mandatory)", () => {
    function fillOtpDigits(digits: string) {
      for (let i = 0; i < digits.length && i < 6; i++) {
        const input = screen.getByLabelText(`Digit ${i + 1}`) as HTMLInputElement;
        fireEvent.input(input, { target: { value: digits[i] } });
      }
    }

    async function reachPasskey() {
      stub.checkHandle.mockResolvedValue({ available: true });
      stub.beginRegistration.mockResolvedValue({ sent: true });
      stub.completeRegistration.mockResolvedValue({
        profileId: "usr_abc",
        handle: "alice",
        email: "alice@example.com",
        session: sampleSession,
      });
      hoisted.adoptSession.mockResolvedValue(undefined);
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      await vi.advanceTimersByTimeAsync(350);
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/i }));
      await waitFor(() => screen.getByLabelText("Digit 1"));
      fillOtpDigits("123456");
      fireEvent.click(screen.getByRole("button", { name: /Verify email/i }));
      await waitFor(() => screen.getByRole("button", { name: /Enroll credential/i }));
    }

    it("adopts the session immediately after OTP verify so the access token can drive enrollment", async () => {
      await reachPasskey();
      expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      expect(stub.passkeyRegisterBegin).not.toHaveBeenCalled();
    });

    it("happy path: enrolls a WebAuthn credential using the freshly-issued access token", async () => {
      await reachPasskey();
      stub.passkeyRegisterBegin.mockResolvedValue({ challenge: "ch" });
      hoisted.startRegistration.mockResolvedValue({ id: "cred", rawId: "raw" });
      stub.passkeyRegisterComplete.mockResolvedValue({ passkeyId: "pk_1" });

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(stub.passkeyRegisterComplete).toHaveBeenCalled();
      });
      expect(stub.passkeyRegisterBegin).toHaveBeenCalledWith({
        profileId: "usr_abc",
        accessToken: sampleSession.accessToken,
      });
      expect(hoisted.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: "ch" } });
      expect(stub.passkeyRegisterComplete).toHaveBeenCalledWith({
        profileId: "usr_abc",
        accessToken: sampleSession.accessToken,
        attestation: { id: "cred", rawId: "raw" },
      });
    });

    it("there is no 'Skip' button — enrollment is required to finish the flow", async () => {
      await reachPasskey();
      expect(screen.queryByRole("button", { name: /Skip/i })).toBeNull();
    });
  });

  describe("WebAuthn-unsupported environment", () => {
    it("blocks the flow at the start with an informational screen", async () => {
      hoisted.webauthnSupported = false;
      render(() => <Register client={asClient(stub)} onCancel={() => {}} />);
      // No form fields render; only the fallback copy.
      expect(screen.queryByLabelText(/Email/)).toBeNull();
      expect(screen.getByText(/needs a passkey or security key/i)).toBeTruthy();
      expect(stub.beginRegistration).not.toHaveBeenCalled();
    });
  });

  it("Cancel button calls onCancel", () => {
    const onCancel = vi.fn();
    render(() => <Register client={asClient(stub)} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
