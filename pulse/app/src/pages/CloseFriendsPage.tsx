import type { ConnectionEntry } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { Avatar, AvatarFallback } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { Card } from "@osn/ui/ui/card";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { OSN_ISSUER_URL } from "../lib/auth";
import {
  addCloseFriend,
  listCloseFriends,
  removeCloseFriend,
  type CloseFriendEntry,
} from "../lib/closeFriends";

interface ConnectionsResponse {
  connections: ConnectionEntry[];
}

async function fetchConnections(token: string): Promise<ConnectionEntry[]> {
  const res = await fetch(`${OSN_ISSUER_URL}/graph/connections`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as ConnectionsResponse;
  return body.connections ?? [];
}

export function CloseFriendsPage() {
  const { session } = useAuth();
  const token = () => session()?.accessToken ?? null;

  const [closeFriends, { refetch: refetchCloseFriends }] = createResource<
    CloseFriendEntry[],
    string
  >(
    () => token() ?? undefined,
    async (tk) => listCloseFriends(tk),
    { initialValue: [] },
  );
  const [connections, { refetch: refetchConnections }] = createResource<ConnectionEntry[], string>(
    () => token() ?? undefined,
    async (tk) => fetchConnections(tk),
    { initialValue: [] },
  );

  const [busy, setBusy] = createSignal<string | null>(null);

  const closeFriendIds = () => new Set(closeFriends().map((c) => c.profileId));
  const eligible = () => connections().filter((c) => !closeFriendIds().has(c.id));

  async function add(connection: ConnectionEntry) {
    const tk = token();
    if (!tk) return;
    setBusy(connection.id);
    try {
      const res = await addCloseFriend(connection.id, tk);
      if (!res.ok) {
        toast.error(
          res.error === "not_a_connection"
            ? "You can only add connections as close friends"
            : "Could not add close friend",
        );
        return;
      }
      toast.success(`Added @${connection.handle} to close friends`);
      refetchCloseFriends();
      refetchConnections();
    } finally {
      setBusy(null);
    }
  }

  async function remove(entry: CloseFriendEntry) {
    const tk = token();
    if (!tk) return;
    setBusy(entry.profileId);
    try {
      const res = await removeCloseFriend(entry.profileId, tk);
      if (!res.ok) {
        toast.error("Could not remove close friend");
        return;
      }
      toast.success(
        entry.handle ? `Removed @${entry.handle} from close friends` : "Removed close friend",
      );
      refetchCloseFriends();
    } finally {
      setBusy(null);
    }
  }

  return (
    <main class="mx-auto max-w-3xl px-6 py-6">
      <h1 class="text-foreground mb-2 text-2xl font-bold">Close friends</h1>
      <p class="text-muted-foreground mb-6 text-sm">
        Pulse uses your close-friends list to surface their events higher in your feed and to make
        them quick to invite when you're hosting. This list is Pulse-only — other OSN apps don't see
        it.
      </p>

      <Show
        when={session()}
        fallback={<p class="text-muted-foreground text-sm">Sign in to manage close friends.</p>}
      >
        <Card class="mb-6 flex flex-col gap-2 p-4">
          <h2 class="text-base font-semibold">Your close friends</h2>
          <Show
            when={closeFriends().length > 0}
            fallback={
              <p class="text-muted-foreground text-sm">
                No close friends yet. Add some from your connections below.
              </p>
            }
          >
            <ul class="flex flex-col gap-1">
              <For each={closeFriends()}>
                {(entry) => (
                  <li class="hover:bg-muted/50 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors">
                    <Avatar class="h-9 w-9">
                      <AvatarFallback class="text-xs">
                        {(entry.handle ?? "?").slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div class="min-w-0 flex-1">
                      <p class="text-foreground text-sm font-medium">
                        {entry.displayName || (entry.handle ? `@${entry.handle}` : entry.profileId)}
                      </p>
                      <Show when={entry.displayName && entry.handle}>
                        <p class="text-muted-foreground text-xs">@{entry.handle}</p>
                      </Show>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="text-muted-foreground h-7 text-xs"
                      disabled={busy() === entry.profileId}
                      onClick={() => {
                        void remove(entry);
                      }}
                    >
                      Remove
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Card>

        <Card class="flex flex-col gap-2 p-4">
          <h2 class="text-base font-semibold">Add from your connections</h2>
          <Show
            when={eligible().length > 0}
            fallback={
              <p class="text-muted-foreground text-sm">
                You've added all your connections, or you don't have any yet.
              </p>
            }
          >
            <ul class="flex flex-col gap-1">
              <For each={eligible()}>
                {(connection) => (
                  <li class="hover:bg-muted/50 flex items-center gap-3 rounded-lg px-2 py-2 transition-colors">
                    <Avatar class="h-9 w-9">
                      <AvatarFallback class="text-xs">
                        {connection.handle.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div class="min-w-0 flex-1">
                      <p class="text-foreground text-sm font-medium">
                        {connection.displayName || `@${connection.handle}`}
                      </p>
                      <Show when={connection.displayName}>
                        <p class="text-muted-foreground text-xs">@{connection.handle}</p>
                      </Show>
                    </div>
                    <Button
                      size="sm"
                      class="h-7 text-xs"
                      disabled={busy() === connection.id}
                      onClick={() => {
                        void add(connection);
                      }}
                    >
                      Add
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Card>
      </Show>
    </main>
  );
}
