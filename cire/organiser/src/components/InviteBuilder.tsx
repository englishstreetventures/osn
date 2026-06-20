import { useAuth } from "@osn/client/solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import {
  CROP_ASPECT,
  cropAspectRatio,
  cropBackgroundStyle,
  type CropSlot,
  type ImageCrop,
} from "../lib/image-crop";
import { isHeroEmpty, isStoryEmpty } from "../lib/invite-emptiness";
import { previewSectionVars, resolveSectionTheme } from "../lib/invite-theme-preview";
import type { PreviewTheme } from "../lib/invite-theme-preview";
import ColorPicker from "./ColorPicker";
import ImageCropModal from "./ImageCropModal";

type ImageSlot = "hero" | "story";
type ThemeSection = "hero" | "story" | "details";

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

// The cire palette gold + dark surface, for the WYSIWYG hero preview (mirrors the
// guest InviteHeader title styling + gradient fallback). Kept local — the
// organiser must never import cire/web internals.
const PREVIEW_GOLD = "oklch(74.99% 0.0854 82.08)";
const PREVIEW_HERO_GRADIENT =
  "linear-gradient(160deg, oklch(27.87% 0.0393 149.62) 0%, oklch(19.96% 0.0331 147.34) 40%, oklch(22.70% 0.0275 152.78) 100%)";

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
// they're overriding. Mirrors cire/web's Hero.astro / OurStory.astro.
const DEFAULTS = {
  heroTitle: "V & R",
  heroSubtitle: "We can't wait to celebrate with you",
  storyEyebrow: "Our Story",
  storyHeading: "How It All Began",
  storyBody: "Your love story goes here — how you met, the proposal, and everything in between.",
};

/**
 * Invite builder — lets the signed-in organiser swap a couple of images and
 * rewrite the hero / story copy on top of the existing animated invite. The
 * event + guest source of truth stays in the CSV import; this only layers
 * presentation on top.
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
  });
  const [surface, setSurface] = createSignal<Record<ThemeSection, string | null>>({
    hero: null,
    story: null,
    details: null,
  });
  const [savingTheme, setSavingTheme] = createSignal(false);

  // Hero display sliders. Default to today's look (blur 28 backdrop, no title
  // panel); saved via the same theme PUT as the fonts + colours.
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
    setInviteMessage(d.inviteMessage ?? "");
    setHeadingFont(d.theme.headingFont ?? "default");
    setBodyFont(d.theme.bodyFont ?? "default");
    setAccent({
      hero: d.theme.hero.accentColor,
      story: d.theme.story.accentColor,
      details: d.theme.details.accentColor,
    });
    setSurface({
      hero: d.theme.hero.surfaceColor,
      story: d.theme.story.surfaceColor,
      details: d.theme.details.surfaceColor,
    });
    setHeroBlur(d.heroDisplay?.blur ?? HERO_BLUR_DEFAULT);
    setTitleBackdropOpacity(d.heroDisplay?.titleBackdrop?.opacity ?? 0);
    setTitleBackdropBlur(d.heroDisplay?.titleBackdrop?.blur ?? 0);
    setSeeded(true);
  }

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

  async function saveText(e: Event) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await authFetch(apiUrl(`${base()}/text`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          heroTitle: heroTitle() || null,
          heroSubtitle: heroSubtitle() || null,
          storyEyebrow: storyEyebrow() || null,
          storyHeading: storyHeading() || null,
          storyBody: storyBody() || null,
          inviteMessage: inviteMessage() || null,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      mutate((await res.json()) as InviteCustomisation);
      toast.success("Invite copy saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function saveTheme(e: Event) {
    e.preventDefault();
    setError(null);
    setSavingTheme(true);
    try {
      const a = accent();
      const s = surface();
      const res = await authFetch(apiUrl(`${base()}/theme`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headingFont: fontOrDefault(headingFont()),
          bodyFont: fontOrDefault(bodyFont()),
          heroAccentColor: a.hero,
          heroSurfaceColor: s.hero,
          storyAccentColor: a.story,
          storySurfaceColor: s.story,
          detailsAccentColor: a.details,
          detailsSurfaceColor: s.details,
          heroBlur: heroBlur(),
          titleBackdropOpacity: titleBackdropOpacity(),
          titleBackdropBlur: titleBackdropBlur(),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      mutate((await res.json()) as InviteCustomisation);
      toast.success("Invite theme saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSavingTheme(false);
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
          Customise images &amp; copy
        </h2>
        <p class="font-body text-text-muted text-[0.82rem]">
          Events and guests still come from your spreadsheet import — this only changes how the
          invite looks.
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
              <Show when={error()}>
                <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
                  {error()}
                </p>
              </Show>

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
                {/* Hero display sliders — saved with the theme below. The live
                    preview beneath composites them so the organiser sees the
                    result as they drag, without ever hitting Cloudflare Images. */}
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
                  hint="A dark panel behind the title so it reads over a busy photo. 0 is no panel."
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
                <HeroPreview
                  imageUrl={d().hero.imageUrl}
                  title={heroTitle()}
                  heroBlur={heroBlur()}
                  backdropOpacity={titleBackdropOpacity()}
                  backdropBlur={titleBackdropBlur()}
                />
                <p class="font-body text-text-muted text-[0.72rem] italic">
                  Hero display sliders save with the Theme below.
                </p>
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
              </fieldset>

              {/* ── Invite message ───────────────────────────────────── */}
              <fieldset class="border-border flex flex-col gap-4 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Invite message
                </legend>
                <p class="font-body text-text-muted text-[0.82rem]">
                  The first line of the message you copy from the Guests tab to send a household.
                  Leave it blank to use the default. The guest-site link and the household's code
                  are added automatically on the two lines below it.
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

              <div class="flex items-center gap-3">
                <button
                  type="button"
                  onClick={(e) => void saveText(e)}
                  disabled={saving()}
                  class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-start rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                >
                  {saving() ? "Saving…" : "Save copy"}
                </button>
              </div>

              {/* ── Theme (fonts + colours) ──────────────────────────── */}
              <fieldset class="border-border flex flex-col gap-5 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Theme
                </legend>
                <p class="font-body text-text-muted text-[0.82rem]">
                  Pick fonts and per-section colours. Anything left on its default keeps the
                  built-in look.
                </p>

                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FontField label="Heading font" value={headingFont()} onChange={setHeadingFont} />
                  <FontField label="Body font" value={bodyFont()} onChange={setBodyFont} />
                </div>

                <div class="flex flex-col gap-4">
                  <SectionColors
                    label="Hero"
                    accent={accent().hero}
                    surface={surface().hero}
                    onAccent={(v) => setAccent((p) => ({ ...p, hero: v }))}
                    onSurface={(v) => setSurface((p) => ({ ...p, hero: v }))}
                  />
                  <SectionColors
                    label="Our Story"
                    accent={accent().story}
                    surface={surface().story}
                    onAccent={(v) => setAccent((p) => ({ ...p, story: v }))}
                    onSurface={(v) => setSurface((p) => ({ ...p, story: v }))}
                  />
                  <SectionColors
                    label="Event Details"
                    accent={accent().details}
                    surface={surface().details}
                    onAccent={(v) => setAccent((p) => ({ ...p, details: v }))}
                    onSurface={(v) => setSurface((p) => ({ ...p, details: v }))}
                  />
                </div>

                {/* Live preview — updates instantly as the controls change, so the
                    organiser SEES each colour/font before saving (the change took
                    effect only on the guest URL before). Driven by the same picker
                    signals; styled with the SAME `--invite-*` CSS variables + the
                    guest var precedence (see lib/invite-theme-preview). */}
                <ThemePreview
                  theme={{
                    headingFont: fontOrDefault(headingFont()),
                    bodyFont: fontOrDefault(bodyFont()),
                    accent: accent(),
                    surface: surface(),
                  }}
                />

                <button
                  type="button"
                  onClick={(e) => void saveTheme(e)}
                  disabled={savingTheme()}
                  class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-start rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
                >
                  {savingTheme() ? "Saving…" : "Save theme"}
                </button>
              </fieldset>
            </div>
          );
        }}
      </Show>
    </section>
  );
}

/**
 * Live theme preview — a compact, representative mini-invite styled with the SAME
 * `--invite-*` CSS variables the guest invite consumes, driven by the live picker
 * signals so each colour/font change is visible instantly. One labelled card per
 * section (Hero / Our Story / Event Details) shows that section's accent (the
 * heading + eyebrow) over its surface (the card background), in the chosen fonts.
 * Defaults are substituted (resolveSectionTheme) so an un-picked colour previews
 * as the real built-in token — an honest before/after. No guest stylesheet, no
 * Effect/web imports: plain inline `style` with the var names.
 */
function ThemePreview(props: { theme: PreviewTheme }) {
  const sections = [
    { key: "hero" as const, label: "Hero", eyebrow: "Save the Date", heading: "V & R" },
    { key: "story" as const, label: "Our Story", eyebrow: "Our Story", heading: "How It Began" },
    { key: "details" as const, label: "Event Details", eyebrow: "Details", heading: "The Day" },
  ];
  return (
    <div class="flex flex-col gap-2">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        Live preview
      </span>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <For each={sections}>
          {(s) => {
            const r = () => resolveSectionTheme(props.theme, s.key);
            return (
              <figure
                aria-label={`${s.label} preview`}
                style={{
                  ...previewSectionVars(props.theme, s.key),
                  "background-color": "var(--invite-surface)",
                  "font-family": "var(--invite-body)",
                }}
                class="border-border flex min-h-28 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-sm border p-4 text-center"
              >
                <span
                  style={{ color: "var(--invite-accent)", "font-family": "var(--invite-body)" }}
                  class="text-[0.6rem] tracking-[0.18em] uppercase opacity-80"
                >
                  {s.eyebrow}
                </span>
                <span
                  style={{ color: "var(--invite-accent)", "font-family": "var(--invite-heading)" }}
                  class="text-[1.5rem] leading-none font-light italic"
                >
                  {s.heading}
                </span>
                {/* Body sample in the body font on the section surface, so the
                    font + surface contrast is visible too. Mid-tone so it reads on
                    either a light or dark picked surface. */}
                <span style={{ color: r().accent }} class="text-[0.62rem] opacity-55">
                  Sample body copy
                </span>
                <figcaption class="font-body text-text-muted mt-1 text-[0.62rem] tracking-[0.08em] uppercase">
                  {s.label}
                </figcaption>
              </figure>
            );
          }}
        </For>
      </div>
    </div>
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
 * WYSIWYG hero preview — composites the three hero-display sliders LIVE as they
 * drag, with ZERO Cloudflare Images calls. The uploaded hero image is the
 * background with a client-side CSS `filter: blur()` (free + instant); on top
 * sits the title legibility panel (background opacity + `backdrop-filter: blur()`
 * from the two backdrop sliders); and on top of THAT the hero title text, styled
 * to evoke the real hero (serif display, gold). With no image uploaded it falls
 * back to the same dark gradient the real hero uses, so the preview is never
 * empty.
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
  return (
    <div class="flex flex-col gap-2">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        Live preview
      </span>
      <div
        aria-label="Hero display preview"
        class="border-border relative flex h-44 items-center justify-center overflow-hidden rounded-sm border"
        style={{ background: PREVIEW_HERO_GRADIENT }}
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
        {/* Radial scrim, mirroring the guest hero, so the gold title always reads. */}
        <div
          class="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, oklch(0% 0 0 / 0.3) 0%, oklch(0% 0 0 / 0.55) 100%)",
          }}
        />
        {/* Title legibility panel — opacity + frosted blur from the two sliders.
            Painted only when opacity > 0 (mirrors the guest behaviour). */}
        <div
          class="relative flex items-center justify-center rounded-xl px-6 py-4"
          style={
            props.backdropOpacity > 0
              ? {
                  "background-color": `color-mix(in oklab, oklch(0% 0 0) ${props.backdropOpacity}%, transparent)`,
                  "backdrop-filter": `blur(${props.backdropBlur}px)`,
                  "-webkit-backdrop-filter": `blur(${props.backdropBlur}px)`,
                }
              : undefined
          }
        >
          <span
            class="font-display max-w-full text-center text-[clamp(1.5rem,7vw,2.75rem)] leading-none font-light break-words italic"
            style={{ color: PREVIEW_GOLD }}
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

/** Accent + surface colour pickers for one named section, each clearable. */
function SectionColors(props: {
  label: string;
  accent: string | null;
  surface: string | null;
  onAccent: (v: string | null) => void;
  onSurface: (v: string | null) => void;
}) {
  return (
    <div class="border-border/60 flex flex-col gap-3 rounded-sm border p-3">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        {props.label}
      </span>
      <div class="flex flex-wrap gap-5">
        <ColorPicker label="Accent" value={props.accent} onChange={props.onAccent} />
        <ColorPicker label="Background" value={props.surface} onChange={props.onSurface} />
      </div>
    </div>
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
