import { derivePalette, PALETTE_PRESETS } from "@cire/theme";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";

import { noteClaimed } from "../../components/claim-session";
import { TOTAL_DURATION_MS } from "../../components/rsvp-responded";
import type { ClaimResult, RsvpSummary } from "../../components/types";
import { noSession, withSession } from "../../test-support/claim-fetch";
import InvitePage from "./InvitePage";
import type { RevealHooks } from "./UnlockReveal.motion";

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

// Capture-stub DetailsModal too, so the themeVars wiring to BOTH modals is
// asserted — the two <Show> blocks are edited independently, and a copy-paste
// slip on one would otherwise pass every test.
const detailsModalProps: { value: Record<string, unknown> | null } = { value: null };

vi.mock("../../components/DetailsModal", () => ({
  DetailsModal: (props: Record<string, unknown>) => {
    detailsModalProps.value = props;
    return <div data-testid="details-modal-stub" />;
  },
}));

// Stub the PulseAccountLink island to a marker so InvitePage's tests assert
// only the mount wiring (post-claim, non-preview) without probing the account
// API — the component's own behaviour is covered in PulseAccountLink.test.tsx.
vi.mock("../../components/PulseAccountLink", () => ({
  PulseAccountLink: () => <div data-testid="pulse-account-link-stub" />,
}));

vi.mock("@shared/rp-auth/solid", () => ({
  AuthProvider: (props: { children: unknown }) => props.children,
}));

// Rendered as a marker, not `() => null`: WHERE the Toaster is mounted is the
// contract under test (see "save-confirmation plumbing" below), and a null
// render makes that unassertable.
vi.mock("@shared/toast", () => ({
  Toaster: () => <div data-testid="toaster-stub" />,
  toast: { success: vi.fn(), error: vi.fn() },
}));

const claim: ClaimResult = {
  publicId: "SHARMA-JOY-RK97",
  familyName: "Sharma",
  members: [
    {
      guestId: "guest-1",
      firstName: "Priya",
      lastName: "Sharma",
      nickname: null,
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
  ],
  rsvps: [{ guestId: "guest-1", eventId: "event-1", status: "attending", dietary: "Vegetarian" }],
};

// A second, UNANSWERED event alongside `claim`'s already-answered Mehndi — so
// the recorded-reply wiring tests below can tell "permanent tick from data"
// (Mehndi) apart from "nothing yet, then a live confirmation" (Reception).
const claimTwoEvents: ClaimResult = {
  ...claim,
  members: [{ ...claim.members[0]!, eventIds: ["event-1", "event-2"] }],
  events: [
    ...claim.events,
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

describe("InvitePage", () => {
  // `EventCard` reaches the tree through a `lazy()` import now, so the first
  // test to render a card pays that chunk's transform inside its own assertion
  // window. The default `findBy*`/`waitFor` budget is 1s, and a loaded CI
  // runner blows through it on a cold module graph — the events container
  // renders empty with Suspense still on its fallback. Warm the module once,
  // up front, where the hook's own budget covers it; each test then waits only
  // the tick Solid needs to swap the fallback for the card.
  beforeAll(async () => {
    await import("../../components/EventCard");
  });

  afterEach(() => {
    cleanup();
    // The palette is applied to the document root, which outlives a render —
    // clear it so one test's scheme can't leak into the next one's assertions.
    document.documentElement.removeAttribute("style");
    capturedProps.value = null;
    detailsModalProps.value = null;
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("auto-claims from a ?code= deep-link, shows the preview banner, and keeps RSVP interactive as a no-op", async () => {
    const previewClaim: ClaimResult = { ...claim, preview: true };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(previewClaim), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", noSession(fetchMock));
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText, findByRole, getByTestId } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    // The events view renders without the guest typing anything.
    await waitFor(() => expect(getByText(/Preview mode/i)).toBeTruthy(), { timeout: 2000 });

    // The claim POST carried the host code from the URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      publicId: "HOST-ABCDEF0123456789ABCDEF01",
    });

    // RSVP is NO LONGER disabled in preview — the host can try it. `findBy*`,
    // not `getBy*`: the cards now arrive through a lazy import, so the button
    // exists a microtask after the preview banner rather than in the same tick.
    const respond = (await findByRole(
      "button",
      { name: /Respond/i },
      { timeout: 2000 },
    )) as HTMLButtonElement;
    expect(respond.disabled).toBe(false);

    // Opening it mounts the RSVP modal in preview mode, so submit is a no-op.
    fireEvent.click(respond);
    await waitFor(() => expect(getByTestId("rsvp-modal-stub")).toBeTruthy());
    expect(capturedProps.value?.preview).toBe(true);

    // No further network call beyond the original claim — the preview never POSTs.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // S-L1: the host code is stripped from the URL after the one-time claim.
    expect(window.location.search).not.toContain("code");
  });

  it("applies the section tone to the events section and the palette to the root", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...claim, preview: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", noSession(fetchMock));
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        theme={{
          headingFont: null,
          bodyFont: null,
          palette: { gilt: "#abcdef", card: "oklch(30% 0.02 150)" },
          // Only the details tone is set — proves the binding uses the
          // "details" key, not a copy-pasted "hero".
          tones: { details: "card" },
        }}
      />
    ));

    await waitFor(() => expect(getByText("Your Events")).toBeTruthy(), { timeout: 2000 });

    const section = getByText("Your Events").closest("section") as HTMLElement;
    // The section chooses its surface…
    expect(section.style.getPropertyValue("--invite-section-bg")).toBe("var(--color-surface)");
    expect(section.style.getPropertyValue("background-color")).toBe("var(--invite-section-bg)");
    // …and the colours come from the root palette, so the EventCard utility
    // classes (buttons, date lines) follow the organiser's scheme too.
    const root = document.documentElement.style;
    await waitFor(() =>
      expect(root.getPropertyValue("--color-gold")).toBe(
        derivePalette({ gilt: "#abcdef", card: "oklch(30% 0.02 150)" })["--color-gold"],
      ),
    );
    expect(root.getPropertyValue("--color-surface")).toBe(
      derivePalette({ gilt: "#abcdef", card: "oklch(30% 0.02 150)" })["--color-surface"],
    );
  });

  it("renders the organiser's events-section header copy, and the defaults when unset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...claim, preview: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", noSession(fetchMock));
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText, queryByText } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        details={{ eyebrow: "Join The Celebration", heading: "The Festivities" }}
      />
    ));

    await waitFor(() => expect(getByText("The Festivities")).toBeTruthy(), { timeout: 2000 });
    expect(getByText("Join The Celebration")).toBeTruthy();
    // The built-in defaults are fully replaced, not rendered alongside.
    expect(queryByText("Your Events")).toBeNull();
    expect(queryByText("Celebrate With Us")).toBeNull();
  });

  it("threads the details theme into the RSVP modal so the sheet follows the section", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...claim, preview: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", noSession(fetchMock));
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByRole, getByTestId } = render(() => (
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

    await waitFor(() => expect(getByRole("button", { name: /Respond/i })).toBeTruthy(), {
      timeout: 2000,
    });
    fireEvent.click(getByRole("button", { name: /Respond/i }));
    await waitFor(() => expect(getByTestId("rsvp-modal-stub")).toBeTruthy());

    const themeVars = capturedProps.value?.themeVars as Record<string, string>;
    expect(themeVars["--invite-section-bg"]).toBe("var(--color-surface-raised)");
  });

  it("threads the details theme into the event-details modal (both modal consumers)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...claim, preview: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", noSession(fetchMock));
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByRole, getByTestId } = render(() => (
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

    await waitFor(() => expect(getByRole("button", { name: /Event Details/i })).toBeTruthy(), {
      timeout: 2000,
    });
    fireEvent.click(getByRole("button", { name: /Event Details/i }));
    await waitFor(() => expect(getByTestId("details-modal-stub")).toBeTruthy());

    const themeVars = detailsModalProps.value?.themeVars as Record<string, string>;
    expect(themeVars["--invite-section-bg"]).toBe("var(--color-surface-raised)");
  });

  it("applies the welcome tone to the code entry + welcome banner", () => {
    const { getByText } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        theme={{
          headingFont: null,
          bodyFont: null,
          palette: { gilt: "#7a9e7e", card: "oklch(30% 0.02 150)" },
          // Only the welcome tone is set — proves the binding uses the
          // "welcome" key, not a copy-pasted sibling section.
          tones: { welcome: "card" },
        }}
      />
    ));

    const section = getByText("Enter Your Code").closest("section") as HTMLElement;
    expect(section.style.getPropertyValue("--invite-section-bg")).toBe("var(--color-surface)");
    expect(section.style.getPropertyValue("background-color")).toBe("var(--invite-section-bg)");
    // The section's gold utilities (labels, focus border, button hover fill)
    // resolve from the root palette, so hover/focus states follow too.
    expect(document.documentElement.style.getPropertyValue("--color-gold")).toBe(
      derivePalette({ gilt: "#7a9e7e", card: "oklch(30% 0.02 150)" })["--color-gold"],
    );
  });

  it("ignores a malicious welcome colour from the live refetch (never reaches the code-entry DOM)", async () => {
    // Counterpart of the malicious-details test for the no-store revalidation
    // path: the render-time seed validation must run on live updates too. The
    // valid card seed proves the refetch landed; the malicious gilt seed must
    // fall back to the default rather than reach the DOM.
    const liveInvite = {
      theme: {
        headingFont: null,
        bodyFont: null,
        palette: {
          gilt: "red;background:url(https://evil.example)",
          card: "oklch(30% 0.02 150)",
        },
        tones: { welcome: "card" },
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(liveInvite), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", noSession(fetchMock));

    const { getByText } = render(() => (
      <InvitePage apiUrl="https://api.test" slug="cire-wedding" />
    ));

    getByText("Enter Your Code");
    const root = document.documentElement.style;
    await waitFor(() =>
      expect(root.getPropertyValue("--color-surface")).toBe(
        derivePalette({ card: "oklch(30% 0.02 150)" })["--color-surface"],
      ),
    );
    // The malicious seed is dropped, so gold stays the built-in default.
    expect(root.getPropertyValue("--color-gold")).toBe(
      derivePalette(PALETTE_PRESETS.evergreen)["--color-gold"],
    );
  });

  it("renders the code entry untouched when the theme carries no tones", () => {
    const { getByText } = render(() => (
      <InvitePage apiUrl="https://api.test" theme={{ headingFont: null, bodyFont: null }} />
    ));

    const section = getByText("Enter Your Code").closest("section") as HTMLElement;
    // No tone ⇒ the section sits on the page ground, as it always has.
    expect(section.style.getPropertyValue("--invite-section-bg")).toBe("var(--color-bg)");
  });

  it("ignores a malicious seed (never reaches the rendered CSS)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...claim, preview: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", noSession(fetchMock));
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        theme={{
          headingFont: null,
          bodyFont: null,
          palette: { gilt: "red;background:url(https://evil.example)" },
        }}
      />
    ));

    await waitFor(() => expect(getByText("Your Events")).toBeTruthy(), { timeout: 2000 });
    // The seed is rejected at the render boundary, so gold stays the built-in.
    expect(document.documentElement.style.getPropertyValue("--color-gold")).toBe(
      derivePalette(PALETTE_PRESETS.evergreen)["--color-gold"],
    );
  });

  it("revalidates the details theme + copy at runtime, overriding the stale build-time props", async () => {
    // The build-time props carry an OLD accent and copy; the live
    // /api/invite/:slug response carries the organiser's NEW values. With a
    // slug present, the on-mount revalidation must win — this is the
    // live-customisation fix: a theme OR copy change reaches guests without a
    // static rebuild.
    const liveInvite = {
      hero: { title: null, subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      details: { eyebrow: "Join The Celebration", heading: "The Festivities" },
      welcome: { message: null },
      theme: { headingFont: null, bodyFont: null, palette: { gilt: "#00ff00" } },
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // The invite-customisation revalidation.
      if (url.includes("/api/invite/")) {
        return Promise.resolve(
          new Response(JSON.stringify(liveInvite), {
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
        theme={{
          headingFont: null,
          bodyFont: null,
          // Stale build-time seed — must be overridden by the live fetch.
          palette: { gilt: "#abcdef" },
        }}
        // Stale build-time copy — must be overridden by the live fetch.
        details={{ eyebrow: "Old Eyebrow", heading: "Old Heading" }}
      />
    ));

    // The live copy wins over both the build-time prop and the defaults.
    await waitFor(() => expect(getByText("The Festivities")).toBeTruthy(), { timeout: 2000 });
    expect(getByText("Join The Celebration")).toBeTruthy();
    expect(queryByText("Old Heading")).toBeNull();
    expect(queryByText("Your Events")).toBeNull();

    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--color-gold")).toBe(
        derivePalette({ gilt: "#00ff00" })["--color-gold"],
      ),
    );
  });

  it("keeps the build-time theme when the runtime revalidation fails (non-OK)", async () => {
    // A transient API blip must NOT wipe the already-painted SSR'd theme. With a
    // slug present, a non-OK /api/invite/:slug response keeps the build-time prop.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/invite/")) {
        return Promise.resolve(new Response("nope", { status: 500 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ...claim, preview: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", noSession(fetchMock));
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        slug="cire-wedding"
        theme={{ headingFont: null, bodyFont: null, palette: { gilt: "#abcdef" } }}
        details={{ eyebrow: "SSR Eyebrow", heading: "SSR Heading" }}
      />
    ));

    await waitFor(() => expect(getByText("SSR Heading")).toBeTruthy(), { timeout: 2000 });
    // The failed revalidation must leave the build-time scheme AND copy untouched.
    expect(document.documentElement.style.getPropertyValue("--color-gold")).toBe(
      derivePalette({ gilt: "#abcdef" })["--color-gold"],
    );
    expect(getByText("SSR Eyebrow")).toBeTruthy();
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

    // Absent before claim.
    expect(queryByTestId("pulse-account-link-stub")).toBeNull();

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    // Present once claimed (this claim is not a preview).
    await waitFor(() => expect(queryByTestId("pulse-account-link-stub")).toBeTruthy(), {
      timeout: 2000,
    });
  });

  it("'Sign out' returns to the code form and clears the claimed invite", async () => {
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

    await waitFor(() => expect(getByText(/Dear Priya/)).toBeTruthy(), { timeout: 2000 });

    fireEvent.click(getByText(/Sign out/));

    // The code form is back, the previously claimed household's events are
    // gone, and the field the household typed into is blank again.
    await waitFor(() => expect(getByText("Enter Your Code")).toBeTruthy());
    expect(queryByText(/Dear Priya/)).toBeNull();
    expect(queryByText("Mehndi")).toBeNull();

    // S-M1: the returned form must be USABLE, not merely present. `submitCode`
    // clears `loading` on every failure branch but not on success, so before
    // this was fixed the form came back with a disabled input and a submit
    // button stuck reading "Checking…" — the escape hatch led nowhere. The
    // original version of this test asserted only that the field was blank,
    // which is exactly why it passed against a dead form.
    const input = getByPlaceholderText(/PATEL-JOY/) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.disabled).toBe(false);
    const submit = getByText("Open Invitation") as HTMLButtonElement;
    // Disabled right now only because the field is empty — the normal
    // pre-claim state, not the stuck one. Typing must re-enable it; before the
    // fix the label read "Checking…" and no amount of typing helped.
    expect(submit.textContent).toBe("Open Invitation");
    expect(submit.disabled).toBe(true);
    fireEvent.input(input, { target: { value: "OKAFOR-LILY-AB12CD" } });
    expect(submit.disabled).toBe(false);

    // C-L1: focus lands on the code input rather than falling to <body>, so a
    // keyboard or screen-reader user is told the form is back and is already
    // on the control they need.
    expect(document.activeElement).toBe(input);
  });

  it("signs out for real: POSTs /api/claim/signout and drops the restore hint", async () => {
    // The contract that makes this a sign-out rather than a local reset. The
    // `cire_session` cookie is HttpOnly and host-scoped to the API origin, so
    // the browser cannot clear it — only this call can. Without it a guest on
    // a shared device who "signs out" leaves a live credential behind, and the
    // on-mount restore silently re-opens the household on the next visit.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(claim), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", noSession(fetchMock));
    // Stand in for the hint a real claim leaves behind.
    noteClaimed();
    expect(document.cookie).toContain("cire_claimed=");

    const { getByText, getByPlaceholderText } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));
    await waitFor(() => expect(getByText(/Dear Priya/)).toBeTruthy(), { timeout: 2000 });

    fireEvent.click(getByText(/Sign out/));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/claim/signout"));
      expect(call, "no sign-out request was sent").toBeTruthy();
      // `credentials: "include"` is load-bearing: the issuer is a different
      // origin from the guest site, and a cross-origin fetch on the default
      // `same-origin` mode sends no cookie — the server would have nothing to
      // revoke and would answer 204 anyway, so this fails silently without it.
      expect((call![1] as RequestInit).method).toBe("POST");
      expect((call![1] as RequestInit).credentials).toBe("include");
    });

    // The local restore hint is gone, so the next visit shows the code form
    // instead of spending a request re-opening the household.
    expect(document.cookie).not.toContain("cire_claimed=1");
  });

  it("can actually claim a second, different household after the reset", async () => {
    // The end-to-end proof that the escape hatch works. A form that merely
    // *looks* restored is not the feature — this drives a real second claim
    // and asserts the new household's invite opens.
    const otherClaim: ClaimResult = {
      ...claim,
      publicId: "OKAFOR-LILY-AB12CD",
      familyName: "Okafor",
      members: [
        {
          guestId: "guest-9",
          firstName: "Chidi",
          lastName: "Okafor",
          nickname: null,
          eventIds: ["event-1"],
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(claim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValue(
        new Response(JSON.stringify(otherClaim), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", noSession(fetchMock));

    const { getByText, getByPlaceholderText } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));
    await waitFor(() => expect(getByText(/Dear Priya/)).toBeTruthy(), { timeout: 2000 });

    fireEvent.click(getByText(/Sign out/));
    await waitFor(() => expect(getByText("Enter Your Code")).toBeTruthy());

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "OKAFOR-LILY-AB12CD" } });
    fireEvent.click(getByText("Open Invitation"));

    await waitFor(() => expect(getByText(/Dear Chidi/)).toBeTruthy(), { timeout: 2000 });
    // The second POST carried the second code — not a stale or blank one.
    const claimPosts = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/claim"));
    expect(claimPosts).toHaveLength(2);
    expect(JSON.parse((claimPosts[1]![1] as RequestInit).body as string)).toEqual({
      publicId: "OKAFOR-LILY-AB12CD",
    });
  });

  it("P-W2: a reset during the unlock choreography is not undone by its trailing setRevealed", async () => {
    // `onFormHidden` makes the button visible at the end of step 1, then the
    // sequence runs on for ~200ms. A click in that gap used to be clobbered by
    // handleClaimed's unconditional `finally { setRevealed(true) }`, leaving the
    // form hidden with claimResult null — the welcome banner rendering from
    // nothing, unrecoverable without a reload.
    const { unlockRevealSequence } = await import("./UnlockReveal.motion");
    let releaseSequence: (() => void) | undefined;
    vi.mocked(unlockRevealSequence).mockImplementationOnce(
      async (_form: unknown, _welcome: unknown, _events: unknown, hooks?: unknown) => {
        (hooks as { onFormHidden?: () => void } | undefined)?.onFormHidden?.();
        // Stand in for the ~200ms tail the real sequence still has to run.
        await new Promise<void>((resolve) => (releaseSequence = resolve));
      },
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

    const { getByText, getByPlaceholderText, queryByText } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    // Wait for the sequence to have STARTED and parked — i.e. `onFormHidden`
    // has fired and we are inside the window the guard protects. Deliberately
    // not `waitFor(getByText(/Sign out/))`: `getByText` also
    // matches `display: none` nodes, so that resolves instantly, before the
    // claim has even landed, and the click would test nothing.
    await waitFor(() => expect(releaseSequence).toBeDefined(), { timeout: 2000 });
    expect(getByText(/Dear Priya/)).toBeTruthy();
    fireEvent.click(getByText(/Sign out/));

    // Now let the choreography finish — its trailing write must not resurrect
    // the welcome half over a null claim.
    releaseSequence?.();
    await waitFor(() => expect(getByText("Enter Your Code")).toBeTruthy());
    expect(queryByText(/Dear Priya/)).toBeNull();
    expect((getByPlaceholderText(/PATEL-JOY/) as HTMLInputElement).disabled).toBe(false);
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
    // A host preview is not a guest seat — the affordance must not mount.
    expect(queryByTestId("pulse-account-link-stub")).toBeNull();
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

    const { getByText, getByPlaceholderText } = render(() => (
      <InvitePage apiUrl="https://api.test" />
    ));

    // Drive the claim flow
    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), {
      target: { value: "SHARMA-JOY-RK97" },
    });
    fireEvent.click(getByText("Open Invitation"));

    // Wait for the event card "Respond" button
    await waitFor(() => expect(getByText(/Respond/i)).toBeTruthy(), { timeout: 2000 });
    fireEvent.click(getByText(/Respond/i));

    await waitFor(() => expect(capturedProps.value).not.toBeNull());

    const props = capturedProps.value!;
    expect(props.apiUrl).toBe("https://api.test");
    expect(props.members).toEqual(claim.members);
    expect(props.existingRsvps).toEqual(claim.rsvps);
    expect(typeof props.onSubmitted).toBe("function");
    expect(typeof props.onClose).toBe("function");

    // onSubmitted should merge into the claimResult — invoke it and confirm
    // a follow-up open uses the new rsvps as existingRsvps
    const updated: RsvpSummary[] = [
      { guestId: "guest-1", eventId: "event-1", status: "declined", dietary: "" },
    ];
    (props.onSubmitted as (r: RsvpSummary[]) => void)(updated);

    // Re-open the modal (the previous one is still in the tree per the stub but
    // we re-open conceptually via state — fire Respond again is a no-op since
    // it's already open. Instead close + reopen by simulating onClose then click.)
    (props.onClose as () => void)();
    capturedProps.value = null;
    await waitFor(() => expect(getByText(/Respond/i)).toBeTruthy());
    fireEvent.click(getByText(/Respond/i));

    await waitFor(() => expect(capturedProps.value).not.toBeNull());
    expect(capturedProps.value!.existingRsvps).toEqual(updated);
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

  describe("RSVP deadline", () => {
    /** Claim through the ?code= deep-link with a given deadline attached. */
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
      const { getByText, getByRole } = await claimWithDeadline({
        date: "2999-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2999-09-01T13:59:59.999Z",
        closed: false,
      });

      expect(getByText("Kindly respond by Sunday 1 September 2999.")).toBeTruthy();
      expect((getByRole("button", { name: "Respond" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("sits directly on top of the event cards, not in the centred header", async () => {
      await claimWithDeadline({
        date: "2999-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2999-09-01T13:59:59.999Z",
        closed: false,
      });

      const notice = document.getElementById("rsvp-deadline-notice")!;
      // Its next sibling IS the card list — nothing may come between them, so
      // the line always reads as the list's label rather than a third line of
      // section header.
      expect(notice.nextElementSibling?.querySelector("[data-event-card]")).not.toBeNull();
      // Centred on the section axis — it speaks for the whole list, so it must
      // not pick out the first card by running along the cards' left edge.
      expect(notice.className).toContain("text-center");
      expect(notice.className).not.toContain("text-left");
    });

    it("paints the open notice in the prose gold, not the metal (WCAG 1.4.3)", async () => {
      await claimWithDeadline({
        date: "2999-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2999-09-01T13:59:59.999Z",
        closed: false,
      });

      // At 0.85rem this is normal-size text, so WCAG AA asks 4.5:1. `text-gold`
      // is the METAL — rules, borders, buttons — and `derivePalette` only holds
      // it to the 3:1 UI floor, which is how a taupe-on-cream scheme shipped
      // this line at 3.35:1 in production. `--color-gold-ink` is the same hue
      // walked to 4.5:1 against all three section surfaces.
      const classes = document.getElementById("rsvp-deadline-notice")!.className.split(/\s+/);
      expect(classes).toContain("text-gold-ink");
      expect(classes).not.toContain("text-gold");
    });

    it("locks every card and states the date once the deadline has passed", async () => {
      const { getByText, getByRole } = await claimWithDeadline({
        date: "2020-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2020-09-01T13:59:59.999Z",
        closed: true,
      });

      expect(getByText("RSVPs closed on Tuesday 1 September 2020.")).toBeTruthy();
      const respond = getByRole("button", { name: "RSVPs closed" }) as HTMLButtonElement;
      // `aria-disabled`, not the native attribute — see C-M2 in EventCard. The
      // button stays focusable and points at the notice, which is where the
      // date actually is.
      expect(respond.getAttribute("aria-disabled")).toBe("true");
      expect(respond.getAttribute("aria-describedby")).toBe("rsvp-deadline-notice");
      expect(document.getElementById("rsvp-deadline-notice")?.textContent).toContain(
        "RSVPs closed on Tuesday 1 September 2020.",
      );
    });

    it("renders no notice and no lock when the wedding has no deadline", async () => {
      // Also the shape a mid-deploy payload from an older API has.
      const { queryByText, getByRole } = await claimWithDeadline(null);

      expect(queryByText(/Kindly respond by/)).toBeNull();
      expect(queryByText(/RSVPs closed/)).toBeNull();
      expect((getByRole("button", { name: "Respond" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("threads the closed state and the deadline day into the RSVP sheet", async () => {
      // The sheet is normally unreachable once closed (Respond is disabled), but
      // the deadline can pass with it already open — so the props still have to
      // be wired, and a stale sheet has to say when the door shut.
      const { getByText } = await claimWithDeadline({
        date: "2999-09-01",
        timezone: "Australia/Sydney",
        closesAt: "2999-09-01T13:59:59.999Z",
        closed: false,
      });

      fireEvent.click(getByText("Respond"));
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
      const restore = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
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
      const restore = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
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

  // The swap between the code form and the welcome banner is driven by ONE
  // signal (`revealed`), read by LoginSection's `display` bindings. The unlock
  // sequence reports the moment via `onFormHidden` and never writes `display`
  // itself, because Solid diffs a style binding against the last value it wrote
  // — an imperative write from the animation would leave Solid believing the
  // form is displayed and silently skip every later attempt to show it again.
  describe("form/welcome swap", () => {
    async function claimWith(
      sequence: (
        loginForm: HTMLElement,
        welcomeEl: HTMLElement,
        eventsSection: HTMLElement,
        hooks?: RevealHooks,
      ) => Promise<void> | void,
    ) {
      const { unlockRevealSequence } = await import("./UnlockReveal.motion");
      vi.mocked(unlockRevealSequence).mockImplementation(async (...args) => {
        await sequence(...args);
      });
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
      const { getByText } = await claimWith(async (_f, _w, _e, hooks) => {
        hooks?.onFormHidden?.();
      });
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
    });

    it("keeps the form up until that moment — the fade needs it on screen", async () => {
      // The old arrangement derived `display` from `claimResult`, so Solid hid
      // the form the instant the claim resolved — a beat BEFORE the sequence
      // ran, leaving step 1 animating an already-invisible element.
      let release: (() => void) | undefined;
      const { getByText } = await claimWith(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      await waitFor(() => expect(release).toBeDefined());
      expect(formPanel({ getByText }).style.display).toBe("");
      release!();
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
    });

    it("hides the form when REPORTED, not merely when the sequence ends", async () => {
      // T-U3: the mirror of the test above. Holding the sequence open AFTER it
      // reports is the only way to tell "hidden on report" from "hidden by the
      // `finally`" — once the promise settles the `finally` masks the
      // difference, which is why dropping the `onFormHidden` wiring altogether
      // was otherwise invisible to every test. Without the hook the form sits
      // in the layout through the whole sequence, so the welcome banner's
      // fade-in plays underneath a form still occupying its space.
      let release: (() => void) | undefined;
      const { getByText } = await claimWith((_f, _w, _e, hooks) => {
        hooks?.onFormHidden?.();
        return new Promise<void>((resolve) => (release = resolve));
      });
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
      expect(release).toBeDefined();
      release!();
    });

    it("still completes the swap when the sequence throws", async () => {
      // A motion chunk that fails to load (offline mid-session, stale deploy)
      // must never leave the code form sitting on top of a claimed invite —
      // that is what the `finally` in handleClaimed guarantees.
      const { getByText, queryByText } = await claimWith(() => {
        throw new Error("chunk failed");
      });
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
      // …and the welcome banner is the thing standing in its place. The fixture
      // is a single-guest code, so that is the individual greeting.
      expect(queryByText(/Dear Priya/)).toBeTruthy();
    });

    it("still completes the swap when the sequence never reports", async () => {
      // Resolving without ever calling `onFormHidden` — same guarantee.
      const { getByText } = await claimWith(() => Promise.resolve());
      await waitFor(() => expect(formPanel({ getByText }).style.display).toBe("none"));
    });
  });

  describe("recorded-reply confirmation wiring", () => {
    // Neither `EventCard` nor `RsvpModal` alone can catch a bug in the glue
    // between them — each is tested in isolation with directly-injected props.
    // These exercise the real (unmocked) `EventCard` behind the mocked
    // `RsvpModal` stub, the same way the production page composes them.
    beforeEach(() => noteClaimed());
    afterEach(() => {
      document.cookie = "cire_claimed=; Path=/; Max-Age=0";
    });

    it("shows the permanent tick from data alone, with no RsvpModal ever opened", async () => {
      vi.stubGlobal(
        "fetch",
        withSession(
          claimTwoEvents,
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
            claimTwoEvents,
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
          ...claimTwoEvents.rsvps,
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

        // Asserted on the tick's DRAW, not on the fill. `confirmed` is monotone
        // — already true from the first celebration — so `scale-x-100` holds
        // here whatever happens, including if the reset regressed. `drawing` is
        // the only observable that separates "celebrated again" from "still
        // marked from last time". Re-query the path: the `<Show when={drawing()}>`
        // swaps the node rather than mutating it.
        const redrawn = respond.querySelector("svg path") as SVGPathElement;
        expect(redrawn.getAttribute("stroke-dasharray")).toBe("20");
        expect(redrawn.getAttribute("class")).toContain("animate-tick-draw");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("save-confirmation plumbing", () => {
    it("mounts the Toaster at the page root, outside the events section, and in preview too", async () => {
      // Two bugs in one placement, both fixed by moving it out here:
      //
      //  - it used to sit inside `<Show when={!preview}>`, so a host previewing
      //    the invite had NO toaster mounted and every `toast.success` was
      //    dropped on the floor;
      //  - it sat inside the events <section>, which Motion One's reveal leaves
      //    with an inline `transform`. That makes the section the containing
      //    block AND a stacking context for the `position: fixed` toaster inside
      //    it, so the toast was positioned against the section instead of the
      //    viewport and painted below the z-100 RSVP sheet it fires underneath.
      //    Measured in `InvitePage.browser.test.tsx`; this pins the structure.
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

      const { container, getByTestId } = render(() => <InvitePage apiUrl="https://api.test" />);
      await waitFor(() => expect(getByTestId("toaster-stub")).toBeTruthy());

      // Present in preview mode at all — the thing that used to be missing.
      const toaster = getByTestId("toaster-stub");
      // And not nested inside the section Motion One transforms.
      expect(toaster.closest("section")).toBeNull();
      expect(container.querySelector("section [data-testid='toaster-stub']")).toBeNull();
    });

    it("holds the Respond mark back until the sheet closes, then puts it up", async () => {
      // The `covered` wiring, exercised through the real EventCard. The reply is
      // recorded (`onSubmitted`) a full dwell before the sheet closes, so a mark
      // driven by the recorded rows alone would appear behind the sheet where no
      // guest can see it.
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...claim, rsvps: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", noSession(fetchMock));
      window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

      const { container } = render(() => <InvitePage apiUrl="https://api.test" />);
      await waitFor(() => expect(container.querySelector("[data-event-card]")).toBeTruthy());

      const respond = respondButtonFor(container, "Mehndi");
      expect(respond.hasAttribute("data-rsvp-confirmed")).toBe(false);

      fireEvent.click(respond);
      await waitFor(() => expect(capturedProps.value).toBeTruthy());

      // Reply recorded, sheet still open: nothing may show yet.
      const recorded: RsvpSummary[] = [
        { guestId: "guest-1", eventId: "event-1", status: "attending", dietary: "" },
      ];
      (capturedProps.value!.onSubmitted as (r: RsvpSummary[]) => void)(recorded);
      expect(respondButtonFor(container, "Mehndi").hasAttribute("data-rsvp-confirmed")).toBe(false);

      // Sheet closes: the mark goes up.
      (capturedProps.value!.onClose as () => void)();
      await waitFor(() =>
        expect(respondButtonFor(container, "Mehndi").getAttribute("data-rsvp-confirmed")).toBe(
          "true",
        ),
      );
    });
  });
});
