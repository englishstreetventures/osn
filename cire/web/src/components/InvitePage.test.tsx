import { derivePalette, PALETTE_PRESETS } from "@cire/theme";
import { render, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, vi, afterEach } from "vitest";

import InvitePage from "./InvitePage";
import type { ClaimResult, RsvpSummary } from "./types";

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

vi.mock("./UnlockReveal.motion", () => ({
  unlockRevealSequence: vi.fn(() => Promise.resolve()),
}));

const capturedProps: { value: Record<string, unknown> | null } = { value: null };

vi.mock("./RsvpModal", () => ({
  RsvpModal: (props: Record<string, unknown>) => {
    capturedProps.value = props;
    return <div data-testid="rsvp-modal-stub" />;
  },
}));

// Capture-stub DetailsModal too, so the themeVars wiring to BOTH modals is
// asserted — the two <Show> blocks are edited independently, and a copy-paste
// slip on one would otherwise pass every test.
const detailsModalProps: { value: Record<string, unknown> | null } = { value: null };

vi.mock("./DetailsModal", () => ({
  DetailsModal: (props: Record<string, unknown>) => {
    detailsModalProps.value = props;
    return <div data-testid="details-modal-stub" />;
  },
}));

// The PulseAccountLink island pulls in @osn/client + @osn/ui (real auth +
// passkey deps). Stub it to a marker so InvitePage's tests assert only the
// mount wiring (post-claim, non-preview) without exercising the OSN stack — the
// component's own behaviour is covered in PulseAccountLink.test.tsx.
vi.mock("./PulseAccountLink", () => ({
  PulseAccountLink: () => <div data-testid="pulse-account-link-stub" />,
}));

vi.mock("@osn/client/solid", () => ({
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
  ],
  rsvps: [{ guestId: "guest-1", eventId: "event-1", status: "attending", dietary: "Vegetarian" }],
};

describe("InvitePage", () => {
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
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText, getByRole, getByTestId } = render(() => (
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

    // RSVP is NO LONGER disabled in preview — the host can try it.
    const respond = getByRole("button", { name: /Respond/i }) as HTMLButtonElement;
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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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

    await waitFor(() => expect(getByRole("button", { name: /View Event/i })).toBeTruthy(), {
      timeout: 2000,
    });
    fireEvent.click(getByRole("button", { name: /View Event/i }));
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
    vi.stubGlobal("fetch", fetchMock);

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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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

    // Absent before claim.
    expect(queryByTestId("pulse-account-link-stub")).toBeNull();

    fireEvent.input(getByPlaceholderText(/PATEL-JOY/), { target: { value: "SHARMA-JOY-RK97" } });
    fireEvent.click(getByText("Open Invitation"));

    // Present once claimed (this claim is not a preview).
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
    // A host preview is not a guest seat — the affordance must not mount.
    expect(queryByTestId("pulse-account-link-stub")).toBeNull();
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
});
