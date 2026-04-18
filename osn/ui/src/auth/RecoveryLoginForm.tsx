import type { RecoveryClient } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { createSignal, Show } from "solid-js";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

/**
 * Standalone recovery-code login surface. Takes a handle/email and a single
 * recovery code, calls the unauthenticated `/login/recovery/complete`, and
 * adopts the returned session through the standard auth provider.
 *
 * Intended to be mounted from the "trouble signing in?" link on the sign-in
 * screen — not part of the normal login flow.
 */

export interface RecoveryLoginFormProps {
  client: RecoveryClient;
  onSuccess?: () => void;
  onCancel?: () => void;
}

export function RecoveryLoginForm(props: RecoveryLoginFormProps) {
  const { adoptSession } = useAuth();
  const [identifier, setIdentifier] = createSignal("");
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await props.client.loginWithRecoveryCode({
        identifier: identifier().trim(),
        code: code().trim(),
      });
      adoptSession(result.session);
      props.onSuccess?.();
    } catch (err) {
      // Generic message — the server deliberately doesn't distinguish "wrong
      // identifier" from "wrong code" to avoid a user-existence oracle.
      setError("That recovery code didn't work. Double-check the code and identifier.");
      void err;
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} class="flex flex-col gap-3">
      <p class="text-muted-foreground text-sm">
        Enter your handle or email plus one of your saved recovery codes. All other signed-in
        sessions will be revoked.
      </p>
      <div class="flex flex-col gap-1">
        <Label for="recovery-identifier">Handle or email</Label>
        <Input
          id="recovery-identifier"
          autocomplete="username"
          value={identifier()}
          onInput={(e) => setIdentifier(e.currentTarget.value)}
          required
        />
      </div>
      <div class="flex flex-col gap-1">
        <Label for="recovery-code">Recovery code</Label>
        <Input
          id="recovery-code"
          autocomplete="one-time-code"
          placeholder="xxxx-xxxx-xxxx-xxxx"
          value={code()}
          onInput={(e) => setCode(e.currentTarget.value)}
          required
        />
      </div>
      <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>
      <div class="flex gap-2">
        <Button type="submit" disabled={busy() || !identifier() || !code()}>
          {busy() ? "Signing in…" : "Sign in with recovery code"}
        </Button>
        <Show when={props.onCancel}>
          {(cancel) => (
            <Button type="button" variant="ghost" onClick={cancel()}>
              Cancel
            </Button>
          )}
        </Show>
      </div>
    </form>
  );
}
