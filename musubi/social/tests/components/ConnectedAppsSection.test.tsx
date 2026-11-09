// @vitest-environment happy-dom
import { OsnApiError } from "@osn/client";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A refused revoke reads a fixed sentence from the copy map, never the text
 * the server sent with the refusal.
 */

const PLANTED = "PLANTED server text";

vi.mock("../../src/lib/authClients", () => ({
  connectionsClient: {
    list: () =>
      Promise.resolve({
        connections: [
          { clientId: "client_1", clientName: "Pulse", logoUrl: null, scope: "openid profile" },
        ],
      }),
    revoke: () => Promise.reject(new OsnApiError(PLANTED, 500, "internal_error")),
  },
}));

import { ConnectedAppsSection } from "../../src/components/ConnectedAppsSection";

afterEach(() => {
  cleanup();
});

describe("<ConnectedAppsSection /> — a refused revoke", () => {
  it("names what failed in the copy map's words, without the server's text", async () => {
    render(() => <ConnectedAppsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("Couldn't revoke this app.");
    expect(alert.textContent).toContain("Something went wrong on our side. Try again.");
    expect(alert.textContent).not.toContain(PLANTED);
  });
});
