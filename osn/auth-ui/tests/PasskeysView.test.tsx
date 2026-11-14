// @vitest-environment happy-dom
import {
  AuthExpiredError,
  type PasskeysClient,
  type StepUpClient,
  type StepUpToken,
} from "@osn/client";
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { Suspense } from "solid-js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { PasskeysView } from "../src/PasskeysView";
import {
  INPUT,
  PASSKEY_NOT_ADDED,
  SERVER,
  WAIT,
  alertsText,
  apiError,
  ceremonyError,
} from "./helpers/errors";
import { withoutAnimations } from "./helpers/motion";

// The step-up sheet closes at once, as under reduced motion, and hands its
// outcome over then (`helpers/motion.ts`).
withoutAnimations();

/**
 * Settings → Passkeys view. Covers the orchestration logic that
 * isn't exercised at the service / HTTP layer: list rendering, inline
 * rename, removal through the step-up sheet, and step-up threading into the delete
 * call. The `PasskeysClient` + `StepUpClient` are stubbed so we assert
 * on the wire-contract rather than real network calls.
 */

interface PasskeysStub {
  list: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  registerBegin: ReturnType<typeof vi.fn>;
  registerComplete: ReturnType<typeof vi.fn>;
}

interface StepUpStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  emailBegin: ReturnType<typeof vi.fn>;
  emailStatus: ReturnType<typeof vi.fn>;
  emailResend: ReturnType<typeof vi.fn>;
}

const makePasskeys = (): PasskeysStub => ({
  list: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
  registerBegin: vi.fn(),
  registerComplete: vi.fn(),
});

const makeStepUp = (): StepUpStub => ({
  passkeyBegin: vi.fn(),
  passkeyComplete: vi.fn(),
  emailBegin: vi.fn(),
  emailStatus: vi.fn(),
  emailResend: vi.fn(),
});

const asPasskeys = (s: PasskeysStub): PasskeysClient => s as unknown as PasskeysClient;
const asStepUp = (s: StepUpStub): StepUpClient => s as unknown as StepUpClient;

const stepUpToken: StepUpToken = { token: "stpup_xxx", expiresIn: 300 };

/**
 * Rename and delete both mint `passkey_delete`, and `passkeyDeleteAllowedAmr`
 * admits `webauthn` alone — so the step-up dialog offers no emailed code for
 * either. These tests used to drive that path because it needed no ceremony
 * runner; it minted a token the delete call would then have refused, so the
 * shortcut was rehearsing a dead end. They drive the passkey factor instead.
 *
 * The add-passkey tests below still use the emailed code, correctly: they mint
 * `passkey_register`, which admits `otp`.
 */
const assertion = {
  id: "cred",
  rawId: "cred",
  response: {
    clientDataJSON: "Y2xpZW50RGF0YQ",
    authenticatorData: "YXV0aERhdGE",
    signature: "c2ln",
  },
  clientExtensionResults: {},
  type: "public-key" as const,
};

/** Arms the step-up stubs so the passkey factor completes with `stepUpToken`. */
function armPasskeyStepUp(stub: StepUpStub) {
  stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
  stub.passkeyComplete.mockResolvedValue(stepUpToken);
}

const runPasskeyCeremony = () => Promise.resolve(assertion);

/** Clicks through the step-up dialog's passkey factor. */
async function useThePasskeyFactor() {
  await waitFor(() => screen.getByRole("button", { name: /Use passkey/i }));
  fireEvent.click(screen.getByRole("button", { name: /Use passkey/i }));
}

const passkeyRows = [
  {
    id: "pk_aaaaaaaaaaaa",
    label: "Work laptop",
    aaguid: null,
    transports: null,
    backupEligible: false,
    backupState: false,
    createdAt: 1_700_000_000,
    lastUsedAt: 1_700_005_000,
  },
  {
    id: "pk_bbbbbbbbbbbb",
    label: null,
    aaguid: null,
    transports: null,
    backupEligible: true,
    backupState: true,
    createdAt: 1_700_000_100,
    lastUsedAt: null,
  },
];

let pk: PasskeysStub;
let su: StepUpStub;

const LINK_REQUEST = {
  requestId: "stepup_0123456789ab",
  claimSecret: "c".repeat(64),
  pairingCode: "47",
  expiresAt: 1_900_000_000,
};

describe("PasskeysView", () => {
  beforeEach(() => {
    pk = makePasskeys();
    su = makeStepUp();
  });

  afterEach(() => cleanup());

  // A read under a host's Suspense boundary would hand the whole boundary to
  // the host's fallback; the view shows its own placeholder instead.
  it("holds its place under a host's Suspense while the list loads", async () => {
    pk.list.mockReturnValue(new Promise(() => {}));
    render(() => (
      <Suspense fallback={<p>HOST FALLBACK</p>}>
        <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />
      </Suspense>
    ));
    await waitFor(() => expect(pk.list).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByText("HOST FALLBACK")).toBeNull();
    expect(screen.getByRole("heading", { name: "Passkeys" })).toBeTruthy();
    const region = document.querySelector('[aria-busy="true"]');
    expect(region?.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it("renders the passkey list with user labels and friendly fallbacks", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    render(() => <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />);

    await waitFor(() => {
      // First row: user-provided label.
      expect(screen.getByText(/Work laptop/)).toBeTruthy();
      // Second row: null label + backupEligible → "Synced passkey" fallback.
      expect(screen.getByText(/Synced passkey/)).toBeTruthy();
      expect(screen.getAllByText(/\(synced\)/)).toHaveLength(1);
    });
  });

  it("renames via step-up: editor → save → step-up dialog → client.rename with stepUpToken", async () => {
    pk.list.mockResolvedValueOnce({ passkeys: passkeyRows });
    pk.list.mockResolvedValueOnce({
      passkeys: [{ ...passkeyRows[0]!, label: "Primary" }, passkeyRows[1]!],
    });
    pk.rename.mockResolvedValue({ success: true });
    armPasskeyStepUp(su);

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        runPasskeyCeremony={runPasskeyCeremony}
      />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Rename / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Rename / })[0]!);
    const input = screen.getByDisplayValue("Work laptop") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "  Primary  " } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await useThePasskeyFactor();

    await waitFor(() =>
      expect(pk.rename).toHaveBeenCalledWith({
        id: "pk_aaaaaaaaaaaa",
        label: "Primary",
        stepUpToken: stepUpToken.token,
      }),
    );
    expect(pk.list).toHaveBeenCalledTimes(2);
  });

  it("offers no emailed code for rename or delete", async () => {
    // Both mint `passkey_delete`, whose gate accepts `webauthn` alone. Offering
    // the emailed code here used to send a real code for an action the server
    // then refused — a dead end that looked like a working flow.
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        runPasskeyCeremony={runPasskeyCeremony}
      />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Remove / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove / })[0]!);
    await waitFor(() => screen.getByRole("button", { name: /Use passkey/i }));
    expect(screen.queryByRole("button", { name: /Email me a link/i })).toBeNull();
  });

  it("disables save when the draft label is empty / whitespace-only", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    render(() => <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />);

    await waitFor(() => screen.getAllByRole("button", { name: /^Rename / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Rename / })[0]!);

    const input = screen.getByDisplayValue("Work laptop") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "   " } });
    const save = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("delete flow: Remove → step-up → client.delete with stepUpToken → reload", async () => {
    pk.list.mockResolvedValueOnce({ passkeys: passkeyRows });
    pk.list.mockResolvedValueOnce({ passkeys: [passkeyRows[1]!] });
    pk.delete.mockResolvedValue({ success: true, remaining: 1 });
    armPasskeyStepUp(su);

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        runPasskeyCeremony={runPasskeyCeremony}
      />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Remove / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove / })[0]!);

    await useThePasskeyFactor();

    await waitFor(() =>
      expect(pk.delete).toHaveBeenCalledWith({
        id: "pk_aaaaaaaaaaaa",
        stepUpToken: stepUpToken.token,
      }),
    );
    // Reload after delete.
    expect(pk.list).toHaveBeenCalledTimes(2);
  });

  // The deleted row stays on screen until the list is read again; acting on it
  // then would run a whole step-up for a passkey that is gone.
  it("locks every row's actions while the list is read again after a delete", async () => {
    pk.list.mockResolvedValueOnce({ passkeys: passkeyRows });
    pk.list.mockReturnValueOnce(new Promise(() => {}));
    pk.delete.mockResolvedValue({ success: true, remaining: 1 });
    armPasskeyStepUp(su);

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        profileId="prof_1"
        runPasskeyCeremony={runPasskeyCeremony}
        runPasskeyRegistration={() => new Promise(() => {})}
      />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Remove / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove / })[0]!);
    await useThePasskeyFactor();
    await waitFor(() => expect(pk.list).toHaveBeenCalledTimes(2));

    const actions = [
      ...screen.getAllByRole("button", { name: /^Rename / }),
      ...screen.getAllByRole("button", { name: /^Remove / }),
      screen.getByRole("button", { name: "Add a passkey" }),
    ] as HTMLButtonElement[];
    expect(actions).toHaveLength(5);
    for (const b of actions) expect(b.disabled).toBe(true);
  });

  it("asks before a removal in the step-up sheet, named and described by the removal, never window.confirm", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        runPasskeyCeremony={runPasskeyCeremony}
      />
    ));

    await waitFor(() => screen.getByRole("button", { name: "Remove Work laptop" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Work laptop" }));

    const sheet = await waitFor(() => screen.getByRole("dialog", { name: "Remove Work laptop?" }));
    const described = (sheet.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain("You'll need another credential to sign in.");
    expect(confirm).not.toHaveBeenCalled();
    // Nothing red commits it: the factor does.
    expect(screen.queryByRole("button", { name: /^(Remove|Delete)$/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pk.delete).not.toHaveBeenCalled();
    expect(su.passkeyBegin).not.toHaveBeenCalled();
  });

  it("names each row's actions by its passkey, so two rows never share a name", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    render(() => <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />);

    await waitFor(() => screen.getByRole("button", { name: "Remove Work laptop" }));
    expect(screen.getByRole("button", { name: "Remove Synced passkey" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename Work laptop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename Synced passkey" })).toBeTruthy();
  });

  it("shows a refused rename under the rename field, tied to it, never the error's text", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    pk.rename.mockRejectedValue(apiError("PLANTED Passkey not found"));
    armPasskeyStepUp(su);

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        runPasskeyCeremony={runPasskeyCeremony}
      />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Rename / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Rename / })[0]!);
    const input = screen.getByDisplayValue("Work laptop") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "New label" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // Drive the step-up to actually fire the rename call.
    await useThePasskeyFactor();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(INPUT);
    expect(alertsText()).not.toContain("PLANTED");
    const field = screen.getByDisplayValue("New label");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("reads a refused delete as the map's sentence", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    pk.delete.mockRejectedValue(apiError("PLANTED-delete", 429, "rate_limited"));
    armPasskeyStepUp(su);

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        runPasskeyCeremony={runPasskeyCeremony}
      />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Remove / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove / })[0]!);
    await useThePasskeyFactor();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(WAIT);
    expect(alertsText()).not.toContain("PLANTED");
  });

  describe("a list that fails to load", () => {
    it("says so with a Try again that reloads it, and keeps the view", async () => {
      pk.list
        .mockRejectedValueOnce(apiError("PLANTED-list", 500, "internal_error"))
        .mockResolvedValueOnce({ passkeys: passkeyRows });
      render(() => <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />);

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Your passkeys didn't load.");
      // The map's 5xx sentence would only repeat the lead beside a Try again.
      expect(alert.textContent).not.toContain(SERVER);
      expect(alertsText()).not.toContain("PLANTED");
      expect(screen.getByRole("heading", { name: "Passkeys" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => screen.getAllByRole("button", { name: /^Rename / }));
      expect(pk.list).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("names the wait on a 429", async () => {
      pk.list.mockRejectedValue(apiError("PLANTED-list-429", 429, "rate_limited"));
      render(() => <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(WAIT);
    });

    // A 401 from the server, or the client's own word that renewal failed.
    it.each([
      ["a 401", apiError("PLANTED-list-401", 401, "unauthorized")],
      ["an AuthExpiredError", new AuthExpiredError({ cause: new Error("PLANTED-expired") })],
    ])("offers no Try again once the session has ended (%s)", async (_, error) => {
      pk.list.mockRejectedValue(error);
      render(() => <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Your session has ended. Sign in again.");
      expect(alertsText()).not.toContain("PLANTED");
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    });
  });

  it("hides the Add-passkey button when profileId / runPasskeyRegistration are missing", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    render(() => <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />);
    await waitFor(() => screen.getAllByRole("button", { name: /^Rename / }));
    expect(screen.queryByRole("button", { name: /Add a passkey/i })).toBeNull();
  });

  it("add-passkey flow: step-up → registerBegin(stepUpToken) → browser ceremony → registerComplete → reload", async () => {
    pk.list.mockResolvedValueOnce({ passkeys: passkeyRows });
    pk.list.mockResolvedValueOnce({
      passkeys: [
        ...passkeyRows,
        {
          id: "pk_ccccccccccccc",
          label: null,
          aaguid: null,
          transports: null,
          backupEligible: false,
          backupState: false,
          createdAt: 1_700_001_000,
          lastUsedAt: null,
        },
      ],
    });
    pk.registerBegin.mockResolvedValue({ challenge: "chal" });
    pk.registerComplete.mockResolvedValue({ passkeyId: "pk_ccccccccccccc" });
    su.emailBegin.mockResolvedValue(LINK_REQUEST);
    su.emailStatus.mockResolvedValue({ status: "complete", token: stepUpToken });

    const runRegistration = vi.fn().mockResolvedValue({ id: "cred_abc" });

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        profileId="prof_123"
        runPasskeyRegistration={runRegistration}
      />
    ));

    await waitFor(() => screen.getByRole("button", { name: /Add a passkey/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));

    // Step-up dialog — use OTP factor.
    await waitFor(() => screen.getByRole("button", { name: /Email me a link/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a link/i }));
    await screen.findByRole("heading", { name: "Check your email" });
    // The link is confirmed elsewhere; coming back to the tab polls at once.
    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(pk.registerBegin).toHaveBeenCalledWith({
        profileId: "prof_123",
        stepUpToken: stepUpToken.token,
      }),
    );
    expect(runRegistration).toHaveBeenCalledWith({ challenge: "chal" });
    await waitFor(() =>
      expect(pk.registerComplete).toHaveBeenCalledWith({
        profileId: "prof_123",
        attestation: { id: "cred_abc" },
      }),
    );
    // Reload after add.
    await waitFor(() => expect(pk.list).toHaveBeenCalledTimes(2));
  });

  it("reads a refused add as the adding sentence, never the error's text", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    pk.registerBegin.mockRejectedValue(apiError("PLANTED Attestation rejected"));
    su.emailBegin.mockResolvedValue(LINK_REQUEST);
    su.emailStatus.mockResolvedValue({ status: "complete", token: stepUpToken });

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        profileId="prof_123"
        runPasskeyRegistration={vi.fn()}
      />
    ));

    await waitFor(() => screen.getByRole("button", { name: /Add a passkey/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
    await waitFor(() => screen.getByRole("button", { name: /Email me a link/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a link/i }));
    await screen.findByRole("heading", { name: "Check your email" });
    // The link is confirmed elsewhere; coming back to the tab polls at once.
    window.dispatchEvent(new Event("focus"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("We couldn't add that passkey. Try again.");
    expect(alertsText()).not.toContain("PLANTED");
    expect(pk.registerComplete).not.toHaveBeenCalled();
  });

  // Most likely real-world failure shape — the user dismisses the
  // browser's WebAuthn prompt. registerBegin already resolved, so we must
  // surface the error AND release the `busy` / `pending` lock so the Add
  // button is clickable again.
  it("re-enables Add passkey after the browser ceremony is cancelled", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    pk.registerBegin.mockResolvedValue({ challenge: "chal" });
    su.emailBegin.mockResolvedValue(LINK_REQUEST);
    su.emailStatus.mockResolvedValue({ status: "complete", token: stepUpToken });
    const runRegistration = vi
      .fn()
      .mockRejectedValue(ceremonyError("NotAllowedError", "PLANTED-add-ceremony"));

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        profileId="prof_123"
        runPasskeyRegistration={runRegistration}
      />
    ));

    await waitFor(() => screen.getByRole("button", { name: /Add a passkey/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
    await waitFor(() => screen.getByRole("button", { name: /Email me a link/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a link/i }));
    await screen.findByRole("heading", { name: "Check your email" });
    // The link is confirmed elsewhere; coming back to the tab polls at once.
    window.dispatchEvent(new Event("focus"));

    // The adding ceremony's sentence, not the signing-in one.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(PASSKEY_NOT_ADDED);
    expect(alertsText()).not.toContain("PLANTED");
    expect(pk.registerComplete).not.toHaveBeenCalled();
    // finally-block cleanup: the Add button must be clickable again.
    const addButton = screen.getByRole("button", {
      name: /Add a passkey/i,
    }) as HTMLButtonElement;
    await waitFor(() => expect(addButton.disabled).toBe(false));
  });

  // The step-up lock must cover the Add button too — a rename/delete
  // step-up in flight must not allow a second ceremony to kick off.
  it("disables Add passkey while a rename/delete step-up is in flight (T-S1)", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        profileId="prof_123"
        runPasskeyRegistration={vi.fn()}
      />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Remove / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove / })[0]!);
    // "Use passkey" is the dialog-is-open signal: it is the one factor every
    // ceremony offers.
    await waitFor(() => screen.getByRole("button", { name: /Use passkey/i }));

    const addButton = screen.getByRole("button", {
      name: /Add a passkey/i,
    }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
  });

  // passkeyOnly: a host that cannot deliver mail. A removal still waits for
  // the person to press the passkey factor under its warning.
  it("passkeyOnly: a removal waits for the passkey press and offers no link", async () => {
    pk.list.mockResolvedValueOnce({ passkeys: passkeyRows });
    pk.list.mockResolvedValueOnce({ passkeys: [passkeyRows[1]!] });
    pk.delete.mockResolvedValue({ success: true, remaining: 1 });
    armPasskeyStepUp(su);
    const runCeremony = vi.fn().mockResolvedValue(assertion);

    render(() => (
      <PasskeysView
        client={asPasskeys(pk)}
        stepUpClient={asStepUp(su)}
        passkeyOnly
        runPasskeyCeremony={runCeremony}
      />
    ));

    await waitFor(() => screen.getByRole("button", { name: "Remove Work laptop" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Work laptop" }));
    await waitFor(() => screen.getByRole("dialog", { name: "Remove Work laptop?" }));
    expect(runCeremony).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Email me a link/i })).toBeNull();

    await useThePasskeyFactor();
    await waitFor(() =>
      expect(pk.delete).toHaveBeenCalledWith({
        id: "pk_aaaaaaaaaaaa",
        stepUpToken: stepUpToken.token,
      }),
    );
    expect(su.emailBegin).not.toHaveBeenCalled();
  });

  // While a step-up is in flight, every Rename / Delete button on the
  // page is disabled to prevent a rapid double-click swapping the pending id.
  it("locks every Rename/Delete button while a step-up is in flight (S-L1)", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });

    render(() => <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} />);

    await waitFor(() => screen.getAllByRole("button", { name: /^Remove / }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Remove / })[0]!);
    // Step-up dialog open — every Rename + Delete button on the list rows
    // must be disabled.
    await waitFor(() => screen.getByRole("button", { name: /Use passkey/i }));
    const renameButtons = screen.getAllByRole("button", { name: /^Rename / });
    const deleteButtons = screen.getAllByRole("button", { name: /^Remove / });
    for (const b of [...renameButtons, ...deleteButtons]) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
