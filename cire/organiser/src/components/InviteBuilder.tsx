import { useAuth } from "@osn/client/solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { isHeroEmpty, isStoryEmpty } from "../lib/invite-emptiness";
import { previewSectionVars, resolveSectionTheme } from "../lib/invite-theme-preview";
import type { PreviewTheme } from "../lib/invite-theme-preview";

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

// Hero display options (organiser choice). Closed unions mirroring the cire/api
// enums; the API coalesces a missing row to these today's-look defaults.
type HeroImageStyle = "blurred" | "regular";
type HeroTitleBackdrop = "none" | "solid";

interface HeroDisplay {
  imageStyle: HeroImageStyle;
  titleBackdrop: HeroTitleBackdrop;
}

interface InviteCustomisation {
  hero: { title: string | null; subtitle: string | null; imageUrl: string | null };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
  };
  heroDisplay: HeroDisplay;
  theme: InviteTheme;
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

  // Hero display options. Default to today's look (blurred backdrop, no title
  // panel); saved via the same theme PUT as the fonts + colours.
  const [heroImageStyle, setHeroImageStyle] = createSignal<HeroImageStyle>("blurred");
  const [heroTitleBackdrop, setHeroTitleBackdrop] = createSignal<HeroTitleBackdrop>("none");

  // Seed the edit buffers once, when the resource first resolves.
  function seed(d: InviteCustomisation) {
    if (seeded()) return;
    setHeroTitle(d.hero.title ?? "");
    setHeroSubtitle(d.hero.subtitle ?? "");
    setStoryEyebrow(d.story.eyebrow ?? "");
    setStoryHeading(d.story.heading ?? "");
    setStoryBody(d.story.body ?? "");
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
    setHeroImageStyle(d.heroDisplay?.imageStyle ?? "blurred");
    setHeroTitleBackdrop(d.heroDisplay?.titleBackdrop ?? "none");
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
          heroImageStyle: heroImageStyle(),
          heroTitleBackdrop: heroTitleBackdrop(),
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
                  url={d().hero.imageUrl}
                  onSelect={(f) => void uploadImage("hero", f)}
                  onRemove={() => void removeImage("hero")}
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
                {/* Hero display options — saved with the theme below. */}
                <ToggleField
                  label="Hero image"
                  hint="Blurred is a soft backdrop; Regular shows the photo sharp."
                  value={heroImageStyle()}
                  options={[
                    { value: "blurred", label: "Blurred" },
                    { value: "regular", label: "Regular" },
                  ]}
                  onChange={setHeroImageStyle}
                />
                <ToggleField
                  label="Title backdrop"
                  hint="Solid adds a panel behind the title so it stays readable over a busy photo."
                  value={heroTitleBackdrop()}
                  options={[
                    { value: "none", label: "None" },
                    { value: "solid", label: "Solid" },
                  ]}
                  onChange={setHeroTitleBackdrop}
                />
                <p class="font-body text-text-muted text-[0.72rem] italic">
                  Hero image &amp; title backdrop save with the Theme below.
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
                  url={d().story.imageUrl}
                  onSelect={(f) => void uploadImage("story", f)}
                  onRemove={() => void removeImage("story")}
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
 * A small segmented two-or-more-option toggle (radio group under the hood) for a
 * bounded enum setting — e.g. the hero image style (Blurred/Regular) and title
 * backdrop (None/Solid). Generic over the closed value type so the caller's
 * setter stays type-safe. The selected option is highlighted; an optional hint
 * explains the choice.
 */
function ToggleField<T extends string>(props: {
  label: string;
  hint?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset class="flex flex-col gap-1.5">
      <legend class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        {props.label}
      </legend>
      <div
        role="radiogroup"
        aria-label={props.label}
        class="border-border inline-flex w-fit overflow-hidden rounded-sm border"
      >
        <For each={props.options}>
          {(opt) => (
            <button
              type="button"
              role="radio"
              aria-checked={props.value === opt.value}
              onClick={() => props.onChange(opt.value)}
              class="font-body px-3 py-1.5 text-[0.82rem] tracking-[0.05em] transition"
              classList={{
                "bg-gold text-bg": props.value === opt.value,
                "bg-bg text-text-muted hover:text-text": props.value !== opt.value,
              }}
            >
              {opt.label}
            </button>
          )}
        </For>
      </div>
      <Show when={props.hint}>
        <span class="font-body text-text-muted text-[0.72rem] italic">{props.hint}</span>
      </Show>
    </fieldset>
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

/**
 * A native colour input that round-trips to a nullable hex value. `null` ⇒ the
 * built-in default (the swatch shows a neutral state + a "Use default" action).
 * Native `<input type="color">` only ever emits a `#rrggbb`, so the value always
 * passes the server-side colour allow-list — the UI can't submit an invalid hue.
 */
function ColorPicker(props: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  return (
    <div class="flex flex-col items-start gap-1.5">
      <span class="font-body text-text-muted text-[0.68rem] tracking-[0.08em] uppercase">
        {props.label}
      </span>
      <div class="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${props.label} colour`}
          value={props.value ?? "#d4af37"}
          onInput={(e) => props.onChange(e.currentTarget.value)}
          class="border-border h-9 w-12 cursor-pointer rounded-sm border bg-transparent p-0.5"
        />
        <Show
          when={props.value}
          fallback={<span class="font-body text-text-muted text-[0.72rem] italic">Default</span>}
        >
          <button
            type="button"
            onClick={() => props.onChange(null)}
            class="font-body text-text-muted text-[0.72rem] underline-offset-4 hover:underline"
          >
            Use default
          </button>
        </Show>
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
  url: string | null;
  onSelect: (file: File) => void;
  onRemove: () => void;
}) {
  return (
    <div class="flex flex-col gap-2">
      <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
        {props.label}
      </span>
      <Show when={props.url}>
        {(url) => (
          <img
            src={apiUrl(url())}
            alt=""
            class="border-border h-32 w-full max-w-xs rounded-sm border object-cover"
          />
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
            onClick={() => props.onRemove()}
            class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline"
          >
            Remove
          </button>
        </Show>
      </div>
    </div>
  );
}
