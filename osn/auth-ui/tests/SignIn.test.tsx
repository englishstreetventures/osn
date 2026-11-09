// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * SignIn.tsx drives WebAuthn (passkey / security key) primary login through
 * an injected `LoginClient`, with a "Lost your passkey?" escape hatch that
 * routes into `RecoveryLoginForm`. When WebAuthn is unsupported it shows an
 * informational screen instead of a broken form.
 */

const hoisted = vi.hoisted(() => ({
  webauthnSupported: true,
  adoptSession: vi.fn(),
  startAuthentication: vi.fn(),
}));

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ adoptSession: hoisted.adoptSession }),
}));

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => hoisted.webauthnSupported,
  startAuthentication: hoisted.startAuthentication,
}));

vi.mock("@shared/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import type { LoginClient, RecoveryClient } from "@osn/client";
import { toast } from "@shared/toast";

import { SignIn } from "../src/SignIn";
import {
  CHECK_FAILED,
  WAIT,
  PASSKEY_NOT_USED,
  alertsText,
  apiError,
  ceremonyError,
} from "./helpers/errors";

interface LoginStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
}

interface RecoveryStub {
  generateRecoveryCodes: ReturnType<typeof vi.fn>;
  loginWithRecoveryCode: ReturnType<typeof vi.fn>;
}

const makeLogin = (): LoginStub => ({
  passkeyBegin: vi.fn(),
  passkeyComplete: vi.fn(),
});

const makeRecovery = (): RecoveryStub => ({
  generateRecoveryCodes: vi.fn(),
  loginWithRecoveryCode: vi.fn(),
});

const asLogin = (s: LoginStub): LoginClient => s as unknown as LoginClient;
const asRecovery = (s: RecoveryStub): RecoveryClient => s as unknown as RecoveryClient;

const sampleSession = {
  accessToken: "acc_x",
  idToken: null,
  expiresAt: Date.now() + 60_000,
  scopes: [],
};

const sampleUser = {
  id: "usr_1",
  handle: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  avatarUrl: null,
};

function fillIdentifier(value: string) {
  const input = screen.getByLabelText(/Email or @handle/) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
}

describe("SignIn component", () => {
  let login: LoginStub;
  let recovery: RecoveryStub;

  beforeEach(() => {
    login = makeLogin();
    recovery = makeRecovery();
    hoisted.webauthnSupported = true;
    hoisted.adoptSession.mockReset();
    hoisted.startAuthentication.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  describe("WebAuthn login (passkey or security key)", () => {
    it("happy path: begin → WebAuthn → complete → adoptSession", async () => {
      login.passkeyBegin.mockResolvedValue({ options: { challenge: "ch" } });
      hoisted.startAuthentication.mockResolvedValue({ id: "cred", rawId: "raw" });
      login.passkeyComplete.mockResolvedValue({ session: sampleSession, user: sampleUser });
      hoisted.adoptSession.mockResolvedValue(undefined);

      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          productName="Musubi"
        />
      ));
      fillIdentifier("alice");
      fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));

      await waitFor(() => {
        expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      });
      expect(login.passkeyBegin).toHaveBeenCalledWith("alice");
      expect(hoisted.startAuthentication).toHaveBeenCalledWith({
        optionsJSON: { challenge: "ch" },
      });
      expect(login.passkeyComplete).toHaveBeenCalledWith({
        identifier: "alice",
        assertion: { id: "cred", rawId: "raw" },
      });
    });

    it("shows the map's sentence for a refused passkey, never the error's text, and adopts nothing", async () => {
      login.passkeyBegin.mockResolvedValue({ options: {} });
      hoisted.startAuthentication.mockResolvedValue({ id: "cred" });
      login.passkeyComplete.mockRejectedValue(apiError("PLANTED-signin-complete"));

      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          productName="Musubi"
        />
      ));
      fillIdentifier("alice");
      fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("We couldn't verify that passkey. Try again.");
      expect(document.body.textContent).not.toContain("PLANTED");
      expect(hoisted.adoptSession).not.toHaveBeenCalled();
    });
  });

  describe("error line", () => {
    function mount() {
      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          productName="Musubi"
        />
      ));
    }

    async function submitAndFail(error: Error) {
      login.passkeyBegin.mockRejectedValue(error);
      mount();
      fillIdentifier("alice");
      fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));
      return screen.findByRole("alert");
    }

    it.each([
      ["a 400", apiError("PLANTED-signin-400"), "We couldn't verify that passkey. Try again."],
      ["a 429", apiError("PLANTED-signin-429", 429, "rate_limited"), WAIT],
      [
        "a 503",
        apiError("PLANTED-signin-503", 503, "temporarily_unavailable"),
        "Something went wrong on our side. Try again.",
      ],
    ])("reads %s as the map's sentence, never its text", async (_, error, sentence) => {
      const alert = await submitAndFail(error);
      expect(alert.textContent).toContain(sentence);
      expect(alertsText()).not.toContain("PLANTED");
    });

    it("ties the line to the identifier field", async () => {
      const alert = await submitAndFail(apiError("PLANTED-signin-tie"));
      const field = screen.getByLabelText(/Email or @handle/);
      expect(alert.id).not.toBe("");
      expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
      // A 400 refused what was typed.
      expect(field.getAttribute("aria-invalid")).toBe("true");
    });

    it.each([
      ["a 429", apiError("PLANTED-signin-429", 429, "rate_limited"), WAIT],
      [
        "a failed verification check",
        apiError("PLANTED-signin-turnstile", 400, "turnstile_failed"),
        CHECK_FAILED,
      ],
    ])(
      "does not mark the field invalid for %s, where nothing typed was wrong",
      async (_, error, sentence) => {
        const alert = await submitAndFail(error);
        expect(alert.textContent).toContain(sentence);
        expect(alertsText()).not.toContain("PLANTED");
        const field = screen.getByLabelText(/Email or @handle/);
        expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
        expect(field.getAttribute("aria-invalid")).toBeNull();
      },
    );

    it("raises no error toast", async () => {
      vi.mocked(toast.error).mockClear();
      await submitAndFail(apiError("PLANTED-signin-toast"));
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("keeps a way out beside a refused passkey", async () => {
      login.passkeyBegin.mockResolvedValue({ options: {} });
      hoisted.startAuthentication.mockRejectedValue(
        ceremonyError("NotAllowedError", "PLANTED https://www.w3.org/TR/webauthn-2/"),
      );
      mount();
      fillIdentifier("alice");
      fireEvent.click(screen.getByRole("button", { name: /^Continue$/ }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(PASSKEY_NOT_USED);
      expect(alert.textContent).not.toContain("PLANTED");
      const way = alert.querySelector("button");
      expect(way?.textContent).toBe("Lost your passkey?");
      expect(way?.getAttribute("type")).toBe("button");
      fireEvent.click(way!);
      await waitFor(() => screen.getByRole("button", { name: /Use a recovery code/i }));
    });

    it("leaves no sign-in error under the recovery form", async () => {
      await submitAndFail(apiError("PLANTED-signin-switch"));
      // The standalone link below Continue.
      const links = screen.getAllByRole("button", { name: /Lost your passkey/i });
      fireEvent.click(links[links.length - 1]!);
      await waitFor(() => screen.getByRole("button", { name: /Use a recovery code/i }));
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  describe("conditional-UI / discoverable login on mount", () => {
    it("kicks off passkeyBegin() (no identifier) → passkeyComplete({ challengeId, assertion })", async () => {
      const isAvail = vi.fn(async () => true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- happy-dom shim
      (window as any).PublicKeyCredential = { isConditionalMediationAvailable: isAvail };

      login.passkeyBegin.mockResolvedValue({
        options: { challenge: "ch-disc" },
        challengeId: "cid-1",
      });
      hoisted.startAuthentication.mockResolvedValue({ id: "cred-disc", rawId: "raw-disc" });
      login.passkeyComplete.mockResolvedValue({ session: sampleSession, user: sampleUser });
      hoisted.adoptSession.mockResolvedValue(undefined);

      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          productName="Musubi"
        />
      ));

      await waitFor(() => expect(login.passkeyBegin).toHaveBeenCalledWith());
      await waitFor(() =>
        expect(hoisted.startAuthentication).toHaveBeenCalledWith({
          optionsJSON: { challenge: "ch-disc" },
          useBrowserAutofill: true,
        }),
      );
      await waitFor(() =>
        expect(login.passkeyComplete).toHaveBeenCalledWith({
          challengeId: "cid-1",
          assertion: { id: "cred-disc", rawId: "raw-disc" },
        }),
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleanup
      delete (window as any).PublicKeyCredential;
    });

    it("does nothing when isConditionalMediationAvailable is missing", async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- cleanup
      delete (window as any).PublicKeyCredential;

      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          productName="Musubi"
        />
      ));

      await new Promise((r) => setTimeout(r, 10));
      expect(login.passkeyBegin).not.toHaveBeenCalled();
      expect(login.passkeyComplete).not.toHaveBeenCalled();
    });
  });

  describe("Turnstile single-use token (login-loop regression)", () => {
    // A minimal stand-in for Cloudflare's `window.turnstile`. `render` issues
    // a fresh token synchronously; `reset` issues another and re-fires the
    // callback — exactly Cloudflare's contract. This lets us prove the form
    // never replays a redeemed (single-use) token, which is what trapped
    // organisers on the login screen once the prod sitekey went live (#160).
    function installTurnstileStub() {
      let n = 0;
      let cb: ((token: string) => void) | undefined;
      const reset = vi.fn(() => {
        n += 1;
        cb?.(`tok-${n}`);
      });
      const stub = {
        render: vi.fn((_el: HTMLElement, opts: { callback?: (t: string) => void }) => {
          cb = opts.callback;
          n += 1;
          cb?.(`tok-${n}`);
          return "widget-1";
        }),
        reset,
        remove: vi.fn(),
      };
      (globalThis as unknown as { turnstile?: unknown }).turnstile = stub;
      return { stub, reset };
    }

    afterEach(() => {
      delete (globalThis as unknown as { turnstile?: unknown }).turnstile;
    });

    it("retries with a FRESH token after a failed ceremony — never replays the redeemed one", async () => {
      const { reset } = installTurnstileStub();

      login.passkeyBegin.mockResolvedValue({ options: { challenge: "ch" } });
      // First ceremony fails (user cancels / wrong passkey); second succeeds.
      hoisted.startAuthentication
        .mockRejectedValueOnce(new Error("ceremony cancelled"))
        .mockResolvedValueOnce({ id: "cred", rawId: "raw" });
      login.passkeyComplete.mockResolvedValue({ session: sampleSession, user: sampleUser });
      hoisted.adoptSession.mockResolvedValue(undefined);

      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          turnstileSiteKey="0x4AAAAAADnA2piUnbgG_kVw"
          productName="Musubi"
        />
      ));

      fillIdentifier("alice");
      // Wait for the widget to deliver its first token + enable the button.
      const button = () => screen.getByRole("button", { name: /^Continue$/ }) as HTMLButtonElement;
      await waitFor(() => expect(button().disabled).toBe(false));

      // Attempt 1 — begin consumes tok-1, then the ceremony fails.
      fireEvent.click(button());
      await waitFor(() => expect(login.passkeyBegin).toHaveBeenCalledTimes(1));
      expect(login.passkeyBegin).toHaveBeenLastCalledWith("alice", "tok-1");
      // The widget must have been reset so a retry gets a fresh token.
      await waitFor(() => expect(reset).toHaveBeenCalled());

      // Attempt 2 — must carry a DIFFERENT (fresh) token, not the redeemed tok-1.
      await waitFor(() => expect(button().disabled).toBe(false));
      fireEvent.click(button());
      await waitFor(() => expect(login.passkeyBegin).toHaveBeenCalledTimes(2));
      const secondToken = login.passkeyBegin.mock.calls[1]![1] as string;
      expect(secondToken).not.toBe("tok-1");
      await waitFor(() => expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession));
    });

    // The server checks the token before it answers, so a refused begin has
    // spent it too. Retrying with it would earn `turnstile_failed`.
    it("asks for a fresh token when begin itself is refused, and waits for it", async () => {
      let cb: ((token: string) => void) | undefined;
      const reset = vi.fn();
      (globalThis as unknown as { turnstile?: unknown }).turnstile = {
        render: vi.fn((_el: HTMLElement, opts: { callback?: (t: string) => void }) => {
          cb = opts.callback;
          cb?.("tok-1");
          return "widget-1";
        }),
        reset,
        remove: vi.fn(),
      };
      login.passkeyBegin.mockRejectedValueOnce(apiError("PLANTED-begin", 400, "invalid_request"));

      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          turnstileSiteKey="0x4AAAAAADnA2piUnbgG_kVw"
          productName="Musubi"
        />
      ));
      fillIdentifier("alice");
      const button = () => screen.getByRole("button", { name: /^Continue$/ }) as HTMLButtonElement;
      await waitFor(() => expect(button().disabled).toBe(false));

      fireEvent.click(button());
      await screen.findByRole("alert");
      expect(reset).toHaveBeenCalledWith("widget-1");
      expect(button().disabled).toBe(true);

      cb?.("tok-2");
      await waitFor(() => expect(button().disabled).toBe(false));
    });
  });

  describe("WebAuthn-unsupported fallback", () => {
    it("shows the informational screen and routes to recovery on click", async () => {
      hoisted.webauthnSupported = false;
      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          productName="Musubi"
        />
      ));
      await waitFor(() => {
        expect(screen.queryByLabelText(/Email or @handle/)).toBeNull();
      });
      expect(screen.getByText(/needs a passkey or security key/i)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Use a recovery code/i }));
      // The recovery surface opens on a factor chooser. With no WebAuthn it
      // offers only the recovery code, because the other two mint a session
      // whose one permitted action is a ceremony this browser cannot run.
      await waitFor(() => screen.getByRole("button", { name: /Use a recovery code/i }));
      expect(screen.queryByRole("button", { name: /Email me a code/i })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /Use a recovery code/i }));
      await waitFor(() => {
        expect(screen.getByLabelText(/Recovery code/i)).toBeTruthy();
      });
    });
  });

  describe("Lost your passkey? escape hatch", () => {
    it("surfaces the recovery form when the user clicks it", async () => {
      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          productName="Musubi"
        />
      ));
      fireEvent.click(screen.getByRole("button", { name: /Lost your passkey/i }));
      await waitFor(() => screen.getByRole("button", { name: /Use a recovery code/i }));
      fireEvent.click(screen.getByRole("button", { name: /Use a recovery code/i }));
      await waitFor(() => {
        expect(screen.getByLabelText(/Recovery code/i)).toBeTruthy();
      });
    });
  });

  describe("onCancel", () => {
    it("renders a Cancel button only when onCancel is provided", () => {
      const onCancel = vi.fn();
      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          onCancel={onCancel}
          productName="Musubi"
        />
      ));
      fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
      expect(onCancel).toHaveBeenCalled();
    });

    it("omits the Cancel button when no onCancel prop is given", () => {
      render(() => (
        <SignIn
          client={asLogin(login)}
          recoveryClient={asRecovery(recovery)}
          productName="Musubi"
        />
      ));
      expect(screen.queryByRole("button", { name: /^Cancel$/ })).toBeNull();
    });
  });
});
