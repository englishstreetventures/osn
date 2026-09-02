import { toast } from "@shared/toast";
import { render, cleanup, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { SAVED_DWELL_MIN_MS, SAVED_DWELL_MS } from "../../src/components/rsvp-saved";
import { RsvpModal } from "../../src/components/RsvpModal";
import type { EventSummary, FamilyMember, RsvpSummary } from "../../src/components/types";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

vi.mock("@shared/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "Henna evening",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1", "event-2"],
};

const raj: FamilyMember = {
  guestId: "guest-raj",
  firstName: "Raj",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
};

const naina: FamilyMember = {
  guestId: "guest-naina",
  firstName: "Naina",
  lastName: "Sharma",
  nickname: null,
  // Not invited to event-1
  eventIds: ["event-2"],
};

/** Locate the fieldset containing the named member. */
function fieldsetFor(name: string): HTMLElement {
  const legends = document.querySelectorAll("legend");
  for (const l of legends) {
    if ((l.textContent ?? "").includes(name)) {
      return l.closest("fieldset") as HTMLElement;
    }
  }
  throw new Error(`fieldset for ${name} not found`);
}

describe("RsvpModal", () => {
  afterEach(() => {
    cleanup();
    // `restoreAllMocks` does not cover the timer mock, and a leaked fake clock
    // would silently freeze every later test that waits on one.
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // The toast mock is a module-level singleton (the factory runs
    // once for the whole file), so its call history survives across tests
    // unless cleared here.
    vi.mocked(toast.success).mockClear();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("renders one fieldset per invited member, filtering out members not invited to this event", () => {
    const { getByText, queryByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj, naina]}
        apiUrl="https://api.test"
        onClose={() => {}}
      />
    ));

    expect(getByText("Priya Sharma")).toBeTruthy();
    expect(getByText("Raj Sharma")).toBeTruthy();
    expect(queryByText("Naina Sharma")).toBeNull();
  });

  it("toggling Attending reveals dietary input; toggling Not attending hides it", () => {
    render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    const fs = fieldsetFor("Priya");
    expect(within(fs).queryByPlaceholderText(/Vegetarian/)).toBeNull();

    fireEvent.click(within(fs).getByText("Attending"));
    expect(within(fs).queryByPlaceholderText(/Vegetarian/)).toBeTruthy();

    fireEvent.click(within(fs).getByText("Not attending"));
    expect(within(fs).queryByPlaceholderText(/Vegetarian/)).toBeNull();
  });

  it("renders the dietary input at the 16px base size on mobile to avoid iOS zoom-on-focus", () => {
    render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    const fs = fieldsetFor("Priya");
    fireEvent.click(within(fs).getByText("Attending"));
    const input = within(fs).getByPlaceholderText(/Vegetarian/) as HTMLInputElement;
    // Mobile-first base must be >=16px (Tailwind `text-base`); a smaller value
    // makes iOS Safari zoom the page when the field is focused.
    expect(input.className).toContain("text-base");
    // The smaller visual size only applies from the `sm:` breakpoint up.
    expect(input.className).toContain("sm:text-[0.9rem]");
  });

  it("blocks submit and shows an error when nobody in the party has answered", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const onSubmitted = vi.fn();
    const onClose = vi.fn();

    const { getByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        apiUrl="https://api.test"
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    ));

    // Nobody answered — there is nothing worth sending.
    fireEvent.click(getByText("Save"));

    await waitFor(() => {
      expect(getByText("Please respond for at least one person in your party.")).toBeTruthy();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("allows submit with only some members answered, sending just the answered ones", async () => {
    const updatedRsvps: RsvpSummary[] = [
      { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
    ];
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rsvps: updatedRsvps }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const onSubmitted = vi.fn();
    const onConfirmed = vi.fn();
    vi.useFakeTimers();

    const { getByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        apiUrl="https://api.test"
        onClose={() => {}}
        onSubmitted={onSubmitted}
        onConfirmed={onConfirmed}
      />
    ));

    // Only Priya answered — Raj is left null. The household no longer has to
    // finish the whole party in one sitting.
    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(getByText("Save"));

    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(fetchSpy).toHaveBeenCalled();

    const parsed = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(parsed.rsvps).toHaveLength(1);
    expect(parsed.rsvps[0]).toMatchObject({ guestId: "guest-priya", eventId: "event-1" });
    expect(onSubmitted).toHaveBeenCalledWith(updatedRsvps);

    // A partial reply gets the toast, same as a complete one, but not the
    // Respond-button celebration — only every invited member answering earns
    // that.
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      `Your RSVP for ${event.name} has been recorded.`,
    );
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("submit POSTs the expected JSON shape with credentials include and content-type", async () => {
    const updatedRsvps: RsvpSummary[] = [
      { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "Vegetarian" },
      { guestId: "guest-raj", eventId: "event-1", status: "declined", dietary: "" },
    ];
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rsvps: updatedRsvps }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    // Fake clock from the outset (P-I2): the dwell is a real `setTimeout`, so it
    // has to be mocked BEFORE the submit registers it. Waiting it out for real
    // cost a real dwell of pure sleep in every suite run.
    vi.useFakeTimers();

    const { getByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        apiUrl="https://api.test"
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    ));

    // Priya: attending + dietary (+ consent box ticked, required for dietary)
    const priyaFs = fieldsetFor("Priya");
    fireEvent.click(within(priyaFs).getByText("Attending"));
    const dietary = within(priyaFs).getByPlaceholderText(/Vegetarian/) as HTMLInputElement;
    fireEvent.input(dietary, { target: { value: "Vegetarian" } });
    fireEvent.click(within(priyaFs).getByRole("checkbox"));

    // Raj: declined
    fireEvent.click(within(fieldsetFor("Raj")).getByText("Not attending"));

    fireEvent.click(getByText("Save"));

    // Flushes the fetch promise chain without letting the dwell elapse.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalled();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.test/api/rsvp");
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const parsed = JSON.parse(init.body);
    expect(parsed).not.toHaveProperty("familyPublicId");
    expect(parsed).toEqual({
      rsvps: [
        {
          guestId: "guest-priya",
          eventId: "event-1",
          status: "attending",
          dietary: "Vegetarian",
          dietaryConsent: true,
        },
        {
          guestId: "guest-raj",
          eventId: "event-1",
          status: "declined",
          dietary: "",
          dietaryConsent: false,
        },
      ],
    });

    // The fresh rows reach the page as soon as the server confirms them, so the
    // events section behind the sheet is already correct while the confirmation
    // is still on screen. The close comes later, on its own timer.
    expect(onSubmitted).toHaveBeenCalledWith(updatedRsvps);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not fire onConfirmed when EDITING a reply that was already complete — toast only", async () => {
    // The sweep marks the moment a whole response is captured, so it belongs to
    // the save that crosses that line. Here the party was already complete when
    // the sheet opened (both members have rows), so flipping one answer and
    // re-saving captures nothing new about completeness: toast, no celebration.
    vi.useFakeTimers();
    const alreadyComplete: RsvpSummary[] = [
      { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      { guestId: "guest-raj", eventId: "event-1", status: "attending", dietary: "" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ rsvps: alreadyComplete }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const onConfirmed = vi.fn();
    const onClose = vi.fn();
    render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        existingRsvps={alreadyComplete}
        apiUrl="https://api.test"
        onClose={onClose}
        onConfirmed={onConfirmed}
      />
    ));

    // Change Raj's answer — a real edit, still a complete party afterwards.
    fireEvent.click(within(fieldsetFor("Raj")).getByText("Not attending"));
    fireEvent.click(document.querySelector("button[type='submit']")!);
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
    expect(onClose).toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("fires onConfirmed on the save that COMPLETES a partly-answered party", async () => {
    // The mirror of the case above: Priya already had a row, Raj did not, so
    // this save is the crossing and earns the sweep.
    vi.useFakeTimers();
    const both: RsvpSummary[] = [
      { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      { guestId: "guest-raj", eventId: "event-1", status: "attending", dietary: "" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ rsvps: both }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const onConfirmed = vi.fn();
    render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        existingRsvps={[both[0]!]}
        apiUrl="https://api.test"
        onClose={() => {}}
        onConfirmed={onConfirmed}
      />
    ));

    fireEvent.click(within(fieldsetFor("Raj")).getByText("Attending"));
    fireEvent.click(document.querySelector("button[type='submit']")!);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it("still celebrates a host-preview save — preview carries no recorded rows to be 'already complete' from", async () => {
    // A preview claim's family is the synthetic `kind: "host"` one, which is
    // barred from RSVP and therefore has no rows, so `wasComplete` is false and
    // the new crossing gate never suppresses preview's confirmation. Asserted
    // because preview exists to show a host exactly what a guest sees, and it
    // would be easy to gate it away by accident.
    vi.useFakeTimers();
    const onConfirmed = vi.fn();
    render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        preview
        apiUrl="https://api.test"
        onClose={() => {}}
        onConfirmed={onConfirmed}
      />
    ));

    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(document.querySelector("button[type='submit']")!);
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  async function submitOnce(): Promise<void> {
    const fs = fieldsetFor("Priya");
    fireEvent.click(within(fs).getByText("Attending"));
    fireEvent.click(document.querySelector("button[type='submit']")!);
  }

  it("shows session-expired message on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
    const { findByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    await submitOnce();
    expect(await findByText("Your session expired. Please re-enter your code.")).toBeTruthy();
  });

  it("shows authorisation message on 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403 })));
    const { findByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    await submitOnce();
    expect(await findByText("You're not authorised to RSVP for one of those guests.")).toBeTruthy();
  });

  it("distinguishes a deadline 403 from an authorisation 403", async () => {
    // The deadline can pass with this sheet already open, so the server's
    // `rsvp_closed` code is the only way to tell "too late" from "not yours".
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "rsvp_closed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const { findByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    await submitOnce();
    expect(
      await findByText("RSVPs have closed for this wedding. Please contact the couple directly."),
    ).toBeTruthy();
  });

  it("shows generic message on 400", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 400 })));
    const { findByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    await submitOnce();
    expect(await findByText("Something went wrong. Please try again.")).toBeTruthy();
  });

  it("shows rate-limit message on 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 429 })));
    const { findByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    await submitOnce();
    expect(await findByText("Too many requests. Please try again in a moment.")).toBeTruthy();
  });

  it("shows connection message on network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    const { findByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    await submitOnce();
    expect(await findByText("Could not connect. Please check your connection.")).toBeTruthy();
  });

  it("swallows AbortError silently when the modal unmounts mid-submit", async () => {
    // Simulate a fetch that rejects with AbortError after the modal unmounts.
    let rejectFetch: ((err: Error) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
      ),
    );

    const { unmount } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    const priyaFs = fieldsetFor("Priya");
    fireEvent.click(within(priyaFs).getByText("Attending"));
    fireEvent.submit(document.querySelector("form")!);

    unmount();

    const abort = new Error("aborted");
    abort.name = "AbortError";
    rejectFetch!(abort);

    // No error message should land — abort is silent.
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("prefills attending status and dietary from existingRsvps", () => {
    const existing: RsvpSummary[] = [
      { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "Vegan" },
      { guestId: "guest-raj", eventId: "event-1", status: "declined", dietary: "" },
    ];

    render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        existingRsvps={existing}
        apiUrl="https://api.test"
        onClose={() => {}}
      />
    ));

    const priyaFs = fieldsetFor("Priya");
    expect((within(priyaFs).getByPlaceholderText(/Vegetarian/) as HTMLInputElement).value).toBe(
      "Vegan",
    );
    expect(within(priyaFs).getByText("Attending").getAttribute("aria-pressed")).toBe("true");

    const rajFs = fieldsetFor("Raj");
    expect(within(rajFs).getByText("Not attending").getAttribute("aria-pressed")).toBe("true");
    // Raj declined: no dietary input visible
    expect(within(rajFs).queryByPlaceholderText(/Vegetarian/)).toBeNull();
  });

  it("treats existing 'maybe' status as null (binary UX)", () => {
    const existing: RsvpSummary[] = [
      { guestId: "guest-priya", eventId: "event-1", status: "maybe", dietary: "" },
    ];

    render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        existingRsvps={existing}
        apiUrl="https://api.test"
        onClose={() => {}}
      />
    ));

    const fs = fieldsetFor("Priya");
    expect(within(fs).queryByPlaceholderText(/Vegetarian/)).toBeNull();
    expect(within(fs).getByText("Attending").getAttribute("aria-pressed")).toBe("false");
    expect(within(fs).getByText("Not attending").getAttribute("aria-pressed")).toBe("false");
  });

  it("hides the consent checkbox until dietary text is entered (C-H2)", () => {
    render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    const fs = fieldsetFor("Priya");
    // Attending, no dietary text yet → no checkbox.
    fireEvent.click(within(fs).getByText("Attending"));
    expect(within(fs).queryByRole("checkbox")).toBeNull();

    // Enter dietary text → consent checkbox appears, unticked, linking /privacy.
    fireEvent.input(within(fs).getByPlaceholderText(/Vegetarian/), {
      target: { value: "Vegan" },
    });
    const checkbox = within(fs).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    const privacyLink = within(fs)
      .getByText(/privacy notice/i)
      .closest("a") as HTMLAnchorElement;
    expect(privacyLink.getAttribute("href")).toBe("/privacy");
  });

  it("blocks submit and shows an error when dietary is entered without consent (C-H2)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { getByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    const fs = fieldsetFor("Priya");
    fireEvent.click(within(fs).getByText("Attending"));
    fireEvent.input(within(fs).getByPlaceholderText(/Vegetarian/), {
      target: { value: "Vegan" },
    });
    // Leave the consent box unticked.
    fireEvent.click(getByText("Save"));

    await waitFor(() => {
      expect(
        getByText("Please tick the box to let us store your dietary requirements."),
      ).toBeTruthy();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows submit with empty dietary and no consent needed (C-H2)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rsvps: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { getByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    // Attending, no dietary text → no consent gate.
    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(getByText("Save"));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const parsed = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(parsed.rsvps[0]).toEqual({
      guestId: "guest-priya",
      eventId: "event-1",
      status: "attending",
      dietary: "",
      dietaryConsent: false,
    });
  });

  it("prefills the consent box as ticked when an existing RSVP carries dietary (C-H2)", () => {
    const existing: RsvpSummary[] = [
      { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "Vegan" },
    ];
    render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        existingRsvps={existing}
        apiUrl="https://api.test"
        onClose={() => {}}
      />
    ));

    const checkbox = within(fieldsetFor("Priya")).getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("does not log dietary input to console (frontend redaction sanity)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ rsvps: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { getByText } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    const fs = fieldsetFor("Priya");
    fireEvent.click(within(fs).getByText("Attending"));
    fireEvent.input(within(fs).getByPlaceholderText(/Vegetarian/), {
      target: { value: "peanut allergy" },
    });
    fireEvent.click(within(fs).getByRole("checkbox"));
    fireEvent.click(getByText("Save"));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const allCalls = [
      ...logSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...debugSpy.mock.calls,
    ].flat();

    for (const arg of allCalls) {
      const s = typeof arg === "string" ? arg : JSON.stringify(arg);
      expect(s).not.toContain("peanut");
    }
  });

  it("shows the preview banner in preview mode", () => {
    const { getByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        apiUrl="https://api.test"
        preview={true}
        onClose={() => {}}
      />
    ));
    expect(getByText(/Nothing you send here is saved/i)).toBeTruthy();
  });

  it("treats a valid submit as a no-op in preview mode: closes, never POSTs", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const onClose = vi.fn();
    const onSubmitted = vi.fn();

    const { getByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        apiUrl="https://api.test"
        preview={true}
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    ));

    vi.useFakeTimers();
    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(getByText("Save"));

    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
    expect(onClose).toHaveBeenCalled();
    // The deliberate no-op: nothing left the browser and nothing was "saved".
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("plays the guest's confirmation in preview without claiming anything was stored", async () => {
    // The point of preview is that a host feels exactly what a guest feels. If
    // the confirmation were skipped here, the one piece of feedback a host most
    // needs to sign off on would be the one thing preview never showed them.
    const onSubmitted = vi.fn();
    vi.stubGlobal("fetch", vi.fn());

    const { getByRole, findByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        apiUrl="https://api.test"
        preview={true}
        onClose={() => {}}
        onSubmitted={onSubmitted}
      />
    ));

    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(getByRole("button", { name: "Save" }));

    expect(await findByText("Saved")).toBeTruthy();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it("allows a partial submit in preview mode too, without the celebration cue", async () => {
    // Preview follows the same partial-save rule as the real path — it must,
    // since the whole point of preview is showing a host exactly what a guest
    // would experience.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const onClose = vi.fn();
    const onConfirmed = vi.fn();
    vi.useFakeTimers();

    const { getByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        apiUrl="https://api.test"
        preview={true}
        onClose={onClose}
        onConfirmed={onConfirmed}
      />
    ));

    // Only Priya answered.
    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(getByText("Save"));

    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
    expect(onClose).toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("still blocks an empty submit in preview mode", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const onClose = vi.fn();

    const { getByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya, raj]}
        apiUrl="https://api.test"
        preview={true}
        onClose={onClose}
      />
    ));

    // Nobody answered — blocked even in preview.
    fireEvent.click(getByText("Save"));

    await waitFor(() =>
      expect(getByText("Please respond for at least one person in your party.")).toBeTruthy(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("becomes a read-only view once RSVPs are closed", () => {
    const { getByText, queryByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        existingRsvps={[
          { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "Vegan" },
        ]}
        apiUrl="https://api.test"
        closed
        closedOn="Tuesday 1 September 2026"
        onClose={() => {}}
      />
    ));

    // Says WHEN it shut, not just that it did.
    expect(getByText(/RSVPs closed on Tuesday 1 September 2026/)).toBeTruthy();

    // No submit at all — a disabled Save invites clicking at a door that won't
    // open — and the one remaining button says "Close", not "Cancel".
    expect(queryByText("Save")).toBeNull();
    expect(document.querySelector("button[type='submit']")).toBeNull();
    // The action bar's own button (the sheet's dismiss "×" also labels itself
    // Close, so match on the visible text node, not the accessible name).
    expect(getByText("Close")).toBeTruthy();
    expect(queryByText("Cancel")).toBeNull();

    // The reply already on file is still visible, and frozen.
    const fs = fieldsetFor("Priya");
    const attending = within(fs).getByText("Attending") as HTMLButtonElement;
    expect(attending.getAttribute("aria-pressed")).toBe("true");
    expect(attending.disabled).toBe(true);
    expect((within(fs).getByText("Not attending") as HTMLButtonElement).disabled).toBe(true);
    expect((within(fs).getByPlaceholderText(/Vegetarian/) as HTMLInputElement).disabled).toBe(true);
  });

  it("never POSTs from a closed sheet, even on a form-level submit", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const onClose = vi.fn();

    render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        existingRsvps={[
          { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
        ]}
        apiUrl="https://api.test"
        closed
        onClose={onClose}
      />
    ));

    // There is no submit button, but a stray Enter in the form would still fire
    // the handler — the guard has to live there, not only in the markup.
    fireEvent.submit(document.querySelector("form")!);

    await waitFor(() => expect(fetchSpy).not.toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rescues focus into the sheet when the deadline passes with Save focused (C-L2)", async () => {
    // The deadline can flip on a live timer while this sheet is open, and that
    // unmounts the submit button. If focus was ON it, focus would revert to
    // <body> — outside an `aria-modal` dialog, with no keyboard way back in.
    const [closed, setClosed] = createSignal(false);
    render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        existingRsvps={[
          { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
        ]}
        apiUrl="https://api.test"
        closed={closed()}
        onClose={() => {}}
      />
    ));

    const save = document.querySelector("button[type='submit']") as HTMLButtonElement;
    save.focus();
    expect(document.activeElement).toBe(save);

    setClosed(true);

    await waitFor(() => expect(document.querySelector("button[type='submit']")).toBeNull());
    // Focus landed on the sheet's dismiss button, not on <body>.
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).textContent).toContain("Close");
  });

  it("leaves focus alone when it was never inside the sheet", async () => {
    // The rescue must not YANK focus from wherever the guest actually is —
    // only recover it when the element being destroyed held it.
    const [closed, setClosed] = createSignal(false);
    const outside = document.createElement("button");
    outside.textContent = "elsewhere";
    document.body.append(outside);

    render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        apiUrl="https://api.test"
        closed={closed()}
        onClose={() => {}}
      />
    ));

    outside.focus();
    setClosed(true);

    await waitFor(() => expect(document.querySelector("button[type='submit']")).toBeNull());
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("still shows the closed banner when the deadline day is unknown", () => {
    const { getByText } = render(() => (
      <RsvpModal
        event={event}
        members={[priya]}
        apiUrl="https://api.test"
        closed
        onClose={() => {}}
      />
    ));
    expect(getByText(/RSVPs have closed/)).toBeTruthy();
  });

  describe("confirmed state", () => {
    /**
     * A successful RSVP used to be indistinguishable from a mis-tap: the sheet
     * simply vanished. These pin the confirmation that replaced that — the gold
     * sweep, the tick, and the held beat before the sheet closes itself.
     *
     * happy-dom and jsdom compute no CSS, so none of this can assert what the
     * guest actually SEES. What is checkable is the contract the visuals hang
     * off: which classes are present, which state flags flip, and what the
     * component does with focus and callbacks. The durations themselves are
     * guarded in `rsvp-saved.test.ts`.
     */

    /** Stub a 200 and answer for Priya, leaving the sheet mid-confirmation. */
    async function confirmOnce(props: Partial<{ onClose: () => void; withDietary: boolean }> = {}) {
      const rsvps: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      ];
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ rsvps }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const view = render(() => (
        <RsvpModal
          event={event}
          members={[priya]}
          apiUrl="https://api.test"
          onClose={props.onClose ?? (() => {})}
        />
      ));

      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      if (props.withDietary) {
        const fs = fieldsetFor("Priya");
        fireEvent.input(within(fs).getByPlaceholderText(/Vegetarian/), {
          target: { value: "Vegetarian" },
        });
        fireEvent.click(within(fs).getByRole("checkbox"));
      }
      const save = view.getByRole("button", { name: "Save" });
      save.focus();
      fireEvent.click(save);

      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      await view.findByText("Saved");
      return { ...view, fetchSpy };
    }

    it("swaps the Save button's label for the recorded-reply wording", async () => {
      const { getByRole } = await confirmOnce();
      expect(getByRole("button", { name: "Saved" })).toBeTruthy();
    });

    it("carries no fill sweep or tick — that confirmation now plays on the Respond button", async () => {
      // PR #380 put a gold fill sweep and a drawn tick on THIS button, which is
      // gone by the time a guest could register either — the sheet closes over
      // it. The choreography moved to `EventCard`'s Respond button, which is
      // still on screen once this sheet closes; see `rsvp-responded.ts`.
      await confirmOnce();
      const submit = document.querySelector("button[type='submit']") as HTMLElement;
      expect(submit.querySelector("span[aria-hidden='true']")).toBeNull();
      expect(submit.querySelector("svg")).toBeNull();
    });

    it("holds onConfirmed until the sheet actually closes, so the celebration is not spent behind it", async () => {
      // The regression this guards. `onConfirmed` cues the `TOTAL_DURATION_MS`
      // celebration on the Respond button BEHIND this sheet, and the sheet sits
      // over that button for the whole dwell after a reply is recorded. Firing the cue at `setSaved` — as this did when the
      // confirmation first moved off the Save button — burns the sweep-in, the
      // tick draw and the entire hold while the button is still covered, so the
      // guest is uncovered onto the 500ms fade-out alone: green draining off a
      // button they never saw fill, which reads as nothing having happened.
      // The cue therefore has to land WITH the close, not at the top of the dwell.
      const onConfirmed = vi.fn();
      const onClose = vi.fn();
      const rsvps: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ rsvps }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      // Fake clock before the submit registers the dwell (P-I2, as above).
      vi.useFakeTimers();
      render(() => (
        <RsvpModal
          event={event}
          members={[priya]}
          apiUrl="https://api.test"
          onClose={onClose}
          onConfirmed={onConfirmed}
        />
      ));
      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);

      // Flush the fetch chain so the sheet is confirmed, without letting the
      // dwell elapse: the sheet is up and still covering the Respond button.
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector("button[type='submit']")!.textContent).toContain("Saved");
      expect(onConfirmed).not.toHaveBeenCalled();

      // Landing the dwell uncovers the button and cues the celebration together.
      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
      expect(onConfirmed).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);

      // And in THAT order, which is load-bearing rather than incidental: the
      // parent's `onConfirmed` is `() => setJustRespondedEventId(event().id)`,
      // where `event()` is the accessor of the `<Show when={rsvpEvent()}>` that
      // `onClose` (`() => setRsvpEvent(null)`) disposes. Swapped, the cue would
      // read a disposed accessor. Both orderings otherwise pass every test here.
      expect(onConfirmed.mock.invocationCallOrder[0]!).toBeLessThan(
        onClose.mock.invocationCallOrder[0]!,
      );
    });

    /**
     * Open the sheet with a fetch the test controls, answer for Priya and
     * submit. Returns the resolver, so the test decides how long the reply
     * takes — the whole point of the dwell budget.
     */
    function submitWithPendingReply(onClose: () => void) {
      let land!: (r: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              land = resolve;
            }),
        ),
      );
      vi.useFakeTimers();
      render(() => (
        <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={onClose} />
      ));
      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);
      const rsvps: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      ];
      return () =>
        land(
          new Response(JSON.stringify({ rsvps }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
    }

    it("charges a slow reply against the dwell instead of stacking on top of it", async () => {
      // The reported bug: the sheet used to hold a flat 900ms measured from the
      // moment the server answered, so a guest waited `round-trip + 900ms` and
      // the slower the network the longer the sheet sat there having already
      // finished its job. The wait is now a budget measured from the CLICK.
      const onClose = vi.fn();
      const land = submitWithPendingReply(onClose);

      // A reply that outruns the entire budget on its own.
      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS + 400);
      expect(onClose).not.toHaveBeenCalled();
      land();
      await vi.advanceTimersByTimeAsync(0);
      expect(document.querySelector("button[type='submit']")!.textContent).toContain("Saved");

      // It still gets the floor — "Saving…" is not a confirmation, so the
      // confirmed state must be seen even when the budget is long gone…
      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MIN_MS - 1);
      expect(onClose).not.toHaveBeenCalled();
      // …and nothing beyond it. Landing on exactly the floor rather than
      // somewhere under the budget is what proves the request time was
      // deducted, not ignored.
      await vi.advanceTimersByTimeAsync(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes a fast reply out at the budget, not the budget plus the round-trip", async () => {
      const onClose = vi.fn();
      const land = submitWithPendingReply(onClose);

      // Below the knee, the one region where the budget is spent exactly.
      // Derived from the constants — a literal would sit the wrong side of it
      // the moment either is retuned.
      const requestMs = Math.floor((SAVED_DWELL_MS - SAVED_DWELL_MIN_MS) / 2);
      await vi.advanceTimersByTimeAsync(requestMs);
      land();
      await vi.advanceTimersByTimeAsync(0);

      // Total click-to-close is the budget, whatever share of it the network
      // took: the remaining dwell is exactly what is left over.
      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS - requestMs - 1);
      expect(onClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("skips the celebration when the guest dismisses the sheet mid-dwell", async () => {
      // The contract `onConfirmed`'s doc states: an early dismissal cancels the
      // dwell timer, so the cue never fires and no celebration plays on a card
      // the guest has already moved on from. Worth pinning at the real exit —
      // Cancel is `disabled` while `saved()`, so the only mid-dwell way out is
      // Escape or a backdrop tap, and both route through `AnimatedModal`'s
      // `handleClose`, a different component with an awaited dynamic import in
      // front of `props.onClose()`. Unmounting via `cleanup()` would skip that
      // path entirely and prove nothing about it.
      const onConfirmed = vi.fn();
      const rsvps: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ rsvps }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.useFakeTimers();
      // `onClose` must actually UNMOUNT, the way the parent's
      // `() => setRsvpEvent(null)` does — that unmount is what runs the
      // `onCleanup` that clears the dwell timer, and so it is the entire
      // mechanism under test. A bare spy leaves the sheet mounted and the dwell
      // lands anyway; this test failed exactly that way when first written.
      const [open, setOpen] = createSignal(true);
      render(() => (
        <Show when={open()}>
          <RsvpModal
            event={event}
            members={[priya]}
            apiUrl="https://api.test"
            onClose={() => setOpen(false)}
            onConfirmed={onConfirmed}
          />
        </Show>
      ));
      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);
      await vi.advanceTimersByTimeAsync(0);
      expect(onConfirmed).not.toHaveBeenCalled();

      // Escape mid-dwell, then run well past both the dwell and the celebration.
      fireEvent.keyDown(document, { key: "Escape" });
      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS * 3);
      expect(open()).toBe(false);
      expect(onConfirmed).not.toHaveBeenCalled();
    });

    it("fires onConfirmed for a host preview too, without ever calling onSubmitted", async () => {
      // Preview must show the guest's confirmation without ever claiming data
      // was written — `onConfirmed` (the celebration) fires; `onSubmitted` (the
      // write) never does.
      const onConfirmed = vi.fn();
      const onSubmitted = vi.fn();
      const onClose = vi.fn();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      // Fake clock: since the cue moved to the close, waiting it out for real
      // would sleep the full `SAVED_DWELL_MS` and sit on `waitFor`'s deadline.
      vi.useFakeTimers();
      render(() => (
        <RsvpModal
          event={event}
          members={[priya]}
          apiUrl="https://api.test"
          preview
          onClose={onClose}
          onConfirmed={onConfirmed}
          onSubmitted={onSubmitted}
        />
      ));
      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);

      // Preview spends the WHOLE budget, two-sided (T-M1). Preview exists so a
      // host feels exactly what a guest feels, and it is the one call site the
      // two controllable-reply tests above cannot reach — it passes a literal
      // `requestMs` of 0 because it never leaves the browser. Only the lower
      // edge distinguishes that 0 from any other argument: "closes by the
      // budget" is satisfied by every dwell ≤ budget, so without this the
      // preview hold could silently collapse to the floor — half the real
      // path's — and every test in this file would still pass.
      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS - 1);
      expect(onClose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onClose).toHaveBeenCalledTimes(1);

      expect(onConfirmed).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(onSubmitted).not.toHaveBeenCalled();
    });

    it("does not fire onConfirmed when the save leaves the party incomplete", async () => {
      // A partial save still closes the sheet and still gets the toast, but
      // the Respond-button celebration is reserved for the save that finishes
      // the whole party.
      const onConfirmed = vi.fn();
      const onClose = vi.fn();
      const rsvps: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ rsvps }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.useFakeTimers();
      render(() => (
        <RsvpModal
          event={event}
          members={[priya, raj]}
          apiUrl="https://api.test"
          onClose={onClose}
          onConfirmed={onConfirmed}
        />
      ));
      // Only Priya answered — Raj is left null.
      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);

      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onConfirmed).not.toHaveBeenCalled();
    });

    it("fires onConfirmed when the save leaves every invited member answered", async () => {
      const onConfirmed = vi.fn();
      const onClose = vi.fn();
      const rsvps: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
        { guestId: "guest-raj", eventId: "event-1", status: "declined", dietary: "" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ rsvps }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.useFakeTimers();
      render(() => (
        <RsvpModal
          event={event}
          members={[priya, raj]}
          apiUrl="https://api.test"
          onClose={onClose}
          onConfirmed={onConfirmed}
        />
      ));
      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(within(fieldsetFor("Raj")).getByText("Not attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);

      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
      expect(onConfirmed).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("counts a member's PRIOR reply as answered, so completing just the last member fires onConfirmed", async () => {
      // `initialResponses` prefills an existing reply into `responses()`, so
      // "every visible member answered" already accounts for a household that
      // is finishing a party it started on an earlier visit — not just one
      // answered entirely in this session.
      const onConfirmed = vi.fn();
      const rsvps: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
        { guestId: "guest-raj", eventId: "event-1", status: "declined", dietary: "" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ rsvps }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.useFakeTimers();
      render(() => (
        <RsvpModal
          event={event}
          members={[priya, raj]}
          // Raj already answered on a previous visit; only Priya is missing.
          existingRsvps={[
            { guestId: "guest-raj", eventId: "event-1", status: "declined", dietary: "" },
          ]}
          apiUrl="https://api.test"
          onClose={() => {}}
          onConfirmed={onConfirmed}
        />
      ));
      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);

      await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
      expect(onConfirmed).toHaveBeenCalledTimes(1);
    });

    it("announces the recorded reply in a live region", async () => {
      // A colour sweep and a tick say nothing to a screen reader, and the
      // button's own label is not re-read on change.
      const { getByRole } = await confirmOnce();
      const status = getByRole("status");
      expect(status.textContent).toContain("has been saved");
      expect(status.textContent).toContain(event.name);
      expect(status.className).toContain("sr-only");
    });

    it("keeps the live region mounted before the reply, so the change is announced", () => {
      // A region that springs into existence with its content is routinely
      // missed; one that was already there and changed is not.
      const { getByRole } = render(() => (
        <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
      ));
      const status = getByRole("status");
      expect(status).toBeTruthy();
      expect(status.textContent?.trim()).toBe("");
    });

    it("keeps focus on the Save button through the confirmation", async () => {
      // Disabling the focused control would drop focus to <body> — outside the
      // aria-modal dialog, with no keyboard route back in. That is the C-L2
      // failure, and it must not be reintroduced by the success path.
      const { getByRole } = await confirmOnce();
      const save = getByRole("button", { name: "Saved" });
      expect(document.activeElement).toBe(save);
      expect(save.hasAttribute("disabled")).toBe(false);
      expect(save.getAttribute("aria-disabled")).toBe("true");
    });

    it("refuses a second submit while the confirmation is on screen", async () => {
      // `aria-disabled` is advisory to the browser, so the guard in
      // `handleSubmit` is what actually stops a double write.
      const { getByRole, fetchSpy } = await confirmOnce();
      fireEvent.click(getByRole("button", { name: "Saved" }));
      fireEvent.submit(document.querySelector("form")!);
      await Promise.resolve();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("locks the party's controls once the reply is recorded", async () => {
      const { getByRole } = await confirmOnce();
      const fs = fieldsetFor("Priya");
      // Editing an answer that can no longer be sent is a dead end.
      expect((within(fs).getByText("Attending") as HTMLButtonElement).disabled).toBe(true);
      expect((within(fs).getByText("Not attending") as HTMLButtonElement).disabled).toBe(true);
      // Cancel too: there is nothing left to cancel, and an early `onClose`
      // here would race the dwell timer for the same call.
      expect((getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("locks the dietary field and its C-H2 consent box too", async () => {
      // Both are gated on the same `locked()` accessor as the toggles, and both
      // carry special-category data — they must not stay live on a sheet whose
      // reply can no longer be sent.
      await confirmOnce({ withDietary: true });
      const fs = fieldsetFor("Priya");
      expect((within(fs).getByPlaceholderText(/Vegetarian/) as HTMLInputElement).disabled).toBe(
        true,
      );
      expect((within(fs).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    });

    it("never wears the in-flight fade while confirming", async () => {
      // The confirmed button is the one state that must look most alive, so it
      // must not inherit the 40% fade the in-flight state uses.
      await confirmOnce();
      const submit = document.querySelector("button[type='submit']") as HTMLElement;
      expect(submit.className).not.toContain("opacity-40");
    });

    it("still rescues focus if the deadline passes DURING the confirmation (C-L2)", async () => {
      // The confirmed state deliberately keeps focus on the submit button. If
      // the deadline flips inside the dwell, `<Show when={!props.closed}>`
      // unmounts that focused button and focus reverts to <body>, so the C-L2
      // rescue has to fire. It can only do that if the dismiss button is still
      // focusable — `.focus()` is a no-op on a disabled one, and the dwell
      // would otherwise have disabled it.
      const [closed, setClosed] = createSignal(false);
      const rsvps: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ rsvps }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const { getByRole, findByText } = render(() => (
        <RsvpModal
          event={event}
          members={[priya]}
          apiUrl="https://api.test"
          closed={closed()}
          onClose={() => {}}
        />
      ));

      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      const save = getByRole("button", { name: "Save" });
      save.focus();
      fireEvent.click(save);
      await findByText("Saved");
      expect(document.activeElement).toBe(save);

      setClosed(true);

      await waitFor(() => expect(document.querySelector("button[type='submit']")).toBeNull());
      expect(document.activeElement).not.toBe(document.body);
      expect((document.activeElement as HTMLElement).textContent).toContain("Close");
    });

    it("leaves the sheet fully re-submittable when the server refuses", async () => {
      // The nastiest possible regression here is the confirmed state leaking
      // out of the 200 branch — into a `finally`, say. The guest would then see
      // a gold tick and "Saved", every control locked, and the sheet close
      // itself, with nothing written. Every existing error-path test asserts
      // only the message text, so all of them would still pass.
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 500 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              rsvps: [
                { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const onClose = vi.fn();

      const { getByRole, findByText } = render(() => (
        <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={onClose} />
      ));

      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(getByRole("button", { name: "Save" }));
      await findByText("Something went wrong. Please try again.");

      // Assert the NEGATIVE of every signal the confirmed state owns.
      const save = getByRole("button", { name: "Save" });
      expect(save.getAttribute("aria-disabled")).toBeNull();
      const fs = fieldsetFor("Priya");
      expect((within(fs).getByText("Attending") as HTMLButtonElement).disabled).toBe(false);
      expect((getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
      expect(onClose).not.toHaveBeenCalled();

      // And the lock genuinely released: a retry goes through to a confirmation.
      fireEvent.click(getByRole("button", { name: "Save" }));
      await findByText("Saved");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("is undisturbed when the parent feeds the fresh rows back mid-confirmation", async () => {
      // `onSubmitted` now fires one dwell before the sheet closes, so the parent's
      // `setClaimResult` lands while this component is still mounted and
      // confirming — the real wiring in both InvitePage packs, which stub the
      // modal out and so never exercise it. The sheet's safety rests on
      // `initialResponses` being a signal initialiser rather than a memo; turn
      // it into one, or add an effect re-seeding from `existingRsvps`, and the
      // confirmation would reset to "Save" mid-sweep with nothing to catch it.
      const [rsvps, setRsvps] = createSignal<RsvpSummary[]>([]);
      const updated: RsvpSummary[] = [
        { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ rsvps: updated }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      const onClose = vi.fn();

      const { getByRole, findByText } = render(() => (
        <RsvpModal
          event={event}
          members={[priya]}
          existingRsvps={rsvps()}
          apiUrl="https://api.test"
          onClose={onClose}
          onSubmitted={setRsvps}
        />
      ));

      fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
      fireEvent.click(getByRole("button", { name: "Save" }));
      await findByText("Saved");

      // The parent really did write back.
      expect(rsvps()).toEqual(updated);
      // And the confirmation is untouched by it.
      const save = getByRole("button", { name: "Saved" });
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(within(fieldsetFor("Priya")).getByText("Attending").getAttribute("aria-pressed")).toBe(
        "true",
      );
    });

    it("drops the dwell timer if the guest dismisses the confirmation early", async () => {
      // Escape, the close chip or a backdrop tap all unmount this component
      // mid-dwell. A surviving timer would then call `onClose` a second time on
      // a disposed instance.
      vi.useFakeTimers();
      try {
        const onClose = vi.fn();
        const rsvps: RsvpSummary[] = [
          { guestId: "guest-priya", eventId: "event-1", status: "attending", dietary: "" },
        ];
        vi.stubGlobal(
          "fetch",
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ rsvps }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        );

        const { getByRole } = render(() => (
          <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={onClose} />
        ));

        fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
        fireEvent.click(getByRole("button", { name: "Save" }));

        // Let the fetch promise chain settle without letting the dwell elapse.
        await vi.advanceTimersByTimeAsync(0);
        expect(getByRole("button", { name: "Saved" })).toBeTruthy();

        cleanup();
        await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS * 3);
        expect(onClose).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("seats the action bar on the sheet's bottom edge and balances the card insets", () => {
    const { getByRole } = render(() => (
      <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
    ));

    const panel = document.querySelector('[role="dialog"]') as HTMLElement;
    // The panel is a non-scrolling frame; its last child is the scroll
    // container that carries the padding the action bar has to line up with.
    const scroller = panel.lastElementChild as HTMLElement;
    // The sheet hands its bottom edge to the action bar (see AnimatedModal's
    // `flushBottom`) instead of padding underneath it.
    expect(scroller.className).toContain("pb-0");

    // Anchor on the role, not on how deep the label's text node sits — a future
    // icon or <span> around "Save" would silently re-point `parentElement`.
    const bar = getByRole("button", { name: "Save" }).parentElement as HTMLElement;
    expect(bar.className).toContain("sticky");
    // No negative bottom margin: `bottom: 0` resolves against the scrollport, so
    // one would hoist the bar up over the last card rather than stretch it down.
    expect(bar.className).not.toMatch(/-mb-/);
    // With the panel at `pb-0` this is the ONLY bottom inset left, so it is what
    // keeps Cancel/Save clear of the iPhone home indicator. Losing it would be
    // invisible to every other assertion here.
    expect(bar.className).toContain("pb-[max(1rem,env(safe-area-inset-bottom))]");
    // The bar is full-bleed only because `-mx-6` cancels the scroller's `px-6`.
    // The number is written twice, in two components — pin both together so a
    // change to either fails at the coupling rather than in a screenshot.
    expect(bar.className).toContain("-mx-6");
    expect(scroller.className).toContain("px-6");

    // The <legend> is laid out in the top border and the block-start padding is
    // added below it, so the card takes no top padding of its own — otherwise
    // its top inset runs ~3x the 20px on the other three sides.
    const card = fieldsetFor("Priya");
    expect(card.className).toContain("pt-0");
    expect(card.className).toContain("pb-5");
    expect(card.className).toContain("px-5");
    // `pt-0` is only correct while the legend carries its own bottom margin —
    // drop that and the first control lands flush against the card's border.
    expect(card.querySelector("legend")!.className).toContain("mb-3");
  });
});
