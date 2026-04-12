// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * SignIn.tsx drives all three first-party sign-in flows (passkey, OTP, magic
 * link) through an injected LoginClient. Same testing strategy as Register:
 * pass a stub client via props, mock the Solid auth context for
 * `adoptSession`, and mock @simplewebauthn/browser for the WebAuthn shim.
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

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import type { LoginClient } from "@osn/client";

import { SignIn } from "../../src/auth/SignIn";

interface ClientStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
  magicBegin: ReturnType<typeof vi.fn>;
  magicVerify: ReturnType<typeof vi.fn>;
}

const makeStub = (): ClientStub => ({
  passkeyBegin: vi.fn(),
  passkeyComplete: vi.fn(),
  otpBegin: vi.fn(),
  otpComplete: vi.fn(),
  magicBegin: vi.fn(),
  magicVerify: vi.fn(),
});

const asClient = (s: ClientStub): LoginClient => s as unknown as LoginClient;

const sampleSession = {
  accessToken: "acc_x",
  refreshToken: null,
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
  let stub: ClientStub;

  beforeEach(() => {
    stub = makeStub();
    hoisted.webauthnSupported = true;
    hoisted.adoptSession.mockReset();
    hoisted.startAuthentication.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  describe("passkey mode", () => {
    it("happy path: begin → WebAuthn → complete → adoptSession", async () => {
      stub.passkeyBegin.mockResolvedValue({ options: { challenge: "ch" } });
      hoisted.startAuthentication.mockResolvedValue({ id: "cred", rawId: "raw" });
      stub.passkeyComplete.mockResolvedValue({ session: sampleSession, user: sampleUser });
      hoisted.adoptSession.mockResolvedValue(undefined);

      render(() => <SignIn client={asClient(stub)} />);
      fillIdentifier("alice");
      fireEvent.click(screen.getByRole("button", { name: /Continue with passkey/i }));

      await waitFor(() => {
        expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      });
      expect(stub.passkeyBegin).toHaveBeenCalledWith("alice");
      expect(hoisted.startAuthentication).toHaveBeenCalledWith({
        optionsJSON: { challenge: "ch" },
      });
      expect(stub.passkeyComplete).toHaveBeenCalledWith("alice", { id: "cred", rawId: "raw" });
    });

    it("surfaces errors from passkeyComplete and doesn't adopt a session", async () => {
      stub.passkeyBegin.mockResolvedValue({ options: {} });
      hoisted.startAuthentication.mockResolvedValue({ id: "cred" });
      stub.passkeyComplete.mockRejectedValue(new Error("Passkey verification failed"));

      render(() => <SignIn client={asClient(stub)} />);
      fillIdentifier("alice");
      fireEvent.click(screen.getByRole("button", { name: /Continue with passkey/i }));

      await waitFor(() => {
        expect(screen.getByText(/Passkey verification failed/)).toBeTruthy();
      });
      expect(hoisted.adoptSession).not.toHaveBeenCalled();
    });

    it("hides the passkey tab and defaults to OTP when WebAuthn is unsupported", async () => {
      hoisted.webauthnSupported = false;
      render(() => <SignIn client={asClient(stub)} defaultMethod="passkey" />);
      await waitFor(() => {
        // Passkey tab should not be rendered at all.
        expect(screen.queryByRole("tab", { name: /Passkey/i })).toBeNull();
      });
      // OTP tab should be active (the "Send verification code" button belongs to OTP).
      expect(screen.getByRole("button", { name: /Send verification code/i })).toBeTruthy();
    });
  });

  describe("OTP mode", () => {
    it("happy path: begin → code entry → complete → adoptSession", async () => {
      stub.otpBegin.mockResolvedValue({ sent: true });
      stub.otpComplete.mockResolvedValue({ session: sampleSession, user: sampleUser });
      hoisted.adoptSession.mockResolvedValue(undefined);

      render(() => <SignIn client={asClient(stub)} defaultMethod="otp" />);
      fillIdentifier("alice@example.com");
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/i }));

      await waitFor(() => screen.getByLabelText(/Verification code/));
      const otp = screen.getByLabelText(/Verification code/) as HTMLInputElement;
      fireEvent.input(otp, { target: { value: "123456" } });
      fireEvent.click(screen.getByRole("button", { name: /^Sign in$/i }));

      await waitFor(() => {
        expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      });
      expect(stub.otpBegin).toHaveBeenCalledWith("alice@example.com");
      expect(stub.otpComplete).toHaveBeenCalledWith("alice@example.com", "123456");
    });

    it("OTP code input strips non-digits and caps at 6 chars", async () => {
      stub.otpBegin.mockResolvedValue({ sent: true });
      render(() => <SignIn client={asClient(stub)} defaultMethod="otp" />);
      fillIdentifier("alice@example.com");
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/i }));
      await waitFor(() => screen.getByLabelText(/Verification code/));
      const otp = screen.getByLabelText(/Verification code/) as HTMLInputElement;
      fireEvent.input(otp, { target: { value: "12ab34cd56789" } });
      expect(otp.value).toBe("123456");
    });
  });

  describe("Magic link mode", () => {
    it("shows the 'check your email' state after a successful begin", async () => {
      stub.magicBegin.mockResolvedValue({ sent: true });
      render(() => <SignIn client={asClient(stub)} defaultMethod="magic" />);
      fillIdentifier("alice@example.com");
      fireEvent.click(screen.getByRole("button", { name: /Send magic link/i }));
      await waitFor(() => {
        expect(screen.getByText(/just emailed a sign-in/i)).toBeTruthy();
      });
      expect(hoisted.adoptSession).not.toHaveBeenCalled();
    });
  });

  describe("onCancel", () => {
    it("renders a Cancel button only when onCancel is provided", () => {
      const onCancel = vi.fn();
      render(() => <SignIn client={asClient(stub)} onCancel={onCancel} />);
      fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
      expect(onCancel).toHaveBeenCalled();
    });

    it("omits the Cancel button when no onCancel prop is given", () => {
      render(() => <SignIn client={asClient(stub)} />);
      expect(screen.queryByRole("button", { name: /Cancel/i })).toBeNull();
    });
  });
});
