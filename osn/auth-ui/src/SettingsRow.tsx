import { Card } from "@shared/ui/ui/card";
import { type JSX, Show } from "solid-js";

/**
 * One row of a Settings panel's list: a passkey, the authenticator app, a
 * session. A `Card` nested in the host's card (8px corners, 16px inside)
 * holding the name, two meta lines and the row's actions. From `md` the
 * actions sit at the row's end beside the words; below `md` they sit under
 * them, 12px down, so the words take the card's whole width on a phone. Each
 * meta line is one line, so a row whose name fits on one is one height at
 * each width, and `RowPlaceholder` holds that height. Internal to this package.
 */
export function SettingsRow(props: {
  /** The name, in the row's name type. May hold a note such as "(synced)". */
  name: JSX.Element;
  /** True while the name is being changed: `editor` takes its place and the actions go. */
  editing?: boolean;
  /** What replaces the name while `editing` (a rename field and its buttons). */
  editor?: JSX.Element;
  /** The two meta lines: when it was added, then when it was last used. */
  meta: readonly [string, string];
  /**
   * The row's buttons: `outline`, `sm`, 40px tall below `md` (`max-md:h-10`),
   * each named for the row ("Remove Work laptop").
   */
  actions: JSX.Element;
}) {
  return (
    <Card
      radius="md"
      padding="sm"
      class="flex items-center justify-between gap-3 max-md:flex-col max-md:items-stretch"
    >
      {/* The words give way, so a long name wraps and the row's actions stay
          inside the card on a phone. */}
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <Show
          when={props.editing}
          fallback={
            <span class="text-ui-ink text-ui-base font-medium wrap-break-word">{props.name}</span>
          }
        >
          {props.editor}
        </Show>
        <span class="text-ui-xs text-ui-ink-secondary">{props.meta[0]}</span>
        <span class="text-ui-xs text-ui-ink-secondary">{props.meta[1]}</span>
      </div>
      <Show when={!props.editing}>
        <div class="flex shrink-0 gap-2 max-md:self-start">{props.actions}</div>
      </Show>
    </Card>
  );
}
