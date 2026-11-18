import { Notice } from "@shared/ui/ui/notice";
import { Show } from "solid-js";

import { canRetryLoad, loadFailureDetail } from "./error-lines";
import { InlineAction } from "./InlineAction";

/**
 * The line a settings view draws in place of a list or status that failed to
 * load: its own lead ("Your passkeys didn't load."), the map's sentence only
 * when it adds something, and a Try again that reloads — left out once the
 * session has ended, since no retry can work then. Internal to this package.
 */
export function LoadFailed(props: { lead: string; error: unknown; onRetry: () => void }) {
  return (
    <Notice tone="danger" size="inline" alert>
      {[props.lead, loadFailureDetail(props.error)].filter(Boolean).join(" ")}{" "}
      <Show when={canRetryLoad(props.error)}>
        <InlineAction onClick={props.onRetry}>Try again</InlineAction>
      </Show>
    </Notice>
  );
}
