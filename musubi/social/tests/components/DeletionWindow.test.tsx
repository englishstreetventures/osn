// @vitest-environment happy-dom
import { AccountError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The window screen's refusals: a status read refused at 401 signs out, a
 * restore that comes too late says so and offers only Sign out, a failed
 * status read offers Try again. And a restore that goes through renews the
 * session, which brings the app back, with the toast; a status read that finds
 * nothing pending renews it too, and says the account is back if this screen
 * is still up after that.
 */

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  cancel: vi.fn(),
  renewSession: vi.fn<(options?: { pending?: boolean }) => Promise<void>>(),
  logout: vi.fn<() => Promise<void>>(),
  stepUps: [] as string[],
}));

vi.mock("../../src/lib/authClients", () => ({
  accountClient: {
    getAccountDeletionStatus: mocks.status,
    cancelAccountDeletion: mocks.cancel,
    exportAccount: vi.fn(),
    sendDataLink: vi.fn(),
  },
}));
vi.mock("../../src/components/StepUpSheet", () => ({
  default: (props: { purpose: string; onToken: (token: { token: string }) => void }) => {
    mocks.stepUps.push(props.purpose);
    queueMicrotask(() => props.onToken({ token: `tok-${mocks.stepUps.length}` }));
    return null;
  },
}));

import DeletionWindow from "../../src/components/DeletionWindow";
import { localDay } from "../../src/lib/account-deletion";

/** 23 November 2026, 09:00 UTC. */
const SCHEDULED_FOR = 1_795_424_400;

function renderWindow() {
  const value = {
    renewSession: mocks.renewSession,
    logout: mocks.logout,
    pendingDeletion: () => true,
  };
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={value as any}>
      <DeletionWindow />
    </AuthContext.Provider>
  ));
}

beforeEach(() => {
  mocks.status.mockReset();
  mocks.cancel.mockReset();
  mocks.renewSession.mockReset().mockResolvedValue(undefined);
  mocks.logout.mockReset().mockResolvedValue(undefined);
  mocks.stepUps.length = 0;
  vi.spyOn(toast, "success");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<DeletionWindow />", () => {
  it("shows the day the account is deleted on, in the reader's own terms, with no clock time", async () => {
    mocks.status.mockResolvedValue({
      scheduled: true,
      scheduledFor: SCHEDULED_FOR,
      softDeletedAt: SCHEDULED_FOR - 7 * 86_400,
    });
    renderWindow();
    const time = await waitFor(() => {
      const found = document.querySelector("time");
      if (!found) throw new Error("no date yet");
      return found;
    });
    const day = localDay(SCHEDULED_FOR);
    expect(time.getAttribute("datetime")).toBe(day.date);
    expect(time.closest("p")!.textContent).toBe(`We delete it on or shortly after ${day.words}.`);
    // Keeping is refused from the instant on, so the line under it ends at the day's start.
    expect(screen.getByText(/^Before that day, you can keep it\./)).toBeTruthy();
    expect(screen.queryByText(/Until/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Your account is set to be deleted" })).toBeTruthy();
  });

  it("signs out when the status read is refused at 401", async () => {
    mocks.status.mockRejectedValue(new AccountError("unauthorized", 401, "unauthorized"));
    renderWindow();
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledOnce());
  });

  it("says the date did not load, and Try again reads it again", async () => {
    mocks.status
      .mockRejectedValueOnce(new AccountError("server", 503, "temporarily_unavailable"))
      .mockResolvedValueOnce({ scheduled: true, scheduledFor: SCHEDULED_FOR, softDeletedAt: 0 });
    renderWindow();
    expect(await screen.findByText(/Your deletion date didn't load\./)).toBeTruthy();
    // No date on screen, so nothing says "that day"; and nothing offers the
    // keep up to the erasure, which can come hours after the window ends.
    expect(screen.queryByText(/that day/)).toBeNull();
    expect(screen.queryByText(/Until it is deleted/)).toBeNull();
    expect(screen.getByText(/You can keep it for 7 days after you asked\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(document.querySelector("time")).not.toBeNull());
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });

  it("says the account is back when nothing is pending and the renewal leaves this screen up", async () => {
    // Red on showing "didn't load" with no error behind it: the account was
    // kept from another device, and only the session has not caught up.
    mocks.status.mockResolvedValue({ scheduled: false });
    renderWindow();
    expect(await screen.findByRole("heading", { name: "Your account is back" })).toBeTruthy();
    expect(mocks.renewSession).toHaveBeenCalledWith();
    expect(screen.queryByText(/didn't load/)).toBeNull();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("keeps the account: steps up, restores, renews the session and says so", async () => {
    mocks.status.mockResolvedValue({
      scheduled: true,
      scheduledFor: SCHEDULED_FOR,
      softDeletedAt: 0,
    });
    mocks.cancel.mockResolvedValue({ cancelled: true });
    renderWindow();
    fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));

    await waitFor(() => expect(mocks.renewSession).toHaveBeenCalledOnce());
    expect(mocks.stepUps).toEqual(["account_restore"]);
    expect(mocks.cancel).toHaveBeenCalledWith({ stepUpToken: "tok-1" });
    expect(mocks.renewSession).toHaveBeenCalledWith();
    expect(toast.success).toHaveBeenCalledWith("Your account is back");
  });

  it("says it is too late when the restore answers cancelled: false, and offers only Sign out", async () => {
    mocks.status.mockResolvedValue({
      scheduled: true,
      scheduledFor: SCHEDULED_FOR,
      softDeletedAt: 0,
    });
    mocks.cancel.mockResolvedValue({ cancelled: false });
    renderWindow();
    fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));

    expect(
      await screen.findByRole("heading", { name: "It's too late to keep this account" }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Sign out"]);
    expect(mocks.renewSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it("brings the app back when cancelled: false means another device kept it first", async () => {
    // Red on reading every `cancelled: false` as too late: the account is
    // live, and this device would say it is being deleted.
    mocks.status
      .mockResolvedValueOnce({ scheduled: true, scheduledFor: SCHEDULED_FOR, softDeletedAt: 0 })
      .mockResolvedValueOnce({ scheduled: false });
    mocks.cancel.mockResolvedValue({ cancelled: false });
    renderWindow();
    fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));

    await waitFor(() => expect(mocks.renewSession).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("heading", { name: "It's too late to keep this account" }),
    ).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Your account is back");
  });

  it("says a refused restore failed, and stays", async () => {
    mocks.status.mockResolvedValue({
      scheduled: true,
      scheduledFor: SCHEDULED_FOR,
      softDeletedAt: 0,
    });
    mocks.cancel.mockRejectedValue(new AccountError("refused", 403, "step_up_required"));
    renderWindow();
    fireEvent.click(screen.getByRole("button", { name: "Keep my account" }));

    expect(
      await screen.findByText("Couldn't keep your account. Confirm it's you, then try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep my account" })).toBeTruthy();
    expect(mocks.renewSession).not.toHaveBeenCalled();
  });
});

/**
 * The screen on Musubi's `/authorize`, for a sign-in an app started: it hands
 * the page every ending (kept, signed out) instead of waiting for the shell to
 * swap, and every ending that leaves offers the way back to the app, so the
 * app hears the refusal a Cancel sends.
 */
describe("<DeletionWindow app={…} />", () => {
  function renderAppWindow() {
    const [session, setSession] = createSignal<unknown>({ accessToken: "pending" });
    const sessionResource = Object.assign(() => session(), { loading: false, error: undefined });
    const value = {
      session: sessionResource,
      renewSession: mocks.renewSession,
      logout: mocks.logout,
      pendingDeletion: () => true,
    };
    const back = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const onKept = vi.fn();
    const onSignedOut = vi.fn();
    render(() => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
      <AuthContext.Provider value={value as any}>
        <DeletionWindow app={{ name: "Cire", back }} onKept={onKept} onSignedOut={onSignedOut} />
      </AuthContext.Provider>
    ));
    return { back, onKept, onSignedOut, endSession: () => setSession(null) };
  }

  it("hands back to the page when nothing is pending any more, rather than asking for a reload", async () => {
    mocks.status.mockResolvedValue({ scheduled: false });
    const { onKept } = renderAppWindow();
    await waitFor(() => expect(onKept).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("offers the way back to the app when it is too late to keep the account", async () => {
    mocks.status.mockResolvedValue({
      scheduled: true,
      scheduledFor: SCHEDULED_FOR,
      softDeletedAt: 0,
    });
    mocks.cancel.mockResolvedValue({ cancelled: false });
    const { back, onKept } = renderAppWindow();
    fireEvent.click(await screen.findByRole("button", { name: "Keep my account" }));

    expect(
      await screen.findByRole("heading", { name: "It's too late to keep this account" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to Cire" }));
    await waitFor(() => expect(back).toHaveBeenCalledOnce());
    expect(onKept).not.toHaveBeenCalled();
  });

  it("hands back to the page when its session ends", async () => {
    mocks.status.mockResolvedValue({
      scheduled: true,
      scheduledFor: SCHEDULED_FOR,
      softDeletedAt: 0,
    });
    const { onSignedOut, endSession } = renderAppWindow();
    await screen.findByRole("button", { name: "Keep my account" });
    expect(onSignedOut).not.toHaveBeenCalled();
    endSession();
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledOnce());
  });
});
