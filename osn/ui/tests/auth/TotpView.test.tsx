// @vitest-environment happy-dom
import type { StepUpClient, TotpClient } from "@osn/client";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { TotpView } from "../../src/auth/TotpView";

/**
 * Settings → Authenticator app. The orchestration is what is covered here:
 * the step-up gate on both ceremonies, the one-and-only appearance of the
 * shared secret, and the manual-entry path that has to work for anyone who
 * cannot scan.
 */

interface TotpStub {
  enrollBegin: ReturnType<typeof vi.fn>;
  enrollComplete: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

interface StepUpStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
  totpComplete: ReturnType<typeof vi.fn>;
}

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/OSN:alice@example.com?secret=${SECRET}&issuer=OSN&algorithm=SHA1&digits=6&period=30`;

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

const notEnrolled = { enrolled: false, label: null, lastUsedAt: null, createdAt: null };
const isEnrolled = {
  enrolled: true,
  label: "iPhone",
  lastUsedAt: 1_700_005_000,
  createdAt: 1_700_000_000,
};

let totp: TotpStub;
let su: StepUpStub;

const asTotp = (s: TotpStub): TotpClient => s as unknown as TotpClient;
const asStepUp = (s: StepUpStub): StepUpClient => s as unknown as StepUpClient;

function mount() {
  render(() => (
    <TotpView
      client={asTotp(totp)}
      stepUpClient={asStepUp(su)}
      accessToken="acc"
      runPasskeyCeremony={async () => assertion}
    />
  ));
}

/** Drives the step-up dialog's passkey factor to completion. */
async function passStepUp() {
  await waitFor(() => screen.getByRole("button", { name: /Use passkey/i }));
  fireEvent.click(screen.getByRole("button", { name: /Use passkey/i }));
}

/** Types a six-digit code into the segmented input. */
function typeCode(value: string) {
  const boxes = screen.getAllByLabelText(/^Digit \d$/);
  for (const [i, ch] of [...value].entries()) {
    fireEvent.input(boxes[i]!, { target: { value: ch } });
  }
}

beforeEach(() => {
  totp = {
    enrollBegin: vi.fn(),
    enrollComplete: vi.fn(),
    disable: vi.fn(),
    status: vi.fn(),
  };
  su = {
    passkeyBegin: vi.fn().mockResolvedValue({ options: { challenge: "abc" } }),
    passkeyComplete: vi.fn().mockResolvedValue({ token: "stpup_x", expiresIn: 300 }),
    otpBegin: vi.fn(),
    otpComplete: vi.fn(),
    totpComplete: vi.fn(),
  };
  window.confirm = () => true;
});

afterEach(() => cleanup());

describe("TotpView", () => {
  it("offers enrolment when the account has no authenticator", async () => {
    totp.status.mockResolvedValue(notEnrolled);
    mount();
    expect(await screen.findByRole("button", { name: /Add an authenticator app/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove$/i })).toBeNull();
  });

  it("shows the credential and a remove action when one is enrolled", async () => {
    totp.status.mockResolvedValue(isEnrolled);
    mount();
    await waitFor(() => expect(screen.getByText("iPhone")).toBeTruthy());
    expect(screen.getByRole("button", { name: /^Remove$/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add an authenticator app/i })).toBeNull();
  });

  it("gates enrolment behind a step-up and passes the minted token to enrollBegin", async () => {
    totp.status.mockResolvedValue(notEnrolled);
    totp.enrollBegin.mockResolvedValue({ otpauthUri: URI, totpSecret: SECRET });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Add an authenticator app/i }));
    await passStepUp();

    await waitFor(() =>
      expect(totp.enrollBegin).toHaveBeenCalledWith({
        accessToken: "acc",
        stepUpToken: "stpup_x",
      }),
    );
  });

  it("shows the secret as selectable text beside the QR, not only as a picture", async () => {
    totp.status.mockResolvedValue(notEnrolled);
    totp.enrollBegin.mockResolvedValue({ otpauthUri: URI, totpSecret: SECRET });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Add an authenticator app/i }));
    await passStepUp();

    // The base32 key is the QR's text alternative and the only path for
    // anyone who cannot photograph their own screen.
    const key = await waitFor(() => screen.getByText(SECRET));
    expect(key.tagName.toLowerCase()).toBe("code");

    const qr = screen.getByRole("img");
    expect(qr.getAttribute("aria-label")).toMatch(/setup key below/i);
    // The accessible name is read aloud and copied into tooling, so it must
    // never carry the URI — which contains the whole shared secret.
    expect(qr.getAttribute("aria-label")).not.toContain(SECRET);
  });

  it("never renders the secret again once enrolment completes", async () => {
    totp.status.mockResolvedValueOnce(notEnrolled).mockResolvedValue(isEnrolled);
    totp.enrollBegin.mockResolvedValue({ otpauthUri: URI, totpSecret: SECRET });
    totp.enrollComplete.mockResolvedValue({ enrolled: true });
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Add an authenticator app/i }));
    await passStepUp();
    await waitFor(() => screen.getByText(SECRET));

    typeCode("123456");
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/i }));

    await waitFor(() =>
      expect(totp.enrollComplete).toHaveBeenCalledWith({
        accessToken: "acc",
        code: "123456",
        label: undefined,
      }),
    );
    // `GET /totp/status` does not return the secret, so this is the last
    // moment it could ever be on screen. It must not be.
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
    expect(screen.queryByRole("img")).toBeNull();
    await waitFor(() => expect(screen.getByText("iPhone")).toBeTruthy());
  });

  it("keeps the panel on a wrong code so the user can retype it", async () => {
    totp.status.mockResolvedValue(notEnrolled);
    totp.enrollBegin.mockResolvedValue({ otpauthUri: URI, totpSecret: SECRET });
    totp.enrollComplete.mockRejectedValue(new Error("That code didn't work"));
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Add an authenticator app/i }));
    await passStepUp();
    await waitFor(() => screen.getByText(SECRET));
    typeCode("000000");
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/didn't work/);
    // The user has already scanned; taking the QR away would force a restart.
    expect(screen.getByText(SECRET)).toBeTruthy();
  });

  it("drops the secret when the user cancels enrolment", async () => {
    totp.status.mockResolvedValue(notEnrolled);
    totp.enrollBegin.mockResolvedValue({ otpauthUri: URI, totpSecret: SECRET });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Add an authenticator app/i }));
    await passStepUp();
    await waitFor(() => screen.getByText(SECRET));

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
  });

  it("sends the optional label when the user names the device", async () => {
    totp.status.mockResolvedValueOnce(notEnrolled).mockResolvedValue(isEnrolled);
    totp.enrollBegin.mockResolvedValue({ otpauthUri: URI, totpSecret: SECRET });
    totp.enrollComplete.mockResolvedValue({ enrolled: true });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Add an authenticator app/i }));
    await passStepUp();
    await waitFor(() => screen.getByText(SECRET));

    fireEvent.input(screen.getByLabelText(/Name this device/i), { target: { value: "  Pixel  " } });
    typeCode("123456");
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/i }));

    await waitFor(() =>
      expect(totp.enrollComplete).toHaveBeenCalledWith({
        accessToken: "acc",
        code: "123456",
        label: "Pixel",
      }),
    );
  });

  it("gates removal behind a confirmation and a step-up", async () => {
    totp.status.mockResolvedValueOnce(isEnrolled).mockResolvedValue(notEnrolled);
    totp.disable.mockResolvedValue({ disabled: true });
    mount();

    await waitFor(() => screen.getByRole("button", { name: /^Remove$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));
    await passStepUp();

    await waitFor(() =>
      expect(totp.disable).toHaveBeenCalledWith({ accessToken: "acc", stepUpToken: "stpup_x" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add an authenticator app/i })).toBeTruthy(),
    );
  });

  it("does not start a removal the user declined", async () => {
    totp.status.mockResolvedValue(isEnrolled);
    window.confirm = () => false;
    mount();

    await waitFor(() => screen.getByRole("button", { name: /^Remove$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove$/i }));

    expect(su.passkeyBegin).not.toHaveBeenCalled();
    expect(totp.disable).not.toHaveBeenCalled();
  });
});
