import { useAuth } from "@osn/client/solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";

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

interface InviteCustomisation {
  hero: { title: string | null; subtitle: string | null; imageUrl: string | null };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
  };
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
    setSeeded(true);
  }

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
              </fieldset>

              {/* ── Our Story ────────────────────────────────────────── */}
              <fieldset class="border-border flex flex-col gap-4 rounded-sm border p-4">
                <legend class="font-body text-gold-dim px-2 text-[0.72rem] tracking-[0.1em] uppercase">
                  Our Story
                </legend>
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
