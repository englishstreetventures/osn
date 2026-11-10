import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * The rail's search results, pressed with a real pointer.
 *
 * An option is not focusable — the combobox keeps focus in the field and moves
 * a virtual one — so a press on it would blur the field, and the field's
 * focusout closes the panel. The press has to keep focus in the field, or the
 * click lands on nothing. A synthetic `click` skips the press and the focus
 * change, which is why this is a browser test.
 *
 * The factory is written literally: the shared-factory idiom in
 * `test-support/` does not resolve in the browser project.
 */

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  sendConnectionRequest: vi.fn(),
  acceptConnection: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  graphClient: {
    sendConnectionRequest: mocks.sendConnectionRequest,
    acceptConnection: mocks.acceptConnection,
  },
  orgClient: {},
  recommendationClient: { search: mocks.search },
}));

import { GlobalSearch } from "../../src/components/GlobalSearch";

function renderSearch() {
  render(() => (
    <MemoryRouter>
      <Route
        path="/"
        component={() => (
          <div class="w-60">
            <GlobalSearch />
            <button type="button" class="mt-96">
              Elsewhere
            </button>
          </div>
        )}
      />
      <Route path="/organisations/:handle" component={() => <h1>Organisation page</h1>} />
    </MemoryRouter>
  ));
}

async function search(text: string) {
  await userEvent.fill(screen.getByRole("combobox"), text);
  return waitFor(() => screen.getByRole("option"), { timeout: 2000 });
}

beforeEach(() => {
  mocks.sendConnectionRequest.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("<GlobalSearch /> under a real pointer", () => {
  it("opens an organisation when its option is clicked", async () => {
    mocks.search.mockResolvedValue({
      people: [],
      organisations: [{ handle: "acme", name: "Acme Inc", avatarUrl: null, isMember: false }],
    });
    renderSearch();

    await userEvent.click(await search("acme"));

    expect(
      await waitFor(() => screen.getByRole("heading", { name: "Organisation page" })),
    ).toBeDefined();
  });

  it("connects to a person when their option is clicked, and keeps focus in the field", async () => {
    mocks.search.mockResolvedValue({
      people: [{ handle: "alice", displayName: null, avatarUrl: null, connectionStatus: "none" }],
      organisations: [],
    });
    renderSearch();

    await userEvent.click(await search("ali"));

    await waitFor(() => screen.getByText("Requested"));
    expect(mocks.sendConnectionRequest).toHaveBeenCalledTimes(1);
    expect(mocks.sendConnectionRequest).toHaveBeenCalledWith("alice");
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  it("still closes the results on a click outside them", async () => {
    mocks.search.mockResolvedValue({
      people: [{ handle: "alice", displayName: null, avatarUrl: null, connectionStatus: "none" }],
      organisations: [],
    });
    renderSearch();
    await search("ali");

    await userEvent.click(screen.getByRole("button", { name: "Elsewhere" }));

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(mocks.sendConnectionRequest).not.toHaveBeenCalled();
  });

  it.each(["light", "dark"])(
    "draws the results as a floating panel, as the rail's menus are (%s)",
    async (theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      mocks.search.mockResolvedValue({
        people: [
          { handle: "alice", displayName: "Alice", avatarUrl: null, connectionStatus: "none" },
        ],
        organisations: [{ handle: "acme", name: "Acme Inc", avatarUrl: null, isMember: false }],
      });
      renderSearch();
      await userEvent.fill(screen.getByRole("combobox"), "a");
      const listbox = await waitFor(() => screen.getByRole("listbox"), { timeout: 2000 });
      await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
      const panel = getComputedStyle(listbox.parentElement!);
      const root = getComputedStyle(document.documentElement);

      // 8px corners (`--radius-md`) on the raised surface, as `@shared/ui`'s menus.
      expect(panel.borderTopLeftRadius).toBe(root.getPropertyValue("--radius").trim());
      const probe = document.createElement("div");
      probe.style.backgroundColor = "var(--popover)";
      document.body.append(probe);
      expect(panel.backgroundColor).toBe(getComputedStyle(probe).backgroundColor);
      probe.remove();
      await page.screenshot({
        path: `../../../../e2e-artifacts/musubi-shell/search-panel-${theme}.png`,
      });
      document.documentElement.classList.remove("dark");
    },
  );
});
