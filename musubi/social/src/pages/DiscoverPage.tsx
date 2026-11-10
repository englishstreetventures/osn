import type { Suggestion } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button, buttonVariants } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { A } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";

import { EmptyNote } from "../components/EmptyNote";
import { ResponsiveSkeleton } from "../components/ResponsiveSkeleton";
import { SignedOutNote } from "../components/SignedOutNote";
import { graphClient, recommendationClient } from "../lib/api";
import { usePageTitle } from "../lib/page-title";
import { safeAvatarUrl } from "../lib/utils";

/**
 * The line under a suggested profile explaining why they're being suggested.
 * Mutual connections are the stronger signal and win the label; a shared
 * organisation is what a brand-new account has instead.
 */
function suggestionReason(suggestion: Suggestion): string {
  if (suggestion.reason === "mutual_connections") {
    return `${suggestion.mutualCount} mutual connection${suggestion.mutualCount === 1 ? "" : "s"}`;
  }
  return suggestion.sharedOrganisation
    ? `Also in ${suggestion.sharedOrganisation.name}`
    : "Suggested for you";
}

export function DiscoverPage() {
  const { session } = useAuth();
  usePageTitle(() => "Discover");

  // Keyed on the session object: a new session refetches, a token renewal does not.
  const [recommendations, { refetch }] = createResource(
    () => session() ?? false,
    () => recommendationClient.suggestConnections({ limit: 20 }),
  );

  const [sending, setSending] = createSignal<Set<string>>(new Set());

  async function connect(handle: string) {
    if (sending().has(handle)) return;
    setSending((s) => new Set(s).add(handle));
    try {
      await graphClient.sendConnectionRequest(handle);
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
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <div class="mb-6">
        <h1 class="text-foreground text-display font-medium">Discover</h1>
        <p class="text-muted-foreground text-body mt-1">
          People you may know, from mutual connections and shared organisations.
        </p>
      </div>

      <Show when={session()} fallback={<SignedOutNote>Sign in to discover people.</SignedOutNote>}>
        <div aria-busy={recommendations.loading || undefined}>
          <Show
            when={!recommendations.loading}
            fallback={
              <div class="grid gap-3 md:grid-cols-2">
                {Array.from({ length: 4 }, () => (
                  // A card is 114px, and 126px below `md`, where Connect
                  // takes the touch height.
                  <ResponsiveSkeleton standsFor="card" height={28.5} phoneHeight={31.5} />
                ))}
              </div>
            }
          >
            <Show
              when={(recommendations()?.suggestions.length ?? 0) > 0}
              fallback={
                <EmptyNote>
                  No suggestions yet.{" "}
                  <A href="/search" class={buttonVariants({ variant: "link", size: "inline" })}>
                    Search for someone
                  </A>
                  , or join an organisation to find people you already share one with.
                </EmptyNote>
              }
            >
              <div class="grid gap-3 md:grid-cols-2">
                <For each={recommendations()?.suggestions}>
                  {(suggestion) => (
                    // A card, not a row: the tile itself is not a control (its
                    // Connect button is), so it takes no hover wash.
                    <Card padding="sm" class="flex flex-col gap-3">
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
                          <AvatarFallback>
                            {suggestion.handle.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div class="min-w-0 flex-1">
                          <p class="text-foreground text-title truncate font-medium">
                            {suggestion.displayName || `@${suggestion.handle}`}
                          </p>
                          <Show when={suggestion.displayName}>
                            <p class="text-muted-foreground text-meta truncate">
                              @{suggestion.handle}
                            </p>
                          </Show>
                        </div>
                      </div>
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-muted-foreground text-meta min-w-0 truncate">
                          {suggestionReason(suggestion)}
                        </span>
                        <Button
                          size="sm"
                          class="h-7 max-md:h-10"
                          busy={sending().has(suggestion.handle)}
                          onClick={() => connect(suggestion.handle)}
                        >
                          {sending().has(suggestion.handle) ? "Sending…" : "Connect"}
                        </Button>
                      </div>
                    </Card>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </main>
  );
}
