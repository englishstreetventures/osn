// @vitest-environment happy-dom
import type { StepUpClient, TotpClient } from "@osn/client";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "@shared/toast";
import { Suspense } from "solid-js";

import { TotpView } from "../src/TotpView";
import { enterCode, expectTied } from "./helpers/code";
import { CODE, WAIT, alertsText, apiError } from "./helpers/errors";
import { withoutAnimations } from "./helpers/motion";

// The step-up sheet closes at once, as under reduced motion, and hands its
// outcome over then (`helpers/motion.ts`).
withoutAnimations();

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
  emailBegin: ReturnType<typeof vi.fn>;
  emailStatus: ReturnType<typeof vi.fn>;
  emailResend: ReturnType<typeof vi.fn>;
  totpComplete: ReturnType<typeof vi.fn>;
}

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/Musubi:alice@example.com?secret=${SECRET}&issuer=Musubi&algorithm=SHA1&digits=6&period=30`;

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
    emailBegin: vi.fn(),
    emailStatus: vi.fn(),
    emailResend: vi.fn(),
    totpComplete: vi.fn(),
  };
});

afterEach(() => cleanup());

describe("TotpView", () => {
  it("offers enrolment when the account has no authenticator", async () => {
    totp.status.mockResolvedValue(notEnrolled);
    mount();
    expect(await screen.findByRole("button", { name: /Add an authenticator app/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });

  it("shows the credential and a remove action when one is enrolled", async () => {
    totp.status.mockResolvedValue(isEnrolled);
    mount();
    await waitFor(() => expect(screen.getByText("iPhone")).toBeTruthy());
    expect(screen.getByRole("button", { name: /^Remove / })).toBeTruthy();
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

  it.each([
    ["a 400", apiError("PLANTED-totp-confirm"), CODE, "true"],
    ["a 429", apiError("PLANTED-totp-confirm-429", 429, "rate_limited"), WAIT, null],
  ] as const)(
    "keeps the panel on a refused code (%s), the line tied to the boxes",
    async (_, error, sentence, invalid) => {
      totp.status.mockResolvedValue(notEnrolled);
      totp.enrollBegin.mockResolvedValue({ otpauthUri: URI, totpSecret: SECRET });
      totp.enrollComplete.mockRejectedValue(error);
      vi.mocked(toast.error).mockClear();
      mount();

      fireEvent.click(await screen.findByRole("button", { name: /Add an authenticator app/i }));
      await passStepUp();
      await waitFor(() => screen.getByText(SECRET));
      // The group is named by the label above it.
      const boxes = await enterCode("Code from the app", "000000");
      fireEvent.click(screen.getByRole("button", { name: /^Confirm$/i }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(sentence);
      expect(alertsText()).not.toContain("PLANTED");
      expect(toast.error).not.toHaveBeenCalled();
      expectTied(boxes, alert.id, invalid);
      // The user has already scanned; taking the QR away would force a restart.
      expect(screen.getByText(SECRET)).toBeTruthy();
    },
  );

  // A read under a host's Suspense boundary would hand the whole boundary to
  // the host's fallback; the view shows its own placeholder instead.
  it("holds its place under a host's Suspense while the status loads", async () => {
    totp.status.mockReturnValue(new Promise(() => {}));
    render(() => (
      <Suspense fallback={<p>HOST FALLBACK</p>}>
        <TotpView
          client={asTotp(totp)}
          stepUpClient={asStepUp(su)}
          runPasskeyCeremony={async () => assertion}
        />
      </Suspense>
    ));
    await waitFor(() => expect(totp.status).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByText("HOST FALLBACK")).toBeNull();
    expect(screen.getByRole("heading", { name: "Authenticator app" })).toBeTruthy();
    const region = document.querySelector('[aria-busy="true"]');
    expect(region?.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it("reads a refused start as the map's sentence, with no error toast", async () => {
    totp.status.mockResolvedValue(notEnrolled);
    totp.enrollBegin.mockRejectedValue(apiError("PLANTED-totp-begin", 429, "rate_limited"));
    vi.mocked(toast.error).mockClear();
    mount();

    fireEvent.click(await screen.findByRole("button", { name: /Add an authenticator app/i }));
    await passStepUp();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(WAIT);
    expect(alertsText()).not.toContain("PLANTED");
    expect(toast.error).not.toHaveBeenCalled();
  });

  describe("a status that fails to load", () => {
    it("says so with a Try again that reloads it", async () => {
      totp.status
        .mockRejectedValueOnce(apiError("PLANTED-status", 503, "temporarily_unavailable"))
        .mockResolvedValueOnce(notEnrolled);
      mount();

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("Your authenticator app didn't load.");
      expect(alertsText()).not.toContain("PLANTED");
      expect(screen.getByRole("heading", { name: "Authenticator app" })).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await screen.findByRole("button", { name: /Add an authenticator app/i });
      expect(totp.status).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("says to check the connection when the request never arrived", async () => {
      totp.status.mockRejectedValue(apiError("PLANTED-status-0", 0, "network"));
      mount();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(
        "We couldn't connect. Check your connection and try again.",
      );
    });
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
        code: "123456",
        label: "Pixel",
      }),
    );
  });

  it("gates removal behind the step-up sheet", async () => {
    totp.status.mockResolvedValueOnce(isEnrolled).mockResolvedValue(notEnrolled);
    totp.disable.mockResolvedValue({ disabled: true });
    mount();

    await waitFor(() => screen.getByRole("button", { name: /^Remove / }));
    fireEvent.click(screen.getByRole("button", { name: /^Remove / }));
    await passStepUp();

    await waitFor(() => expect(totp.disable).toHaveBeenCalledWith({ stepUpToken: "stpup_x" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Add an authenticator app/i })).toBeTruthy(),
    );
  });

  it("asks before a removal in the step-up sheet, named and described by the removal, never window.confirm", async () => {
    totp.status.mockResolvedValue(isEnrolled);
    const confirm = vi.fn(() => true);
    window.confirm = confirm;
    mount();

    await waitFor(() => screen.getByRole("button", { name: "Remove iPhone" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove iPhone" }));

    const sheet = await waitFor(() => screen.getByRole("dialog", { name: "Remove iPhone?" }));
    const described = (sheet.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain("You'll lose it as a way back into your account.");
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(su.passkeyBegin).not.toHaveBeenCalled();
    expect(totp.disable).not.toHaveBeenCalled();
  });

  it("names an unnamed app's removal after the app", async () => {
    totp.status.mockResolvedValue({ ...isEnrolled, label: null });
    mount();
    const remove = await waitFor(() =>
      screen.getByRole("button", { name: "Remove Authenticator app" }),
    );
    expect(remove.textContent).toBe("Remove");
  });
});
