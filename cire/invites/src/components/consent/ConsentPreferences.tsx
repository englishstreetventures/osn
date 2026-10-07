import { Modal } from "@shared/ui/ui/modal";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";

import { CATEGORY_LIST, type ConsentCategory } from "../../lib/consent/categories";
import type { ConsentGrants } from "../../lib/consent/record";
import { closeConsentPreferences, currentGrants, saveConsent } from "../../lib/consent/store";
import { gatedVendorsInCategory } from "../../lib/consent/vendors";

/** The switches the sheet offers: every category but the required one. */
const SWITCHES = CATEGORY_LIST.filter((category) => !category.required);

/**
 * The "Choose" sheet — one switch per third party that needs consent (the
 * Pinterest moodboard, the Google venue map) and Save. Nothing else: what the
 * site stores to work at all is necessary, needs no switch, and is described
 * in the privacy notice.
 *
 * Switches are seeded from the guest's stored decision and edited LOCALLY
 * until they press Save. Writing each flip straight through to the cookie
 * would mean a guest who opened the sheet to read it, flicked a switch to see
 * what it covered, and then closed it had silently granted consent they never
 * confirmed. Nothing here persists without the explicit Save.
 */
export function ConsentPreferences() {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();

  const [draft, setDraft] = createSignal<ConsentGrants>({ ...currentGrants() });

  function toggle(category: ConsentCategory, next: boolean) {
    setDraft((current) => ({ ...current, [category]: next }));
  }

  return (
    // `Modal` rather than `AnimatedModal`: that one applies the invite's
    // per-section theme variables, and this sheet also renders on `/privacy`
    // and `/terms`, which have no invite theme at all.
    //
    // A dismissal is not a decision. Escape and a backdrop click both discard
    // the draft and leave the prompt up, and `onClose` is wired to nothing but
    // `closeConsentPreferences` so there is no path where one writes a record.
    //
    // Plain utilities in `class`, never `base:` ones: `Modal`'s own defaults
    // are `:where(…)`, so a plain utility beats them and a `base:` one ties —
    // see `wiki/shared/component-library.md`.
    <Modal
      open
      onClose={closeConsentPreferences}
      labelledBy={titleId}
      aria-describedby={descriptionId}
      presentation="sheet"
      // The page ground, not the raised surface a dialog normally floats on:
      // this panel's own switch rows ARE raised surfaces, and a panel painted
      // the same colour stops them reading as rows.
      surface="ground"
      class="max-w-lg"
    >
      <h2 id={titleId} class="font-display text-text text-ui-lg leading-tight font-light">
        Your privacy choices
      </h2>
      <p id={descriptionId} class="font-body text-text-muted text-ui-sm mt-2 leading-relaxed">
        Choose which of these the invite may load. You can change this at any time from the link in
        the footer of any page.
      </p>
      {/* Turning a switch off removes its embeds at once, and reloads the
          page when an embed that already ran left code running in the page
          itself — see `saveConsent` in `lib/consent/store.ts` — so that
          company's code is stopped, not just kept from loading again. Stated
          here because a silent reload the guest didn't expect is its own kind
          of surprising, and hedged on "may" because the reload only happens
          when there is something the removal could not stop. Neither the
          removal nor the reload takes back what the company already received
          or stored; `/privacy` states that in full. */}
      <p class="font-body text-text-muted/80 text-ui-sm mt-1.5 leading-relaxed">
        Turning something off takes effect at once; the page may reload. Data already sent to that
        company can't be recalled.
      </p>

      <div class="mt-5 flex flex-col gap-4">
        <For each={SWITCHES}>
          {(category) => (
            <SwitchRow
              id={category.id}
              title={category.title}
              summary={category.summary}
              checked={draft()[category.id]}
              onChange={(next) => toggle(category.id, next)}
            />
          )}
        </For>
      </div>

      <div class="border-border/70 mt-6 flex justify-end border-t pt-5">
        <button
          type="button"
          onClick={() => saveConsent(draft())}
          class="border-gold bg-gold text-bg font-body hover:text-gold-ink focus-visible:ring-gold/60 text-ui-xs tracking-ui-wider rounded-sm border px-5 py-2 uppercase transition-colors duration-200 hover:bg-transparent focus:outline-none focus-visible:ring-2"
        >
          Save choices
        </button>
      </div>
    </Modal>
  );
}

function SwitchRow(props: {
  id: ConsentCategory;
  title: string;
  summary: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  const inputId = createUniqueId();
  const vendor = () => gatedVendorsInCategory(props.id)[0];

  return (
    <div class="border-border/60 bg-surface-raised/40 rounded-md border px-4 py-3.5">
      <div class="flex items-start gap-3">
        <input
          id={inputId}
          type="checkbox"
          checked={props.checked}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
          class="accent-gold mt-0.5 h-4 w-4 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <label for={inputId} class="font-body text-text text-ui-base font-normal">
            {props.title}
          </label>
          <p class="font-body text-text-muted text-ui-sm mt-1 leading-relaxed">{props.summary}</p>
          <Show when={vendor()?.privacyUrl}>
            {(url) => (
              <p class="font-body text-text-muted text-ui-xs mt-1.5 leading-snug">
                <Show when={vendor()?.transfer}>{(transfer) => <>{transfer()} · </>}</Show>
                <a
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-gold-ink underline underline-offset-2"
                >
                  privacy policy ↗
                </a>
              </p>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}
