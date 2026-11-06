/**
 * Invite builder — lets the signed-in organiser customise the guest invite. It
 * is structured as one card per guest-page section, **in the order a guest
 * scrolls them** (Hero → Our Story → Code Entry & Welcome → Events → FAQ →
 * Closing),
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
 * It spans the Invite module's four views (`view`): Template (the design),
 * Style (type and colours), Content (the guest page's sections, one at a time)
 * and Codes (the invite message, beside the owner's codes). One builder stays
 * mounted across them, so moving between views keeps the draft. Content's
 * sections are a second glass strip lent to the module's view bar; on a phone
 * both strips give way to one glass pill naming the place and a menu of every
 * view and section.
 *
 * Two persistence models coexist deliberately: text/theme and the section
 * visibility switches wait for Save;
 * images, crops, the design and envelope selections and the FAQ entries apply immediately (marked with an
 * "applies immediately" badge, and image removal asks first). A draft→publish
 * model that would unify them needs API support — tracked in the cire wiki.
 */

import type { EnvelopeId } from "@cire/envelope";
import { DEFAULT_DESIGN_ID } from "@cire/invite-designs";
import {
  derivePalette,
  fontStack,
  paletteAdjustments,
  SECTION_TONES,
  type SectionState,
  type SectionTone,
  typographyVars,
} from "@cire/theme";
import Button from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import Disclosure from "@cire/ui/disclosure";
import { GLASS_FILL } from "@cire/ui/lib/glass";
import Loading from "@cire/ui/loading";
import SegmentedTabs from "@cire/ui/segmented-tabs";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@shared/ui/ui/dropdown-menu";
import { Notice } from "@shared/ui/ui/notice";
import ChevronDown from "lucide-solid/icons/chevron-down";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createStore } from "solid-js/store";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../../lib/api";
import { INVITE_VIEWS, type InviteView } from "../../lib/dashboard-route";
import type { ImageCrop } from "../../lib/image-crop";
import { faqState, footerState, heroState, storyState } from "../../lib/invite-emptiness";
import { CIRE_WEB_URL } from "../../lib/osn";
import { haptic } from "../../lib/touch-feedback";
import { registerUnsavedGuard } from "../../lib/unsaved-guard";
import PaletteField, { resolvedSeeds } from "../PaletteField";
import { createCompact, useViewBar, ViewBar } from "../ViewBar";
import { designLayout } from "./design-layout";
import DesignPicker from "./DesignPicker";
import EnvelopePicker from "./EnvelopePicker";
import FaqEditor from "./FaqEditor";
import {
  ChoiceField,
  HiddenSectionIcon,
  isHiddenState,
  SECTION_STATE_LABELS,
  SectionCard,
  SliderField,
  TextAreaField,
  TextField,
} from "./fields";
import ImageField from "./ImageField";
import InviteMessageCopy from "./InviteMessageCopy";
import {
  BACKDROP_BLUR_MAX,
  BACKDROP_BLUR_MIN,
  BACKDROP_OPACITY_MAX,
  BACKDROP_OPACITY_MIN,
  COPY_CAPS,
  DEFAULTS,
  draftFromCustomisation,
  emptyDraft,
  type FaqEntry,
  FONT_OPTIONS,
  FONT_STYLE_OPTIONS,
  FONT_WEIGHT_OPTIONS,
  fontOrDefault,
  HEADING_SIZE_OPTIONS,
  HERO_BLUR_DEFAULT,
  HERO_BLUR_MAX,
  HERO_BLUR_MIN,
  faqSampleBody,
  type ImageSlot,
  type InviteCustomisation,
  sampleCopy,
  SLOT_LABELS,
  textPayload,
  themePayload,
  type ThemeSection,
  visibilityPayload,
} from "./model";
import PreviewModal from "./PreviewModal";
import PreviewPane, { type PreviewPaneProps } from "./PreviewPane";
import { HeroPreview, SectionPreview } from "./previews";

const BUILDER_CLASS = `${cardClass({ padding: "lg" })} @container/builder gap-8`;

export { isDesignLocked } from "./model";

interface InviteBuilderProps {
  weddingId: string;
  /** The wedding's slug — builds the public guest-invite preview link. */
  weddingSlug: string;
  /** The wedding's name — the default first line of the copied invite message. */
  weddingName: string;
  /** Owner or editor: copying a household's message also marks it sent. */
  canEdit: boolean;
  /** The wedding's entitlement keys — locks premium designs in the selector. */
  entitlements: string[];
  /** Which of the Invite module's views to show. */
  view: InviteView;
  /** Move to another view — the phone menu's choice. */
  onView?: (view: InviteView) => void;
  /** Alone, outside a module shell: draw the phone's pill and menu. */
  compact?: boolean;
  /** The line pointing at the other place that shapes the invite message,
   *  shown under the Codes view's message. */
  inviteMessageLinks?: JSX.Element;
  /** Counts the owner's re-mints on Codes, so the message's copy reads the new
   *  codes. */
  codesRevision?: number;
}

/**
 * The builder's wide threshold, mirroring the `@4xl/builder` container query
 * that swaps the inline per-section previews for the composed pane. Container
 * queries have no `matchMedia` equivalent, so the number has to exist in JS as
 * well to decide what to MOUNT — this constant is the only place it appears, and
 * it is compared against the same content box the query measures.
 */
const WIDE_BUILDER_REM = 56;

/** Below this panel width, in rem, the view bar holds the phone's one pill
 *  and menu in place of both strips. */
const PHONE_REM = 30;

/** From this panel width, in rem, Content's sections share the views' row;
 *  below it they take a row of their own. Measured in Chromium: four labelled
 *  views (348px), the divider, six sections (471px) and the Preview button
 *  (78px), with the bar's 8px gaps, need 922px. */
const SAME_ROW_REM = 58;

/** Which preview layer is mounted. `unknown` means "not measured yet, or not
 *  measurable" and mounts both — see {@link watchBuilderWidth}. */
type PreviewLayer = "unknown" | "narrow" | "wide";

/** The document's root font size, since a `rem` threshold in a container query
 *  resolves against the root, not the container. `global.css` pins this to 16px,
 *  but reading it keeps the two in step if that ever changes. */
function rootFontPx(): number {
  if (typeof document === "undefined") return 16;
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

/** Content's sections, in guest scroll order. Ids double as the fieldset ids.
 *  One shows at a time. */
const CONTENT_SECTIONS = [
  { id: "invite-hero", label: "Hero" },
  { id: "invite-story", label: "Our story" },
  { id: "invite-welcome", label: "Welcome" },
  { id: "invite-events", label: "Events" },
  { id: "invite-faq", label: "FAQ" },
  { id: "invite-closing", label: "Closing" },
] as const;

type ContentSectionId = (typeof CONTENT_SECTIONS)[number]["id"];

/** The views' names, as the module's strip and the phone's pill say them. */
const VIEW_LABEL = {
  template: "Template",
  style: "Style",
  content: "Content",
  codes: "Codes",
} satisfies Readonly<Record<InviteView, string>>;

export default function InviteBuilder(props: InviteBuilderProps) {
  const { authFetch } = useAuth();

  const base = () => weddingPath(props.weddingId, "/invite");

  // The FAQ entries. They arrive once, on the first load (`?include=faqs`), and
  // from then on `FaqEditor` keeps them current: the write routes' responses
  // that replace `data` below never carry them. Set before the resource
  // resolves, so the FAQ card never renders ahead of its list. `undefined`
  // after the first load means an API older than the FAQ.
  const [faqs, setFaqs] = createSignal<FaqEntry[] | undefined>(undefined);
  let faqsLoaded = false;
  // An FAQ form with typing in it, or an FAQ order not yet saved. Guarded like a
  // dirty draft, but kept out of the save bar, which cannot save either.
  const [faqPending, setFaqPending] = createSignal(false);

  // What only `GET /invite` says about envelopes: whether the API has them at
  // all (an older one sends no `envelopeId` key, and the picker stays hidden)
  // and whether the wedding may use one now. The write answers that replace
  // `data` carry neither, so both are set from each read and never from a write.
  const [envelopesOffered, setEnvelopesOffered] = createSignal(false);
  const [envelopeEntitled, setEnvelopeEntitled] = createSignal(false);

  // A read that fails resolves rather than throws: a failed resource throws
  // wherever it is read, and the builder reads it in many places. The first
  // read's failure is drawn in place of the builder; a later one keeps what is
  // on screen and says so beside the save button.
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [data, { mutate, refetch }] = createResource<InviteCustomisation | undefined>(
    async (_source, info) => {
      const res = await authFetch(apiUrl(faqsLoaded ? base() : `${base()}?include=faqs`));
      if (res.status === 401) {
        redirectToLogin();
        throw new Error("unauthorised");
      }
      if (!res.ok) {
        if (info.value) {
          setError("Could not reload the invite. Try again.");
          return info.value;
        }
        setLoadFailed(true);
        return undefined;
      }
      setLoadFailed(false);
      return read(res);
    },
  );
  async function read(res: Response): Promise<InviteCustomisation> {
    const body = (await res.json()) as InviteCustomisation;
    if (!faqsLoaded) {
      faqsLoaded = true;
      setFaqs(body.faqs);
    }
    setEnvelopesOffered("envelopeId" in body);
    setEnvelopeEntitled(body.envelopeEntitled === true);
    return body;
  }

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
  const [savedVisibility, setSavedVisibility] = createSignal("");

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
    setSavedVisibility(JSON.stringify(visibilityPayload(next)));
    setSeeded(true);
  });

  // Live dirty state per half. Each half is compared against the last
  // server-acknowledged snapshot — a copy-only save must not bump the theme
  // row's `updatedAt` (it doubles as the guest image-cache version, so a
  // gratuitous bump busts the per-variant transform cache and makes guests
  // re-download the hero for zero visual change — see [[free-tier-limits]]).
  const textDirty = createMemo(
    () => seeded() && JSON.stringify(textPayload(draft)) !== savedText(),
  );
  const themeDirty = createMemo(
    () => seeded() && JSON.stringify(themePayload(draft)) !== savedTheme(),
  );
  const visibilityDirty = createMemo(
    () => seeded() && JSON.stringify(visibilityPayload(draft)) !== savedVisibility(),
  );
  const isDirty = () => textDirty() || themeDirty() || visibilityDirty();

  // A dirty draft is guarded twice: the dashboard's SPA navigation asks before
  // switching away (unsaved-guard), and the browser asks on tab close/reload.
  onMount(() => {
    // The builder stays mounted on every Invite view of its wedding, so a move
    // between them keeps the draft and needs no prompt.
    const unregister = registerUnsavedGuard(
      () => isDirty() || faqPending(),
      (next) =>
        next.view === "weddings" && next.weddingId === props.weddingId && next.module === "invite",
    );
    onCleanup(unregister);
  });
  // The beforeunload listener exists ONLY while dirty — a persistently
  // registered one makes the page ineligible for the back/forward cache in
  // Firefox/Safari even with a clean form.
  createEffect(() => {
    if (!isDirty() && !faqPending()) return;
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
  // frame.
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
   * Which preview layer to mount. A layer only hidden by a container query
   * would still take every token write on every keystroke and colour-drag
   * frame — five `style` spreads of ~25 custom properties, landing on subtrees
   * that render nothing — so the idle layer is not mounted at all.
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
    });
    observer.observe(el);
    onCleanup(() => observer.disconnect());
  };

  // Which of Content's sections is showing — one at a time, guest scroll
  // order, the first by default. Kept across a trip to another view.
  const [activeSection, setActiveSection] = createSignal<ContentSectionId>(CONTENT_SECTIONS[0].id);
  // Whether Codes has been shown since the builder mounted. The message's
  // copy action reads the household list, so it mounts on the first visit
  // rather than with the builder, then stays: the household an organiser
  // picked survives a trip to another view.
  const messageOpened = createMemo<boolean>((opened) => opened || props.view === "codes", false);

  /** The section on screen: Content's chosen one, none on another view. */
  const shownSection = () => (props.view === "content" ? activeSection() : undefined);

  // The way between the builder's places, read off the module panel's width
  // the view bar measures (`ViewBar.createCompact`). Alone, `compact` decides.
  const phone = createCompact(
    () => PHONE_REM,
    () => props.compact ?? false,
  ).compact;
  const stacked = createCompact(
    () => SAME_ROW_REM,
    () => true,
  ).compact;

  // The composed preview, opened as a modal — the only way to reach it below
  // `@4xl/builder`, where there's no room for the sticky side pane.
  const [previewModalOpen, setPreviewModalOpen] = createSignal(false);

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

  // Live "what a guest will see" states, mirroring the guest invite's state
  // functions: shown, empty (switched on with no content) or off. Driven by the
  // draft (so a section's tab and reason line change the instant the organiser
  // types or flips the switch) plus the loaded image URL (image upload/remove
  // refetches `data`). A section renders on the live invite only in the `shown`
  // state — the tabs surface that before the organiser saves.
  const heroSectionState = () =>
    heroState(draft.visibility.hero, {
      imageUrl: data()?.hero.imageUrl,
      title: draft.heroTitle,
      subtitle: draft.heroSubtitle,
    });
  const storySectionState = () =>
    storyState(draft.visibility.story, {
      heading: draft.storyHeading,
      body: draft.storyBody,
      imageUrl: data()?.story.imageUrl,
    });
  // The closing section has no defaults, so its content check asks "is there
  // anything personal here at all?" — a note, an image, or both.
  const footerSectionState = () =>
    footerState(draft.visibility.footer, {
      message: draft.footerMessage,
      imageUrl: data()?.footer?.imageUrl,
    });

  // The FAQ has content once it has an entry. The entries apply at once, so the
  // state reads the live list; the switch is the draft's, like the others.
  const faqSectionState = () => faqState(draft.visibility.faq, faqs());

  /** Section state per nav item, as each section card has it. `undefined` for
   *  the sections that cannot be hidden. */
  const navState = (id: string): SectionState | undefined => {
    switch (id) {
      case "invite-hero":
        return heroSectionState();
      case "invite-story":
        return storySectionState();
      case "invite-faq":
        return faqSectionState();
      case "invite-closing":
        return footerSectionState();
      default:
        return undefined;
    }
  };

  /** Whether a section is hidden from guests, and the words for it after its
   *  name: "(hidden — empty)". Wording from `SECTION_STATE_LABELS`. */
  const hiddenNote = (id: string): string | undefined => {
    const state = navState(id);
    return isHiddenState(state) ? `(${SECTION_STATE_LABELS[state!].toLowerCase()})` : undefined;
  };

  /** Content's sections as the second strip draws them: a hidden one leads
   *  with its eye-off icon and says so in its name. */
  const sectionItems = createMemo(() =>
    CONTENT_SECTIONS.map((section) => {
      const note = hiddenNote(section.id);
      return {
        value: section.id,
        label: section.label,
        icon: note ? HiddenSectionIcon : undefined,
        name: note ? `${section.label} ${note}` : undefined,
      };
    }),
  );

  /** Where the organiser is, as the phone's pill names it: a view, or under
   *  Content the section. */
  const place = () => {
    if (props.view !== "content") return { label: VIEW_LABEL[props.view], note: undefined };
    const section = CONTENT_SECTIONS.find((s) => s.id === activeSection())!;
    return { label: section.label, note: hiddenNote(section.id) };
  };

  /**
   * The single save. The API keeps three endpoints (`/text`, `/theme`,
   * `/visibility`) but the organiser sees ONE action. Dirty parts run
   * sequentially (text, then theme, then visibility); each successful response
   * refreshes its snapshot and mutates the loaded data immediately (so a text
   * success followed by a theme failure leaves the UI consistent with what the
   * server actually saved), and whichever part fails surfaces its own error.
   * Wired as the form's submit handler so Enter in any field saves too.
   */
  async function saveInvite(e?: Event) {
    e?.preventDefault();
    if (saving()) return;
    setError(null);

    const textBody = JSON.stringify(textPayload(draft));
    const themeBody = JSON.stringify(themePayload(draft));
    const visibilityBody = JSON.stringify(visibilityPayload(draft));
    const textIsDirty = textBody !== savedText();
    const themeIsDirty = themeBody !== savedTheme();
    const visibilityIsDirty = visibilityBody !== savedVisibility();
    // Unreachable via the UI (the button disables when clean) — belt & braces
    // against a programmatic submit.
    if (!textIsDirty && !themeIsDirty && !visibilityIsDirty) return;

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

      if (visibilityIsDirty) {
        const visibilityRes = await authFetch(apiUrl(`${base()}/visibility`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: visibilityBody,
        });
        if (!visibilityRes.ok) {
          const body = (await visibilityRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Save failed (${visibilityRes.status})`);
        }
        setSavedVisibility(visibilityBody);
        mutate((await visibilityRes.json()) as InviteCustomisation);
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

  // Like the design: one PUT per choice, outside the save bar.
  const [savingEnvelope, setSavingEnvelope] = createSignal(false);

  /** The server-acknowledged envelope, `null` for none. */
  const currentEnvelope = () => data()?.envelopeId ?? null;

  const selectEnvelope = async (envelopeId: EnvelopeId | null) => {
    if (savingEnvelope() || currentEnvelope() === envelopeId) return;
    setSavingEnvelope(true);
    try {
      const res = await authFetch(apiUrl(`${base()}/envelope`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelopeId }),
      });
      if (!res.ok) {
        // The wedding has lost premium envelopes since this builder read it:
        // lock the card rather than let the next click fail the same way.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error === "premium_envelope") setEnvelopeEntitled(false);
        throw new Error(`Envelope save failed (${res.status})`);
      }
      mutate((await res.json()) as InviteCustomisation);
      haptic("commit");
      toast.success("Envelope updated");
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return;
      }
      haptic("reject");
      toast.error("Could not update the envelope");
    } finally {
      setSavingEnvelope(false);
    }
  };

  // The wedding's public guest-invite URL, shared with generated messages.
  const guestBaseUrl = () =>
    `${CIRE_WEB_URL}/cire/invite?slug=${encodeURIComponent(props.weddingSlug)}`;

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
  // Resetting a switchable section also switches it back on — the default a
  // section starts with.
  const resetHero = () => {
    setDraft({
      heroTitle: "",
      heroSubtitle: "",
      heroBlur: HERO_BLUR_DEFAULT,
      titleBackdropOpacity: 0,
      titleBackdropBlur: 0,
    });
    setDraft("tones", "hero", null);
    setDraft("visibility", "hero", true);
  };
  const resetStory = () => {
    setDraft({ storyEyebrow: "", storyHeading: "", storyBody: "" });
    setDraft("tones", "story", null);
    setDraft("visibility", "story", true);
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
    state: heroSectionState(),
    imageUrl: d().hero.imageUrl,
    crop: d().hero.imageCrop,
    cropMobile: d().hero.imageCropMobile ?? null,
    title: draft.heroTitle,
    heroBlur: draft.heroBlur,
    backdropOpacity: draft.titleBackdropOpacity,
    backdropBlur: draft.titleBackdropBlur,
  });
  const storyPreviewProps = (): PreviewPaneProps["story"] => ({
    state: storySectionState(),
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
  const faqPreviewProps = (): PreviewPaneProps["faq"] => ({
    state: faqSectionState(),
    questions: (faqs() ?? []).map((e) => e.question),
  });
  const closingPreviewProps = (d: () => InviteCustomisation): PreviewPaneProps["closing"] => ({
    state: footerSectionState(),
    message: draft.footerMessage,
    imageUrl: d().footer?.imageUrl ?? null,
    imageCrop: d().footer?.imageCrop ?? null,
  });

  /** Choose one of Content's sections, from wherever the organiser is. */
  const showSection = (id: ContentSectionId) => {
    setActiveSection(id);
    if (props.view !== "content") props.onView?.("content");
  };

  /** Content's sections as a glass strip. Manual activation, as every strip:
   *  the arrows move focus and Enter or Space chooses. */
  const sectionStrip = () => (
    <SegmentedTabs
      items={sectionItems()}
      value={activeSection()}
      onChange={setActiveSection}
      label="Invite sections"
      semantics="tabs"
      tabId={(id) => `${id}-tab`}
      panelId={(id) => id}
      scroll
      class="max-w-full min-w-0"
    />
  );

  /** The phone's pill and chevron as one button, its own look, which the
   *  menu's trigger renders as (`as`). Round, so the focus ring is too. */
  function PlaceButton(buttonProps: JSX.ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
      <button
        type="button"
        {...buttonProps}
        class="group mr-auto flex h-7 min-w-0 items-center gap-1.5 rounded-full"
      />
    );
  }

  /**
   * The way between places on a phone: one glass pill naming where the
   * organiser is, and a round glass chevron, as one button that opens a menu
   * of every view, with Content's sections under their eyebrow; a choice
   * moves there and closes the menu, as a way between places does. While it is
   * mounted the module's own strip is hidden (`ViewBar.replaceTabs`); it
   * mounts only once the invite has loaded, so until then, or if it never
   * does, the module's strip is still there to leave by.
   */
  function PhonePlace() {
    const release = useViewBar()?.replaceTabs();
    onCleanup(() => release?.());
    return (
      <DropdownMenu placement="bottom-start" gutter={6}>
        <DropdownMenuTrigger
          as={PlaceButton}
          aria-label={`Invite: ${place().label}${place().note ? ` ${place().note}` : ""}. Choose a view or section`}
        >
          {/* The chosen choice's glass and its readable gold at medium
              weight, as on a strip; a contrast theme drops the glass, so the
              pill draws its own edge there. */}
          <span
            class={`${GLASS_FILL} font-body text-gold-ink text-ui-xs flex h-7 min-w-0 items-center gap-1.5 rounded-full px-3 leading-none font-medium forced-colors:border`}
          >
            <Show when={place().note}>
              <HiddenSectionIcon />
            </Show>
            <span class="truncate">{place().label}</span>
          </span>
          <span
            class={`${GLASS_FILL} text-text-muted group-hover:text-gold-ink transition-ui-colors flex size-7 shrink-0 items-center justify-center rounded-full duration-(--dur-fast) ease-(--ease-out) forced-colors:border`}
          >
            <ChevronDown aria-hidden="true" strokeWidth={1.75} class="size-3.5" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          variant="accent"
          class="max-h-[min(28rem,70vh)] min-w-56 overflow-y-auto"
        >
          {/* The two tiers the strips draw, each one choice: the four views,
              then Content's sections. On Content both carry a check. */}
          <DropdownMenuRadioGroup
            value={props.view}
            onChange={(view) => props.onView?.(view as InviteView)}
          >
            <DropdownMenuLabel class="sr-only">Views</DropdownMenuLabel>
            <For each={INVITE_VIEWS}>
              {(view) => (
                <DropdownMenuRadioItem value={view} closeOnSelect>
                  {VIEW_LABEL[view]}
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={props.view === "content" ? activeSection() : ""}
            onChange={(id) => showSection(id as ContentSectionId)}
          >
            <DropdownMenuLabel tone="eyebrow">Sections</DropdownMenuLabel>
            <For each={CONTENT_SECTIONS}>
              {(section) => (
                <DropdownMenuRadioItem value={section.id} closeOnSelect>
                  <span class="flex items-center gap-2">
                    <Show when={hiddenNote(section.id)}>
                      <HiddenSectionIcon />
                    </Show>
                    {section.label}
                    <Show when={hiddenNote(section.id)}>
                      {(note) => <span class="sr-only">{note()}</span>}
                    </Show>
                  </span>
                </DropdownMenuRadioItem>
              )}
            </For>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    // The ref measures the same box `@container/builder` does — see
    // `watchBuilderWidth`.
    <section ref={watchBuilderWidth} class={BUILDER_CLASS}>
      {/* Codes holds the message alone; the owner's codes sit above it. */}
      <Show when={props.view !== "codes"}>
        <header class="flex flex-col gap-1">
          <h2 class="font-display text-text text-ui-lg font-light">Customise your invite</h2>
          <p class="font-body text-text-muted text-ui-sm">
            Choose a template and its style, then write each part of the page in the order guests
            see it — images, copy and colours together. Events and guests still come from your
            spreadsheet import.
          </p>
        </header>
      </Show>

      {/* A first read that failed says so, rather than loading for ever. */}
      <Show when={loadFailed()}>
        <Notice tone="danger" alert>
          Could not load the invite. Is the API running?
        </Notice>
      </Show>
      <Show
        when={data()}
        fallback={
          <Show when={!loadFailed()}>
            <Loading label="Loading invite…" />
          </Show>
        }
      >
        {(d) => {
          // Memoized once per render pass and shared by the sticky side pane
          // and the mobile modal — without this, the rare frame where
          // both are mounted (the initial "unknown" preview-layer measurement,
          // or resizing to wide while the modal is left open) has each
          // consumer independently re-deriving every slot.
          const heroSlot = createMemo(() => heroPreviewProps(d));
          const storySlot = createMemo(() => storyPreviewProps());
          const welcomeSlot = createMemo(() => welcomePreviewProps());
          const eventsSlot = createMemo(() => eventsPreviewProps());
          const faqSlot = createMemo(() => faqPreviewProps());
          const closingSlot = createMemo(() => closingPreviewProps(d));

          return (
            <form onSubmit={(e) => void saveInvite(e)} class="flex flex-col gap-6">
              {/* ── The way between the builder's places, lent to the module's
                  view bar (`ViewBar`), which is already stuck: under Content its
                  sections as a second glass strip — on the views' own row when
                  the panel has room, on a row of their own when not — and, below
                  the composed pane's width, the Preview button. On a phone, one
                  glass pill naming where the organiser is opens a menu of every
                  view and section, in place of both strips. ── */}
              <Show
                when={phone()}
                fallback={
                  <>
                    {/* On a row of their own, drawn only under Content: the
                        bar's height animation brings the row in and out. */}
                    <Show when={stacked() && props.view === "content"}>
                      <ViewBar slot="row2">{sectionStrip()}</ViewBar>
                    </Show>
                    {/* On the views' row, kept mounted and `hidden` off
                        Content, so the strip fades and slides out as well as
                        in (`section-track`, `global.css`). */}
                    <Show when={!stacked()}>
                      <ViewBar slot="end">
                        <div
                          data-section-track
                          hidden={props.view !== "content"}
                          class="section-track mr-auto flex max-w-full min-w-0 items-center gap-2"
                        >
                          <span
                            data-bar-divider
                            aria-hidden="true"
                            class="bg-border h-5 w-px shrink-0"
                          />
                          {sectionStrip()}
                        </div>
                      </ViewBar>
                    </Show>
                  </>
                }
              >
                <ViewBar slot="end">
                  <PhonePlace />
                </ViewBar>
              </Show>
              {/* Hidden once the sticky side pane below can show instead — the
                  same `@4xl/builder` threshold `showPreviewPane` measures, read
                  in JS because the bar sits outside the builder's container. */}
              {/* Codes edits nothing on the guest page, so it offers no preview. */}
              <Show when={previewLayer() !== "wide" && props.view !== "codes"}>
                <ViewBar slot="end">
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    onClick={() => setPreviewModalOpen(true)}
                    class="shrink-0"
                  >
                    Preview
                  </Button>
                </ViewBar>
              </Show>

              {/* Form and preview side by side from `@4xl/builder` up — a
                threshold the panel could never actually reach while the page was
                capped at 1100px, so the composed preview was effectively dead
                code on the very screens it was written for. */}
              <div class="flex flex-col gap-8 @4xl/builder:flex-row @4xl/builder:items-start @6xl/builder:gap-10">
                <div
                  class={`flex min-w-0 flex-1 flex-col gap-8 ${CLEAR_OF_STUCK_STACK} ${CLEAR_OF_SAVE_BAR}`}
                >
                  {/* ── Design ─────────────────────────────────────────── */}
                  <SectionCard
                    id="invite-design"
                    legend="Design"
                    hidden={props.view !== "template"}
                  >
                    <DesignPicker
                      entitlements={props.entitlements}
                      currentId={currentDesign()}
                      saving={savingDesign()}
                      onSelect={(id) => void selectDesign(id)}
                      previewHref={designPreviewHref}
                    />
                    <Show when={envelopesOffered()}>
                      <EnvelopePicker
                        entitled={envelopeEntitled()}
                        currentId={currentEnvelope()}
                        saving={savingEnvelope()}
                        heroState={heroSectionState()}
                        onSelect={(id) => void selectEnvelope(id)}
                      />
                    </Show>
                  </SectionCard>

                  {/* ── Look (global): typography + the colour scheme ──── */}
                  <SectionCard
                    id="invite-look"
                    legend="Look"
                    hidden={props.view !== "style"}
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
                    <Disclosure
                      nested
                      summary={
                        <>
                          Fine-tune typography
                          <span class="text-text-muted/70 ml-2 italic">
                            size, weight and italics
                          </span>
                        </>
                      }
                    >
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
                    tabPanel={!phone()}
                    legend="Hero"
                    visibility={{
                      state: heroSectionState(),
                      visible: draft.visibility.hero,
                      onChange: (v) => setDraft("visibility", "hero", v),
                      emptyHint: "a title, a subtitle or an image",
                      offNote:
                        "Switched off. Guests won't see the hero section; everything in it is kept for when you switch it back on. Your couple title still names the invite in the browser tab and the page footer, and the photo still heads your gift list.",
                    }}
                    onReset={resetHero}
                    hidden={props.view !== "content" || activeSection() !== "invite-hero"}
                  >
                    {/* Preview FIRST — the display sliders below act on it, and
                      on small screens a preview below the sliders scrolls out
                      of view exactly when it's needed. Mounted only when this
                      layer is the visible one (see `previewLayer`) AND this is
                      the active tab — a hidden tab's inline preview
                      would otherwise still re-render on every token edit for
                      no one to see. */}
                    <Show when={showInlinePreviews() && shownSection() === "invite-hero"}>
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
                    <Disclosure
                      nested
                      summary={
                        <>
                          Hero display
                          <span class="text-text-muted/70 ml-2 italic">
                            photo blur and the title panel
                          </span>
                        </>
                      }
                    >
                      {/* The sliders keep the 16px rhythm the builder's fields use. */}
                      <div class="flex flex-col gap-4">
                        <SliderField
                          label="Hero image blur"
                          hint="0 is a sharp photo; higher is a softer, dreamier backdrop."
                          min={HERO_BLUR_MIN}
                          max={HERO_BLUR_MAX}
                          value={draft.heroBlur}
                          valueText={(v) =>
                            v === 0 ? "0 — sharp photo" : `${v} — softer backdrop`
                          }
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
                      </div>
                    </Disclosure>
                  </SectionCard>

                  {/* ── Our Story ──────────────────────────────────────── */}
                  <SectionCard
                    id="invite-story"
                    tabPanel={!phone()}
                    legend="Our Story"
                    visibility={{
                      state: storySectionState(),
                      visible: draft.visibility.story,
                      onChange: (v) => setDraft("visibility", "story", v),
                      emptyHint: "a heading, the story or a photo",
                    }}
                    onReset={resetStory}
                    hidden={props.view !== "content" || activeSection() !== "invite-story"}
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
                    <Show when={showInlinePreviews() && shownSection() === "invite-story"}>
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
                    tabPanel={!phone()}
                    legend="Code Entry & Welcome"
                    onReset={resetWelcome}
                    hidden={props.view !== "content" || activeSection() !== "invite-welcome"}
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
                    <Show when={showInlinePreviews() && shownSection() === "invite-welcome"}>
                      <SectionPreview
                        label="Code Entry & Welcome"
                        tokens={previewTokens()}
                        surface={toneSurface("welcome")}
                        design={currentDesign()}
                        panel={designLayout(currentDesign()).welcome === "panel"}
                        eyebrow="Your Invitation"
                        heading="Enter your code"
                        body={sampleCopy(draft.welcomeMessage, DEFAULTS.welcomeMessage)}
                      />
                    </Show>
                  </SectionCard>

                  {/* ── Events section ─────────────────────────────────── */}
                  <SectionCard
                    id="invite-events"
                    tabPanel={!phone()}
                    legend="Events Section"
                    onReset={resetEvents}
                    hidden={props.view !== "content" || activeSection() !== "invite-events"}
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
                    <Show when={showInlinePreviews() && shownSection() === "invite-events"}>
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

                  {/* ── FAQ ────────────────────────────────────────────── */}
                  <SectionCard
                    id="invite-faq"
                    tabPanel={!phone()}
                    legend="FAQ"
                    visibility={{
                      state: faqSectionState(),
                      visible: draft.visibility.faq,
                      onChange: (v) => setDraft("visibility", "faq", v),
                      emptyHint: "a question and its answer",
                      offNote:
                        "Switched off. Guests won't see your questions; they are all kept for when you switch it back on.",
                    }}
                    hidden={props.view !== "content" || activeSection() !== "invite-faq"}
                    description="Answer what guests ask anyway — parking, the dress code, children, timing. The questions sit under your events once a guest enters their code, each answer opening from its question. Every household sees every question, unlike the events, which each household sees only when invited — so don't mention an event only some guests are invited to. Questions save as soon as you add, change, reorder or delete them; the switch saves with the rest of the invite."
                  >
                    <FaqEditor
                      weddingId={props.weddingId}
                      entries={faqs()}
                      onEntriesChange={setFaqs}
                      onPendingChange={setFaqPending}
                    />
                    {/* No colour picker of its own — the FAQ sits on the events
                      section's surface, as part of the same block. */}
                    <Show when={showInlinePreviews() && shownSection() === "invite-faq"}>
                      <SectionPreview
                        label="FAQ"
                        tokens={previewTokens()}
                        surface={toneSurface("details")}
                        design={currentDesign()}
                        eyebrow={DEFAULTS.faqEyebrow}
                        heading={DEFAULTS.faqHeading}
                        body={faqSampleBody((faqs() ?? []).map((e) => e.question))}
                      />
                    </Show>
                  </SectionCard>

                  {/* ── Closing section ────────────────────────────────── */}
                  <SectionCard
                    id="invite-closing"
                    tabPanel={!phone()}
                    legend="Closing Section"
                    visibility={{
                      state: footerSectionState(),
                      visible: draft.visibility.footer,
                      onChange: (v) => setDraft("visibility", "footer", v),
                      emptyHint: "a closing image or a closing note",
                    }}
                    hidden={props.view !== "content" || activeSection() !== "invite-closing"}
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
                    <Show when={showInlinePreviews() && shownSection() === "invite-closing"}>
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
                    <p class="font-body text-text-muted text-ui-sm italic">
                      Uses the colours you picked for Code Entry &amp; Welcome — the closing note is
                      you speaking to your guests, same as the greeting.
                    </p>
                  </SectionCard>

                  {/* ── Invite message (not on the guest page) ─────────── */}
                  <SectionCard
                    id="invite-message"
                    legend="Invite message"
                    hidden={props.view !== "codes"}
                    description="Not part of the invite page — this is the first line of the message each household is sent. Leave it blank to use the default."
                  >
                    <TextAreaField
                      label="Invite message (optional)"
                      rows={4}
                      placeholder="You're invited to our wedding! View your invitation and RSVP below."
                      value={draft.inviteMessage}
                      maxLength={COPY_CAPS.inviteMessage}
                      hint="The wedding link and the household's invitation code are appended automatically — don't include them here."
                      onInput={(v) => setDraft("inviteMessage", v)}
                    />
                    <Show when={messageOpened()}>
                      <InviteMessageCopy
                        weddingId={props.weddingId}
                        weddingName={props.weddingName}
                        weddingSlug={props.weddingSlug}
                        canEdit={props.canEdit}
                        savedLine={d().inviteMessage ?? null}
                        draftLine={draft.inviteMessage}
                        codesRevision={props.codesRevision}
                      />
                    </Show>
                    {props.inviteMessageLinks}
                  </SectionCard>
                </div>

                {/* ── Persistent composed preview (wide layouts) ─────────── */}
                {/* The miniature earns more room as the builder widens — at 20rem
                  the hero's type is guesswork; by 24rem the tone rhythm down the
                  page is legible, which is the whole point of the pane. */}
                <Show when={showPreviewPane() && props.view !== "codes"}>
                  <aside class="hidden w-80 shrink-0 @4xl/builder:block @6xl/builder:w-96">
                    {/* Under the stuck chrome (the top bar and the module's
                        view bar), and no taller than the screen left below
                        them, so its foot is never out of reach. */}
                    <div class="sticky top-[calc(var(--chrome-h)+var(--bar-h,0px)+1.5rem)] max-h-[calc(100svh-var(--chrome-h)-var(--bar-h,0px)-1.5rem)] overflow-y-auto">
                      <PreviewPane
                        tokens={previewTokens()}
                        toneSurface={toneSurface}
                        design={currentDesign()}
                        hero={heroSlot()}
                        story={storySlot()}
                        welcome={welcomeSlot()}
                        events={eventsSlot()}
                        faq={faqSlot()}
                        closing={closingSlot()}
                      />
                    </div>
                  </aside>
                </Show>
              </div>

              {/* ── Mobile preview modal — the "Preview" button in the module's
                view bar, the only way to reach the composed preview below
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
                faq={faqSlot()}
                closing={closingSlot()}
              />

              {/* ── Save bar — sticky so it's reachable from any section ── */}
              <div
                ref={trackSaveBarHeight}
                class="border-border bg-bg/90 rounded-b-ui-lg sticky bottom-0 z-10 -mx-6 -mb-6 flex flex-col gap-3 border-t px-6 py-4 backdrop-blur"
              >
                <Show when={error()}>
                  <Notice tone="danger" alert>
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
                      <span class="font-body text-text-muted text-ui-sm">All changes saved</span>
                    }
                  >
                    <span role="status" class="font-body text-gold-ink text-ui-sm">
                      Unsaved changes
                    </span>
                  </Show>
                  <span class="font-body text-text-muted text-ui-sm">
                    Copy, colours, fonts, hero display and which sections show save together.
                    Images, crops and the design apply as soon as you change them.
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

/** A control that takes focus in the section cards stops below the stuck stack:
 *  the top bar and the view bar, whose measured height holds Content's
 *  sections, plus half a rem (DESIGN.md §The stuck stack). */
const CLEAR_OF_STUCK_STACK =
  "[&_:is(button,input,select,textarea,a,[tabindex])]:scroll-mt-[calc(var(--chrome-h)+var(--bar-h,0px)+0.5rem)]";

/** A control that takes focus in the section cards stops clear of the sticky
 *  save bar at the foot of the page: the bar's measured height (`--save-bar-h`,
 *  written on the form by `trackSaveBarHeight`) plus half a rem. The bar's own
 *  button, the tab row and the preview modal do not carry it. */
const CLEAR_OF_SAVE_BAR =
  "[&_:is(button,input,select,textarea,a,[tabindex])]:scroll-mb-[calc(var(--save-bar-h,0px)+0.5rem)]";

/**
 * Writes the save bar's height as `--save-bar-h` on its form, and again
 * whenever it changes (an error row appears, the line wraps). The offset is
 * measured, never a guess: the bar's content grows. Runs as the bar's `ref`, so
 * the observer ends with the bar.
 */
function trackSaveBarHeight(bar: HTMLElement) {
  const form = bar.closest("form");
  if (!form || typeof ResizeObserver === "undefined") return;
  let written: string | undefined;
  const write = () => {
    const value = `${bar.getBoundingClientRect().height}px`;
    if (value === written) return;
    written = value;
    form.style.setProperty("--save-bar-h", value);
  };
  queueMicrotask(write);
  const observer = new ResizeObserver(write);
  observer.observe(bar, { box: "border-box" });
  onCleanup(() => {
    observer.disconnect();
    written = undefined;
    form.style.removeProperty("--save-bar-h");
  });
}

/** Plain-English names for the three surfaces a section can sit on. */
const TONE_LABELS = {
  ground: "Page",
  card: "Card",
  raised: "Raised",
} satisfies Record<SectionTone, string>;

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
  const surfaceFor = {
    ground: "var(--color-bg)",
    card: "var(--color-surface)",
    raised: "var(--color-surface-raised)",
  } satisfies Record<SectionTone, string>;
  return (
    <div class="flex flex-col gap-1.5">
      <span class="font-body text-text-muted text-ui-sm">Section background</span>
      <div
        class="flex flex-wrap gap-2"
        role="group"
        aria-label="Section background"
        style={props.tokens}
      >
        <For each={SECTION_TONES}>
          {(tone) => (
            <Button
              variant="choice"
              type="button"
              aria-pressed={current() === tone}
              onClick={() => props.onChange(tone === "ground" ? null : tone)}
              style={{ "background-color": surfaceFor[tone], color: "var(--color-text)" }}
            >
              {TONE_LABELS[tone]}
            </Button>
          )}
        </For>
      </div>
      <Show when={props.hint}>
        <span class="font-body text-text-muted text-ui-xs italic">{props.hint}</span>
      </Show>
    </div>
  );
}
