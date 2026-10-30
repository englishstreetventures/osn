import Button, { proseLinkClass } from "@cire/ui/button";
import { CATEGORY_LIST, type ConsentCategory } from "@cire/ui/consent-categories";
import { gatedVendorsInCategory } from "@cire/ui/consent-vendors";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { Modal } from "@shared/ui/ui/modal";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";

import type { ConsentGrants } from "../../lib/consent/record";
import { closeConsentPreferences, currentGrants, saveConsent } from "../../lib/consent/store";

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
      <h2 id={titleId} class="font-display text-text text-ui-lg leading-ui-tight font-light">
        Your privacy choices
      </h2>
      <p id={descriptionId} class="font-body text-text-muted text-ui-sm leading-ui-normal mt-2">
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
      <p class="font-body text-text-muted/80 text-ui-sm leading-ui-normal mt-1.5">
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
        {/* The sheet's one commit, so the filled `primary` rather than the
            outlined `cta` the prompt's three equal choices take. */}
        <Button variant="primary" size="sm" onClick={() => saveConsent(draft())}>
          Save choices
        </Button>
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
  const vendor = () => gatedVendorsInCategory(props.id)[0];

  // The title and the summary are the label, so a tap anywhere on either ticks
  // the box; the box is named by the title and described by the summary. The
  // vendor's line holds a link, so it is the box's note, outside the label.
  return (
    <div class="border-border/60 bg-surface-raised/40 rounded-sm border px-4 py-3.5">
      <Checkbox
        box="native"
        align="start"
        checked={props.checked}
        onChange={props.onChange}
        label={props.title}
        description={props.summary}
        note={
          <Show when={vendor()?.privacyUrl}>
            {(url) => (
              <p class="font-body text-text-muted text-ui-xs leading-ui-snug">
                <Show when={vendor()?.transfer}>{(transfer) => <>{transfer()} · </>}</Show>
                <a href={url()} target="_blank" rel="noopener noreferrer" class={proseLinkClass()}>
                  privacy policy <span aria-hidden="true">↗</span>
                  <span class="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
            )}
          </Show>
        }
      />
    </div>
  );
}
