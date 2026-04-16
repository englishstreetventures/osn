import type { ConnectionEntry, PendingRequestEntry, ProfileEntry } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { clsx } from "@osn/ui/lib/utils";
import { Avatar, AvatarFallback } from "@osn/ui/ui/avatar";
import { Badge } from "@osn/ui/ui/badge";
import { Button } from "@osn/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@osn/ui/ui/dialog";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { graphClient } from "../lib/api";

type Tab = "all" | "pending" | "close-friends" | "blocked";

const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "close-friends", label: "Close friends" },
  { value: "blocked", label: "Blocked" },
];

export function ConnectionsPage() {
  const { session } = useAuth();
  const token = () => session()?.accessToken ?? "";
  const [tab, setTab] = createSignal<Tab>("all");

  // Single keyed resource for all four tabs (P-W5). Rapid tab-switching
  // produces a single in-flight request at a time thanks to Solid's
  // source-change cancellation semantics, rather than firing one request
  // per tab entered.
  type TabPayload =
    | { kind: "all"; data: Awaited<ReturnType<typeof graphClient.listConnections>> }
    | { kind: "pending"; data: Awaited<ReturnType<typeof graphClient.listPendingRequests>> }
    | { kind: "close-friends"; data: Awaited<ReturnType<typeof graphClient.listCloseFriends>> }
    | { kind: "blocked"; data: Awaited<ReturnType<typeof graphClient.listBlocks>> };

  const [payload, { refetch: refetchPayload }] = createResource<
    TabPayload | undefined,
    { tab: Tab; token: string }
  >(
    () => (token() ? { tab: tab(), token: token() } : undefined),
    async ({ tab: t, token: tk }): Promise<TabPayload> => {
      switch (t) {
        case "all":
          return { kind: "all", data: await graphClient.listConnections(tk) };
        case "pending":
          return { kind: "pending", data: await graphClient.listPendingRequests(tk) };
        case "close-friends":
          return { kind: "close-friends", data: await graphClient.listCloseFriends(tk) };
        case "blocked":
          return { kind: "blocked", data: await graphClient.listBlocks(tk) };
      }
    },
  );

  // Narrowed accessors — each returns the tab's payload when active, else null.
  const connections = () =>
    payload()?.kind === "all"
      ? (payload() as Extract<TabPayload, { kind: "all" }>).data
      : undefined;
  const pending = () =>
    payload()?.kind === "pending"
      ? (payload() as Extract<TabPayload, { kind: "pending" }>).data
      : undefined;
  const closeFriends = () =>
    payload()?.kind === "close-friends"
      ? (payload() as Extract<TabPayload, { kind: "close-friends" }>).data
      : undefined;
  const blocked = () =>
    payload()?.kind === "blocked"
      ? (payload() as Extract<TabPayload, { kind: "blocked" }>).data
      : undefined;

  const refetchConnections = refetchPayload;
  const refetchPending = refetchPayload;
  const refetchCloseFriends = refetchPayload;

  // Two-step friend removal: clicking "Remove" on a row opens a confirmation
  // dialog rather than mutating immediately, guarding against accidental
  // removals. The pending target (full ConnectionEntry) is kept in local
  // state so the dialog can render the friend's display name / handle.
  const [removeTarget, setRemoveTarget] = createSignal<ConnectionEntry | null>(null);

  function requestRemove(conn: ConnectionEntry) {
    setRemoveTarget(conn);
  }

  async function confirmRemove() {
    const target = removeTarget();
    if (!target) return;
    setRemoveTarget(null);
    try {
      await graphClient.removeConnection(token(), target.handle);
      toast.success(`Removed @${target.handle}`);
      refetchConnections();
    } catch {
      toast.error("Failed to remove connection");
    }
  }

  async function acceptRequest(handle: string) {
    try {
      await graphClient.acceptConnection(token(), handle);
      toast.success(`Accepted @${handle}`);
      refetchPending();
      refetchConnections();
    } catch {
      toast.error("Failed to accept request");
    }
  }

  async function rejectRequest(handle: string) {
    try {
      await graphClient.rejectConnection(token(), handle);
      refetchPending();
    } catch {
      toast.error("Failed to reject request");
    }
  }

  async function toggleCloseFriend(handle: string, isClose: boolean) {
    try {
      if (isClose) {
        await graphClient.removeCloseFriend(token(), handle);
        toast.success(`Removed @${handle} from close friends`);
      } else {
        await graphClient.addCloseFriend(token(), handle);
        toast.success(`Added @${handle} to close friends`);
      }
      refetchCloseFriends();
    } catch {
      toast.error("Failed to update close friend");
    }
  }

  async function unblock(handle: string) {
    try {
      await graphClient.unblockProfile(token(), handle);
      toast.success(`Unblocked @${handle}`);
    } catch {
      toast.error("Failed to unblock");
    }
  }

  return (
    <main class="mx-auto w-full max-w-2xl px-8 py-8">
      <div class="mb-6">
        <h1 class="text-foreground text-xl font-semibold tracking-tight">Connections</h1>
        <p class="text-muted-foreground mt-1 text-sm">People in your social network on OSN.</p>
      </div>

      <Show
        when={session()}
        fallback={
          <div class="text-muted-foreground border-border rounded-lg border border-dashed py-16 text-center text-sm">
            Sign in to view your connections.
          </div>
        }
      >
        {/* Tab bar */}
        <div class="border-border mb-6 flex gap-1 border-b">
          <For each={TABS}>
            {(t) => (
              <button
                type="button"
                class={clsx(
                  "border-b-2 px-3 pb-2.5 text-[13px] font-medium transition-colors",
                  tab() === t.value
                    ? "border-foreground text-foreground"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
                onClick={() => setTab(t.value)}
              >
                {t.label}
              </button>
            )}
          </For>
        </div>

        {/* All connections */}
        <Show when={tab() === "all"}>
          <Show when={!payload.loading} fallback={<LoadingSkeleton count={3} />}>
            <Show
              when={(connections()?.connections?.length ?? 0) > 0}
              fallback={
                <EmptyState message="No connections yet. Discover people to connect with." />
              }
            >
              <div class="flex flex-col gap-1">
                <For each={connections()?.connections}>
                  {(conn: ConnectionEntry) => (
                    <div class="hover:bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors">
                      <Avatar class="h-9 w-9">
                        <AvatarFallback class="text-xs">
                          {conn.handle.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div class="min-w-0 flex-1">
                        <p class="text-foreground text-sm font-medium">
                          {conn.displayName || `@${conn.handle}`}
                        </p>
                        <Show when={conn.displayName}>
                          <p class="text-muted-foreground text-xs">@{conn.handle}</p>
                        </Show>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-muted-foreground h-7 text-xs"
                          onClick={() => toggleCloseFriend(conn.handle, false)}
                        >
                          Close friend
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-destructive h-7 text-xs"
                          onClick={() => requestRemove(conn)}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>

        {/* Pending requests */}
        <Show when={tab() === "pending"}>
          <Show when={!payload.loading} fallback={<LoadingSkeleton count={2} />}>
            <Show
              when={(pending()?.pending.length ?? 0) > 0}
              fallback={<EmptyState message="No pending connection requests." />}
            >
              <div class="flex flex-col gap-1">
                <For each={pending()?.pending}>
                  {(req: PendingRequestEntry) => (
                    <div class="hover:bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors">
                      <Avatar class="h-9 w-9">
                        <AvatarFallback class="text-xs">
                          {req.handle.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div class="min-w-0 flex-1">
                        <p class="text-foreground text-sm font-medium">
                          {req.displayName || `@${req.handle}`}
                        </p>
                        <p class="text-muted-foreground text-xs">
                          Requested {new Date(req.requestedAt).toLocaleDateString()}
                        </p>
                      </div>
                      <div class="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          class="h-7 text-xs"
                          onClick={() => acceptRequest(req.handle)}
                        >
                          Accept
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-muted-foreground h-7 text-xs"
                          onClick={() => rejectRequest(req.handle)}
                        >
                          Decline
                        </Button>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>

        {/* Close friends */}
        <Show when={tab() === "close-friends"}>
          <Show when={!payload.loading} fallback={<LoadingSkeleton count={2} />}>
            <Show
              when={(closeFriends()?.closeFriends.length ?? 0) > 0}
              fallback={
                <EmptyState message="No close friends yet. Add connections as close friends to see them here." />
              }
            >
              <div class="flex flex-col gap-1">
                <For each={closeFriends()?.closeFriends}>
                  {(friend: ProfileEntry) => (
                    <div class="hover:bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors">
                      <Avatar class="h-9 w-9">
                        <AvatarFallback class="text-xs">
                          {friend.handle.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div class="min-w-0 flex-1">
                        <p class="text-foreground text-sm font-medium">
                          {friend.displayName || `@${friend.handle}`}
                        </p>
                        <Show when={friend.displayName}>
                          <p class="text-muted-foreground text-xs">@{friend.handle}</p>
                        </Show>
                      </div>
                      <Badge variant="secondary" class="text-[11px]">
                        Close friend
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="text-muted-foreground h-7 text-xs"
                        onClick={() => toggleCloseFriend(friend.handle, true)}
                      >
                        Remove
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
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
          <DialogContent class="max-w-sm">
            <DialogHeader>
              <DialogTitle>
                Remove {removeTarget()?.displayName || `@${removeTarget()?.handle}`} as a friend?
              </DialogTitle>
            </DialogHeader>
            <div class="flex flex-col gap-4 p-4">
              <DialogDescription>You can always add them again later.</DialogDescription>
              <DialogFooter class="border-0 p-0">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setRemoveTarget(null)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    void confirmRemove();
                  }}
                >
                  Remove
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>

        {/* Blocked */}
        <Show when={tab() === "blocked"}>
          <Show when={!payload.loading} fallback={<LoadingSkeleton count={1} />}>
            <Show
              when={(blocked()?.blocks.length ?? 0) > 0}
              fallback={<EmptyState message="You haven't blocked anyone." />}
            >
              <div class="flex flex-col gap-1">
                <For each={blocked()?.blocks}>
                  {(profile: ProfileEntry) => (
                    <div class="hover:bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors">
                      <Avatar class="h-9 w-9">
                        <AvatarFallback class="text-xs">
                          {profile.handle.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div class="min-w-0 flex-1">
                        <p class="text-foreground text-sm font-medium">@{profile.handle}</p>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        class="h-7 text-xs"
                        onClick={() => unblock(profile.handle)}
                      >
                        Unblock
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </main>
  );
}

function EmptyState(props: { message: string }) {
  return (
    <div class="text-muted-foreground border-border rounded-lg border border-dashed py-12 text-center text-sm">
      {props.message}
    </div>
  );
}

function LoadingSkeleton(props: { count: number }) {
  return (
    <div class="flex flex-col gap-2">
      {Array.from({ length: props.count }, () => (
        <div class="bg-muted/50 h-14 animate-pulse rounded-lg" />
      ))}
    </div>
  );
}
