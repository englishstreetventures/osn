// @vitest-environment happy-dom
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, type Accessor } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The prompt's whole job is knowing when to keep quiet. It offers recovery-code
 * setup to an account that has never generated a set, and to nobody else — so
 * every case below is a case where it must not render, plus the one where it
 * must.
 *
 * `getRecoveryCodesStatus` is stubbed: what is under test is the decision, not
 * the client, which has its own tests in `@osn/client`.
 */

const client = vi.hoisted(() => ({
  getRecoveryCodesStatus: vi.fn(),
}));

vi.mock("../../src/lib/authClients", () => ({ recoveryClient: client }));

import { RecoveryCodesPrompt } from "../../src/components/RecoveryCodesPrompt";

const HEADING = "Set up recovery codes";

/** An unsigned access token carrying just the `sub` claim the prompt reads. */
function tokenFor(profileId: string): string {
  return `header.${btoa(JSON.stringify({ sub: profileId }))}.signature`;
}

function renderPrompt(token: Accessor<string>) {
  return render(() => (
    <MemoryRouter>
      <Route path="*" component={() => <RecoveryCodesPrompt accessToken={token()} />} />
    </MemoryRouter>
  ));
}

beforeEach(() => {
  localStorage.clear();
  client.getRecoveryCodesStatus.mockReset();
});

afterEach(() => cleanup());

describe("<RecoveryCodesPrompt />", () => {
  it("offers setup when the account has never generated a set", async () => {
    client.getRecoveryCodesStatus.mockResolvedValue({ active: 0, total: 0, generatedAt: null });
    renderPrompt(() => tokenFor("prof_1"));

    expect(await screen.findByText(HEADING)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Go to Security settings" });
    expect(link.getAttribute("href")).toBe("/settings#security");
  });

  it("stays quiet for an account that already has codes", async () => {
    client.getRecoveryCodesStatus.mockResolvedValue({
      active: 7,
      total: 10,
      generatedAt: 1_750_000_000,
    });
    renderPrompt(() => tokenFor("prof_1"));

    await vi.waitFor(() => expect(client.getRecoveryCodesStatus).toHaveBeenCalled());
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("stays quiet, and reaches no network, once dismissed on this device", async () => {
    localStorage.setItem("musubi:recovery-codes-prompt-dismissed:prof_1", "1");
    client.getRecoveryCodesStatus.mockResolvedValue({ active: 0, total: 0, generatedAt: null });
    renderPrompt(() => tokenFor("prof_1"));

    await Promise.resolve();
    expect(screen.queryByText(HEADING)).toBeNull();
    // A dismissed prompt must not spend a slot on a 30/min per-IP endpoint on
    // every page load for the rest of the account's life.
    expect(client.getRecoveryCodesStatus).not.toHaveBeenCalled();
  });

  it("hides on dismissal and records it for the signed-in profile", async () => {
    client.getRecoveryCodesStatus.mockResolvedValue({ active: 0, total: 0, generatedAt: null });
    renderPrompt(() => tokenFor("prof_1"));

    (await screen.findByRole("button", { name: "Dismiss" })).click();

    // The hide settles a tick after the click: dismissing empties the status
    // resource's source, and the resource leaves its ready state on the
    // microtask that follows.
    await waitFor(() => expect(screen.queryByText(HEADING)).toBeNull());
    expect(localStorage.getItem("musubi:recovery-codes-prompt-dismissed:prof_1")).toBe("1");
  });

  it("renders nothing when the status cannot be read", async () => {
    // A rate limit or a dropped connection must not turn into an offer of
    // codes to somebody who already has them — nor into a thrown resource, in
    // a component that renders in the application shell.
    client.getRecoveryCodesStatus.mockRejectedValue(new Error("Request failed: 429"));
    renderPrompt(() => tokenFor("prof_1"));

    await vi.waitFor(() => expect(client.getRecoveryCodesStatus).toHaveBeenCalled());
    expect(screen.queryByText(HEADING)).toBeNull();
  });

  it("asks the profile that is signed in now, not the one that was", async () => {
    // Switching profile swaps the access token without remounting anything:
    // `Show` in the shell compares truthiness only. Read once at mount, this
    // would show profile A's answer — and A's dismissal — to profile B.
    localStorage.setItem("musubi:recovery-codes-prompt-dismissed:prof_1", "1");
    client.getRecoveryCodesStatus.mockResolvedValue({ active: 0, total: 0, generatedAt: null });

    const [token, setToken] = createSignal(tokenFor("prof_1"));
    renderPrompt(token);

    await Promise.resolve();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(client.getRecoveryCodesStatus).not.toHaveBeenCalled();

    setToken(tokenFor("prof_2"));

    expect(await screen.findByText(HEADING)).toBeTruthy();
    expect(client.getRecoveryCodesStatus).toHaveBeenCalledWith({
      accessToken: tokenFor("prof_2"),
    });
  });

  it("stays quiet when the token carries no profile id", async () => {
    renderPrompt(() => "not-a-token");

    await Promise.resolve();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(client.getRecoveryCodesStatus).not.toHaveBeenCalled();
  });
});
