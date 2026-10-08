// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});
vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import UnlockCodeDialog from "../../src/components/UnlockCodeDialog";
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function open(onRedeemed = vi.fn()) {
  render(() => <UnlockCodeDialog weddingId="wed_1" onRedeemed={onRedeemed} />);
  fireEvent.click(screen.getByRole("button", { name: "Have a code?" }));
  return { onRedeemed, input: screen.getByLabelText("Code") as HTMLInputElement };
}

const useButton = () => screen.getByRole("button", { name: "Use code" });

describe("UnlockCodeDialog", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("opens from a 'Have a code?' link and says what a code does", () => {
    open();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/moves this wedding to that plan/i)).toBeInTheDocument();
  });

  it("keeps 'Use code' disabled until something is typed", () => {
    const { input } = open();
    expect(useButton()).toBeDisabled();
    fireEvent.input(input, { target: { value: "   " } });
    expect(useButton()).toBeDisabled();
    fireEvent.input(input, { target: { value: "3f9a-0c1e-b7d2-48aa" } });
    expect(useButton()).toBeEnabled();
  });

  it("sends the code, reports the new tier and closes", async () => {
    authFetchMock.mockResolvedValueOnce(json({ tier: "gold" }));
    const { input, onRedeemed } = open();
    fireEvent.input(input, { target: { value: "3f9a-0c1e-b7d2-48aa" } });
    fireEvent.click(useButton());

    await waitFor(() => expect(onRedeemed).toHaveBeenCalledWith("gold"));
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/unlock-code");
    expect(JSON.parse(init.body)).toEqual({ unlockCode: "3f9a-0c1e-b7d2-48aa" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows a refusal beside the field, stays open, and clears it on the next keystroke", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "unlock_code_invalid" }, 404));
    const { input, onRedeemed } = open();
    fireEvent.input(input, { target: { value: "0000-0000-0000-0000" } });
    fireEvent.click(useButton());

    expect(await screen.findByText(/that code is not valid/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onRedeemed).not.toHaveBeenCalled();
    fireEvent.input(input, { target: { value: "0000-0000-0000-0001" } });
    expect(screen.queryByText(/that code is not valid/i)).not.toBeInTheDocument();
  });

  it("sends an expired session to sign-in", async () => {
    authFetchMock.mockRejectedValueOnce(new Error("AuthExpiredError"));
    const { input } = open();
    fireEvent.input(input, { target: { value: "3f9a-0c1e-b7d2-48aa" } });
    fireEvent.click(useButton());
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });

  it("says so when the request never reaches the API", async () => {
    authFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { input } = open();
    fireEvent.input(input, { target: { value: "3f9a-0c1e-b7d2-48aa" } });
    fireEvent.click(useButton());
    expect(await screen.findByText(/check your connection/i)).toBeInTheDocument();
  });

  it("sends one request while one is in flight, and holds the dialog open under it", async () => {
    // A second POST would come back 404 (this wedding has now used the code)
    // and leave a "not valid" error behind a success.
    authFetchMock.mockReturnValue(new Promise(() => {}));
    const { input } = open();
    fireEvent.input(input, { target: { value: "3f9a-0c1e-b7d2-48aa" } });
    const form = input.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(await screen.findByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("forgets the code and its error on Cancel", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "unlock_code_invalid" }, 404));
    const { input } = open();
    fireEvent.input(input, { target: { value: "0000-0000-0000-0000" } });
    fireEvent.click(useButton());
    await screen.findByText(/that code is not valid/i);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Have a code?" }));

    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText(/that code is not valid/i)).toBeNull();
  });
});
