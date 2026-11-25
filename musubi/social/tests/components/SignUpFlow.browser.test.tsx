import { AuthContext } from "@osn/client/solid";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * Musubi's sign-up, walked in a real browser: `AuthDialogs` with the real
 * `@osn/auth-ui` `Register` and `SignIn` inside, against a registration
 * client this file answers for.
 *
 * Each case is one of #2049's checks:
 *
 * - the details lock while a link is pending, and the welcome names the
 *   handle the server answered, not the one typed;
 * - closing the dialog, or a reload (the page's memory gone, the tab's
 *   `sessionStorage` kept), keeps every field typed, and no stored value holds
 *   the request's number;
 * - a date of birth in the future, or more than 120 years ago, is refused with
 *   a line saying so;
 * - after a `429` on Send, Send stays disabled for 60 seconds, counting down;
 * - a reload on the passkey step reopens on it and finishes there;
 * - the sign-in and create-account dialogs link to each other;
 * - each screen at 320px and 768px, light and dark, written under the
 *   gitignored `e2e-artifacts/musubi-signup/`.
 */

const hoisted = vi.hoisted(() => ({
  registration: {
    checkHandle: vi.fn(),
    beginRegistration: vi.fn(),
    registrationStatus: vi.fn(),
    resendRegistrationLink: vi.fn(),
    passkeyRegisterBegin: vi.fn(),
    passkeyRegisterComplete: vi.fn(),
  },
  toastSuccess: vi.fn(),
  startRegistration: vi.fn(),
}));

vi.mock("../../src/lib/authClients", () => {
  const wait = () => new Promise<never>(() => {});
  return {
    loginClient: { passkeyBegin: wait, passkeyComplete: wait },
    recoveryClient: {},
    registrationClient: hoisted.registration,
  };
});

vi.mock("@shared/toast", () => ({
  toast: { success: hoisted.toastSuccess, error: vi.fn() },
}));

// The passkey prompt is the browser's; this file answers for it.
vi.mock("@simplewebauthn/browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/browser")>()),
  startRegistration: hoisted.startRegistration,
}));

import { AuthDialogs } from "../../src/components/AuthDialogs";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/musubi-signup";

const PAIRING_CODE = "47";

/** A JWT on `aud`, as osn-api writes one; the signature is never read here. */
function jwt(aud: string): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "ES256" })}.${part({ sub: "usr_000000000001", aud })}.sig`;
}

const RESTRICTED = jwt("osn-recovery");
const ORDINARY = jwt("osn-access");
const EXPIRES_AT = Date.now() + 3_600_000;

/** One session object per token, so a call can be matched to the one handed out. */
const SESSIONS = new Map<
  string,
  { accessToken: string; idToken: null; expiresAt: number; scopes: [] }
>();
function sessionWith(accessToken: string) {
  if (!SESSIONS.has(accessToken)) {
    SESSIONS.set(accessToken, { accessToken, idToken: null, expiresAt: EXPIRES_AT, scopes: [] });
  }
  return SESSIONS.get(accessToken)!;
}

function begun(n: number) {
  return {
    requestId: `signup_00000000000${n}`,
    claimSecret: String(n).repeat(64),
    retireSecret: `${"f".repeat(63)}${n}`,
    pairingCode: PAIRING_CODE,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
}

/** The completing poll, with the handle the server made the account under. */
function completed(handle: string) {
  return {
    status: "complete" as const,
    profileId: "usr_000000000001",
    handle,
    email: "ada@example.com",
    session: sessionWith(RESTRICTED),
  };
}

const adoptSession = vi.fn(async () => {});
const refreshHeldSession = vi.fn();

/** Signed out, as anyone who opens these dialogs is. */
function signedOut() {
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
    session: resource(null),
    profiles: resource(null),
    activeProfileId: () => null,
    adoptSession,
    refreshHeldSession,
  };
}

/** The shell's one-dialog-at-a-time state, as `ShellDialogs` keeps it. */
function mount(initial: "register" | "signIn" | null) {
  const [open, setOpen] = createSignal(initial);
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={signedOut() as any}>
      <AuthDialogs
        showRegister={open() === "register"}
        onShowRegisterChange={(o) =>
          setOpen((now) => (o ? "register" : now === "register" ? null : now))
        }
        showSignIn={open() === "signIn"}
        onShowSignInChange={(o) => setOpen((now) => (o ? "signIn" : now === "signIn" ? null : now))}
      />
    </AuthContext.Provider>
  ));
  return { open, setOpen };
}

const REGISTER = "Create your Musubi account";
const SIGN_IN = "Sign in to Musubi";

const sheet = (name: string) => waitFor(() => screen.getByRole("dialog", { name }));

/**
 * Waits for the dialog's own motion (its entry, a sheet's rise) to end. A
 * wait's fill behind Resend runs as long as the wait, so anything over five
 * seconds is left running.
 */
async function settle() {
  const ending = document.getAnimations().filter((a) => {
    const end = a.effect?.getComputedTiming().endTime;
    return typeof end === "number" && Number.isFinite(end) && end <= 5_000;
  });
  await Promise.all(ending.map((a) => a.finished.catch(() => {})));
}

async function fillDetails(
  dialog: HTMLElement,
  fields: { email?: string; handle?: string; birthdate?: string; name?: string },
) {
  if (fields.email !== undefined)
    await userEvent.fill(within(dialog).getByLabelText("Email"), fields.email);
  if (fields.handle !== undefined)
    await userEvent.fill(within(dialog).getByLabelText("Handle"), fields.handle);
  if (fields.birthdate !== undefined)
    await userEvent.fill(within(dialog).getByLabelText("Date of birth"), fields.birthdate);
  if (fields.name !== undefined)
    await userEvent.fill(within(dialog).getByLabelText("Display name (optional)"), fields.name);
}

const send = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", {
    name: /^(Send verification link|Sending…|Try again in)/,
  }) as HTMLButtonElement;

/** A field's value. */
const valueOf = (field: HTMLElement) => (field as HTMLInputElement).value;

/** Every value the tab keeps in `sessionStorage`, parsed. */
function stored(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)!;
    out[key] = JSON.parse(sessionStorage.getItem(key)!);
  }
  return out;
}

/** Every key and string value under `value`. */
function walk(value: unknown, keys: string[] = [], strings: string[] = []) {
  if (typeof value === "string") strings.push(value);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      walk(v, keys, strings);
    }
  }
  return { keys, strings };
}

/** A reload, as the page sees it: every component and signal gone, the tab's storage kept. */
function reload() {
  cleanup();
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
  hoisted.registration.checkHandle.mockResolvedValue({ available: true });
  hoisted.registration.registrationStatus.mockResolvedValue({
    status: "pending",
    pairingCode: PAIRING_CODE,
  });
  hoisted.registration.passkeyRegisterBegin.mockResolvedValue({ challenge: "c" });
  hoisted.registration.passkeyRegisterComplete.mockResolvedValue({ passkeyId: "pk_1" });
  hoisted.startRegistration.mockResolvedValue({ id: "cred" });
  refreshHeldSession.mockResolvedValue({ held: true, session: sessionWith(ORDINARY) });
});

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  document.documentElement.classList.remove("dark");
  await page.viewport(414, 896);
});

describe("the details, once a link is sent", () => {
  it("lock while it is pending, and the welcome names the handle the server answered", async () => {
    hoisted.registration.beginRegistration
      .mockResolvedValueOnce(begun(1))
      .mockResolvedValueOnce(begun(2));
    mount("register");
    let dialog = await sheet(REGISTER);
    await fillDetails(dialog, {
      email: "ada@example.com",
      handle: "ada",
      birthdate: "1990-01-01",
      name: "Ada",
    });
    await waitFor(() => expect(send(dialog).disabled).toBe(false));
    await userEvent.click(send(dialog));

    // Pending: no field of the details is on screen to edit.
    await within(dialog).findByRole("heading", { name: "Check your email" });
    expect(within(dialog).queryByLabelText("Handle")).toBeNull();
    expect(within(dialog).queryByLabelText("Email")).toBeNull();

    // The only way back to them leaves the request this tab held.
    await userEvent.click(within(dialog).getByRole("button", { name: "Start again" }));
    dialog = await sheet(REGISTER);
    expect(valueOf(within(dialog).getByLabelText("Handle"))).toBe("ada");
    await userEvent.fill(within(dialog).getByLabelText("Handle"), "ada_two");
    await waitFor(() => expect(send(dialog).disabled).toBe(false));
    await userEvent.click(send(dialog));
    await within(dialog).findByRole("heading", { name: "Check your email" });

    const second = hoisted.registration.beginRegistration.mock.calls[1]![0] as {
      handle: string;
      previous?: { requestId: string };
    };
    expect(second.handle).toBe("ada_two");
    // The first request goes with the new begin, so it can never finish.
    expect(second.previous?.requestId).toBe(begun(1).requestId);

    // The server made the account under a handle of its own answer.
    hoisted.registration.registrationStatus.mockResolvedValue(completed("ada_server"));
    window.dispatchEvent(new Event("focus"));
    await within(dialog).findByRole("button", { name: "Add a passkey" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Add a passkey" }));

    await waitFor(() => expect(adoptSession).toHaveBeenCalledWith(sessionWith(ORDINARY)));
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("Welcome, @ada_server");
    expect(hoisted.toastSuccess).not.toHaveBeenCalledWith("Welcome, @ada_two");
  });
});

describe("what was typed", () => {
  it("survives closing the dialog and a reload, with no number and no under-13 date stored", async () => {
    const { setOpen } = mount("register");
    let dialog = await sheet(REGISTER);
    await fillDetails(dialog, { email: "ada@example.com", handle: "ada", birthdate: "2020-01-01" });
    // Under 13: not kept.
    expect(walk(stored()).strings).not.toContain("2020-01-01");
    await fillDetails(dialog, { birthdate: "1990-01-01", name: "Ada Lovelace" });

    // Escape or a press outside closes it through the host.
    setOpen(null);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: REGISTER })).toBeNull());
    setOpen("register");
    dialog = await sheet(REGISTER);
    expect(valueOf(within(dialog).getByLabelText("Email"))).toBe("ada@example.com");
    expect(valueOf(within(dialog).getByLabelText("Handle"))).toBe("ada");
    expect(valueOf(within(dialog).getByLabelText("Date of birth"))).toBe("1990-01-01");
    expect(valueOf(within(dialog).getByLabelText("Display name (optional)"))).toBe("Ada Lovelace");

    reload();
    mount("register");
    dialog = await sheet(REGISTER);
    expect(valueOf(within(dialog).getByLabelText("Email"))).toBe("ada@example.com");
    expect(valueOf(within(dialog).getByLabelText("Handle"))).toBe("ada");
    expect(valueOf(within(dialog).getByLabelText("Date of birth"))).toBe("1990-01-01");
    expect(valueOf(within(dialog).getByLabelText("Display name (optional)"))).toBe("Ada Lovelace");
    // The kept handle is checked again, so Send is ready without a keystroke.
    await waitFor(() => expect(send(dialog).disabled).toBe(false));

    // Send, then reload on the wait: it resumes, and Start again brings back
    // every field, the two the wait does not keep included.
    hoisted.registration.beginRegistration.mockResolvedValueOnce(begun(1));
    await userEvent.click(send(dialog));
    await within(dialog).findByRole("heading", { name: "Check your email" });
    reload();
    mount(null);
    dialog = await sheet(REGISTER);
    await within(dialog).findByRole("heading", { name: "Check your email" });

    const { keys, strings } = walk(stored());
    expect(strings).not.toContain(PAIRING_CODE);
    expect(keys.filter((k) => /pairing|number|code|linkSecret/i.test(k))).toEqual([]);

    await userEvent.click(within(dialog).getByRole("button", { name: "Start again" }));
    dialog = await sheet(REGISTER);
    expect(valueOf(within(dialog).getByLabelText("Date of birth"))).toBe("1990-01-01");
    expect(valueOf(within(dialog).getByLabelText("Display name (optional)"))).toBe("Ada Lovelace");
  });
});

describe("the date of birth", () => {
  it("refuses a date in the future, or more than 120 years ago, with a line saying so", async () => {
    mount("register");
    const dialog = await sheet(REGISTER);
    const field = within(dialog).getByLabelText("Date of birth");
    await fillDetails(dialog, { email: "ada@example.com", handle: "ada" });

    const nextYear = new Date().getFullYear() + 1;
    await userEvent.fill(field, `${nextYear}-01-01`);
    await within(dialog).findByText("That date is in the future. Enter your date of birth.");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(send(dialog).disabled).toBe(true);

    await userEvent.fill(field, "1890-01-01");
    await within(dialog).findByText("Check the year. That date is more than 120 years ago.");
    expect(send(dialog).disabled).toBe(true);

    // Both ends are the field's own range too.
    expect(field.getAttribute("max")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(field.getAttribute("min")).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await userEvent.fill(field, "1990-01-01");
    await waitFor(() => expect(send(dialog).disabled).toBe(false));
    expect(field.getAttribute("aria-invalid")).toBeNull();
  });
});

describe("Send after a rate limit", () => {
  it("stays disabled for 60 seconds, counting down", async () => {
    hoisted.registration.beginRegistration.mockRejectedValue(
      Object.assign(new Error("rate limited"), { status: 429, code: "rate_limited" }),
    );
    mount("register");
    const dialog = await sheet(REGISTER);
    await fillDetails(dialog, {
      email: "ada@example.com",
      handle: "ada",
      birthdate: "1990-01-01",
    });
    await waitFor(() => expect(send(dialog).disabled).toBe(false));

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await userEvent.click(send(dialog));
    await vi.waitUntil(() => /Try again in/.test(send(dialog).textContent ?? ""));

    expect(send(dialog).disabled).toBe(true);
    expect(send(dialog).textContent).toBe("Try again in 60s");
    expect(within(dialog).getByRole("alert").textContent).toContain("Too many attempts");
    await page.screenshot({ path: `${SHOTS}/details-rate-limited-414.png` });

    vi.advanceTimersByTime(30_000);
    expect(send(dialog).textContent).toBe("Try again in 30s");
    expect(send(dialog).disabled).toBe(true);

    vi.advanceTimersByTime(29_000);
    expect(send(dialog).textContent).toBe("Try again in 1s");
    vi.advanceTimersByTime(1_000);
    expect(send(dialog).textContent).toBe("Send verification link");
    expect(send(dialog).disabled).toBe(false);
  });
});

describe("the passkey step", () => {
  async function toPasskeyStep() {
    hoisted.registration.beginRegistration.mockResolvedValueOnce(begun(1));
    mount("register");
    const dialog = await sheet(REGISTER);
    await fillDetails(dialog, {
      email: "ada@example.com",
      handle: "ada",
      birthdate: "1990-01-01",
    });
    await waitFor(() => expect(send(dialog).disabled).toBe(false));
    await userEvent.click(send(dialog));
    await within(dialog).findByRole("heading", { name: "Check your email" });
    hoisted.registration.registrationStatus.mockResolvedValue(completed("ada"));
    window.dispatchEvent(new Event("focus"));
    await within(dialog).findByRole("button", { name: "Add a passkey" });
  }

  it("reopens on a reload and finishes there, with a token from the cookie", async () => {
    await toPasskeyStep();
    reload();
    refreshHeldSession
      .mockResolvedValueOnce({ held: true, session: sessionWith(RESTRICTED) })
      .mockResolvedValueOnce({ held: true, session: sessionWith(ORDINARY) });
    mount(null);
    const dialog = await sheet(REGISTER);
    await userEvent.click(await within(dialog).findByRole("button", { name: "Add a passkey" }));

    await waitFor(() => expect(adoptSession).toHaveBeenCalledWith(sessionWith(ORDINARY)));
    // The enrolment ran on the held token, never on a published one.
    expect(hoisted.registration.passkeyRegisterBegin).toHaveBeenCalledWith({
      profileId: "usr_000000000001",
      accessToken: RESTRICTED,
    });
    expect(hoisted.toastSuccess).toHaveBeenCalledWith("Welcome, @ada");
    expect(stored()).toEqual({});
  });

  const RAN_OUT =
    "This sign-up ran out of time before a passkey was added. Your account is saved: sign in, choose “Lost your passkey?”, and confirm your email to add one.";

  it("says how to finish once the session behind it has ended, and offers only sign-in", async () => {
    await toPasskeyStep();
    reload();
    refreshHeldSession.mockRejectedValue(Object.assign(new Error("refused"), { refused: true }));
    mount(null);
    let dialog = await sheet(REGISTER);
    await userEvent.click(await within(dialog).findByRole("button", { name: "Add a passkey" }));

    await within(dialog).findByText(RAN_OUT);
    // Never the details again: their address has an account now.
    expect(within(dialog).queryByLabelText("Email")).toBeNull();
    expect(hoisted.registration.passkeyRegisterBegin).not.toHaveBeenCalled();
    expect(adoptSession).not.toHaveBeenCalled();
    expect(localStorage.getItem("osn.signup.enrolling")).toBeNull();
    await page.screenshot({ path: `${SHOTS}/ran-out-414.png` });

    await userEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
    dialog = await sheet(SIGN_IN);
    expect(dialog).toBeTruthy();
  });

  it("ends the same way when the cookie answers for another account", async () => {
    await toPasskeyStep();
    reload();
    // Someone signed in as somebody else in another tab meanwhile.
    const part = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const otherAccount = `${part({ alg: "ES256" })}.${part({ sub: "usr_0000000000ff", aud: "osn-access" })}.sig`;
    refreshHeldSession.mockResolvedValue({ held: true, session: sessionWith(otherAccount) });
    mount(null);
    const dialog = await sheet(REGISTER);
    await userEvent.click(await within(dialog).findByRole("button", { name: "Add a passkey" }));

    await within(dialog).findByText(RAN_OUT);
    expect(adoptSession).not.toHaveBeenCalled();
    expect(hoisted.registration.passkeyRegisterBegin).not.toHaveBeenCalled();
    expect(localStorage.getItem("osn.signup.enrolling")).toBeNull();
  });

  it("says to sign in with the new passkey when the session is gone once it is in", async () => {
    await toPasskeyStep();
    const dialog = screen.getByRole("dialog", { name: REGISTER });
    // The lift reached a session another tab had already renewed away.
    refreshHeldSession.mockRejectedValue(Object.assign(new Error("refused"), { refused: true }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Add a passkey" }));

    await within(dialog).findByText("Your passkey is added. Sign in with it to finish.");
    expect(hoisted.registration.passkeyRegisterComplete).toHaveBeenCalledTimes(1);
    expect(adoptSession).not.toHaveBeenCalled();
    expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
    await page.screenshot({ path: `${SHOTS}/added-414.png` });
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await sheet(SIGN_IN);
  });
});

describe("sign-in and create-account", () => {
  it("link to each other", async () => {
    mount("signIn");
    let dialog = await sheet(SIGN_IN);
    await userEvent.click(within(dialog).getByRole("button", { name: "Create one" }));
    dialog = await sheet(REGISTER);
    expect(within(dialog).getByText(/Already have an account\?/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
    dialog = await sheet(SIGN_IN);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: REGISTER })).toBeNull());
    // Focus is in the dialog that opened, never left on the page under it.
    await settle();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });
});

describe("each screen", () => {
  const WIDTHS = [320, 768] as const;
  const THEMES = ["light", "dark"] as const;

  for (const theme of THEMES) {
    it.each(WIDTHS)(`at %ipx (${theme})`, async (width) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      await page.viewport(width, width < 768 ? 844 : 1024);
      const shot = async (name: string) => {
        await settle();
        await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png` });
      };

      mount("signIn");
      let dialog = await sheet(SIGN_IN);
      await shot("sign-in");
      await userEvent.click(within(dialog).getByRole("button", { name: "Create one" }));
      dialog = await sheet(REGISTER);
      await shot("details");

      // Nothing scrolls sideways, and the cross-link stays on the sheet.
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);

      await fillDetails(dialog, { email: "ada@example.com", handle: "ada" });
      await userEvent.fill(within(dialog).getByLabelText("Date of birth"), "2999-01-01");
      await within(dialog).findByText("That date is in the future. Enter your date of birth.");
      await shot("details-future-date");

      await fillDetails(dialog, { birthdate: "1990-01-01", name: "Ada" });
      await waitFor(() => expect(send(dialog).disabled).toBe(false));
      await shot("details-filled");

      hoisted.registration.beginRegistration.mockResolvedValueOnce(begun(1));
      await userEvent.click(send(dialog));
      await within(dialog).findByRole("heading", { name: "Check your email" });
      await shot("verify");

      hoisted.registration.registrationStatus.mockResolvedValue(completed("ada"));
      window.dispatchEvent(new Event("focus"));
      await within(dialog).findByRole("button", { name: "Add a passkey" });
      await shot("passkey");
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    });
  }
});
