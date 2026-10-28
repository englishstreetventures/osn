import Button from "@cire/ui/button";
import { CATEGORY_META, type ConsentCategory } from "@cire/ui/consent-categories";
import { vendorById } from "@cire/ui/consent-vendors";
import { type JSX, onMount, Show } from "solid-js";

import {
  grantCategory,
  hydrateConsent,
  isCategoryGranted,
  noteGatedContentLoaded,
  openConsentPreferences,
} from "../../lib/consent/store";

interface ConsentGateProps {
  /** The category that must be switched on before `children` may render. */
  category: ConsentCategory;
  /** Registry id of the third party behind this gate — names it in the placeholder. */
  vendor: string;
  /**
   * What to render instead when the category is off. Omit for the standard
   * placeholder (vendor name + purpose + an in-place "allow" button). Pass
   * something else when the component already has a good un-consented state to
   * fall back to: `MapPreview` passes its drawn map card, which is a better
   * answer than a permission notice where a map should be, and `PinterestBoard`
   * its moodboard block, which links out and offers to show the board in place.
   */
  fallback?: JSX.Element;
  children: JSX.Element;
}

/**
 * Renders `children` only while `category` is switched on.
 *
 * This is the single choke point that replaced the bespoke, Pinterest-shaped
 * gate: previously the one third party that happened to have a consent story
 * carried its own persisted key, its own prompt and its own copy inside the
 * component that used it, while the Google Maps embed — an equivalent transfer
 * to an equivalent US recipient — had no gate at all, because nobody had
 * written it one. Consent lived wherever someone had remembered to put it.
 *
 * Every optional category is off until the guest allows it (see
 * `cire/ui/src/consent-categories.ts`), so wrapping an embed keeps it from loading for
 * an undecided guest, and makes it *governed*: a switch in the preferences
 * sheet, named in the privacy notice, and switchable off again for good. The
 * old arrangement could offer that for Pinterest and nothing else.
 *
 * Children are not rendered — not hidden — while the category is off, so a
 * gated component's `onMount`/`createEffect` never runs and no request can
 * escape. That is what makes a refusal real for something like Pinterest, whose
 * entire tracker is injected from inside such an effect; a version that mounted
 * always and hid its output behind a CSS class would have made the request
 * anyway.
 */
export function ConsentGate(props: ConsentGateProps) {
  // Read the persisted decision on mount. Every gate does this rather than
  // depending on a banner having mounted first, so an embed behaves correctly
  // on any page — including one that never shows the banner because the guest
  // already decided. Until this runs the store sits at the required-only floor,
  // so a stored refusal is never briefly overridden by a default.
  onMount(hydrateConsent);

  // Which vendor's code this gate actually ran decides whether a later refusal
  // needs a reload to tear it down — see `noteGatedContentLoaded`. Read inside
  // the `Show`'s children so it runs when children render, not on the
  // placeholder branch. The store decides from the vendor registry whether that
  // vendor needs a reload at all.
  const noteLoaded = () => {
    noteGatedContentLoaded(props.category, props.vendor);
    return props.children;
  };

  return (
    <Show
      when={isCategoryGranted(props.category)}
      fallback={
        props.fallback ?? <ConsentPlaceholder category={props.category} vendor={props.vendor} />
      }
    >
      {noteLoaded()}
    </Show>
  );
}

/**
 * The standard blocked-content notice: what would be here, who it comes from,
 * and two ways to act on it. The default for a gate given no fallback of its
 * own; both embeds on the invite today pass one.
 *
 * It shows both to a guest who refused and to one who has not answered yet,
 * so the copy says what the guest is not seeing and how to allow it, without
 * claiming which of the two they are — and it does not nag. Both routes are
 * offered on purpose: "Allow" turns just this switch on, so a guest who
 * changes their mind about the moodboard isn't sent through a settings sheet
 * to get it; "Privacy choices" opens both switches together.
 */
export function ConsentPlaceholder(props: { category: ConsentCategory; vendor: string }) {
  const vendor = () => vendorById(props.vendor);
  const vendorName = () => vendor()?.name ?? "This content";
  const categoryTitle = () => CATEGORY_META[props.category].title;

  return (
    <div class="border-border/70 bg-surface-raised/60 mt-2 rounded-sm border px-4 py-4 text-center">
      {/* The purpose is written in the third person for the privacy notice
          ("Shows the couple's…"), so it follows "It" here rather than "would",
          which would need the bare verb. */}
      <p class="font-body text-text-muted text-ui-sm leading-ui-normal">
        <Show when={vendor()?.purpose} fallback={<>Content from {vendorName()} is switched off.</>}>
          {(purpose) => (
            <>
              Content from {vendorName()} would appear here. It{" "}
              {purpose().charAt(0).toLowerCase() + purpose().slice(1)}
            </>
          )}
        </Show>
      </p>
      <p class="font-body text-text-muted text-ui-xs leading-ui-normal mt-1.5">
        It's switched off until you allow it. It loads from {vendorName()}'s servers, which lets
        them see your IP address and browser.
      </p>
      {/* Allowing is offered, not urged: `quiet`, not the call-to-action shape.
          Both controls take a 44px target, as everything a thumb has to hit on
          the invite does. */}
      <div class="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <Button
          variant="quiet"
          size="sm"
          type="button"
          class="min-h-11"
          onClick={() => grantCategory(props.category)}
        >
          Allow {categoryTitle()}
        </Button>
        <Button
          variant="touchLink"
          size="sm"
          type="button"
          class="min-h-11"
          onClick={openConsentPreferences}
        >
          Privacy choices
        </Button>
      </div>
    </div>
  );
}
