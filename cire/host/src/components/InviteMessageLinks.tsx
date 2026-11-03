import { proseLinkClass } from "@cire/ui/button";
import { For, type JSX, Show } from "solid-js";

import { ROLE_COPY } from "../lib/wedding-roles";

/**
 * The two places that together make the message an organiser sends a
 * household: Invite → Codes, where its first line is written (and one
 * household's message copied) beside the codes that end it, whose style an
 * owner changes there; and the household list with a copy action on every row
 * (Guests → Households).
 */
export type InviteMessagePlace = "codes" | "households";

interface InviteMessageLinksProps {
  /** Where this line is shown. It names the other place, never this one. */
  here: InviteMessagePlace;
  /** Owner or editor: may open Invite → Codes, and so the message editor. */
  canEdit: boolean;
  /** Owner: may change the code style there. */
  canManage: boolean;
  /** A place's address, so a link can open in a new tab and say where it goes. */
  href: (place: InviteMessagePlace) => string;
  /** Go to a place. Only called for a place the reader may open. */
  onNavigate: (place: InviteMessagePlace) => void;
}

/** Each place as the path an organiser follows to it — the words on the rail
 *  and the sub-tabs. */
const PLACE_PATH = {
  codes: ["Invite", "Codes"],
  households: ["Guests", "Households"],
} as const satisfies Readonly<Record<InviteMessagePlace, readonly string[]>>;

/** Who may open a place, said after its name when the reader may not. */
const OPENED_BY = {
  codes: `${ROLE_COPY.owner.label} and ${ROLE_COPY.editor.label} only`,
  households: "",
} satisfies Readonly<Record<InviteMessagePlace, string>>;

type PlaceRenderer = (place: InviteMessagePlace) => JSX.Element;

/** The sentence shown in each place. The code style is picked when the wedding
 *  is created; an owner changes it in Codes, by re-minting every code, at the
 *  top of the same view as the message. */
const SENTENCE = {
  codes: (place, canManage) => (
    <>
      Save, then copy a household's message above, or from {place("households")}. The code on its
      last line keeps the style chosen when the wedding was created
      {canManage ? "; change it at the top of this page." : ", which an owner can change."}
    </>
  ),
  households: (place, canManage) => (
    <>
      Each message opens with the line written in {place("codes")} and ends with the household's
      code, in the style chosen when the wedding was created
      {canManage ? "; change it there." : "."}
    </>
  ),
} satisfies Readonly<
  Record<InviteMessagePlace, (place: PlaceRenderer, canManage: boolean) => JSX.Element>
>;

/** A click the browser should handle itself: a new tab, a new window, a
 *  download, or any button but the main one. */
const opensElsewhere = (event: MouseEvent): boolean =>
  event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

/** A place's path spoken as a list, "Invite, Codes" — never "Invite right
 *  arrow Codes". */
const spokenPath = (place: InviteMessagePlace): string => PLACE_PATH[place].join(", ");

/** A place's path, drawn with arrows. The arrow is hidden from assistive tech
 *  and a hidden comma stands in for it, so read as text it is the same list
 *  {@link spokenPath} gives a link. */
function PlacePath(props: { place: InviteMessagePlace }) {
  return (
    <For each={PLACE_PATH[props.place]}>
      {(part, index) => (
        <>
          <Show when={index() > 0}>
            <span aria-hidden="true"> → </span>
            <span class="sr-only">, </span>
          </Show>
          {part}
        </>
      )}
    </For>
  );
}

/**
 * One line that tells an organiser where the other two places are, so none of
 * the three has to be found by guessing. A place the reader can open is a link;
 * one their role cannot open is named as text, with who can.
 *
 * Each link is an `<a href>` to the place's address, so it wraps with its
 * sentence and a modifier or middle click opens the place in a new tab. A plain
 * click does not follow the address: it navigates through the dashboard's own
 * route callback, because a hash change skips the invite builder's
 * unsaved-changes check.
 */
export default function InviteMessageLinks(props: InviteMessageLinksProps) {
  const canOpen = (place: InviteMessagePlace): boolean => {
    switch (place) {
      case "codes":
        return props.canEdit;
      case "households":
        return true;
    }
  };

  const place: PlaceRenderer = (target) => (
    <Show
      when={canOpen(target)}
      fallback={
        <span>
          <PlacePath place={target} /> ({OPENED_BY[target]})
        </span>
      }
    >
      {/* The muted prose link: inside a sentence the underline at rest is what
          marks the words as a link (WCAG 1.4.1). */}
      <a
        href={props.href(target)}
        class={proseLinkClass({ tone: "muted" })}
        aria-label={spokenPath(target)}
        onClick={(event) => {
          if (opensElsewhere(event)) return;
          event.preventDefault();
          props.onNavigate(target);
        }}
      >
        <PlacePath place={target} />
      </a>
    </Show>
  );

  return (
    <p class="font-body text-text-muted text-ui-sm leading-ui-normal max-w-prose">
      {SENTENCE[props.here](place, props.canManage)}
    </p>
  );
}
