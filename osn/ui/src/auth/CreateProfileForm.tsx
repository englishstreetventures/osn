import { useAuth } from "@osn/client/solid";
import { createSignal, onCleanup, Show } from "solid-js";
import { toast } from "solid-toast";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

const HANDLE_RE = /^[a-z0-9_]{1,30}$/;

export interface CreateProfileFormProps {
  /**
   * Server-side handle availability check. When provided, the form debounces
   * calls on input and gates the submit button on `available`. Build it from
   * the existing `registrationClient.checkHandle` in the consuming app. The
   * form aborts the previous in-flight check via the `signal` before issuing
   * a new one (P-W10) — implementations that ignore it still work.
   */
  checkHandle?: (handle: string, signal?: AbortSignal) => Promise<{ available: boolean }>;
  onSuccess?: (profile: { id: string; handle: string }) => void;
  onCancel?: () => void;
}

export function CreateProfileForm(props: CreateProfileFormProps) {
  const { createProfile } = useAuth();

  const [handle, setHandle] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [handleStatus, setHandleStatus] = createSignal<
    "idle" | "checking" | "available" | "taken" | "invalid" | "error"
  >("idle");

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Cancels the previous in-flight availability probe when a new one fires,
  // so debounced typing bursts never stack requests (P-W10).
  let checkAbort: AbortController | null = null;
  onCleanup(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    checkAbort?.abort();
  });

  function onHandleInput(value: string) {
    const next = value.toLowerCase().replace(/[^a-z0-9_]/g, "");
    setHandle(next);
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!next) {
      setHandleStatus("idle");
      return;
    }
    if (!HANDLE_RE.test(next)) {
      setHandleStatus("invalid");
      return;
    }
    if (!props.checkHandle) {
      // No server check — treat local validation as sufficient.
      setHandleStatus("available");
      return;
    }
    setHandleStatus("checking");
    debounceTimer = setTimeout(async () => {
      checkAbort?.abort();
      const controller = new AbortController();
      checkAbort = controller;
      try {
        const { available } = await props.checkHandle!(next, controller.signal);
        if (handle() !== next) return;
        setHandleStatus(available ? "available" : "taken");
      } catch {
        // An aborted probe was superseded (or unmounted) — never an error state.
        if (controller.signal.aborted || handle() !== next) return;
        setHandleStatus("error");
      }
    }, 300);
  }

  const canSubmit = () => handleStatus() === "available" && !busy();

  async function submit(e: Event) {
    e.preventDefault();
    if (!canSubmit()) return;
    setBusy(true);
    try {
      const profile = await createProfile(handle(), displayName().trim() || undefined);
      toast.success(`Profile @${profile.handle} created`);
      props.onSuccess?.(profile);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create profile");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} class="flex flex-col gap-4">
      <div class="flex flex-col gap-1">
        <Label for="cpf-handle">Handle</Label>
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground">@</span>
          <Input
            id="cpf-handle"
            type="text"
            required
            autocomplete="username"
            value={handle()}
            onInput={(e) => onHandleInput(e.currentTarget.value)}
            placeholder="lowercase, numbers, _"
            class="flex-1"
          />
        </div>
        <Show when={handleStatus() === "checking"}>
          <span class="text-muted-foreground text-xs">Checking...</span>
        </Show>
        <Show when={handleStatus() === "available"}>
          <span class="text-xs text-green-600">@{handle()} is available</span>
        </Show>
        <Show when={handleStatus() === "taken"}>
          <span class="text-destructive text-xs">@{handle()} is taken</span>
        </Show>
        <Show when={handleStatus() === "invalid"}>
          <span class="text-destructive text-xs">
            1-30 chars: lowercase letters, numbers, underscores
          </span>
        </Show>
        <Show when={handleStatus() === "error"}>
          <span class="text-destructive text-xs">Couldn&apos;t check availability — try again</span>
        </Show>
      </div>

      <div class="flex flex-col gap-1">
        <Label for="cpf-display-name">Display name (optional)</Label>
        <Input
          id="cpf-display-name"
          type="text"
          value={displayName()}
          onInput={(e) => setDisplayName(e.currentTarget.value)}
        />
      </div>

      <div class="flex gap-2">
        <Button type="submit" disabled={!canSubmit()} class="flex-1">
          {busy() ? "Creating..." : "Create profile"}
        </Button>
        {props.onCancel && (
          <Button type="button" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
