import type {
  ConnectionEntry,
  PendingRequestEntry,
  ProfileEntry,
  SentRequestEntry,
} from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Avatar, AvatarFallback } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@shared/ui/ui/dialog";
import { createSignal, For, Show } from "solid-js";

import { EmptyNote } from "../components/EmptyNote";
import { ResponsiveDialogContent } from "../components/ResponsiveDialogContent";
import { ResponsiveSkeleton } from "../components/ResponsiveSkeleton";
import { SectionTabs } from "../components/SectionTabs";
import { SignedOutNote } from "../components/SignedOutNote";
import { graphClient } from "../lib/api";
import { PRODUCT_NAME } from "../lib/auth";
import {
  blockedProfiles,
  connectionsList,
  pendingRequests,
  sentRequests,
  suggestions,
} from "../lib/page-data";
import { usePageTitle } from "../lib/page-title";
import { createRowActions } from "../lib/row-actions";

type Tab = "all" | "pending" | "sent" | "blocked";

const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "sent", label: "Sent" },
  { value: "blocked", label: "Blocked" },
];

/** The route's preload: the tab a visit opens on. */
export function preloadConnections(): void {
  connectionsList.preload();
}

export function ConnectionsPage() {
  const { session } = useAuth();
  usePageTitle(() => "Connections");
  const [tab, setTab] = createSignal<Tab>("all");

  // Each tab reads its own list through the page cache, and only while it is
  // shown: a tab seen before draws its last rows at once and is read again
  // behind them.
  const all = connectionsList.use(() => (tab() === "all" ? [] : undefined));
  const pending = pendingRequests.use(() => (tab() === "pending" ? [] : undefined));
  const sent = sentRequests.use(() => (tab() === "sent" ? [] : undefined));
  const blocked = blockedProfiles.use(() => (tab() === "blocked" ? [] : undefined));

  const actions = createRowActions();
  const without =
    <K extends string>(key: K, handle: string) =>
    <V extends Record<K, { handle: string }[]>>(value: V): V => ({
      ...value,
      [key]: value[key].filter((row) => row.handle !== handle),
    });

  // Two-step friend removal: clicking "Remove" on a row opens a confirmation
  // dialog rather than mutating immediately, guarding against accidental
  // removals. The pending target (full ConnectionEntry) is kept in local
  // state so the dialog can render the friend's display name / handle.
  const [removeTarget, setRemoveTarget] = createSignal<ConnectionEntry | null>(null);

  function requestRemove(conn: ConnectionEntry) {
    setRemoveTarget(conn);
  }

  function confirmRemove() {
    const target = removeTarget();
    if (!target) return;
    setRemoveTarget(null);
    const { handle } = target;
    return actions.run(
      `remove:${handle}`,
      all,
      (rows) => rows.connections.some((row) => row.handle === handle),
      async (mark) => {
        try {
          await graphClient.removeConnection(handle);
          toast.success(`Removed @${handle}`);
          connectionsList.update([], without("connections", handle), mark);
          connectionsList.invalidate();
          suggestions.invalidate();
        } catch {
          toast.error("Failed to remove connection");
        }
      },
    );
  }

  const hasPending = (handle: string) => (rows: { pending: PendingRequestEntry[] }) =>
    rows.pending.some((row) => row.handle === handle);

  function acceptRequest(handle: string) {
    return actions.run(`accept:${handle}`, pending, hasPending(handle), async (mark) => {
      try {
        await graphClient.acceptConnection(handle);
        toast.success(`Accepted @${handle}`);
        pendingRequests.update([], without("pending", handle), mark);
        pendingRequests.invalidate();
        connectionsList.invalidate();
        suggestions.invalidate();
      } catch {
        toast.error("Failed to accept request");
      }
    });
  }

  function rejectRequest(handle: string) {
    return actions.run(`decline:${handle}`, pending, hasPending(handle), async (mark) => {
      try {
        await graphClient.rejectConnection(handle);
        pendingRequests.update([], without("pending", handle), mark);
        pendingRequests.invalidate();
        suggestions.invalidate();
      } catch {
        toast.error("Failed to reject request");
      }
    });
  }

  function cancelSentRequest(handle: string) {
    return actions.run(
      `cancel:${handle}`,
      sent,
      (rows) => rows.sent.some((row) => row.handle === handle),
      async (mark) => {
        try {
          await graphClient.removeConnection(handle);
          toast.success(`Cancelled request to @${handle}`);
          sentRequests.update([], without("sent", handle), mark);
          sentRequests.invalidate();
          suggestions.invalidate();
        } catch {
          toast.error("Failed to cancel request");
        }
      },
    );
  }

  function unblock(handle: string) {
    return actions.run(
      `unblock:${handle}`,
      blocked,
      (rows) => rows.blocks.some((row) => row.handle === handle),
      async (mark) => {
        try {
          await graphClient.unblockProfile(handle);
          toast.success(`Unblocked @${handle}`);
          blockedProfiles.update([], without("blocks", handle), mark);
          suggestions.invalidate();
        } catch {
          toast.error("Failed to unblock");
        }
      },
    );
  }

  return (
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <div class="mb-6">
        <h1 class="text-foreground text-display font-medium">Connections</h1>
        <p class="text-muted-foreground text-body mt-1">
          People in your social network on {PRODUCT_NAME}.
        </p>
      </div>

      <Show
        when={session()}
        fallback={<SignedOutNote>Sign in to view your connections.</SignedOutNote>}
      >
        <SectionTabs
          label="Connection filters"
          tabs={TABS}
          current={tab()}
          onSelect={setTab}
          class="mb-6"
        />

        {/* All connections */}
        <Show when={tab() === "all"}>
          <div aria-busy={all.busy || undefined}>
            <Show when={all()} fallback={<LoadingSkeleton count={all.rows} />}>
              <Show
                when={(all()?.connections.length ?? 0) > 0}
                fallback={
                  <EmptyNote size="section">
                    No connections yet. Discover people to connect with.
                  </EmptyNote>
                }
              >
                <div class="flex flex-col gap-1">
                  <For each={all()?.connections}>
                    {(conn: ConnectionEntry) => (
                      <div class="hover:bg-muted/50 active:bg-muted/50 transition-ui-colors flex items-center gap-3 rounded-lg px-3 py-2.5">
                        <Avatar class="h-9 w-9">
                          <AvatarFallback>{conn.handle.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div class="min-w-0 flex-1">
                          <p class="text-foreground text-title truncate font-medium">
                            {conn.displayName || `@${conn.handle}`}
                          </p>
                          <Show when={conn.displayName}>
                            <p class="text-muted-foreground text-meta truncate">@{conn.handle}</p>
                          </Show>
                        </div>
                        <div class="flex items-center gap-1.5">
                          <Button
                            variant="ghostDanger"
                            size="sm"
                            class="h-7 max-md:h-10"
                            busy={actions.busy(`remove:${conn.handle}`)}
                            onClick={() => requestRemove(conn)}
                          >
                            {actions.busy(`remove:${conn.handle}`) ? "Removing…" : "Remove"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </Show>

        {/* Pending requests */}
        <Show when={tab() === "pending"}>
          <div aria-busy={pending.busy || undefined}>
            <Show when={pending()} fallback={<LoadingSkeleton count={pending.rows} />}>
              <Show
                when={(pending()?.pending.length ?? 0) > 0}
                fallback={<EmptyNote size="section">No pending connection requests.</EmptyNote>}
              >
                <div class="flex flex-col gap-1">
                  <For each={pending()?.pending}>
                    {(req: PendingRequestEntry) => (
                      <div class="hover:bg-muted/50 active:bg-muted/50 transition-ui-colors flex items-center gap-3 rounded-lg px-3 py-2.5">
                        <Avatar class="h-9 w-9">
                          <AvatarFallback>{req.handle.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div class="min-w-0 flex-1">
                          <p class="text-foreground text-title truncate font-medium">
                            {req.displayName || `@${req.handle}`}
                          </p>
                          <p class="text-muted-foreground text-meta truncate">
                            Requested {new Date(req.requestedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div class="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            class="h-7 max-md:h-10"
                            busy={actions.busy(`accept:${req.handle}`)}
                            disabled={
                              !actions.busy(`accept:${req.handle}`) &&
                              actions.busy(`decline:${req.handle}`)
                            }
                            onClick={() => acceptRequest(req.handle)}
                          >
                            {actions.busy(`accept:${req.handle}`) ? "Accepting…" : "Accept"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            class="h-7 max-md:h-10"
                            busy={actions.busy(`decline:${req.handle}`)}
                            disabled={
                              !actions.busy(`decline:${req.handle}`) &&
                              actions.busy(`accept:${req.handle}`)
                            }
                            onClick={() => rejectRequest(req.handle)}
                          >
                            {actions.busy(`decline:${req.handle}`) ? "Declining…" : "Decline"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </Show>

        {/* Sent requests */}
        <Show when={tab() === "sent"}>
          <div aria-busy={sent.busy || undefined}>
            <Show when={sent()} fallback={<LoadingSkeleton count={sent.rows} />}>
              <Show
                when={(sent()?.sent.length ?? 0) > 0}
                fallback={<EmptyNote size="section">No outgoing connection requests.</EmptyNote>}
              >
                <div class="flex flex-col gap-1">
                  <For each={sent()?.sent}>
                    {(req: SentRequestEntry) => (
                      <div class="hover:bg-muted/50 active:bg-muted/50 transition-ui-colors flex items-center gap-3 rounded-lg px-3 py-2.5">
                        <Avatar class="h-9 w-9">
                          <AvatarFallback>{req.handle.slice(0, 2).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div class="min-w-0 flex-1">
                          <p class="text-foreground text-title truncate font-medium">
                            {req.displayName || `@${req.handle}`}
                          </p>
                          <p class="text-muted-foreground text-meta truncate">
                            Requested {new Date(req.requestedAt).toLocaleDateString()}
                          </p>
                        </div>
                        <div class="flex items-center gap-1.5">
                          <Button
                            variant="ghostDanger"
                            size="sm"
                            class="h-7 max-md:h-10"
                            busy={actions.busy(`cancel:${req.handle}`)}
                            onClick={() => cancelSentRequest(req.handle)}
                          >
                            {actions.busy(`cancel:${req.handle}`) ? "Cancelling…" : "Cancel"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </Show>

        {/* Remove-friend confirmation dialog. Rendered once at the page
            level and driven by the `removeTarget` signal so a single
            instance handles removal from any row in the "All" tab. */}
        <Dialog
          open={removeTarget() !== null}
          onOpenChange={(open) => {
            if (!open) setRemoveTarget(null);
          }}
        >
          <ResponsiveDialogContent>
            <DialogHeader>
              <DialogTitle>
                Remove {removeTarget()?.displayName || `@${removeTarget()?.handle}`} as a friend?
              </DialogTitle>
            </DialogHeader>
            <div class="p-4">
              <DialogDescription>You can always add them again later.</DialogDescription>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                class="max-md:h-10"
                onClick={() => setRemoveTarget(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                class="max-md:h-10"
                onClick={() => {
                  void confirmRemove();
                }}
              >
                Remove
              </Button>
            </DialogFooter>
          </ResponsiveDialogContent>
        </Dialog>

        {/* Blocked */}
        <Show when={tab() === "blocked"}>
          <div aria-busy={blocked.busy || undefined}>
            <Show when={blocked()} fallback={<LoadingSkeleton count={blocked.rows} />}>
              <Show
                when={(blocked()?.blocks.length ?? 0) > 0}
                fallback={<EmptyNote size="section">You haven't blocked anyone.</EmptyNote>}
              >
                <div class="flex flex-col gap-1">
                  <For each={blocked()?.blocks}>
                    {(profile: ProfileEntry) => (
                      <div class="hover:bg-muted/50 active:bg-muted/50 transition-ui-colors flex items-center gap-3 rounded-lg px-3 py-2.5">
                        <Avatar class="h-9 w-9">
                          <AvatarFallback>
                            {profile.handle.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div class="min-w-0 flex-1">
                          <p class="text-foreground text-title truncate font-medium">
                            @{profile.handle}
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          size="sm"
                          class="h-7 max-md:h-10"
                          busy={actions.busy(`unblock:${profile.handle}`)}
                          onClick={() => unblock(profile.handle)}
                        >
                          {actions.busy(`unblock:${profile.handle}`) ? "Unblocking…" : "Unblock"}
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </Show>
    </main>
  );
}

/**
 * `count` rows' placeholders, spaced as the list is: as many as the tab last
 * landed, one when nothing is known. A row is 56px, and 60px below `md`, where
 * its buttons take the touch height.
 */
function LoadingSkeleton(props: { count: number }) {
  return (
    <div class="flex flex-col gap-1">
      {Array.from({ length: props.count }, () => (
        <ResponsiveSkeleton height={14} phoneHeight={15} />
      ))}
    </div>
  );
}
