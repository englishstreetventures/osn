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
 * mock `@osn/client/solid` (useAuth → adoptSession spy), and mock
 * `@simplewebauthn/browser` (toggleable support flag). The WebAuthn mock is
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

vi.mock("@shared/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import type { RegistrationClient } from "@osn/client";

// Import after mocks so the component picks them up.
import { Register } from "../src/Register";

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

function fillBirthdate(value: string) {
  const input = screen.getByLabelText(/Date of birth/) as HTMLInputElement;
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
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      const input = fillHandle("Alice WONDERLAND!");
      expect(input.value).toBe("alicewonderland");
    });

    it("flags handle as invalid format synchronously, no fetch", () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
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
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      fillHandle("alice");
      // Synchronously transitions to "checking".
      expect(screen.getByText(/Checking/)).toBeTruthy();
      expect(stub.checkHandle).not.toHaveBeenCalled();

      // Advance past the 300ms debounce.
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/@alice is available/)).toBeTruthy();
      });
      expect(stub.checkHandle).toHaveBeenCalledWith("alice", expect.any(AbortSignal));
    });

    it("aborts the previous in-flight check before issuing a new one (P-W10)", async () => {
      stub.checkHandle.mockImplementation(() => new Promise(() => {}));
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      fillHandle("ali");
      await vi.advanceTimersByTimeAsync(350);
      expect(stub.checkHandle).toHaveBeenCalledTimes(1);
      const firstSignal = stub.checkHandle.mock.calls[0][1] as AbortSignal;
      expect(firstSignal.aborted).toBe(false);

      fillHandle("alice");
      await vi.advanceTimersByTimeAsync(350);
      expect(stub.checkHandle).toHaveBeenCalledTimes(2);
      expect(firstSignal.aborted).toBe(true);
      expect((stub.checkHandle.mock.calls[1][1] as AbortSignal).aborted).toBe(false);
    });

    it("shows 'taken' when the server reports unavailable", async () => {
      stub.checkHandle.mockResolvedValue({ available: false });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
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
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
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
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      // Still "checking" — debounce hasn't fired but the synchronous status
      // change to "checking" is enough to keep detailsValid() false.
      const submit = screen.getByRole("button", {
        name: /Send verification code/i,
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
    });

    it("submit becomes enabled once email + handle + birthdate are all valid", async () => {
      stub.checkHandle.mockResolvedValue({ available: true });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      fillBirthdate("1990-01-01");
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        const submit = screen.getByRole("button", {
          name: /Send verification code/i,
        }) as HTMLButtonElement;
        expect(submit.disabled).toBe(false);
      });
    });

    // The client mirrors the server's under-13 gate for immediate
    // feedback — the submit button stays disabled and the copy explains why.
    it("keeps submit disabled and warns for an under-13 birthdate", async () => {
      stub.checkHandle.mockResolvedValue({ available: true });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      const tenYearsAgo = new Date();
      tenYearsAgo.setUTCFullYear(tenYearsAgo.getUTCFullYear() - 10);
      fillBirthdate(tenYearsAgo.toISOString().slice(0, 10));
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        expect(screen.getByText(/13 and older/)).toBeTruthy();
      });
      const submit = screen.getByRole("button", {
        name: /Send verification code/i,
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(stub.beginRegistration).not.toHaveBeenCalled();
    });
  });

  // The address verifies the account, is the emailed-code way back into an
  // account whose passkeys are gone, and receives security notices. The form
  // said none of it, and the recovery job is the one that should steer which
  // address a person types in.
  describe("email explainer", () => {
    it("names the trigger, since a circled glyph announces nothing", () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      const trigger = screen.getByLabelText("What this address is used for");
      expect(trigger.tagName).toBe("BUTTON");
      expect(trigger.textContent).toBe("i");
    });

    it("is a real button that cannot submit the form it sits in", () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      const trigger = screen.getByLabelText("What this address is used for") as HTMLButtonElement;
      expect(trigger.getAttribute("type")).toBe("button");
      expect(trigger.disabled).toBe(false);
      expect(trigger.getAttribute("tabindex")).toBeNull();
    });

    it("gives all three uses of the address, naming the product it was given", async () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Kumiho" />);
      fireEvent.click(screen.getByLabelText("What this address is used for"));

      const panel = await screen.findByRole("dialog");
      expect(panel.textContent).toMatch(/six-digit code/);
      expect(panel.textContent).toMatch(/Kumiho account is not created until you enter it/);
      expect(panel.textContent).toMatch(/lose every device with a passkey/);
      expect(panel.textContent).toMatch(/Security notices/);
    });

    // The form is filled to valid first on purpose. `submitDetails` returns
    // early while the details are invalid, and happy-dom's `requestSubmit`
    // runs `checkValidity()` against three required inputs — so on an empty
    // form a trigger that DID submit would still reach nothing, and this
    // assertion would pass without proving anything.
    it("opening it does not submit the form or advance the step", async () => {
      stub.checkHandle.mockResolvedValue({ available: true });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      fillBirthdate("1990-01-01");
      await vi.advanceTimersByTimeAsync(350);

      const submit = await waitFor(() => {
        const b = screen.getByRole("button", {
          name: /Send verification code/i,
        }) as HTMLButtonElement;
        expect(b.disabled).toBe(false);
        return b;
      });

      fireEvent.click(screen.getByLabelText("What this address is used for"));
      expect(await screen.findByRole("dialog")).toBeTruthy();

      expect(stub.beginRegistration).not.toHaveBeenCalled();
      // Still on the details step: its submit button is the one on screen.
      expect(submit.isConnected).toBe(true);
      expect(screen.queryByText(/Enter it below to verify/)).toBeNull();
    });
  });

  describe("verify step", () => {
    async function advanceToVerify() {
      stub.checkHandle.mockResolvedValue({ available: true });
      stub.beginRegistration.mockResolvedValue({ sent: true });
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      fillEmail("alice@example.com");
      fillHandle("alice");
      fillBirthdate("1990-01-01");
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
        birthdate: "1990-01-01",
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

    // The Resend code button renders the moment the verify step mounts,
    // not only after a wrong code.
    it("renders the Resend code button as soon as the verify step mounts (no error required)", async () => {
      await advanceToVerify();
      expect(screen.getByRole("button", { name: /Resend code/i })).toBeTruthy();
    });

    // Companion guard: the first OTP send must also start the 30s
    // cooldown so the button can't be mashed on arrival. Without this,
    // server-side rate-limit errors would replace the intended UX.
    it("starts the 30s cooldown on the first OTP send and re-enables after it elapses", async () => {
      await advanceToVerify();
      const disabled = screen.getByRole("button", {
        name: /Resend code \(\d+s\)/,
      }) as HTMLButtonElement;
      expect(disabled.disabled).toBe(true);
      await vi.advanceTimersByTimeAsync(31_000);
      await waitFor(() => {
        const ready = screen.getByRole("button", { name: /^Resend code$/ }) as HTMLButtonElement;
        expect(ready.disabled).toBe(false);
      });
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

    async function reachPasskey(extra?: { onSuccess?: () => void }) {
      stub.checkHandle.mockResolvedValue({ available: true });
      stub.beginRegistration.mockResolvedValue({ sent: true });
      stub.completeRegistration.mockResolvedValue({
        profileId: "usr_abc",
        handle: "alice",
        email: "alice@example.com",
        session: sampleSession,
      });
      hoisted.adoptSession.mockResolvedValue(undefined);
      render(() => (
        <Register
          client={asClient(stub)}
          onCancel={() => {}}
          onSuccess={extra?.onSuccess}
          productName="Musubi"
        />
      ));
      fillEmail("alice@example.com");
      fillHandle("alice");
      fillBirthdate("1990-01-01");
      await vi.advanceTimersByTimeAsync(350);
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/i }));
      await waitFor(() => screen.getByLabelText("Digit 1"));
      fillOtpDigits("123456");
      fireEvent.click(screen.getByRole("button", { name: /Verify email/i }));
      await waitFor(() => screen.getByRole("button", { name: /Enroll credential/i }));
    }

    // The passkey step is the whole reason this component holds `accessToken`
    // in a signal: enrollment is authenticated by that explicit bearer token,
    // not by an adopted session. Adopting early published a session to the
    // app while the account still had zero passkeys — and in `@musubi/social`
    // that unmounted the dialog mid-flow, skipping enrollment entirely.
    it("does not adopt the session after OTP verify — enrollment carries its own token", async () => {
      await reachPasskey();
      expect(hoisted.adoptSession).not.toHaveBeenCalled();
      expect(stub.passkeyRegisterBegin).not.toHaveBeenCalled();
    });

    it("adopts the session only once the credential is enrolled", async () => {
      await reachPasskey();
      stub.passkeyRegisterBegin.mockResolvedValue({ challenge: "ch" });
      hoisted.startRegistration.mockResolvedValue({ id: "cred", rawId: "raw" });
      stub.passkeyRegisterComplete.mockResolvedValue({ passkeyId: "pk_1" });

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      });
      expect(stub.passkeyRegisterComplete.mock.invocationCallOrder[0]).toBeLessThan(
        hoisted.adoptSession.mock.invocationCallOrder[0],
      );
    });

    it("leaves the user signed out when enrollment fails", async () => {
      await reachPasskey();
      stub.passkeyRegisterBegin.mockResolvedValue({ challenge: "ch" });
      hoisted.startRegistration.mockRejectedValue(new Error("ceremony cancelled"));

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(screen.getByText(/ceremony cancelled/)).toBeTruthy();
      });
      // No session, so no half-made account signed in behind a dismissed
      // dialog — the user is still on the step that can finish the job.
      expect(hoisted.adoptSession).not.toHaveBeenCalled();
    });

    // `adoptSession` writes the session to `localStorage`, which throws when
    // storage is disabled or full — Safari private mode, quota exceeded. The
    // credential exists by then, so the account is fine; what must not happen
    // is the user being parked on the "done" step, which has no error slot and
    // no retry, while the app still considers them signed out.
    it("stays on the passkey step when adopting the session fails", async () => {
      await reachPasskey();
      stub.passkeyRegisterBegin.mockResolvedValue({ challenge: "ch" });
      hoisted.startRegistration.mockResolvedValue({ id: "cred", rawId: "raw" });
      stub.passkeyRegisterComplete.mockResolvedValue({ passkeyId: "pk_1" });
      hoisted.adoptSession.mockRejectedValue(new Error("storage unavailable"));

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(screen.getByText(/storage unavailable/)).toBeTruthy();
      });
      expect(screen.getByRole("button", { name: /Enroll credential/i })).toBeTruthy();
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

    // onSuccess is the contract this prop exists for — consumers that
    // own navigation (cire's standalone login page) redirect from it. Pin
    // that it fires exactly once on the enrollment success path.
    it("fires onSuccess after a successful enrollment", async () => {
      const onSuccess = vi.fn();
      await reachPasskey({ onSuccess });
      stub.passkeyRegisterBegin.mockResolvedValue({ challenge: "ch" });
      hoisted.startRegistration.mockResolvedValue({ id: "cred", rawId: "raw" });
      stub.passkeyRegisterComplete.mockResolvedValue({ passkeyId: "pk_1" });

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      // onSuccess now sits behind the adoptSession await, one microtask hop
      // further out than `waitFor`'s fake-timer loop drains on its own.
      await vi.advanceTimersByTimeAsync(0);
      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
      });
      // It must follow a real enrollment, never precede it.
      expect(stub.passkeyRegisterComplete).toHaveBeenCalled();
    });

    // The "every account has ≥1 passkey" invariant rests on onSuccess
    // (and the redirect it drives) NOT firing until enrollment truly
    // succeeds. A failed ceremony must keep the user on the passkey step.
    it("does not fire onSuccess and surfaces an error when enrollment fails", async () => {
      const onSuccess = vi.fn();
      await reachPasskey({ onSuccess });
      stub.passkeyRegisterBegin.mockResolvedValue({ challenge: "ch" });
      hoisted.startRegistration.mockRejectedValue(new Error("ceremony cancelled"));

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(screen.getByText(/ceremony cancelled/)).toBeTruthy();
      });
      expect(onSuccess).not.toHaveBeenCalled();
      // Still on the passkey step — enrollment remains required.
      expect(screen.getByRole("button", { name: /Enroll credential/i })).toBeTruthy();
    });

    // onSuccess is optional — consumers that react to session()
    // directly (musubi/social) omit it. Omission must not break completion.
    it("completes to the done step when onSuccess is omitted", async () => {
      await reachPasskey();
      stub.passkeyRegisterBegin.mockResolvedValue({ challenge: "ch" });
      hoisted.startRegistration.mockResolvedValue({ id: "cred", rawId: "raw" });
      stub.passkeyRegisterComplete.mockResolvedValue({ passkeyId: "pk_1" });

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(screen.getByText(/You.re all set/)).toBeTruthy();
      });
      // The done step names the product it is loading. It named a different
      // one for as long as this component was written for a single consumer,
      // so the assertion is on the name and not just on the sentence.
      expect(screen.getByText(/You.re all set\. Loading Musubi/)).toBeTruthy();
    });
  });

  describe("product name", () => {
    it("heads the dialog with the product it was given", () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Kumiho" />);
      expect(screen.getByRole("heading", { name: "Create your Kumiho account" })).toBeTruthy();
    });

    it("names the product in the age gate and the WebAuthn fallback", () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Kumiho" />);
      fillEmail("alice@example.com");
      fillBirthdate("2020-01-01");
      expect(screen.getByText("Kumiho is for users 13 and older")).toBeTruthy();

      cleanup();
      hoisted.webauthnSupported = false;
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Kumiho" />);
      expect(screen.getByText(/Creating an account on Kumiho needs a passkey/)).toBeTruthy();
    });
  });

  describe("WebAuthn-unsupported environment", () => {
    it("blocks the flow at the start with an informational screen", async () => {
      hoisted.webauthnSupported = false;
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      // No form fields render; only the fallback copy.
      expect(screen.queryByLabelText(/Email/)).toBeNull();
      expect(screen.getByText(/needs a passkey or security key/i)).toBeTruthy();
      expect(stub.beginRegistration).not.toHaveBeenCalled();
    });
  });

  it("Cancel button calls onCancel", () => {
    const onCancel = vi.fn();
    render(() => <Register client={asClient(stub)} onCancel={onCancel} productName="Musubi" />);
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
