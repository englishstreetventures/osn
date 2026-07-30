// @vitest-environment happy-dom
import { derivePalette, PALETTE_PRESETS, typographyVar } from "@cire/theme";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
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

vi.mock("@shared/rp-auth/solid", () => ({
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

// Test-only catalog: a premium design BETWEEN the two free ones, so keyboard
// navigation's locked-skip behaviour is exercised (mirrors the TEST_CATALOG
// fixture pattern in cire/api/src/routes/invite.test.ts — the launch catalog
// is all-free, so the dormant entitlement gate needs its own fixture).
vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [
    { id: "classic", name: "Classic", tier: "free" },
    { id: "test-premium", name: "Test Premium", tier: "premium" },
    { id: "gala", name: "Gala", tier: "free" },
  ],
}));

// Stand-in for the lazy-loaded cropperjs editor: cropperjs v2 web components
// can't mount in happy-dom, and what these tests pin is the WIRING — which slot
// the modal opens on and what body the save PUTs — not the crop interaction.
// The fake exposes save/reset triggers that call through with a fixed rectangle.
vi.mock("./ImageCropModal", () => ({
  default: (props: {
    slot: string;
    initialCrop: unknown;
    onSave: (crop: unknown) => Promise<void>;
    onReset: () => Promise<void>;
    onClose: () => void;
  }) => (
    <div data-testid="mock-crop-modal" data-slot={props.slot}>
      <button
        onClick={() => {
          void props
            .onSave({ x: 0.6, y: 0, w: 0.3, h: 0.9 })
            .then(() => props.onClose())
            .catch(() => {});
        }}
      >
        mock-save
      </button>
      <button
        onClick={() => {
          void props.onReset().catch(() => {});
        }}
      >
        mock-reset
      </button>
    </div>
  ),
}));

// Real (unmocked) — the guard-lifecycle test asserts the builder's dirty state
// reaches the process-global registry the dashboard consults.
import { confirmNavigation } from "../lib/unsaved-guard";
import { captureDeclaredStyles } from "../test-support/declared-style";
import InviteBuilder, { isDesignLocked } from "./InviteBuilder";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMPTY_CUSTOMISATION = {
  designId: "classic",
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    palettePreset: null,
    palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
    tones: { hero: null, story: null, details: null, welcome: null },
  },
};

/** The parsed body of the PUT whose URL ends with `suffix`, or null if never fired. */
function sentBody(suffix: string) {
  const call = authFetchMock.mock.calls.find((c) => String(c[0]).endsWith(suffix));
  return call ? JSON.parse(call[1].body as string) : null;
}

/** Like `sentBody`, but the LAST matching call — for tests that trigger the
 *  same endpoint more than once (e.g. two keyboard-nav saves in sequence). */
function lastSentBody(suffix: string) {
  const calls = authFetchMock.mock.calls.filter((c) => String(c[0]).endsWith(suffix));
  const call = calls.at(-1);
  return call ? JSON.parse(call[1].body as string) : null;
}

describe("InviteBuilder theme", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    vi.restoreAllMocks();
  });

  it("seeds the font selects from the loaded theme", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: { ...EMPTY_CUSTOMISATION.theme, headingFont: "georgia", bodyFont: "system-sans" },
      }),
    );
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    await waitFor(() => {
      const heading = screen.getByLabelText("Heading font") as HTMLSelectElement;
      expect(heading.value).toBe("georgia");
    });
    const body = screen.getByLabelText("Body font") as HTMLSelectElement;
    expect(body.value).toBe("system-sans");
  });

  it("seeds the typography selects from the loaded theme (0048)", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: {
          ...EMPTY_CUSTOMISATION.theme,
          headingSize: "large",
          headingWeight: "bold",
          headingStyle: "italic",
          bodyWeight: "light",
          bodyStyle: "italic",
        },
      }),
    );
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    await waitFor(() => {
      const size = screen.getByLabelText("Heading size") as HTMLSelectElement;
      expect(size.value).toBe("large");
    });
    expect((screen.getByLabelText("Heading weight") as HTMLSelectElement).value).toBe("bold");
    expect((screen.getByLabelText("Heading style") as HTMLSelectElement).value).toBe("italic");
    expect((screen.getByLabelText("Body weight") as HTMLSelectElement).value).toBe("light");
    expect((screen.getByLabelText("Body style") as HTMLSelectElement).value).toBe("italic");
  });

  it("PUTs the typography keys with the theme body, collapsing 'default' to null", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    fireEvent.change(screen.getByLabelText("Heading style"), { target: { value: "italic" } });
    fireEvent.change(screen.getByLabelText("Body weight"), { target: { value: "light" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    expect(sent.headingStyle).toBe("italic");
    expect(sent.bodyWeight).toBe("light");
    // Untouched options collapse to null ("default" ⇒ keep the pack's look).
    expect(sent.headingSize).toBeNull();
    expect(sent.headingWeight).toBeNull();
    expect(sent.bodyStyle).toBeNull();
  });

  it("PUTs only the theme body when only theme fields changed (font enum + scheme)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    await waitFor(() => screen.getByText("Save invite"));

    fireEvent.change(screen.getByLabelText("Heading font"), { target: { value: "cormorant" } });
    // ONE Accent swatch for the whole invite now, not one per section. Open its
    // popover and type a full hex into the labelled "Hex" field.
    fireEvent.click(screen.getByLabelText("Gilt colour"));
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
    expect(sent.paletteGilt).toBe("#112233");
    // Untouched fonts collapse to null ("default" ⇒ keep the built-in token).
    expect(sent.bodyFont).toBeNull();
    // Hero display sliders ride on the same PUT, defaulting to today's look.
    expect(sent.heroBlur).toBe(28);
    expect(sent.titleBackdropOpacity).toBe(0);
    expect(sent.titleBackdropBlur).toBe(0);
    // The untouched seeds and tones ride along as null (keep the defaults) —
    // the body is total, so every field must be present.
    expect(sent.paletteGround).toBeNull();
    expect(sent.paletteBloom).toBeNull();
    expect(sent.welcomeTone).toBeNull();
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Invite saved"));
  });

  it("PUTs both halves in order when copy AND theme changed", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // text save
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
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

    // A successful save refreshes both snapshots — the bar returns to clean
    // (button disabled, saved indicator) rather than showing a stale dirty flag.
    await waitFor(() =>
      expect((screen.getByText("Save invite") as HTMLButtonElement).disabled).toBe(true),
    );
    screen.getByText("All changes saved");
  });

  it("disables Save on a clean form and shows the live dirty indicator on edit", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load only

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    // Clean form ⇒ the button is disabled and the bar reports saved state — a
    // gratuitous save must not bump `updatedAt` (it would bust the guest
    // image-transform caches for zero change, P-W1).
    const save = screen.getByText("Save invite") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    screen.getByText("All changes saved");
    fireEvent.click(save);
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // An edit flips the reactive dirty state: indicator + enabled save.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "A & B" } });
    await waitFor(() => expect(save.disabled).toBe(false));
    screen.getByText("Unsaved changes");

    // Reverting the edit returns the form to clean — no stale dirty flag.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "" } });
    await waitFor(() => expect(save.disabled).toBe(true));
    screen.getByText("All changes saved");
  });

  it("seeds the scheme from the loaded theme and PUTs an edited seed", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: {
          ...EMPTY_CUSTOMISATION.theme,
          palettePreset: "jewel",
          palette: { ...EMPTY_CUSTOMISATION.theme.palette, gilt: "#7a9e7e" },
        },
      }),
    );
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    // The section fieldset carries its legend AND a live preview card.
    expect(screen.getAllByText("Code Entry & Welcome").length).toBeGreaterThanOrEqual(2);
    screen.getByLabelText("Code Entry & Welcome preview");

    fireEvent.click(screen.getByLabelText("Gilt colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    // Seeded from the loaded theme, not the preset default (case per Kobalte).
    expect(hex.value.toLowerCase()).toBe("#7a9e7e");
    fireEvent.input(hex, { target: { value: "#112233" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    expect(sent.paletteGilt).toBe("#112233");
    // The preset the organiser started from rides along; the seeds they never
    // touched stay null so they keep following that preset.
    expect(sent.palettePreset).toBe("jewel");
    expect(sent.paletteGround).toBeNull();
  });

  it("adopts a preset's five colours in one click", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    fireEvent.click(screen.getByText("Fog"));
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    // Picking a preset records the CHOICE, not five copied hexes — so a later
    // change to the preset's palette reaches invites that chose it. The guest
    // side resolves the null seeds against this key (see paletteRootVars), which
    // is what makes a key-only scheme render as that scheme.
    expect(sent.palettePreset).toBe("fog");
    expect(sent.paletteGround).toBeNull();

    // And the preview agrees with what a guest will see. The two sides reach
    // `derivePalette` differently — the builder pre-fills the five seeds, the
    // guest passes the preset key — and the one bug this feature shipped to a
    // live preview was exactly a preset-only scheme rendering as evergreen.
    const heroPreview = document.querySelector('[aria-label="Hero preview"]') as HTMLElement;
    await waitFor(() =>
      expect(heroPreview.style.getPropertyValue("--color-gold")).toBe(
        derivePalette(PALETTE_PRESETS.fog)["--color-gold"],
      ),
    );
  });

  it("PUTs an edited section tone (the tone lane)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    // One tone control per section, in guest-page order (hero, story, welcome,
    // events); each offers the same three surfaces. The closing section has NO
    // control of its own — it reuses the welcome surface.
    const raised = screen.getAllByText("Raised");
    expect(raised.length).toBe(4);
    fireEvent.click(raised[2]); // welcome
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    expect(sent.welcomeTone).toBe("raised");
    // Sibling tone lanes untouched — guards a copy-paste slip in the updater.
    expect(sent.storyTone).toBeNull();
    expect(sent.detailsTone).toBeNull();
    expect(sent.heroTone).toBeNull();
  });

  // The closing section deliberately adds NO tone field — it reuses the welcome
  // surface, so the theme body must stay the four lanes it has always had.
  it("sends no extra tone lane for the closing section", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    fireEvent.click(screen.getAllByText("Raised")[0]); // hero — make the half dirty
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(sentBody("/theme")).not.toHaveProperty("footerTone");
  });

  it("seeds the hero display sliders from the loaded customisation", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        heroDisplay: { blur: 12, titleBackdrop: { opacity: 60, blur: 8 } },
      }),
    );
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    await waitFor(() => screen.getByText("Save invite"));
    expect((screen.getByLabelText("Hero image blur") as HTMLInputElement).value).toBe("12");
    expect((screen.getByLabelText("Title backdrop opacity") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("Title backdrop blur") as HTMLInputElement).value).toBe("8");
  });

  it("PUTs the chosen hero display slider values on Save invite", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
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

    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));
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

  it("seeds a null font as 'default' and sends a cleared seed as null", async () => {
    // Loaded with an accent seed set + null fonts: the selects should read
    // "default", and clearing the seed should PUT paletteGilt: null.
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: {
          ...EMPTY_CUSTOMISATION.theme,
          palette: { ...EMPTY_CUSTOMISATION.theme.palette, gilt: "#112233" },
        },
      }),
    );
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // theme save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    await waitFor(() => {
      const heading = screen.getByLabelText("Heading font") as HTMLSelectElement;
      expect(heading.value).toBe("default");
    });

    // The accent seed was loaded as #112233, so its "Use default" clear shows.
    const clears = screen.getAllByText("Use default");
    fireEvent.click(clears[0]);

    fireEvent.click(screen.getByText("Save invite"));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const sent = sentBody("/theme");
    expect(sent.paletteGilt).toBeNull();
    expect(sent.headingFont).toBeNull();
  });

  it("updates the live hero preview's CSS vars as a colour picker changes (no save needed)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load only

    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));

    await waitFor(() => screen.getByText("Save invite"));

    // The WYSIWYG hero preview consumes the DERIVED tokens, driven live by the
    // scheme editor. Before any change: the built-in gold.
    const heroPreview = () =>
      container.querySelector('[aria-label="Hero preview"]') as HTMLElement | null;
    await waitFor(() => expect(heroPreview()).not.toBeNull());
    expect(heroPreview()!.style.getPropertyValue("--color-gold")).toBe(
      derivePalette(PALETTE_PRESETS.evergreen)["--color-gold"],
    );

    // Change the accent seed via the popover hex field — the preview updates
    // instantly (no PUT fired), through the SAME derivation the guest uses.
    fireEvent.click(screen.getByLabelText("Gilt colour"));
    const hex = await waitFor(() => screen.getByLabelText("Hex") as HTMLInputElement);
    fireEvent.input(hex, { target: { value: "#112233" } });

    await waitFor(() =>
      expect(heroPreview()!.style.getPropertyValue("--color-gold")).toBe(
        derivePalette({ ...PALETTE_PRESETS.evergreen, gilt: "#112233" })["--color-gold"],
      ),
    );
    // Live preview must not trigger a network save.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("updates the live previews' typography vars as a select changes (no save needed)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load only

    // Installed before the render: the samples resolve their fallbacks through
    // `@cire/theme`, which makes those style objects computed, and happy-dom
    // discards a `var()` value applied that way. See `test-support/declared-style`.
    const styles = captureDeclaredStyles();
    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));
    await waitFor(() => screen.getByText("Save invite"));

    const heroPreview = () =>
      container.querySelector('[aria-label="Hero preview"]') as HTMLElement | null;
    await waitFor(() => expect(heroPreview()).not.toBeNull());
    // Default pick ⇒ no override var — the preview falls back to the pack look.
    expect(heroPreview()!.style.getPropertyValue("--invite-heading-weight")).toBe("");

    // The pick resolves through the SAME shared value map the guest uses, so
    // the preview cannot show a weight the guest would not render.
    fireEvent.change(screen.getByLabelText("Heading weight"), { target: { value: "bold" } });
    await waitFor(() =>
      expect(heroPreview()!.style.getPropertyValue("--invite-heading-weight")).toBe("700"),
    );
    // EVERY preview layer is styled from the same token map — including the
    // colour-scheme sample inside the Look card, which sits closest to the
    // typography controls and so is the one an organiser watches first.
    const schemePreview = container.querySelector(
      '[aria-label="Colour scheme preview"]',
    ) as HTMLElement;
    expect(schemePreview.style.getPropertyValue("--invite-heading-weight")).toBe("700");
    // …and the sample INSIDE it consumes what the figure was handed. Asserting
    // the figure alone would pass against the unfixed code: the bug was never
    // the plumbing, it was a sample that hardcoded `font-light italic` and so
    // ignored the variables it was given. Both halves of that seam, or neither.
    const schemeHeading = within(schemePreview).getByText("Your Events");
    expect(styles.of(schemeHeading)["font-weight"]).toBe(typographyVar("headingWeight"));
    // (The section samples' body-pair cascade is pinned directly in
    // invite/previews.test.tsx.)
    // Live preview must not trigger a network save.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows the live section previews with the live copy buffers", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
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

  it("reports which seeds it adjusted for a self-defeating scheme (WT-C-L1)", async () => {
    // Loaded with text ≈ page: the invite would be near-unreadable. Contrast is
    // now ENFORCED in the derivation rather than merely warned about, so the
    // builder reports what it moved instead of asking the organiser to fix it.
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        theme: {
          ...EMPTY_CUSTOMISATION.theme,
          palette: {
            ...EMPTY_CUSTOMISATION.theme.palette,
            ground: "#999999",
            card: "#999999",
            ink: "#888888",
          },
        },
      }),
    );

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    const notice = await waitFor(() => screen.getByText(/Adjusted to stay readable/));
    // The seed NAME, not the old "text" label — and not the raw key either,
    // which is what the notice falls back to when the label map loses a role.
    expect(notice.textContent).toContain("ink");
    // The organiser's own pick is still saveable — nothing is blocked (the
    // save enables as soon as the form is dirty).
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "A & B" } });
    await waitFor(() =>
      expect((screen.getByText("Save invite") as HTMLButtonElement).disabled).toBe(false),
    );

    // Clearing the three edited seeds back to the preset's colours clears the
    // notice live, with no save. (Clearing only the text seed is not enough —
    // near-white text on a mid-grey page is still short of 4.5:1, which is
    // exactly why the derivation refuses to leave the pair alone.)
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getAllByText("Use default")[0]);
    await waitFor(() => expect(screen.queryByText(/Adjusted to stay readable/)).toBeNull());
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports no adjustment for the built-in scheme", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    expect(screen.queryByText(/Adjusted to stay readable/)).toBeNull();
  });

  it("surfaces a server validation error from the theme half (bad colour rejected)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ error: "Invalid colour or font" }, 400));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    // Dirty the theme half so its PUT actually fires.
    fireEvent.change(screen.getByLabelText("Heading font"), { target: { value: "georgia" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(screen.getByText("Invalid colour or font")).toBeTruthy());
  });

  it("stops before the theme PUT when the text half fails, surfacing its error", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ error: "Missing or invalid fields" }, 400));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
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

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

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

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

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

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const eyebrow = (await waitFor(() =>
      screen.getByLabelText("Events eyebrow"),
    )) as HTMLInputElement;
    expect(eyebrow.value).toBe("");
    expect((screen.getByLabelText("Welcome greeting") as HTMLInputElement).value).toBe("");
    // Same mid-deploy tolerance for the footer note (no `footer` key at all).
    expect((screen.getByLabelText("Closing note (optional)") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("seeds the footer note and sends it on Save invite", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ ...EMPTY_CUSTOMISATION, footer: { message: "No boxed gifts please" } }),
    ); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // text save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const note = (await waitFor(() =>
      screen.getByLabelText("Closing note (optional)"),
    )) as HTMLTextAreaElement;
    expect(note.value).toBe("No boxed gifts please");

    fireEvent.input(note, { target: { value: "Looking forward to celebrating with you" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(sentBody("/text").footerMessage).toBe("Looking forward to celebrating with you");
    // Copy-only edit: the theme half stays untouched so the guest image caches
    // aren't busted for nothing (P-W1).
    expect(sentBody("/theme")).toBeNull();
  });

  it("clears the footer note to null when the organiser empties the field", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({ ...EMPTY_CUSTOMISATION, footer: { message: "No boxed gifts please" } }),
    );
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const note = (await waitFor(() =>
      screen.getByLabelText("Closing note (optional)"),
    )) as HTMLTextAreaElement;
    fireEvent.input(note, { target: { value: "" } });
    fireEvent.click(screen.getByText("Save invite"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(sentBody("/text").footerMessage).toBeNull();
  });
});

describe("InviteBuilder shown/hidden badges", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    vi.restoreAllMocks();
  });

  /** All segment badges, in DOM order: [hero, story, footer]. */
  const badges = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-segment-badge]")] as HTMLElement[];

  it("marks hero, story and footer 'Hidden — empty' for a blank invite", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));

    await waitFor(() => expect(badges(container)).toHaveLength(3));
    const [hero, story, footer] = badges(container);
    expect(hero.dataset.shown).toBe("false");
    expect(story.dataset.shown).toBe("false");
    expect(footer.dataset.shown).toBe("false");
    expect(hero.textContent).toContain("Hidden — empty");
    expect(story.textContent).toContain("Hidden — empty");
    expect(footer.textContent).toContain("Hidden — empty");
  });

  it("marks a section 'Shown' when its content is present", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        hero: { title: "Vera & Ravi", subtitle: null, imageUrl: null },
        story: { eyebrow: null, heading: "How It Began", body: null, imageUrl: null },
        footer: { message: "No boxed gifts please" },
      }),
    );
    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));

    await waitFor(() => expect(badges(container)).toHaveLength(3));
    const [hero, story, footer] = badges(container);
    expect(hero.dataset.shown).toBe("true");
    expect(story.dataset.shown).toBe("true");
    expect(footer.dataset.shown).toBe("true");
    expect(hero.textContent).toContain("Shown");
  });

  it("flips the hero badge to 'Shown' live as the organiser types a title", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));

    await waitFor(() => expect(badges(container)).toHaveLength(3));
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

  it("marks the footer 'Shown' from an image alone, with no note typed", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...EMPTY_CUSTOMISATION,
        footer: { message: null, imageUrl: "/api/invite/anita-ben/image/footer?v=1" },
      }),
    );
    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));

    await waitFor(() => expect(badges(container)).toHaveLength(3));
    expect(badges(container)[2].dataset.shown).toBe("true");
    // …and the note field really is empty — the badge came from the image.
    expect((screen.getByLabelText("Closing note (optional)") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("flips the footer badge live, and whitespace-only stays hidden", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));

    await waitFor(() => expect(badges(container)).toHaveLength(3));
    const footerBadge = () => badges(container)[2];
    expect(footerBadge().dataset.shown).toBe("false");

    const field = screen.getByLabelText("Closing note (optional)");
    fireEvent.input(field, { target: { value: "Looking forward to celebrating with you" } });
    await waitFor(() => expect(footerBadge().dataset.shown).toBe("true"));

    fireEvent.input(field, { target: { value: "   " } });
    await waitFor(() => expect(footerBadge().dataset.shown).toBe("false"));
  });
});

describe("isDesignLocked", () => {
  it("never locks a free design", () => {
    expect(isDesignLocked("free", [])).toBe(false);
  });

  it("locks a premium design without the entitlement", () => {
    expect(isDesignLocked("premium", [])).toBe(true);
    expect(isDesignLocked("premium", ["vendors"])).toBe(true);
  });

  it("unlocks a premium design with premium_templates", () => {
    expect(isDesignLocked("premium", ["premium_templates"])).toBe(false);
  });
});

describe("design selector", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    vi.restoreAllMocks();
  });

  it("renders a card per catalog design with the active one marked", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const classic = await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));
    expect(classic.getAttribute("aria-checked")).toBe("true");
  });

  it("clicking the current design does not save", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const classic = await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));
    fireEvent.click(classic);

    // No PUT to /design — the current design is a no-op click.
    expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/design"))).toBe(false);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("clicking the classic design with missing designId does not save", async () => {
    // Fixture with no designId field — should default to "classic" and no-op the click.
    const { designId: _omitted, ...customisationWithoutDesignId } = EMPTY_CUSTOMISATION;
    authFetchMock.mockResolvedValueOnce(json(customisationWithoutDesignId)); // initial load

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const classic = await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));
    fireEvent.click(classic);

    // No PUT to /design — clicking the visually-current classic card is a no-op even when designId is absent.
    expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/design"))).toBe(false);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("selecting a different design PUTs and updates the builder", async () => {
    authFetchMock.mockResolvedValueOnce(json({ ...EMPTY_CUSTOMISATION, designId: "other" })); // initial load — an id from a newer deploy, Classic not active
    authFetchMock.mockResolvedValueOnce(json({ ...EMPTY_CUSTOMISATION, designId: "classic" })); // design save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const classic = await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));
    expect(classic.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(classic);

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(sentBody("/design")).toEqual({ designId: "classic" });
    await waitFor(() => expect(classic.getAttribute("aria-checked")).toBe("true"));
  });

  it("renders an abstract thumbnail svg per card, decorative", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load

    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));

    await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));
    const radiogroup = screen.getByRole("radiogroup", { name: "Invite design" });
    const thumbnails = radiogroup.querySelectorAll("svg");
    // One thumbnail per catalog card (classic, test-premium, gala).
    expect(thumbnails.length).toBe(3);
    for (const svg of thumbnails) {
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    }
    // Thumbnails live inside the radio control, not floating in the card.
    expect(container.querySelectorAll('[role="radio"] svg').length).toBe(3);
  });

  it("shows a 'Preview live' link per unlocked card, outside the radio control", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));

    // Only two unlocked cards (classic, gala) get a preview link — the locked
    // test-premium card in between does not.
    const links = screen.getAllByRole("link", { name: "Preview live" });
    expect(links.length).toBe(2);

    const galaLink = links.find((l) => l.getAttribute("href")?.includes("design=gala"));
    expect(galaLink).toBeDefined();
    expect(galaLink!.getAttribute("target")).toBe("_blank");
    expect(galaLink!.getAttribute("rel")).toBe("noopener");
    expect(galaLink!.getAttribute("href")).toBe("http://localhost:4321/anita-ben?design=gala");

    // The link is a sibling of the radio control, never a descendant (nesting
    // an <a> inside the radio <button> would be invalid + would toggle
    // selection on click).
    const radio = screen.getByRole("radio", { name: /Gala/ });
    expect(radio.contains(galaLink!)).toBe(false);

    // Clicking it must never fire a design save. preventDefault first so
    // happy-dom doesn't actually fetch the guest URL (ECONNREFUSED noise in
    // every test run).
    galaLink!.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(galaLink!);
    expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/design"))).toBe(false);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("a failed design save keeps the current selection and toasts the error", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({}, 500)); // design PUT fails

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const gala = await waitFor(() => screen.getByRole("radio", { name: /Gala/ }));
    fireEvent.click(gala);

    // The design save bypasses the save bar, so the toast is the ONLY failure
    // feedback — and the server-acknowledged selection must not move.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Could not update the design"));
    expect(screen.getByRole("radio", { name: /Classic/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(gala.getAttribute("aria-checked")).toBe("false");
  });

  it("ArrowRight lands on the locked card (perceivable, unselectable); the next step selects gala", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ ...EMPTY_CUSTOMISATION, designId: "gala" })); // design save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const classic = await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));
    // Locked cards are aria-disabled (never `disabled`) so they stay in the
    // accessibility tree and keyboard focus can reach them — a screen-reader
    // user can discover that premium designs exist and hear why they're off.
    const premium = screen.getByRole("radio", { name: /Test Premium/ });
    expect(premium.getAttribute("aria-disabled")).toBe("true");

    // Focus MOVES onto the locked card, but selection never follows it there.
    fireEvent.keyDown(classic, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(premium));
    expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/design"))).toBe(false);

    // The next step lands on gala and selects it (radio semantics resume).
    fireEvent.keyDown(premium, { key: "ArrowRight" });
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(sentBody("/design")).toEqual({ designId: "gala" });

    const gala = screen.getByRole("radio", { name: /Gala/ });
    await waitFor(() => expect(document.activeElement).toBe(gala));
  });

  it("clicking a locked design is a no-op (server-enforced; the card only signals)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const premium = await waitFor(() => screen.getByRole("radio", { name: /Test Premium/ }));
    fireEvent.click(premium);

    expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/design"))).toBe(false);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("Home and End jump to the first and last unlocked cards", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ ...EMPTY_CUSTOMISATION, designId: "gala" })); // End -> gala
    authFetchMock.mockResolvedValueOnce(json({ ...EMPTY_CUSTOMISATION, designId: "classic" })); // Home -> classic

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const classic = await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));
    fireEvent.keyDown(classic, { key: "End" });

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(sentBody("/design")).toEqual({ designId: "gala" });

    const gala = screen.getByRole("radio", { name: /Gala/ });
    await waitFor(() => expect(document.activeElement).toBe(gala));
    // Wait for the End save to fully settle (not just be in-flight) before
    // firing Home — selectDesign no-ops while a prior save is still pending.
    await waitFor(() => expect(gala.getAttribute("aria-checked")).toBe("true"));

    fireEvent.keyDown(gala, { key: "Home" });

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(3));
    expect(lastSentBody("/design")).toEqual({ designId: "classic" });
    await waitFor(() => expect(document.activeElement).toBe(classic));
  });

  it("keeps exactly one card at tabindex 0, moving with keyboard nav", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ ...EMPTY_CUSTOMISATION, designId: "gala" })); // design save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const classic = await waitFor(() => screen.getByRole("radio", { name: /Classic/ }));
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBe(3);

    const tabbable = () => radios.filter((r) => r.getAttribute("tabindex") === "0");
    expect(tabbable()).toEqual([classic]);

    // First step: the locked card becomes the single tab stop (no save)…
    fireEvent.keyDown(classic, { key: "ArrowRight" });
    const premium = screen.getByRole("radio", { name: /Test Premium/ });
    await waitFor(() => expect(tabbable()).toEqual([premium]));

    // …second step: gala, with the selection save.
    fireEvent.keyDown(premium, { key: "ArrowRight" });
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const gala = screen.getByRole("radio", { name: /Gala/ });
    await waitFor(() => expect(tabbable()).toEqual([gala]));
    expect(tabbable().length).toBe(1);
  });
});

describe("InviteBuilder hero phone crop (migration 0046)", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    vi.restoreAllMocks();
  });

  // A customisation with both images uploaded, no crops saved yet.
  const WITH_IMAGES = {
    ...EMPTY_CUSTOMISATION,
    hero: {
      title: null,
      subtitle: null,
      imageUrl: "/api/organiser/weddings/wed_1/invite/image/hero?v=1",
      imageCrop: null,
      imageCropMobile: null,
    },
    story: {
      eyebrow: null,
      heading: null,
      body: null,
      imageUrl: "/api/organiser/weddings/wed_1/invite/image/story?v=1",
      imageCrop: null,
    },
  };

  it("offers 'Phone crop' on the hero image only (the story renders at one aspect)", async () => {
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    await waitFor(() => screen.getByRole("button", { name: "Phone crop" }));
    // Both slots offer the plain crop; only the hero offers the phone one.
    expect(screen.getAllByRole("button", { name: "Crop" }).length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Phone crop" }).length).toBe(1);
  });

  it("a phone-crop save PUTs { crop, screen: 'mobile' } to the hero crop route", async () => {
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // initial load
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // crop save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Phone crop" })));
    // The phone editor opens on the tall hero-mobile frame, seeded empty.
    const modal = await waitFor(() => screen.getByTestId("mock-crop-modal"));
    expect(modal.getAttribute("data-slot")).toBe("hero-mobile");

    fireEvent.click(screen.getByRole("button", { name: "mock-save" }));
    await waitFor(() =>
      expect(sentBody("/image/hero/crop")).toEqual({
        crop: { x: 0.6, y: 0, w: 0.3, h: 0.9 },
        screen: "mobile",
      }),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Phone crop saved"));
  });

  it("a plain crop save PUTs { crop } with NO screen key (pre-0046 body unchanged)", async () => {
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // initial load
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // crop save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    // The hero card comes first, so its "Crop" is the first of the two.
    const cropButtons = await waitFor(() => screen.getAllByRole("button", { name: "Crop" }));
    fireEvent.click(cropButtons[0]);
    const modal = await waitFor(() => screen.getByTestId("mock-crop-modal"));
    expect(modal.getAttribute("data-slot")).toBe("hero");

    fireEvent.click(screen.getByRole("button", { name: "mock-save" }));
    // Exact equality: a stray `screen` key here would misroute the save into
    // the desktop column semantics on older-API deploys.
    await waitFor(() =>
      expect(sentBody("/image/hero/crop")).toEqual({ crop: { x: 0.6, y: 0, w: 0.3, h: 0.9 } }),
    );
  });

  it("crop reset PUTs an explicit null — desktop and phone nouns both toast", async () => {
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // initial load
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // desktop reset
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // phone reset

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    // Desktop reset: `crop: null` must reach the API as an explicit null (not
    // be dropped by serialisation), with no `screen` key.
    const cropButtons = await waitFor(() => screen.getAllByRole("button", { name: "Crop" }));
    fireEvent.click(cropButtons[0]);
    await waitFor(() => screen.getByTestId("mock-crop-modal"));
    fireEvent.click(screen.getByRole("button", { name: "mock-reset" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Crop reset"));
    expect(lastSentBody("/image/hero/crop")).toEqual({ crop: null });

    // Phone reset: same explicit null, routed to the mobile rectangle.
    fireEvent.click(screen.getByRole("button", { name: "Phone crop" }));
    const modal = await waitFor(() => screen.getByTestId("mock-crop-modal"));
    expect(modal.getAttribute("data-slot")).toBe("hero-mobile");
    fireEvent.click(screen.getByRole("button", { name: "mock-reset" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Phone crop reset"));
    expect(lastSentBody("/image/hero/crop")).toEqual({ crop: null, screen: "mobile" });
  });

  it("shows the phone framing in the hero preview via the device toggle", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...WITH_IMAGES,
        hero: { ...WITH_IMAGES.hero, imageCropMobile: { x: 0.6, y: 0, w: 0.3, h: 0.9 } },
      }),
    );
    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));
    await waitFor(() => screen.getByText("Save invite"));

    const preview = () => container.querySelector('[aria-label="Hero preview"]') as HTMLElement;
    // Desktop framing by default; the phone toggle sits beside the preview.
    const toggles = screen.getAllByRole("group", { name: "Preview device" });
    expect(toggles.length).toBeGreaterThanOrEqual(1);
    const phoneButtons = screen.getAllByRole("button", { name: "Phone" });
    fireEvent.click(phoneButtons[0]);

    // The phone frame renders the hero's PHONE rectangle with the same
    // background-fraction technique as the guest site (no plain <img> cover) —
    // the whole reason the second crop rectangle exists (0046). The fraction
    // layer is the one carrying background-size (the base gradient does not).
    await waitFor(() => {
      const cropLayer = preview().querySelector("div[style*='background-size']");
      expect(cropLayer).not.toBeNull();
    });
  });

  it("renders the phone thumbnail only when a phone crop is saved", async () => {
    authFetchMock.mockResolvedValueOnce(
      json({
        ...WITH_IMAGES,
        hero: { ...WITH_IMAGES.hero, imageCropMobile: { x: 0.6, y: 0, w: 0.3, h: 0.9 } },
      }),
    );
    const first = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));
    await waitFor(() =>
      expect(screen.getByLabelText("Hero background image (phone crop)")).toBeTruthy(),
    );
    first.unmount();
    authFetchMock.mockReset();

    // Without a saved phone crop the thumbnail is absent.
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByRole("button", { name: "Phone crop" }));
    expect(screen.queryByLabelText("Hero background image (phone crop)")).toBeNull();
  });
});

describe("InviteBuilder UX guards", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    vi.unstubAllGlobals();
  });

  const WITH_HERO_IMAGE = {
    ...EMPTY_CUSTOMISATION,
    hero: {
      title: null,
      subtitle: null,
      imageUrl: "/api/organiser/weddings/wed_1/invite/image/hero?v=1",
      imageCrop: null,
    },
  };

  it("shows a live character counter on capped notes, enforced at the input", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const note = (await waitFor(() =>
      screen.getByLabelText("Closing note (optional)"),
    )) as HTMLTextAreaElement;
    // The counter mirrors the server cap in cire/api schemas/invite.ts, so the
    // organiser never discovers the limit via a 400 at save time.
    screen.getByText("0/300");
    fireEvent.input(note, { target: { value: "No boxed gifts" } });
    await waitFor(() => screen.getByText("14/300"));
    expect(note.getAttribute("maxlength")).toBe("300");
  });

  it("asks before removing an image and skips the DELETE when declined", async () => {
    authFetchMock.mockResolvedValueOnce(json(WITH_HERO_IMAGE));
    // happy-dom ships no window.confirm — stub it (declined).
    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    const remove = await waitFor(() => screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(remove);

    // Removal hits the LIVE invite immediately, so it is confirm-gated — a
    // declined confirm must fire no DELETE.
    expect(confirmSpy).toHaveBeenCalled();
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes the image after an accepted confirm", async () => {
    authFetchMock.mockResolvedValueOnce(json(WITH_HERO_IMAGE)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // DELETE
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Remove" })));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = authFetchMock.mock.calls[1];
    expect(String(url)).toMatch(/\/invite\/image\/hero$/);
    expect(init.method).toBe("DELETE");
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Image removed"));
  });

  it("surfaces an upload failure inside its own section, not the save bar", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ error: "Image too large (max 5 MB)" }, 413)); // upload

    const { container } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));
    await waitFor(() => screen.getByText("Save invite"));

    const input = container.querySelector('#invite-hero input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "hero.jpg", { type: "image/jpeg" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    const alert = await waitFor(() => screen.getByText("Image too large (max 5 MB)"));
    // The error renders next to the control that failed — inside the hero
    // section card — not in the distant save bar.
    expect(document.getElementById("invite-hero")!.contains(alert)).toBe(true);
  });

  it("wires the dirty state into the navigation guard across its lifecycle", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // text save
    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);

    const { unmount } = render(() => (
      <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />
    ));
    await waitFor(() => screen.getByText("Save invite"));

    // Clean load ⇒ navigation allowed without prompting.
    expect(confirmNavigation()).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();

    // Dirty ⇒ the registered guard prompts; a declined confirm vetoes.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "A & B" } });
    await waitFor(() => screen.getByText("Unsaved changes"));
    expect(confirmNavigation()).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    // Saved ⇒ clean again, no prompt.
    fireEvent.click(screen.getByText("Save invite"));
    await waitFor(() => screen.getByText("All changes saved"));
    expect(confirmNavigation()).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);

    // Unmounted ⇒ the guard unregisters; a dead builder can never veto
    // unrelated navigation, even mid-edit.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "X" } });
    await waitFor(() => screen.getByText("Unsaved changes"));
    unmount();
    expect(confirmNavigation()).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a remove failure inside its own section, not the save bar", async () => {
    authFetchMock.mockResolvedValueOnce(json(WITH_HERO_IMAGE)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ error: "Remove failed upstream" }, 500)); // DELETE
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Remove" })));

    const alert = await waitFor(() => screen.getByText("Remove failed upstream"));
    expect(document.getElementById("invite-hero")!.contains(alert)).toBe(true);
    expect(toastSuccess).not.toHaveBeenCalledWith("Image removed");
  });

  it("renders the composed preview pane and the section jump list", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    // The persistent composed preview (sticky pane at wide widths) exists and
    // composes the guest page; hidden sections read as placeholders.
    const pane = screen.getByLabelText("Invite preview");
    expect(pane.textContent).toContain("Enter Your Code");
    expect(pane.textContent).toContain("hidden until it has content");

    // The sticky jump list mirrors the section order.
    const nav = screen.getByRole("navigation", { name: "Invite sections" });
    expect(nav.textContent).toContain("Hero");
    expect(nav.textContent).toContain("Closing");
  });
});
