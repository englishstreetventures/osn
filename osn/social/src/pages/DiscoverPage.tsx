import { useAuth } from "@osn/client/solid";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { graphClient, recommendationClient } from "../lib/api";
import { safeAvatarUrl } from "../lib/utils";

export function DiscoverPage() {
  const { session } = useAuth();
  const token = () => session()?.accessToken ?? "";

  const [recommendations, { refetch }] = createResource(
    () => token() || false,
    (t) => recommendationClient.suggestConnections(t as string, { limit: 20 }),
  );

  const [sending, setSending] = createSignal<Set<string>>(new Set());

  async function connect(handle: string) {
    setSending((s) => new Set(s).add(handle));
    try {
      await graphClient.sendConnectionRequest(token(), handle);
      toast.success(`Request sent to @${handle}`);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send request");
    } finally {
      setSending((s) => {
        const next = new Set(s);
        next.delete(handle);
        return next;
      });
    }
  }

  return (
    <main class="mx-auto w-full max-w-2xl px-8 py-8">
      <div class="mb-6">
        <h1 class="text-foreground text-xl font-semibold tracking-tight">Discover</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          People you may know based on mutual connections.
        </p>
      </div>

      <Show
        when={session()}
        fallback={
          <div class="text-muted-foreground border-border rounded-lg border border-dashed py-16 text-center text-sm">
            Sign in to discover people.
          </div>
        }
      >
        <Show
          when={!recommendations.loading}
          fallback={
            <div class="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }, () => (
                <div class="bg-muted/50 h-28 animate-pulse rounded-lg" />
              ))}
            </div>
          }
        >
          <Show
            when={(recommendations()?.suggestions.length ?? 0) > 0}
            fallback={
              <div class="text-muted-foreground border-border rounded-lg border border-dashed py-16 text-center text-sm">
                No suggestions yet. Connect with more people to get recommendations.
              </div>
            }
          >
            <div class="grid gap-3 sm:grid-cols-2">
              <For each={recommendations()?.suggestions}>
                {(suggestion) => (
                  <div class="border-border hover:bg-muted/30 flex flex-col gap-3 rounded-lg border p-4 transition-colors">
                    <div class="flex items-center gap-3">
                      <Avatar class="h-10 w-10">
                        <Show when={safeAvatarUrl(suggestion.avatarUrl)}>
                          {(url) => (
                            <AvatarImage
                              src={url()}
                              alt={suggestion.handle}
                              referrerpolicy="no-referrer"
                              loading="lazy"
                            />
                          )}
                        </Show>
                        <AvatarFallback class="text-xs">
                          {suggestion.handle.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div class="min-w-0 flex-1">
                        <p class="text-foreground truncate text-sm font-medium">
                          {suggestion.displayName || `@${suggestion.handle}`}
                        </p>
                        <Show when={suggestion.displayName}>
                          <p class="text-muted-foreground truncate text-xs">@{suggestion.handle}</p>
                        </Show>
                      </div>
                    </div>
                    <div class="flex items-center justify-between">
                      <span class="text-muted-foreground text-xs">
                        {suggestion.mutualCount} mutual{suggestion.mutualCount !== 1 ? "s" : ""}
                      </span>
                      <Button
                        size="sm"
                        class="h-7 text-xs"
                        disabled={sending().has(suggestion.handle)}
                        onClick={() => connect(suggestion.handle)}
                      >
                        {sending().has(suggestion.handle) ? "Sending..." : "Connect"}
                      </Button>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
    </main>
  );
}
