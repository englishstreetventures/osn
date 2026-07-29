import { createSignal, createUniqueId, For, type JSX, onCleanup, onMount, Show } from "solid-js";

import {
  CATEGORY_LIST,
  type ConsentCategory,
  isRequiredCategory,
} from "../../lib/consent/categories";
import type { ConsentGrants } from "../../lib/consent/record";
import {
  acceptAllConsent,
  closeConsentPreferences,
  currentGrants,
  rejectAllConsent,
  saveConsent,
} from "../../lib/consent/store";
import {
  type ConsentVendor,
  gatedVendorsInCategory,
  ungatedVendorsInCategory,
} from "../../lib/consent/vendors";
import { Z_CLASS } from "../../lib/z-index";

/** Selector for the tab-order-relevant focusable descendants of the panel. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * The "Choose" layer — per-category toggles, with the vendors each one governs
 * listed underneath so the choice is made against the actual disclosure rather
 * than against a category name.
 *
 * Toggles are seeded from the guest's stored decision and edited LOCALLY until
 * they press Save. Writing each flip straight through to the cookie would mean
 * a guest who opened the dialog to read it, flicked a switch to see what it
 * covered, and then closed the dialog had silently granted consent they never
 * confirmed. Nothing here persists without the explicit Save (or one of the two
 * one-click actions, which are unambiguous by construction).
 *
 * Vendors that the toggle does NOT govern (`enforcement: "always"` — today only
 * Google Fonts, loaded from the document head) are listed separately under an
 * explicit "loads on every visit" heading. Hiding them would leave the dialog
 * quietly overstating what the switch controls; listing them under the switch
 * as though it applied would do the same thing more loudly.
 */
export function ConsentPreferences() {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();

  const [draft, setDraft] = createSignal<ConsentGrants>({ ...currentGrants() });

  let panelRef: HTMLDivElement | undefined;
  let previouslyFocused: HTMLElement | null = null;

  function focusables(): HTMLElement[] {
    if (!panelRef) return [];
    return Array.from(panelRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  // Escape closes; Tab is trapped inside the panel. Same contract as
  // AnimatedModal — the consent dialog is a modal dialog and has to behave like
  // one, but it deliberately does not reuse AnimatedModal: that component
  // applies the invite's per-section theme variables and sits at the modal
  // layer, and this dialog also has to render on the legal pages, which have no
  // invite theme and no modal beneath it.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeConsentPreferences();
      return;
    }
    if (event.key !== "Tab") return;

    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      panelRef?.focus();
      return;
    }

    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;

    if (event.shiftKey && (active === first || !panelRef?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMount(() => {
    previouslyFocused = document.activeElement as HTMLElement | null;
    document.addEventListener("keydown", onKeyDown);
    // Focus the panel itself rather than the first control, so a screen reader
    // announces the dialog's name and purpose before its options.
    panelRef?.focus();
  });

  onCleanup(() => {
    document.removeEventListener("keydown", onKeyDown);
    previouslyFocused?.focus?.();
  });

  function toggle(category: ConsentCategory, next: boolean) {
    if (isRequiredCategory(category)) return;
    setDraft((current) => ({ ...current, [category]: next }));
  }

  return (
    <div
      class={`fixed inset-0 ${Z_CLASS.CONSENT_DIALOG} flex items-end justify-center sm:items-center`}
    >
      {/* Backdrop. Clicking it closes WITHOUT saving — a dismissal is not a
          decision, so the draft is discarded and the banner stays up. */}
      <div
        class="absolute inset-0 bg-black/70"
        aria-hidden="true"
        onClick={closeConsentPreferences}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabindex="-1"
        class="border-border bg-bg relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-lg border p-6 focus:outline-none sm:rounded-lg"
      >
        <h2 id={titleId} class="font-display text-text text-[1.4rem] leading-tight font-light">
          Your privacy choices
        </h2>
        <p id={descriptionId} class="font-body text-text-muted mt-2 text-[0.82rem] leading-relaxed">
          Choose what this invite is allowed to load. You can change this at any time from the link
          in the footer of any page.
        </p>
        {/* S-M1 residual, stated rather than glossed over: switching a category
            off stops anything further loading, but code from that company which
            already ran during this visit stays in the page until it is
            reloaded. Claiming a clean revocation without a reload would
            overstate what the toggle does. */}
        <p class="font-body text-text-muted/80 mt-1.5 text-[0.76rem] leading-relaxed">
          Switching something off takes effect straight away for anything not yet loaded. To also
          clear content already loaded during this visit, reload the page afterwards.
        </p>

        <div class="mt-5 flex flex-col gap-4">
          <For each={CATEGORY_LIST}>
            {(category) => (
              <CategoryRow
                id={category.id}
                title={category.title}
                summary={category.summary}
                required={category.required}
                checked={draft()[category.id]}
                onChange={(next) => toggle(category.id, next)}
              />
            )}
          </For>
        </div>

        <div class="border-border/70 mt-6 flex flex-col gap-2 border-t pt-5 sm:flex-row sm:justify-between">
          {/* Reject and Accept are rendered as siblings with identical weight.
              A refusal that is visually harder to reach than an acceptance is
              not a free choice, and is the specific dark pattern the "reject
              must be as easy as accept" rule targets. */}
          <div class="flex gap-2">
            <ChoiceButton onClick={rejectAllConsent}>Reject all</ChoiceButton>
            <ChoiceButton onClick={acceptAllConsent}>Accept all</ChoiceButton>
          </div>
          <ChoiceButton primary onClick={() => saveConsent(draft())}>
            Save choices
          </ChoiceButton>
        </div>
      </div>
    </div>
  );
}

function CategoryRow(props: {
  id: ConsentCategory;
  title: string;
  summary: string;
  required: boolean;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const inputId = createUniqueId();
  const gated = () => gatedVendorsInCategory(props.id);
  const ungated = () => ungatedVendorsInCategory(props.id);

  return (
    <div class="border-border/60 bg-surface-raised/40 rounded-md border px-4 py-3.5">
      <div class="flex items-start gap-3">
        <input
          id={inputId}
          type="checkbox"
          checked={props.checked}
          disabled={props.required}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
          class="accent-gold mt-0.5 h-4 w-4 shrink-0 disabled:opacity-60"
        />
        <div class="min-w-0 flex-1">
          <label
            for={inputId}
            class="font-body text-text flex items-center gap-2 text-[0.88rem] font-normal"
          >
            {props.title}
            <Show when={props.required}>
              <span class="text-gold/80 text-[0.62rem] tracking-[0.14em] uppercase">Always on</span>
            </Show>
          </label>
          <p class="font-body text-text-muted mt-1 text-[0.76rem] leading-relaxed">
            {props.summary}
          </p>

          <Show when={gated().length > 0}>
            <VendorList label="This switch controls" vendors={gated()} />
          </Show>
          <Show when={ungated().length > 0}>
            {/* Named plainly rather than omitted — see the module doc. */}
            <VendorList label="Loads on every visit, whatever you choose" vendors={ungated()} />
          </Show>
        </div>
      </div>
    </div>
  );
}

function VendorList(props: { label: string; vendors: readonly ConsentVendor[] }) {
  return (
    <div class="mt-2.5">
      <p class="font-body text-text-muted/70 text-[0.66rem] tracking-[0.1em] uppercase">
        {props.label}
      </p>
      <ul class="mt-1 flex flex-col gap-1">
        <For each={props.vendors}>
          {(vendor) => (
            <li class="font-body text-text-muted text-[0.74rem] leading-snug">
              <span class="text-text/90">{vendor.name}</span>
              <Show when={vendor.transfer}>{(transfer) => <> — {transfer()}</>}</Show>
              <Show when={vendor.privacyUrl}>
                {(url) => (
                  <>
                    {" "}
                    <a
                      href={url()}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-gold underline underline-offset-2"
                    >
                      privacy policy ↗
                    </a>
                  </>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

function ChoiceButton(props: { primary?: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={
        props.primary
          ? "border-gold bg-gold text-bg font-body hover:text-gold focus-visible:ring-gold/60 rounded-sm border px-5 py-2 text-[0.74rem] tracking-[0.12em] uppercase transition-colors duration-200 hover:bg-transparent focus:outline-none focus-visible:ring-2"
          : "border-border font-body text-text hover:border-gold hover:text-gold focus-visible:ring-gold/60 rounded-sm border px-5 py-2 text-[0.74rem] tracking-[0.12em] uppercase transition-colors duration-200 focus:outline-none focus-visible:ring-2"
      }
    >
      {props.children}
    </button>
  );
}
