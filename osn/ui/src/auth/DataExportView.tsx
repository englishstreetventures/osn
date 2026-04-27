import type {
  AccountExportClient,
  AccountExportStatus,
  StepUpClient,
  StepUpToken,
} from "@osn/client";
import { createEffect, createSignal, Show } from "solid-js";

import { Button } from "../components/ui/button";
import { StepUpDialog } from "./StepUpDialog";

/**
 * Settings-panel surface for the GDPR Art. 15 / Art. 20 + CCPA right-to-
 * know account-data export (C-H1).
 *
 * Flow:
 *   1. Mount → fetch `/account/export/status` for cooldown info.
 *   2. User clicks "Download my data" → step-up ceremony.
 *   3. On token → call `/account/export`, stream NDJSON to a Blob, trigger
 *      browser <a download>. Tauri builds receive the same `Response`
 *      and can pipe to the system save dialog.
 */
export interface DataExportViewProps {
  accountExportClient: AccountExportClient;
  stepUpClient: StepUpClient;
  accessToken: string;
  /** Forwarded to StepUpDialog so passkeys work when available. */
  runPasskeyCeremony?: (options: unknown) => Promise<unknown>;
  /**
   * Optional override for the file save behaviour (Tauri builds inject
   * this to write through `tauri::fs::write_binary` instead of building
   * an in-memory Blob). Default: browser <a download>.
   */
  onDownload?: (blob: Blob, filename: string) => Promise<void>;
}

const DEFAULT_FILENAME = (): string =>
  `osn-data-export-${new Date().toISOString().slice(0, 10)}.ndjson`;

async function defaultDownload(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so Safari has time to navigate to the blob.
  setTimeout(() => URL.revokeObjectURL(url), 250);
}

export function DataExportView(props: DataExportViewProps) {
  const [status, setStatus] = createSignal<AccountExportStatus | null>(null);
  const [phase, setPhase] = createSignal<"idle" | "step_up" | "downloading" | "done" | "error">(
    "idle",
  );
  const [error, setError] = createSignal<string | null>(null);
  const [progressBytes, setProgressBytes] = createSignal(0);

  const refreshStatus = async () => {
    try {
      const s = await props.accountExportClient.status({ accessToken: props.accessToken });
      setStatus(s);
    } catch (e) {
      // Status is informational only — don't block the action UI on a
      // failed status fetch.
      setStatus(null);
      // eslint-disable-next-line no-console
      // (No console.* here — leaving status null is the visible signal.)
      void e;
    }
  };

  createEffect(() => {
    void refreshStatus();
  });

  const cooldownLabel = () => {
    const next = status()?.nextAvailableAt;
    if (!next) return null;
    const ms = new Date(next).getTime() - Date.now();
    if (ms <= 0) return null;
    const hrs = Math.ceil(ms / 3_600_000);
    return hrs <= 1 ? "Available again in under an hour" : `Available again in ~${hrs} hours`;
  };

  const onTokenReceived = async (tok: StepUpToken) => {
    setPhase("downloading");
    setProgressBytes(0);
    setError(null);
    try {
      const res = await props.accountExportClient.download({
        accessToken: props.accessToken,
        stepUpToken: tok.token,
      });
      // Stream the body so the browser tab doesn't pin the entire bundle
      // in memory before save. We chunk into a Blob; large enough budgets
      // stay around 32 MB which all browsers handle fine.
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const chunks: Uint8Array[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        setProgressBytes((b) => b + value.byteLength);
      }
      const blob = new Blob(chunks as BlobPart[], { type: "application/x-ndjson" });
      const filename = DEFAULT_FILENAME();
      const downloader = props.onDownload ?? defaultDownload;
      await downloader(blob, filename);
      setPhase("done");
      await refreshStatus();
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Download failed");
    }
  };

  return (
    <div class="flex flex-col gap-4">
      <div>
        <h2 class="text-lg font-semibold">Download your data</h2>
        <p class="text-muted-foreground mt-1 text-sm">
          A copy of everything tied to your OSN account: profile, security audit, social graph,
          organisations, plus your activity on connected apps (Pulse events &amp; RSVPs, Zap chat
          membership). Streams directly to your device — nothing is stored on a server.
        </p>
        <p class="text-muted-foreground mt-2 text-xs">
          Encrypted Zap message contents are excluded by design (the server has no key). Your local
          Zap client can export decrypted history separately.
        </p>
      </div>

      <Show when={error()}>{(m) => <p class="text-destructive text-sm">{m()}</p>}</Show>

      <Show when={status()?.lastExportAt}>
        {(last) => (
          <p class="text-muted-foreground text-xs">
            Last export: {new Date(last()).toLocaleString()}
          </p>
        )}
      </Show>

      <Show when={phase() === "idle" || phase() === "error" || phase() === "done"}>
        <div class="flex flex-col gap-2">
          <Button
            onClick={() => {
              setError(null);
              setPhase("step_up");
            }}
            disabled={!!cooldownLabel()}
          >
            Download my data
          </Button>
          <Show when={cooldownLabel()}>
            {(label) => <p class="text-muted-foreground text-xs">{label()}</p>}
          </Show>
          <Show when={phase() === "done"}>
            <p class="text-sm text-emerald-600">Download started — check your downloads folder.</p>
          </Show>
        </div>
      </Show>

      <Show when={phase() === "downloading"}>
        <div class="flex flex-col gap-1">
          <p class="text-sm">Streaming export…</p>
          <p class="text-muted-foreground text-xs">
            {(progressBytes() / 1024).toFixed(1)} KB received
          </p>
        </div>
      </Show>

      <Show when={phase() === "step_up"}>
        <StepUpDialog
          client={props.stepUpClient}
          accessToken={props.accessToken}
          runPasskeyCeremony={props.runPasskeyCeremony}
          onToken={(tok) => {
            void onTokenReceived(tok);
          }}
          onCancel={() => setPhase("idle")}
        />
      </Show>
    </div>
  );
}
