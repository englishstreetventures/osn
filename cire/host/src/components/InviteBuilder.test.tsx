// @vitest-environment happy-dom
import { derivePalette, PALETTE_PRESETS, typographyVar } from "@cire/theme";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
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

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

vi.mock("../lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

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
  // Same value as the real catalog's. The builder reads it for the "no design
  // saved yet" fallback, and `design-layout.ts` for an unrecognised id — a mock
  // missing it fails at import, not at an assertion.
  DEFAULT_DESIGN_ID: "classic",
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
import {
  authFetchMock,
  resetOrganiserMocks,
  toastError,
  toastSuccess,
} from "../test-support/mocks";
import InviteBuilder, { isDesignLocked, SECTION_MENU_COLUMNS } from "./InviteBuilder";

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

/** Switches the builder's tabbed nav to the named section. The builder shows
 *  one section at a time now — every OTHER section's controls are hidden
 *  (native `hidden` attribute), which takes them out of the accessibility
 *  tree, so a test reaching for a control by role must select its tab first.
 *  (`getByLabelText`/`getByText` don't filter on `hidden`, so tests using
 *  those queries are unaffected and need no tab switch.) */
async function openSection(label: string | RegExp) {
  const tab = await waitFor(() => screen.getByRole("tab", { name: label }));
  fireEvent.click(tab);
}

describe("InviteBuilder theme", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
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
    // The inline preview only mounts on its own tab (P-I2).
    await openSection("Welcome");

    // The section fieldset carries its legend AND a live preview card.
    expect(screen.getAllByText("Code Entry & Welcome").length).toBeGreaterThanOrEqual(2);
    screen.getByLabelText("Code Entry & Welcome preview");

    // "Gilt colour" lives in the (now hidden, but still mounted) Look
    // section — `fireEvent` doesn't filter on the `hidden` attribute.
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
    // The Hero inline preview only mounts on its own tab (P-I2); "Fog" (the
    // Look section's preset picker) is clickable regardless of active tab.
    await openSection(/^Hero/);

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
    await openSection("Hero");

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
    await openSection(/^Hero/);

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
    await openSection(/^Hero/);

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

    // Each guest-page section has its own labelled preview card — but only
    // one is mounted at a time now (P-I2), one tab per section.
    await openSection(/^Our Story/);
    screen.getByLabelText("Our Story preview");

    await openSection("Welcome");
    screen.getByLabelText("Code Entry & Welcome preview");

    await openSection("Events");
    const events = screen.getByLabelText("Events Section preview");
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
    resetOrganiserMocks();
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
    resetOrganiserMocks();
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

  it("re-shapes the live preview when the design changes, not just the radio card", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION)); // initial load
    authFetchMock.mockResolvedValueOnce(json({ ...EMPTY_CUSTOMISATION, designId: "gala" }));

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);

    // Both preview layers mount while the builder's width is unmeasurable (see
    // `previewLayer`), so the composed pane is reachable here.
    await waitFor(() =>
      expect(screen.getAllByLabelText("Invite preview").length).toBeGreaterThan(0),
    );
    const pane = () => screen.getAllByLabelText("Invite preview")[0]!;
    // Classic: no events hairline, no inset code-entry panel. (Alignment is
    // deliberately NOT asserted on the classic side here — the hidden-section
    // placeholder strips carry `text-center` whatever the design, so that
    // assertion could not fail. `previews.test.tsx` pins alignment per sample.)
    expect(pane().querySelector("hr")).toBeNull();
    expect(pane().querySelector(".m-4")).toBeNull();
    expect(screen.getAllByTestId("preview-design")[0]!.textContent).toContain("Classic");

    fireEvent.click(screen.getByRole("radio", { name: /Gala/ }));

    // Gala: left-aligned copy, the events hairline, and the inset code-entry
    // panel — the last of which flows through PreviewPane's own
    // `panel={layout().welcome === "panel"}` wiring, not just the sample's.
    // The miniature used to be pixel-identical either side of this click.
    await waitFor(() =>
      expect(screen.getAllByTestId("preview-design")[0]!.textContent).toContain("Gala"),
    );
    expect(pane().querySelector(".text-left")).toBeTruthy();
    expect(pane().querySelector("hr")).toBeTruthy();
    expect(pane().querySelector(".m-4")).toBeTruthy();
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
    resetOrganiserMocks();
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

    // Both slots offer the plain crop; only the hero offers the phone one —
    // checked one tab at a time, since the builder shows one section at a time.
    await openSection("Hero");
    await waitFor(() => screen.getByRole("button", { name: "Phone crop" }));
    expect(screen.getAllByRole("button", { name: "Crop" }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: "Phone crop" }).length).toBe(1);

    await openSection("Our Story");
    await waitFor(() => screen.getByRole("button", { name: "Crop" }));
    expect(screen.queryByRole("button", { name: "Phone crop" })).toBeNull();
  });

  it("a phone-crop save PUTs { crop, screen: 'mobile' } to the hero crop route", async () => {
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // initial load
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES)); // crop save

    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await openSection("Hero");

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
    await openSection("Hero");

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
    await openSection("Hero");

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
    await openSection("Hero");

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
    resetOrganiserMocks();

    // Without a saved phone crop the thumbnail is absent.
    authFetchMock.mockResolvedValueOnce(json(WITH_IMAGES));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await openSection("Hero");
    await waitFor(() => screen.getByRole("button", { name: "Phone crop" }));
    expect(screen.queryByLabelText("Hero background image (phone crop)")).toBeNull();
  });
});

describe("InviteBuilder UX guards", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
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
    await openSection("Hero");

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
    await openSection("Hero");

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
    await openSection("Hero");

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

  it("shows one section at a time via the native `hidden` attribute", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    // Design is the default active tab; every other section starts hidden.
    expect(document.getElementById("invite-design")!.hidden).toBe(false);
    expect(document.getElementById("invite-hero")!.hidden).toBe(true);

    // Switching tabs flips which fieldset carries `hidden` — the switch is a
    // real attribute toggle, not a CSS class the DOM can't see. Regex name
    // match: with `EMPTY_CUSTOMISATION` the Hero tab's accessible name is
    // "Hero (hidden — empty)" (the sr-only Shown/Hidden suffix), not "Hero".
    await openSection(/^Hero/);
    expect(document.getElementById("invite-design")!.hidden).toBe(true);
    expect(document.getElementById("invite-hero")!.hidden).toBe(false);
  });

  it("wires the section tabs to their panels via aria-controls/aria-labelledby", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    const designTab = screen.getByRole("tab", { name: "Design" });
    const designPanel = document.getElementById("invite-design")!;
    expect(designPanel.getAttribute("role")).toBe("tabpanel");
    expect(designTab.getAttribute("aria-controls")).toBe(designPanel.id);
    expect(designPanel.getAttribute("aria-labelledby")).toBe(designTab.id);
  });

  it("moves focus AND activation with ArrowRight/ArrowLeft/Home/End (roving tabindex)", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    const designTab = screen.getByRole("tab", { name: "Design" });
    const lookTab = screen.getByRole("tab", { name: "Look" });
    // Only the active tab is in the normal Tab order (roving tabindex).
    expect(designTab.tabIndex).toBe(0);
    expect(lookTab.tabIndex).toBe(-1);

    fireEvent.keyDown(designTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(lookTab);
    expect(lookTab.getAttribute("aria-selected")).toBe("true");
    expect(lookTab.tabIndex).toBe(0);
    expect(designTab.tabIndex).toBe(-1);
    expect(document.getElementById("invite-look")!.hidden).toBe(false);

    fireEvent.keyDown(lookTab, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(designTab);
    expect(designTab.getAttribute("aria-selected")).toBe("true");

    const messageTab = screen.getByRole("tab", { name: "Message" });
    fireEvent.keyDown(designTab, { key: "End" });
    expect(document.activeElement).toBe(messageTab);
    expect(messageTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(messageTab, { key: "Home" });
    expect(document.activeElement).toBe(designTab);
    expect(designTab.getAttribute("aria-selected")).toBe("true");

    // ArrowRight from the last tab wraps around to the first.
    fireEvent.keyDown(messageTab, { key: "End" }); // back to Message
    fireEvent.keyDown(screen.getByRole("tab", { name: "Message" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Design" }));
  });

  it("opens the composed preview in a modal from the mobile Preview button", async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    // No dialog until the button is clicked — the modal is the only way to
    // reach the composed preview below `@4xl/builder`.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const dialog = await waitFor(() =>
      screen.getByRole("dialog", { name: "Invite preview modal" }),
    );
    // The SAME composed preview the sticky side pane renders — one markup
    // source shared via `previewProps()`, not a second copy.
    expect(within(dialog).getByLabelText("Invite preview")).toBeInTheDocument();

    // Live, not a stale snapshot taken when the modal opened.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "Anita & Ben" } });
    await waitFor(() => expect(dialog.textContent).toContain("Anita & Ben"));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

/**
 * The narrow-container section menu (2026-07-30). Below `@3xl/builder` the
 * eight tabs can't share a line, and the row used to be a horizontally
 * scrolling strip with Closing and Message parked off the right edge. They now
 * collapse behind a trigger naming the current section and open as a grid that
 * shows all eight at once.
 *
 * ONE tablist serves both surfaces (a per-surface copy would give every panel
 * two `aria-labelledby` candidates), so what these tests assert is the
 * COLLAPSE: `aria-expanded` on the trigger, the `hidden` class on the tablist,
 * and the dismiss paths. happy-dom applies no CSS, so the container-query swap
 * itself isn't observable here — the class list is the closest honest proxy.
 */
describe("InviteBuilder section menu (narrow containers)", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    vi.unstubAllGlobals();
  });

  const renderBuilder = async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));
  };

  const trigger = () => screen.getByRole("button", { name: /Choose a section/ });
  const tablist = () => screen.getByRole("tablist");

  it("names the current section and its position on the trigger, live", async () => {
    await renderBuilder();

    // Where the organiser IS, without opening anything — the one thing the
    // scrolling strip couldn't tell them about an off-screen section.
    expect(trigger().getAttribute("aria-label")).toBe(
      "Invite section: Design, 1 of 8. Choose a section",
    );
    expect(trigger().textContent).toContain("Design");
    expect(trigger().textContent).toContain("1/8");

    // The Shown/Hidden state rides the LABEL, not just the dot: the dot is
    // `aria-hidden` and an `aria-label` overrides subtree content, so an
    // `sr-only` span in the button would be dropped. Without this clause the
    // collapsed trigger conveys three things visually and two to a screen
    // reader — and "you can read it instead of opening it" stops being true.
    await openSection(/^Closing/);
    expect(trigger().getAttribute("aria-label")).toBe(
      "Invite section: Closing, 7 of 8, hidden — empty. Choose a section",
    );
    expect(trigger().textContent).toContain("7/8");

    await openSection(/^Hero/);
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "Anita & Ben" } });
    await waitFor(() =>
      expect(trigger().getAttribute("aria-label")).toBe(
        "Invite section: Hero, 3 of 8, shown. Choose a section",
      ),
    );
  });

  it("mirrors the active section's Shown/Hidden dot on the trigger, live", async () => {
    await renderBuilder();
    const dot = () => trigger().querySelector(".rounded-full");

    // Design has no Shown/Hidden state at all — no dot to mislead with.
    expect(dot()).toBeNull();

    // Hero starts empty on `EMPTY_CUSTOMISATION`, so the guest invite hides it.
    await openSection(/^Hero/);
    expect(dot()!.className).toContain("bg-text-muted/50");

    // The dot flips the instant an edit gives the section content — it's the
    // whole reason the trigger can be read instead of opened.
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "Anita & Ben" } });
    await waitFor(() => expect(dot()!.className).toContain("bg-gold"));
  });

  it("collapses the tablist behind the trigger and toggles it", async () => {
    await renderBuilder();

    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBe(tablist().id);
    expect(tablist().classList.contains("hidden")).toBe(true);

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(tablist().classList.contains("hidden")).toBe(false);

    // All eight reachable in one screen — the point of replacing the strip.
    expect(within(tablist()).getAllByRole("tab")).toHaveLength(8);

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a selection and hands focus back to the trigger", async () => {
    await renderBuilder();
    fireEvent.click(trigger());

    fireEvent.click(within(tablist()).getByRole("tab", { name: "Message" }));

    expect(document.getElementById("invite-message")!.hidden).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // Collapsing takes the clicked tab to `display: none` and focus with it —
    // the trigger is where focus has to land.
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves focus alone when a tab is clicked with the menu closed (wide row)", async () => {
    await renderBuilder();

    const lookTab = screen.getByRole("tab", { name: "Look" });
    lookTab.focus();
    fireEvent.click(lookTab);

    expect(document.getElementById("invite-look")!.hidden).toBe(false);
    expect(document.activeElement).toBe(lookTab);
  });

  it("closes on Escape from a tab, and on a press outside the nav", async () => {
    await renderBuilder();

    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("tab", { name: "Design" }), { key: "Escape" });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"));

    // A press INSIDE the nav (the tablist's own padding) leaves it open.
    fireEvent.click(trigger());
    fireEvent.pointerDown(tablist());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    // Escape works from the TRIGGER too, not just from a tab — its own handler,
    // reached whenever the menu was opened by keyboard and focus never moved.
    fireEvent.keyDown(trigger(), { key: "Escape" });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses the menu when the container grows past the static-row threshold", async () => {
    // A resizable stub: happy-dom runs no layout, so the only way to exercise a
    // container CROSSING the threshold is to drive the callback by hand.
    let report: ((width: number) => void) | undefined;
    class ResizableObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        report = (width) =>
          this.callback(
            [{ contentRect: { width } } as unknown as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        report(600); // narrow: the menu surface
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizableObserver);
    await renderBuilder();

    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    // Rotate / resize / collapse the dashboard rail — the tabs become the static
    // row, which the open menu must not outlive. Left `true`, `selectSection`
    // would "close" it on every wide tab click, focusing a `display: none`
    // trigger and dropping focus to the body.
    report!(900);
    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"));

    // The tab click that the stale state would have broken: focus stays put.
    const lookTab = screen.getByRole("tab", { name: "Look" });
    lookTab.focus();
    fireEvent.click(lookTab);
    expect(document.activeElement).toBe(lookTab);
    expect(document.body).not.toBe(document.activeElement);

    // 48rem at the 16px root `global.css` pins — the same content box
    // `@3xl/builder` measures, so the JS collapse can't drift from the CSS swap.
    report!(767);
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    report!(768);
    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"));
  });

  it("keeps ONE tablist whose tabs stay in the DOM while collapsed", async () => {
    await renderBuilder();

    // The narrow surface re-lays-out the same tablist rather than rendering a
    // second copy: a duplicate would give every panel two `aria-labelledby`
    // candidates and assistive tech two tabs widgets for one set of panels.
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("tab")).toHaveLength(8);

    // Collapsed, the tabs are `display: none` — but they must remain IN the
    // document, because each panel's accessible name is computed from its tab
    // (accname follows `aria-labelledby` into hidden subtrees; it cannot follow
    // it into an unmounted node).
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    for (const panel of ["invite-design", "invite-hero", "invite-message"]) {
      const labelledBy = document.getElementById(panel)!.getAttribute("aria-labelledby")!;
      expect(document.getElementById(labelledBy)).toBeInTheDocument();
    }
  });

  it("steps DOWN the open grid by a row, not along it", async () => {
    await renderBuilder();
    fireEvent.click(trigger());

    // Row-major two-column grid: Design|Look / Hero|Our Story / … — so from
    // Design, "down" is Hero (+2), and aliasing it to Look (+1, the item to the
    // RIGHT) would make the arrows disagree with what the organiser can see.
    const designTab = screen.getByRole("tab", { name: "Design" });
    fireEvent.keyDown(designTab, { key: "ArrowDown" });
    const heroTab = screen.getByRole("tab", { name: /^Hero/ });
    expect(document.activeElement).toBe(heroTab);
    expect(document.getElementById("invite-hero")!.hidden).toBe(false);

    fireEvent.keyDown(heroTab, { key: "ArrowUp" });
    expect(document.activeElement).toBe(designTab);

    // The horizontal pair still steps one, along the row.
    fireEvent.keyDown(designTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Look" }));

    // Stepping keeps the menu open — only Escape, a selection, an outside press
    // or focus leaving the nav dismisses it.
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("leaves ArrowDown/ArrowUp to the browser on the wide static row", async () => {
    await renderBuilder();

    // Closed ⇒ the wide surface, where the tablist is one horizontal line. APG
    // reserves Down/Up for the page there, and the row this replaced let a
    // keyboard user scroll from a focused tab — swallowing that is a regression.
    const designTab = screen.getByRole("tab", { name: "Design" });
    designTab.focus();
    const down = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      cancelable: true,
      bubbles: true,
    });
    designTab.dispatchEvent(down);

    expect(down.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(designTab);
    expect(document.getElementById("invite-design")!.hidden).toBe(false);
  });

  it("closes when focus leaves the nav, so it can't obscure the field focus lands in", async () => {
    await renderBuilder();
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    // Tabbing forward out of the menu used to leave it up — an opaque overlay
    // across the top of the active section, with focus in a form field behind
    // it and no keyboard way to uncover it (WCAG 2.2 SC 2.4.11).
    const outside = screen.getByRole("button", { name: "Preview" });
    fireEvent.focusOut(tablist(), { relatedTarget: outside });
    await waitFor(() => expect(trigger().getAttribute("aria-expanded")).toBe("false"));

    // Focus moving WITHIN the nav (tab → tab, or the close's own restore to the
    // trigger) must not dismiss it.
    fireEvent.click(trigger());
    fireEvent.focusOut(tablist(), { relatedTarget: trigger() });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the arrow step in lockstep with the grid's column count", async () => {
    await renderBuilder();

    // `ArrowDown` steps by SECTION_MENU_COLUMNS, but the column count is a CSS
    // fact the handler can't read back — and Tailwind only emits utilities it
    // finds as literal source text, so the class can't be built from the
    // constant either. This is the checkable half of that pair.
    expect(tablist().className).toContain(`grid-cols-${SECTION_MENU_COLUMNS}`);
  });
});

/**
 * Which preview layer is MOUNTED (perf P-I1). Both layers used to be mounted at
 * every width with a container query hiding one, so the idle layer still took
 * every token write on every keystroke and colour drag. The builder now measures
 * its own container and mounts only the matching layer.
 *
 * happy-dom runs no layout, so a real `ResizeObserver` would never report a
 * width — these tests supply one that reports the width under test, which is the
 * only way to exercise the decision at all. The no-observer case is the fallback
 * every other test in this file relies on.
 */
describe("InviteBuilder preview layer", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    vi.unstubAllGlobals();
  });

  /** A ResizeObserver that reports one fixed CONTENT-box width on observe —
   *  the same box a container query evaluates. */
  function stubResizeObserver(width: number) {
    class FixedWidthResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FixedWidthResizeObserver);
  }

  const renderBuilder = async () => {
    authFetchMock.mockResolvedValueOnce(json(EMPTY_CUSTOMISATION));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));
  };

  /** The inline per-section previews, counted inside the five section cards that
   *  carry one. Scoped rather than counted globally because `PaletteField`'s
   *  swatch strip — always mounted, in the Look card — uses the same label. */
  const inlinePreviewCount = () =>
    ["invite-hero", "invite-story", "invite-welcome", "invite-events", "invite-closing"]
      .map((id) => within(document.getElementById(id)!).queryAllByText("Live preview").length)
      .reduce((total, n) => total + n, 0);

  it("mounts only the composed pane on a wide builder", async () => {
    // 1200px content box, past the 56rem (896px) `@4xl/builder` crossover.
    stubResizeObserver(1200);
    await renderBuilder();

    expect(screen.getByLabelText("Invite preview")).toBeInTheDocument();
    expect(inlinePreviewCount()).toBe(0);
  });

  it("mounts only the ACTIVE section's inline preview on a narrow builder", async () => {
    stubResizeObserver(600);
    await renderBuilder();

    expect(screen.queryByLabelText("Invite preview")).not.toBeInTheDocument();
    // Design (the default tab) has no inline preview at all.
    expect(inlinePreviewCount()).toBe(0);

    // Switching tabs mounts exactly the active section's preview (P-I2) — a
    // hidden tab's inline preview is unmounted, not merely hidden, so it
    // isn't re-rendering on every keystroke for no one to see.
    await openSection(/^Hero/);
    expect(inlinePreviewCount()).toBe(1);
    expect(
      within(document.getElementById("invite-hero")!).queryAllByText("Live preview"),
    ).toHaveLength(1);

    await openSection(/^Our Story/);
    expect(inlinePreviewCount()).toBe(1);
    expect(
      within(document.getElementById("invite-hero")!).queryAllByText("Live preview"),
    ).toHaveLength(0);
    expect(
      within(document.getElementById("invite-story")!).queryAllByText("Live preview"),
    ).toHaveLength(1);
  });

  /**
   * The closing crop has to REACH the preview. `SectionSample` degrades silently
   * without it — the uncropped `<img>` branch still renders something plausible
   * — so deleting either wiring line (the `closingSlot` memo's `imageCrop`, or
   * the prop on the inline sample) restores the pre-branch lie, "what you frame
   * is not what publishes", with the whole suite green. The `SectionSample` unit
   * tests pass the prop directly and structurally cannot see this seam.
   */
  const WITH_CLOSING_CROP = {
    ...EMPTY_CUSTOMISATION,
    footer: {
      message: null,
      imageUrl: "/api/organiser/weddings/wed_1/invite/image/footer?v=3",
      // 2:1 pixel aspect — (0.5·1000) / (0.5·500).
      imageCrop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5, natW: 1000, natH: 500 },
    },
  };

  /** The preview band, asserted to be the CROPPED render: only that path sets an
   *  aspect-ratio and a background-image. */
  const expectCroppedBand = () => {
    const band = screen.getByRole("img", { name: "Closing section artwork" });
    expect(band.style.getPropertyValue("aspect-ratio")).toBe("2 / 1");
    expect(band.style.getPropertyValue("background-image")).toContain("variant=card");
    return band;
  };

  it("feeds the saved closing crop to the inline preview", async () => {
    stubResizeObserver(600);
    authFetchMock.mockResolvedValueOnce(json(WITH_CLOSING_CROP));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByText("Save invite"));

    await openSection("Closing");
    expect(await waitFor(() => expectCroppedBand())).toBeInTheDocument();
  });

  it("feeds the saved closing crop to the composed preview pane", async () => {
    stubResizeObserver(1200);
    authFetchMock.mockResolvedValueOnce(json(WITH_CLOSING_CROP));
    render(() => <InviteBuilder weddingId="wed_1" weddingSlug="anita-ben" entitlements={[]} />);
    await waitFor(() => screen.getByLabelText("Invite preview"));

    // The pass-through the pane adds on top of the inline path: its own
    // `PreviewPaneProps["closing"].imageCrop` field.
    expect(await waitFor(() => expectCroppedBand())).toBeInTheDocument();
  });

  it("keeps the crossover on the same content box as @4xl/builder", async () => {
    // Exactly 56rem at the root 16px `global.css` pins: the container query is
    // `width >= 56rem`, so this width is WIDE. One pixel less is not.
    stubResizeObserver(896);
    await renderBuilder();
    expect(screen.getByLabelText("Invite preview")).toBeInTheDocument();

    cleanup();
    resetOrganiserMocks();
    stubResizeObserver(895);
    await renderBuilder();
    expect(screen.queryByLabelText("Invite preview")).not.toBeInTheDocument();
  });

  it("mounts both layers when the width cannot be measured", async () => {
    // No ResizeObserver (and a 0-width report means `display: none`, not narrow)
    // — unmounting a layer we can't measure could leave the organiser with no
    // preview at all, so the CSS classes stay in charge and both are mounted.
    // The inline layer is additionally gated to the active tab (P-I2), so
    // switch to one that carries a preview to exercise the overlap.
    vi.stubGlobal("ResizeObserver", undefined);
    await renderBuilder();
    await openSection(/^Hero/);

    expect(screen.getByLabelText("Invite preview")).toBeInTheDocument();
    expect(inlinePreviewCount()).toBe(1);
  });

  it("treats a zero-width report as unmeasured, not narrow", async () => {
    stubResizeObserver(0);
    await renderBuilder();
    await openSection(/^Hero/);

    expect(screen.getByLabelText("Invite preview")).toBeInTheDocument();
    expect(inlinePreviewCount()).toBe(1);
  });
});
