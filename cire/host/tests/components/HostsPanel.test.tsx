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

// The purchase dialog prices and checks out on its own, and has its own tests;
// here it only has to open, selling the tier the panel names.
vi.mock("../../src/components/UpgradeDialog", () => ({
  default: (props: { tier: string; module: string; onClose: () => void }) => (
    <dialog open aria-label="Upgrade">
      Upgrade dialog for {props.tier} from {props.module}
      <button type="button" onClick={() => props.onClose()}>
        Close upgrade
      </button>
    </dialog>
  ),
}));

import HostsPanel from "../../src/components/HostsPanel";
import {
  activeProfileIdMock,
  authFetchMock,
  redirectSpy,
  resetOrganiserMocks,
  toastError,
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
    // The GET request hit the hosts endpoint.
    expect(String(authFetchMock.mock.calls[0]![0])).toBe(
      "https://api.test/api/organiser/weddings/wed_a/hosts",
    );
  });

  it("shows a fixed @ ahead of the add-host box and strips one a paste drops into the value", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    // The "@" is decoration next to the box, not part of its value — and
    // typing (or pasting) a leading "@" into the box doesn't double it up.
    expect(screen.getByText("@")).toBeTruthy();
    typeHandle("@bob");
    expect((handleInput() as HTMLInputElement).value).toBe("bob");
  });

  it("lists owners as seats, ahead of everyone else, each badged Owner", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        hosts: [
          { osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 },
          { osnProfileId: "usr_alice", handle: "alice", role: "owner", createdAt: 2 },
        ],
      }),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" />);
    await waitFor(() => expect(screen.getByText("@alice")).toBeTruthy());
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("@alice")).toBeTruthy();
    expect(within(rows[0]!).getByText("Owner")).toBeTruthy();
    expect(within(rows[1]!).getByText("@bob")).toBeTruthy();
  });

  it("falls back to an owner's profile id when the handle can't be resolved", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_alice", role: "owner", createdAt: 1 }] }),
    );
    // A viewer, so the badge is the only thing on the row naming the role.
    render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" />);
    await waitFor(() => expect(screen.getByText("usr_alice")).toBeTruthy());
    expect(within(screen.getByRole("listitem")).getByText("Owner")).toBeTruthy();
    // Owners only: nobody else is helping yet.
    expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy();
  });

  it("offers an owner the role and remove controls on another owner's row", async () => {
    activeProfileIdMock.mockImplementation(() => "usr_alice");
    authFetchMock.mockResolvedValueOnce(
      json({
        hosts: [
          { osnProfileId: "usr_alice", handle: "alice", role: "owner", createdAt: 1 },
          { osnProfileId: "usr_ben", handle: "ben", role: "owner", createdAt: 2 },
        ],
      }),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText("@ben")).toBeTruthy());
    expect((roleSelect("@ben") as HTMLSelectElement).value).toBe("owner");
    expect(screen.getByRole("button", { name: "Remove @ben" })).toBeTruthy();
  });

  it("marks the caller's own seat, offering a step down but no remove", async () => {
    activeProfileIdMock.mockImplementation(() => "usr_alice");
    authFetchMock.mockResolvedValueOnce(
      json({
        hosts: [
          { osnProfileId: "usr_alice", handle: "alice", role: "owner", createdAt: 1 },
          { osnProfileId: "usr_ben", handle: "ben", role: "owner", createdAt: 2 },
        ],
      }),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText("@alice")).toBeTruthy());
    const own = screen.getAllByRole("listitem")[0]!;
    expect(within(own).getByText("you")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Your role on this wedding/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove @alice" })).toBeNull();
  });

  it("asks before an owner steps down, then hands the new role up on yes, with no reload", async () => {
    activeProfileIdMock.mockImplementation(() => "usr_alice");
    authFetchMock.mockResolvedValueOnce(
      json({
        hosts: [
          { osnProfileId: "usr_alice", handle: "alice", role: "owner", createdAt: 1 },
          { osnProfileId: "usr_ben", handle: "ben", role: "owner", createdAt: 2 },
        ],
      }),
    );
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_alice", role: "editor", createdAt: 1 } }),
    );
    const onOwnRoleChanged = vi.fn();
    render(() => (
      <HostsPanel weddingId="wed_a" callerRole="owner" onOwnRoleChanged={onOwnRoleChanged} />
    ));
    await waitFor(() => expect(screen.getByText("@alice")).toBeTruthy());

    const own = screen.getByRole("combobox", { name: /Your role on this wedding/i });
    fireEvent.change(own, { target: { value: "editor" } });
    // Stepping down is asked about even though it takes something away: it is
    // the caller's own owner surface, and only another owner can give it back.
    expect(screen.getByText(/Step down to editor\?/i)).toBeTruthy();
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Yes, step down/i }));
    await waitFor(() => expect(onOwnRoleChanged).toHaveBeenCalledWith("editor"));
    expect(onOwnRoleChanged).toHaveBeenCalledTimes(1);
    // Two requests in all: the list and the role change. Nothing reloads.
    expect(authFetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts/usr_alice/role");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ role: "editor" });
  });

  it("says why when the API keeps the last owner (409 last_owner)", async () => {
    activeProfileIdMock.mockImplementation(() => "usr_alice");
    authFetchMock.mockResolvedValueOnce(
      json({
        hosts: [{ osnProfileId: "usr_alice", handle: "alice", role: "owner", createdAt: 1 }],
      }),
    );
    authFetchMock.mockResolvedValueOnce(json({ error: "last_owner" }, 409));
    const onOwnRoleChanged = vi.fn();
    render(() => (
      <HostsPanel weddingId="wed_a" callerRole="owner" onOwnRoleChanged={onOwnRoleChanged} />
    ));
    await waitFor(() => expect(screen.getByText("@alice")).toBeTruthy());

    fireEvent.change(screen.getByRole("combobox", { name: /Your role on this wedding/i }), {
      target: { value: "viewer" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Yes, step down/i }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/at least one owner/i)),
    );
    expect(onOwnRoleChanged).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("combobox", { name: /Your role on this wedding/i }) as HTMLSelectElement)
        .value,
    ).toBe("owner");
  });

  it("asks before making someone an owner", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 }] }),
    );
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", role: "owner", createdAt: 1 } }),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    fireEvent.change(roleSelect("@bob"), { target: { value: "owner" } });
    expect(screen.getByText(/Make @bob an owner\?/i)).toBeTruthy();
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Yes, make them owner/i }));
    await waitFor(() => expect((roleSelect("@bob") as HTMLSelectElement).value).toBe("owner"));
    expect(JSON.parse(String((authFetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      role: "owner",
    });
  });

  it("says why an add was refused when the wedding is full (409 host_cap_reached)", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "host_cap_reached" }, 409));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() =>
      expect(screen.getByText(/as many hosts as it can hold, owners included/i)).toBeTruthy(),
    );
  });

  it("says why removing an owner was refused (409 last_owner)", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_ben", handle: "ben", role: "owner", createdAt: 1 }] }),
    );
    authFetchMock.mockResolvedValueOnce(json({ error: "last_owner" }, 409));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText("@ben")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Remove @ben" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/at least one owner/i)),
    );
    expect(screen.getByText("@ben")).toBeTruthy();
  });

  it("explains every role, the owner's included, to an owner adding someone", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());
    const forOwner = screen.getByRole("group", { name: /What a co-host can do/i });
    for (const label of ["Owner", "Editor", "Viewer", "Helper"]) {
      expect(within(forOwner).getByText(label)).toBeTruthy();
    }
  });

  it("adds a host by handle and appends it to the list", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] })); // initial load
    authFetchMock.mockResolvedValueOnce(
      json({ host: { osnProfileId: "usr_bob", handle: "bob", role: "host", createdAt: 2 } }, 201),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    // Nothing in the form sets a role: choosing one before the person exists is
    // what this replaced. What the form carries instead is the explainers.
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.getByRole("group", { name: /What a co-host can do/i })).toBeTruthy();
  });

  it("puts the role explainers ahead of the handle input", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    // A demotion goes straight through — nothing is being handed over.
    fireEvent.change(roleSelect("@bob"), { target: { value: "viewer" } });

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = authFetchMock.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts/usr_bob/role");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ role: "viewer" });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    // The dropdown now reads as what the seat became.
    expect((roleSelect("@bob") as HTMLSelectElement).value).toBe("viewer");
  });

  it("asks before promoting someone to editor, and sends nothing until it is answered", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "viewer", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    fireEvent.change(roleSelect("@bob"), { target: { value: "helper" } });

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((authFetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      role: "helper",
    });
  });

  it("shows a helper seat as a helper, and offers every role on the row to an owner", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "helper", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    expect((roleSelect("@bob") as HTMLSelectElement).value).toBe("helper");
    const options = within(roleSelect("@bob")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Owner", "Editor", "Viewer", "Helper"]);
  });

  it("shows a role it does not recognise as the narrowest seat", async () => {
    // Including the API's legacy `host`, which no response should carry. The
    // row reads as the least a seat can be rather than being guessed upward.
    // Rendered for a non-owner so the badge is the only thing naming the role.
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "planner", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());

    expect(within(screen.getByRole("listitem")).getByText("Helper")).toBeTruthy();
  });

  it("gives an EDITOR neither the add form nor the role + remove controls", async () => {
    // Host management is owner-only, as every one of its routes is
    // `weddingOwner()`: offering any of these controls to an editor would only
    // produce a 403.
    authFetchMock.mockResolvedValueOnce(
      json({ hosts: [{ osnProfileId: "usr_bob", handle: "bob", role: "editor", createdAt: 1 }] }),
    );
    render(() => <HostsPanel weddingId="wed_a" callerRole="editor" />);
    await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Add host/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /Role for @bob/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
    // The role badge still shows — the read stays, only the write is withheld.
    expect(within(screen.getByRole("listitem")).getByText("Editor")).toBeTruthy();
    expect(screen.getByText(/an owner's call/i)).toBeTruthy();
  });

  it("says only an owner can add when the API refuses the add (403)", async () => {
    // The caller stopped being an owner after the panel loaded.
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("carol");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/Only an owner can add someone/i)).toBeTruthy());
  });

  it("shows a not-found message when the handle resolves to nobody (404)", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "No OSN account with that handle" }, 404));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("ghost");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/No OSN account found for @ghost/i)).toBeTruthy());
  });

  it("shows an already-a-host message on 409", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "already_host" }, 409));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() => expect(screen.getByText(/already a host/i)).toBeTruthy());
  });

  it("explains when adding hosts is unavailable (503)", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    authFetchMock.mockResolvedValueOnce(json({ error: "Adding hosts is not available" }, 503));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
    await waitFor(() => expect(screen.getByText(/No co-hosts yet/i)).toBeTruthy());

    typeHandle("bob");
    fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
    await waitFor(() =>
      expect(screen.getByText(/isn't available on this deployment/i)).toBeTruthy(),
    );
  });

  it("does not call the API when the handle is blank", async () => {
    authFetchMock.mockResolvedValueOnce(json({ hosts: [] }));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" />);
    await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add host/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
  });

  describe("leaving the wedding", () => {
    const hostsBody = () =>
      json({ hosts: [{ osnProfileId: "usr_bob", role: "viewer", createdAt: 1 }] });

    it("offers no leave control unless the dashboard hands it one", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
      expect(screen.queryByRole("button", { name: /Leave this wedding/i })).toBeNull();
    });

    it("asks first, then sends DELETE /hosts/me and reports the leave after the toast", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      authFetchMock.mockResolvedValueOnce(json({ left: true }));
      const order: string[] = [];
      toastSuccess.mockImplementation(() => order.push("toast"));
      const onLeft = vi.fn(() => order.push("left"));
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" canLeave onLeft={onLeft} />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      // Opening the dialog sends nothing.
      expect(authFetchMock).toHaveBeenCalledTimes(1);
      fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));

      await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
      const [url, init] = authFetchMock.mock.calls[1]!;
      expect(String(url)).toBe("https://api.test/api/organiser/weddings/wed_a/hosts/me");
      expect((init as RequestInit).method).toBe("DELETE");
      expect(order).toEqual(["toast", "left"]);
    });

    it("sends nothing when the confirmation is cancelled", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      const onLeft = vi.fn();
      render(() => <HostsPanel weddingId="wed_a" callerRole="editor" canLeave onLeft={onLeft} />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Cancel/i }));
      expect(authFetchMock).toHaveBeenCalledTimes(1);
      expect(onLeft).not.toHaveBeenCalled();
    });

    it("treats a 403 as already gone, and leaves the list to the dashboard's recheck", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      authFetchMock.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
      const onLeft = vi.fn();
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" canLeave onLeft={onLeft} />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
      expect(String(toastSuccess.mock.calls[0]![0])).toMatch(/no longer a host/i);
      expect(toastError).not.toHaveBeenCalled();
      // The 403 already triggered the dashboard's list recheck; a local drop
      // would make it ask twice.
      expect(onLeft).not.toHaveBeenCalled();
    });

    it("shows a plain error on a 500 and keeps the wedding", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      authFetchMock.mockResolvedValueOnce(json({ error: "Could not leave this wedding" }, 500));
      const onLeft = vi.fn();
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" canLeave onLeft={onLeft} />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));
      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(String(toastError.mock.calls[0]![0])).toMatch(/try again/i);
      expect(onLeft).not.toHaveBeenCalled();
    });

    it("sends a signed-out organiser to sign in", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      authFetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
      const onLeft = vi.fn();
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" canLeave onLeft={onLeft} />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));
      await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
      expect(onLeft).not.toHaveBeenCalled();
    });

    it("holds the dialog open and disabled while the leave is in flight", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      let settle!: (res: Response) => void;
      authFetchMock.mockReturnValueOnce(new Promise<Response>((r) => (settle = r)));
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" canLeave />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));

      const confirm = await screen.findByRole("button", { name: /Leaving…/i });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: /Cancel/i }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      settle(json({ left: true }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1));
    });

    it("sends an expired session to sign in", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      authFetchMock.mockRejectedValueOnce(new Error("AuthExpiredError"));
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" canLeave />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));
      await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    });

    it("says the API may be down on a network error, and keeps the wedding", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      authFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const onLeft = vi.fn();
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" canLeave onLeft={onLeft} />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));
      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(String(toastError.mock.calls[0]![0])).toMatch(/API running/i);
      expect(onLeft).not.toHaveBeenCalled();
    });

    it("keeps the wedding and tells the last owner what would let them go", async () => {
      authFetchMock.mockResolvedValueOnce(hostsBody());
      authFetchMock.mockResolvedValueOnce(json({ error: "last_owner" }, 409));
      const onLeft = vi.fn();
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" canLeave onLeft={onLeft} />);
      await waitFor(() => expect(screen.getByText("usr_bob")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /Leave this wedding/i }));
      fireEvent.click(await screen.findByRole("button", { name: /Yes, leave/i }));
      await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
      expect(String(toastError.mock.calls[0]![0])).toMatch(/only owner/i);
      expect(String(toastError.mock.calls[0]![0])).toMatch(/delete the wedding/i);
      expect(onLeft).not.toHaveBeenCalled();
    });
  });

  it("redirects to login on a 401 during load", async () => {
    authFetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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
    render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
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

  describe("the people limit", () => {
    const owner = (name: string) => ({
      osnProfileId: `usr_${name}`,
      handle: name,
      role: "owner",
      createdAt: 1,
    });
    const viewer = (name: string) => ({
      osnProfileId: `usr_${name}`,
      handle: name,
      role: "viewer",
      createdAt: 2,
    });
    const AT_LIMIT = { used: 6, limit: 6, tier: "gold" };
    const UNDER = { used: 5, limit: 6, tier: "ivory" };

    /** The trailing debounced handle search, answered with nothing. */
    const quietSearch = () =>
      authFetchMock.mockImplementation(() => Promise.resolve(json({ profiles: [] })));

    const posts = () =>
      authFetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");

    it("shows every member how many people the wedding holds against its limit", async () => {
      authFetchMock.mockResolvedValueOnce(
        json({ hosts: [owner("alice"), viewer("bob")], peopleLimit: { ...UNDER, used: 4 } }),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" />);
      await waitFor(() => expect(screen.getByText(/4 of 6 people/)).toBeTruthy());
      expect(screen.getByText(/first two owners don't count/i)).toBeTruthy();
    });

    it("shows no count when an older API sends none, and keeps the add form", async () => {
      authFetchMock.mockResolvedValueOnce(json({ hosts: [owner("alice")] }));
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText("@alice")).toBeTruthy());
      expect(screen.queryByText(/ of \d+ people/)).toBeNull();
      expect(handleInput()).toBeTruthy();
    });

    it("offers an owner the upgrade instead of the add form at the limit", async () => {
      authFetchMock.mockResolvedValueOnce(
        json({ hosts: [owner("alice"), owner("ben"), viewer("bob")], peopleLimit: AT_LIMIT }),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() =>
        expect(screen.getByText(/reached its plan's limit of 6 people/i)).toBeTruthy(),
      );
      expect(screen.queryByRole("combobox", { name: /OSN handle/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Add host/i })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Upgrade to Gold" }));
      expect(screen.getByRole("dialog", { name: "Upgrade" }).textContent).toContain(
        "Upgrade dialog for gold from settings",
      );
      fireEvent.click(screen.getByRole("button", { name: "Close upgrade" }));
      expect(screen.queryByRole("dialog", { name: "Upgrade" })).toBeNull();
    });

    it("says plainly when no plan holds more, and offers no upgrade", async () => {
      authFetchMock.mockResolvedValueOnce(
        json({
          hosts: [owner("alice"), owner("ben")],
          peopleLimit: { used: 40, limit: 40, tier: null },
        }),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText(/No plan holds more/i)).toBeTruthy());
      expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Add/i })).toBeNull();
    });

    it("shows a viewer the count at the limit, but no offer", async () => {
      authFetchMock.mockResolvedValueOnce(
        json({ hosts: [owner("alice"), owner("ben")], peopleLimit: AT_LIMIT }),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="viewer" />);
      await waitFor(() => expect(screen.getByText(/6 of 6 people/)).toBeTruthy());
      expect(screen.queryByRole("button", { name: /Upgrade to/i })).toBeNull();
    });

    it("keeps an add-as-owner form at the limit while the wedding has one owner", async () => {
      quietSearch();
      activeProfileIdMock.mockImplementation(() => "usr_alice");
      authFetchMock.mockResolvedValueOnce(json({ hosts: [owner("alice")], peopleLimit: AT_LIMIT }));
      authFetchMock.mockResolvedValueOnce(
        json(
          {
            host: { osnProfileId: "usr_bob", handle: "bob", role: "owner", createdAt: 3 },
            peopleLimit: AT_LIMIT,
          },
          201,
        ),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText(/can still add a second owner/i)).toBeTruthy());
      // The way out is there too.
      expect(screen.getByRole("button", { name: "Upgrade to Gold" })).toBeTruthy();

      typeHandle("bob");
      fireEvent.click(screen.getByRole("button", { name: /Add as owner/i }));
      // Making someone an owner hands them everything, so it asks first.
      expect(screen.getByText(/Add @bob as an owner\?/i)).toBeTruthy();
      expect(posts()).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: /Yes, add them as an owner/i }));

      await waitFor(() => expect(screen.getByText("@bob")).toBeTruthy());
      expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({
        handle: "@bob",
        role: "owner",
      });
      // Two owners now, so the offer replaces the form.
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /Add as owner/i })).toBeNull(),
      );
    });

    it("sends nothing when the add-as-owner confirmation is cancelled", async () => {
      quietSearch();
      authFetchMock.mockResolvedValueOnce(json({ hosts: [owner("alice")], peopleLimit: AT_LIMIT }));
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText(/can still add a second owner/i)).toBeTruthy());
      typeHandle("bob");
      fireEvent.click(screen.getByRole("button", { name: /Add as owner/i }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByText(/Add @bob as an owner\?/i)).toBeNull());
      expect(posts()).toHaveLength(0);
    });

    it("swaps the form for the offer when an add is refused at the limit (409)", async () => {
      quietSearch();
      authFetchMock.mockResolvedValueOnce(
        json({ hosts: [owner("alice"), owner("ben")], peopleLimit: UNDER }),
      );
      authFetchMock.mockResolvedValueOnce(
        json({ error: "people_limit_reached", ...AT_LIMIT }, 409),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText(/5 of 6 people/)).toBeTruthy());

      typeHandle("bob");
      fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Upgrade to Gold" })).toBeTruthy(),
      );
      expect(screen.getByText(/6 of 6 people/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Add host/i })).toBeNull();
    });

    it("moves into the limit after an add and back out after a removal", async () => {
      quietSearch();
      authFetchMock.mockResolvedValueOnce(
        json({ hosts: [owner("alice"), owner("ben")], peopleLimit: UNDER }),
      );
      authFetchMock.mockResolvedValueOnce(
        json({ host: viewer("bob"), peopleLimit: AT_LIMIT }, 201),
      );
      authFetchMock.mockResolvedValueOnce(
        json({ removed: true, osnProfileId: "usr_bob", peopleLimit: UNDER }),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText(/5 of 6 people/)).toBeTruthy());

      typeHandle("bob");
      fireEvent.click(screen.getByRole("button", { name: /Add host/i }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Upgrade to Gold" })).toBeTruthy(),
      );

      fireEvent.click(screen.getByRole("button", { name: "Remove @bob" }));
      await waitFor(() => expect(screen.getByRole("button", { name: /Add host/i })).toBeTruthy());
      expect(screen.getByText(/5 of 6 people/)).toBeTruthy();
    });

    it("words a role change the limit refused, and keeps the seat's role", async () => {
      activeProfileIdMock.mockImplementation(() => "usr_alice");
      authFetchMock.mockResolvedValueOnce(
        json({ hosts: [owner("alice"), owner("ben")], peopleLimit: AT_LIMIT }),
      );
      authFetchMock.mockResolvedValueOnce(
        json({ error: "people_limit_reached", ...AT_LIMIT }, 409),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText("@ben")).toBeTruthy());

      fireEvent.change(roleSelect("@ben"), { target: { value: "viewer" } });
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "This wedding has reached its plan's limit of 6 people. Remove someone, or upgrade to Gold.",
        ),
      );
      expect((roleSelect("@ben") as HTMLSelectElement).value).toBe("owner");
    });

    it("updates the count from a role change the API accepted", async () => {
      activeProfileIdMock.mockImplementation(() => "usr_alice");
      authFetchMock.mockResolvedValueOnce(
        json({ hosts: [owner("alice"), owner("ben"), viewer("bob")], peopleLimit: UNDER }),
      );
      authFetchMock.mockResolvedValueOnce(
        json({
          host: { osnProfileId: "usr_ben", role: "viewer", createdAt: 1 },
          peopleLimit: AT_LIMIT,
        }),
      );
      render(() => <HostsPanel weddingId="wed_a" callerRole="owner" />);
      await waitFor(() => expect(screen.getByText(/5 of 6 people/)).toBeTruthy());
      fireEvent.change(roleSelect("@ben"), { target: { value: "viewer" } });
      await waitFor(() => expect(screen.getByText(/6 of 6 people/)).toBeTruthy());
    });
  });
});
