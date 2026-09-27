// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may bring a plus-one, on the Households tab.
 *
 * An editor turns it on or off per guest (a switch) or per household ("Allow
 * everyone" / "Allow no one"); a viewer sees the switches read-only. Turning it
 * off where a plus-one is already named deletes that plus-one with their
 * replies, outside the change history, so the table asks first, naming them,
 * reads the list again before it sends the remove flag, and never sends it at
 * all without a yes.
 *
 * The API is a small in-memory stand-in routed by URL, so a test can change
 * what the server holds between two reads — which is exactly the case the
 * re-read exists for.
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

vi.mock("../../src/lib/osn", () => ({ CIRE_WEB_URL: "https://guests.test" }));

import GuestTable from "../../src/components/GuestTable";
import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache, type OrganiserGuestRow } from "../../src/lib/guests-store";
import {
  __resetHouseholdsCache,
  ensureHouseholdsLoaded,
  hasCachedHouseholds,
} from "../../src/lib/households-store";
import {
  authFetchMock,
  redirectSpy,
  resetOrganiserMocks,
  toastError,
  toastSuccess,
} from "../test-support/mocks";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const SHARMA = {
  familyId: "fam_a",
  publicId: "SHARMA-WIDGET-AB3K9",
  familyName: "Sharma",
  codeSharedAt: null,
  firstOpenedAt: null,
  deactivatedAt: null,
};
const JONES = {
  familyId: "fam_b",
  publicId: "JONES-KITE-77Q2",
  familyName: "Jones",
  codeSharedAt: null,
  firstOpenedAt: null,
  deactivatedAt: null,
};

function guest(
  household: typeof SHARMA,
  guestId: string,
  firstName: string,
  lastName: string,
  extra: Partial<OrganiserGuestRow> = {},
): OrganiserGuestRow {
  return {
    ...household,
    guestId,
    firstName,
    lastName,
    nickname: null,
    events: ["evt_1"],
    plusOneAllowed: false,
    plusOneOf: null,
    ...extra,
  };
}

// Sam is listed first: the API orders by sort order, and a plus-one's is
// whatever was free when they were named.
const sam = () => guest(SHARMA, "g_sam", "Sam", "Lee", { plusOneOf: "g_ada" });
const ada = () => guest(SHARMA, "g_ada", "Ada", "Sharma", { plusOneAllowed: true });
const bo = () => guest(SHARMA, "g_bo", "Bo", "Sharma");
const cy = () => guest(JONES, "g_cy", "Cy", "Jones", { plusOneAllowed: true });

/** What the stand-in API holds. Tests change it between reads. */
let server: OrganiserGuestRow[] = [];
/** How the stand-in answers a permission PUT. */
let answerPut: (url: string, body: Record<string, unknown>) => Response | Promise<Response> = () =>
  json({});
const guestReads = () =>
  authFetchMock.mock.calls.filter(
    ([url, init]) => String(url).endsWith("/guests") && !(init as RequestInit | undefined)?.method,
  ).length;
const puts = () =>
  authFetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse(String((init as RequestInit).body)) as unknown,
    }));

/** A PUT that the stand-in applies the way the API does. */
function applyPut(url: string, body: Record<string, unknown>): Response {
  const allowed = body.allowed === true;
  const guestMatch = /\/guests\/([^/]+)\/plus-one$/.exec(url);
  const familyMatch = /\/families\/([^/]+)\/plus-one$/.exec(url);
  if (guestMatch) {
    const id = decodeURIComponent(guestMatch[1]!);
    const named = server.some((g) => g.plusOneOf === id);
    if (!allowed && named && body.removePlusOne !== true) {
      return json({ error: "plus_one_named", named: 1 }, 409);
    }
    const removing = !allowed && named;
    server = server
      .filter((g) => !(removing && g.plusOneOf === id))
      .map((g) => (g.guestId === id ? Object.assign({}, g, { plusOneAllowed: allowed }) : g));
    return json({ guestId: id, plusOneAllowed: allowed, plusOneRemoved: removing });
  }
  const familyId = decodeURIComponent(familyMatch![1]!);
  const named = server.filter((g) => g.familyId === familyId && g.plusOneOf).length;
  if (!allowed && named > 0 && body.removePlusOnes !== true) {
    return json({ error: "plus_one_named", named }, 409);
  }
  const removing = !allowed && named > 0;
  server = server
    .filter((g) => !(removing && g.familyId === familyId && g.plusOneOf))
    .map((g) =>
      g.familyId === familyId && !g.plusOneOf
        ? Object.assign({}, g, { plusOneAllowed: allowed })
        : g,
    );
  return json({
    familyId,
    plusOneAllowed: allowed,
    guestsUpdated: server.filter((g) => g.familyId === familyId && !g.plusOneOf).length,
    plusOnesRemoved: removing ? named : 0,
  });
}

beforeEach(() => {
  server = [sam(), ada(), bo(), cy()];
  answerPut = applyPut;
  authFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return Promise.resolve(
        answerPut(url, JSON.parse(String(init.body)) as Record<string, unknown>),
      );
    }
    if (url.endsWith("/guests")) return Promise.resolve(json(server));
    if (url.endsWith("/events")) {
      return Promise.resolve(json([{ id: "evt_1", name: "Ceremony", slug: "c", sortOrder: 0 }]));
    }
    if (url.endsWith("/invite")) return Promise.resolve(json({ inviteMessage: null }));
    return Promise.resolve(json({}));
  });
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  __resetGuestsCache();
  __resetEventsCache();
  __resetHouseholdsCache();
});

async function mount(canEdit = true) {
  render(() => (
    <GuestTable
      weddingId="wed_a"
      canManage={false}
      canEdit={canEdit}
      weddingName="Nadia & Sam"
      weddingSlug="nadia-sam"
    />
  ));
  await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());
}

const switchFor = (name: string) =>
  screen.getByRole("switch", { name: `${name} may bring a plus-one` }) as HTMLInputElement;
const householdGroup = (familyName: string) =>
  screen.getByRole("group", { name: `Plus-ones for the ${familyName} household` });
const guestRowNames = () =>
  screen
    .getAllByRole("row")
    .map((row) => row.querySelector("td")?.textContent?.trim() ?? "")
    .filter((text) => text.length > 0);

describe("GuestTable — plus-one permission", () => {
  it("shows each guest's stored permission, as read from the list", async () => {
    await mount();
    expect(switchFor("Ada Sharma").getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("Cy Jones").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("columnheader", { name: "Plus-one" })).toBeTruthy();
  });

  it("lists a plus-one after the guest who brought them, named as theirs, with no switch", async () => {
    await mount();
    const names = guestRowNames();
    const adaAt = names.findIndex((n) => n.startsWith("Ada Sharma"));
    expect(names[adaAt + 1]).toMatch(/^Sam Lee\s+Plus-one of Ada Sharma$/);
    expect(names[adaAt + 2]).toMatch(/^Bo Sharma/);
    expect(screen.queryByRole("switch", { name: /Sam Lee/ })).toBeNull();
  });

  it("turns one guest's permission on and keeps the same switch, and focus, afterwards", async () => {
    await mount();
    const before = switchFor("Bo Sharma");
    before.focus();
    fireEvent.click(before);

    await waitFor(() => expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("true"));
    expect(puts()).toEqual([
      {
        url: "https://api.test/api/organiser/weddings/wed_a/guests/g_bo/plus-one",
        body: { allowed: true },
      },
    ]);
    // Updated in place, not rebuilt: the row, the switch and the focus survive.
    expect(switchFor("Bo Sharma")).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it("turns a guest off without asking when they have named no one", async () => {
    await mount();
    fireEvent.click(switchFor("Cy Jones"));
    await waitFor(() => expect(switchFor("Cy Jones").getAttribute("aria-checked")).toBe("false"));
    expect(puts()).toEqual([
      {
        url: "https://api.test/api/organiser/weddings/wed_a/guests/g_cy/plus-one",
        body: { allowed: false },
      },
    ]);
    expect(screen.queryByText(/cannot be undone/)).toBeNull();
  });

  it("asks before removing a named plus-one, naming them, and sends nothing on Cancel", async () => {
    await mount();
    fireEvent.click(switchFor("Ada Sharma"));

    expect(await screen.findByText("Remove Sam Lee?")).toBeTruthy();
    expect(screen.getByText(/Ada Sharma named Sam Lee as their plus-one/)).toBeTruthy();
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    expect(puts()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(puts()).toEqual([]);
    expect(switchFor("Ada Sharma").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Plus-one of Ada Sharma/)).toBeTruthy();
  });

  it("puts Cancel before the destructive button, and describes the removal on it", async () => {
    await mount();
    fireEvent.click(switchFor("Ada Sharma"));
    const buttons = within(await screen.findByRole("dialog")).getAllByRole("button");
    expect(buttons[0]!.textContent).toBe("Cancel");
    const remove = screen.getByRole("button", { name: "Remove Sam Lee" });
    const described = document.getElementById(remove.getAttribute("aria-describedby")!);
    expect(described?.textContent).toMatch(/removes Sam Lee from the guest list/);
  });

  it("on yes, reads the list again, then sends the remove flag, and the plus-one leaves", async () => {
    await mount();
    fireEvent.click(switchFor("Ada Sharma"));
    const readsBefore = guestReads();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam Lee" }));

    await waitFor(() => expect(screen.queryByText(/Plus-one of Ada Sharma/)).toBeNull());
    expect(guestReads()).toBe(readsBefore + 1);
    expect(puts()).toEqual([
      {
        url: "https://api.test/api/organiser/weddings/wed_a/guests/g_ada/plus-one",
        body: { allowed: false, removePlusOne: true },
      },
    ]);
    expect(switchFor("Ada Sharma").getAttribute("aria-checked")).toBe("false");
    expect(toastSuccess).toHaveBeenCalledWith("Removed Sam Lee");
  });

  it("asks again, about the new name, when the household changed its plus-one before the yes", async () => {
    await mount();
    fireEvent.click(switchFor("Ada Sharma"));
    // Meanwhile the household swaps Sam for Kit.
    server = [guest(SHARMA, "g_kit", "Kit", "Ng", { plusOneOf: "g_ada" }), ada(), bo(), cy()];
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam Lee" }));

    await waitFor(() => expect(screen.getByText("Remove Kit Ng?")).toBeTruthy());
    expect(screen.getByText(/changed its plus-ones since the list loaded/)).toBeTruthy();
    expect(puts()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Remove Kit Ng" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ allowed: false, removePlusOne: true });
  });

  it("asks again when the household renamed its plus-one before the yes, though the id is the same", async () => {
    await mount();
    fireEvent.click(switchFor("Ada Sharma"));
    // A rename keeps the row, so only the name tells the two apart.
    server = [guest(SHARMA, "g_sam", "Kit", "Ng", { plusOneOf: "g_ada" }), ada(), bo(), cy()];
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam Lee" }));

    await waitFor(() => expect(screen.getByText("Remove Kit Ng?")).toBeTruthy());
    expect(puts()).toEqual([]);
  });

  it("sends a plain turn-off when the plus-one was already taken back before the yes", async () => {
    await mount();
    fireEvent.click(switchFor("Ada Sharma"));
    server = [ada(), bo(), cy()];
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam Lee" }));

    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toEqual({ allowed: false });
    await waitFor(() => expect(switchFor("Ada Sharma").getAttribute("aria-checked")).toBe("false"));
  });

  it("when the API says a plus-one was named since the list loaded, reloads and asks", async () => {
    await mount();
    // Named after this list was read: the table thinks Cy brings no one.
    server = [...server, guest(JONES, "g_max", "Max", "Roe", { plusOneOf: "g_cy" })];
    fireEvent.click(switchFor("Cy Jones"));

    await waitFor(() => expect(screen.getByText("Remove Max Roe?")).toBeTruthy());
    expect(screen.getByText(/changed its plus-ones since the list loaded/)).toBeTruthy();
    expect(puts()).toEqual([
      {
        url: "https://api.test/api/organiser/weddings/wed_a/guests/g_cy/plus-one",
        body: { allowed: false },
      },
    ]);
    // The reload brought Max into the table as well.
    expect(screen.getByText(/Plus-one of Cy Jones/)).toBeTruthy();
  });

  it("asks the organiser to try again when a named plus-one is gone by the reload", async () => {
    await mount();
    answerPut = () => json({ error: "plus_one_named", named: 1 }, 409);
    fireEvent.click(switchFor("Cy Jones"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("The guest list changed. Try again."),
    );
    expect(screen.queryByText(/cannot be undone/)).toBeNull();
  });

  it("shows an error, not an empty list, when the reload after a refusal fails", async () => {
    await mount();
    answerPut = () => json({ error: "plus_one_named", named: 1 }, 409);
    authFetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "PUT"
          ? json({ error: "plus_one_named", named: 1 }, 409)
          : url.endsWith("/guests")
            ? json({}, 500)
            : json({}),
      ),
    );
    fireEvent.click(switchFor("Cy Jones"));
    await waitFor(() => expect(screen.getByText(/Could not reload the guest list/)).toBeTruthy());
    expect(screen.queryByText("No guests yet")).toBeNull();
  });

  it("allows everyone in a household at once", async () => {
    await mount();
    const group = householdGroup("Sharma");
    expect(within(group).getByText("Plus-ones: 1 of 2")).toBeTruthy();
    fireEvent.click(within(group).getByRole("button", { name: "Allow everyone" }));

    await waitFor(() => expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("true"));
    expect(puts()).toEqual([
      {
        url: "https://api.test/api/organiser/weddings/wed_a/families/fam_a/plus-one",
        body: { allowed: true },
      },
    ]);
    expect(within(householdGroup("Sharma")).getByText("Plus-ones: 2 of 2")).toBeTruthy();
    expect(
      within(householdGroup("Sharma"))
        .getByRole("button", { name: "Allow everyone" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(toastSuccess).toHaveBeenCalledWith("Everyone in Sharma may bring a plus-one");
  });

  it("turns a household off at once when it has named no one", async () => {
    await mount();
    const group = householdGroup("Jones");
    expect(
      within(group).getByRole("button", { name: "Allow everyone" }).getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Allow no one" }));

    await waitFor(() => expect(switchFor("Cy Jones").getAttribute("aria-checked")).toBe("false"));
    expect(puts()).toEqual([
      {
        url: "https://api.test/api/organiser/weddings/wed_a/families/fam_b/plus-one",
        body: { allowed: false },
      },
    ]);
    expect(screen.queryByText(/cannot be undone/)).toBeNull();
    expect(toastSuccess).toHaveBeenCalledWith("No one in Jones may bring a plus-one");
    expect(
      within(householdGroup("Jones"))
        .getByRole("button", { name: "Allow no one" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("marks the household list stale after a removal, since its guest count changed", async () => {
    await ensureHouseholdsLoaded("wed_a", () => Promise.resolve([]));
    expect(hasCachedHouseholds("wed_a")).toBe(true);
    await mount();
    fireEvent.click(switchFor("Ada Sharma"));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam Lee" }));
    await waitFor(() => expect(screen.queryByText(/Plus-one of Ada Sharma/)).toBeNull());
    expect(hasCachedHouseholds("wed_a")).toBe(false);
  });

  it("names every plus-one a household turn-off removes, even ones a search hides", async () => {
    await mount();
    fireEvent.input(screen.getByRole("searchbox", { name: "Search guests" }), {
      target: { value: "Bo" },
    });
    await waitFor(() => expect(screen.queryByText(/Plus-one of Ada Sharma/)).toBeNull());

    fireEvent.click(within(householdGroup("Sharma")).getByRole("button", { name: "Allow no one" }));
    expect(await screen.findByText("Turn off plus-ones for Sharma?")).toBeTruthy();
    expect(screen.getByText(/Ada Sharma’s plus-one/)).toBeTruthy();
    expect(puts()).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Turn off and remove Sam Lee" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual({
      url: "https://api.test/api/organiser/weddings/wed_a/families/fam_a/plus-one",
      body: { allowed: false, removePlusOnes: true },
    });
    await waitFor(() => expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("false"));
  });

  it("reloads and warns when the API removed a different number than was confirmed", async () => {
    await mount();
    fireEvent.click(within(householdGroup("Sharma")).getByRole("button", { name: "Allow no one" }));
    // The re-read still shows one plus-one, but by the time the write lands
    // the household has named a second.
    answerPut = (url, body) => {
      server = [...server, guest(SHARMA, "g_zed", "Zed", "Fox", { plusOneOf: "g_bo" })];
      return applyPut(url, body);
    };
    const confirm = await screen.findByRole("button", { name: "Turn off and remove Sam Lee" });
    const readsBefore = guestReads();
    fireEvent.click(confirm);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]![0])).toMatch(
      /Removed 2 plus-ones, not the 1 you confirmed/,
    );
    // Read once before the write and once more after the mismatch.
    expect(guestReads()).toBe(readsBefore + 2);
    expect(screen.queryByText(/Zed Fox/)).toBeNull();
  });

  it("shows an error, not an empty list, when the reload before a removal fails", async () => {
    await mount();
    fireEvent.click(switchFor("Ada Sharma"));
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith("/guests") ? json({}, 500) : json({})),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove Sam Lee" }));

    await waitFor(() => expect(screen.getByText(/Could not reload the guest list/)).toBeTruthy());
    expect(screen.queryByText("No guests yet")).toBeNull();
    expect(puts()).toEqual([]);
  });

  it("runs one write at a time, and marks the switch whose write is running", async () => {
    await mount();
    let finish: (res: Response) => void = () => {};
    answerPut = () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      });
    fireEvent.click(switchFor("Bo Sharma"));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(switchFor("Bo Sharma").getAttribute("aria-busy")).toBe("true");
    expect(switchFor("Bo Sharma").getAttribute("aria-readonly")).toBe("true");
    // Only the switch the write covers shows it; the rest of the roster is
    // left alone rather than re-rendered.
    expect(switchFor("Cy Jones").hasAttribute("aria-busy")).toBe(false);
    expect(switchFor("Cy Jones").hasAttribute("aria-readonly")).toBe(false);

    // A second write asked for meanwhile does nothing, and its switch stays put.
    fireEvent.click(switchFor("Cy Jones"));
    fireEvent.click(within(householdGroup("Jones")).getByRole("button", { name: "Allow no one" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(puts()).toHaveLength(1);
    expect(switchFor("Cy Jones").getAttribute("aria-checked")).toBe("true");

    finish(json({ guestId: "g_bo", plusOneAllowed: true, plusOneRemoved: false }));
    await waitFor(() => expect(switchFor("Bo Sharma").hasAttribute("aria-busy")).toBe(false));

    // And once it lands the next one goes through.
    answerPut = applyPut;
    fireEvent.click(switchFor("Cy Jones"));
    await waitFor(() => expect(puts()).toHaveLength(2));
  });

  it("frees the table again when a write fails on the network", async () => {
    await mount();
    answerPut = () => Promise.reject(new TypeError("Failed to fetch"));
    fireEvent.click(switchFor("Bo Sharma"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not change the plus-one setting. Try again."),
    );
    expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("false");
    expect(switchFor("Bo Sharma").hasAttribute("aria-busy")).toBe(false);

    answerPut = applyPut;
    fireEvent.click(switchFor("Bo Sharma"));
    await waitFor(() => expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("true"));
  });

  it("sends a signed-out organiser to sign in", async () => {
    await mount();
    answerPut = () => new Response("", { status: 401 });
    fireEvent.click(switchFor("Bo Sharma"));
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("false");
  });

  it("reloads the list when the guest has gone, and says so", async () => {
    await mount();
    answerPut = () => {
      server = server.filter((g) => g.familyId !== "fam_b");
      return json({ error: "guest_not_found" }, 404);
    };
    fireEvent.click(switchFor("Cy Jones"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("That guest is no longer on the list."),
    );
    await waitFor(() => expect(screen.queryByText("Jones")).toBeNull());
  });

  it("reports any other refusal without changing the switch", async () => {
    await mount();
    answerPut = () => json({ error: "Internal error" }, 500);
    fireEvent.click(switchFor("Bo Sharma"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Could not change the plus-one setting. Try again."),
    );
    expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("false");
  });

  it("tells a demoted organiser the write was refused and leaves the switch as it was", async () => {
    await mount();
    answerPut = () => json({ error: "read_only_role" }, 403);
    fireEvent.click(switchFor("Bo Sharma"));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Only the owner and editors can change plus-ones."),
    );
    expect(switchFor("Bo Sharma").getAttribute("aria-checked")).toBe("false");
  });

  it("gives a viewer read-only switches, no household controls, and sends nothing", async () => {
    await mount(false);
    const adaSwitch = switchFor("Ada Sharma");
    expect(adaSwitch.getAttribute("aria-readonly")).toBe("true");
    expect(adaSwitch.disabled).toBe(false);
    expect(screen.queryByRole("group", { name: /Plus-ones for the/ })).toBeNull();

    fireEvent.click(adaSwitch);
    // The confirmation opens a tick after the gesture; wait past it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(puts()).toEqual([]);
    expect(screen.queryByText("Remove Sam Lee?")).toBeNull();
    expect(adaSwitch.getAttribute("aria-checked")).toBe("true");
  });

  it("reads a missing `canEdit` as read-only", async () => {
    render(() => (
      <GuestTable weddingId="wed_a" canManage weddingName="Nadia & Sam" weddingSlug="nadia-sam" />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());
    expect(switchFor("Bo Sharma").getAttribute("aria-readonly")).toBe("true");
    expect(screen.queryByRole("group", { name: /Plus-ones for the/ })).toBeNull();
  });

  it("shows no plus-one column when the API does not send the permission", async () => {
    server = server
      .filter((g) => !g.plusOneOf)
      .map(({ plusOneAllowed: _a, plusOneOf: _o, ...rest }) => rest as OrganiserGuestRow);
    await mount();
    expect(screen.queryByRole("columnheader", { name: "Plus-one" })).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: /Plus-ones for the/ })).toBeNull();
  });
});
