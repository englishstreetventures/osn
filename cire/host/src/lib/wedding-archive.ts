// The whole wedding as one ZIP: `POST …/archive`, owner only, at every tier.
//
// The API streams the archive as it builds it, reading each picture from
// storage on the way, so a wedding with many pictures takes a while and the
// answer carries no length. The portal reads it as it arrives, to show how
// much has come, then holds it as one Blob and saves it under a name of its
// own: the browser cannot read the API's `content-disposition` across origins.
//
// A Worker stopped part way ends the response early, and a ZIP cut short loses
// its end record, which is written last. So nothing is saved unless the bytes
// end in that record: a cut archive would open as a damaged file, or not at
// all, long after the owner has deleted the wedding it was their copy of.
//
// The state lives here, one entry per wedding, rather than in the page: a
// download outlives the page it was started from, so an owner who looks at
// another tab meanwhile comes back to it running, or saved, and a second press
// cannot start a second one, which would spend another of the owner's ten a day.
//
// Effect is deliberately NOT imported (frontend code).
import type { AuthFetch } from "@shared/rp-auth";
import { type Accessor, createSignal, type Setter } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "./api";
import { downloadBlob } from "./download";

/** Why a download saved nothing. */
export type ArchiveFailure =
  /** 403: the caller is not an owner of this wedding. */
  | "forbidden"
  /** 404: no such wedding, or it was deleted. */
  | "notFound"
  /** 429: the owner's ten a day, or the ten a minute every download shares. */
  | "limit"
  /** Any other refusal, a 500 among them: the read failed before any byte. */
  | "server"
  /** The request never reached the API. */
  | "network"
  /** The archive stopped before its end. */
  | "cut";

/** Where one wedding's download is. */
export type ArchiveState =
  | { phase: "idle" }
  /** Asked for, and `received` bytes of it in so far. */
  | { phase: "preparing"; received: number }
  /** Saved as `fileName`, `size` bytes. */
  | { phase: "ready"; fileName: string; size: number }
  | { phase: "failed"; reason: ArchiveFailure };

/** The saved file's name: the wedding's slug, as the API names it. */
const archiveFileName = (slug: string): string => `cire-wedding-${slug}.zip`;

/** A ZIP's end-of-central-directory record: 22 bytes, starting `PK 05 06`,
 *  and the archive's last bytes, since the API never writes a comment. */
const END_RECORD_SIZE = 22;
const END_RECORD_SIGNATURE = [0x50, 0x4b, 0x05, 0x06] as const;

/** Whether `blob` ends in a ZIP's end record, as a whole archive does. */
async function endsLikeAZip(blob: Blob): Promise<boolean> {
  if (blob.size < END_RECORD_SIZE) return false;
  const tail = new Uint8Array(await blob.slice(blob.size - END_RECORD_SIZE).arrayBuffer());
  return END_RECORD_SIGNATURE.every((byte, i) => tail[i] === byte);
}

/** What each refusal means, by the API's status. */
function failureFor(status: number): ArchiveFailure {
  switch (status) {
    case 403:
      return "forbidden";
    case 404:
      return "notFound";
    case 429:
      return "limit";
    default:
      return "server";
  }
}

/** Read the body to its end, reporting the running total after each chunk. */
async function readArchive(res: Response, onProgress: (received: number) => void): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  if (res.body) {
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(received);
    }
  }
  return new Blob(chunks, { type: "application/zip" });
}

type Outcome =
  | { ok: true; fileName: string; size: number }
  | { ok: false; reason: ArchiveFailure | "expired" };

async function download(
  authFetch: AuthFetch,
  weddingId: string,
  slug: string,
  onProgress: (received: number) => void,
): Promise<Outcome> {
  let res: Response;
  try {
    res = await authFetch(apiUrl(weddingPath(weddingId, "/archive")), { method: "POST" });
  } catch (err) {
    // `authFetch` answers a 401 by throwing, so a signed-out owner lands here.
    return { ok: false, reason: isAuthExpired(err) ? "expired" : "network" };
  }
  if (!res.ok) return { ok: false, reason: failureFor(res.status) };

  let archive: Blob;
  try {
    archive = await readArchive(res, onProgress);
  } catch {
    return { ok: false, reason: "cut" };
  }
  if (!(await endsLikeAZip(archive))) return { ok: false, reason: "cut" };

  const fileName = archiveFileName(slug);
  downloadBlob(fileName, archive);
  return { ok: true, fileName, size: archive.size };
}

interface Entry {
  state: Accessor<ArchiveState>;
  setState: Setter<ArchiveState>;
}

const entries = new Map<string, Entry>();

function entryFor(weddingId: string): Entry {
  let entry = entries.get(weddingId);
  if (!entry) {
    const [state, setState] = createSignal<ArchiveState>({ phase: "idle" });
    entry = { state, setState };
    entries.set(weddingId, entry);
  }
  return entry;
}

/** The subscribing read of one wedding's download. */
export function weddingArchiveState(weddingId: string): Accessor<ArchiveState> {
  return entryFor(weddingId).state;
}

/**
 * Download the wedding and save it, unless a download of it is already
 * running. A signed-out owner goes to sign in. Nothing is retried: a refusal,
 * the limit's included, waits for the owner to press again.
 */
export async function startWeddingArchive(
  authFetch: AuthFetch,
  weddingId: string,
  slug: string,
): Promise<void> {
  const { state, setState } = entryFor(weddingId);
  if (state().phase === "preparing") return;
  setState({ phase: "preparing", received: 0 });
  const outcome = await download(authFetch, weddingId, slug, (received) =>
    setState({ phase: "preparing", received }),
  );
  if (outcome.ok) {
    setState({ phase: "ready", fileName: outcome.fileName, size: outcome.size });
  } else if (outcome.reason === "expired") {
    setState({ phase: "idle" });
    redirectToLogin();
  } else {
    setState({ phase: "failed", reason: outcome.reason });
  }
}

const KB = 1000;
const MB = 1000 * KB;

/** Between a number and its unit, so a line never breaks them apart. */
const NO_BREAK = "\u00a0";

/**
 * A size as a file manager shows it, in decimal units: whole kilobytes under a
 * megabyte, never "0 KB", and megabytes to one place from where the kilobytes
 * would round to 1000.
 */
export function formatBytes(bytes: number): string {
  if (bytes < MB - KB / 2) return `${Math.max(1, Math.round(bytes / KB))}${NO_BREAK}KB`;
  return `${(bytes / MB).toFixed(1)}${NO_BREAK}MB`;
}
