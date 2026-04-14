// @vitest-environment happy-dom
import { render, cleanup, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  adoptSession: vi.fn(),
}));

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ adoptSession: hoisted.adoptSession }),
}));

import type { LoginClient } from "@osn/client";

import { MagicLinkHandler } from "../../src/auth/MagicLinkHandler";

interface Stub {
  magicVerify: ReturnType<typeof vi.fn>;
}

const makeStub = (): Stub => ({
  magicVerify: vi.fn(),
});

const asClient = (s: Stub): LoginClient => s as unknown as LoginClient;

const sampleSession = {
  accessToken: "acc_x",
  refreshToken: null,
  idToken: null,
  expiresAt: Date.now() + 60_000,
  scopes: [],
};

describe("MagicLinkHandler", () => {
  let stub: Stub;

  beforeEach(() => {
    stub = makeStub();
    hoisted.adoptSession.mockReset();
    // Reset URL to a clean baseline before each test.
    window.history.replaceState({}, "", "http://localhost:3000/");
  });

  afterEach(() => cleanup());

  it("no-op when the URL has no token", () => {
    render(() => <MagicLinkHandler client={asClient(stub)} />);
    expect(stub.magicVerify).not.toHaveBeenCalled();
    expect(hoisted.adoptSession).not.toHaveBeenCalled();
  });

  it("verifies the token, adopts the session, and clears the URL", async () => {
    stub.magicVerify.mockResolvedValue({
      session: sampleSession,
      profile: {
        id: "usr_1",
        handle: "alice",
        email: "a@e.com",
        displayName: null,
        avatarUrl: null,
      },
    });
    const onSuccess = vi.fn();
    hoisted.adoptSession.mockResolvedValue(undefined);
    window.history.replaceState({}, "", "http://localhost:3000/?token=mlnk_abc&foo=bar");

    render(() => <MagicLinkHandler client={asClient(stub)} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
    });
    expect(stub.magicVerify).toHaveBeenCalledWith("mlnk_abc");
    expect(onSuccess).toHaveBeenCalled();
    // The token param is gone; the unrelated `foo` param stays.
    expect(window.location.search).toBe("?foo=bar");
  });

  it("routes verify errors through onError rather than surfacing them", async () => {
    stub.magicVerify.mockRejectedValue(new Error("Magic link expired or not found"));
    const onError = vi.fn();
    window.history.replaceState({}, "", "http://localhost:3000/?token=bogus");

    render(() => <MagicLinkHandler client={asClient(stub)} onError={onError} />);

    await waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });
    expect(hoisted.adoptSession).not.toHaveBeenCalled();
  });
});
