import { describeAuthError } from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { createResource, createSignal, For, Show } from "solid-js";

import { PRODUCT_NAME } from "../lib/auth";
import { connectionsClient } from "../lib/authClients";
import { safeAvatarUrl } from "../lib/utils";
import { AppRowsLoading } from "./AppRowsLoading";
import { EmptyNote } from "./EmptyNote";

/**
 * Settings → Connected apps. Lists the relying parties this account has
 * authorised through the OSN OIDC provider and lets the user revoke one.
 *
 * This is the user-facing half of the `/oidc/connections` API and the control
 * GDPR Art. 7(3) requires — "revoking must be as easy as granting". It replaced
 * a hardcoded, non-functional Pulse/Zap list. Its lead paragraph is the
 * page's (`SettingsPage`), so its words show while this section's code loads.
 */
export function ConnectedAppsSection() {
  const [connections, { refetch }] = createResource(() =>
    connectionsClient.list().then((r) => r.connections),
  );
  /**
   * The list once a read has landed, kept on screen while it is read again
   * after a revoke (so the busy Revoke stays where it was), and nothing before
   * the first read lands or after one fails. It reads `state` first: a failed
   * resource throws when read, which would end the page in its error boundary.
   */
  const list = () => {
    const state = connections.state;
    return state === "ready" || state === "refreshing" ? connections.latest : undefined;
  };
  const [revoking, setRevoking] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function revoke(clientId: string) {
    if (revoking() === clientId) return;
    setError(null);
    setRevoking(clientId);
    try {
      await connectionsClient.revoke({ clientId });
      await refetch();
    } catch (e) {
      setError(`Couldn't revoke this app. ${describeAuthError(e)}`);
    } finally {
      setRevoking(null);
    }
  }

  const scopesOf = (scope: string) => scope.split(/\s+/).filter((s) => s.length > 0);

  return (
    <div class="flex flex-col gap-4">
      <Show when={error()}>
        <Notice tone="danger" size="inline" alert>
          {error()}
        </Notice>
      </Show>

      {/* The list's place: one app's placeholder until the first read lands,
          the failure, or the list. */}
      <div aria-busy={connections.loading || undefined}>
        <Show when={!connections.loading && connections.error}>
          <Notice tone="danger" size="inline" alert>
            Couldn't load your connected apps. Reload and try again.
          </Notice>
        </Show>
        <Show when={connections.loading && list() === undefined}>
          <AppRowsLoading />
        </Show>
        <Show when={list()}>
          {(apps) => (
            <Show
              when={apps().length > 0}
              fallback={
                <EmptyNote size="section">
                  You haven't connected any apps to your {PRODUCT_NAME} account yet.
                </EmptyNote>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={apps()}>
                  {(conn) => (
                    <div class="border-border rounded-card flex items-center justify-between gap-3 border px-4 py-3">
                      <div class="flex min-w-0 items-center gap-3">
                        <Show when={safeAvatarUrl(conn.logoUrl)}>
                          {(url) => (
                            <img
                              src={url()}
                              alt=""
                              class="border-border h-8 w-8 shrink-0 rounded-lg border object-cover"
                              referrerpolicy="no-referrer"
                            />
                          )}
                        </Show>
                        <div class="min-w-0">
                          <p class="text-foreground text-title truncate font-medium">
                            {conn.clientName ?? "Unknown app"}
                          </p>
                          <p class="text-muted-foreground text-meta truncate">
                            Access: {scopesOf(conn.scope).join(", ") || "—"}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        class="h-7 shrink-0 max-md:h-10"
                        busy={revoking() === conn.clientId}
                        onClick={() => void revoke(conn.clientId)}
                      >
                        {revoking() === conn.clientId ? "Revoking…" : "Revoke"}
                      </Button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}
