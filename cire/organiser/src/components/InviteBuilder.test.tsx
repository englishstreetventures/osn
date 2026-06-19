// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * InviteBuilder lets the organiser rewrite copy, swap images, and (this suite)
 * set a per-section theme — fonts + accent/surface colours. The OSN auth + api
 * helpers + toasts are stubbed; this asserts the theme wiring: the loaded theme
 * seeds the controls, and "Save theme" PUTs the closed font enum + colour
 * payload to /theme.
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
  theme: {
    headingFont: null,
    bodyFont: null,
    hero: { accentColor: null, surfaceColor: null },
    story: { accentColor: null, surfaceColor: null },
    details: { accentColor: null, surfaceColor: null },
  },
};

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

  it("PUTs the theme payload (font enum + colours) on Save theme", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => screen.getByText("Save theme"));

    fireEvent.change(screen.getByLabelText("Heading font"), { target: { value: "cormorant" } });
    // Three "Accent colour" inputs (one per section); the first is Hero.
    const accents = screen.getAllByLabelText("Accent colour");
    fireEvent.input(accents[0], { target: { value: "#112233" } });

    fireEvent.click(screen.getByText("Save theme"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = authFetchMock.mock.calls[1];
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/invite/theme");
    expect(init.method).toBe("PUT");
    const sent = JSON.parse(init.body as string);
    expect(sent.headingFont).toBe("cormorant");
    expect(sent.heroAccentColor).toBe("#112233");
    // Untouched fonts collapse to null ("default" ⇒ keep the built-in token).
    expect(sent.bodyFont).toBeNull();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
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

    fireEvent.click(screen.getByText("Save theme"));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = JSON.parse(authFetchMock.mock.calls[1][1].body as string);
    expect(sent.heroAccentColor).toBeNull();
    expect(sent.headingFont).toBeNull();
  });

  it("updates the live preview's CSS vars as a colour picker changes (no save needed)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load only

    const { container } = render(() => <InviteBuilder weddingId="wed_1" />);

    await waitFor(() => screen.getByText("Save theme"));

    // The Hero preview card is labelled; it consumes --invite-accent, driven live
    // by the Hero accent picker. Before any change it shows the default gold.
    const heroPreview = () =>
      container.querySelector('[aria-label="Hero preview"]') as HTMLElement | null;
    await waitFor(() => expect(heroPreview()).not.toBeNull());
    expect(heroPreview()!.style.getPropertyValue("--invite-accent")).toBe(
      "oklch(74.99% 0.0854 82.08)",
    );

    // Change the Hero accent — the preview updates instantly (no PUT fired).
    const accents = screen.getAllByLabelText("Accent colour");
    fireEvent.input(accents[0], { target: { value: "#112233" } });

    await waitFor(() =>
      expect(heroPreview()!.style.getPropertyValue("--invite-accent")).toBe("#112233"),
    );
    // Live preview must not trigger a network save.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a server validation error (bad colour rejected)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ error: "Invalid colour or font" }, 400));

    render(() => <InviteBuilder weddingId="wed_1" />);
    await waitFor(() => screen.getByText("Save theme"));

    fireEvent.click(screen.getByText("Save theme"));

    await waitFor(() => expect(screen.getByText("Invalid colour or font")).toBeTruthy());
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
