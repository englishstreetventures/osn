import { buttonClass } from "@cire/ui/button";
import { type Component, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

/** The row link pills sit in, and the container a marked pill reads its width from. */
export const LINK_PILL_ROW = "@container flex flex-wrap items-center gap-2";

const PILL = `${buttonClass({ variant: "outline", size: "sm" })} h-7`;
const MARKED_PILL = `${PILL} @max-[14rem]:w-7 @max-[14rem]:px-0`;

export interface LinkPillProps {
  href: string;
  /** The destination's mark. With one, the pill turns to a circle in a narrow row. */
  mark?: Component<{ class?: string }>;
  /** Heard after the word, never shown: what or whose the destination is. */
  hint?: string;
  /** The word on the pill, and a marked pill's title under the pointer. */
  label: string;
}

/**
 * A link that stands alone — a vendor's website, an event's map, a gift's shop
 * page — drawn as a pill rather than as underlined words: a pill reads as a
 * link on its own, where underlined words need a sentence around them. A link
 * inside a sentence is not this: it takes `proseLinkClass`.
 *
 * `Button`'s `outline` at `sm`, at the portal's 28px pill height: accent ink
 * on an accent hairline that turns full gold under the pointer, because a
 * link leads somewhere.
 *
 * A named destination someone knows by its mark — a website, Instagram, a map,
 * Pinterest — leads with that mark at 14px. In a row too narrow for its pills
 * (under 14rem, about the width of the two widest side by side) a marked pill
 * drops its word to a 28px circle; the word stays in its name, and in its
 * title, so the circle names itself under the pointer too. A pill with no mark
 * keeps its word at every width, since a circle would have nothing to say.
 *
 * Every place a portal pill leads is away from the portal — a vendor's site, a
 * map, a shop, the live invite — so it opens in a new tab, keeping the host's
 * place, and says so in hidden words after its name. An address that is not
 * `http:` or `https:` draws no pill at all ({@link webHref}).
 */
export function LinkPill(props: LinkPillProps) {
  return (
    <Show when={webHref(props.href)}>
      {(href) => (
        <a
          href={href()}
          target="_blank"
          rel="noopener noreferrer"
          class={props.mark ? MARKED_PILL : PILL}
          title={props.mark ? props.label : undefined}
        >
          <Show when={props.mark}>
            {(mark) => <Dynamic component={mark()} class="size-3.5 shrink-0" />}
          </Show>
          <span class={props.mark ? "@max-[14rem]:sr-only" : undefined}>{props.label}</span>
          <Show when={props.hint}>{(hint) => <span class="sr-only"> {hint()}</span>}</Show>
          <span class="sr-only"> (opens in a new tab)</span>
        </a>
      )}
    </Show>
  );
}

/**
 * `href` when it is an absolute `http:` or `https:` address, and `null`
 * otherwise, so the pill draws nothing. Many of these addresses are typed by
 * a vendor or a co-host, and a `javascript:` link would run in the portal's
 * own origin; the pill refuses one whatever its caller checked.
 */
function webHref(href: string): string | null {
  try {
    const { protocol } = new URL(href);
    return protocol === "https:" || protocol === "http:" ? href : null;
  } catch {
    return null;
  }
}

/**
 * Instagram's mark, as an outline in the ink around it. Lucide, which the
 * portal draws its other icons from, carries no brand marks; this is the
 * Feather outline `pulse/web` already draws.
 */
export function InstagramMark(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}
