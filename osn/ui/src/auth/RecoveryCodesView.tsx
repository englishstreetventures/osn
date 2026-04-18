import type { RecoveryClient } from "@osn/client";
import { createSignal, For, Show } from "solid-js";

import { Button } from "../components/ui/button";

/**
 * Settings-panel surface for generating and displaying recovery codes
 * (Copenhagen Book M2). The codes are returned by the server exactly once;
 * this component surfaces a copy-to-clipboard and a .txt download so users
 * can reliably save them before dismissing.
 *
 * Design notes
 * ------------
 * - The component never persists the codes anywhere in the client — no
 *   localStorage, no application state beyond the signal that drives this
 *   view. Once the user dismisses, the codes are gone on the client side.
 *   The server keeps only hashes.
 * - Regenerating invalidates any previous set server-side. The UI requires
 *   an explicit "I saved these" confirmation before it will let you generate
 *   again, to avoid the easy footgun of accidentally rotating the set while
 *   the previous codes are still taped to a fridge somewhere.
 */

export interface RecoveryCodesViewProps {
  /** Recovery client, built via `createRecoveryClient({ issuerUrl })`. */
  client: RecoveryClient;
  /** The caller's current access token — required to authenticate generate. */
  accessToken: string;
  /** Fires once the user has acknowledged saving the codes. */
  onSaved?: () => void;
}

export function RecoveryCodesView(props: RecoveryCodesViewProps) {
  const [codes, setCodes] = createSignal<string[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [acknowledged, setAcknowledged] = createSignal(false);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await props.client.generateRecoveryCodes({ accessToken: props.accessToken });
      setCodes(res.codes);
      setAcknowledged(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate recovery codes");
    } finally {
      setBusy(false);
    }
  }

  async function copyToClipboard() {
    const c = codes();
    if (!c) return;
    await navigator.clipboard.writeText(c.join("\n"));
  }

  function downloadTxt() {
    const c = codes();
    if (!c) return;
    const blob = new Blob([c.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "osn-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function acknowledge() {
    setAcknowledged(true);
    setCodes(null);
    props.onSaved?.();
  }

  return (
    <div class="flex flex-col gap-4">
      <Show
        when={codes() !== null}
        fallback={
          <div class="flex flex-col gap-3">
            <p class="text-muted-foreground text-sm">
              Recovery codes let you sign in if you lose every device with your passkey. Each code
              works once. Generating a new set invalidates any previous codes.
            </p>
            <Button onClick={generate} disabled={busy()}>
              {busy() ? "Generating…" : "Generate recovery codes"}
            </Button>
            <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>
          </div>
        }
      >
        <div class="flex flex-col gap-3">
          <p class="text-muted-foreground text-sm">
            Save these codes somewhere safe. You will not see them again.
          </p>
          <ul class="bg-muted/40 grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm">
            <For each={codes()!}>{(c) => <li>{c}</li>}</For>
          </ul>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" onClick={copyToClipboard}>
              Copy
            </Button>
            <Button variant="outline" onClick={downloadTxt}>
              Download .txt
            </Button>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged()}
              onChange={(e) => setAcknowledged(e.currentTarget.checked)}
            />
            I've saved these codes somewhere safe.
          </label>
          <Button onClick={acknowledge} disabled={!acknowledged()}>
            Done
          </Button>
        </div>
      </Show>
    </div>
  );
}
