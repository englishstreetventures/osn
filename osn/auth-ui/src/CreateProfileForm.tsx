import { describeAuthError } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Button } from "@shared/ui/ui/button";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { UsernameInput } from "@shared/ui/ui/username-input";
import { createSignal, createUniqueId, onCleanup, Show } from "solid-js";

import { describedBy, fieldError, type FieldError } from "./error-lines";

const HANDLE_RE = /^[a-z0-9_]{1,30}$/;

export interface CreateProfileFormProps {
  /**
   * Server-side handle availability check. When provided, the form debounces
   * calls on input and gates the submit button on `available`. Build it from
   * the existing `registrationClient.checkHandle` in the consuming app. The
   * form aborts the previous in-flight check via the `signal` before issuing
   * a new one — implementations that ignore it still work.
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
  // Above the submit, tied to the handle: the only field the server judges.
  const [error, setError] = createSignal<FieldError | null>(null);
  const errorId = createUniqueId();
  const [handleStatus, setHandleStatus] = createSignal<
    "idle" | "checking" | "available" | "taken" | "invalid" | "error"
  >("idle");

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Cancels the previous in-flight availability probe when a new one fires,
  // so debounced typing bursts never stack requests.
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

  const canSubmit = () => handleStatus() === "available";

  async function submit(e: Event) {
    e.preventDefault();
    if (busy() || !canSubmit()) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await createProfile(handle(), displayName().trim() || undefined);
      toast.success(`Profile @${profile.handle} created`);
      props.onSuccess?.(profile);
    } catch (err) {
      setError(fieldError(describeAuthError(err, "details"), err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} class="flex flex-col gap-4">
      <Field labelTreatment="plain" label="Handle">
        {(field) => (
          <UsernameInput
            id={field.id}
            required
            spellcheck={false}
            value={handle()}
            onInput={onHandleInput}
            status={handleStatus()}
            placeholder="lowercase, numbers, _"
            invalidMessage="1-30 chars: lowercase letters, numbers, underscores"
            aria-describedby={describedBy(field["aria-describedby"], error() && errorId)}
            aria-invalid={error()?.invalid || undefined}
          />
        )}
      </Field>

      <Field labelTreatment="plain" label="Display name (optional)">
        {(field) => (
          <Input
            {...field}
            type="text"
            value={displayName()}
            onInput={(e) => setDisplayName(e.currentTarget.value)}
          />
        )}
      </Field>

      <Show when={error()}>
        {(line) => (
          <Notice tone="danger" size="inline" alert id={errorId}>
            {line().text}
          </Notice>
        )}
      </Show>

      <div class="flex gap-2">
        <Button type="submit" busy={busy()} disabled={!busy() && !canSubmit()} class="flex-1">
          {busy() ? "Creating…" : "Create profile"}
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
