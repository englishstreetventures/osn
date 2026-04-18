import type { SessionSummary, SessionsClient } from "@osn/client";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

/**
 * "Your active sessions" surface. Lists every non-expired session for the
 * caller's account, flags the current device, and lets the user revoke an
 * individual session or nuke every other device at once.
 *
 * Design notes
 * ------------
 * - The component is stateless beyond the refresh signal — data comes from
 *   `createResource` re-fetches, not local copies. A revoke mutates the
 *   server and then re-fetches; no manual splicing.
 * - Revoking the current device is allowed (matches "sign me out of here
 *   from somewhere else"). The onLoggedOut callback is invoked so the
 *   host app can redirect to the sign-in page — we don't assume a router.
 * - The user-agent string is shown raw rather than parsed — the UI can
 *   always parse later if that turns out to be noisier than useful.
 */

export interface SessionListProps {
  client: SessionsClient;
  /** The caller's current access token. Bearer-authenticated endpoints. */
  accessToken: string;
  /**
   * Fired after the user revokes their own current session. The host app
   * should clear its cached session and redirect to sign-in.
   */
  onLoggedOut?: () => void;
}

function formatRelative(unixSeconds: number): string {
  const deltaMs = Date.now() - unixSeconds * 1000;
  if (deltaMs < 0) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

export function SessionList(props: SessionListProps) {
  const [sessions, { refetch }] = createResource(async (): Promise<SessionSummary[]> => {
    const result = await props.client.listSessions({ accessToken: props.accessToken });
    // Current device first, then most-recently-seen. `sort` mutates but the
    // array is an internal copy returned by the API client, never shared.
    const copy = [...result.sessions];
    copy.sort((a: SessionSummary, b: SessionSummary) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return b.lastSeenAt - a.lastSeenAt;
    });
    return copy;
  });

  const [confirmRevoke, setConfirmRevoke] = createSignal<SessionSummary | null>(null);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  async function handleRevoke(session: SessionSummary) {
    if (busy()) return;
    setBusy(true);
    try {
      const result = await props.client.revokeSession({
        accessToken: props.accessToken,
        sessionId: session.id,
      });
      setConfirmRevoke(null);
      toast.success(result.wasCurrent ? "Signed out" : "Session revoked");
      if (result.wasCurrent) {
        props.onLoggedOut?.();
      } else {
        await refetch();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke session");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevokeOthers() {
    if (busy()) return;
    setBusy(true);
    try {
      const result = await props.client.revokeOtherSessions({ accessToken: props.accessToken });
      setConfirmRevokeOthers(false);
      toast.success(
        result.revoked === 0
          ? "No other sessions to revoke"
          : `Revoked ${result.revoked} other session${result.revoked === 1 ? "" : "s"}`,
      );
      await refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke other sessions");
    } finally {
      setBusy(false);
    }
  }

  const otherSessionCount = () => sessions()?.filter((s) => !s.isCurrent).length ?? 0;

  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="text-foreground text-sm font-semibold">Active sessions</h3>
          <p class="text-muted-foreground text-xs">
            Devices currently signed into this account. Sign out of any you don't recognise.
          </p>
        </div>
        <Show when={otherSessionCount() > 0}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmRevokeOthers(true)}
            disabled={busy()}
          >
            Sign out other devices
          </Button>
        </Show>
      </div>

      <Show when={sessions.loading}>
        <p class="text-muted-foreground text-xs">Loading sessions…</p>
      </Show>

      <Show when={sessions.error}>
        <p class="text-destructive text-xs">
          {sessions.error instanceof Error ? sessions.error.message : "Failed to load sessions"}
        </p>
      </Show>

      <Show when={!sessions.loading && sessions()?.length === 0}>
        <p class="text-muted-foreground text-xs">No active sessions.</p>
      </Show>

      <ul class="flex flex-col gap-2">
        <For each={sessions() ?? []}>
          {(session) => (
            <li class="bg-card flex items-start justify-between gap-3 rounded-md border p-3">
              <div class="flex flex-col gap-0.5">
                <div class="flex items-center gap-2">
                  <span class="text-foreground text-sm font-medium">
                    {session.deviceLabel ?? "Unnamed device"}
                  </span>
                  <Show when={session.isCurrent}>
                    <span class="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
                      This device
                    </span>
                  </Show>
                </div>
                <Show when={session.userAgent}>
                  <p class="text-muted-foreground line-clamp-1 text-xs">{session.userAgent}</p>
                </Show>
                <p class="text-muted-foreground text-xs">
                  Last active {formatRelative(session.lastSeenAt)}
                  <Show when={session.ipHashPrefix}>
                    <span class="ml-1 font-mono text-[10px]">· {session.ipHashPrefix}</span>
                  </Show>
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRevoke(session)}
                disabled={busy()}
                aria-label={session.isCurrent ? "Sign out this device" : "Revoke session"}
              >
                {session.isCurrent ? "Sign out" : "Revoke"}
              </Button>
            </li>
          )}
        </For>
      </ul>

      <Dialog open={confirmRevoke() !== null} onOpenChange={(v) => !v && setConfirmRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmRevoke()?.isCurrent ? "Sign out of this device?" : "Revoke this session?"}
            </DialogTitle>
          </DialogHeader>
          <div class="p-4">
            <p class="text-muted-foreground text-sm">
              {confirmRevoke()?.isCurrent
                ? "You'll be signed out of this device immediately. You can sign back in from the login screen."
                : "This device will be signed out the next time it tries to refresh. This cannot be undone."}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRevoke(null)}
              disabled={busy()}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => confirmRevoke() && handleRevoke(confirmRevoke()!)}
              disabled={busy()}
            >
              {busy() ? "Revoking…" : confirmRevoke()?.isCurrent ? "Sign out" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRevokeOthers()} onOpenChange={setConfirmRevokeOthers}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Sign out of other devices?</DialogTitle>
          </DialogHeader>
          <div class="p-4">
            <p class="text-muted-foreground text-sm">
              This signs {otherSessionCount()} other device{otherSessionCount() === 1 ? "" : "s"}{" "}
              out of your account. This device stays signed in.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRevokeOthers(false)}
              disabled={busy()}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleRevokeOthers} disabled={busy()}>
              {busy() ? "Revoking…" : "Sign out other devices"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
