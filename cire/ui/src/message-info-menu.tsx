import {
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPortal,
  MenuRoot,
} from "@kobalte/core/menu";
import { Separator } from "@kobalte/core/separator";
import {
  menuLabelClass,
  menuPanelClass,
  menuRowClass,
  menuSeparatorClass,
} from "@shared/ui/ui/menu-classes";
import type { JSX } from "solid-js";

import { fullDateTime } from "./lib/message-time";
import type { MessageThreadItem } from "./message-bubble";

/**
 * A message's info, opened by a right-click or from the keyboard (Shift and
 * F10, or the menu key). It says who sent the message and the whole date and
 * time, and offers "Copy text". Drawn in the shared menu's `accent`
 * look, so it reads as every other portal menu (host DESIGN.md §7).
 *
 * The thread decides when it opens and where; this module only draws it. It
 * is Kobalte's menu root, controlled by `open` and placed by `getAnchorRect`,
 * from which Kobalte's positioner builds a virtual anchor, so the menu opens at
 * the point the thread hands it — the root `ContextMenu` is built on, without
 * the trigger it adds. Keeping that trigger out is what lets the thread leave a
 * phone's long press and a right-click on selected words to the browser.
 *
 * Focus goes back to the message when the menu closes from inside it (Escape,
 * "Copy text"), and stays where it went when the reader clicked elsewhere.
 *
 * Loaded with `lazy()` the first time a menu is wanted, so a portal's first
 * load carries none of Kobalte's menu code for a thread nobody right-clicks.
 *
 * It portals to `<body>`. No thread renders inside a `Modal` today — the
 * host's sits in its module view and the vendor's in a card — and a menu
 * portalled out of an open modal would sit under the top layer.
 */

export interface MessageInfoMenuProps {
  /** The message the menu is about; the menu is open while there is one. */
  message: MessageThreadItem | null;
  /** Where it opens, in viewport pixels. */
  at: { x: number; y: number };
  onClose: () => void;
  /** Focus back to the message, once the menu has gone. */
  onReturnFocus: () => void;
  /** When the clipboard refuses: select the words so the reader can copy them. */
  onCopyRefused: () => void;
}

export default function MessageInfoMenu(props: MessageInfoMenuProps): JSX.Element {
  /** Set when a press outside the menu closes it, so focus is left where that press put it. */
  let leftByOutside = false;

  function copy() {
    const words = props.message?.body ?? "";
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) {
      props.onCopyRefused();
      return;
    }
    clipboard.writeText(words).catch(() => props.onCopyRefused());
  }

  const who = () => {
    const message = props.message;
    if (!message) return "";
    if (message.undelivered) return "You wrote, not delivered yet";
    return message.from === "me" ? "You sent" : "They sent";
  };

  return (
    <MenuRoot
      open={props.message !== null}
      onOpenChange={(open) => {
        if (open) leftByOutside = false;
        else props.onClose();
      }}
      // Not modal: a modal menu sets `pointer-events: none` on the page, and a
      // right-click on another message would then land outside the thread.
      modal={false}
      placement="right-start"
      gutter={2}
      shift={2}
      getAnchorRect={() => ({ x: props.at.x, y: props.at.y, width: 0, height: 0 })}
    >
      <MenuPortal>
        <MenuContent
          // Named here: Kobalte names a menu by its trigger, and this one has none.
          aria-label="Message info"
          class={menuPanelClass("accent")}
          onInteractOutside={() => {
            leftByOutside = true;
          }}
          onCloseAutoFocus={(event: Event) => {
            // Kobalte would focus its trigger, and there is none.
            event.preventDefault();
            if (!leftByOutside) props.onReturnFocus();
            leftByOutside = false;
          }}
        >
          <MenuGroup>
            {/* A block, not Kobalte's default inline span: the date is a line of its
                own, and an inline label pads only its first line. */}
            <MenuGroupLabel as="div" class={menuLabelClass("accent", "identity")}>
              {who()}
              <span class="base:block base:text-ui-ink">
                {fullDateTime(props.message?.sentAt ?? Number.NaN)}
              </span>
            </MenuGroupLabel>
            <Separator class={menuSeparatorClass("accent")} />
            <MenuItem class={menuRowClass("accent")} onSelect={copy}>
              Copy text
            </MenuItem>
          </MenuGroup>
        </MenuContent>
      </MenuPortal>
    </MenuRoot>
  );
}
