/**
 * Invite builder — lets the signed-in organiser customise the guest invite. It
 * is structured as one card per guest-page section, **in the order a guest
 * scrolls them** (Hero → Our Story → Code Entry & Welcome → Events → Closing),
 * and each card owns EVERYTHING about its section: image, copy, colours, and a
 * live preview. Global typography sits first (it applies to every section),
 * the copyable invite message last (it is not part of the guest page). One
 * sticky "Save invite" action persists the lot — the API's text/theme endpoint
 * split is an implementation detail the organiser never sees. The event +
 * guest source of truth stays in the CSV import; this only layers presentation.
 *
 * State shape: ONE `createStore` draft (`model.ts`) plus reactive snapshots of
 * the last server-acknowledged payloads. Dirty state is therefore a memo the
 * UI can render — the save bar shows live "Unsaved changes", the save button
 * disables when clean, `beforeunload` + the dashboard's navigation guard
 * (`lib/unsaved-guard`) protect a dirty draft from being lost.
 *
 * The section nav is one tablist with two presentations, switched by a
 * container query: a static row of pills from `@3xl/builder` up, and below it
 * (phones) a trigger naming the current section that opens the same tabs as a
 * two-column grid — see {@link SECTION_MENU_ID}.
 *
 * Two persistence models coexist deliberately: text/theme wait for Save;
 * images, crops and the design selection apply immediately (marked with an
 * "applies immediately" badge, and image removal asks first). A draft→publish
 * model that would unify them needs API support — tracked in the cire wiki.
 */

import { DEFAULT_DESIGN_ID } from "@cire/invite-designs";
import {
  derivePalette,
  fontStack,
  paletteAdjustments,
  SECTION_TONES,
  type SectionTone,
  typographyVars,
} from "@cire/theme";
import { useAuth } from "@shared/rp-auth/solid";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../../lib/api";
import { haptic } from "../../lib/haptics";
import type { ImageCrop } from "../../lib/image-crop";
import { isFooterEmpty, isHeroEmpty, isStoryEmpty } from "../../lib/invite-emptiness";
import { CIRE_WEB_URL } from "../../lib/osn";
import { registerUnsavedGuard } from "../../lib/unsaved-guard";
import PaletteField, { resolvedSeeds } from "../PaletteField";
import Button from "../ui/Button";
import Notice from "../ui/Notice";
import { designLayout } from "./design-layout";
import DesignPicker from "./DesignPicker";
import {
  ChoiceField,
  Disclosure,
  SectionCard,
  SliderField,
  TextAreaField,
  TextField,
} from "./fields";
import ImageField from "./ImageField";
import {
  BACKDROP_BLUR_MAX,
  BACKDROP_BLUR_MIN,
  BACKDROP_OPACITY_MAX,
  BACKDROP_OPACITY_MIN,
  COPY_CAPS,
  DEFAULTS,
  draftFromCustomisation,
  emptyDraft,
  FONT_OPTIONS,
  FONT_STYLE_OPTIONS,
  FONT_WEIGHT_OPTIONS,
  fontOrDefault,
  HEADING_SIZE_OPTIONS,
  HERO_BLUR_DEFAULT,
  HERO_BLUR_MAX,
  HERO_BLUR_MIN,
  type ImageSlot,
  type InviteCustomisation,
  sampleCopy,
  SLOT_LABELS,
  textPayload,
  themePayload,
  type ThemeSection,
} from "./model";
import PreviewModal from "./PreviewModal";
import PreviewPane, { type PreviewPaneProps } from "./PreviewPane";
import { HeroPreview, SectionPreview } from "./previews";

export { isDesignLocked } from "./model";

interface InviteBuilderProps {
  weddingId: string;
  /** The wedding's slug — builds the public guest-invite preview link. */
  weddingSlug: string;
  /** The wedding's entitlement keys — locks premium designs in the selector. */
  entitlements: string[];
}

/**
 * The builder's wide threshold, mirroring the `@4xl/builder` container query
 * that swaps the inline per-section previews for the composed pane. Container
 * queries have no `matchMedia` equivalent, so the number has to exist in JS as
 * well to decide what to MOUNT — this constant is the only place it appears, and
 * it is compared against the same content box the query measures.
 */
const WIDE_BUILDER_REM = 56;

/**
 * The threshold at which the section tabs stop being a collapsible menu and
 * become the static row, mirroring the `@3xl/builder` container query on the
 * tablist. Like {@link WIDE_BUILDER_REM} it has to exist in JS as well — not to
 * decide what to mount (the swap is pure CSS) but to CLOSE the menu when the
 * container grows past it, since a menu left open across the crossover would
 * otherwise stay "open" forever on a surface that can no longer show it.
 */
const SECTION_MENU_REM = 48;

/**
 * How many columns the open section menu lays out in. **Lockstep with the
 * literal `grid-cols-2` utility on the tablist** — the column count is a CSS
 * fact the key handler cannot read back, and `ArrowDown`/`ArrowUp` step by it
 * so the arrows follow the visible geometry rather than the DOM order.
 *
 * The class stays a LITERAL at its usage site rather than being built from this
 * constant: Tailwind extracts class names by scanning source text, so a
 * `grid-cols-${…}` template would emit no CSS at all. Exported so a static
 * drift guard in the tests can assert the two agree — the same treatment the
 * `auto-grid` / `page-frame` utilities got, and the only mechanically checkable
 * half of a CSS↔JS constant pair.
 */
export const SECTION_MENU_COLUMNS = 2;

/** Which preview layer is mounted. `unknown` means "not measured yet, or not
 *  measurable" and mounts both — see {@link watchBuilderWidth}. */
type PreviewLayer = "unknown" | "narrow" | "wide";

/** DOM id of the section tablist — the `aria-controls` target of the narrow
 *  container's menu trigger. A constant, not `createUniqueId()`, because the
 *  builder is a singleton surface and the id reads in the DOM inspector. */
const SECTION_MENU_ID = "invite-section-tablist";

/** The document's root font size, since a `rem` threshold in a container query
 *  resolves against the root, not the container. `global.css` pins this to 16px,
 *  but reading it keeps the two in step if that ever changes. */
function rootFontPx(): number {
  if (typeof document === "undefined") return 16;
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/** The builder's sections, in guest scroll order (+ the two non-page cards).
 *  Ids double as the fieldset ids. The nav row above the form is a real tab
 *  switcher — one section shown at a time — rather than the vertical stack of
 *  every card the builder used to be, with a scroll-jump nav bolted to the
 *  top of it. */
const NAV_SECTIONS = [
  { id: "invite-design", label: "Design" },
  { id: "invite-look", label: "Look" },
  { id: "invite-hero", label: "Hero" },
  { id: "invite-story", label: "Our Story" },
  { id: "invite-welcome", label: "Welcome" },
  { id: "invite-events", label: "Events" },
  { id: "invite-closing", label: "Closing" },
  { id: "invite-message", label: "Message" },
] as const;

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

  // The whole editable state as one draft store (see model.ts), seeded once
  // when the resource first resolves. Image URLs/crops are NOT drafted — they
  // save instantly and live on `data`.
  const [draft, setDraft] = createStore(emptyDraft());
  const [seeded, setSeeded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Upload/remove failures surface inside their own section, not the save bar.
  const [slotErrors, setSlotErrors] = createStore<Record<ImageSlot, string | null>>({
    hero: null,
    story: null,
    footer: null,
  });

  // Serialised snapshots of the last state the server has (seeded on load,
  // refreshed after each successful PUT). REACTIVE signals — the dirty memos
  // below are what let the save bar render live state; the old non-reactive
  // `let` snapshots made an "Unsaved changes" indicator impossible.
  const [savedText, setSavedText] = createSignal("");
  const [savedTheme, setSavedTheme] = createSignal("");

  // Seed the draft once, when the resource first resolves (an effect, not a
  // render-path side effect). Later mutations from image/design saves refresh
  // `data` but never clobber the organiser's in-progress buffers.
  createEffect(() => {
    const d = data();
    if (!d || seeded()) return;
    const next = draftFromCustomisation(d);
    setDraft(next);
    setSavedText(JSON.stringify(textPayload(next)));
    setSavedTheme(JSON.stringify(themePayload(next)));
    setSeeded(true);
  });

  // Live dirty state per half. Each half is compared against the last
  // server-acknowledged snapshot — a copy-only save must not bump the theme
  // row's `updatedAt` (it doubles as the guest image-cache version, so a
  // gratuitous bump busts the per-variant transform cache and makes guests
  // re-download the hero for zero visual change — P-W1, see
  // [[free-tier-limits]]).
  const textDirty = createMemo(
    () => seeded() && JSON.stringify(textPayload(draft)) !== savedText(),
  );
  const themeDirty = createMemo(
    () => seeded() && JSON.stringify(themePayload(draft)) !== savedTheme(),
  );
  const isDirty = () => textDirty() || themeDirty();

  // A dirty draft is guarded twice: the dashboard's SPA navigation asks before
  // switching away (unsaved-guard), and the browser asks on tab close/reload.
  onMount(() => {
    const unregister = registerUnsavedGuard(isDirty);
    onCleanup(unregister);
  });
  // The beforeunload listener exists ONLY while dirty — a persistently
  // registered one makes the page ineligible for the back/forward cache in
  // Firefox/Safari even with a clean form (P-I3).
  createEffect(() => {
    if (!isDirty()) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));
  });

  // The live scheme as a CSS-variable map, derived by the SAME function the
  // guest site uses (`derivePalette` in `@cire/theme`). There is no
  // organiser-side colour maths any more, so the preview cannot disagree with
  // what a guest sees. Memoised: many preview readers, and the trigger is a
  // colour-picker DRAG (pointermove) — without a memo each frame ran the full
  // derivation once per reader. The seeds + adjustments memos are shared with
  // PaletteField via props, so the whole builder derives exactly once per
  // frame (P-W1).
  const paletteSeeds = createMemo(() => resolvedSeeds(draft.palette));
  const seedAdjustments = createMemo(() => paletteAdjustments(paletteSeeds()));
  const previewTokens = createMemo((): Record<string, string> => {
    const vars: Record<string, string> = derivePalette(paletteSeeds());
    const heading = fontStack(fontOrDefault(draft.headingFont));
    if (heading) vars["--font-display"] = heading;
    const body = fontStack(fontOrDefault(draft.bodyFont));
    if (body) vars["--font-body"] = body;
    // Typography options ride the same token map — resolved by the SAME shared
    // function the guest site uses, so the preview cannot lie about a weight.
    Object.assign(
      vars,
      typographyVars({
        headingSize: fontOrDefault(draft.headingSize),
        headingWeight: fontOrDefault(draft.headingWeight),
        headingStyle: fontOrDefault(draft.headingStyle),
        bodyWeight: fontOrDefault(draft.bodyWeight),
        bodyStyle: fontOrDefault(draft.bodyStyle),
      }),
    );
    return vars;
  });

  /**
   * Which preview layer to mount (perf P-I1). Both layers used to be mounted at
   * all times with a container query hiding one, so the hidden layer still took
   * every token write on every keystroke and colour-drag frame — five `style`
   * spreads of ~25 custom properties, landing on subtrees that render nothing.
   * That was cheap while the composed pane was unreachable (the old 1100px page
   * cap kept the builder below `@4xl`); now that the pane is the wide default,
   * the waste moved to whichever layer is idle.
   *
   * Measured off the builder container itself, exactly like the module nav's
   * rail/sheet swap: a `ResizeObserver`'s `contentRect` IS the content box a
   * container query evaluates, so the mount crossover cannot drift from the CSS
   * one.
   *
   * `unknown` mounts BOTH. Without a `ResizeObserver`, or before the first
   * measurement, or while the builder sits in a `display: none` ancestor, we
   * genuinely don't know which side we're on — and unmounting a layer we can't
   * measure would leave an organiser with no preview at all. Each layer keeps
   * its container-query classes as the visual authority, so in a browser the two
   * never both show, including during that first frame.
   */
  const [previewLayer, setPreviewLayer] = createSignal<PreviewLayer>("unknown");
  const showInlinePreviews = () => previewLayer() !== "wide";
  const showPreviewPane = () => previewLayer() !== "narrow";

  const watchBuilderWidth = (el: HTMLElement) => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      // 0 means `display: none` or not laid out — not a measurement, so stay
      // `unknown` rather than deciding the builder is narrow.
      if (width === 0) return;
      setPreviewLayer(width >= WIDE_BUILDER_REM * rootFontPx() ? "wide" : "narrow");
      // Collapse the section menu once the container can show the static row.
      // Nothing else writes this signal except the trigger, so without this a
      // menu opened narrow stays `true` for the rest of the session after a
      // rotate/resize — and `selectSection` would then "close" it on every wide
      // tab click, focusing a `display: none` trigger and dropping focus to the
      // body. Measured off the same `contentRect` the container query evaluates,
      // so the JS collapse point cannot drift from the CSS one.
      if (width >= SECTION_MENU_REM * rootFontPx()) setSectionMenuOpen(false);
    });
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };

  // Which section the tabbed nav is showing — one at a time, rather than the
  // old vertical stack of every card. Defaults to the first section, guest
  // scroll order.
  const [activeSection, setActiveSection] = createSignal<(typeof NAV_SECTIONS)[number]["id"]>(
    NAV_SECTIONS[0].id,
  );

  /**
   * Whether the narrow-container section menu is open (see {@link SECTION_MENU_ID}).
   *
   * Below `@3xl/builder` the eight tabs cannot sit on one line, and the row used
   * to be a horizontally scrolling strip: Closing and Message lived off the right
   * edge with nothing to say so, on the surface where an organiser is least
   * likely to go looking. The tabs are now collapsed behind a trigger naming the
   * current section, and open as a two-column grid that shows all eight at once —
   * the same move `ModuleSidebar` made for the module strip. From
   * `@3xl/builder` up the trigger is `display: none` and the same tablist is the
   * static row it has always been, so this signal is inert there.
   *
   * ONE tablist serves both surfaces rather than a per-surface copy: the panels'
   * `aria-labelledby` points at `${id}-tab`, and duplicating the tabs would give
   * every panel two candidate labels and assistive tech two tabs widgets.
   */
  const [sectionMenuOpen, setSectionMenuOpen] = createSignal(false);
  let sectionMenuTrigger: HTMLButtonElement | undefined;
  let sectionNav: HTMLElement | undefined;

  const activeIndex = () => {
    const i = NAV_SECTIONS.findIndex((s) => s.id === activeSection());
    return i === -1 ? 0 : i;
  };
  const activeLabel = () => NAV_SECTIONS[activeIndex()]!.label;

  /** Close the menu, optionally handing focus back to the trigger — which is
   *  required whenever the close was caused by something INSIDE the menu, since
   *  collapsing it takes the focused tab to `display: none` and focus with it. */
  const closeSectionMenu = (restoreFocus = false) => {
    setSectionMenuOpen(false);
    if (restoreFocus) sectionMenuTrigger?.focus();
  };

  /** Pick a section. Closing the menu is what makes the choice feel like a
   *  choice on touch; at `@3xl/builder` and up the menu is never open, so a tab
   *  click there keeps its focus exactly as before. */
  const selectSection = (id: (typeof NAV_SECTIONS)[number]["id"]) => {
    setActiveSection(id);
    if (sectionMenuOpen()) closeSectionMenu(true);
  };

  // Dismiss the open menu on an outside press. Listener exists ONLY while open
  // (and only on the surface that can open it), so the common case adds no
  // document-level work. Capture phase, so a press that also triggers something
  // else still closes the menu first.
  createEffect(() => {
    if (!sectionMenuOpen()) return;
    const onPointerDown = (e: Event) => {
      const target = e.target;
      if (target instanceof Node && sectionNav?.contains(target)) return;
      setSectionMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });

  // The composed preview, opened as a modal — the only way to reach it below
  // `@4xl/builder`, where there's no room for the sticky side pane.
  const [previewModalOpen, setPreviewModalOpen] = createSignal(false);

  // Roving tabindex over the section tabs — the same pattern `DesignPicker`
  // uses for its radiogroup. Solid has no built-in roving-tabindex primitive,
  // so keyboard navigation moves DOM focus imperatively via these refs.
  const sectionTabRefs = new Map<string, HTMLButtonElement>();

  /** The section `delta` steps from `fromId`, wrapping around. */
  function stepSection(fromId: string, delta: number): string | undefined {
    const ids = NAV_SECTIONS.map((s): string => s.id);
    const from = ids.indexOf(fromId);
    const fromIndex = from === -1 ? 0 : from;
    return ids[(fromIndex + delta + ids.length) % ids.length];
  }

  /** Move focus to a tab and activate its section — the APG "automatic
   *  activation" model, same as the design radiogroup's arrow-key behaviour. */
  function focusSection(id: (typeof NAV_SECTIONS)[number]["id"]) {
    setActiveSection(id);
    sectionTabRefs.get(id)?.focus();
  }

  /**
   * Arrow-key/Home/End roving-tabindex handler for the section tablist.
   *
   * `ArrowDown`/`ArrowUp` are handled ONLY while the menu is open, where the
   * tablist is a {@link SECTION_MENU_COLUMNS}-column grid and a keyboard user
   * reaches for the vertical arrows. On the wide static row the tablist is a
   * single horizontal line, so APG reserves Down/Up for the browser — handling
   * them there would swallow page scroll from a focused tab, which is a
   * regression against the row this replaced.
   *
   * Open, the vertical pair steps by the COLUMN COUNT, not by one: in a
   * row-major two-column grid the next item is to the right, and the one below
   * is two along. Aliasing Down to Right would make the arrows disagree with
   * what the organiser can see.
   *
   * Escape collapses the menu (a no-op on the static wide row).
   */
  function onSectionTabKeyDown(e: KeyboardEvent, currentId: string) {
    if (e.key === "Escape") {
      if (!sectionMenuOpen()) return;
      e.preventDefault();
      closeSectionMenu(true);
      return;
    }
    let nextId: string | undefined;
    switch (e.key) {
      case "ArrowRight":
        nextId = stepSection(currentId, 1);
        break;
      case "ArrowLeft":
        nextId = stepSection(currentId, -1);
        break;
      case "ArrowDown":
        if (!sectionMenuOpen()) return;
        nextId = stepSection(currentId, SECTION_MENU_COLUMNS);
        break;
      case "ArrowUp":
        if (!sectionMenuOpen()) return;
        nextId = stepSection(currentId, -SECTION_MENU_COLUMNS);
        break;
      case "Home":
        nextId = NAV_SECTIONS[0]!.id;
        break;
      case "End":
        nextId = NAV_SECTIONS[NAV_SECTIONS.length - 1]!.id;
        break;
      default:
        return;
    }
    if (!nextId) return;
    e.preventDefault();
    focusSection(nextId as (typeof NAV_SECTIONS)[number]["id"]);
  }

  /** The surface a section's tone paints, for its preview card. */
  const toneSurface = (section: ThemeSection): string => {
    switch (draft.tones[section]) {
      case "card":
        return "var(--color-surface)";
      case "raised":
        return "var(--color-surface-raised)";
      default:
        return "var(--color-bg)";
    }
  };

  // Live "what a guest will see" gates, mirroring the guest invite's emptiness
  // predicates. Driven by the draft buffers (so the badge flips the instant the
  // organiser types) plus the loaded image URL (image upload/remove refetches
  // `data`). The hero/story sections are HIDDEN on the live invite when these
  // report empty — the badges surface that before the organiser saves.
  const heroShown = () =>
    !isHeroEmpty({
      imageUrl: data()?.hero.imageUrl,
      title: draft.heroTitle,
      subtitle: draft.heroSubtitle,
    });
  const storyShown = () =>
    !isStoryEmpty({
      heading: draft.storyHeading,
      body: draft.storyBody,
      imageUrl: data()?.story.imageUrl,
    });
  // The footer has no defaults, so its badge asks "is there anything personal
  // here at all?" — a note, an image, or both. Neither ⇒ the guest sees the
  // plain footer (names over the legal links).
  const footerShown = () =>
    !isFooterEmpty({ message: draft.footerMessage, imageUrl: data()?.footer?.imageUrl });

  /** Shown-state per nav item, mirroring the section badges in the jump list. */
  const navShown = (id: string): boolean | undefined => {
    switch (id) {
      case "invite-hero":
        return heroShown();
      case "invite-story":
        return storyShown();
      case "invite-closing":
        return footerShown();
      default:
        return undefined;
    }
  };

  /** The ACTIVE section's Shown/Hidden state, for the collapsed menu trigger's
   *  dot. Memoised because the trigger reads it three times (the `Show` plus
   *  two `classList` entries) and `navShown` funnels into the draft-reading
   *  emptiness predicates — one subscription per keystroke instead of three.
   *  Declared here, not beside `activeIndex`/`activeLabel`: `createMemo` runs
   *  its computation eagerly, so it has to sit below `navShown`. */
  const activeShown = createMemo(() => navShown(activeSection()));

  /** The active section's Shown/Hidden state as a clause for the trigger's
   *  accessible name — empty for the sections that have no such state. */
  const shownSuffix = () => {
    switch (activeShown()) {
      case true:
        return ", shown";
      case false:
        return ", hidden — empty";
      default:
        return "";
    }
  };

  /**
   * The single save. The API keeps its two endpoints (`/text` + `/theme`) but
   * the organiser sees ONE action. Dirty halves run sequentially (text then
   * theme); each successful response refreshes its snapshot and mutates the
   * loaded data immediately (so a text success followed by a theme failure
   * leaves the UI consistent with what the server actually saved), and
   * whichever half fails surfaces its own error. Wired as the form's submit
   * handler so Enter in any field saves too.
   */
  async function saveInvite(e?: Event) {
    e?.preventDefault();
    if (saving()) return;
    setError(null);

    const textBody = JSON.stringify(textPayload(draft));
    const themeBody = JSON.stringify(themePayload(draft));
    const textIsDirty = textBody !== savedText();
    const themeIsDirty = themeBody !== savedTheme();
    // Unreachable via the UI (the button disables when clean) — belt & braces
    // against a programmatic submit.
    if (!textIsDirty && !themeIsDirty) return;

    setSaving(true);
    try {
      if (textIsDirty) {
        const textRes = await authFetch(apiUrl(`${base()}/text`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: textBody,
        });
        if (!textRes.ok) {
          const body = (await textRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Save failed (${textRes.status})`);
        }
        setSavedText(textBody);
        mutate((await textRes.json()) as InviteCustomisation);
      }

      if (themeIsDirty) {
        const themeRes = await authFetch(apiUrl(`${base()}/theme`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: themeBody,
        });
        if (!themeRes.ok) {
          const body = (await themeRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Save failed (${themeRes.status})`);
        }
        setSavedTheme(themeBody);
        mutate((await themeRes.json()) as InviteCustomisation);
      }
      haptic("commit");
      toast.success("Invite saved");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  // Fires immediately on card click — no dirty-tracking, one PUT per selection.
  const [savingDesign, setSavingDesign] = createSignal(false);

  /** The server-acknowledged design pack. One accessor rather than three
   *  `?? "classic"` literals: the picker's checked card, the previews' shape and
   *  the "is this a no-op click?" guard have to be reading the same thing, or a
   *  preview can show one pack while the radio says another. */
  const currentDesign = () => data()?.designId ?? DEFAULT_DESIGN_ID;

  const selectDesign = async (designId: string) => {
    if (savingDesign() || currentDesign() === designId) return;
    setSavingDesign(true);
    try {
      const res = await authFetch(apiUrl(`${base()}/design`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ designId }),
      });
      if (!res.ok) throw new Error(`Design save failed (${res.status})`);
      mutate((await res.json()) as InviteCustomisation);
      haptic("commit");
      toast.success("Design updated");
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return;
      }
      haptic("reject");
      toast.error("Could not update the design");
    } finally {
      setSavingDesign(false);
    }
  };

  // The wedding's public guest-invite URL — same path-routed pattern used by
  // PreviewInviteButton / buildInviteMessage (the guest site is SSR +
  // path-routed, so the slug must be in the PATH; the bare origin would
  // resolve to whatever wedding is primary, not necessarily this one).
  const guestBaseUrl = () => `${CIRE_WEB_URL}/${encodeURIComponent(props.weddingSlug)}`;

  /** The "Preview live" link target for a design card — the guest invite URL
   *  with `?design=<id>` appended (`&` if a query is already present). */
  function designPreviewHref(designId: string): string {
    const url = guestBaseUrl();
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}design=${encodeURIComponent(designId)}`;
  }

  async function uploadImage(slot: ImageSlot, file: File) {
    setSlotErrors(slot, null);
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
      toast.success(`${SLOT_LABELS[slot]} image updated`);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setSlotErrors(slot, err instanceof Error ? err.message : "Upload failed.");
    }
  }

  async function removeImage(slot: ImageSlot) {
    // Removal hits the LIVE invite immediately (no save bar, no undo) — the
    // one destructive control in the builder, so it asks first.
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Remove the ${SLOT_LABELS[slot].toLowerCase()} image? It disappears from your live invite immediately.`,
      )
    ) {
      return;
    }
    setSlotErrors(slot, null);
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
      setSlotErrors(slot, err instanceof Error ? err.message : "Remove failed.");
    }
  }

  // Save (or reset, with `crop: null`) a slot's crop rectangle. `screen` picks
  // which of the hero's two rectangles a save targets (0046): "desktop" (the
  // default, and the only option for the story slot) or the hero's "mobile"
  // phone rectangle. Mutates the loaded data with the returned customisation so
  // the thumbnail re-renders the new crop. Throws on failure so the modal can
  // keep itself open and surface a retry.
  async function saveCrop(slot: ImageSlot, crop: ImageCrop | null, screen?: "desktop" | "mobile") {
    const res = await authFetch(apiUrl(`${base()}/image/${slot}/crop`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(screen ? { crop, screen } : { crop }),
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
    const noun = screen === "mobile" ? "Phone crop" : "Crop";
    toast.success(crop ? `${noun} saved` : `${noun} reset`);
  }

  // Per-section resets — draft-only changes (nothing saved), so no confirm.
  const resetLook = () =>
    setDraft({
      headingFont: "default",
      bodyFont: "default",
      headingSize: "default",
      headingWeight: "default",
      headingStyle: "default",
      bodyWeight: "default",
      bodyStyle: "default",
      palette: { preset: null, seeds: {} },
    });
  const resetHero = () => {
    setDraft({
      heroTitle: "",
      heroSubtitle: "",
      heroBlur: HERO_BLUR_DEFAULT,
      titleBackdropOpacity: 0,
      titleBackdropBlur: 0,
    });
    setDraft("tones", "hero", null);
  };
  const resetStory = () => {
    setDraft({ storyEyebrow: "", storyHeading: "", storyBody: "" });
    setDraft("tones", "story", null);
  };
  const resetWelcome = () => {
    setDraft({ welcomeMessage: "" });
    setDraft("tones", "welcome", null);
  };
  const resetEvents = () => {
    setDraft({ detailsEyebrow: "", detailsHeading: "" });
    setDraft("tones", "details", null);
  };

  // Props for the composed preview's `hero`/`story`/`welcome`/`events`/
  // `closing` slots — shared by the sticky side pane (wide layouts) and the
  // mobile preview modal, so the two presentations can never drift apart.
  // Each is wrapped in its own `createMemo` (see `heroSlot` etc. below) at the
  // call site, so the two consumers share one computed object per slot
  // instead of each recomputing it.
  //
  // Kept as one small function PER SLOT rather than one function returning the
  // whole `PreviewPaneProps` object spread with `{...}` on each consumer.
  // Solid's compiler makes an individual JSX prop (`hero={heroSlot()}`)
  // reactive by wrapping its expression in a getter, so `props.hero`
  // re-evaluates on every read; a spread of an ALREADY-COMPUTED plain object
  // loses that — the object is built once, when the enclosing `<Show>`
  // render-prop runs, and never again, so the preview would freeze at
  // whatever the form looked like on first render.
  const heroPreviewProps = (d: () => InviteCustomisation): PreviewPaneProps["hero"] => ({
    shown: heroShown(),
    imageUrl: d().hero.imageUrl,
    crop: d().hero.imageCrop,
    cropMobile: d().hero.imageCropMobile ?? null,
    title: draft.heroTitle,
    heroBlur: draft.heroBlur,
    backdropOpacity: draft.titleBackdropOpacity,
    backdropBlur: draft.titleBackdropBlur,
  });
  const storyPreviewProps = (): PreviewPaneProps["story"] => ({
    shown: storyShown(),
    eyebrow: draft.storyEyebrow,
    heading: draft.storyHeading,
    body: draft.storyBody,
  });
  const welcomePreviewProps = (): PreviewPaneProps["welcome"] => ({
    message: draft.welcomeMessage,
  });
  const eventsPreviewProps = (): PreviewPaneProps["events"] => ({
    eyebrow: draft.detailsEyebrow,
    heading: draft.detailsHeading,
  });
  const closingPreviewProps = (d: () => InviteCustomisation): PreviewPaneProps["closing"] => ({
    shown: footerShown(),
    message: draft.footerMessage,
    imageUrl: d().footer?.imageUrl ?? null,
    imageCrop: d().footer?.imageCrop ?? null,
  });

  return (
    // The ref measures the same box `@container/builder` does — see
    // `watchBuilderWidth`.
    <section
      ref={watchBuilderWidth}
      class="border-border bg-surface/30 @container/builder flex flex-col gap-8 rounded-sm border p-6"
    >
      <header class="flex flex-col gap-1">
        <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">Invite Builder</p>
        <h2 class="font-display text-text text-[1.4rem] font-light">Customise your invite</h2>
        <p class="font-body text-text-muted text-[0.82rem]">
          Use the tabs below to move between sections of the guest invite, in the order guests see
          them — images, copy and colours together. Events and guests still come from your
          spreadsheet import.
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
          // Memoized once per render pass and shared by the sticky side pane
          // and the mobile modal (P-I1) — without this, the rare frame where
          // both are mounted (the initial "unknown" preview-layer measurement,
          // or resizing to wide while the modal is left open) has each
          // consumer independently re-deriving every slot.
          const heroSlot = createMemo(() => heroPreviewProps(d));
          const storySlot = createMemo(() => storyPreviewProps());
          const welcomeSlot = createMemo(() => welcomePreviewProps());
          const eventsSlot = createMemo(() => eventsPreviewProps());
          const closingSlot = createMemo(() => closingPreviewProps(d));

          return (
            <form onSubmit={(e) => void saveInvite(e)} class="flex flex-col gap-6">
              {/* ── Section tabs — sticky, one section shown at a time, dots mirror
                the Shown/Hidden badges — plus, below `@4xl/builder` (where there's
                no room for the sticky side preview), a button that opens the
                composed preview in a modal instead. ── */}
              <div class="border-border bg-bg/90 sticky top-0 z-20 -mx-6 flex items-center gap-2 border-b px-6 py-2 backdrop-blur">
                {/* No `relative` here on purpose: the open menu positions
                  against the STICKY BAR (already a positioned element, so it is
                  the containing block), which is wider than this nav column by
                  the Preview button — a menu boxed into the column truncates
                  "Our Story" on a 390px phone. */}
                <nav
                  ref={sectionNav}
                  aria-label="Invite sections"
                  class="min-w-0 flex-1"
                  // Tabbing forward out of the open menu used to leave it up,
                  // and the menu is an opaque overlay across the top of the
                  // active section — so focus landed in a form field the
                  // organiser could not see, with no keyboard way to uncover it
                  // (WCAG 2.2 SC 2.4.11 Focus Not Obscured; Escape is bound to
                  // the tabs and the trigger, not to the field they'd reach).
                  // Closing on focus leaving the nav is what every popover
                  // primitive does, and it costs nothing on the wide row where
                  // the menu is never open.
                  onFocusOut={(e) => {
                    if (!sectionMenuOpen()) return;
                    const next = e.relatedTarget;
                    if (next instanceof Node && sectionNav?.contains(next)) return;
                    setSectionMenuOpen(false);
                  }}
                >
                  {/* Narrow containers only: the current section as a menu
                    trigger. It names where the organiser IS (label, position,
                    Shown/Hidden dot) so the menu only has to be opened to move,
                    never to orient — the thing the scrolling strip could not do
                    for the sections parked off its right edge. */}
                  <button
                    type="button"
                    ref={(el) => (sectionMenuTrigger = el)}
                    aria-expanded={sectionMenuOpen()}
                    aria-controls={SECTION_MENU_ID}
                    // The dot is `aria-hidden`, and an `aria-label` overrides
                    // subtree content — so an `sr-only` span inside the button
                    // (what the tabs themselves use) would be dropped. The state
                    // has to be folded into the label, or the collapsed trigger
                    // tells a sighted organiser three things and a screen-reader
                    // one only two. Wording matches `SegmentBadge`.
                    aria-label={`Invite section: ${activeLabel()}, ${activeIndex() + 1} of ${NAV_SECTIONS.length}${shownSuffix()}. Choose a section`}
                    onClick={() => setSectionMenuOpen(!sectionMenuOpen())}
                    onKeyDown={(e) => {
                      if (e.key !== "Escape" || !sectionMenuOpen()) return;
                      e.preventDefault();
                      closeSectionMenu();
                    }}
                    class="border-border bg-surface/40 text-text hover:border-gold-dim font-body flex min-h-11 w-full items-center justify-between gap-3 rounded-sm border px-3 py-2 text-[0.75rem] tracking-[0.08em] uppercase transition-colors @3xl/builder:hidden"
                  >
                    <span class="flex min-w-0 items-center gap-2">
                      <Show when={activeShown() !== undefined}>
                        <span
                          aria-hidden
                          class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                          classList={{
                            "bg-gold": activeShown() === true,
                            "bg-text-muted/50": activeShown() === false,
                          }}
                        />
                      </Show>
                      <span class="min-w-0 truncate">{activeLabel()}</span>
                    </span>
                    <span
                      aria-hidden
                      class="text-text-muted flex shrink-0 items-center gap-2 text-[0.66rem] tracking-[0.14em] tabular-nums"
                    >
                      {activeIndex() + 1}/{NAV_SECTIONS.length}
                      <span
                        class="text-gold inline-block text-[0.8rem] tracking-normal transition-transform duration-(--dur-fast)"
                        classList={{ "rotate-180": sectionMenuOpen() }}
                      >
                        ▾
                      </span>
                    </span>
                  </button>

                  {/* ONE tablist, two presentations. Narrow + open: a two-column
                    grid dropped under the trigger — all eight sections on screen
                    at once, no horizontal scroll, and absolutely positioned so
                    opening it never shoves the form down. Narrow + closed:
                    `display: none` (the panels' `aria-labelledby` still resolves
                    against it — the accname spec follows hidden references).
                    From `@3xl/builder`, where the eight fit on one line: the
                    static row, always laid out, menu state irrelevant. */}
                  <div
                    id={SECTION_MENU_ID}
                    role="tablist"
                    classList={{ hidden: !sectionMenuOpen(), grid: sectionMenuOpen() }}
                    class="border-border bg-bg absolute inset-x-6 top-full z-30 mt-1 max-h-[60vh] grid-cols-2 gap-1 overflow-y-auto rounded-sm border p-2 shadow-lg @3xl/builder:static @3xl/builder:mt-0 @3xl/builder:flex @3xl/builder:max-h-none @3xl/builder:flex-wrap @3xl/builder:overflow-visible @3xl/builder:rounded-none @3xl/builder:border-0 @3xl/builder:bg-transparent @3xl/builder:p-0 @3xl/builder:shadow-none"
                  >
                    <For each={[...NAV_SECTIONS]}>
                      {(item) => {
                        const shown = () => navShown(item.id);
                        const active = () => activeSection() === item.id;
                        return (
                          <button
                            type="button"
                            role="tab"
                            id={`${item.id}-tab`}
                            aria-controls={item.id}
                            aria-selected={active()}
                            tabIndex={active() ? 0 : -1}
                            ref={(el) => sectionTabRefs.set(item.id, el)}
                            onClick={() => selectSection(item.id)}
                            onKeyDown={(e) => onSectionTabKeyDown(e, item.id)}
                            // `min-h-11` is a 44px touch target in the menu; the
                            // wide row keeps the compact pill it has always been.
                            class={`font-body flex min-h-11 w-full shrink-0 items-center gap-1.5 rounded-sm px-3 py-2 text-left text-[0.72rem] tracking-[0.08em] uppercase transition-colors @3xl/builder:min-h-0 @3xl/builder:w-auto @3xl/builder:px-2.5 @3xl/builder:py-1 ${
                              active()
                                ? "bg-gold/12 text-gold"
                                : "text-text-muted hover:text-text hover:bg-surface/60"
                            }`}
                          >
                            <Show when={shown() !== undefined}>
                              <span
                                aria-hidden
                                class="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                                classList={{
                                  "bg-gold": shown() === true,
                                  "bg-text-muted/50": shown() === false,
                                }}
                              />
                            </Show>
                            <span class="min-w-0 truncate">{item.label}</span>
                            <Show when={shown() === false}>
                              <span class="sr-only">(hidden — empty)</span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </nav>
                {/* Hidden once the sticky side pane below can show instead — the
                  same `@4xl/builder` threshold `showPreviewPane`/`showInlinePreviews`
                  measure in JS. */}
                <button
                  type="button"
                  onClick={() => setPreviewModalOpen(true)}
                  class="font-body text-gold border-gold/40 hover:bg-gold/10 flex min-h-11 shrink-0 items-center rounded-sm border px-3 py-1 text-[0.72rem] tracking-[0.08em] uppercase transition-colors @3xl/builder:min-h-0 @3xl/builder:py-1 @4xl/builder:hidden"
                >
                  Preview
                </button>
              </div>

              {/* Form and preview side by side from `@4xl/builder` up — a
                threshold the panel could never actually reach while the page was
                capped at 1100px, so the composed preview was effectively dead
                code on the very screens it was written for. */}
              <div class="flex flex-col gap-8 @4xl/builder:flex-row @4xl/builder:items-start @6xl/builder:gap-10">
                <div class="flex min-w-0 flex-1 flex-col gap-8">
                  {/* ── Design ─────────────────────────────────────────── */}
                  <SectionCard
                    id="invite-design"
                    legend="Design"
                    hidden={activeSection() !== "invite-design"}
                  >
                    <DesignPicker
                      entitlements={props.entitlements}
                      currentId={currentDesign()}
                      saving={savingDesign()}
                      onSelect={(id) => void selectDesign(id)}
                      previewHref={designPreviewHref}
                    />
                  </SectionCard>

                  {/* ── Look (global): typography + the colour scheme ──── */}
                  <SectionCard
                    id="invite-look"
                    legend="Look"
                    hidden={activeSection() !== "invite-look"}
                    onReset={resetLook}
                    description="Two fonts and five colours set the whole invite. Each section below picks how light or dark it sits — not its own colours."
                  >
                    {/* `auto-grid`, not a `@lg/builder` step: these fields sit in
                      the form column, which is narrower than the builder
                      container once the preview pane appears — an intrinsic grid
                      measures the box the fields are actually in. */}
                    <div class="auto-grid [--auto-grid-min:15rem]">
                      <ChoiceField
                        label="Heading font"
                        options={FONT_OPTIONS}
                        value={draft.headingFont}
                        onChange={(v) => setDraft("headingFont", v)}
                      />
                      <ChoiceField
                        label="Body font"
                        options={FONT_OPTIONS}
                        value={draft.bodyFont}
                        onChange={(v) => setDraft("bodyFont", v)}
                      />
                    </div>
                    <PaletteField
                      value={draft.palette}
                      onChange={(next) => setDraft("palette", next)}
                      tokens={previewTokens()}
                      adjustments={seedAdjustments()}
                    />
                    {/* Most couples pick a preset and stop — the five fine
                      typography knobs stay one click away. */}
                    <Disclosure summary="Fine-tune typography" hint="size, weight and italics">
                      <div class="auto-grid [--auto-grid-min:15rem]">
                        <ChoiceField
                          label="Heading size"
                          options={HEADING_SIZE_OPTIONS}
                          value={draft.headingSize}
                          onChange={(v) => setDraft("headingSize", v)}
                        />
                        <ChoiceField
                          label="Heading weight"
                          options={FONT_WEIGHT_OPTIONS}
                          value={draft.headingWeight}
                          onChange={(v) => setDraft("headingWeight", v)}
                        />
                        <ChoiceField
                          label="Heading style"
                          options={FONT_STYLE_OPTIONS}
                          value={draft.headingStyle}
                          onChange={(v) => setDraft("headingStyle", v)}
                        />
                        <ChoiceField
                          label="Body weight"
                          options={FONT_WEIGHT_OPTIONS}
                          value={draft.bodyWeight}
                          onChange={(v) => setDraft("bodyWeight", v)}
                        />
                        <ChoiceField
                          label="Body style"
                          options={FONT_STYLE_OPTIONS}
                          value={draft.bodyStyle}
                          onChange={(v) => setDraft("bodyStyle", v)}
                        />
                      </div>
                    </Disclosure>
                  </SectionCard>

                  {/* ── Hero ───────────────────────────────────────────── */}
                  <SectionCard
                    id="invite-hero"
                    legend="Hero"
                    shown={heroShown()}
                    onReset={resetHero}
                    hidden={activeSection() !== "invite-hero"}
                  >
                    {/* Preview FIRST — the display sliders below act on it, and
                      on small screens a preview below the sliders scrolls out
                      of view exactly when it's needed. Mounted only when this
                      layer is the visible one (see `previewLayer`) AND this is
                      the active tab (P-I2) — a hidden tab's inline preview
                      would otherwise still re-render on every token edit for
                      no one to see. */}
                    <Show when={showInlinePreviews() && activeSection() === "invite-hero"}>
                      <HeroPreview
                        imageUrl={d().hero.imageUrl}
                        crop={d().hero.imageCrop}
                        cropMobile={d().hero.imageCropMobile ?? null}
                        title={draft.heroTitle}
                        heroBlur={draft.heroBlur}
                        backdropOpacity={draft.titleBackdropOpacity}
                        backdropBlur={draft.titleBackdropBlur}
                        tokens={previewTokens()}
                        surface={toneSurface("hero")}
                        design={currentDesign()}
                      />
                    </Show>
                    <ImageField
                      label="Hero background image"
                      slot="hero"
                      url={d().hero.imageUrl}
                      crop={d().hero.imageCrop}
                      cropMobile={d().hero.imageCropMobile ?? null}
                      error={slotErrors.hero}
                      onSelect={(f) => void uploadImage("hero", f)}
                      onRemove={() => void removeImage("hero")}
                      onSaveCrop={(c) => saveCrop("hero", c)}
                      onSaveCropMobile={(c) => saveCrop("hero", c, "mobile")}
                    />
                    <TextField
                      label="Couple title"
                      placeholder={DEFAULTS.heroTitle}
                      value={draft.heroTitle}
                      maxLength={COPY_CAPS.heroTitle}
                      onInput={(v) => setDraft("heroTitle", v)}
                    />
                    <TextField
                      label="Subtitle"
                      placeholder={DEFAULTS.heroSubtitle}
                      value={draft.heroSubtitle}
                      maxLength={COPY_CAPS.heroSubtitle}
                      onInput={(v) => setDraft("heroSubtitle", v)}
                    />
                    <ToneField
                      value={draft.tones.hero}
                      tokens={previewTokens()}
                      hint="Used behind the title panel and wherever the photo doesn't reach."
                      onChange={(v) => setDraft("tones", "hero", v)}
                    />
                    <Disclosure summary="Hero display" hint="photo blur and the title panel">
                      <SliderField
                        label="Hero image blur"
                        hint="0 is a sharp photo; higher is a softer, dreamier backdrop."
                        min={HERO_BLUR_MIN}
                        max={HERO_BLUR_MAX}
                        value={draft.heroBlur}
                        valueText={(v) => (v === 0 ? "0 — sharp photo" : `${v} — softer backdrop`)}
                        onInput={(v) => setDraft("heroBlur", v)}
                      />
                      <SliderField
                        label="Title backdrop opacity"
                        hint="A panel behind the title so it reads over a busy photo. 0 is no panel."
                        min={BACKDROP_OPACITY_MIN}
                        max={BACKDROP_OPACITY_MAX}
                        value={draft.titleBackdropOpacity}
                        valueText={(v) => (v === 0 ? "0 — no panel" : `${v} percent opaque`)}
                        onInput={(v) => setDraft("titleBackdropOpacity", v)}
                      />
                      <SliderField
                        label="Title backdrop blur"
                        hint="Frosts the photo behind the title panel (px)."
                        min={BACKDROP_BLUR_MIN}
                        max={BACKDROP_BLUR_MAX}
                        value={draft.titleBackdropBlur}
                        valueText={(v) => (v === 0 ? "0 — no frosting" : `${v} pixels of frost`)}
                        onInput={(v) => setDraft("titleBackdropBlur", v)}
                      />
                    </Disclosure>
                  </SectionCard>

                  {/* ── Our Story ──────────────────────────────────────── */}
                  <SectionCard
                    id="invite-story"
                    legend="Our Story"
                    shown={storyShown()}
                    onReset={resetStory}
                    hidden={activeSection() !== "invite-story"}
                  >
                    <ImageField
                      label="Story photo"
                      slot="story"
                      url={d().story.imageUrl}
                      crop={d().story.imageCrop}
                      error={slotErrors.story}
                      onSelect={(f) => void uploadImage("story", f)}
                      onRemove={() => void removeImage("story")}
                      onSaveCrop={(c) => saveCrop("story", c)}
                    />
                    <TextField
                      label="Eyebrow"
                      placeholder={DEFAULTS.storyEyebrow}
                      value={draft.storyEyebrow}
                      maxLength={COPY_CAPS.storyEyebrow}
                      onInput={(v) => setDraft("storyEyebrow", v)}
                    />
                    <TextField
                      label="Heading"
                      placeholder={DEFAULTS.storyHeading}
                      value={draft.storyHeading}
                      maxLength={COPY_CAPS.storyHeading}
                      onInput={(v) => setDraft("storyHeading", v)}
                    />
                    <TextAreaField
                      label="Story"
                      rows={6}
                      placeholder={DEFAULTS.storyBody}
                      value={draft.storyBody}
                      maxLength={COPY_CAPS.storyBody}
                      onInput={(v) => setDraft("storyBody", v)}
                    />
                    <ToneField
                      value={draft.tones.story}
                      tokens={previewTokens()}
                      onChange={(v) => setDraft("tones", "story", v)}
                    />
                    <Show when={showInlinePreviews() && activeSection() === "invite-story"}>
                      <SectionPreview
                        label="Our Story"
                        tokens={previewTokens()}
                        surface={toneSurface("story")}
                        design={currentDesign()}
                        eyebrow={sampleCopy(draft.storyEyebrow, DEFAULTS.storyEyebrow, 40)}
                        heading={sampleCopy(draft.storyHeading, DEFAULTS.storyHeading, 60)}
                        body={sampleCopy(draft.storyBody, DEFAULTS.storyBody)}
                      />
                    </Show>
                  </SectionCard>

                  {/* ── Code Entry & Welcome ───────────────────────────── */}
                  <SectionCard
                    id="invite-welcome"
                    legend="Code Entry & Welcome"
                    onReset={resetWelcome}
                    hidden={activeSection() !== "invite-welcome"}
                    description="The invite-code entry form, and the greeting a guest sees under their name after entering their code. Leave the greeting blank to use the default. Like the rest of the invite copy, the greeting is part of the public invite page — don't put anything private in it."
                  >
                    <TextField
                      label="Welcome greeting"
                      placeholder={DEFAULTS.welcomeMessage}
                      value={draft.welcomeMessage}
                      maxLength={COPY_CAPS.welcomeMessage}
                      onInput={(v) => setDraft("welcomeMessage", v)}
                    />
                    <ToneField
                      value={draft.tones.welcome}
                      tokens={previewTokens()}
                      onChange={(v) => setDraft("tones", "welcome", v)}
                    />
                    <Show when={showInlinePreviews() && activeSection() === "invite-welcome"}>
                      <SectionPreview
                        label="Code Entry & Welcome"
                        tokens={previewTokens()}
                        surface={toneSurface("welcome")}
                        design={currentDesign()}
                        panel={designLayout(currentDesign()).welcome === "panel"}
                        eyebrow="Your Invitation"
                        heading="Enter Your Code"
                        body={sampleCopy(draft.welcomeMessage, DEFAULTS.welcomeMessage)}
                      />
                    </Show>
                  </SectionCard>

                  {/* ── Events section ─────────────────────────────────── */}
                  <SectionCard
                    id="invite-events"
                    legend="Events Section"
                    onReset={resetEvents}
                    hidden={activeSection() !== "invite-events"}
                    description="The header above the guest's event list. The colours also style the event cards, their buttons and the event pop-ups. The events themselves come from your spreadsheet import."
                  >
                    <TextField
                      label="Events eyebrow"
                      placeholder={DEFAULTS.detailsEyebrow}
                      value={draft.detailsEyebrow}
                      maxLength={COPY_CAPS.detailsEyebrow}
                      onInput={(v) => setDraft("detailsEyebrow", v)}
                    />
                    <TextField
                      label="Events heading"
                      placeholder={DEFAULTS.detailsHeading}
                      value={draft.detailsHeading}
                      maxLength={COPY_CAPS.detailsHeading}
                      onInput={(v) => setDraft("detailsHeading", v)}
                    />
                    <ToneField
                      value={draft.tones.details}
                      tokens={previewTokens()}
                      onChange={(v) => setDraft("tones", "details", v)}
                    />
                    <Show when={showInlinePreviews() && activeSection() === "invite-events"}>
                      <SectionPreview
                        label="Events Section"
                        tokens={previewTokens()}
                        surface={toneSurface("details")}
                        design={currentDesign()}
                        rule={designLayout(currentDesign()).eventsRule}
                        eyebrow={sampleCopy(draft.detailsEyebrow, DEFAULTS.detailsEyebrow, 40)}
                        heading={sampleCopy(draft.detailsHeading, DEFAULTS.detailsHeading, 60)}
                        body="Event names, dates and the Respond buttons follow these colours."
                      />
                    </Show>
                  </SectionCard>

                  {/* ── Closing section ────────────────────────────────── */}
                  <SectionCard
                    id="invite-closing"
                    legend="Closing Section"
                    shown={footerShown()}
                    hidden={activeSection() !== "invite-closing"}
                    description={
                      'The last section of the invite — your own sign-off, below the events and above the page footer. A closing image that spans the page edge to edge, like the hero at the top, and a closing line like "Looking forward to celebrating with you" or "No boxed gifts please". Add either, both, or neither: leave them empty and the whole section is skipped, so the invite ends on your events exactly as it does now. Guests see this only after they enter their code. The image is decorative — anything that needs to be read (including by a screen reader) should go in the note.'
                    }
                  >
                    <ImageField
                      label="Closing image"
                      slot="footer"
                      url={d().footer?.imageUrl ?? null}
                      crop={d().footer?.imageCrop ?? null}
                      error={slotErrors.footer}
                      onSelect={(f) => void uploadImage("footer", f)}
                      onRemove={() => void removeImage("footer")}
                      onSaveCrop={(c) => saveCrop("footer", c)}
                    />
                    <TextAreaField
                      label="Closing note (optional)"
                      rows={3}
                      placeholder="Looking forward to celebrating with you"
                      value={draft.footerMessage}
                      maxLength={COPY_CAPS.footerMessage}
                      onInput={(v) => setDraft("footerMessage", v)}
                    />
                    {/* No colour picker of its own — the closing section reuses the
                      Code Entry & Welcome surface, so the couple's two direct
                      addresses to their guests match. */}
                    <Show when={showInlinePreviews() && activeSection() === "invite-closing"}>
                      <SectionPreview
                        label="Closing Section"
                        tokens={previewTokens()}
                        surface={toneSurface("welcome")}
                        design={currentDesign()}
                        imageUrl={d().footer?.imageUrl ?? null}
                        imageCrop={d().footer?.imageCrop ?? null}
                        body={
                          draft.footerMessage.trim().length > 0
                            ? sampleCopy(draft.footerMessage, "")
                            : "Your closing note appears here."
                        }
                      />
                    </Show>
                    <p class="font-body text-text-muted text-[0.78rem] italic">
                      Uses the colours you picked for Code Entry &amp; Welcome — the closing note is
                      you speaking to your guests, same as the greeting.
                    </p>
                  </SectionCard>

                  {/* ── Invite message (not on the guest page) ─────────── */}
                  <SectionCard
                    id="invite-message"
                    legend="Invite message"
                    hidden={activeSection() !== "invite-message"}
                    description="Not part of the invite page — this is the first line of the message you copy from the Guests tab to send a household. Leave it blank to use the default. The guest-site link and the household's code are added automatically on the two lines below it."
                  >
                    <TextAreaField
                      label="Invite message (optional)"
                      rows={4}
                      placeholder="You're invited to our wedding! View your invitation and RSVP below."
                      value={draft.inviteMessage}
                      maxLength={COPY_CAPS.inviteMessage}
                      hint="The wedding link and family code are appended automatically — don't include them here."
                      onInput={(v) => setDraft("inviteMessage", v)}
                    />
                  </SectionCard>
                </div>

                {/* ── Persistent composed preview (wide layouts) ─────────── */}
                {/* The miniature earns more room as the builder widens — at 20rem
                  the hero's type is guesswork; by 24rem the tone rhythm down the
                  page is legible, which is the whole point of the pane. */}
                <Show when={showPreviewPane()}>
                  <aside class="hidden w-80 shrink-0 @4xl/builder:block @6xl/builder:w-96">
                    <div class="sticky top-12">
                      <PreviewPane
                        tokens={previewTokens()}
                        toneSurface={toneSurface}
                        design={currentDesign()}
                        hero={heroSlot()}
                        story={storySlot()}
                        welcome={welcomeSlot()}
                        events={eventsSlot()}
                        closing={closingSlot()}
                      />
                    </div>
                  </aside>
                </Show>
              </div>

              {/* ── Mobile preview modal — the "Preview" button next to the
                section tabs, the only way to reach the composed preview below
                `@4xl/builder`. ── */}
              <PreviewModal
                open={previewModalOpen()}
                onClose={() => setPreviewModalOpen(false)}
                tokens={previewTokens()}
                toneSurface={toneSurface}
                design={currentDesign()}
                hero={heroSlot()}
                story={storySlot()}
                welcome={welcomeSlot()}
                events={eventsSlot()}
                closing={closingSlot()}
              />

              {/* ── Save bar — sticky so it's reachable from any section ── */}
              <div class="border-border bg-bg/90 sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-col gap-3 rounded-b-sm border-t px-6 py-4 backdrop-blur">
                <Show when={error()}>
                  <Notice tone="error" alert>
                    {error()}
                  </Notice>
                </Show>
                <div class="flex flex-wrap items-center gap-4">
                  <Button
                    type="submit"
                    variant="primary"
                    onClick={(e) => {
                      e.preventDefault();
                      void saveInvite();
                    }}
                    disabled={saving() || !isDirty()}
                  >
                    {saving() ? "Saving…" : "Save invite"}
                  </Button>
                  <Show
                    when={isDirty()}
                    fallback={
                      <span class="font-body text-text-muted text-[0.75rem]">
                        All changes saved
                      </span>
                    }
                  >
                    <span role="status" class="font-body text-gold text-[0.75rem]">
                      Unsaved changes
                    </span>
                  </Show>
                  <span class="font-body text-text-muted text-[0.75rem]">
                    Copy, colours, fonts and hero display save together. Images, crops and the
                    design apply as soon as you change them.
                  </span>
                </div>
              </div>
            </form>
          );
        }}
      </Show>
    </section>
  );
}

/** Plain-English names for the three surfaces a section can sit on. */
const TONE_LABELS: Record<SectionTone, string> = {
  ground: "Page",
  card: "Card",
  raised: "Raised",
};

/**
 * Which surface this section sits on — the whole of a section's colour choice
 * now that the scheme is global. Three steps in one family always read as a
 * deliberate rhythm down the page, where three freely-picked colours usually
 * did not; and there is no way to land on an unreadable pairing, because all
 * three surfaces are derived against the same text colour.
 *
 * The buttons render AS their surface (the derived tokens are scoped onto the
 * group), so the choice is visual — these are literally colours, not words.
 */
function ToneField(props: {
  value: SectionTone | null;
  hint?: string;
  tokens: Record<string, string>;
  onChange: (v: SectionTone | null) => void;
}) {
  const current = () => props.value ?? "ground";
  const surfaceFor: Record<SectionTone, string> = {
    ground: "var(--color-bg)",
    card: "var(--color-surface)",
    raised: "var(--color-surface-raised)",
  };
  return (
    <div class="flex flex-col gap-1.5">
      <span class="font-body text-text-muted text-[0.8rem]">Section background</span>
      <div
        class="flex flex-wrap gap-2"
        role="group"
        aria-label="Section background"
        style={props.tokens}
      >
        <For each={SECTION_TONES}>
          {(tone) => (
            <button
              type="button"
              aria-pressed={current() === tone}
              onClick={() => props.onChange(tone === "ground" ? null : tone)}
              class="border-border hover:border-gold focus-visible:border-gold focus-visible:ring-gold/40 font-body aria-pressed:border-gold aria-pressed:ring-gold/60 rounded-sm border px-3 py-1.5 text-[0.78rem] transition outline-none focus-visible:ring-2 aria-pressed:ring-1"
              style={{ "background-color": surfaceFor[tone], color: "var(--color-text)" }}
            >
              {TONE_LABELS[tone]}
            </button>
          )}
        </For>
      </div>
      <Show when={props.hint}>
        <span class="font-body text-text-muted text-[0.72rem] italic">{props.hint}</span>
      </Show>
    </div>
  );
}
