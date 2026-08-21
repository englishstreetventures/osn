// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * GuestsEditor is the interactive guest editor (E5): a household-grouped editable
 * list with a per-guest × per-event attendance matrix and a Save flow that posts
 * the whole draft as DesiredState to changes/preview, renders the shared preview,
 * then applies. Auth/api/toast are stubbed; the stores are reset per test.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

vi.mock("../lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import { __resetEventsCache } from "../lib/events-store";
import type { DesiredStateWire } from "../lib/guest-event-draft";
import { __resetGuestsCache } from "../lib/guests-store";
import { __resetHouseholdsCache } from "../lib/households-store";
import { confirmNavigation } from "../lib/unsaved-guard";
import { authFetchMock, resetOrganiserMocks, toastSuccess } from "../test-support/mocks";
import GuestsEditor from "./GuestsEditor";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EVENTS = [
  {
    id: "evt_1",
    name: "Ceremony",
    slug: "ceremony",
    sortOrder: 0,
    startAt: "2026-11-14T15:00+11:00",
    endAt: "",
    timezone: "Australia/Sydney",
    address: "St Mary's",
    description: "",
    dressCodeDescription: null,
    dressCodePalette: null,
    pinterestUrl: null,
    mapsUrl: null,
    imageUrl: null,
    imageCrop: null,
  },
];

const GUESTS = [
  {
    guestId: "g_1",
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    firstName: "Ada",
    lastName: "Sharma",
    nickname: null,
    events: ["evt_1"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];

const HOUSEHOLDS = [
  {
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    guestCount: 1,
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];

/** A second guest in the same household, so a delete has something to leave
 *  behind (and so the row that survives can be told apart from the one that
 *  doesn't). */
const BEN = {
  guestId: "g_2",
  familyId: "fam_a",
  publicId: "SHARMA-KITE-77Q2",
  familyName: "Sharma",
  firstName: "Ben",
  lastName: "Sharma",
  nickname: null,
  events: ["evt_1"],
  codeSharedAt: null,
  firstOpenedAt: null,
  deactivatedAt: null,
};

/** Prime the onMount events + guests + households loads (order-independent —
 *  the component requests all three; each URL is matched below). */
function primeLoad() {
  authFetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith("/events")) return Promise.resolve(json(EVENTS));
    if (String(url).endsWith("/guests")) return Promise.resolve(json(GUESTS));
    if (String(url).endsWith("/households")) return Promise.resolve(json(HOUSEHOLDS));
    return Promise.resolve(json({}));
  });
}

describe("GuestsEditor", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    __resetGuestsCache();
    __resetHouseholdsCache();
    __resetEventsCache();
  });

  it("renders households with an attendance matrix column per event", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Household name") as HTMLInputElement).value).toBe("Sharma"),
    );
    // Guest name field + the event column header.
    expect(screen.getByDisplayValue("Ada")).toBeTruthy();
    expect(screen.getByText("Ceremony")).toBeTruthy();
    // The attendance checkbox for Ada × Ceremony is present + checked.
    const box = screen.getByRole("checkbox", { name: /Ada attends Ceremony/i });
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it("shows the sticky save bar only once an edit makes the draft dirty", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Save changes/i })).toBeNull();

    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "Adaeze" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());
  });

  it("blocks save with an inline error when a required name is blanked", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());

    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByText(/First name is required/i)).toBeTruthy());
    const save = screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("runs the save flow: preview → shared modal → apply → toast", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());

    // Make an edit.
    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "Adaeze" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    // The preview POST returns a plan with a warning; then the apply POST; then
    // the reload (events + guests) — matched by URL in the impl below.
    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: ["1 guest will keep their RSVPs (rename)."],
            plan: {
              eventCreates: [],
              eventUpdates: [{}],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [{}],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: ["1 guest will keep their RSVPs (rename)."],
            },
          }),
        );
      }
      if (u.endsWith("/changes/apply")) {
        return Promise.resolve(json({ summary: { importId: "chg_1" } }));
      }
      if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
      if (u.endsWith("/households")) return Promise.resolve(json(HOUSEHOLDS));
      if (u.endsWith("/guests"))
        return Promise.resolve(json([{ ...GUESTS[0], firstName: "Adaeze" }]));
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    // The shared preview modal appears with the diff + warning.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText(/keep their RSVPs/i)).toBeTruthy();

    // Confirm apply (the modal's confirm button is labelled distinctly).
    fireEvent.click(screen.getByRole("button", { name: /Confirm & save/i }));

    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(
          (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/changes/apply",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0]![0]).toMatch(/saved/i);

    // The apply call carried the previewed changeId.
    const applyCall = authFetchMock.mock.calls.find(
      (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/changes/apply",
    )!;
    expect(JSON.parse(String((applyCall[1] as RequestInit).body)).changeId).toBe("chg_1");
  });

  it("adds a household and a guest", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Add household/i }));
    // A new blank household field appears (the "New — code minted on save" badge).
    await waitFor(() => expect(screen.getByText(/code minted on save/i)).toBeTruthy());
  });

  /**
   * Deletion is the whole point of these: the editor expresses it by dropping
   * the row from the DesiredState it posts, so anything that keeps the row in
   * the payload — or never marks the draft dirty — is a delete that silently
   * doesn't happen, which is exactly what an organiser sees as "the guest I
   * deleted came back after a reload".
   */
  describe("deleting", () => {
    /** Load with two guests in the one household. */
    function primeTwoGuests() {
      authFetchMock.mockImplementation((url: string) => {
        const u = String(url);
        if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
        if (u.endsWith("/guests")) return Promise.resolve(json([...GUESTS, BEN]));
        if (u.endsWith("/households"))
          return Promise.resolve(json([{ ...HOUSEHOLDS[0], guestCount: 2 }]));
        return Promise.resolve(json({}));
      });
    }

    /**
     * The envelope the editor POSTs to `changes/preview`. The wire shape is
     * already named in `guest-event-draft` — the assertions below read the
     * real thing, so they should be checked against it rather than against an
     * `unknown` each test re-describes for itself.
     */
    interface PreviewPost {
      desiredState: DesiredStateWire;
    }

    /** Swap in a preview stub that records the posted DesiredState. */
    function capturePreview(): { body: () => PreviewPost | null } {
      let captured: PreviewPost | null = null;
      authFetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (String(url).endsWith("/changes/preview")) {
          captured = JSON.parse(String(init?.body));
          return Promise.resolve(
            json({
              changeId: "chg_1",
              baseRevision: "genesis",
              warnings: [],
              plan: {
                eventCreates: [],
                eventUpdates: [],
                eventRemoves: [],
                familyCreates: [],
                familyRemoves: [],
                guestCreates: [],
                guestUpdates: [],
                guestRemoves: [{ id: "g_2", firstName: "Ben" }],
                eventLinkCreates: [],
                eventLinkRemoves: [],
                warnings: [],
              },
            }),
          );
        }
        return Promise.resolve(json({}));
      });
      return { body: () => captured };
    }

    it("removing a guest drops the row and the wire entry", async () => {
      primeTwoGuests();
      render(() => <GuestsEditor weddingId="wed_a" />);
      await waitFor(() => expect(screen.getByDisplayValue("Ben")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: /Remove Ben/i }));
      await waitFor(() => expect(screen.queryByDisplayValue("Ben")).toBeNull());
      expect(screen.getByDisplayValue("Ada")).toBeTruthy();

      const preview = capturePreview();
      fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
      await waitFor(() => expect(preview.body()).not.toBeNull());

      const posted = preview.body()!;
      expect(posted.desiredState.families[0]!.guests.map((g) => g.id)).toEqual(["g_1"]);
    });

    it("removing a household drops it from the wire", async () => {
      primeTwoGuests();
      render(() => <GuestsEditor weddingId="wed_a" />);
      await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: /Delete household/i }));
      await waitFor(() => expect(screen.getByText(/No households yet/i)).toBeTruthy());

      const preview = capturePreview();
      fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
      await waitFor(() => expect(preview.body()).not.toBeNull());

      const posted = preview.body()!;
      expect(posted.desiredState.families).toHaveLength(0);
    });
  });

  it("shows a household that holds no guests instead of dropping it", async () => {
    // The guest rows can't describe this household — only the households read
    // can. If the editor didn't carry it, the next save would delete it and its
    // claim code without ever having shown it.
    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
      if (u.endsWith("/guests")) return Promise.resolve(json(GUESTS));
      if (u.endsWith("/households"))
        return Promise.resolve(
          json([
            ...HOUSEHOLDS,
            {
              familyId: "fam_empty",
              publicId: "EMPTY-CODE-0001",
              familyName: "Code Only",
              guestCount: 0,
              codeSharedAt: null,
              firstOpenedAt: null,
              deactivatedAt: null,
            },
          ]),
        );
      return Promise.resolve(json({}));
    });

    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Code Only")).toBeTruthy());
    expect(screen.getByText(/No guests in this household yet/i)).toBeTruthy();
    // Showing it is not an edit — the save bar stays away.
    expect(screen.queryByRole("button", { name: /Save changes/i })).toBeNull();
  });

  it("registers beforeunload only while the draft is dirty", async () => {
    primeLoad();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());

    const beforeUnloadAdds = () => add.mock.calls.filter((c) => c[0] === "beforeunload").length;
    // Clean draft ⇒ no listener. Registering unconditionally is the obvious
    // "simplification" and it makes the page bfcache-ineligible in Firefox/Safari.
    expect(beforeUnloadAdds()).toBe(0);

    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "Adaeze" } });
    await waitFor(() => expect(beforeUnloadAdds()).toBe(1));

    // …and it comes off again once the draft is clean (undo back to baseline).
    fireEvent.click(screen.getByRole("button", { name: /^Undo$/i }));
    await waitFor(() => expect(remove.mock.calls.some((c) => c[0] === "beforeunload")).toBe(true));
    add.mockRestore();
    remove.mockRestore();
  });

  it("keeps the preview modal open on a failed apply and says why", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());
    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "Adaeze" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [{}],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
        );
      }
      if (u.endsWith("/changes/apply"))
        return Promise.resolve(json({ error: "Apply failed" }, 500));
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Confirm & save/i }));

    // A retryable failure leaves the modal up — and the error has to render
    // INSIDE it, because the sticky bar it would otherwise appear in sits behind
    // this modal's overlay ("nothing happened at all", from the organiser's side).
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toMatch(/Apply failed/i));
  });

  it("guards in-app navigation while the draft is dirty", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());
    // Clean draft ⇒ navigation is free.
    expect(confirmNavigation()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Remove Ada/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    // Dirty ⇒ the guard asks. Without it, a stray sidebar click threw the
    // deletion away with no prompt at all.
    // happy-dom ships no window.confirm — stub it, as unsaved-guard's own tests do.
    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);
    expect(confirmNavigation()).toBe(false);
    expect(confirmSpy).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("surfaces a 409 as a re-preview prompt", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());
    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "Adaeze" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [{}],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
        );
      }
      if (u.endsWith("/changes/apply"))
        return Promise.resolve(json({ error: "State changed — re-preview" }, 409));
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Confirm & save/i }));

    await waitFor(() => expect(screen.getByText(/changed elsewhere/i)).toBeTruthy());
    // A 409 means the previewed diff is stale, so the modal is dismissed —
    // re-confirming it could only 409 again.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
