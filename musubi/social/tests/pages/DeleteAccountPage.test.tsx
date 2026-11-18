// @vitest-environment happy-dom
import {
  AccountDeletionRefusedError,
  AccountError,
  type AccountDeletionOpenAction,
  type AccountDeletionPreview,
} from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where each refusal of `DELETE /account` lands, and what the deletion sends.
 *
 * The account client and the step-up sheet are stand-ins: the sheet hands
 * over a token at once (`tok-1`, `tok-2`, … in the order asked), so each test
 * drives the page from step 1 to "Delete my account" and reads where the
 * server's answer puts the person.
 */

const mocks = vi.hoisted(() => ({
  preview: vi.fn<() => Promise<AccountDeletionPreview>>(),
  deleteAccount: vi.fn(),
  renewSession: vi.fn<(options?: { pending?: boolean }) => Promise<void>>(),
  logout: vi.fn<() => Promise<void>>(),
  openDialog: vi.fn(),
  stepUps: [] as string[],
}));

vi.mock("../../src/lib/authClients", () => ({
  accountClient: {
    getAccountDeletionPreview: mocks.preview,
    deleteAccount: mocks.deleteAccount,
    exportAccount: vi.fn(),
    sendDataLink: vi.fn(),
  },
}));
vi.mock("../../src/components/StepUpSheet", () => ({
  default: (props: { purpose: string; onToken: (token: { token: string }) => void }) => {
    mocks.stepUps.push(props.purpose);
    const token = `tok-${mocks.stepUps.length}`;
    queueMicrotask(() => props.onToken({ token }));
    return null;
  },
}));
vi.mock("../../src/components/ShellDialogs", () => ({
  useShellDialogs: () => ({
    open: mocks.openDialog,
    load: () => Promise.resolve(),
    ready: () => true,
  }),
}));

import { DeleteAccountPage } from "../../src/pages/DeleteAccountPage";

const ORG: AccountDeletionOpenAction = {
  id: "osn:organisation:org_acme",
  app: "osn",
  kind: "organisation_owned",
  label: "You own Acme (@acme).",
  choices: [
    { choice: "transfer", description: "@bob becomes the owner.", erased_on: null },
    { choice: "successor", description: "The member you name becomes the owner.", erased_on: null },
    {
      choice: "delete",
      description: "The organisation and its memberships are deleted.",
      erased_on: null,
    },
  ],
  default_choice: null,
  link: null,
  organisation: { id: "org_acme", handle: "acme", name: "Acme" },
  successor: { profile_id: "usr_bob", handle: "bob", display_name: "Bob", role: "member" },
  candidates: [
    { profile_id: "usr_bob", handle: "bob", display_name: "Bob", role: "member" },
    { profile_id: "usr_carol", handle: "carol", display_name: null, role: "member" },
  ],
};

const WEDDING_WORDS =
  "Deleted with its guests, replies and invite when your account is deleted. Download its guest list and other exports from Cire first if you want a copy.";

const WEDDING: AccountDeletionOpenAction = {
  id: "cire:wedding:w_1",
  app: "cire",
  kind: "wedding_sole_owner",
  label:
    "You are the only owner of “Sam & Alex”. Add another owner in Cire to keep it, or it is deleted when your account is.",
  choices: [{ choice: "delete", description: WEDDING_WORDS, erased_on: null }],
  default_choice: null,
  link: "https://host.cire.example/#/w/w_1/settings/hosts",
};

const EVENT: AccountDeletionOpenAction = {
  id: "pulse:event:ev_1",
  app: "pulse",
  kind: "events_hosted",
  label: "You host “Picnic”, starting 1 December 2026.",
  choices: [
    {
      choice: "cancel",
      description:
        "Cancelled when your account is deleted. Its guests see it as cancelled for 14 days; then it is deleted.",
      erased_on: 1_796_000_000,
    },
    {
      choice: "delete",
      description: "Deleted when your account is deleted, with its guest list and messages.",
      erased_on: null,
    },
  ],
  default_choice: "cancel",
  link: null,
};

const preview = (
  open_actions: AccountDeletionOpenAction[],
  could_not_check: string[] = [],
): AccountDeletionPreview => ({ open_actions, could_not_check });

/** An unsigned access token carrying the claims the page reads. */
const ACCESS_TOKEN = `header.${btoa(JSON.stringify({ sub: "usr_alice", handle: "alice" }))}.sig`;

function authValue() {
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  return {
    session: resource({ accessToken: ACCESS_TOKEN, idToken: null, expiresAt: 0, scopes: [] }),
    profiles: resource([]),
    activeProfileId: () => "usr_alice",
    pendingDeletion: () => false,
    renewSession: mocks.renewSession,
    logout: mocks.logout,
  };
}

function renderPage() {
  const history = createMemoryHistory();
  history.set({ value: "/settings/delete-account" });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path="/settings/delete-account" component={DeleteAccountPage} />
        <Route path="/settings" component={() => <p>Settings page</p>} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
  return history;
}

const button = (name: string) => screen.getByRole("button", { name });

/** Step 1 → step 2, once the preview has landed. */
async function toAnswers() {
  fireEvent.click(button("Continue"));
  await screen.findByRole("heading", { name: "What needs an answer" });
  await waitFor(() => expect(button("Continue").hasAttribute("disabled")).toBe(false));
}

/** Step 2 → step 3. */
async function toConfirm() {
  fireEvent.click(button("Continue"));
  await screen.findByRole("heading", { name: "Confirm" });
}

/** Types the handle and presses "Delete my account". */
function submit(handle = "alice") {
  fireEvent.input(screen.getByLabelText("Your handle"), { target: { value: handle } });
  fireEvent.click(button("Delete my account"));
}

/** The card of the open action whose label is `label`. */
function card(label: string): HTMLElement {
  return screen.getByText(label).closest<HTMLElement>("[data-action]")!;
}

function radio(label: string) {
  return screen.getByRole("radio", { name: label }) as HTMLInputElement;
}

beforeEach(() => {
  mocks.preview.mockReset();
  mocks.deleteAccount.mockReset();
  mocks.renewSession.mockReset().mockResolvedValue(undefined);
  mocks.logout.mockReset().mockResolvedValue(undefined);
  mocks.openDialog.mockReset();
  mocks.stepUps.length = 0;
});

afterEach(() => cleanup());

describe("<DeleteAccountPage /> sends", () => {
  it("deleteEverything and no choices when Delete everything is on", async () => {
    mocks.preview.mockResolvedValue(preview([ORG, WEDDING]));
    mocks.deleteAccount.mockResolvedValue({ scheduled_for: 1, already_pending: false });
    renderPage();
    await toAnswers();

    // An answer given before the box is not sent while it is ticked.
    fireEvent.click(radio("The organisation and its memberships are deleted."));
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete everything" }));
    expect(radio("@bob becomes the owner.").disabled).toBe(true);
    await toConfirm();
    submit();

    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledOnce());
    const sent = mocks.deleteAccount.mock.calls[0]![0];
    expect(sent).toEqual({ confirmHandle: "alice", stepUpToken: "tok-1", deleteEverything: true });
    expect(sent).not.toHaveProperty("choices");
    expect(mocks.stepUps).toEqual(["account_delete"]);
    expect(mocks.renewSession).toHaveBeenCalledWith({ pending: true });
  });

  it("the member named with a successor answer, and no answer for an action left at its default", async () => {
    mocks.preview.mockResolvedValue(preview([ORG, WEDDING, EVENT]));
    mocks.deleteAccount.mockResolvedValue({ scheduled_for: 1, already_pending: false });
    renderPage();
    await toAnswers();

    fireEvent.click(radio("The member you name becomes the owner."));
    fireEvent.change(screen.getByLabelText("New owner"), { target: { value: "usr_carol" } });
    fireEvent.click(screen.getByRole("checkbox", { name: WEDDING_WORDS }));
    await toConfirm();
    submit();

    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledOnce());
    expect(mocks.deleteAccount.mock.calls[0]![0]).toEqual({
      confirmHandle: "alice",
      stepUpToken: "tok-1",
      choices: [
        { action: ORG.id, choice: "successor", successorProfileId: "usr_carol" },
        { action: WEDDING.id, choice: "delete" },
      ],
    });
  });
});

describe("<DeleteAccountPage /> refuses before sending", () => {
  it("marks an action that needs an answer and stays on step 2", async () => {
    mocks.preview.mockResolvedValue(preview([ORG, WEDDING]));
    renderPage();
    await toAnswers();
    fireEvent.click(radio("@bob becomes the owner."));
    fireEvent.click(button("Continue"));

    expect(screen.getByRole("heading", { name: "What needs an answer" })).toBeTruthy();
    expect(within(card(WEDDING.label)).getByText("Choose what happens to this.")).toBeTruthy();
    expect(within(card(ORG.label)).queryByText("Choose what happens to this.")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: WEDDING_WORDS }));
  });

  it("asks for the member a successor answer names", async () => {
    mocks.preview.mockResolvedValue(preview([ORG]));
    renderPage();
    await toAnswers();
    fireEvent.click(radio("The member you name becomes the owner."));
    fireEvent.click(button("Continue"));

    expect(await screen.findByText("Choose who becomes the owner.")).toBeTruthy();
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });

  it("says the handle does not match, and sends nothing", async () => {
    mocks.preview.mockResolvedValue(preview([]));
    renderPage();
    await toAnswers();
    expect(screen.getByText("Nothing else needs an answer.")).toBeTruthy();
    await toConfirm();
    submit("bob");

    expect(
      await screen.findByText("The handle you typed doesn't match. Check it and try again."),
    ).toBeTruthy();
    expect(mocks.stepUps).toEqual([]);
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
  });
});

describe("<DeleteAccountPage /> lands each refusal", () => {
  it("409 open_actions: back to step 2 with the actions marked", async () => {
    mocks.preview.mockResolvedValue(preview([EVENT]));
    mocks.deleteAccount.mockRejectedValue(
      new AccountDeletionRefusedError(409, "open_actions", { openActions: [WEDDING] }),
    );
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    expect(await screen.findByRole("heading", { name: "What needs an answer" })).toBeTruthy();
    expect(screen.getByText("Answer the items marked below before you go on.")).toBeTruthy();
    expect(within(card(WEDDING.label)).getByText("Choose what happens to this.")).toBeTruthy();
    expect(within(card(EVENT.label)).queryByText("Choose what happens to this.")).toBeNull();
    expect(mocks.renewSession).not.toHaveBeenCalled();
  });

  it("409 stale_choices: step 2 with the fresh preview, answers kept where the action stands", async () => {
    mocks.preview.mockResolvedValue(preview([ORG, WEDDING]));
    mocks.deleteAccount
      .mockRejectedValueOnce(
        new AccountDeletionRefusedError(409, "stale_choices", { preview: preview([ORG, EVENT]) }),
      )
      .mockResolvedValueOnce({ scheduled_for: 1, already_pending: false });
    renderPage();
    await toAnswers();
    fireEvent.click(radio("The organisation and its memberships are deleted."));
    fireEvent.click(screen.getByRole("checkbox", { name: WEDDING_WORDS }));
    await toConfirm();
    submit();

    expect(
      await screen.findByText("Something changed since you last looked. Check your answers below."),
    ).toBeTruthy();
    expect(screen.queryByText(WEDDING.label)).toBeNull();
    expect(screen.getByText(EVENT.label)).toBeTruthy();
    expect(radio("The organisation and its memberships are deleted.").checked).toBe(true);

    await toConfirm();
    submit();
    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledTimes(2));
    expect(mocks.deleteAccount.mock.calls[1]![0].choices).toEqual([
      { action: ORG.id, choice: "delete" },
    ]);
  });

  it("409 could_not_check: the blocked state, naming each app, with Try again", async () => {
    mocks.preview.mockResolvedValueOnce(preview([])).mockResolvedValueOnce(preview([WEDDING]));
    mocks.deleteAccount.mockRejectedValue(
      new AccountDeletionRefusedError(409, "could_not_check", {
        preview: preview([], ["cire", "pulse"]),
      }),
    );
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    const line = await screen.findByText(/Cire and Pulse didn't answer/);
    expect(line.textContent).toContain("Your account can't be deleted until they do.");
    expect(button("Continue").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("Nothing else needs an answer.")).toBeNull();

    fireEvent.click(button("Try again"));
    expect(await screen.findByText(WEDDING.label)).toBeTruthy();
    expect(screen.queryByText(/didn't answer/)).toBeNull();
    expect(button("Continue").hasAttribute("disabled")).toBe(false);
  });

  it("400 invalid_choice: step 2 with that action marked and its answer taken back", async () => {
    mocks.preview.mockResolvedValue(preview([ORG, WEDDING]));
    mocks.deleteAccount.mockRejectedValue(
      new AccountDeletionRefusedError(400, "invalid_choice", { action: ORG.id }),
    );
    renderPage();
    await toAnswers();
    fireEvent.click(radio("@bob becomes the owner."));
    fireEvent.click(screen.getByRole("checkbox", { name: WEDDING_WORDS }));
    await toConfirm();
    submit();

    expect(
      await screen.findByText("One of your answers can't be used now. Choose again below."),
    ).toBeTruthy();
    expect(
      within(card(ORG.label)).getByText("That answer can't be used now. Choose again."),
    ).toBeTruthy();
    expect(radio("@bob becomes the owner.").checked).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: WEDDING_WORDS }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("400 choices_with_delete_everything: back to step 2", async () => {
    mocks.preview.mockResolvedValue(preview([EVENT]));
    mocks.deleteAccount.mockRejectedValue(
      new AccountError("refused", 400, "choices_with_delete_everything"),
    );
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    expect(await screen.findByRole("heading", { name: "What needs an answer" })).toBeTruthy();
    expect(
      screen.getByText("Your answers couldn't be used. Check them and try again."),
    ).toBeTruthy();
  });

  it("400 handle_mismatch: the handle field's error, on step 3", async () => {
    mocks.preview.mockResolvedValue(preview([]));
    mocks.deleteAccount.mockRejectedValue(new AccountError("refused", 400, "handle_mismatch"));
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    expect(
      await screen.findByText("The handle you typed doesn't match. Check it and try again."),
    ).toBeTruthy();
    expect(screen.getByLabelText("Your handle").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("heading", { name: "Confirm" })).toBeTruthy();
  });

  it("403 step_up_required: steps up again and sends the new token", async () => {
    mocks.preview.mockResolvedValue(preview([]));
    mocks.deleteAccount
      .mockRejectedValueOnce(new AccountError("refused", 403, "step_up_required"))
      .mockResolvedValueOnce({ scheduled_for: 1, already_pending: false });
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    await waitFor(() => expect(mocks.deleteAccount).toHaveBeenCalledTimes(2));
    expect(mocks.stepUps).toEqual(["account_delete", "account_delete"]);
    expect(mocks.deleteAccount.mock.calls[1]![0].stepUpToken).toBe("tok-2");
    await waitFor(() => expect(mocks.renewSession).toHaveBeenCalledWith({ pending: true }));
  });

  it("409 session_stale: says to sign in again, and Sign in again signs out and opens sign-in", async () => {
    mocks.preview.mockResolvedValue(preview([]));
    mocks.deleteAccount.mockRejectedValue(new AccountError("refused", 409, "session_stale"));
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    expect(
      await screen.findByText(/For your security, sign in again to finish this\./),
    ).toBeTruthy();
    fireEvent.click(button("Sign in again"));
    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalledWith("sign-in"));
    expect(mocks.logout).toHaveBeenCalledOnce();
  });

  it("429: says to wait, and stays on step 3", async () => {
    mocks.preview.mockResolvedValue(preview([]));
    mocks.deleteAccount.mockRejectedValue(new AccountError("limited", 429, "rate_limited"));
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    expect(
      await screen.findByText("Too many attempts. Wait a while, then try again."),
    ).toBeTruthy();
    expect(button("Delete my account")).toBeTruthy();
  });

  it("no answer, then a server error: says so each time, and the button tries again", async () => {
    mocks.preview.mockResolvedValue(preview([]));
    mocks.deleteAccount
      .mockRejectedValueOnce(new AccountError("no answer", 0))
      .mockRejectedValueOnce(new AccountError("server", 503, "temporarily_unavailable"));
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    expect(
      await screen.findByText("We couldn't connect. Check your connection and try again."),
    ).toBeTruthy();
    fireEvent.click(button("Delete my account"));
    expect(await screen.findByText("Something went wrong on our side. Try again.")).toBeTruthy();
    expect(mocks.stepUps).toEqual(["account_delete", "account_delete"]);
  });

  it("already_pending: turns the session pending, as a new deletion does", async () => {
    mocks.preview.mockResolvedValue(preview([]));
    mocks.deleteAccount.mockResolvedValue({ scheduled_for: 1, already_pending: true });
    renderPage();
    await toAnswers();
    await toConfirm();
    submit();

    await waitFor(() => expect(mocks.renewSession).toHaveBeenCalledWith({ pending: true }));
  });
});

describe("<DeleteAccountPage /> when a read or the renewal fails", () => {
  it("a preview that did not load says so, and Try again loads it", async () => {
    mocks.preview
      .mockRejectedValueOnce(new AccountError("server", 503, "temporarily_unavailable"))
      .mockResolvedValue(preview([WEDDING]));
    renderPage();
    fireEvent.click(button("Continue"));
    await screen.findByRole("heading", { name: "What needs an answer" });

    expect(await screen.findByText(/didn't load/)).toBeTruthy();
    expect(button("Continue").hasAttribute("disabled")).toBe(true);
    fireEvent.click(button("Try again"));

    expect(await screen.findByText(WEDDING.label)).toBeTruthy();
    expect(mocks.preview).toHaveBeenCalledTimes(2);
  });
});
