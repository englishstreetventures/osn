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
    capturedProps.value = null;
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("auto-claims from a ?code= deep-link, shows the preview banner, and disables RSVP", async () => {
    const previewClaim: ClaimResult = { ...claim, preview: true };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(previewClaim), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState(null, "", "/?code=HOST-ABCDEF0123456789ABCDEF01");

    const { getByText, getByRole } = render(() => <InvitePage apiUrl="https://api.test" />);

    // The events view renders without the guest typing anything.
    await waitFor(() => expect(getByText(/Preview mode/i)).toBeTruthy(), { timeout: 2000 });

    // The claim POST carried the host code from the URL.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      publicId: "HOST-ABCDEF0123456789ABCDEF01",
    });

    // RSVP is disabled in preview mode.
    const respond = getByRole("button", { name: /Respond/i }) as HTMLButtonElement;
    expect(respond.disabled).toBe(true);

    // S-L1: the host code is stripped from the URL after the one-time claim.
    expect(window.location.search).not.toContain("code");
  });

  it("applies the validated details-section theme to the events section", async () => {
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
          hero: { accentColor: null, surfaceColor: null },
          story: { accentColor: null, surfaceColor: null },
          // Only the details section is themed — proves the binding uses the
          // "details" key, not a copy-pasted "hero".
          details: { accentColor: "#abcdef", surfaceColor: "oklch(30% 0.02 150)" },
        }}
      />
    ));

    await waitFor(() => expect(getByText("Your Events")).toBeTruthy(), { timeout: 2000 });

    const section = getByText("Your Events").closest("section") as HTMLElement;
    expect(section.style.getPropertyValue("--invite-accent")).toBe("#abcdef");
    expect(section.style.getPropertyValue("--invite-surface")).toBe("oklch(30% 0.02 150)");
  });

  it("ignores a malicious details colour (never reaches the events-section DOM)", async () => {
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
          hero: { accentColor: null, surfaceColor: null },
          story: { accentColor: null, surfaceColor: null },
          details: { accentColor: "red;background:url(https://evil.example)", surfaceColor: null },
        }}
      />
    ));

    await waitFor(() => expect(getByText("Your Events")).toBeTruthy(), { timeout: 2000 });
    const section = getByText("Your Events").closest("section") as HTMLElement;
    expect(section.style.getPropertyValue("--invite-accent")).toBe("");
  });

  it("revalidates the details theme at runtime, overriding the stale build-time prop", async () => {
    // The build-time prop carries an OLD accent; the live /api/invite/:slug
    // response carries the organiser's NEW accent. With a slug present, the
    // on-mount revalidation must win — this is the live-customisation fix: a
    // theme change reaches guests without a static rebuild.
    const liveInvite = {
      hero: { title: null, subtitle: null, imageUrl: null },
      story: { eyebrow: null, heading: null, body: null, imageUrl: null },
      theme: {
        headingFont: null,
        bodyFont: null,
        hero: { accentColor: null, surfaceColor: null },
        story: { accentColor: null, surfaceColor: null },
        details: { accentColor: "#00ff00", surfaceColor: null },
      },
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

    const { getByText } = render(() => (
      <InvitePage
        apiUrl="https://api.test"
        slug="cire-wedding"
        theme={{
          headingFont: null,
          bodyFont: null,
          hero: { accentColor: null, surfaceColor: null },
          story: { accentColor: null, surfaceColor: null },
          // Stale build-time accent — must be overridden by the live fetch.
          details: { accentColor: "#abcdef", surfaceColor: null },
        }}
      />
    ));

    await waitFor(() => expect(getByText("Your Events")).toBeTruthy(), { timeout: 2000 });
    const section = getByText("Your Events").closest("section") as HTMLElement;
    await waitFor(() => expect(section.style.getPropertyValue("--invite-accent")).toBe("#00ff00"));
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
        theme={{
          headingFont: null,
          bodyFont: null,
          hero: { accentColor: null, surfaceColor: null },
          story: { accentColor: null, surfaceColor: null },
          details: { accentColor: "#abcdef", surfaceColor: null },
        }}
      />
    ));

    await waitFor(() => expect(getByText("Your Events")).toBeTruthy(), { timeout: 2000 });
    const section = getByText("Your Events").closest("section") as HTMLElement;
    // The failed revalidation must leave the build-time accent untouched.
    expect(section.style.getPropertyValue("--invite-accent")).toBe("#abcdef");
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
