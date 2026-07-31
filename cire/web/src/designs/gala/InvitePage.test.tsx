import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import type { ClaimResult, RsvpSummary } from "../../components/types";
import InvitePage from "./InvitePage";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

vi.mock("./UnlockReveal.motion", () => ({
  unlockRevealSequence: vi.fn(() => Promise.resolve()),
}));

const capturedProps: { value: Record<string, unknown> | null } = { value: null };

vi.mock("../../components/RsvpModal", () => ({
  RsvpModal: (props: Record<string, unknown>) => {
    capturedProps.value = props;
    return <div data-testid="rsvp-modal-stub" />;
  },
}));

const detailsModalProps: { value: Record<string, unknown> | null } = { value: null };

vi.mock("../../components/DetailsModal", () => ({
  DetailsModal: (props: Record<string, unknown>) => {
    detailsModalProps.value = props;
    return <div data-testid="details-modal-stub" />;
  },
}));

// Stub the PulseAccountLink island to a marker so InvitePage's tests assert
// only the mount wiring (post-claim, non-preview) without probing the account
// API.
vi.mock("../../components/PulseAccountLink", () => ({
  PulseAccountLink: () => <div data-testid="pulse-account-link-stub" />,
}));

vi.mock("@shared/rp-auth/solid", () => ({
  AuthProvider: (props: { children: unknown }) => props.children,
}));

vi.mock("solid-toast", () => ({ Toaster: () => null }));

const claim: ClaimResult = {
  publicId: "SHARMA-JOY-RK97",
  familyName: "Sharma",
  members: [
    {
      guestId: "guest-1",
      firstName: "Priya",
      lastName: "Sharma",
      eventIds: ["event-1"],
    },
  ],
  events: [
    {
      id: "event-1",
      name: "Mehndi",
      description: "Henna evening",
      startAt: "2026-09-18T16:00:00+10:00",
      endAt: "2026-09-18T22:00:00+10:00",
      timezone: "Australia/Sydney",
      address: "Sharma Residence",
      dressCodeDescription: null,
      dressCodePalette: null,
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 0,
      imageUrl: null,
    },
    {
      id: "event-2",
      name: "Reception",
      description: "The big night",
      startAt: "2026-09-19T18:00:00+10:00",
      endAt: "2026-09-19T23:00:00+10:00",
      timezone: "Australia/Sydney",
      address: "Grand Hall",
      dressCodeDescription: null,
      dressCodePalette: null,
      pinterestUrl: null,
      mapsUrl: null,
      sortOrder: 1,
      imageUrl: null,
    },
  ],
  rsvps: [{ guestId: "guest-1", eventId: "event-1", status: "attending", dietary: "Vegetarian" }],
};

describe("gala InvitePage", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("style");
    capturedProps.value = null;
    detailsModalProps.value = null;
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("renders the claim panel initially, with the events section absent", () => {
    const { getByText, queryByTestId } = render(() => <InvitePage apiUrl="https://api.test" />);

    expect(getByText("Enter Your Code")).toBeTruthy();
    expect(queryByTestId("events-column")).toBeNull();
  });

  it("renders the events section with a data-event-card wrapper per event after a claim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { getByText, getByPlaceholderText, container } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    await waitFor(() => expect(getByText("Mehndi")).toBeTruthy(), { timeout: 2000 });
    expect(getByText("Reception")).toBeTruthy();

    const cards = container.querySelectorAll("[data-event-card]");
    expect(cards).toHaveLength(2);

    // Drain handleClaimed's own async reveal (dynamic import + mocked
    // unlockRevealSequence call) before the next test runs — otherwise it can
    // still be in flight and consume a later test's `mockRejectedValueOnce`
    // meant for its own call, since the mock is shared module-wide.
    const { unlockRevealSequence } = await import("./UnlockReveal.motion");
    await waitFor(() => expect(unlockRevealSequence).toHaveBeenCalled());
  });

  it("still reveals the events section when the motion chunk fails to load", async () => {
    const { unlockRevealSequence } = await import("./UnlockReveal.motion");
    vi.mocked(unlockRevealSequence).mockRejectedValueOnce(new Error("chunk load failed"));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { getByText, getByPlaceholderText, getByTestId } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    await waitFor(() => expect(getByTestId("events-column")).toBeTruthy(), { timeout: 2000 });
    const section = getByTestId("events-column").closest("section") as HTMLElement;
    await waitFor(() => expect(section.style.opacity).toBe("1"));
  });

  it("widens the events column to max-w-[960px], left-aligned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { getByText, getByPlaceholderText, getByTestId } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    await waitFor(() => expect(getByText("Your Events")).toBeTruthy(), { timeout: 2000 });
    const column = getByTestId("events-column");
    expect(column.className).toContain("max-w-[960px]");
    expect(column.className).not.toContain("mx-auto");
    expect(column.className).not.toContain("text-center");
  });

  it("renders every EventCard with orientation=norm (no alternating rhythm)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { getByText, getByPlaceholderText, container } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    await waitFor(() => expect(getByText("Mehndi")).toBeTruthy(), { timeout: 2000 });
    const cards = container.querySelectorAll("[data-orientation]");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.getAttribute("data-orientation")).toBe("norm");
    }
  });

  it("swaps the claim panel to the welcome state post-claim, greeting the individual guest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { getByText, getByPlaceholderText, queryByText } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    await waitFor(() => expect(getByText("Dear Priya")).toBeTruthy(), { timeout: 2000 });
    expect(queryByText("Enter Your Code")).toBeTruthy();
  });

  it("mounts the Pulse account-link affordance post-claim (non-preview only)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { getByText, getByPlaceholderText, queryByTestId } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    expect(queryByTestId("pulse-account-link-stub")).toBeNull();

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    await waitFor(() => expect(queryByTestId("pulse-account-link-stub")).toBeTruthy(), {
      timeout: 2000,
    });
  });

  it("hides the Pulse account-link affordance in preview mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...claim, preview: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText, queryByTestId } = render(() => <InvitePage apiUrl="https://api.test" />);

    await waitFor(() => expect(getByText(/Preview mode/i)).toBeTruthy(), { timeout: 2000 });
    expect(queryByTestId("pulse-account-link-stub")).toBeNull();
  });

  it("threads the details theme into both the RSVP modal and the event-details modal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...claim, preview: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getAllByRole, getByTestId } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        theme={{
          headingFont: null,
          bodyFont: null,
          palette: { gilt: "#abcdef" },
          tones: { details: "raised" },
        }}
      />
    ));

    // Two events are present (per fixture) — the first is enough to exercise
    // the theme-threading wiring shared by every card.
    await waitFor(() => expect(getAllByRole("button", { name: /Respond/i })[0]).toBeTruthy(), {
      timeout: 2000,
    });
    fireEvent.click(getAllByRole("button", { name: /Respond/i })[0]!);
    await waitFor(() => expect(getByTestId("rsvp-modal-stub")).toBeTruthy());
    const rsvpVars = capturedProps.value?.themeVars as Record<string, string>;
    expect(rsvpVars["--invite-section-bg"]).toBe("var(--color-surface-raised)");

    (capturedProps.value!.onClose as () => void)();
    fireEvent.click(getAllByRole("button", { name: /Event Details/i })[0]!);
    await waitFor(() => expect(getByTestId("details-modal-stub")).toBeTruthy());
    const detailsVars = detailsModalProps.value?.themeVars as Record<string, string>;
    expect(detailsVars["--invite-section-bg"]).toBe("var(--color-surface-raised)");
  });

  it("threads existingRsvps, apiUrl, members and onSubmitted into RsvpModal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const { getByText, getByPlaceholderText, getAllByRole } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), {
      target: { value: "SHARMA-JOY-RK97" },
    });
    fireEvent.click(getByText("Open Invitation"));

    // Two events are present (per fixture) — respond to the first.
    await waitFor(() => expect(getAllByRole("button", { name: /Respond/i })[0]).toBeTruthy(), {
      timeout: 2000,
    });
    fireEvent.click(getAllByRole("button", { name: /Respond/i })[0]!);

    await waitFor(() => expect(capturedProps.value).not.toBeNull());

    const props = capturedProps.value!;
    expect(props.apiUrl).toBe("https://api.test");
    expect(props.members).toEqual(claim.members);
    expect(props.existingRsvps).toEqual(claim.rsvps);
    expect(typeof props.onSubmitted).toBe("function");

    const updated: RsvpSummary[] = [
      { guestId: "guest-1", eventId: "event-1", status: "declined", dietary: "" },
    ];
    (props.onSubmitted as (r: RsvpSummary[]) => void)(updated);

    (props.onClose as () => void)();
    capturedProps.value = null;
    await waitFor(() => expect(getAllByRole("button", { name: /Respond/i })[0]).toBeTruthy());
    fireEvent.click(getAllByRole("button", { name: /Respond/i })[0]!);

    await waitFor(() => expect(capturedProps.value).not.toBeNull());
    expect(capturedProps.value!.existingRsvps).toEqual(updated);
  });

  it("renders the organiser's events-section header copy, and the defaults when unset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...claim, preview: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText, queryByText } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        details={{ eyebrow: "Join The Celebration", heading: "The Festivities" }}
      />
    ));

    await waitFor(() => expect(getByText("The Festivities")).toBeTruthy(), { timeout: 2000 });
    expect(getByText("Join The Celebration")).toBeTruthy();
    expect(queryByText("Your Events")).toBeNull();
    expect(queryByText("Celebrate With Us")).toBeNull();
  });

  it("renders the live revalidated welcome message, overriding the stale build-time prop", async () => {
    // The build-time prop carries the OLD greeting; the live /api/invite/:slug
    // response carries the organiser's NEW one. With a slug present, the
    // on-mount revalidation must win — an organiser edit made after the last
    // build reaches guests without a static rebuild.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // The invite-customisation revalidation.
      if (url.includes("/api/invite/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ welcome: { message: "Fresh live greeting" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      // The auto-claim POST (?code= deep-link).
      return Promise.resolve(
        new Response(JSON.stringify({ ...claim, preview: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText, queryByText } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        slug="cire-wedding"
        // Stale build-time greeting — must be overridden by the live fetch.
        welcomeMessage="Stale build-time greeting"
      />
    ));

    await waitFor(() => expect(getByText("Fresh live greeting")).toBeTruthy(), { timeout: 2000 });
    expect(queryByText("Stale build-time greeting")).toBeNull();
  });

  it("renders the build-time welcome message when no slug means no revalidation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...claim, preview: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText, queryByText } = render(() => (
      <InvitePage apiUrl="https://api.test" welcomeMessage="Our own greeting" />
    ));

    await waitFor(() => expect(getByText("Our own greeting")).toBeTruthy(), { timeout: 2000 });
    expect(queryByText("We are delighted to invite you to celebrate with us.")).toBeNull();
  });

  it("auto-claims from a ?code= deep-link and strips the code from the URL (S-L1)", async () => {
    const previewClaim: ClaimResult = { ...claim, preview: true };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(previewClaim), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText } = render(() => <InvitePage apiUrl="https://api.test" />);

    await waitFor(() => expect(getByText(/Preview mode/i)).toBeTruthy(), { timeout: 2000 });
    expect(window.location.search).not.toContain("code");
  });

  it("hides the closing section until the guest claims their code, then shows it", async () => {
    // The closing content rides the CLAIM response — the public invite payload
    // redacts it (S-H1), so there is no prop to seed it with pre-claim.
    const claimed = {
      ...claim,
      preview: true,
      closing: { message: "No boxed gifts please", imageUrl: null, imageCrop: null },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(claimed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { container, queryByText } = render(() => <InvitePage apiUrl="https://api.test" />);

    // Pre-claim: the section is not in the DOM, and neither is its copy.
    expect(container.querySelector("[data-invite-closing]")).toBeNull();
    expect(queryByText("No boxed gifts please")).toBeNull();

    // Claim (the ?code= deep-link path drives it without typing).
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");
    cleanup();
    const after = render(() => <InvitePage apiUrl="https://api.test" />);

    await waitFor(() =>
      expect(after.container.querySelector("[data-invite-closing]")).toBeTruthy(),
    );
    expect(after.getByText("No boxed gifts please")).toBeTruthy();
  });

  it("renders the closing image on its own, with no note", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...claim,
            preview: true,
            closing: {
              message: null,
              imageUrl: "/api/invite/anita-ben/image/footer?v=7",
              imageCrop: null,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { container } = render(() => <InvitePage apiUrl="https://api.test" />);

    const section = await waitFor(() => {
      const el = container.querySelector("[data-invite-closing]");
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const img = section.querySelector("img") as HTMLImageElement;
    // The path is resolved against the API origin, not the guest site's, and
    // names a bounded variant so it can't mint a transform outside the allowlist.
    expect(img.getAttribute("src")).toBe(
      "https://api.test/api/invite/anita-ben/image/footer?v=7&variant=thumb",
    );
    // Off-screen at mount (it sits below every event card), so it must not
    // race the in-viewport event images for bandwidth.
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(section.querySelector("p")).toBeNull();
  });

  it("omits the closing section entirely when neither a note nor an image is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...claim, preview: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { container, getByText } = render(() => <InvitePage apiUrl="https://api.test" />);

    // Wait for the claim to land, so "absent" isn't just "not rendered yet".
    await waitFor(() => expect(getByText(/Preview mode/i)).toBeTruthy(), { timeout: 2000 });
    expect(container.querySelector("[data-invite-closing]")).toBeNull();
  });

  // Whitespace-only is not content — same rule as every other invite segment.
  it("omits the closing section for a whitespace-only note", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...claim,
            preview: true,
            closing: { message: "   ", imageUrl: null, imageCrop: null },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { container, getByText } = render(() => <InvitePage apiUrl="https://api.test" />);

    await waitFor(() => expect(getByText(/Preview mode/i)).toBeTruthy(), { timeout: 2000 });
    expect(container.querySelector("[data-invite-closing]")).toBeNull();
  });

  // Gala renders its own events section, so the deadline wiring is a SEPARATE
  // set of call sites from classic's — the same behaviour has to be pinned on
  // both or one design silently keeps accepting late replies.
  describe("RSVP deadline", () => {
    async function claimWithDeadline(rsvpDeadline: ClaimResult["rsvpDeadline"]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ...claim, preview: true, rsvpDeadline }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");
      const view = render(() => <InvitePage apiUrl="https://api.test" />);
      await waitFor(() => expect(view.getByText(/Preview mode/i)).toBeTruthy(), { timeout: 2000 });
      return view;
    }

    it("invites a reply by the date while the deadline is ahead", async () => {
      const { getByText, getAllByRole } = await claimWithDeadline({
        date: "2999-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2999-09-01T13:59:59.999Z",
        closed: false,
      });

      expect(getByText("Kindly respond by Sunday 1 September 2999.")).toBeTruthy();
      const responds = getAllByRole("button", { name: "Respond" }) as HTMLButtonElement[];
      expect(responds.every((b) => !b.disabled)).toBe(true);
    });

    it("sits below the header rule, directly on top of the event cards", async () => {
      await claimWithDeadline({
        date: "2999-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2999-09-01T13:59:59.999Z",
        closed: false,
      });

      const notice = document.getElementById("rsvp-deadline-notice")!;
      // The rule closes the section header; the line belongs to the cards under
      // it, not to the heading above — so it comes AFTER the rule…
      expect(notice.previousElementSibling?.tagName).toBe("HR");
      // …and nothing sits between it and the card list.
      expect(notice.nextElementSibling?.querySelector("[data-event-card]")).not.toBeNull();
    });

    it("locks every card and states the date once the deadline has passed", async () => {
      const { getByText, getAllByRole } = await claimWithDeadline({
        date: "2020-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2020-09-01T13:59:59.999Z",
        closed: true,
      });

      expect(getByText("RSVPs closed on Tuesday 1 September 2020.")).toBeTruthy();
      const closed = getAllByRole("button", { name: "RSVPs closed" }) as HTMLButtonElement[];
      expect(closed.length).toBeGreaterThan(0);
      // `aria-disabled`, not the native attribute — see C-M2 in EventCard.
      expect(closed.every((b) => b.getAttribute("aria-disabled") === "true")).toBe(true);
      // Each closed button points at the section notice, which is the only
      // place the DATE is stated.
      expect(
        closed.every((b) => b.getAttribute("aria-describedby") === "rsvp-deadline-notice"),
      ).toBe(true);
      expect(document.getElementById("rsvp-deadline-notice")).not.toBeNull();
    });

    it("renders no notice and no lock when the wedding has no deadline", async () => {
      const { queryByText, getAllByRole } = await claimWithDeadline(null);

      expect(queryByText(/Kindly respond by/)).toBeNull();
      expect(queryByText(/RSVPs closed/)).toBeNull();
      const responds = getAllByRole("button", { name: "Respond" }) as HTMLButtonElement[];
      expect(responds.every((b) => !b.disabled)).toBe(true);
    });

    it("threads the closed state and the deadline day into the RSVP sheet", async () => {
      const { getAllByRole } = await claimWithDeadline({
        date: "2999-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2999-09-01T13:59:59.999Z",
        closed: false,
      });

      fireEvent.click(getAllByRole("button", { name: "Respond" })[0]!);
      await waitFor(() => expect(capturedProps.value).not.toBeNull());
      expect(capturedProps.value!.closed).toBe(false);
      expect(capturedProps.value!.closedOn).toBe("Sunday 1 September 2999");
    });
  });
});
