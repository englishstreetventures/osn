// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * InviteBuilder lets the organiser rewrite copy, swap images, and set a
 * per-section theme — fonts + accent/surface colours. The OSN auth + api
 * helpers + toasts are stubbed; this asserts the wiring: the loaded
 * customisation seeds the controls, and the single "Save invite" action
 * dirty-checks each half and PUTs only what changed — the text body, the theme
 * body, or both in order (a copy-only save must not bump the theme row's
 * `updatedAt`, which doubles as the guest image-cache version — P-W1).
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

import InviteBuilder from "./InviteBuilder";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMPTY_CUSTOMISATION = {
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    hero: { accentColor: null, surfaceColor: null },
    story: { accentColor: null, surfaceColor: null },
    details: { accentColor: null, surfaceColor: null },
    welcome: { accentColor: null, surfaceColor: null },
  },
};

/** The parsed body of the PUT whose URL ends with `suffix`, or null if never fired. */
function sentBody(suffix: string) {
  const call = authFetchMock.mock.calls.find((c) => String(c[0]).endsWith(suffix));
  return call ? JSON.parse(call[1].body as string) : null;
}

describe("InviteBuilder theme", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("seeds the font selects from the loaded theme", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: { ...EMPTY_CUSTOMISATION.theme, headingFont: "georgia", bodyFont: "system-sans" },
      }),
    );
    render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => {
      const heading = screen.getByLabelText("Heading font") as HTMLSelectElement;
      expect(heading.value).toBe("georgia");
    });
    const body = screen.getByLabelText("Body font") as HTMLSelectElement;
    expect(body.value).toBe("system-sans");
  });

  it("PUTs only the theme body when only theme fields changed (font enum + colours)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => screen.getByText("Save invite"));

    fireEvent.change(screen.getByLabelText("Heading font"), { target: { value: "cormorant" } });
    // Four "Accent colour" swatch triggers (one per section, in guest-page
    // order: hero, story, welcome, events/details); the first is Hero. Open its
    // popover and type a full hex into the labelled "Hex" field.
    const accents = screen.getAllByLabelText("Accent colour");
    fireEvent.click(accents[0]);
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#112233" } });

    fireEvent.click(screen.getByText("Save invite"));

    // Dirty-check: the copy half is untouched, so /text must NOT be PUT — a
    // theme-only save is exactly one write.
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [themeUrl, themeInit] = authFetchMock.mock.calls[1];
    expect(themeUrl).toBe("https://api.test/api/organiser/weddings/wed_1/invite/theme");
    expect(themeInit.method).toBe("PUT");
    expect(sentBody("/text")).toBeNull();

    const sent = sentBody("/theme");
    expect(sent.headingFont).toBe("cormorant");
    expect(sent.heroAccentColor).toBe("#112233");
    // Untouched fonts collapse to null ("default" ⇒ keep the built-in token).
    expect(sent.bodyFont).toBeNull();
    // Hero display sliders ride on the same PUT, defaulting to today's look.
    expect(sent.heroBlur).toBe(28);
    expect(sent.titleBackdropOpacity).toBe(0);
    expect(sent.titleBackdropBlur).toBe(0);
    // The untouched welcome section rides along as null (keep the defaults) —
    // the body is total, so the fields must be present.
    expect(sent.welcomeAccentColor).toBeNull();
    expect(sent.welcomeSurfaceColor).toBeNull();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Invite saved"));
  });

  it("PUTs both halves in order when copy AND theme changed", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // text save
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "Anita & Ben" } });
    fireEvent.change(screen.getByLabelText("Heading font"), { target: { value: "georgia" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(3));
    // Text first, theme second — the documented ordering.
    expect(String(authFetchMock.mock.calls[1][0])).toMatch(/\/invite\/text$/);
    expect(String(authFetchMock.mock.calls[2][0])).toMatch(/\/invite\/theme$/);
    expect(sentBody("/text").heroTitle).toBe("Anita & Ben");
    expect(sentBody("/theme").headingFont).toBe("georgia");
  });

  it("skips the network entirely on a no-op save", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load only

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("No changes to save"));
    // No PUT fired — a gratuitous save must not bump `updatedAt` (it would bust
    // the guest image-transform caches for zero change, P-W1).
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("seeds the welcome section pickers and PUTs the edited welcome accent", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: {
          ...EMPTY_CUSTOMISATION.theme,
          welcome: { accentColor: "#7a9e7e", surfaceColor: null },
        },
      }),
    );
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    // The section fieldset carries its legend AND a live preview card.
    expect(screen.getAllByText("Code Entry & Welcome").length).toBeGreaterThanOrEqual(2);
    screen.getByLabelText("Code Entry & Welcome preview");

    // Welcome is the THIRD section in guest-page order (hero, story, welcome,
    // events) — recolour it and save.
    const accents = screen.getAllByLabelText("Accent colour");
    expect(accents.length).toBe(4);
    fireEvent.click(accents[2]);
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    // Seeded from the loaded theme, not the empty default (case per Kobalte).
    expect(hex.value.toLowerCase()).toBe("#7a9e7e");
    fireEvent.input(hex, { target: { value: "#112233" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    expect(sent.welcomeAccentColor).toBe("#112233");
    // The sibling sections are untouched.
    expect(sent.heroAccentColor).toBeNull();
    expect(sent.detailsAccentColor).toBeNull();
  });

  it("PUTs an edited welcome surface colour (the background signal lane)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    // The THIRD "Background colour" swatch is the welcome section's surface.
    const surfaces = screen.getAllByLabelText("Background colour");
    expect(surfaces.length).toBe(4);
    fireEvent.click(surfaces[2]);
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#223344" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    expect(sent.welcomeSurfaceColor).toBe("#223344");
    // Sibling surface lanes untouched — guards a copy-paste slip in the updater.
    expect(sent.storySurfaceColor).toBeNull();
    expect(sent.detailsSurfaceColor).toBeNull();
    expect(sent.welcomeAccentColor).toBeNull();
  });

  it("seeds the hero display sliders from the loaded customisation", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        heroDisplay: { blur: 12, titleBackdrop: { opacity: 60, blur: 8 } },
      }),
    );
    render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => screen.getByText("Save invite"));
    expect((screen.getByLabelText("Hero image blur") as HTMLInputElement).value).toBe("12");
    expect((screen.getByLabelText("Title backdrop opacity") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("Title backdrop blur") as HTMLInputElement).value).toBe("8");
  });

  it("PUTs the chosen hero display slider values on Save invite", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    fireEvent.input(screen.getByLabelText("Hero image blur"), { target: { value: "5" } });
    fireEvent.input(screen.getByLabelText("Title backdrop opacity"), { target: { value: "80" } });
    fireEvent.input(screen.getByLabelText("Title backdrop blur"), { target: { value: "10" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    expect(sent.heroBlur).toBe(5);
    expect(sent.titleBackdropOpacity).toBe(80);
    expect(sent.titleBackdropBlur).toBe(10);
  });

  it("composites the WYSIWYG hero preview live as the sliders drag (no save)", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        hero: { title: "Vera & Ravi", subtitle: null, imageUrl: "/api/invite/s/image/hero?v=1" },
      }),
    );

    const { container } = render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    const preview = () => container.querySelector('[aria-label="Hero preview"]') as HTMLElement;
    // The preview shows the title text and a NON-blurred (card) variant image so
    // the client-side CSS blur isn't doubled on a server-blurred source.
    const img = preview().querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(
      "https://api.test/api/invite/s/image/hero?v=1&variant=card",
    );
    expect(img.style.filter).toBe("blur(28px)"); // default blur

    // Drag the blur slider — the preview image filter updates instantly, no PUT.
    fireEvent.input(screen.getByLabelText("Hero image blur"), { target: { value: "3" } });
    await waitFor(() => expect(img.style.filter).toBe("blur(3px)"));
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("seeds a null font as 'default' and sends a cleared colour as null", async () => {
    // Loaded with a hero accent set + null fonts: the selects should read
    // "default", and clearing the accent should PUT heroAccentColor: null.
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: {
          ...EMPTY_CUSTOMISATION.theme,
          hero: { accentColor: "#112233", surfaceColor: null },
        },
      }),
    );
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => {
      const heading = screen.getByLabelText("Heading font") as HTMLSelectElement;
      expect(heading.value).toBe("default");
    });

    // Hero accent was loaded as #112233, so its "Use default" clear control shows.
    const clears = screen.getAllByText("Use default");
    fireEvent.click(clears[0]);

    fireEvent.click(screen.getByText("Save invite"));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    expect(sent.heroAccentColor).toBeNull();
    expect(sent.headingFont).toBeNull();
  });

  it("updates the live hero preview's CSS vars as a colour picker changes (no save needed)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load only

    const { container } = render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => screen.getByText("Save invite"));

    // The WYSIWYG hero preview consumes --invite-accent, driven live by the Hero
    // accent picker in the same fieldset. Before any change: the default gold.
    const heroPreview = () =>
      container.querySelector('[aria-label="Hero preview"]') as HTMLElement | null;
    await waitFor(() => expect(heroPreview()).not.toBeNull());
    expect(heroPreview()!.style.getPropertyValue("--invite-accent")).toBe(
      "oklch(74.99% 0.0854 82.08)",
    );

    // Change the Hero accent via the popover hex field — the preview updates
    // instantly (no PUT fired).
    const accents = screen.getAllByLabelText("Accent colour");
    fireEvent.click(accents[0]);
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#112233" } });

    await waitFor(() =>
      expect(heroPreview()!.style.getPropertyValue("--invite-accent")).toBe("#112233"),
    );
    // Live preview must not trigger a network save.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the live section previews with the live copy buffers", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    // Each guest-page section has its own labelled preview card…
    const events = screen.getByLabelText("Events Section preview");
    screen.getByLabelText("Our Story preview");
    screen.getByLabelText("Code Entry & Welcome preview");
    // …showing the built-in copy until the organiser types.
    expect(events.textContent).toContain("Your Events");

    // Typing new events copy updates the preview instantly (no save).
    fireEvent.input(screen.getByLabelText("Events heading"), {
      target: { value: "The Festivities" },
    });
    await waitFor(() => expect(events.textContent).toContain("The Festivities"));
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a live low-contrast advisory for a self-defeating colour pair, and clears it (WT-C-L1)", async () => {
    // Loaded with a welcome accent ≈ background: the code-entry form's labels /
    // focus ring would be near-invisible. The advisory must warn (never block).
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: {
          ...EMPTY_CUSTOMISATION.theme,
          welcome: { accentColor: "#888888", surfaceColor: "#999999" },
        },
      }),
    );

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    const advisory = await waitFor(() => screen.getByText(/Low contrast/));
    expect(advisory.textContent).toContain(":1");
    // Advisory only — the save button stays enabled.
    expect((screen.getByText("Save invite") as HTMLButtonElement).disabled).toBe(false);

    // Clearing the accent back to the default (gold on #999999 is still low…
    // so clear the background too) removes the warning live, no save needed.
    const clears = screen.getAllByText("Use default");
    fireEvent.click(clears[0]);
    fireEvent.click(screen.getAllByText("Use default")[0]);
    await waitFor(() => expect(screen.queryByText(/Low contrast/)).toBeNull());
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows no contrast advisory for the built-in defaults", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    expect(screen.queryByText(/Low contrast/)).toBeNull();
  });

  it("surfaces a server validation error from the theme half (bad colour rejected)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ error: "Invalid colour or font" }, 400));

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    // Dirty the theme half so its PUT actually fires.
    fireEvent.change(screen.getByLabelText("Heading font"), { target: { value: "georgia" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(screen.getByText("Invalid colour or font")).toBeTruthy());
  });

  it("stops before the theme PUT when the text half fails, surfacing its error", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ error: "Missing or invalid fields" }, 400));

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save invite"));

    // Dirty BOTH halves; the failed text PUT must stop the theme PUT.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "A & B" } });
    fireEvent.change(screen.getByLabelText("Heading font"), { target: { value: "georgia" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(screen.getByText("Missing or invalid fields")).toBeTruthy());
    // Text failed ⇒ the theme PUT never fires (load + text only).
    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody("/theme")).toBeNull();
  });

  it("seeds the invite message field and sends it on Save invite (text half only)", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ ...EMPTY_CUSTOMISATION, inviteMessage: "See you in Goa!" }),
    ); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // text save

    render(() => <InviteBuilder weddingId="wed_1" />);

    const field = (await waitFor(() =>
      screen.getByLabelText("Invite message (optional)"),
    )) as HTMLTextAreaElement;
    expect(field.value).toBe("See you in Goa!");

    fireEvent.input(field, { target: { value: "Come celebrate with us!" } });
    fireEvent.click(screen.getByText("Save invite"));

    // Copy-only edit ⇒ exactly one PUT, to /text — the theme row (and its
    // updatedAt image-cache version) is untouched.
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = authFetchMock.mock.calls[1];
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/invite/text");
    expect(init.method).toBe("PUT");
    expect(sentBody("/text").inviteMessage).toBe("Come celebrate with us!");
    expect(sentBody("/theme")).toBeNull();
  });

  it("seeds the events-section header + welcome greeting fields and sends them on Save invite", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        details: { eyebrow: "Join Us", heading: "The Festivities" },
        welcome: { message: "So happy you're here!" },
      }),
    ); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // text save

    render(() => <InviteBuilder weddingId="wed_1" />);

    const eyebrow = (await waitFor(() =>
      screen.getByLabelText("Events eyebrow"),
    )) as HTMLInputElement;
    expect(eyebrow.value).toBe("Join Us");
    expect((screen.getByLabelText("Events heading") as HTMLInputElement).value).toBe(
      "The Festivities",
    );
    expect((screen.getByLabelText("Welcome greeting") as HTMLInputElement).value).toBe(
      "So happy you're here!",
    );

    fireEvent.input(eyebrow, { target: { value: "Celebrate!" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/text");
    expect(sent.detailsEyebrow).toBe("Celebrate!");
    expect(sent.detailsHeading).toBe("The Festivities");
    expect(sent.welcomeMessage).toBe("So happy you're here!");
  });

  it("tolerates a payload without details/welcome copy (older API) — fields seed empty", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // no details/welcome keys

    render(() => <InviteBuilder weddingId="wed_1" />);

    const eyebrow = (await waitFor(() =>
      screen.getByLabelText("Events eyebrow"),
    )) as HTMLInputElement;
    expect(eyebrow.value).toBe("");
    expect((screen.getByLabelText("Welcome greeting") as HTMLInputElement).value).toBe("");
  });
});

describe("InviteBuilder shown/hidden badges", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  /** All segment badges, in DOM order: [hero, story]. */
  const badges = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-segment-badge]")] as HTMLElement[];

  it("marks both hero and story 'Hidden — empty' for a blank invite", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    const { container } = render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => expect(badges(container)).toHaveLength(2));
    const [hero, story] = badges(container);
    expect(hero.dataset.shown).toBe("false");
    expect(story.dataset.shown).toBe("false");
    expect(hero.textContent).toContain("Hidden — empty");
    expect(story.textContent).toContain("Hidden — empty");
  });

  it("marks a section 'Shown' when its content is present", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        hero: { title: "Vera & Ravi", subtitle: null, imageUrl: null },
        story: { eyebrow: null, heading: "How It Began", body: null, imageUrl: null },
      }),
    );
    const { container } = render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => expect(badges(container)).toHaveLength(2));
    const [hero, story] = badges(container);
    expect(hero.dataset.shown).toBe("true");
    expect(story.dataset.shown).toBe("true");
    expect(hero.textContent).toContain("Shown");
  });

  it("flips the hero badge to 'Shown' live as the organiser types a title", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    const { container } = render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => expect(badges(container)).toHaveLength(2));
    expect(badges(container)[0].dataset.shown).toBe("false");

    // Typing a couple title flips the hero badge without any save.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "A & B" } });

    await waitFor(() => expect(badges(container)[0].dataset.shown).toBe("true"));
    // Whitespace-only does NOT count as content — clearing back to spaces hides it.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "   " } });
    await waitFor(() => expect(badges(container)[0].dataset.shown).toBe("false"));
    // No network save was triggered by typing.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });
});
