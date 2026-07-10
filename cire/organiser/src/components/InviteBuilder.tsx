import { useAuth } from "@osn/client/solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { contrastRatio, WCAG_TEXT_MIN } from "../lib/contrast";
import {
  CROP_ASPECT,
  cropAspectRatio,
  cropBackgroundStyle,
  type CropSlot,
  type ImageCrop,
} from "../lib/image-crop";
import { isHeroEmpty, isStoryEmpty } from "../lib/invite-emptiness";
import { previewSectionVars, resolveSectionTheme } from "../lib/invite-theme-preview";
import type { PreviewTheme, ThemeSection } from "../lib/invite-theme-preview";
import ColorPicker from "./ColorPicker";
import ImageCropModal from "./ImageCropModal";

type ImageSlot = "hero" | "story";

// Closed font allow-list — mirrors FONT_CHOICES in cire/api. The value is the
// only thing persisted; the guest site owns the concrete font stack. Kept in
// sync by hand (a server-side enum miss would 400 anyway).
const FONT_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "cormorant", label: "Cormorant (serif)" },
  { value: "lato", label: "Lato (sans)" },
  { value: "georgia", label: "Georgia (serif)" },
  { value: "system-sans", label: "System sans" },
  { value: "system-mono", label: "System mono" },
] as const;

interface InviteTheme {
  headingFont: string | null;
  bodyFont: string | null;
  hero: { accentColor: string | null; surfaceColor: string | null };
  story: { accentColor: string | null; surfaceColor: string | null };
  details: { accentColor: string | null; surfaceColor: string | null };
  // The guest site's invite-code entry form + post-claim welcome banner.
  // Optional on the wire only until cire-api ships migration 0027 (the seed
  // below already coalesces a missing section to "keep the defaults").
  welcome?: { accentColor: string | null; surfaceColor: string | null };
}

// Hero display sliders (organiser choice; migration 0018 replaced the coarse
// enums). The API coalesces a missing row to these today's-look defaults:
//   blur 28 (soft backdrop) / title backdrop opacity 0, blur 0 (no panel).
interface HeroDisplay {
  blur: number;
  titleBackdrop: { opacity: number; blur: number };
}

// Slider ranges — mirror the clamp bounds in cire/api schemas/invite.ts.
const HERO_BLUR_MIN = 0;
const HERO_BLUR_MAX = 40;
const HERO_BLUR_DEFAULT = 28;
const BACKDROP_OPACITY_MIN = 0;
const BACKDROP_OPACITY_MAX = 100;
const BACKDROP_BLUR_MIN = 0;
const BACKDROP_BLUR_MAX = 20;

// The guest hero's dark gradient fallback, for the WYSIWYG hero preview (mirrors
// InviteHeader's base layer). Kept local — the organiser must never import
// cire/web internals.
const PREVIEW_HERO_GRADIENT =
  "linear-gradient(160deg, oklch(27.87% 0.0393 149.62) 0%, oklch(19.96% 0.0331 147.34) 40%, oklch(22.70% 0.0275 152.78) 100%)";

// The guest hero's title-panel base when no surface colour is picked. The guest
// falls back to BLACK here (not the section surface token), so the preview must
// too or it would lie about the default look.
const PREVIEW_PANEL_BASE = "oklch(0% 0 0)";

interface InviteCustomisation {
  hero: {
    title: string | null;
    subtitle: string | null;
    imageUrl: string | null;
    imageCrop: ImageCrop | null;
  };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
    imageCrop: ImageCrop | null;
  };
  // Events-section header copy + post-claim welcome greeting (migration 0028).
  // Optional on the wire so a mid-deploy payload from an older API seeds the
  // fields as "use the defaults" instead of crashing the builder.
  details?: { eyebrow: string | null; heading: string | null };
  welcome?: { message: string | null };
  heroDisplay: HeroDisplay;
  theme: InviteTheme;
  // Optional host override for the first line of the copyable invite message
  // (the line above the auto-appended guest-site URL + family code).
  inviteMessage: string | null;
}

interface InviteBuilderProps {
  weddingId: string;
}

/** A "default" font selection collapses to null (keep the built-in token). */
function fontOrDefault(value: string): string | null {
  return value === "default" ? null : value;
}

// The built-in default copy, shown as placeholders so an organiser can see what
// they're overriding. Mirrors the guest site's neutral hardcoded fallbacks.
const DEFAULTS = {
  heroTitle: "You're Invited",
  heroSubtitle: "We can't wait to celebrate with you",
  storyEyebrow: "Our Story",
  storyHeading: "How It All Began",
  storyBody:
    "Every love story is beautiful, and we can't wait to celebrate the next chapter of ours with the people we love most…",
  detailsEyebrow: "Celebrate With Us",
  detailsHeading: "Your Events",
  welcomeMessage: "We are delighted to invite you to celebrate with us.",
};

/** Trimmed live copy (or the default when blank), truncated to fit a preview card. */
function sampleCopy(value: string, fallback: string, max = 90): string {
  const text = value.trim().length > 0 ? value.trim() : fallback;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Invite builder — lets the signed-in organiser customise the guest invite. It
 * is structured as one card per guest-page section, **in the order a guest
 * scrolls them** (Hero → Our Story → Code Entry & Welcome → Events), and each
 * card owns EVERYTHING about its section: image, copy, colours, and a live
 * preview. Global typography sits first (it applies to every section), the
 * copyable invite message last (it is not part of the guest page). One sticky
 * "Save invite" action persists the lot — the API's text/theme endpoint split
 * is an implementation detail the organiser never sees. The event + guest
 * source of truth stays in the CSV import; this only layers presentation.
 */
export default function InviteBuilder(props: InviteBuilderProps) {
  const { authFetch } = useAuth();

  const base = () => `/api/organiser/weddings/${props.weddingId}/invite`;

  const [data, { mutate, refetch }] = createResource<InviteCustomisation>(async () => {
    const res = await authFetch(apiUrl(base()));
    if (res.status === 401) {
      redirectToLogin();
      throw new Error("unauthorised");
    }
    if (!res.ok) throw new Error(`Could not load invite (${res.status}).`);
    return (await res.json()) as InviteCustomisation;
  });

  // Local edit buffers for the text fields, seeded from the loaded data.
  const [heroTitle, setHeroTitle] = createSignal("");
  const [heroSubtitle, setHeroSubtitle] = createSignal("");
  const [storyEyebrow, setStoryEyebrow] = createSignal("");
  const [storyHeading, setStoryHeading] = createSignal("");
  const [storyBody, setStoryBody] = createSignal("");
  const [detailsEyebrow, setDetailsEyebrow] = createSignal("");
  const [detailsHeading, setDetailsHeading] = createSignal("");
  const [welcomeMessage, setWelcomeMessage] = createSignal("");
  const [inviteMessage, setInviteMessage] = createSignal("");
  const [seeded, setSeeded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Theme edit buffers. Fonts default to "default"; each section's accent +
  // surface colours are nullable (null ⇒ keep the built-in token).
  const [headingFont, setHeadingFont] = createSignal("default");
  const [bodyFont, setBodyFont] = createSignal("default");
  const [accent, setAccent] = createSignal<Record<ThemeSection, string | null>>({
    hero: null,
    story: null,
    details: null,
    welcome: null,
  });
  const [surface, setSurface] = createSignal<Record<ThemeSection, string | null>>({
    hero: null,
    story: null,
    details: null,
    welcome: null,
  });

  // Hero display sliders. Default to today's look (blur 28 backdrop, no title
  // panel); saved with everything else by the single Save invite action.
  const [heroBlur, setHeroBlur] = createSignal(HERO_BLUR_DEFAULT);
  const [titleBackdropOpacity, setTitleBackdropOpacity] = createSignal(0);
  const [titleBackdropBlur, setTitleBackdropBlur] = createSignal(0);

  // Seed the edit buffers once, when the resource first resolves.
  function seed(d: InviteCustomisation) {
    if (seeded()) return;
    setHeroTitle(d.hero.title ?? "");
    setHeroSubtitle(d.hero.subtitle ?? "");
    setStoryEyebrow(d.story.eyebrow ?? "");
    setStoryHeading(d.story.heading ?? "");
    setStoryBody(d.story.body ?? "");
    setDetailsEyebrow(d.details?.eyebrow ?? "");
    setDetailsHeading(d.details?.heading ?? "");
    setWelcomeMessage(d.welcome?.message ?? "");
    setInviteMessage(d.inviteMessage ?? "");
    setHeadingFont(d.theme.headingFont ?? "default");
    setBodyFont(d.theme.bodyFont ?? "default");
    setAccent({
      hero: d.theme.hero.accentColor,
      story: d.theme.story.accentColor,
      details: d.theme.details.accentColor,
      welcome: d.theme.welcome?.accentColor ?? null,
    });
    setSurface({
      hero: d.theme.hero.surfaceColor,
      story: d.theme.story.surfaceColor,
      details: d.theme.details.surfaceColor,
      welcome: d.theme.welcome?.surfaceColor ?? null,
    });
    setHeroBlur(d.heroDisplay?.blur ?? HERO_BLUR_DEFAULT);
    setTitleBackdropOpacity(d.heroDisplay?.titleBackdrop?.opacity ?? 0);
    setTitleBackdropBlur(d.heroDisplay?.titleBackdrop?.blur ?? 0);
    // Snapshot the just-seeded state so saveInvite can dirty-check each half.
    savedText = JSON.stringify(textPayload());
    savedTheme = JSON.stringify(themePayload());
    setSeeded(true);
  }

  /** The `/invite/text` request body from the live edit buffers. */
  const textPayload = () => ({
    heroTitle: heroTitle() || null,
    heroSubtitle: heroSubtitle() || null,
    storyEyebrow: storyEyebrow() || null,
    storyHeading: storyHeading() || null,
    storyBody: storyBody() || null,
    detailsEyebrow: detailsEyebrow() || null,
    detailsHeading: detailsHeading() || null,
    welcomeMessage: welcomeMessage() || null,
    inviteMessage: inviteMessage() || null,
  });

  /** The `/invite/theme` request body from the live edit buffers. */
  const themePayload = () => ({
    headingFont: fontOrDefault(headingFont()),
    bodyFont: fontOrDefault(bodyFont()),
    heroAccentColor: accent().hero,
    heroSurfaceColor: surface().hero,
    storyAccentColor: accent().story,
    storySurfaceColor: surface().story,
    detailsAccentColor: accent().details,
    detailsSurfaceColor: surface().details,
    welcomeAccentColor: accent().welcome,
    welcomeSurfaceColor: surface().welcome,
    heroBlur: heroBlur(),
    titleBackdropOpacity: titleBackdropOpacity(),
    titleBackdropBlur: titleBackdropBlur(),
  });

  // Serialised snapshots of the last state the server has (seeded on load,
  // refreshed after each successful PUT). saveInvite compares against these to
  // skip a PUT whose half hasn't changed — a copy-only save must not bump the
  // theme row's `updatedAt` (it doubles as the guest image-cache version, so a
  // gratuitous bump busts the per-variant transform cache and makes guests
  // re-download the hero for zero visual change — P-W1, see
  // [[free-tier-limits]]).
  let savedText = "";
  let savedTheme = "";

  // The live picker state as one PreviewTheme — drives every section preview,
  // wired with the SAME `--invite-*` CSS variables the guest invite consumes
  // (see lib/invite-theme-preview), so each font/colour change is visible
  // instantly, before saving.
  const previewTheme = (): PreviewTheme => ({
    headingFont: fontOrDefault(headingFont()),
    bodyFont: fontOrDefault(bodyFont()),
    accent: accent(),
    surface: surface(),
  });

  // Live "what a guest will see" gates, mirroring the guest invite's emptiness
  // predicates. Driven by the edit buffers (so the badge flips the instant the
  // organiser types) plus the loaded image URL (image upload/remove refetches
  // `data`). The hero/story sections are HIDDEN on the live invite when these
  // report empty — the badges below surface that before the organiser saves.
  const heroShown = () =>
    !isHeroEmpty({
      imageUrl: data()?.hero.imageUrl,
      title: heroTitle(),
      subtitle: heroSubtitle(),
    });
  const storyShown = () =>
    !isStoryEmpty({
      heading: storyHeading(),
      body: storyBody(),
      imageUrl: data()?.story.imageUrl,
    });

  /**
   * The single save. The API keeps its two endpoints (`/text` + `/theme`) but
   * the organiser sees ONE action. Each half is DIRTY-CHECKED against the last
   * server-acknowledged snapshot and skipped when unchanged — a copy-only edit
   * must not touch the theme row (its `updatedAt` bump would bust the guest
   * image caches for nothing, P-W1), and a no-op save makes no network call at
   * all. Dirty halves run sequentially; each successful response refreshes its
   * snapshot and mutates the loaded data immediately (so a text success
   * followed by a theme failure leaves the UI consistent with what the server
   * actually saved), and whichever half fails surfaces its own error.
   */
  async function saveInvite(e: Event) {
    e.preventDefault();
    setError(null);

    const textBody = JSON.stringify(textPayload());
    const themeBody = JSON.stringify(themePayload());
    const textDirty = textBody !== savedText;
    const themeDirty = themeBody !== savedTheme;
    if (!textDirty && !themeDirty) {
      toast.success("No changes to save");
      return;
    }

    setSaving(true);
    try {
      if (textDirty) {
        const textRes = await authFetch(apiUrl(`${base()}/text`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: textBody,
        });
        if (!textRes.ok) {
          const body = (await textRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Save failed (${textRes.status})`);
        }
        savedText = textBody;
        mutate((await textRes.json()) as InviteCustomisation);
      }

      if (themeDirty) {
        const themeRes = await authFetch(apiUrl(`${base()}/theme`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: themeBody,
        });
        if (!themeRes.ok) {
          const body = (await themeRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Save failed (${themeRes.status})`);
        }
        savedTheme = themeBody;
        mutate((await themeRes.json()) as InviteCustomisation);
      }
      toast.success("Invite saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function uploadImage(slot: ImageSlot, file: File) {
    setError(null);
    try {
      const res = await authFetch(apiUrl(`${base()}/image/${slot}`), {
        method: "POST",
        body: file,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Upload failed (${res.status})`);
      }
      await refetch();
      toast.success(`${slot === "hero" ? "Hero" : "Story"} image updated`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Upload failed.");
    }
  }

  async function removeImage(slot: ImageSlot) {
    setError(null);
    try {
      const res = await authFetch(apiUrl(`${base()}/image/${slot}`), { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Remove failed (${res.status})`);
      }
      mutate((await res.json()) as InviteCustomisation);
      toast.success("Image removed");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Remove failed.");
    }
  }

  // Save (or reset, with `crop: null`) a slot's crop rectangle. Mutates the loaded
  // data with the returned customisation so the thumbnail re-renders the new crop.
  // Throws on failure so the modal can keep itself open and surface a retry.
  async function saveCrop(slot: ImageSlot, crop: ImageCrop | null) {
    const res = await authFetch(apiUrl(`${base()}/image/${slot}/crop`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crop }),
    });
    if (res.status === 401) {
      redirectToLogin();
      throw new Error("unauthorised");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Save failed (${res.status})`);
    }
    mutate((await res.json()) as InviteCustomisation);
    toast.success(crop ? "Crop saved" : "Crop reset");
  }

  return (
    <section class="border-border bg-surface/30 flex flex-col gap-8 rounded-sm border p-6">
      <header class="flex flex-col gap-1">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">Invite Builder</p>
        <h2 class="font-display text-text text-[1.4rem] font-light italic">
          Customise your invite
        </h2>
        <p class="font-body text-text-muted text-[0.82rem]">
          Each card below is one section of the guest invite, in the order guests see them — images,
          copy and colours together. Events and guests still come from your spreadsheet import.
        </p>
      </header>

      <Show
        when={data()}
        fallback={
          <p class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase">
            Loading invite…
          </p>
        }
      >
        {(d) => {
          seed(d());
          return (
            <div class="flex flex-col gap-8">
              {/* ── Typography (global) ──────────────────────────────── */}
              <fieldset class="border-border flex flex-col gap-4 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Typography
                </legend>
                <p class="font-body text-text-muted text-[0.82rem]">
                  Two fonts for the whole invite — headings and body text. Shown live in every
                  section preview below.
                </p>
                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FontField label="Heading font" value={headingFont()} onChange={setHeadingFont} />
                  <FontField label="Body font" value={bodyFont()} onChange={setBodyFont} />
                </div>
              </fieldset>

              {/* ── Hero ─────────────────────────────────────────────── */}
              <fieldset class="border-border flex flex-col gap-4 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Hero
                </legend>
                <SegmentBadge shown={heroShown()} />
                <ImageField
                  label="Hero background image"
                  slot="hero"
                  url={d().hero.imageUrl}
                  crop={d().hero.imageCrop}
                  onSelect={(f) => void uploadImage("hero", f)}
                  onRemove={() => void removeImage("hero")}
                  onSaveCrop={(c) => saveCrop("hero", c)}
                />
                <TextField
                  label="Couple title"
                  placeholder={DEFAULTS.heroTitle}
                  value={heroTitle()}
                  onInput={setHeroTitle}
                />
                <TextField
                  label="Subtitle"
                  placeholder={DEFAULTS.heroSubtitle}
                  value={heroSubtitle()}
                  onInput={setHeroSubtitle}
                />
                <SectionColours
                  accent={accent().hero}
                  surface={surface().hero}
                  surfaceHint="The panel behind the title (with the backdrop sliders below)."
                  onAccent={(v) => setAccent((p) => ({ ...p, hero: v }))}
                  onSurface={(v) => setSurface((p) => ({ ...p, hero: v }))}
                />
                <SliderField
                  label="Hero image blur"
                  hint="0 is a sharp photo; higher is a softer, dreamier backdrop."
                  min={HERO_BLUR_MIN}
                  max={HERO_BLUR_MAX}
                  value={heroBlur()}
                  onInput={setHeroBlur}
                />
                <SliderField
                  label="Title backdrop opacity"
                  hint="A panel behind the title so it reads over a busy photo. 0 is no panel."
                  min={BACKDROP_OPACITY_MIN}
                  max={BACKDROP_OPACITY_MAX}
                  value={titleBackdropOpacity()}
                  onInput={setTitleBackdropOpacity}
                />
                <SliderField
                  label="Title backdrop blur"
                  hint="Frosts the photo behind the title panel (px)."
                  min={BACKDROP_BLUR_MIN}
                  max={BACKDROP_BLUR_MAX}
                  value={titleBackdropBlur()}
                  onInput={setTitleBackdropBlur}
                />
                {/* One WYSIWYG preview for the whole section: image + client-side
                    blur + title panel + the section's accent/fonts, live as the
                    controls change — no Cloudflare Images calls. */}
                <HeroPreview
                  imageUrl={d().hero.imageUrl}
                  title={heroTitle()}
                  heroBlur={heroBlur()}
                  backdropOpacity={titleBackdropOpacity()}
                  backdropBlur={titleBackdropBlur()}
                  theme={previewTheme()}
                />
              </fieldset>

              {/* ── Our Story ────────────────────────────────────────── */}
              <fieldset class="border-border flex flex-col gap-4 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Our Story
                </legend>
                <SegmentBadge shown={storyShown()} />
                <ImageField
                  label="Story photo"
                  slot="story"
                  url={d().story.imageUrl}
                  crop={d().story.imageCrop}
                  onSelect={(f) => void uploadImage("story", f)}
                  onRemove={() => void removeImage("story")}
                  onSaveCrop={(c) => saveCrop("story", c)}
                />
                <TextField
                  label="Eyebrow"
                  placeholder={DEFAULTS.storyEyebrow}
                  value={storyEyebrow()}
                  onInput={setStoryEyebrow}
                />
                <TextField
                  label="Heading"
                  placeholder={DEFAULTS.storyHeading}
                  value={storyHeading()}
                  onInput={setStoryHeading}
                />
                <label class="flex flex-col gap-1.5">
                  <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
                    Story
                  </span>
                  <textarea
                    rows={6}
                    placeholder={DEFAULTS.storyBody}
                    value={storyBody()}
                    onInput={(e) => setStoryBody(e.currentTarget.value)}
                    class="border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.88rem] outline-none"
                  />
                </label>
                <SectionColours
                  accent={accent().story}
                  surface={surface().story}
                  onAccent={(v) => setAccent((p) => ({ ...p, story: v }))}
                  onSurface={(v) => setSurface((p) => ({ ...p, story: v }))}
                />
                <SectionPreview
                  label="Our Story"
                  section="story"
                  theme={previewTheme()}
                  eyebrow={sampleCopy(storyEyebrow(), DEFAULTS.storyEyebrow, 40)}
                  heading={sampleCopy(storyHeading(), DEFAULTS.storyHeading, 60)}
                  body={sampleCopy(storyBody(), DEFAULTS.storyBody)}
                />
              </fieldset>

              {/* ── Code Entry & Welcome ─────────────────────────────── */}
              <fieldset class="border-border flex flex-col gap-4 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Code Entry &amp; Welcome
                </legend>
                <p class="font-body text-text-muted text-[0.82rem]">
                  The invite-code entry form, and the greeting a guest sees under their name after
                  entering their code. Leave the greeting blank to use the default. Like the rest of
                  the invite copy, the greeting is part of the public invite page — don't put
                  anything private in it.
                </p>
                <TextField
                  label="Welcome greeting"
                  placeholder={DEFAULTS.welcomeMessage}
                  value={welcomeMessage()}
                  onInput={setWelcomeMessage}
                />
                <SectionColours
                  accent={accent().welcome}
                  surface={surface().welcome}
                  onAccent={(v) => setAccent((p) => ({ ...p, welcome: v }))}
                  onSurface={(v) => setSurface((p) => ({ ...p, welcome: v }))}
                />
                <SectionPreview
                  label="Code Entry & Welcome"
                  section="welcome"
                  theme={previewTheme()}
                  eyebrow="Your Invitation"
                  heading="Enter Your Code"
                  body={sampleCopy(welcomeMessage(), DEFAULTS.welcomeMessage)}
                />
              </fieldset>

              {/* ── Events section ───────────────────────────────────── */}
              <fieldset class="border-border flex flex-col gap-4 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Events Section
                </legend>
                <p class="font-body text-text-muted text-[0.82rem]">
                  The header above the guest's event list. The colours also style the event cards,
                  their buttons and the event pop-ups. The events themselves come from your
                  spreadsheet import.
                </p>
                <TextField
                  label="Events eyebrow"
                  placeholder={DEFAULTS.detailsEyebrow}
                  value={detailsEyebrow()}
                  onInput={setDetailsEyebrow}
                />
                <TextField
                  label="Events heading"
                  placeholder={DEFAULTS.detailsHeading}
                  value={detailsHeading()}
                  onInput={setDetailsHeading}
                />
                <SectionColours
                  accent={accent().details}
                  surface={surface().details}
                  onAccent={(v) => setAccent((p) => ({ ...p, details: v }))}
                  onSurface={(v) => setSurface((p) => ({ ...p, details: v }))}
                />
                <SectionPreview
                  label="Events Section"
                  section="details"
                  theme={previewTheme()}
                  eyebrow={sampleCopy(detailsEyebrow(), DEFAULTS.detailsEyebrow, 40)}
                  heading={sampleCopy(detailsHeading(), DEFAULTS.detailsHeading, 60)}
                  body="Event names, dates and the Respond buttons follow these colours."
                />
              </fieldset>

              {/* ── Invite message (not on the guest page) ───────────── */}
              <fieldset class="border-border flex flex-col gap-4 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Invite message
                </legend>
                <p class="font-body text-text-muted text-[0.82rem]">
                  Not part of the invite page — this is the first line of the message you copy from
                  the Guests tab to send a household. Leave it blank to use the default. The
                  guest-site link and the household's code are added automatically on the two lines
                  below it.
                </p>
                <label class="flex flex-col gap-1.5">
                  <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
                    Invite message (optional)
                  </span>
                  <textarea
                    rows={4}
                    aria-label="Invite message (optional)"
                    placeholder="You're invited to our wedding! View your invitation and RSVP below."
                    value={inviteMessage()}
                    onInput={(e) => setInviteMessage(e.currentTarget.value)}
                    class="border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.88rem] outline-none"
                  />
                  <span class="font-body text-text-muted text-[0.72rem] italic">
                    The wedding link and family code are appended automatically — don't include them
                    here.
                  </span>
                </label>
              </fieldset>

              {/* ── Save bar — sticky so it's reachable from any section ── */}
              <div class="border-border bg-bg/90 sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-col gap-3 rounded-b-sm border-t px-6 py-4 backdrop-blur">
                <Show when={error()}>
                  <p
                    class="border-error/20 bg-error/5 text-error rounded-sm border p-3 text-[0.85rem]"
                    role="alert"
                  >
                    {error()}
                  </p>
                </Show>
                <div class="flex flex-wrap items-center gap-4">
                  <button
                    type="button"
                    onClick={(e) => void saveInvite(e)}
                    disabled={saving()}
                    class="border-gold bg-gold font-body text-bg hover:bg-gold-dim rounded-sm border px-5 py-2.5 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                  >
                    {saving() ? "Saving…" : "Save invite"}
                  </button>
                  <span class="font-body text-text-muted text-[0.75rem]">
                    Saves every section — copy, colours, fonts and hero display. Images and crops
                    apply as soon as you upload them.
                  </span>
                </div>
              </div>
            </div>
          );
        }}
      </Show>
    </section>
  );
}

/** Accent + background colour pickers for the enclosing section, each clearable. */
function SectionColours(props: {
  accent: string | null;
  surface: string | null;
  /** Optional extra context for what "Background" means in this section. */
  surfaceHint?: string;
  onAccent: (v: string | null) => void;
  onSurface: (v: string | null) => void;
}) {
  return (
    <div class="flex flex-col gap-1.5">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        Section colours
      </span>
      <div class="flex flex-wrap gap-5">
        <ColorPicker label="Accent" value={props.accent} onChange={props.onAccent} />
        <ColorPicker label="Background" value={props.surface} onChange={props.onSurface} />
      </div>
      <Show when={props.surfaceHint}>
        <span class="font-body text-text-muted text-[0.72rem] italic">{props.surfaceHint}</span>
      </Show>
    </div>
  );
}

/**
 * Live preview card for one section, styled with the SAME `--invite-*` CSS
 * variables the guest invite consumes and driven by the live picker signals +
 * copy buffers, so every colour/font/copy change is visible instantly — before
 * saving. Defaults are substituted (resolveSectionTheme) so an un-picked value
 * previews as the real built-in token — an honest before/after. No guest
 * stylesheet, no Effect/web imports: plain inline `style` with the var names.
 */
function SectionPreview(props: {
  label: string;
  section: ThemeSection;
  theme: PreviewTheme;
  eyebrow: string;
  heading: string;
  body: string;
}) {
  const r = () => resolveSectionTheme(props.theme, props.section);
  return (
    <div class="flex flex-col gap-1.5">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        Live preview
      </span>
      <figure
        aria-label={`${props.label} preview`}
        style={{
          ...previewSectionVars(props.theme, props.section),
          "background-color": "var(--invite-surface)",
          "font-family": "var(--invite-body)",
        }}
        class="border-border flex min-h-28 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-sm border p-4 text-center"
      >
        <span
          style={{ color: "var(--invite-accent)", "font-family": "var(--invite-body)" }}
          class="text-[0.6rem] tracking-[0.18em] uppercase opacity-80"
        >
          {props.eyebrow}
        </span>
        <span
          style={{ color: "var(--invite-accent)", "font-family": "var(--invite-heading)" }}
          class="text-[1.5rem] leading-none font-light italic"
        >
          {props.heading}
        </span>
        {/* Body sample in the body font on the section surface, so the font +
            surface contrast is visible too. Mid-tone so it reads on either a
            light or dark picked surface. */}
        <span
          style={{ color: r().accent }}
          class="max-w-full text-[0.62rem] break-words opacity-55"
        >
          {props.body}
        </span>
        <figcaption class="font-body text-text-muted mt-1 text-[0.62rem] tracking-[0.08em] uppercase">
          {props.label}
        </figcaption>
      </figure>
      <ContrastAdvisory theme={props.theme} section={props.section} />
    </div>
  );
}

/**
 * Live WCAG contrast advisory (WT-C-L1): warns — never blocks — when the
 * section's resolved accent-on-background pair drops below the AA text minimum
 * (4.5:1), since the accent styles real text (eyebrows, headings, buttons; in
 * the welcome section it styles the functionally-critical code-entry form).
 * Defaults are substituted first, so it only fires on the organiser's own
 * picks; an unparseable colour keeps it silent (advisory, not a validator —
 * the server-side allow-list stays the only gate).
 */
function ContrastAdvisory(props: { theme: PreviewTheme; section: ThemeSection }) {
  const ratio = () => {
    const r = resolveSectionTheme(props.theme, props.section);
    return contrastRatio(r.accent, r.surface);
  };
  const low = () => {
    const c = ratio();
    return c !== null && c < WCAG_TEXT_MIN;
  };
  return (
    <Show when={low()}>
      <p
        role="status"
        class="border-error/30 bg-error/5 text-error rounded-sm border px-3 py-2 text-[0.78rem] leading-relaxed"
      >
        Low contrast: this accent on this background is about {ratio()!.toFixed(1)}:1 — text needs
        at least {WCAG_TEXT_MIN}:1 to stay readable for everyone. You can still save it; consider a
        lighter/darker pick.
      </p>
    </Show>
  );
}

/**
 * A small per-section status badge telling the organiser whether this section
 * will render on the live guest invite. "Shown" when it has content; "Hidden —
 * empty" when the guest site would hide it (mirrors the guest-side emptiness
 * predicates in `../lib/invite-emptiness`). It updates live as the fields change.
 */
function SegmentBadge(props: { shown: boolean }) {
  return (
    <span
      data-segment-badge
      data-shown={props.shown ? "true" : "false"}
      class="font-body inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[0.66rem] tracking-[0.1em] uppercase"
      classList={{
        "border-gold/40 text-gold bg-gold/5": props.shown,
        "border-border text-text-muted bg-bg/40": !props.shown,
      }}
    >
      <span
        aria-hidden
        class="inline-block h-1.5 w-1.5 rounded-full"
        classList={{ "bg-gold": props.shown, "bg-text-muted/60": !props.shown }}
      />
      {props.shown ? "Shown" : "Hidden — empty"}
    </span>
  );
}

/**
 * A labelled range slider for a bounded integer hero-display setting (blur,
 * backdrop opacity/blur). Shows the live value readout next to the label and an
 * optional hint. Styled to match the rest of the builder (uppercase micro-label,
 * gold accent on the track via `accent-gold`). The native `<input type="range">`
 * is value-clamped to [min,max] by the browser, and the server re-clamps on save.
 */
function SliderField(props: {
  label: string;
  hint?: string;
  min: number;
  max: number;
  value: number;
  onInput: (v: number) => void;
}) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="flex items-baseline justify-between gap-2">
        <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
          {props.label}
        </span>
        <span class="font-body text-gold text-[0.72rem] tabular-nums">{props.value}</span>
      </span>
      <input
        type="range"
        aria-label={props.label}
        min={props.min}
        max={props.max}
        step={1}
        value={props.value}
        onInput={(e) => props.onInput(Number(e.currentTarget.value))}
        class="accent-gold h-1.5 w-full cursor-pointer"
      />
      <Show when={props.hint}>
        <span class="font-body text-text-muted text-[0.72rem] italic">{props.hint}</span>
      </Show>
    </label>
  );
}

/**
 * WYSIWYG hero preview — composites the hero section's ENTIRE look live, with
 * ZERO Cloudflare Images calls: the uploaded photo with a client-side CSS
 * `filter: blur()` (free + instant), the title legibility panel (background
 * opacity + `backdrop-filter` from the two backdrop sliders, tinted by the
 * section's picked Background colour — falling back to the guest's BLACK panel
 * default, not the surface token), and the hero title in the section's accent
 * colour + the chosen heading font (via the same `--invite-*` variables the
 * guest consumes, default-substituted by previewSectionVars). With no image
 * uploaded it falls back to the same dark gradient the real hero uses, so the
 * preview is never empty.
 *
 * The image requests a PLAIN variant (`card`, not the server-blurred `hero-bg`)
 * so the client-side CSS blur isn't doubled on an already-blurred server image.
 */
function HeroPreview(props: {
  imageUrl: string | null;
  title: string;
  heroBlur: number;
  backdropOpacity: number;
  backdropBlur: number;
  theme: PreviewTheme;
}) {
  // A non-blurred source so the CSS blur is the only blur in the preview. The
  // imageUrl already carries the ?v= cache-buster; append the bounded variant.
  const previewSrc = (): string | null => {
    const url = props.imageUrl;
    if (!url) return null;
    const sep = url.includes("?") ? "&" : "?";
    return apiUrl(`${url}${sep}variant=card`);
  };
  const titleText = () => (props.title.trim().length > 0 ? props.title : DEFAULTS.heroTitle);
  // The title panel's base colour: the picked hero Background, else the guest's
  // black default (deliberately NOT the resolved surface token — the guest
  // falls back to black here, and the preview must not lie).
  const panelBase = () => props.theme.surface.hero ?? PREVIEW_PANEL_BASE;
  return (
    <div class="flex flex-col gap-2">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        Live preview
      </span>
      <div
        aria-label="Hero preview"
        class="border-border relative flex h-44 items-center justify-center overflow-hidden rounded-sm border"
        style={{
          ...previewSectionVars(props.theme, "hero"),
          background: PREVIEW_HERO_GRADIENT,
        }}
      >
        {/* Background photo with a live CSS blur (free — no CF transform). */}
        <Show when={previewSrc()}>
          {(src) => (
            <img
              src={src()}
              alt=""
              class="absolute inset-0 h-full w-full object-cover"
              style={{ filter: `blur(${props.heroBlur}px)`, transform: "scale(1.1)" }}
            />
          )}
        </Show>
        {/* Radial scrim, mirroring the guest hero, so the title always reads. */}
        <div
          class="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, oklch(0% 0 0 / 0.3) 0%, oklch(0% 0 0 / 0.55) 100%)",
          }}
        />
        {/* Title legibility panel — opacity + frosted blur from the two sliders,
            tinted by the section's Background colour. Painted only when opacity
            > 0 (mirrors the guest behaviour). */}
        <div
          class="relative flex items-center justify-center rounded-xl px-6 py-4"
          style={
            props.backdropOpacity > 0
              ? {
                  "background-color": `color-mix(in oklab, ${panelBase()} ${props.backdropOpacity}%, transparent)`,
                  "backdrop-filter": `blur(${props.backdropBlur}px)`,
                  "-webkit-backdrop-filter": `blur(${props.backdropBlur}px)`,
                }
              : undefined
          }
        >
          <span
            class="max-w-full text-center text-[clamp(1.5rem,7vw,2.75rem)] leading-none font-light break-words italic"
            style={{ color: "var(--invite-accent)", "font-family": "var(--invite-heading)" }}
          >
            {titleText()}
          </span>
        </div>
      </div>
    </div>
  );
}

function FontField(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        {props.label}
      </span>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.currentTarget.value)}
        class="border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.88rem] outline-none"
      >
        <For each={FONT_OPTIONS}>{(opt) => <option value={opt.value}>{opt.label}</option>}</For>
      </select>
    </label>
  );
}

function TextField(props: {
  label: string;
  placeholder: string;
  value: string;
  onInput: (v: string) => void;
}) {
  return (
    <label class="flex flex-col gap-1.5">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        {props.label}
      </span>
      <input
        type="text"
        placeholder={props.placeholder}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        class="border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.88rem] outline-none"
      />
    </label>
  );
}

function ImageField(props: {
  label: string;
  slot: CropSlot;
  url: string | null;
  crop: ImageCrop | null;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onSaveCrop: (crop: ImageCrop | null) => Promise<void>;
}) {
  const [cropping, setCropping] = createSignal(false);
  // Absolute, cache-busted image URL for the thumbnail + the cropper. The crop
  // editor works against the ORIGINAL (full) image so the organiser can re-frame
  // freely, so it always loads the unmodified `src`.
  const absoluteUrl = (): string | null => (props.url ? apiUrl(props.url) : null);
  // WYSIWYG thumbnail: when a crop is saved, render the cropped region with the
  // same background-image fraction technique the guest site uses, so the preview
  // matches the invite. With no crop, fall back to the plain object-cover image.
  const cropStyle = () => {
    const url = absoluteUrl();
    return url ? cropBackgroundStyle(url, props.crop) : null;
  };

  return (
    <div class="flex flex-col gap-2">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        {props.label}
      </span>
      <Show when={absoluteUrl()}>
        {(url) => (
          <Show
            when={cropStyle()}
            fallback={
              <img
                src={url()}
                alt=""
                class="border-border h-32 w-full max-w-xs rounded-sm border object-cover"
              />
            }
          >
            {(style) => (
              <div
                aria-label={`${props.label} (cropped)`}
                // WYSIWYG with the guest render: the box adopts the crop's true
                // pixel aspect, and the region scales uniformly inside it — what the
                // organiser sees here is exactly what guests get (no stretch).
                class="border-border w-full max-w-xs overflow-hidden rounded-sm border"
                style={{
                  ...style(),
                  "aspect-ratio": String(cropAspectRatio(props.crop, CROP_ASPECT[props.slot])),
                }}
              />
            )}
          </Show>
        )}
      </Show>
      <div class="flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) props.onSelect(file);
            e.currentTarget.value = "";
          }}
          class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-[0.82rem] file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[0.82rem]"
        />
        <Show when={props.url}>
          <button
            type="button"
            onClick={() => setCropping(true)}
            class="font-body text-gold text-[0.82rem] underline-offset-4 hover:underline"
          >
            Crop
          </button>
          <button
            type="button"
            onClick={() => props.onRemove()}
            class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline"
          >
            Remove
          </button>
        </Show>
      </div>
      <Show when={cropping() && absoluteUrl()}>
        {(url) => (
          <ImageCropModal
            imageUrl={url()}
            slot={props.slot}
            initialCrop={props.crop}
            onSave={props.onSaveCrop}
            onReset={() => props.onSaveCrop(null)}
            onClose={() => setCropping(false)}
          />
        )}
      </Show>
    </div>
  );
}
