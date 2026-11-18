// @vitest-environment happy-dom
import { AccountError } from "@osn/client";
import { toast } from "@shared/toast";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Download my data" and "Send me a link": each limit reached says when to
 * try again, the download steps up for `account_export` first, and the file
 * takes the server's name, else Musubi's own.
 */

const mocks = vi.hoisted(() => ({
  exportAccount: vi.fn(),
  sendDataLink: vi.fn(),
  saveFile: vi.fn(),
  stepUps: [] as string[],
}));

vi.mock("../../src/lib/authClients", () => ({
  accountClient: { exportAccount: mocks.exportAccount, sendDataLink: mocks.sendDataLink },
}));
vi.mock("../../src/lib/save-file", () => ({ saveFile: mocks.saveFile }));
vi.mock("../../src/components/StepUpSheet", () => ({
  default: (props: { purpose: string; onToken: (token: { token: string }) => void }) => {
    mocks.stepUps.push(props.purpose);
    queueMicrotask(() => props.onToken({ token: "tok-export" }));
    return null;
  },
}));

import { AccountDataActions } from "../../src/components/AccountDataActions";

beforeEach(() => {
  mocks.exportAccount.mockReset();
  mocks.sendDataLink.mockReset();
  mocks.saveFile.mockReset();
  mocks.stepUps.length = 0;
  vi.spyOn(toast, "success");
  vi.spyOn(toast, "error");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AccountDataActions />", () => {
  it("steps up, downloads, and saves under Musubi's name when the server's cannot be read", async () => {
    const blob = new Blob(["{}\n"]);
    mocks.exportAccount.mockResolvedValue({ blob, fileName: null });
    render(() => <AccountDataActions />);
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));

    await waitFor(() => expect(mocks.saveFile).toHaveBeenCalledOnce());
    expect(mocks.stepUps).toEqual(["account_export"]);
    expect(mocks.exportAccount).toHaveBeenCalledWith({ stepUpToken: "tok-export" });
    expect(mocks.saveFile).toHaveBeenCalledWith(blob, "musubi-account-export.ndjson");
  });

  it("says a download is once a day when refused at 429", async () => {
    mocks.exportAccount.mockRejectedValue(new AccountError("limited", 429, "rate_limited"));
    render(() => <AccountDataActions />);
    fireEvent.click(screen.getByRole("button", { name: "Download my data" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You can download your data once a day. Try again tomorrow.",
      ),
    );
    expect(mocks.saveFile).not.toHaveBeenCalled();
  });

  it("says a link is three a day when refused at 429", async () => {
    mocks.sendDataLink.mockRejectedValue(new AccountError("limited", 429, "rate_limited"));
    render(() => <AccountDataActions />);
    fireEvent.click(screen.getByRole("button", { name: "Send me a link" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You can ask for three links a day. Try again tomorrow.",
      ),
    );
  });
});
