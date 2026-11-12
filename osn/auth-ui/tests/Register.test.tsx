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
import { toast } from "@shared/toast";

// Import after mocks so the component picks them up.
import { Register } from "../src/Register";
import {
  CONNECTION,
  DETAILS,
  PASSKEY_GENERAL,
  PASSKEY_NOT_ADDED,
  WAIT,
  alertsText,
  apiError,
  ceremonyError,
} from "./helpers/errors";

interface ClientStub {
  checkHandle: ReturnType<typeof vi.fn>;
  beginRegistration: ReturnType<typeof vi.fn>;
  registrationStatus: ReturnType<typeof vi.fn>;
  resendRegistrationLink: ReturnType<typeof vi.fn>;
  passkeyRegisterBegin: ReturnType<typeof vi.fn>;
  passkeyRegisterComplete: ReturnType<typeof vi.fn>;
}

function makeClientStub(): ClientStub {
  return {
    checkHandle: vi.fn(),
    beginRegistration: vi.fn(),
    registrationStatus: vi.fn(),
    resendRegistrationLink: vi.fn(),
    passkeyRegisterBegin: vi.fn(),
    passkeyRegisterComplete: vi.fn(),
  };
}

/** A sign-up as `beginRegistration` answers it; `n` tells two apart. */
function begun(n = 1) {
  return {
    requestId: `signup_00000000000${n}`,
    claimSecret: String(n).repeat(64),
    pairingCode: `4${n}`,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
}

/** What the completing status poll answers. */
function completed() {
  return {
    status: "complete" as const,
    profileId: "usr_abc",
    handle: "alice",
    email: "alice@example.com",
    session: sampleSession,
  };
}

/** A promise and the functions that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

/** The number the waiting view shows, or null: the digits after its hidden "Your number:". */
function shownNumber(): string | null {
  const label = screen.queryByText("Your number:");
  return label?.parentElement?.querySelector('[translate="no"]')?.textContent ?? null;
}

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
    sessionStorage.clear();
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
        name: /Send verification link/i,
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
          name: /Send verification link/i,
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
        name: /Send verification link/i,
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      expect(stub.beginRegistration).not.toHaveBeenCalled();
    });
  });

  // The address verifies the account, is the emailed way back into an
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
      expect(panel.textContent).toMatch(/a link here to confirm the address/);
      expect(panel.textContent).toMatch(/Kumiho account is not created until you confirm it/);
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
          name: /Send verification link/i,
        }) as HTMLButtonElement;
        expect(b.disabled).toBe(false);
        return b;
      });

      fireEvent.click(screen.getByLabelText("What this address is used for"));
      expect(await screen.findByRole("dialog")).toBeTruthy();

      expect(stub.beginRegistration).not.toHaveBeenCalled();
      // Still on the details step: its submit button is the one on screen.
      expect(submit.isConnected).toBe(true);
      expect(screen.queryByText(/Check your email/)).toBeNull();
    });
  });

  /** Fills the details and submits them; resolves once the waiting view shows. */
  async function submitDetailsAs(email = "alice@example.com", handle = "alice") {
    stub.checkHandle.mockResolvedValue({ available: true });
    fillEmail(email);
    fillHandle(handle);
    fillBirthdate("1990-01-01");
    await vi.advanceTimersByTimeAsync(350);
    await waitFor(() => {
      const submit = screen.getByRole("button", {
        name: /Send verification link/i,
      }) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole("button", { name: /Send verification link/i }));
    await waitFor(() => expect(screen.getByText(/Check your email/)).toBeTruthy());
  }

  function renderRegister(extra?: { onSuccess?: () => void; onCancel?: () => void }) {
    return render(() => (
      <Register
        client={asClient(stub)}
        onCancel={extra?.onCancel ?? (() => {})}
        onSuccess={extra?.onSuccess}
        productName="Musubi"
      />
    ));
  }

  describe("waiting for the link", () => {
    it("begins with the form values and waits on the link, polling with the request it got", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "pending" });
      renderRegister();
      await submitDetailsAs();
      expect(stub.beginRegistration).toHaveBeenCalledWith({
        email: "alice@example.com",
        handle: "alice",
        birthdate: "1990-01-01",
        displayName: undefined,
      });
      expect(stub.registrationStatus).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stub.registrationStatus).toHaveBeenCalledWith({
        requestId: begun().requestId,
        claimSecret: begun().claimSecret,
      });
    });

    it("shows the number the begin gave on the waiting view, and never writes it to storage", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({
        status: "pending",
        pairingCode: begun().pairingCode,
      });
      renderRegister();
      await submitDetailsAs();
      expect(shownNumber()).toBe(begun().pairingCode);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stub.registrationStatus).toHaveBeenCalledTimes(1);

      const stored = JSON.parse(sessionStorage.getItem("osn.signup.pending") ?? "null") as Record<
        string,
        unknown
      >;
      expect(Object.keys(stored)).toEqual(
        expect.arrayContaining(["claimSecret", "email", "expiresAt", "handle", "requestId"]),
      );
      expect(Object.keys(stored)).toHaveLength(5);
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)!;
        expect(Object.values(JSON.parse(sessionStorage.getItem(key)!) as object)).not.toContain(
          begun().pairingCode,
        );
      }
    });

    it("stops polling, and leaves no timer or listener behind, once the view is gone", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "pending" });
      const view = renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      const calls = stub.registrationStatus.mock.calls.length;

      view.unmount();
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stub.registrationStatus.mock.calls.length).toBe(calls);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("shows the expired view and stops polling when the request is gone", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "expired" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(screen.getByText(/Your link has expired/)).toBeTruthy());
      const calls = stub.registrationStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stub.registrationStatus.mock.calls.length).toBe(calls);
      expect(sessionStorage.getItem("osn.signup.pending")).toBeNull();
    });

    it("sends a new link after expiry from the details, so Turnstile can run again, retiring the old request", async () => {
      stub.beginRegistration.mockResolvedValueOnce(begun(1)).mockResolvedValueOnce(begun(2));
      stub.registrationStatus.mockResolvedValue({ status: "expired" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => screen.getByRole("button", { name: /Send a new link/i }));
      fireEvent.click(screen.getByRole("button", { name: /Send a new link/i }));

      await waitFor(() => screen.getByRole("button", { name: /Send verification link/i }));
      expect((screen.getByLabelText(/Email/) as HTMLInputElement).value).toBe("alice@example.com");
      await vi.advanceTimersByTimeAsync(350);
      await waitFor(() => {
        const submit = screen.getByRole("button", {
          name: /Send verification link/i,
        }) as HTMLButtonElement;
        expect(submit.disabled).toBe(false);
      });
      fireEvent.click(screen.getByRole("button", { name: /Send verification link/i }));
      await waitFor(() => expect(stub.beginRegistration).toHaveBeenCalledTimes(2));
      expect(stub.beginRegistration.mock.calls[1]![0].previous).toEqual({
        requestId: begun(1).requestId,
        claimSecret: begun(1).claimSecret,
      });
    });

    it("keeps waiting through a poll that failed, and polls again", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus
        .mockRejectedValueOnce(new Error("Failed to fetch"))
        .mockResolvedValue({ status: "pending" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stub.registrationStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Check your email/)).toBeTruthy();
      expect(screen.queryByText(/Your link has expired/)).toBeNull();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stub.registrationStatus).toHaveBeenCalledTimes(2);
    });

    it("resends a link for the same request, and says so only when one went", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "pending" });
      stub.resendRegistrationLink
        .mockResolvedValueOnce({ status: "sent" })
        .mockResolvedValueOnce({ status: "limit" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(30_000);
      fireEvent.click(await screen.findByRole("button", { name: /^Resend link$/ }));
      await waitFor(() => expect(screen.getByText(/We sent a new link/)).toBeTruthy());
      expect(stub.resendRegistrationLink).toHaveBeenCalledWith({
        requestId: begun().requestId,
        claimSecret: begun().claimSecret,
      });
      expect(stub.beginRegistration).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      fireEvent.click(await screen.findByRole("button", { name: /^Resend link$/ }));
      await waitFor(() => expect(screen.getByText(/all the links we can/i)).toBeTruthy());
      expect(screen.queryByText(/We sent a new link/)).toBeNull();
      const calls = stub.registrationStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stub.registrationStatus.mock.calls.length).toBeGreaterThan(calls);
    });

    it.each([
      ["no answer", apiError("PLANTED-resend-offline", 0, ""), CONNECTION],
      ["a 429", apiError("PLANTED-resend-429", 429, "rate_limited"), WAIT],
    ])(
      "says %s on a failed Resend as the map's sentence, and keeps polling",
      async (_, error, sentence) => {
        stub.beginRegistration.mockResolvedValue(begun());
        stub.registrationStatus.mockResolvedValue({ status: "pending" });
        stub.resendRegistrationLink.mockRejectedValueOnce(error);
        renderRegister();
        await submitDetailsAs();
        await vi.advanceTimersByTimeAsync(30_000);
        fireEvent.click(await screen.findByRole("button", { name: /^Resend link$/ }));
        await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(sentence));
        expect(alertsText()).not.toContain("PLANTED");
        expect(screen.queryByText(/We sent a new link/)).toBeNull();
        expect(screen.queryByText(/Your link has expired/)).toBeNull();
        const calls = stub.registrationStatus.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(stub.registrationStatus.mock.calls.length).toBeGreaterThan(calls);
      },
    );

    it("holds Cancel while Resend sends", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "pending" });
      const held = deferred<{ status: "sent" }>();
      stub.resendRegistrationLink.mockReturnValueOnce(held.promise);
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(30_000);
      fireEvent.click(await screen.findByRole("button", { name: /^Resend link$/ }));
      await screen.findByRole("button", { name: /Sending…/ });
      const cancel = screen.getByRole("button", { name: /^Cancel$/ }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(true);
      held.resolve({ status: "sent" });
      await waitFor(() => expect(cancel.disabled).toBe(false));
    });

    it("shows the expired view, stops polling and clears the stored wait when Resend answers expired", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "pending" });
      stub.resendRegistrationLink.mockResolvedValueOnce({ status: "expired" });
      renderRegister();
      await submitDetailsAs();
      expect(sessionStorage.getItem("osn.signup.pending")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      fireEvent.click(await screen.findByRole("button", { name: /^Resend link$/ }));
      await waitFor(() => expect(screen.getByText(/Your link has expired/)).toBeTruthy());
      expect(sessionStorage.getItem("osn.signup.pending")).toBeNull();
      const calls = stub.registrationStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stub.registrationStatus.mock.calls.length).toBe(calls);
    });

    it("keeps the wait in memory when session storage refuses to write", async () => {
      const setItem = vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });
      try {
        stub.beginRegistration.mockResolvedValue(begun());
        stub.registrationStatus.mockResolvedValue({ status: "pending" });
        renderRegister();
        await submitDetailsAs();
        expect(setItem).toHaveBeenCalled();
        expect(screen.getByText(/Check your email/)).toBeTruthy();
        expect(screen.queryByText(/could(n't| not)/i)).toBeNull();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(stub.registrationStatus).toHaveBeenCalledWith({
          requestId: begun().requestId,
          claimSecret: begun().claimSecret,
        });
      } finally {
        setItem.mockRestore();
      }
    });

    it("stops waiting on 'Start again' and retires that request on the next begin", async () => {
      stub.beginRegistration.mockResolvedValueOnce(begun(1)).mockResolvedValueOnce(begun(2));
      stub.registrationStatus.mockResolvedValue({ status: "pending" });
      renderRegister();
      await submitDetailsAs();
      fireEvent.click(screen.getByRole("button", { name: /Start again/i }));
      await waitFor(() => screen.getByRole("button", { name: /Send verification link/i }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(stub.registrationStatus).not.toHaveBeenCalled();

      fillEmail("alice@example.org");
      await vi.advanceTimersByTimeAsync(350);
      fireEvent.click(screen.getByRole("button", { name: /Send verification link/i }));
      await waitFor(() => expect(stub.beginRegistration).toHaveBeenCalledTimes(2));
      expect(stub.beginRegistration.mock.calls[1]![0].previous).toEqual({
        requestId: begun(1).requestId,
        claimSecret: begun(1).claimSecret,
      });
    });

    it("retires the request a cancelled dialog left, when the next one begins", async () => {
      stub.beginRegistration.mockResolvedValueOnce(begun(1)).mockResolvedValueOnce(begun(2));
      stub.registrationStatus.mockResolvedValue({ status: "pending" });
      const first = renderRegister();
      await submitDetailsAs();
      fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
      first.unmount();

      renderRegister();
      expect(screen.getByRole("button", { name: /Send verification link/i })).toBeTruthy();
      await submitDetailsAs();
      expect(stub.beginRegistration.mock.calls[1]![0].previous).toEqual({
        requestId: begun(1).requestId,
        claimSecret: begun(1).claimSecret,
      });
    });

    it("polls at once when the person comes back to the tab", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "pending" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(500);
      expect(stub.registrationStatus).not.toHaveBeenCalled();
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.registrationStatus).toHaveBeenCalledTimes(1);
    });

    it("sends one poll when focus and visibility change land together", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      const held = deferred<{ status: "pending" }>();
      stub.registrationStatus.mockReturnValue(held.promise);
      renderRegister();
      await submitDetailsAs();
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stub.registrationStatus).toHaveBeenCalledTimes(1);
      held.resolve({ status: "pending" });
    });

    it("adopts a completing answer that arrives after the person moved on, and drops a stale refusal", async () => {
      stub.beginRegistration.mockResolvedValueOnce(begun(1)).mockResolvedValueOnce(begun(2));
      const late = deferred<unknown>();
      stub.registrationStatus.mockReturnValueOnce(late.promise);
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stub.registrationStatus).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: /Start again/i }));
      await waitFor(() => screen.getByRole("button", { name: /Send verification link/i }));
      late.resolve(completed());
      await waitFor(() => screen.getByRole("button", { name: /Enroll credential/i }));
      expect(hoisted.adoptSession).not.toHaveBeenCalled();
    });

    it("publishes the session of a completing answer that lands after the dialog closed, and clears the stored wait", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      const late = deferred<unknown>();
      stub.registrationStatus.mockReturnValueOnce(late.promise);
      hoisted.adoptSession.mockResolvedValue(undefined);
      const onCancel = vi.fn();
      const view = renderRegister({ onCancel });
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stub.registrationStatus).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
      expect(onCancel).toHaveBeenCalledTimes(1);
      view.unmount();
      late.resolve(completed());
      await vi.advanceTimersByTimeAsync(0);

      expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      expect(sessionStorage.getItem("osn.signup.pending")).toBeNull();
      expect(sessionStorage.getItem("osn.signup.previous")).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stub.registrationStatus).toHaveBeenCalledTimes(1);
    });

    it("drops a stale expired answer for a request it no longer waits on", async () => {
      stub.beginRegistration.mockResolvedValueOnce(begun(1)).mockResolvedValueOnce(begun(2));
      const late = deferred<unknown>();
      stub.registrationStatus.mockReturnValueOnce(late.promise).mockResolvedValue({
        status: "pending",
      });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      fireEvent.click(screen.getByRole("button", { name: /Start again/i }));
      await waitFor(() => screen.getByRole("button", { name: /Send verification link/i }));
      fillEmail("alice@example.org");
      await vi.advanceTimersByTimeAsync(350);
      fireEvent.click(screen.getByRole("button", { name: /Send verification link/i }));
      await waitFor(() => expect(screen.getByText(/Check your email/)).toBeTruthy());

      late.resolve({ status: "expired" });
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByText(/Your link has expired/)).toBeNull();
    });

    it("resumes the wait after a reload, polling at once for the number, and drops a stored wait that has expired", async () => {
      const { pairingCode, ...request } = begun();
      sessionStorage.setItem(
        "osn.signup.pending",
        JSON.stringify({ ...request, email: "alice@example.com", handle: "alice" }),
      );
      stub.registrationStatus.mockResolvedValue({ status: "pending", pairingCode });
      const resumed = renderRegister();
      expect(screen.getByText(/Check your email/)).toBeTruthy();
      expect(screen.getByText(/alice@example.com/)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.registrationStatus).toHaveBeenCalledWith({
        requestId: begun().requestId,
        claimSecret: begun().claimSecret,
      });
      await waitFor(() => expect(shownNumber()).toBe(pairingCode));
      resumed.unmount();

      sessionStorage.setItem(
        "osn.signup.pending",
        JSON.stringify({
          ...begun(),
          expiresAt: Math.floor(Date.now() / 1000) - 1,
          email: "alice@example.com",
          handle: "alice",
        }),
      );
      renderRegister();
      expect(screen.getByRole("button", { name: /Send verification link/i })).toBeTruthy();
      expect(sessionStorage.getItem("osn.signup.pending")).toBeNull();
    });

    it("goes back to the details with a reason when the handle went while it waited", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "conflict" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => screen.getByRole("button", { name: /Send verification link/i }));
      expect(screen.getByText(/taken while you waited/i)).toBeTruthy();
    });

    it("reads the reason out as an alert and puts focus on the handle field", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "conflict" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => screen.getByRole("button", { name: /Send verification link/i }));
      expect(screen.getByRole("alert").textContent).toMatch(/taken while you waited/i);
      expect(document.activeElement).toBe(screen.getByLabelText("Handle"));
    });

    it("ties the reason to the handle field, so it is read with the field that took focus", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "conflict" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => screen.getByRole("button", { name: /Send verification link/i }));
      const alert = screen.getByRole("alert");
      expect(alert.id).not.toBe("");
      expect(screen.getByLabelText("Handle").getAttribute("aria-describedby")).toBe(alert.id);
    });

    it("drops the reason once the person changes the handle, and with it the field's description", async () => {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue({ status: "conflict" });
      renderRegister();
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => screen.getByRole("button", { name: /Send verification link/i }));
      const field = fillHandle("alice_2");
      expect(screen.queryByText(/taken while you waited/i)).toBeNull();
      expect(field.hasAttribute("aria-describedby")).toBe(false);
    });
  });

  describe("passkey step (mandatory)", () => {
    async function reachPasskey(extra?: { onSuccess?: () => void }) {
      stub.beginRegistration.mockResolvedValue(begun());
      stub.registrationStatus.mockResolvedValue(completed());
      hoisted.adoptSession.mockResolvedValue(undefined);
      renderRegister(extra);
      await submitDetailsAs();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => screen.getByRole("button", { name: /Enroll credential/i }));
    }

    // The passkey step is the whole reason this component holds `accessToken`
    // in a signal: enrollment is authenticated by that explicit bearer token,
    // not by an adopted session. Adopting early published a session to the
    // app while the account still had zero passkeys — and in `@musubi/social`
    // that unmounted the dialog mid-flow, skipping enrollment entirely.
    it("does not adopt the session when the account is made — enrollment carries its own token", async () => {
      await reachPasskey();
      expect(hoisted.adoptSession).not.toHaveBeenCalled();
      expect(stub.passkeyRegisterBegin).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("osn.signup.pending")).toBeNull();
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
      hoisted.startRegistration.mockRejectedValue(new Error("PLANTED ceremony cancelled"));

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert").textContent).toContain(PASSKEY_GENERAL);
      });
      expect(alertsText()).not.toContain("PLANTED");
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
      hoisted.adoptSession.mockRejectedValue(new Error("PLANTED storage unavailable"));

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert").textContent).toContain(PASSKEY_GENERAL);
      });
      expect(alertsText()).not.toContain("PLANTED");
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
      hoisted.startRegistration.mockRejectedValue(
        ceremonyError("NotAllowedError", "PLANTED ceremony cancelled"),
      );

      fireEvent.click(screen.getByRole("button", { name: /Enroll credential/i }));

      await waitFor(() => {
        expect(screen.getByRole("alert").textContent).toContain(PASSKEY_NOT_ADDED);
      });
      expect(alertsText()).not.toContain("PLANTED");
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

  describe("error lines and waits", () => {
    async function fillValidDetails(siteKey?: string) {
      stub.checkHandle.mockResolvedValue({ available: true });
      render(() => (
        <Register
          client={asClient(stub)}
          onCancel={() => {}}
          turnstileSiteKey={siteKey}
          productName="Musubi"
        />
      ));
      fillEmail("alice@example.com");
      fillHandle("alice");
      fillBirthdate("1990-01-01");
      await vi.advanceTimersByTimeAsync(350);
    }

    const send = () =>
      screen.getByRole("button", { name: /Send verification link|Sending…/ }) as HTMLButtonElement;

    it.each([
      ["a 400", apiError("PLANTED-register-400"), DETAILS],
      [
        "a 422",
        apiError("PLANTED-register-422", 422, "age_restricted"),
        "You must be 13 or older to create an account.",
      ],
      ["a 429", apiError("PLANTED-register-429", 429, "rate_limited"), WAIT],
    ])(
      "a refused send reads %s as the map's sentence, above the button, with no toast",
      async (_, error, sentence) => {
        vi.mocked(toast.error).mockClear();
        stub.beginRegistration.mockRejectedValue(error);
        await fillValidDetails();
        fireEvent.click(send());
        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain(sentence);
        expect(alertsText()).not.toContain("PLANTED");
        expect(toast.error).not.toHaveBeenCalled();
        // The line comes before the button it is about.
        expect(
          alert.compareDocumentPosition(send()) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      },
    );

    it("ties a malformed email to its field once the field is left", async () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      const field = screen.getByLabelText(/Email/) as HTMLInputElement;
      fireEvent.input(field, { target: { value: "alice@" } });
      // Not announced on every keystroke.
      expect(screen.queryByRole("alert")).toBeNull();
      fireEvent.blur(field);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Please enter a valid email address");
      expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
      expect(field.getAttribute("aria-invalid")).toBe("true");
    });

    it("describes the date of birth by its hint, then by the under-13 line", async () => {
      render(() => <Register client={asClient(stub)} onCancel={() => {}} productName="Musubi" />);
      const field = screen.getByLabelText(/Date of birth/) as HTMLInputElement;
      const hint = screen.getByText("You must be 13 or older to create an account.");
      expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
      expect(field.getAttribute("aria-invalid")).toBeNull();

      const tenYearsAgo = new Date();
      tenYearsAgo.setUTCFullYear(tenYearsAgo.getUTCFullYear() - 10);
      fillBirthdate(tenYearsAgo.toISOString().slice(0, 10));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Musubi is for users 13 and older");
      expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
      expect(field.getAttribute("aria-invalid")).toBe("true");
    });

    // Only the button that started the wait shows it, and nothing leaves the
    // dialog while it runs.
    it("keeps the send busy, not disabled, and holds Cancel while it sends", async () => {
      await fillValidDetails();
      stub.beginRegistration.mockReturnValueOnce(new Promise(() => {}));
      await waitFor(() => expect(send().disabled).toBe(false));
      fireEvent.click(send());
      const sending = await screen.findByRole("button", { name: /Sending…/ });
      expect(sending.getAttribute("aria-busy")).toBe("true");
      expect((sending as HTMLButtonElement).disabled).toBe(false);
      const cancel = screen.getByRole("button", { name: /^Cancel$/ }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(true);
      fireEvent.submit(sending.closest("form")!);
      await vi.advanceTimersByTimeAsync(0);
      expect(stub.beginRegistration).toHaveBeenCalledTimes(1);
    });

    describe("with the verification check on", () => {
      let deliver: ((token: string) => void) | undefined;
      let reset: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        reset = vi.fn();
        // Like Cloudflare's: a token on render, and another only once the
        // challenge runs again after `reset`.
        (globalThis as unknown as { turnstile?: unknown }).turnstile = {
          render: vi.fn((_el: HTMLElement, opts: { callback?: (t: string) => void }) => {
            deliver = opts.callback;
            deliver?.("tok-render");
            return "widget-1";
          }),
          reset,
          remove: vi.fn(),
        };
      });

      afterEach(() => {
        delete (globalThis as unknown as { turnstile?: unknown }).turnstile;
        document.getElementById("cf-turnstile-script")?.remove();
      });

      it("asks for a fresh token when the send is refused, and waits for it", async () => {
        stub.beginRegistration.mockRejectedValueOnce(apiError("PLANTED-begin"));
        await fillValidDetails("0x4AAAAAADnA2piUnbgG_kVw");
        await waitFor(() => expect(send().disabled).toBe(false));
        fireEvent.click(send());
        await screen.findByRole("alert");
        expect(reset).toHaveBeenCalled();
        expect(send().disabled).toBe(true);
        deliver?.("tok-2");
        await waitFor(() => expect(send().disabled).toBe(false));
      });

      // A sign-up that sends runs one challenge: the spent token goes with the
      // details step's widget, and the waiting view's Resend needs none.
      it("runs no second challenge once the link is sent", async () => {
        const challenges = (
          globalThis as unknown as { turnstile: { render: ReturnType<typeof vi.fn> } }
        ).turnstile.render;
        stub.beginRegistration.mockResolvedValueOnce(begun());
        stub.registrationStatus.mockResolvedValue({ status: "pending" });
        await fillValidDetails("0x4AAAAAADnA2piUnbgG_kVw");
        await waitFor(() => expect(send().disabled).toBe(false));
        fireEvent.click(send());
        await waitFor(() => expect(screen.getByText(/Check your email/)).toBeTruthy());
        await vi.advanceTimersByTimeAsync(31_000);
        expect(challenges).toHaveBeenCalledTimes(1);
        expect(reset).not.toHaveBeenCalled();
      });
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
