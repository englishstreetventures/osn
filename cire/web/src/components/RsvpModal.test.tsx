import { render, cleanup, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { RsvpModal } from "./RsvpModal";
import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  date: "2026-09-18",
  location: "The Sharma Residence",
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
};

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  eventIds: ["event-1", "event-2"],
};

const raj: FamilyMember = {
  guestId: "guest-raj",
  firstName: "Raj",
  lastName: "Sharma",
  eventIds: ["event-1"],
};

const naina: FamilyMember = {
  guestId: "guest-naina",
  firstName: "Naina",
  lastName: "Sharma",
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("shows error and blocks submit if any member's response is null", async () => {
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

    // Only set Priya, leave Raj null
    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));

    fireEvent.click(getByText("Save"));

    await waitFor(() => {
      expect(getByText("Please respond for everyone in your party.")).toBeTruthy();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
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

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

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

    await waitFor(() => {
      expect(onSubmitted).toHaveBeenCalledWith(updatedRsvps);
      expect(onClose).toHaveBeenCalled();
    });
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
});
