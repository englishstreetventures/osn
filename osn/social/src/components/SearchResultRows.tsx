import type {
  OrganisationSearchResult,
  ProfileSearchResult,
  SearchConnectionState,
} from "@osn/client";
import { clsx } from "@osn/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { A } from "@solidjs/router";
import { createSignal, Show } from "solid-js";
import { toast } from "solid-toast";

import { graphClient } from "../lib/api";
import type { SearchController } from "../lib/search";
import { safeAvatarUrl } from "../lib/utils";

/**
 * Connect / accept actions shared by every search surface. Kept here rather
 * than in each surface so the rail dropdown and the `/search` page can never
 * drift on what a row does.
 */
export function useSearchActions(token: () => string, controller: SearchController) {
  const [pending, setPending] = createSignal<Set<string>>(new Set());

  function withPending(handle: string, run: () => Promise<void>) {
    setPending((prev) => new Set(prev).add(handle));
    void run().finally(() =>
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(handle);
        return next;
      }),
    );
  }

  function connect(handle: string) {
    withPending(handle, async () => {
      try {
        await graphClient.sendConnectionRequest(token(), handle);
        controller.setConnectionStatus(handle, "pending_sent");
        toast.success(`Request sent to @${handle}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to send request");
      }
    });
  }

  function accept(handle: string) {
    withPending(handle, async () => {
      try {
        await graphClient.acceptConnection(token(), handle);
        controller.setConnectionStatus(handle, "connected");
        toast.success(`You and @${handle} are connected`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to accept request");
      }
    });
  }

  /** What Enter on an active row does: connect, or accept if they asked first. */
  function activate(person: ProfileSearchResult) {
    const status = controller.connectionStatus(person.handle, person.connectionStatus);
    if (status === "none") connect(person.handle);
    else if (status === "pending_received") accept(person.handle);
  }

  return { pending, connect, accept, activate };
}

export type SearchActions = ReturnType<typeof useSearchActions>;

function ResultAvatar(props: { url: string | null; label: string; size: string }) {
  return (
    <Avatar class={props.size}>
      <Show when={safeAvatarUrl(props.url)}>
        {(url) => (
          <AvatarImage src={url()} alt={props.label} referrerpolicy="no-referrer" loading="lazy" />
        )}
      </Show>
      <AvatarFallback class="text-meta">{props.label.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

/** The label for a person row's affordance, given the caller's state with them. */
function actionLabel(status: SearchConnectionState, busy: boolean): string {
  if (busy) return "…";
  switch (status) {
    case "connected":
      return "Connected";
    case "pending_sent":
      return "Requested";
    case "pending_received":
      return "Accept";
    default:
      return "Connect";
  }
}

/**
 * The right-hand affordance for a person row.
 *
 * `interactive: false` renders it as plain text rather than a `<Button>`. That
 * is not cosmetic — inside the rail's ARIA listbox the row *is* the activation
 * target, and a listbox option may not contain operable descendants (assistive
 * tech flattens an option to its accessible name, so a nested button is
 * announced as text and can't be triggered). The `/search` page is a plain
 * list, so it keeps real buttons.
 */
export function PersonAction(props: {
  status: SearchConnectionState;
  busy: boolean;
  interactive?: boolean;
  onConnect: () => void;
  onAccept: () => void;
}) {
  const actionable = () => props.status === "none" || props.status === "pending_received";
  const label = () => actionLabel(props.status, props.busy);

  return (
    <Show
      when={props.interactive !== false && actionable()}
      fallback={
        <span
          class={clsx(
            "text-meta shrink-0",
            actionable() ? "text-foreground font-medium" : "text-subtle",
          )}
        >
          {label()}
        </span>
      }
    >
      <Button
        size="sm"
        class="text-body rounded-pill h-7 shrink-0 max-md:h-9"
        disabled={props.busy}
        onClick={() => (props.status === "none" ? props.onConnect() : props.onAccept())}
      >
        {label()}
      </Button>
    </Show>
  );
}

export function PersonRow(props: {
  person: ProfileSearchResult;
  controller: SearchController;
  actions: SearchActions;
  /** See `PersonAction` — `false` inside an ARIA listbox option. */
  interactive?: boolean;
}) {
  const status = () =>
    props.controller.connectionStatus(props.person.handle, props.person.connectionStatus);

  return (
    <>
      <ResultAvatar url={props.person.avatarUrl} label={props.person.handle} size="h-8 w-8" />
      <div class="min-w-0 flex-1">
        <p class="text-foreground text-body truncate font-medium">
          {props.person.displayName || `@${props.person.handle}`}
        </p>
        <Show when={props.person.displayName}>
          <p class="text-subtle text-meta truncate">@{props.person.handle}</p>
        </Show>
      </div>
      <PersonAction
        status={status()}
        busy={props.actions.pending().has(props.person.handle)}
        interactive={props.interactive}
        onConnect={() => props.actions.connect(props.person.handle)}
        onAccept={() => props.actions.accept(props.person.handle)}
      />
    </>
  );
}

export function OrganisationRow(props: { organisation: OrganisationSearchResult }) {
  return (
    <>
      <ResultAvatar
        url={props.organisation.avatarUrl}
        label={props.organisation.handle}
        size="h-8 w-8 rounded-md"
      />
      <div class="min-w-0 flex-1">
        <p class="text-foreground text-body truncate font-medium">{props.organisation.name}</p>
        <p class="text-subtle text-meta truncate">@{props.organisation.handle}</p>
      </div>
      <Show when={props.organisation.isMember}>
        <span class="text-subtle text-meta shrink-0">Member</span>
      </Show>
    </>
  );
}

/**
 * Wraps an organisation row in the link to its detail page. Used by the
 * `/search` page; the rail dropdown can't use it, because a listbox option may
 * not contain a link (see `PersonAction`) and activates the row instead.
 */
export function OrganisationLink(props: {
  organisation: OrganisationSearchResult;
  class?: string;
}) {
  return (
    <A href={`/organisations/${props.organisation.handle}`} class={props.class}>
      <OrganisationRow organisation={props.organisation} />
    </A>
  );
}
