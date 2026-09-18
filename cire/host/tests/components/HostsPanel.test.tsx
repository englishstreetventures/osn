// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * HostsPanel lists a wedding's co-hosts and (for owners) adds one by OSN handle
 * or removes one. The OSN auth + api helpers + toasts are stubbed; this asserts
 * the wiring — the requests it sends, the optimistic list updates, the
 * owner-vs-co-host affordances, and the add error branches (404 / 409 / 503).
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import HostsPanel from "../../src/components/HostsPanel";
import {
  authFetchMock,
  redirectSpy,
  resetOrganiserMocks,
  toastSuccess,
} from "../test-support/mocks";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The add-host input: a combobox (`role="combobox"`) now it has autocomplete.
 *  Found by its accessible name rather than by role alone — a co-host row's
 *  role dropdown is a native `<select>`, which is a combobox too, so a bare
 *  role query matches several the moment the list has anyone in it. */
function handleInput() {
  return screen.getByRole("combobox", { name: /OSN handle/i });
}

function typeHandle(value: string) {
  fireEvent.input(handleInput(), { target: { value } });
}

/** A co-host row's role dropdown, by the person it belongs to. */
function roleSelect(name: string) {
  return screen.getByRole("combobox", { name: new RegExp(`Role for ${name}`, "i") });
}

describe("HostsPanel", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("loads and lists existing hosts", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", role: "host", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
    // The GET request hit the hosts endpoint.
    expect(String(authFetchMock.mock.calls[0]![0])).toBe(
      "https://api.test/api/organiser/weddings/wed_a/hosts",
    );
  });

  it("shows a fixed @ ahead of the add-host box and strips one a paste drops into the value", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    // The "@" is decoration next to the box, not part of its value — and
    // typing (or pasting) a leading "@" into the box doesn't double it up.
    expect(screen.getByText("@")).toBeTruthy();
    typeHandle("@bob");
    expect((handleInput() as HTMLInputElement).value).toBe("bob");
  });

  it("shows the wedding's owner above the co-hosts, with no role badge or remove control", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        owner: { osnProfileId: "usr_alice", handle: "alice", displayName: "Alice" },
        hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 }],
      }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("@alice")).toBeTruthy());
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("@bob")).toBeTruthy();
    // The owner's row carries no role-change or remove control — those actions
    // don't apply to an owner, unlike the co-host row right below it.
    expect(screen.queryByRole("button", { name: /Make @alice/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove @alice/i })).toBeNull();
  });

  it("falls back to the owner's profile id when the handle can't be resolved", async () => {
    authFetchMock.mockResolvedValueOnce(json({ owner: { osnProfileId: "usr_alice" }, hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("usr_alice")).toBeTruthy());
    expect(screen.getByText("Owner")).toBeTruthy();
  });

  it("adds a host by handle and appends it to the list", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", handle: "bob", role: "host", createdAt: 2 } }, 201),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("@bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));

    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts");
    expect((init as RequestInit).method).toBe("POST");
    // Everyone joins as a viewer. The role is chosen afterwards, on their row.
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      handle: "@bob",
      role: "viewer",
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("offers no role picker in the add form — a seat starts at viewer", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    // Nothing in the form sets a role: choosing one before the person exists is
    // what this replaced. What the form carries instead is the explainers.
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.getByRole("group", { name: /What a co-host can do/i })).toBeTruthy();
  });

  it("puts the role explainers ahead of the handle input", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    const explainers = screen.getByRole("group", { name: /What a co-host can do/i });
    // Reading order, not styling: the decision the explainers inform is made
    // before the box that names a person, so they precede it in the document.
    expect(explainers.compareDocumentPosition(handleInput())).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    for (const role of ["Editor", "Viewer", "Helper"]) {
      expect(within(explainers).getByText(role)).toBeTruthy();
    }
  });

  it("changes a host's role from the row's dropdown (PUT …/role)", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 }] }),
    );
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", role: "viewer", createdAt: 1 } }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    // A demotion goes straight through — nothing is being handed over.
    fireEvent.change(roleSelect("@bob"), { target: { value: "viewer" } });

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts/usr_bob/role");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ role: "viewer" });
    expect(toastSuccess).toHaveBeenCalled();
    // The dropdown now reads as what the seat became.
    expect((roleSelect("@bob") as HTMLSelectElement).value).toBe("viewer");
  });

  it("asks before promoting someone to editor, and sends nothing until it is answered", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "viewer", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    fireEvent.change(roleSelect("@bob"), { target: { value: "editor" } });

    // The dialog is up and the request is not: editor is the widest a seat can
    // be given, so it is the one grant that stops to ask.
    expect(screen.getByText(/Make @bob an editor\?/i)).toBeTruthy();
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the promotion once it is confirmed", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "viewer", createdAt: 1 }] }),
    );
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", role: "editor", createdAt: 1 } }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    fireEvent.change(roleSelect("@bob"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: /Yes, make them editor/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts/usr_bob/role");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ role: "editor" });
    await waitFor(() => expect((roleSelect("@bob") as HTMLSelectElement).value).toBe("editor"));
  });

  it("sends nothing and puts the dropdown back when the confirmation is dismissed", async () => {
    // The select changed in the DOM the moment the option was picked, so a
    // dismissal that only closed the dialog would leave it showing a role
    // nobody granted.
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "viewer", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    fireEvent.change(roleSelect("@bob"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect((roleSelect("@bob") as HTMLSelectElement).value).toBe("viewer");
  });

  it("does not ask when the change takes something away", async () => {
    // A demotion is reversible by the same person in the same place, so a
    // prompt on it is a prompt that teaches people to click through prompts.
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 }] }),
    );
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", role: "helper", createdAt: 1 } }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    fireEvent.change(roleSelect("@bob"), { target: { value: "helper" } });

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((authFetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      role: "helper",
    });
  });

  it("shows a helper seat as a helper, and offers all three roles on the row", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "helper", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    expect((roleSelect("@bob") as HTMLSelectElement).value).toBe("helper");
    const options = within(roleSelect("@bob")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Editor", "Viewer", "Helper"]);
  });

  it("shows a role it does not recognise as the narrowest seat", async () => {
    // Including the API's legacy `host`, which no response should carry. The
    // row reads as the least a seat can be rather than being guessed upward.
    // Rendered for a non-owner so the badge is the only thing naming the role.
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "planner", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage={false} canAdd={false} />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    expect(within(screen.getByRole("listitem")).getByText("Helper")).toBeTruthy();
  });

  it("gives an EDITOR the add form but not the role + remove controls", async () => {
    // The additive/subtractive split, mirroring the API's two gates: an editor
    // can bring someone else on board (`weddingEditor()` on POST /hosts) but
    // cannot demote or evict anyone (`weddingOwner()` on PUT/DELETE). Offering
    // either of those controls here would just produce a 403.
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage={false} canAdd />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
    expect(screen.getByRole("button", { name: /Add host/i })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /Role for @bob/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
    // The role badge still shows — the read stays, only the write is withheld.
    // Scoped to the list, since the explainers above also say "Editor".
    expect(within(screen.getByRole("listitem")).getByText("Editor")).toBeTruthy();
  });

  it("lets an editor actually submit an add (the form is wired, not decorative)", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(
      json(
        { host: { osnProfileId: "usr_carol", handle: "carol", role: "editor", createdAt: 2 } },
        201,
      ),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage={false} canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("carol");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText("@carol")).toBeTruthy());
    const [, add] = authFetchMock.mock.calls;
    expect((add?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("shows a not-found message when the handle resolves to nobody (404)", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "No OSN account with that handle" }, 404));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("ghost");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/No OSN account found for @ghost/i)).toBeTruthy());
  });

  it("shows an already-a-host message on 409", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "already_host" }, 409));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/already a host/i)).toBeTruthy());
  });

  it("explains when adding hosts is unavailable (503)", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "Adding hosts is not available" }, 503));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() =>
      expect(screen.getByText(/isn't available on this deployment/i)).toBeTruthy(),
    );
  });

  it("does not call the API when the handle is blank", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("   ");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/Enter an OSN handle/i)).toBeTruthy());
    // Only the initial load happened.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes a host on click", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", role: "host", createdAt: 1 }] }),
    );
    authFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ removed: true }), { status: 200 }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Remove/i }));
    await waitFor(() => expect(screen.queryByText("usr_bob")).toBeNull());
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts/usr_bob");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("hides the add form and remove controls for a VIEWER co-host (read-only)", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", role: "host", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage={false} canAdd={false} />);
    await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add host/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
  });

  it("redirects to login on a 401 during load", async () => {
    authFetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
  });

  // --- Handle autocomplete ---------------------------------------------------

  /** Convenience: the search response shape returned by /handle-search. */
  function searchJson(
    profiles: {
      profileId: string;
      handle: string;
      displayName: string | null;
      connected?: boolean;
    }[],
  ) {
    return json({ profiles });
  }

  /** Focus the add-co-host combobox — triggers the on-focus connections fetch. */
  function focusHandle() {
    fireEvent.focus(handleInput());
  }

  it("debounces the search and fetches suggestions for a 2+ char prefix", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      searchJson([
        { profileId: "usr_alice", handle: "alice", displayName: "Alice" },
        { profileId: "usr_alina", handle: "alina", displayName: null },
      ]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("al");
    // Suggestions appear after the debounce + fetch resolves.
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    expect(screen.getByText("@alice")).toBeTruthy();
    expect(screen.getByText("@alina")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy(); // displayName rendered

    // The second call is the debounced search hitting the handle-search endpoint.
    const [url] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/handle-search?q=al");
    // Exactly one search fetch despite a single multi-char input (debounced).
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it("searches a single character too — connections have no minimum length", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      searchJson([{ profileId: "usr_zoe", handle: "zoe", displayName: "Zoe", connected: true }]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    // The old two-character floor existed for the global handle search; the
    // connection source has no namespace to enumerate, so one character is
    // enough to narrow a list the organiser already has access to.
    typeHandle("z");
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    expect(screen.getByText("@zoe")).toBeTruthy();
    const [url] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/handle-search?q=z");
  });

  // --- Connections-driven suggestions -----------------------------------------

  it("shows the organiser's OSN connections on focus, before a keystroke", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      searchJson([
        { profileId: "usr_alina", handle: "alina", displayName: "Alina Rao", connected: true },
        { profileId: "usr_zoe", handle: "zoe", displayName: null, connected: true },
      ]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    focusHandle();
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    expect(screen.getByText("@alina")).toBeTruthy();
    expect(screen.getByText("@zoe")).toBeTruthy();
    // The caption is what makes an unprompted dropdown legible.
    expect(screen.getByText("From your OSN connections")).toBeTruthy();
    // An empty query is what asks the API for connections.
    const [url] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/handle-search?q=");
  });

  it("fetches the connections list once per focus cycle, not on every focus", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(
      searchJson([{ profileId: "usr_zoe", handle: "zoe", displayName: null, connected: true }]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    focusHandle();
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    fireEvent.blur(handleInput());
    focusHandle();
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());

    // Initial host load + exactly one connections fetch: re-focusing reopens the
    // cached list rather than spending another (rate-limited) request.
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it("badges a connection in a mixed result list", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(
      searchJson([
        { profileId: "usr_alina", handle: "alina", displayName: "Alina Rao", connected: true },
        { profileId: "usr_alice", handle: "alice", displayName: "Alice", connected: false },
      ]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("al");
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    const options = screen.getAllByRole("option");
    // Connections lead the list (the API ranks them) and carry the badge; the
    // non-connection does not.
    expect(within(options[0]!).getByText("@alina")).toBeTruthy();
    expect(within(options[0]!).getByText(/Connected/i)).toBeTruthy();
    expect(within(options[1]!).queryByText(/Connected/i)).toBeNull();
    // No caption — this list isn't the plain connections browse.
    expect(screen.queryByText("From your OSN connections")).toBeNull();
  });

  it("omits the per-row badge when the whole list is connections", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(
      searchJson([{ profileId: "usr_zoe", handle: "zoe", displayName: null, connected: true }]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    focusHandle();
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    // The caption already says it — a badge on every row would be noise.
    expect(screen.getByText("From your OSN connections")).toBeTruthy();
    expect(within(screen.getByRole("option")).queryByText(/Connected/i)).toBeNull();
  });

  it("does NOT refetch connections when focusing an input that already has text", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(
      searchJson([
        { profileId: "usr_alina", handle: "alina", displayName: "Alina Rao", connected: true },
        { profileId: "usr_alice", handle: "alice", displayName: "Alice", connected: false },
      ]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("al");
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    fireEvent.blur(handleInput());
    focusHandle();

    // Refetching "" here would swap their filtered matches for the unfiltered
    // connections list and flip the caption — mid-edit, unprompted.
    await new Promise((r) => setTimeout(r, 50));
    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("From your OSN connections")).toBeNull();
  });

  it("serves the cached connections on backspace-to-empty instead of refetching", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(
      searchJson([{ profileId: "usr_zoe", handle: "zoe", displayName: null, connected: true }]),
    );
    authFetchMock.mockResolvedValueOnce(
      searchJson([
        { profileId: "usr_alice", handle: "alice", displayName: null, connected: false },
      ]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    focusHandle();
    await waitFor(() => expect(screen.getByText("@zoe")).toBeTruthy());
    typeHandle("al");
    await waitFor(() => expect(screen.getByText("@alice")).toBeTruthy());

    // Clearing the field re-shows the cached connections. The upstream query
    // for an empty search scans the organiser's whole connection list, so it
    // must not re-run every time they backspace.
    typeHandle("");
    await waitFor(() => expect(screen.getByText("@zoe")).toBeTruthy());
    expect(screen.getByText("From your OSN connections")).toBeTruthy();
    expect(authFetchMock).toHaveBeenCalledTimes(3);
  });

  it("re-pulls connections after an add, since the added host is now stale in the list", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      searchJson([{ profileId: "usr_zoe", handle: "zoe", displayName: null, connected: true }]),
    );
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_zoe", handle: "zoe", role: "editor", createdAt: 2 } }, 201),
    );
    authFetchMock.mockResolvedValueOnce(searchJson([]));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    focusHandle();
    await waitFor(() => expect(screen.getByRole("option")).toBeTruthy());
    fireEvent.mouseDown(screen.getByRole("option", { name: /@zoe/i }));
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());

    // Without the post-add cache reset, @zoe would sit in the cached dropdown
    // forever — a suggestion whose click now leads straight to a 409.
    focusHandle();
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(4));
    expect(String(authFetchMock.mock.calls[3]![0])).toBe(
      "https://api.test/api/organiser/handle-search?q=",
    );
  });

  it("a slow on-focus fetch cannot clobber a newer typed search", async () => {
    // Focus bypasses the debounce, so the on-focus fetch and the first
    // keystroke's fetch are routinely in flight together. If the focus response
    // lands last, the dropdown must NOT revert to the unfiltered list.
    let resolveFocusFetch: ((r: Response) => void) | undefined;
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFocusFetch = resolve;
        }),
    );
    authFetchMock.mockResolvedValueOnce(
      searchJson([
        { profileId: "usr_alice", handle: "alice", displayName: null, connected: false },
      ]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    focusHandle(); // starts the (hanging) q= fetch
    typeHandle("al"); // debounces into the q=al fetch
    await waitFor(() => expect(screen.getByText("@alice")).toBeTruthy());

    // The superseded focus response arrives late and must be discarded.
    resolveFocusFetch?.(
      searchJson([{ profileId: "usr_zoe", handle: "zoe", displayName: null, connected: true }]),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText("@alice")).toBeTruthy();
    expect(screen.queryByText("@zoe")).toBeNull();
    expect(screen.queryByText("From your OSN connections")).toBeNull();
  });

  it("fails soft (no dropdown) when the connections fetch errors on focus", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "nope" }, 500));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    focusHandle();
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("listbox")).toBeNull();
    // Manual typing is untouched by a search outage.
    expect((handleInput() as HTMLInputElement).disabled).toBe(false);
  });

  it("fills the input when a suggestion is selected", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(
      searchJson([{ profileId: "usr_alice", handle: "alice", displayName: "Alice" }]),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("al");
    await waitFor(() => expect(screen.getByRole("option")).toBeTruthy());

    fireEvent.mouseDown(screen.getByRole("option", { name: /@alice/i }));
    // The input now holds the chosen handle and the list is gone. The box's
    // own value never carries the "@" — that's the fixed prefix rendered
    // beside it.
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect((handleInput() as HTMLInputElement).value).toBe("alice");
  });

  it("fails soft (no listbox) when the search endpoint errors", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "nope" }, 500));
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("al");
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("still allows manual type-and-submit without picking a suggestion", async () => {
    // The user types and submits immediately, before the search debounce fires.
    // The add POST is therefore call #2; a default mock absorbs the trailing
    // debounced search so it can't reject unmatched.
    authFetchMock.mockImplementation(() => Promise.resolve(searchJson([])));
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // load
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", handle: "bob", role: "host", createdAt: 2 } }, 201),
    );
    render(() => <HostsPanel weddingId="wed_a" canManage canAdd />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
    // The add request used the hosts POST endpoint, not the search endpoint.
    const postCall = authFetchMock.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(String(postCall?.[0])).toBe("https://api.test/api/organiser/weddings/wed_a/hosts");
  });
});
