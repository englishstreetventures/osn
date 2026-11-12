// @vitest-environment happy-dom
import type { StepUpClient, StepUpPurpose, StepUpToken, TotpClient } from "@osn/client";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { createSignal, onMount, Show, Suspense } from "solid-js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { StepUpDialog, type StepUpDialogProps } from "../src/StepUpDialog";
import { codeBoxes, enterCode, expectTied, findCodeBoxes } from "./helpers/code";
import {
  CODE,
  PASSKEY_NOT_USED,
  WAIT,
  alertsText,
  apiError,
  ceremonyError,
} from "./helpers/errors";
import { exitThatNeverEnds, withoutAnimations } from "./helpers/motion";

interface ClientStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  emailBegin: ReturnType<typeof vi.fn>;
  emailStatus: ReturnType<typeof vi.fn>;
  emailResend: ReturnType<typeof vi.fn>;
  totpComplete: ReturnType<typeof vi.fn>;
}

function makeStub(): ClientStub {
  return {
    passkeyBegin: vi.fn(),
    passkeyComplete: vi.fn(),
    emailBegin: vi.fn(),
    emailStatus: vi.fn(),
    emailResend: vi.fn(),
    totpComplete: vi.fn(),
  };
}

const asClient = (s: ClientStub): StepUpClient => s as unknown as StepUpClient;

const LINK_REQUEST = {
  requestId: "stepup_0123456789ab",
  claimSecret: "c".repeat(64),
  pairingCode: "47",
  expiresAt: 1_900_000_000,
};

/**
 * A minimal but well-formed WebAuthn assertion. The dialog never reads a
 * field off it — it goes straight to `passkeyComplete` — so the values only
 * need to satisfy the shape the browser really returns.
 */
const assertion: AuthenticationResponseJSON = {
  id: "cred",
  rawId: "cred",
  response: {
    clientDataJSON: "Y2xpZW50RGF0YQ",
    authenticatorData: "YXV0aERhdGE",
    signature: "c2ln",
  },
  clientExtensionResults: {},
  type: "public-key",
};

let stub: ClientStub;

withoutAnimations();

// Module-level so every describe below gets a fresh stub, not only the first.
beforeEach(() => {
  stub = makeStub();
});
afterEach(() => cleanup());

/** A promise the test settles by hand. */
function held<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** Lets every queued promise callback run, and a `setTimeout(0)` after them. */
async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

/** Microtasks only, for a test whose `setTimeout` is faked. */
async function flushMicrotasks() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function pressEscape() {
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
}

const enrolled = (): TotpClient =>
  ({ status: vi.fn().mockResolvedValue({ enrolled: true }) }) as unknown as TotpClient;

/**
 * The buttons of the sheet named `title`, where two sheets are open at once.
 * Each modal marks the rest of the page `aria-hidden`, the other sheet
 * included, so every query here counts hidden elements: a query that skipped
 * them would find nothing in a hidden sheet and pass an absence check for the
 * wrong reason.
 */
function buttonsIn(title: string) {
  const sheet = () => within(screen.getByRole("dialog", { name: title, hidden: true }));
  return {
    get: (name: RegExp) => sheet().getByRole("button", { name, hidden: true }),
    query: (name: RegExp) => sheet().queryByRole("button", { name, hidden: true }),
  };
}

/** The sheet with the props most tests share; `overrides` wins. */
function renderSheet(overrides: Partial<StepUpDialogProps> = {}) {
  return render(() => (
    <StepUpDialog
      client={asClient(stub)}
      onToken={() => {}}
      onCancel={() => {}}
      runPasskeyCeremony={async () => assertion}
      {...overrides}
    />
  ));
}

describe("StepUpDialog", () => {
  it("email path: the wait shows the number, and the confirmed link's token reaches onToken", async () => {
    stub.emailBegin.mockResolvedValue(LINK_REQUEST);
    stub.emailStatus.mockResolvedValue({
      status: "complete",
      token: { token: "eyJlink", expiresIn: 300 },
    });

    const onToken = vi.fn();
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        purpose="account_export"
        onToken={onToken}
        onCancel={() => {}}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Use email instead/ }));
    await waitFor(() =>
      expect(stub.emailBegin).toHaveBeenCalledWith({ purpose: "account_export" }),
    );
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    expect(screen.getByText("47")).toBeTruthy();

    // Coming back to the tab polls at once.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(onToken).toHaveBeenCalledWith({ token: "eyJlink", expiresIn: 300 }));
    expect(stub.emailStatus).toHaveBeenCalledWith({
      requestId: LINK_REQUEST.requestId,
      claimSecret: LINK_REQUEST.claimSecret,
    });
  });

  // The button holds focus through the wait: `busy`, not `disabled`, and the
  // factors and Cancel beside it wait too.
  it("keeps Use email instead busy, not disabled, while it sends", async () => {
    stub.emailBegin.mockReturnValue(new Promise(() => {}));
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        purpose="account_export"
        onToken={() => {}}
        onCancel={() => {}}
        runPasskeyCeremony={async () => assertion}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /Use email instead/ }));
    const sending = await screen.findByRole("button", { name: "Sending…" });
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect((sending as HTMLButtonElement).disabled).toBe(false);
    const usePasskey = screen.getByRole("button", { name: "Use passkey" }) as HTMLButtonElement;
    expect(usePasskey.disabled).toBe(true);
    expect(usePasskey.getAttribute("aria-busy")).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(sending);
    await Promise.resolve();
    expect(stub.emailBegin).toHaveBeenCalledTimes(1);
  });

  it("passkey path: runs caller-supplied ceremony and exchanges the assertion", async () => {
    stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
    stub.passkeyComplete.mockResolvedValue({ token: "eyJpk", expiresIn: 300 });
    const runPasskey = vi.fn(async () => assertion);

    const onToken = vi.fn();
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        onToken={onToken}
        onCancel={() => {}}
        runPasskeyCeremony={runPasskey}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Use passkey/ }));
    await waitFor(() => expect(runPasskey).toHaveBeenCalled());
    await waitFor(() => expect(onToken).toHaveBeenCalledWith({ token: "eyJpk", expiresIn: 300 }));
  });

  it.each([
    ["a 400", apiError("PLANTED-totp"), CODE, "true"],
    ["a 429", apiError("PLANTED-totp-429", 429, "rate_limited"), WAIT, null],
  ] as const)(
    "an authenticator code refused with %s reads the map's sentence, tied to its boxes",
    async (_, error, sentence, invalid) => {
      stub.totpComplete.mockRejectedValue(error);
      render(() => (
        <StepUpDialog
          client={asClient(stub)}
          onToken={() => {}}
          onCancel={() => {}}
          totpClient={
            { status: vi.fn().mockResolvedValue({ enrolled: true }) } as unknown as TotpClient
          }
        />
      ));
      fireEvent.click(await screen.findByRole("button", { name: /Use your authenticator app/ }));
      const boxes = await enterCode("Code from your authenticator app", "123456");
      fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(sentence);
      expect(alertsText()).not.toContain("PLANTED");
      expectTied(boxes, alert.id, invalid);
    },
  );

  // Focus lands on the wait's heading, not on Cancel or the page, when the
  // email step opens inside the panel.
  it("puts focus on the wait's heading when the email step opens", async () => {
    stub.emailBegin.mockResolvedValue(LINK_REQUEST);
    stub.emailStatus.mockReturnValue(new Promise(() => {}));
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        purpose="account_export"
        onToken={() => {}}
        onCancel={() => {}}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /Use email instead/ }));
    const heading = await screen.findByRole("heading", { name: "Check your email" });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it("puts focus in box 1 when the authenticator step opens", async () => {
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        onToken={() => {}}
        onCancel={() => {}}
        totpClient={
          { status: vi.fn().mockResolvedValue({ enrolled: true }) } as unknown as TotpClient
        }
      />
    ));
    fireEvent.click(await screen.findByRole("button", { name: /Use your authenticator app/ }));
    const boxes = await findCodeBoxes("Code from your authenticator app");
    await waitFor(() => expect(document.activeElement).toBe(boxes[0]));
  });

  it("a passkey failure reads as the signing-in sentence, never the browser's text", async () => {
    stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
    const runPasskey = vi
      .fn()
      .mockRejectedValue(ceremonyError("NotAllowedError", "PLANTED-stepup"));
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        onToken={() => {}}
        onCancel={() => {}}
        runPasskeyCeremony={runPasskey}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /Use passkey/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(PASSKEY_NOT_USED);
    expect(alertsText()).not.toContain("PLANTED");
  });

  it("with no ceremony runner, says a passkey can't be used here and offers no retry", async () => {
    render(() => <StepUpDialog client={asClient(stub)} onToken={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Use passkey/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("A passkey can't be used here.");
    expect(alert.textContent).not.toMatch(/try again/i);
  });

  // passkeyOnly: the emailed-link factor is hidden entirely. Used where
  // transactional email is degraded (OSN_EMAIL_OPTIONAL=true), so an emailed
  // step-up would dead-end the user. The passkey ceremony starts immediately
  // on mount — no factor picker.
  it("passkeyOnly: hides the email option and auto-starts the passkey ceremony", async () => {
    stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
    stub.passkeyComplete.mockResolvedValue({ token: "eyJpk", expiresIn: 300 });
    const runPasskey = vi.fn(async () => assertion);
    const onToken = vi.fn();

    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        onToken={onToken}
        onCancel={() => {}}
        runPasskeyCeremony={runPasskey}
        passkeyOnly
      />
    ));

    // No email affordance at all.
    expect(screen.queryByRole("button", { name: /Use email instead/i })).toBeNull();
    // Ceremony fires without the user clicking "Use passkey".
    await waitFor(() => expect(runPasskey).toHaveBeenCalled());
    await waitFor(() => expect(onToken).toHaveBeenCalledWith({ token: "eyJpk", expiresIn: 300 }));
    expect(stub.emailBegin).not.toHaveBeenCalled();
  });

  it("passkeyOnly: surfaces a retry affordance when the ceremony fails", async () => {
    stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
    const runPasskey = vi
      .fn()
      .mockRejectedValue(ceremonyError("NotAllowedError", "PLANTED-passkey-only"));

    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        onToken={() => {}}
        onCancel={() => {}}
        runPasskeyCeremony={runPasskey}
        passkeyOnly
      />
    ));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(PASSKEY_NOT_USED));
    expect(alertsText()).not.toContain("PLANTED");
    // A retry button is available (passkey factor, not the choose menu).
    expect(screen.getByRole("button", { name: /Try again|Use passkey/i })).toBeTruthy();
  });

  it("announces the failure rather than leaving it to be noticed", async () => {
    stub.emailBegin.mockRejectedValue(apiError("PLANTED Could not send code", 429, "rate_limited"));

    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        purpose="account_export"
        onToken={() => {}}
        onCancel={() => {}}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Use email instead/ }));
    // A step-up failure is why the user cannot proceed. Rendering it in a
    // coloured paragraph tells a sighted user only.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(WAIT);
    expect(alertsText()).not.toContain("PLANTED");
  });
});

/**
 * The authenticator-app factor.
 *
 * Two independent conditions gate it, and each fails differently if dropped:
 * the account must have a confirmed credential (otherwise the dialog offers a
 * factor that cannot produce a code), and the ceremony's own allow-list must
 * admit `totp` (otherwise it mints a token the gated call refuses). Both are
 * checked below.
 */
describe("StepUpDialog — authenticator app factor", () => {
  const TOTP_BUTTON = /Use your authenticator app/i;

  function totpStub(status: { enrolled: boolean } | Error) {
    return {
      status:
        status instanceof Error
          ? vi.fn().mockRejectedValue(status)
          : vi.fn().mockResolvedValue({
              enrolled: status.enrolled,
              label: "iPhone",
              lastUsedAt: null,
              createdAt: 1_700_000_000,
            }),
    };
  }

  const asTotp = (s: { status: ReturnType<typeof vi.fn> }): TotpClient =>
    s as unknown as TotpClient;

  function mount(overrides: {
    totp?: { status: ReturnType<typeof vi.fn> };
    purpose?: StepUpPurpose;
    passkeyOnly?: boolean;
    onToken?: (t: StepUpToken) => void;
  }) {
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        onToken={overrides.onToken ?? (() => {})}
        onCancel={() => {}}
        runPasskeyCeremony={async () => assertion}
        totpClient={overrides.totp ? asTotp(overrides.totp) : undefined}
        purpose={overrides.purpose}
        passkeyOnly={overrides.passkeyOnly}
      />
    ));
  }

  /**
   * Mounts the dialog under test beside one that DOES admit the
   * authenticator (enrolled, no error), and waits for that companion's
   * button to appear before returning the one under test.
   *
   * Asserting the factor's absence on its own — even inside `waitFor` —
   * cannot fail: whether it renders depends on the `GET /totp/status`
   * resource settling, and `waitFor`'s first check runs synchronously,
   * before that resource has had a single microtask to resolve. A
   * `queryByRole(...).toBeNull()` that is already true at that instant
   * resolves on the spot, whatever the guard would eventually decide — the
   * same failure mode a bare check has, just with extra ceremony. Both
   * dialogs' resources resolve on the same microtask cadence, so once the
   * admitting one has painted its button, the one under test has had its
   * chance too.
   */
  async function mountBesideAnAdmittingCeremony(overrides: {
    totp?: { status: ReturnType<typeof vi.fn> };
    purpose?: StepUpPurpose;
  }) {
    render(() => (
      <>
        <StepUpDialog
          client={asClient(stub)}
          onToken={() => {}}
          onCancel={() => {}}
          runPasskeyCeremony={async () => assertion}
          totpClient={asTotp(totpStub({ enrolled: true }))}
          purpose={overrides.purpose}
          title="Admits"
        />
        <StepUpDialog
          client={asClient(stub)}
          onToken={() => {}}
          onCancel={() => {}}
          runPasskeyCeremony={async () => assertion}
          totpClient={overrides.totp ? asTotp(overrides.totp) : undefined}
          purpose={overrides.purpose}
          title="Under test"
        />
      </>
    ));
    const admits = buttonsIn("Admits");
    await waitFor(() => expect(admits.get(TOTP_BUTTON)).toBeTruthy());
    return buttonsIn("Under test");
  }

  it("offers the factor when the account has a confirmed credential", async () => {
    mount({ totp: totpStub({ enrolled: true }), purpose: "recovery_generate" });
    expect(await screen.findByRole("button", { name: TOTP_BUTTON })).toBeTruthy();
  });

  it("hides the factor when the account has no confirmed credential", async () => {
    const underTest = await mountBesideAnAdmittingCeremony({
      totp: totpStub({ enrolled: false }),
      purpose: "recovery_generate",
    });
    expect(underTest.get(/Use passkey/i)).toBeTruthy();
    expect(underTest.query(TOTP_BUTTON)).toBeNull();
  });

  it("hides the factor when no TOTP client is supplied at all", async () => {
    mount({ purpose: "recovery_generate" });
    await waitFor(() => screen.getByRole("button", { name: /Use passkey/i }));
    expect(screen.queryByRole("button", { name: TOTP_BUTTON })).toBeNull();
  });

  // A read under a host's Suspense boundary would hand the whole boundary to
  // the host's fallback, step-up and all, until the status lands.
  it("holds its place under a host's Suspense while the status loads", async () => {
    const status = vi.fn().mockReturnValue(new Promise(() => {}));
    render(() => (
      <Suspense fallback={<p>HOST FALLBACK</p>}>
        <StepUpDialog
          client={asClient(stub)}
          onToken={() => {}}
          onCancel={() => {}}
          runPasskeyCeremony={async () => assertion}
          totpClient={asTotp({ status })}
          purpose="recovery_generate"
        />
      </Suspense>
    ));
    await waitFor(() => expect(status).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByText("HOST FALLBACK")).toBeNull();
    expect(screen.getByRole("button", { name: /Use passkey/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use email instead/i })).toBeTruthy();
  });

  it("keeps the other factors when the status read fails", async () => {
    // Whether an authenticator exists is not worth failing a ceremony over.
    const underTest = await mountBesideAnAdmittingCeremony({
      totp: totpStub(new Error("network")),
      purpose: "recovery_generate",
    });
    expect(underTest.get(/Use passkey/i)).toBeTruthy();
    expect(underTest.get(/Use email instead/i)).toBeTruthy();
    expect(underTest.query(TOTP_BUTTON)).toBeNull();
  });

  it("exchanges a code for a token bound to the ceremony", async () => {
    stub.totpComplete.mockResolvedValue({ token: "eyJtotp", expiresIn: 300 });
    const onToken = vi.fn();
    mount({ totp: totpStub({ enrolled: true }), purpose: "recovery_generate", onToken });

    fireEvent.click(await screen.findByRole("button", { name: TOTP_BUTTON }));
    await enterCode("Code from your authenticator app", "123456");
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() =>
      expect(stub.totpComplete).toHaveBeenCalledWith({
        code: "123456",
        purpose: "recovery_generate",
      }),
    );
    // The token goes over once the sheet has closed.
    await waitFor(() => expect(onToken).toHaveBeenCalledWith({ token: "eyJtotp", expiresIn: 300 }));
    // TOTP is challenge-free: there is no `begin` half to call.
    expect(stub.emailBegin).not.toHaveBeenCalled();
  });

  it("keeps Confirm busy, not disabled, while it checks an authenticator code", async () => {
    stub.totpComplete.mockReturnValue(new Promise(() => {}));
    mount({ totp: totpStub({ enrolled: true }), purpose: "recovery_generate" });
    fireEvent.click(await screen.findByRole("button", { name: TOTP_BUTTON }));
    await enterCode("Code from your authenticator app", "123456");
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
    const checking = await screen.findByRole("button", { name: "Checking…" });
    expect(checking.getAttribute("aria-busy")).toBe("true");
    expect((checking as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(checking);
    await Promise.resolve();
    expect(stub.totpComplete).toHaveBeenCalledTimes(1);
  });

  it("survives passkeyOnly, because an authenticator code needs no delivery", async () => {
    // `passkeyOnly` means "this host cannot deliver mail". A TOTP code is not
    // delivered, so it cannot dead-end the way the prop exists to prevent.
    mount({ totp: totpStub({ enrolled: true }), purpose: "recovery_generate", passkeyOnly: true });
    expect(await screen.findByRole("button", { name: TOTP_BUTTON })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use email instead/i })).toBeNull();
  });
});

/**
 * A factor the gated endpoint will refuse is not a smaller menu, it is a dead
 * end: the ceremony succeeds, a token is minted, and the call it was minted
 * for fails. These pin the two ceremonies whose allow-lists are narrower than
 * the rest.
 */
describe("StepUpDialog — factors the ceremony would refuse", () => {
  const asTotp = (s: object): TotpClient => s as TotpClient;
  const TOTP_BUTTON = /Use your authenticator app/i;

  function totpClient() {
    return asTotp({
      status: async () => ({
        enrolled: true,
        label: "iPhone",
        lastUsedAt: null,
        createdAt: 1_700_000_000,
      }),
    });
  }

  function dialog(purpose: StepUpPurpose, title?: string) {
    return (
      <StepUpDialog
        client={asClient(stub)}
        onToken={() => {}}
        onCancel={() => {}}
        runPasskeyCeremony={async () => assertion}
        totpClient={totpClient()}
        purpose={purpose}
        title={title}
      />
    );
  }

  /**
   * Mounts the ceremony under test beside one that DOES admit the
   * authenticator, and waits for the factor to appear in that one.
   *
   * Asserting the factor's absence on its own cannot fail: whether it renders
   * depends on a `GET /totp/status` resource, so a bare `queryByRole` runs
   * before the fetch resolves and passes whether or not the guard exists.
   * Both dialogs read the same already-resolved status, so once the admitting
   * one has painted the button, the refusing one has had its chance.
   */
  async function mountBesideAnAdmittingCeremony(refusing: StepUpPurpose) {
    render(() => (
      <>
        {dialog("passkey_register", "Admits")}
        {dialog(refusing, "Refuses")}
      </>
    ));
    const admits = buttonsIn("Admits");
    await waitFor(() => expect(admits.get(TOTP_BUTTON)).toBeTruthy());
    return buttonsIn("Refuses");
  }

  it("passkey_delete offers neither code factor — the gate is WebAuthn-only", async () => {
    // `passkeyDeleteAllowedAmr` is `["webauthn"]`, and this purpose gates
    // rename as well as delete.
    const refuses = await mountBesideAnAdmittingCeremony("passkey_delete");
    expect(refuses.get(/Use passkey/i)).toBeTruthy();
    expect(refuses.query(/Use email instead/i)).toBeNull();
    expect(refuses.query(TOTP_BUTTON)).toBeNull();
  });

  it("email_change keeps the emailed link but not the authenticator", async () => {
    // The emailed code proves control of the CURRENT mailbox; an
    // authenticator seed does not, which is the whole point of that gate.
    const refuses = await mountBesideAnAdmittingCeremony("email_change");
    expect(refuses.get(/Use email instead/i)).toBeTruthy();
    expect(refuses.query(TOTP_BUTTON)).toBeNull();
  });

  it("passkey_register admits both, so a lost device is not a lock-out", async () => {
    render(() => dialog("passkey_register"));
    expect(await screen.findByRole("button", { name: TOTP_BUTTON })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use email instead/i })).toBeTruthy();
  });
});

/**
 * The step-up as a sheet: its name and description, the ways out of it, going
 * back to the factors, and the one outcome it hands its host. Each case is one
 * way the sheet can fail; the focus hand-back on Escape and the sheet's shape
 * are held in Chromium (`musubi/social/tests/components/SecurityStepUp.browser.test.tsx`).
 */
describe("StepUpDialog — the sheet", () => {
  const LINK_REQUEST_2 = {
    requestId: "stepup_ba9876543210",
    claimSecret: "d".repeat(64),
    pairingCode: "83",
    expiresAt: 1_900_000_000,
  };

  async function openEmailWait(overrides: Partial<StepUpDialogProps> = {}) {
    renderSheet({ purpose: "account_export", ...overrides });
    fireEvent.click(screen.getByRole("button", { name: "Use email instead" }));
    return screen.findByRole("heading", { name: "Check your email" });
  }

  // F9
  it('is a dialog named by its title, "Confirm it\'s you" unless the host names it', async () => {
    renderSheet();
    expect(screen.getByRole("dialog", { name: "Confirm it's you" })).toBeTruthy();
    cleanup();
    renderSheet({ title: "Remove Device passkey?" });
    expect(screen.getByRole("dialog", { name: "Remove Device passkey?" })).toBeTruthy();
  });

  // F8
  it("is described by the warning when there is one, and by the reason otherwise", async () => {
    renderSheet({
      purpose: "passkey_delete",
      reason: "to remove a passkey",
      warning: "You'll need another credential to sign in. Confirm it's you to remove it.",
    });
    const dialog = screen.getByRole("dialog");
    const describedBy = (dialog.getAttribute("aria-describedby") ?? "").split(" ");
    const description = describedBy.map((id) => document.getElementById(id)?.textContent).join(" ");
    expect(description).toBe(
      "You'll need another credential to sign in. Confirm it's you to remove it.",
    );
    // The reason still shows, as a line of its own.
    expect(screen.getByText("Re-authenticate to remove a passkey.")).toBeTruthy();
    cleanup();
    renderSheet({ reason: "to generate recovery codes" });
    const plain = screen.getByRole("dialog");
    expect(document.getElementById(plain.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "Re-authenticate to generate recovery codes.",
    );
  });

  // F7
  it("passkeyOnly: the wait is the busy passkey button, not a line", async () => {
    stub.passkeyBegin.mockReturnValue(new Promise(() => {}));
    renderSheet({ passkeyOnly: true });
    const waiting = await screen.findByRole("button", { name: "Waiting for your passkey…" });
    expect(waiting.getAttribute("aria-busy")).toBe("true");
    expect((waiting as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  // F3
  it("refuses Escape while the passkey call runs", async () => {
    stub.passkeyBegin.mockReturnValue(new Promise(() => {}));
    const onCancel = vi.fn();
    renderSheet({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: "Use passkey" }));
    await screen.findByRole("button", { name: "Waiting for your passkey…" });
    pressEscape();
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });

  // F3
  it("refuses Escape while an authenticator code is checked", async () => {
    stub.totpComplete.mockReturnValue(new Promise(() => {}));
    const onCancel = vi.fn();
    renderSheet({ onCancel, totpClient: enrolled() });
    fireEvent.click(await screen.findByRole("button", { name: "Use your authenticator app" }));
    await enterCode("Code from your authenticator app", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("button", { name: "Checking…" });
    pressEscape();
    await flush();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closes on Escape from the factors, and tells the host once", async () => {
    const onCancel = vi.fn();
    renderSheet({ onCancel });
    pressEscape();
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // F4
  it("Escape on the emailed-link wait ends it: a later confirmation hands over no token", async () => {
    const answer = held<unknown>();
    stub.emailBegin.mockResolvedValue(LINK_REQUEST);
    stub.emailStatus.mockReturnValueOnce(answer.promise);
    const onToken = vi.fn();
    const onCancel = vi.fn();
    await openEmailWait({ onToken, onCancel });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(stub.emailStatus).toHaveBeenCalledTimes(1));
    pressEscape();
    await flush();
    expect(onCancel).toHaveBeenCalledTimes(1);
    answer.settle({ status: "complete", token: { token: "eyJlate", expiresIn: 300 } });
    await flush();
    expect(onToken).not.toHaveBeenCalled();
  });

  // F1
  it("going back from the emailed-link wait ends it: a later confirmation hands over no token", async () => {
    const answer = held<unknown>();
    stub.emailBegin.mockResolvedValue(LINK_REQUEST);
    stub.emailStatus.mockReturnValueOnce(answer.promise);
    const onToken = vi.fn();
    await openEmailWait({ onToken });
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(stub.emailStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Use another method" }));
    // Focus goes to the factor just left, so the next choice is beside it.
    const email = await screen.findByRole("button", { name: "Use email instead" });
    expect(document.activeElement).toBe(email);
    answer.settle({ status: "complete", token: { token: "eyJlate", expiresIn: 300 } });
    await flush();
    // Coming back to the tab would poll at once if the wait still ran.
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(onToken).not.toHaveBeenCalled();
    expect(stub.emailStatus).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  // F2
  it("a Resend still out when the person went back writes nothing into the next wait", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      const resend = held<{ status: "sent" | "limit" | "expired" }>();
      stub.emailBegin.mockResolvedValueOnce(LINK_REQUEST).mockResolvedValueOnce(LINK_REQUEST_2);
      stub.emailStatus.mockReturnValue(new Promise(() => {}));
      stub.emailResend.mockReturnValueOnce(resend.promise);
      await openEmailWait();
      // Past the 120-second wait, Resend unlocks.
      vi.advanceTimersByTime(121_000);
      fireEvent.click(await screen.findByRole("button", { name: "Resend link" }));
      await waitFor(() => expect(stub.emailResend).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole("button", { name: "Use another method" }));
      fireEvent.click(await screen.findByRole("button", { name: "Use email instead" }));
      expect(await screen.findByText("83")).toBeTruthy();
      resend.settle({ status: "limit" });
      await flush();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getByText("83")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // F10
  it("a new link asked for an expired one, answered after the person went back, starts no wait", async () => {
    const begun = held<typeof LINK_REQUEST>();
    stub.emailBegin.mockResolvedValueOnce(LINK_REQUEST).mockReturnValueOnce(begun.promise);
    stub.emailStatus.mockResolvedValueOnce({ status: "expired" });
    const onToken = vi.fn();
    await openEmailWait({ onToken });
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(await screen.findByRole("button", { name: "Send a new link" }));
    await waitFor(() => expect(stub.emailBegin).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Use another method" }));
    await screen.findByRole("button", { name: "Use email instead" });
    begun.settle(LINK_REQUEST_2);
    await flush();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(stub.emailStatus).toHaveBeenCalledTimes(1);
    expect(onToken).not.toHaveBeenCalled();
    // Still the factor list, with no wait drawn behind it.
    expect(screen.queryByRole("heading", { name: "Check your email" })).toBeNull();
  });

  // F5
  it("going back from the code step forgets the code and its error", async () => {
    stub.totpComplete.mockRejectedValue(apiError("PLANTED-totp"));
    renderSheet({ totpClient: enrolled() });
    fireEvent.click(await screen.findByRole("button", { name: "Use your authenticator app" }));
    await enterCode("Code from your authenticator app", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Use another method" }));
    const factor = await screen.findByRole("button", { name: "Use your authenticator app" });
    expect(document.activeElement).toBe(factor);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(factor);
    const boxes = await findCodeBoxes("Code from your authenticator app");
    expect(boxes.map((box) => box.value).join("")).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // F6
  it('holds "Use another method" while a code is checked', async () => {
    stub.totpComplete.mockReturnValue(new Promise(() => {}));
    renderSheet({ totpClient: enrolled() });
    fireEvent.click(await screen.findByRole("button", { name: "Use your authenticator app" }));
    await enterCode("Code from your authenticator app", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("button", { name: "Checking…" });
    const back = screen.getByRole("button", { name: "Use another method" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    fireEvent.click(back);
    await flush();
    expect(codeBoxes("Code from your authenticator app")).toHaveLength(6);
  });

  it("passkeyOnly: going back from the code step returns to the passkey without starting it again", async () => {
    stub.passkeyBegin.mockRejectedValueOnce(ceremonyError("NotAllowedError", "PLANTED"));
    renderSheet({ passkeyOnly: true, totpClient: enrolled() });
    await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(screen.getByRole("button", { name: "Use your authenticator app" }));
    await findCodeBoxes("Code from your authenticator app");
    fireEvent.click(screen.getByRole("button", { name: "Use another method" }));
    await screen.findByRole("button", { name: /Use passkey|Try again/ });
    await flush();
    expect(stub.passkeyBegin).toHaveBeenCalledTimes(1);
  });

  // F12
  it("leaves focus where the host put it after the token", async () => {
    stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
    stub.passkeyComplete.mockResolvedValue({ token: "eyJpk", expiresIn: 300 });
    function NextStep() {
      let field: HTMLInputElement | undefined;
      onMount(() => field?.focus());
      return <input ref={field} aria-label="Next step" />;
    }
    function Host() {
      const [pending, setPending] = createSignal(false);
      const [next, setNext] = createSignal(false);
      return (
        <>
          <button type="button" onClick={() => setPending(true)}>
            Open
          </button>
          <Show when={pending()}>
            <StepUpDialog
              client={asClient(stub)}
              runPasskeyCeremony={async () => assertion}
              onToken={() => {
                setPending(false);
                setNext(true);
              }}
              onCancel={() => setPending(false)}
            />
          </Show>
          <Show when={next()}>
            <NextStep />
          </Show>
        </>
      );
    }
    render(() => <Host />);
    const open = screen.getByRole("button", { name: "Open" });
    open.focus();
    fireEvent.click(open);
    fireEvent.click(await screen.findByRole("button", { name: "Use passkey" }));
    const field = await screen.findByRole("textbox", { name: "Next step" });
    // The hand-back runs on a timer after the sheet unmounts; wait it out.
    await flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.activeElement).toBe(field);
  });

  describe("when the exit never ends", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = exitThatNeverEnds();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
      stub.passkeyComplete.mockResolvedValue({ token: "eyJpk", expiresIn: 300 });
    });
    afterEach(() => {
      vi.useRealTimers();
      restore();
    });

    // F11
    it("hands over the token within 300ms all the same", async () => {
      const onToken = vi.fn();
      renderSheet({ onToken });
      fireEvent.click(screen.getByRole("button", { name: "Use passkey" }));
      await flushMicrotasks();
      expect(screen.getByRole("dialog", { hidden: true }).hasAttribute("data-closed")).toBe(true);
      expect(onToken).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(onToken).toHaveBeenCalledTimes(1);
      expect(onToken).toHaveBeenCalledWith({ token: "eyJpk", expiresIn: 300 });
    });

    // F13
    it("takes no second outcome while it closes", async () => {
      const onToken = vi.fn();
      const onCancel = vi.fn();
      renderSheet({ onToken, onCancel });
      fireEvent.click(screen.getByRole("button", { name: "Use passkey" }));
      await flushMicrotasks();
      const sheet = screen.getByRole("dialog", { hidden: true });
      expect(sheet.querySelector("[inert]")).not.toBeNull();
      fireEvent.click(within(sheet).getByRole("button", { name: "Cancel", hidden: true }));
      fireEvent.click(within(sheet).getByRole("button", { name: "Use passkey", hidden: true }));
      fireEvent.keyDown(sheet, { key: "Escape" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onToken).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
      expect(stub.passkeyBegin).toHaveBeenCalledTimes(1);
    });

    // F14
    it("hands nothing to a host that removed it mid-close", async () => {
      const onToken = vi.fn();
      const { unmount } = renderSheet({ onToken });
      fireEvent.click(screen.getByRole("button", { name: "Use passkey" }));
      await flushMicrotasks();
      unmount();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onToken).not.toHaveBeenCalled();
    });
  });

  // F14
  it("hands nothing to a host that removed it while open", async () => {
    const onToken = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = renderSheet({ onToken, onCancel });
    expect(screen.getByRole("dialog")).toBeTruthy();
    unmount();
    await flush();
    await new Promise((r) => setTimeout(r, 350));
    expect(onToken).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
