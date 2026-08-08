import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { noteClaimed } from "../../components/claim-session";
import { TOTAL_DURATION_MS } from "../../components/rsvp-responded";
import type { ClaimResult, RsvpSummary } from "../../components/types";
import { noSession, withSession } from "../../test-support/claim-fetch";
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

// `claim`'s single member is only invited to Mehndi (`eventIds: ["event-1"]`)
// — `hasHouseholdResponded` requires an invite before it will ever call an
// event answered, so the confirmation-wiring tests below (which DO answer
// Reception) need a variant where the member is invited to both.
const claimBothEvents: ClaimResult = {
  ...claim,
  members: [{ ...claim.members[0]!, eventIds: ["event-1", "event-2"] }],
};

/** The real (unmocked) EventCard's Respond button for a given event's card. */
function respondButtonFor(container: HTMLElement, eventName: string) {
  const card = [...container.querySelectorAll("[data-event-card]")].find((el) =>
    el.textContent?.includes(eventName),
  ) as HTMLElement;
  return [...card.querySelectorAll("button")].find(
    (b) => b.textContent === "Respond" || b.textContent === "RSVPs closed",
  ) as HTMLButtonElement;
}

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

  // Drift guard: gala renders its own claim markup rather than reusing
  // LoginSection, so the code field's contrast contract has to be asserted in
  // both packs or the two silently diverge. Same values, same reasoning — see
  // the note in components/LoginSection.tsx.
  it("draws the code field one step off its surface, like classic", () => {
    const { getByPlaceholderText } = render(() => <InvitePage apiUrl="https://api.test" />);
    const cls = (getByPlaceholderText(/PATEL-JOY/) as HTMLInputElement).className;

    expect(cls).toContain("bg-text/[0.045]");
    expect(cls).toContain("border-text/55");
    expect(cls).not.toContain("border-border");
    expect(cls).not.toContain("bg-transparent");
    // T-S2: classic asserts BOTH halves of the focus affordance, so gala must
    // too — a half-copied drift guard drifts.
    expect(cls).toContain("focus:border-gold");
    expect(cls).toContain("focus-visible:outline-[var(--invite-focus)]");
    // A placeholder is not an accessible name, and it vanishes on input.
    expect((getByPlaceholderText(/PATEL-JOY/) as HTMLInputElement).getAttribute("aria-label")).toBe(
      "Invitation code",
    );
  });

  it("renders the events section with a data-event-card wrapper per event after a claim", async () => {
    vi.stubGlobal(
      "fetch",
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ...claim, preview: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ...claim, preview: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ...claim, preview: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
    vi.stubGlobal("fetch", noSession(fetchMock));
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
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ...claim, preview: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
    vi.stubGlobal("fetch", noSession(fetchMock));
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
    vi.stubGlobal("fetch", noSession(fetchMock));

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
      noSession(
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
      "https://api.test/api/invite/anita-ben/image/footer?v=7&variant=card",
    );
    // Off-screen at mount (it sits below every event card), so it must not
    // race the in-viewport event images for bandwidth.
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(section.querySelector("p")).toBeNull();
  });

  it("omits the closing section entirely when neither a note nor an image is set", async () => {
    vi.stubGlobal(
      "fetch",
      noSession(
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ ...claim, preview: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
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
      noSession(
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
        noSession(
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ ...claim, preview: true, rsvpDeadline }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
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
      // Centred on the column, against gala's left-aligned card copy — the line
      // speaks for the whole list, so it must not read as a note on the first
      // card. Asserted here as well as in `classic` because the two packs place
      // this line at separate call sites with no shared component between them.
      expect(notice.className).toContain("text-center");
    });

    it("paints the open notice in the prose gold, not the metal (WCAG 1.4.3)", async () => {
      await claimWithDeadline({
        date: "2999-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2999-09-01T13:59:59.999Z",
        closed: false,
      });

      // Asserted per pack, like the centring above: the two packs place this
      // line at separate call sites with nothing shared between them, so one
      // can regress to `text-gold` — held only to the 3:1 UI floor — while the
      // other stays correct.
      const classes = document.getElementById("rsvp-deadline-notice")!.className.split(/\s+/);
      expect(classes).toContain("text-gold-ink");
      expect(classes).not.toContain("text-gold");
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

  describe("session restore", () => {
    beforeEach(() => {
      // Returning guest: the restore is gated on the non-credential
      // `cire_claimed` hint written by a successful claim.
      noteClaimed();
    });

    afterEach(() => {
      document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    });

    it("re-opens the invite from an existing session, with no code entry", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ theme: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", withSession(claim, fetchMock as unknown as typeof fetch));

      const { getByText } = render(() => (
        <InvitePage apiUrl="https://api.test" slug="anita-and-ben" />
      ));

      await waitFor(() => expect(getByText("Mehndi")).toBeTruthy(), { timeout: 2000 });
      // The single-member fixture greets the individual, not the household.
      expect(getByText(/Dear Priya/)).toBeTruthy();
      // T-U2: and the code form is actually GONE, not merely behind the events.
      // A restore runs no choreography, so `setRevealed(true)` in `onRestored`
      // is the only thing that flips it — drop that line and every returning
      // guest loads their invite with the form still sitting on top of it. The
      // greeting assertion above cannot see that: textContent queries match
      // inside a `display: none` subtree.
      expect((getByText("Enter Your Code").parentElement as HTMLElement).style.display).toBe(
        "none",
      );
    });

    it("sends the household cookie on the restore read", async () => {
      // Asserted on a bare mock, not through `withSession`: the wrapper answers
      // the restore itself, so the call never reaches the inner mock.
      // A fresh Response per call: `mockResolvedValue` would hand the same one
      // to both the invite revalidation and the restore, and a body can only be
      // read once.
      const restore = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", restore);

      const { getByText } = render(() => (
        <InvitePage apiUrl="https://api.test" slug="anita-and-ben" />
      ));
      await waitFor(() => expect(getByText("Mehndi")).toBeTruthy(), { timeout: 2000 });

      const call = restore.mock.calls.find((c) => String(c[0]).includes("/api/claim/session"));
      expect(call).toBeTruthy();
      expect(call![1]).toMatchObject({ credentials: "include", cache: "no-store" });
    });

    it("does NOT start the restored events section at opacity-0 — nothing would reveal it", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ theme: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", withSession(claim, fetchMock as unknown as typeof fetch));

      const { getByText, container } = render(() => (
        <InvitePage apiUrl="https://api.test" slug="anita-and-ben" />
      ));
      await waitFor(() => expect(getByText("Mehndi")).toBeTruthy(), { timeout: 2000 });

      const section = container.querySelector("[data-event-card]")!.closest("section")!;
      expect(section.classList.contains("opacity-0")).toBe(false);
    });

    it("skips the unlock choreography on a restore — there is no unlock to perform", async () => {
      const { unlockRevealSequence } = await import("./UnlockReveal.motion");
      // The pack mock is module-wide and `restoreAllMocks` does not clear a
      // `vi.fn()` from a `vi.mock` factory, so earlier tests' calls would leak
      // in. Assert on THIS test's calls only.
      vi.mocked(unlockRevealSequence).mockClear();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ theme: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", withSession(claim, fetchMock as unknown as typeof fetch));

      const { getByText } = render(() => (
        <InvitePage apiUrl="https://api.test" slug="anita-and-ben" />
      ));
      await waitFor(() => expect(getByText("Mehndi")).toBeTruthy(), { timeout: 2000 });

      expect(unlockRevealSequence).not.toHaveBeenCalled();
    });

    it("leaves the code form standing when there is no session (401)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ theme: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", noSession(fetchMock as unknown as typeof fetch));

      const { getByPlaceholderText, queryByText } = render(() => (
        <InvitePage apiUrl="https://api.test" slug="anita-and-ben" />
      ));

      await waitFor(() => expect(getByPlaceholderText(/PATEL-JOY/)).toBeTruthy());
      expect(queryByText("Mehndi")).toBeNull();
    });

    it("does not restore over a ?code= deep-link — the explicit code wins", async () => {
      window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");
      // A fresh Response per call: `mockResolvedValue` would hand the same one
      // to both the invite revalidation and the restore, and a body can only be
      // read once.
      const restore = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(claim), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
      vi.stubGlobal("fetch", restore);

      const { getByText } = render(() => (
        <InvitePage apiUrl="https://api.test" slug="anita-and-ben" />
      ));
      await waitFor(() => expect(getByText("Mehndi")).toBeTruthy(), { timeout: 2000 });

      expect(restore.mock.calls.some((c) => String(c[0]).includes("/api/claim/session"))).toBe(
        false,
      );
    });
  });
  // Ported verbatim from classic (T-U1): gala renders its own claim markup
  // instead of reusing `LoginSection`, so `LoginSection.test.tsx`'s swap tests
  // protect classic only. Without these, reverting BOTH of gala's `revealed`
  // bindings back to `claimResult()` — undoing the fix entirely — passes.
  describe("form/welcome swap", () => {
    async function claimWith(sequence: (...args: never[]) => Promise<void> | void) {
      const { unlockRevealSequence } = await import("./UnlockReveal.motion");
      vi.mocked(unlockRevealSequence).mockImplementation(
        sequence as unknown as typeof unlockRevealSequence,
      );
      vi.stubGlobal(
        "fetch",
        noSession(
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify(claim), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        ),
      );
      const screen = render(() => <InvitePage apiUrl="https://api.test" />);
      fireEvent.input(screen.getByPlaceholderText(/PATEL-JOY/), {
        target: { value: "SHARMA-JOY-RK97" },
      });
      fireEvent.click(screen.getByText("Open Invitation"));
      return screen;
    }

    /** The form's wrapper — the element whose `display` the swap drives. */
    const formPanel = (screen: { getByText: (t: string) => HTMLElement }) =>
      screen.getByText("Enter Your Code").parentElement as HTMLElement;

    it("hides the form when the sequence reports it faded out", async () => {
      const { getByText } = await claimWith(((_f, _w, _e, hooks) => {
        (hooks as { onFormHidden?: () => void } | undefined)?.onFormHidden?.();
        return Promise.resolve();
      }) as never);
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
    });

    it("keeps the form up until that moment — the fade needs it on screen", async () => {
      let release: (() => void) | undefined;
      const { getByText } = await claimWith(
        (() => new Promise<void>((resolve) => (release = resolve))) as never,
      );
      await waitFor(() => expect(release).toBeDefined());
      expect(formPanel({ getByText }).style.display).toBe("");
      release!();
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
    });

    it("hides the form when REPORTED, not merely when the sequence ends", async () => {
      // T-U3: the mirror of the test above. Holding the sequence open after it
      // reports is the only way to tell "hidden on report" from "hidden by the
      // `finally`" — once the promise settles the `finally` masks the
      // difference, which is why dropping the `onFormHidden` wiring was
      // otherwise invisible.
      let release: (() => void) | undefined;
      const { getByText } = await claimWith(((_f, _w, _e, hooks) => {
        (hooks as { onFormHidden?: () => void } | undefined)?.onFormHidden?.();
        return new Promise<void>((resolve) => (release = resolve));
      }) as never);
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
      expect(release).toBeDefined();
      release!();
    });

    it("still completes the swap when the sequence throws", async () => {
      // A motion chunk that fails to load must never leave the claim form
      // sitting on top of a claimed invite — the `finally` in handleClaimed.
      const { getByText, queryByText } = await claimWith((() => {
        throw new Error("chunk failed");
      }) as never);
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
      expect(queryByText(/Dear Priya/)).toBeTruthy();
    });

    it("still completes the swap when the sequence never reports", async () => {
      const { getByText } = await claimWith((() => Promise.resolve()) as never);
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
    });
  });

  describe("recorded-reply confirmation wiring", () => {
    // Neither `EventCard` nor `RsvpModal` alone can catch a bug in the glue
    // between them — each is tested in isolation with directly-injected props.
    // These exercise the real (unmocked) `EventCard` behind the mocked
    // `RsvpModal` stub, the same way the production page composes them.
    // `claim` already carries a second, UNANSWERED event (Reception) alongside
    // the already-answered Mehndi, so no separate fixture is needed here.
    beforeEach(() => noteClaimed());
    afterEach(() => {
      document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    });

    it("shows the permanent tick from data alone, with no RsvpModal ever opened", async () => {
      vi.stubGlobal(
        "fetch",
        withSession(
          claim,
          vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ theme: null }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ) as unknown as typeof fetch,
        ),
      );
      const { container } = render(() => (
        <InvitePage apiUrl="https://api.test" slug="anita-and-ben" />
      ));
      await waitFor(() => expect(container.querySelector("[data-event-card]")).toBeTruthy());

      // Mehndi is already on file in the claim payload's `rsvps` — the tick
      // must come purely from `respondedEventIds`, never having gone through a
      // live confirmation.
      expect(respondButtonFor(container, "Mehndi").querySelector("svg")).toBeTruthy();
      // Reception has no row yet — no tick to claim a reply that was never sent.
      expect(respondButtonFor(container, "Reception").querySelector("svg")).toBeNull();
    });

    it("plays EventCard's confirmation from RsvpModal's onConfirmed, and resets so a later edit celebrates again", async () => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal(
          "fetch",
          withSession(
            claimBothEvents,
            vi.fn().mockResolvedValue(
              new Response(JSON.stringify({ theme: null }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            ) as unknown as typeof fetch,
          ),
        );
        const { container } = render(() => (
          <InvitePage apiUrl="https://api.test" slug="anita-and-ben" />
        ));
        await vi.advanceTimersByTimeAsync(0);

        const respond = respondButtonFor(container, "Reception");
        expect(respond.querySelector("svg")).toBeNull();
        fireEvent.click(respond);
        await vi.advanceTimersByTimeAsync(0);

        expect(capturedProps.value).not.toBeNull();
        expect((capturedProps.value!.event as { id: string }).id).toBe("event-2");

        // Production order, which this stub has to imitate deliberately since it
        // is not a real sheet. The write lands at SUBMIT time…
        (capturedProps.value!.onSubmitted as (r: RsvpSummary[]) => void)([
          ...claimBothEvents.rsvps,
          { guestId: "guest-1", eventId: "event-2", status: "attending", dietary: "" },
        ]);

        // …and then, a full `SAVED_DWELL_MS` later, RsvpModal fires the cue and
        // closes itself, in that order (`RsvpModal.enterSavedState`). Driven as
        // a pair because production never separates them, and because the order
        // is load-bearing: `onConfirmed` reads `event()` from the very `<Show>`
        // that `onClose` disposes. Keeping them together is also what puts this
        // page in the state production reaches — card celebrating, no sheet over
        // it. The joint timing itself is `RsvpModal`'s to prove; this pack owns
        // the wiring, and `rsvp-confirmation.integration.test.tsx` owns the seam.
        const confirmAndClose = () => {
          (capturedProps.value!.onConfirmed as () => void)();
          (capturedProps.value!.onClose as () => void)();
        };
        confirmAndClose();
        expect(container.querySelector("[data-testid='rsvp-modal-stub']")).toBeNull();

        let fill = respond.querySelector("span[aria-hidden='true']") as HTMLElement;
        expect(fill.className).toContain("scale-x-100");
        let path = respond.querySelector("svg path") as SVGPathElement;
        expect(path.getAttribute("class")).toContain("animate-tick-draw");

        // The celebration settles: fill stays, tick stays, now undrawn.
        await vi.advanceTimersByTimeAsync(TOTAL_DURATION_MS);
        path = respond.querySelector("svg path") as SVGPathElement;
        expect(path).toBeTruthy();
        expect(path.hasAttribute("stroke-dasharray")).toBe(false);
        fill = respond.querySelector("span[aria-hidden='true']") as HTMLElement;
        expect(fill.className).toContain("scale-x-100");

        // The regression this guards: if `onCelebrated` ever stopped resetting
        // `justRespondedEventId` to null, THIS second confirmation (an edited,
        // re-submitted reply) would be a silent no-op instead of celebrating
        // again — `justResponded` would already be stuck `true` with nothing
        // left to transition from `false`. Editing a reply means REOPENING the
        // sheet, since the first one closed itself above.
        fireEvent.click(respond);
        await vi.advanceTimersByTimeAsync(0);
        confirmAndClose();
        fill = respond.querySelector("span[aria-hidden='true']") as HTMLElement;
        expect(fill.className).toContain("scale-x-100");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
