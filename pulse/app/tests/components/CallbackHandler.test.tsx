// @vitest-environment happy-dom
import { render, cleanup } from "@solidjs/testing-library";
import { vi, describe, it, expect, afterEach } from "vitest";
import { CallbackHandler } from "../../src/components/CallbackHandler";

const mockHandleCallback = vi.fn();
vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ handleCallback: mockHandleCallback }),
}));

describe("CallbackHandler", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mockHandleCallback.mockReset();
  });

  it("calls handleCallback and clears URL when code + state present", async () => {
    vi.stubGlobal("location", {
      search: "?code=abc123&state=xyz789",
      pathname: "/callback",
      origin: "http://localhost",
    });
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    mockHandleCallback.mockResolvedValue(undefined);

    render(() => <CallbackHandler />);

    // onMount runs after render — flush microtasks for the async handleCallback
    await Promise.resolve();
    await Promise.resolve();

    expect(mockHandleCallback).toHaveBeenCalledWith(
      expect.objectContaining({ code: "abc123", state: "xyz789" }),
    );
    expect(replaceState).toHaveBeenCalledWith({}, "", "/callback");
  });

  it("does not call handleCallback when no code/state in URL", () => {
    vi.stubGlobal("location", {
      search: "",
      pathname: "/",
      origin: "http://localhost",
    });

    render(() => <CallbackHandler />);

    expect(mockHandleCallback).not.toHaveBeenCalled();
  });

  it("does not call handleCallback when code present but state missing", () => {
    vi.stubGlobal("location", {
      search: "?code=abc123",
      pathname: "/",
      origin: "http://localhost",
    });

    render(() => <CallbackHandler />);

    expect(mockHandleCallback).not.toHaveBeenCalled();
  });
});
