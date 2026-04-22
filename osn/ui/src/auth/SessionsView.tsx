import type { SessionsClient, SessionSummary } from "@osn/client";
import { createResource, createSignal, For, Show } from "solid-js";

import { Button } from "../components/ui/button";

/**
 * Settings-panel surface for listing and revoking the caller's active
 * sessions.
 *
 * Design notes
 * ------------
 * - Never displays IP hashes or full session hashes. The revocation
 *   handle shown to users is the coarse UA label (e.g. "Firefox on
 *   macOS") plus created/last-used timestamps; the real `id` (16 hex
 *   chars) is carried in the DELETE URL only.
 * - "This device" is always at the top and cannot be revoked from this
 *   view — users would lock themselves out mid-settings. The logout
 *   button is the proper way to terminate the current session.
 * - "Sign out everywhere else" revokes all OTHER sessions in one call
 *   after a confirmation prompt. This is the Copenhagen Book H1 remediation
 *   surface, exposed so users can react to a phone loss without having
 *   to enumerate devices manually.
 */

export interface SessionsViewProps {
  client: SessionsClient;
  accessToken: string;
}

function formatTs(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toLocaleString();
}

export function SessionsView(props: SessionsViewProps) {
  const [reloadKey, setReloadKey] = createSignal(0);
  const [sessions] = createResource(reloadKey, async () => {
    const res = await props.client.list({ accessToken: props.accessToken });
    return res.sessions;
  });
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      await props.client.revoke({ accessToken: props.accessToken, id });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke session");
    } finally {
      setBusy(false);
    }
  }

  async function revokeAllOther() {
    // Intentional synchronous confirm — this is a destructive action and
    // a toast-style undo would leave the stolen-session window open.
    if (!window.confirm("Sign out of every other device?")) return;
    setBusy(true);
    setError(null);
    try {
      await props.client.revokeAllOther({ accessToken: props.accessToken });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke other sessions");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Active sessions</h2>
        <Button variant="outline" onClick={revokeAllOther} disabled={busy()}>
          Sign out everywhere else
        </Button>
      </div>
      <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>
      <Show when={sessions.loading}>
        <p class="text-muted-foreground text-sm">Loading…</p>
      </Show>
      <Show when={sessions()}>
        {(list) => (
          <ul class="flex flex-col gap-2">
            <For each={list()}>
              {(s: SessionSummary) => (
                <li class="flex items-center justify-between rounded-md border p-3">
                  <div class="flex flex-col gap-0.5">
                    <span class="font-medium">
                      {s.uaLabel ?? "Unknown device"}
                      <Show when={s.isCurrent}>
                        <span class="text-primary ml-2 text-xs">(this device)</span>
                      </Show>
                    </span>
                    <span class="text-muted-foreground text-xs">
                      Created {formatTs(s.createdAt)} · Last used {formatTs(s.lastUsedAt)}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => revoke(s.id)}
                    disabled={busy() || s.isCurrent}
                  >
                    Revoke
                  </Button>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
    </div>
  );
}
