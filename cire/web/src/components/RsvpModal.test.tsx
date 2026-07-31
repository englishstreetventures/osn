import { render, cleanup, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { RsvpModal } from "./RsvpModal";
import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

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

    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(getByText("Save"));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The deliberate no-op: nothing left the browser and nothing was "saved".
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("still enforces party-complete validation before the preview no-op", async () => {
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

    // Only Priya answered → submit is blocked even in preview, and does not close.
    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(getByText("Save"));

    await waitFor(() =>
      expect(getByText("Please respond for everyone in your party.")).toBeTruthy(),
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
