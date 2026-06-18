// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * CreateWeddingForm POSTs the display name to /api/organiser/weddings and hands
 * the created wedding back to its parent. The OSN auth + api helpers are
 * stubbed; this asserts the wiring — the request it sends, the happy-path
 * callback, validation, and the auth/error branches.
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

import CreateWeddingForm from "./CreateWeddingForm";

function fill(value: string) {
  const input = screen.getByRole("textbox");
  fireEvent.input(input, { target: { value } });
}

describe("CreateWeddingForm", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
  });

  it("POSTs the display name and calls onCreated with the new wedding", async () => {
    const wedding = { id: "wed_x", slug: "nadia-sam-abc123", displayName: "Nadia & Sam" };
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ wedding }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const onCreated = vi.fn();
    render(() => <CreateWeddingForm onCreated={onCreated} />);

    fill("Nadia & Sam");
    fireEvent.click(screen.getByRole("button", { name: /Create wedding/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(wedding));

    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings");
    expect((init as RequestInit).method).toBe("POST");
    // Defaults to the recommended `secure` style when the organiser doesn't change it.
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      displayName: "Nadia & Sam",
      codeStyle: "secure",
    });
  });

  it("sends the chosen 'simple' code style when the organiser picks it", async () => {
    authFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ wedding: { id: "w", slug: "s", displayName: "Simple Pick" } }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    render(() => <CreateWeddingForm onCreated={vi.fn()} />);

    fill("Simple Pick");
    fireEvent.click(screen.getByRole("radio", { name: /Simple/i }));
    fireEvent.click(screen.getByRole("button", { name: /Create wedding/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalled());
    const body = JSON.parse(String((authFetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body.codeStyle).toBe("simple");
  });

  it("does not call the API when the name is blank", async () => {
    const onCreated = vi.fn();
    render(() => <CreateWeddingForm onCreated={onCreated} />);

    fill("   ");
    fireEvent.click(screen.getByRole("button", { name: /Create wedding/i }));

    await waitFor(() => expect(screen.getByText(/Give the wedding a name/i)).toBeTruthy());
    expect(authFetchMock).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("redirects to login on a 401", async () => {
    authFetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const onCreated = vi.fn();
    render(() => <CreateWeddingForm onCreated={onCreated} />);

    fill("Anything");
    fireEvent.click(screen.getByRole("button", { name: /Create wedding/i }));

    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("redirects to login when authFetch throws AuthExpiredError (T-S3)", async () => {
    authFetchMock.mockRejectedValue(new Error("AuthExpiredError: token expired"));
    const onCreated = vi.fn();
    render(() => <CreateWeddingForm onCreated={onCreated} />);

    fill("Anything");
    fireEvent.click(screen.getByRole("button", { name: /Create wedding/i }));

    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("surfaces the server error message on a non-ok response", async () => {
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Could not create wedding" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(() => <CreateWeddingForm onCreated={vi.fn()} />);

    fill("Anything");
    fireEvent.click(screen.getByRole("button", { name: /Create wedding/i }));

    await waitFor(() => expect(screen.getByText(/Could not create wedding/i)).toBeTruthy());
  });

  it("shows a Cancel control only when onCancel is provided", () => {
    const { unmount } = render(() => <CreateWeddingForm onCreated={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Cancel/i })).toBeNull();
    unmount();

    render(() => <CreateWeddingForm onCreated={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Cancel/i })).toBeTruthy();
  });
});
