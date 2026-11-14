import { describeAuthError, type SessionsClient, type SessionSummary } from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { createResource, createSignal, For, Show } from "solid-js";

import { LoadFailed } from "./LoadFailed";
import { RowPlaceholder } from "./RowPlaceholder";
import { SettingsRow } from "./SettingsRow";

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
}

function formatTs(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toLocaleString();
}

export function SessionsView(props: SessionsViewProps) {
  const [reloadKey, setReloadKey] = createSignal(0);
  const [sessions] = createResource(reloadKey, async () => {
    const res = await props.client.list();
    return res.sessions;
  });
  /**
   * The list once a read has landed, kept on screen while it is read again,
   * and nothing before the first read lands or after one fails. It reads
   * `state` first and never calls `sessions()`: a failed resource throws when
   * read, and a loading one joins the host's Suspense boundary.
   */
  const list = () => {
    const state = sessions.state;
    return state === "ready" || state === "refreshing" ? sessions.latest : undefined;
  };
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // And while a landed list is read again: a session just revoked is still on
  // screen until the read lands. Not on the first read, when there is no row.
  const locked = () => busy() || sessions.state === "refreshing";

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      await props.client.revoke({ id });
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(describeAuthError(e));
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
      await props.client.revokeAllOther();
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(describeAuthError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="flex flex-col gap-3">
      {/* The action goes under the heading when the two do not fit on one line. */}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-ui-ink text-ui-md font-ui-title">Active sessions</h2>
        <Button variant="outline" class="max-md:h-10" onClick={revokeAllOther} disabled={locked()}>
          Sign out everywhere else
        </Button>
      </div>
      <Show when={error()}>
        {(msg) => (
          <Notice tone="danger" size="inline" alert>
            {msg()}
          </Notice>
        )}
      </Show>
      {/* The list's place: one row's placeholder until the first read lands
          (this session is always on it), the failure, or the list. */}
      <div aria-busy={sessions.loading || undefined}>
        <Show when={sessions.loading && list() === undefined}>
          <RowPlaceholder />
        </Show>
        <Show when={!sessions.loading && sessions.error}>
          {(err) => (
            <LoadFailed
              lead="Your sessions didn't load."
              error={err()}
              onRetry={() => setReloadKey((k) => k + 1)}
            />
          )}
        </Show>
        <Show when={list()}>
          {(rows) => (
            <ul class="flex flex-col gap-2">
              <For each={rows()}>
                {(s: SessionSummary) => (
                  <li>
                    <SettingsRow
                      name={
                        <>
                          {s.uaLabel ?? "Unknown device"}
                          <Show when={s.isCurrent}>
                            <span class="text-ui-accent-ink text-ui-xs ml-2 font-normal">
                              (this device)
                            </span>
                          </Show>
                        </>
                      }
                      meta={[
                        `Created ${formatTs(s.createdAt)}`,
                        `Last used ${formatTs(s.lastUsedAt)}`,
                      ]}
                      actions={
                        // Named by its device, so it is never one more "Sign
                        // out" beside the app's own.
                        <Button
                          variant="outline"
                          size="sm"
                          class="max-md:h-10"
                          onClick={() => revoke(s.id)}
                          disabled={locked() || s.isCurrent}
                          aria-label={`Sign out ${s.uaLabel ?? "Unknown device"}`}
                        >
                          Sign out
                        </Button>
                      }
                    />
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </div>
    </div>
  );
}
