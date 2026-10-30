import { ORGANISER_EMAIL_ATTESTATION } from "@cire/guest-email";
import { proseLinkClass } from "@cire/ui/button";
import Eyebrow from "@cire/ui/eyebrow";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { Notice } from "@shared/ui/ui/notice";

import { CIRE_MARKETING_URL } from "../lib/osn";

/**
 * The organiser's attestation for the guest addresses a change adds or
 * changes, shown in a change preview when `count` is above zero.
 *
 * The box opens unticked, and the preview's Apply waits for it. The words are
 * `ORGANISER_EMAIL_ATTESTATION.text`, whose version the apply sends; the API
 * stamps that version onto each address as the evidence of what was ticked.
 * The guests' privacy notice is linked under the box, outside the label, so
 * the link is no part of what the box attests or of its accessible name; it
 * opens in a new tab, so the preview stays as it is.
 */
export default function EmailAttestationCheck(props: {
  /** How many addresses the change sets on the organiser's word. */
  count: number;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Notice tone="accent" size="sm">
      <div class="flex flex-col gap-1.5">
        <Eyebrow>
          {props.count === 1 ? "1 email address" : `${props.count} email addresses`}
        </Eyebrow>
        <Checkbox
          box="native"
          size="sm"
          align="start"
          checked={props.checked}
          onChange={props.onChange}
          disabled={props.disabled}
          label={ORGANISER_EMAIL_ATTESTATION.text}
          note={
            <p class="font-body text-text-muted text-ui-sm leading-ui-normal">
              The notice to share:{" "}
              <a
                href={`${CIRE_MARKETING_URL}/privacy/guests`}
                target="_blank"
                rel="noopener noreferrer"
                class={proseLinkClass()}
              >
                cireweddings.com/privacy/guests<span class="sr-only"> (opens in a new tab)</span>
              </a>
            </p>
          }
        />
      </div>
    </Notice>
  );
}
