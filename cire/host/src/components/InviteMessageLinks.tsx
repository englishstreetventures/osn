import Button from "@cire/ui/button";
import { For, type JSX, Show } from "solid-js";

import { ROLE_COPY } from "../lib/wedding-roles";

/**
 * The three places that together make the message an organiser sends a
 * household: its first line (the invite builder's Message section), the code on
 * its last line (Invite → Codes, where the owner changes the code style), and
 * the copy action (Guests → Households).
 */
export type InviteMessagePlace = "message" | "codes" | "households";

interface InviteMessageLinksProps {
  /** Where this line is shown. It names the other two places, never this one. */
  here: InviteMessagePlace;
  /** Owner or editor: may open the invite builder, and so the message editor. */
  canEdit: boolean;
  /** Owner: may open Invite → Codes. */
  canManage: boolean;
  /** Go to a place. Only called for a place the reader may open. */
  onNavigate: (place: InviteMessagePlace) => void;
}

/** Each place as the path an organiser follows to it — the words on the rail,
 *  the sub-tabs and the builder's section tabs. */
const PLACE_PATH = {
  message: ["Invite", "Design", "Message"],
  codes: ["Invite", "Codes"],
  households: ["Guests", "Households"],
} as const satisfies Readonly<Record<InviteMessagePlace, readonly string[]>>;

/** Who may open a place, said after its name when the reader may not. */
const OPENED_BY = {
  message: `${ROLE_COPY.owner.label} and ${ROLE_COPY.editor.label} only`,
  codes: `${ROLE_COPY.owner.label} only`,
  households: "",
} satisfies Readonly<Record<InviteMessagePlace, string>>;

type PlaceRenderer = (place: InviteMessagePlace) => JSX.Element;

/** The sentence shown in each place. The code style is picked when the wedding
 *  is created; Codes only changes it, by re-minting every code. */
const SENTENCE = {
  message: (place) => (
    <>
      Save, then copy each household's message from {place("households")}. The code on its last line
      keeps the style chosen when the wedding was created; change it in {place("codes")}.
    </>
  ),
  codes: (place) => (
    <>
      Each code is the last line of a household's invite message. Write the line above it in{" "}
      {place("message")}, and copy each household's message from {place("households")}.
    </>
  ),
  households: (place) => (
    <>
      Each message opens with the line written in {place("message")} and ends with the household's
      code, in the style chosen when the wedding was created; change it in {place("codes")}.
    </>
  ),
} satisfies Readonly<Record<InviteMessagePlace, (place: PlaceRenderer) => JSX.Element>>;

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
 * The links are buttons that navigate through the dashboard's own route
 * callbacks rather than `#/…` anchors, because a hash change skips the invite
 * builder's unsaved-changes check.
 */
export default function InviteMessageLinks(props: InviteMessageLinksProps) {
  const canOpen = (place: InviteMessagePlace): boolean => {
    switch (place) {
      case "message":
        return props.canEdit;
      case "codes":
        return props.canManage;
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
      {/* `touchLink`, not `link`: inside a sentence the underline at rest is
          what marks the words as a link. `link` shows its underline only on
          hover, leaving colour alone to do it, which WCAG 1.4.1 does not
          accept for a link set in running text. */}
      <Button
        variant="touchLink"
        aria-label={spokenPath(target)}
        onClick={() => props.onNavigate(target)}
      >
        {/* One flex item, so the button's gap does not open between the path's
            words and the underline runs unbroken. */}
        <span>
          <PlacePath place={target} />
        </span>
      </Button>
    </Show>
  );

  return (
    <p class="font-body text-text-muted text-ui-sm max-w-prose leading-relaxed">
      {SENTENCE[props.here](place)}
    </p>
  );
}
