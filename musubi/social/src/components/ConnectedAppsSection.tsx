import { describeAuthError } from "@osn/client";
import { clsx } from "@shared/ui/lib/utils";
import { Button, buttonVariants } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, createUniqueId, For, Show } from "solid-js";

import { PRODUCT_NAME } from "../lib/auth";
import { connectionsClient } from "../lib/authClients";
import { removalLink } from "../lib/connected-apps";
import { connectedApps } from "../lib/page-data";
import { safeAvatarUrl } from "../lib/utils";
import { AppRowsLoading } from "./AppRowsLoading";
import { EmptyNote } from "./EmptyNote";

/**
 * Settings → Connected apps. Lists the relying parties this account has
 * authorised through the OSN OIDC provider and lets the user revoke one.
 * Where an app sent its own screen for removing the person's data from it,
 * its row links there too ("Remove my data from Cire").
 *
 * This is the user-facing half of the `/oidc/connections` API and the control
 * GDPR Art. 7(3) requires — "revoking must be as easy as granting". It replaced
 * a hardcoded, non-functional Pulse/Zap list. Its lead paragraph is the
 * page's (`SettingsPage`), so its words show while this section's code loads.
 */
export function ConnectedAppsSection() {
  // Through the page cache: the tab shown again draws its last list at once
  // and reads it again behind it.
  const connections = connectedApps.use(() => []);
  /**
   * The list once a read has landed, kept on screen while it is read again
   * (so a busy Revoke stays where it was), and nothing before the first read
   * lands or after one fails. It reads `state` first: a failed read throws
   * when read, which would end the page in its error boundary.
   */
  const list = () => {
    const state = connections.state;
    return state === "ready" || state === "refreshing" ? connections() : undefined;
  };
  const [revoking, setRevoking] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function revoke(clientId: string) {
    if (revoking() === clientId) return;
    setError(null);
    setRevoking(clientId);
    try {
      // Nothing is revoked for an app the read in flight has taken off.
      const shown = await connections.settled();
      if (!shown?.some((app) => app.clientId === clientId)) return;
      await connectionsClient.revoke({ clientId });
      await connectedApps.refresh();
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

      {/* The list's place: as many apps' placeholders as it last landed, each
          at its row's height, until the first read lands; the failure; or the
          list. */}
      <div aria-busy={connections.busy || undefined}>
        <Show when={connections.state === "errored"}>
          <Notice tone="danger" size="inline" alert>
            Couldn't load your connected apps. Reload and try again.
          </Notice>
        </Show>
        <Show when={connections.busy && list() === undefined && connections.state !== "errored"}>
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
                  {(conn) => {
                    const nameId = createUniqueId();
                    return (
                      <Card
                        radius="md"
                        padding="sm"
                        class="flex flex-col gap-3"
                        data-app={conn.clientId}
                      >
                        <div class="flex items-center justify-between gap-3">
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
                              <p
                                id={nameId}
                                class="text-foreground text-title truncate font-medium"
                              >
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
                        {/* The app's own screen for removing the person's data,
                            in a tab of its own so this page stays as it is. Its
                            words cut short rather than wrap, so the row keeps
                            the height its placeholder holds (`AppRowsLoading`). */}
                        <Show when={removalLink(conn)}>
                          {(href) => (
                            <a
                              href={href()}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-describedby={nameId}
                              class={clsx(
                                buttonVariants({ variant: "secondary", size: "sm" }),
                                "max-w-full self-start max-md:h-10",
                              )}
                            >
                              <span class="truncate">Remove my data from {conn.clientName}</span>
                            </a>
                          )}
                        </Show>
                      </Card>
                    );
                  }}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}
