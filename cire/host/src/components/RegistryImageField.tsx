/**
 * The picture on a registry item — uploaded from the organiser's machine, or
 * copied off a shop page they paste a link to.
 *
 * Structure, accessibility handling and inline error surface follow
 * `invite/ImageField.tsx`, which is the portal's other image control. Two things
 * differ, and both come from the backend:
 *
 *  - **Every picture is fetched, not linked.** Invite images are served by a
 *    PUBLIC route (`/api/invite/:slug/image/:slot`), so `ImageField` can put the
 *    URL straight in an `<img src>`. A registry image is served behind the
 *    organiser session, the role gate and the entitlement, and answered
 *    `private`; it is read with `authFetch` (which sends the session cookie)
 *    into an object URL, revoked when it is replaced or the field goes away.
 *  - **The link path offers a choice.** A shop page has a dozen images and only
 *    the organiser knows which one is the gift, so `POST /registry/link-preview`
 *    returns the candidates and this field renders them as a radio group. Taking
 *    the first one silently would be wrong more often than right. Each
 *    candidate's picture comes from `POST /registry/link-preview/image`, which
 *    fetches and re-encodes it on cire-api, read into an object URL the same
 *    way. The browser never loads a shop's host, which is what lets the
 *    portal's CSP `img-src` (`public/_headers`) admit no https origin but
 *    cire-api's.
 *
 * `ImageCropModal` is deliberately NOT reused. It is slot-typed to the invite's
 * `CropSlot`s and reads `CROP_ASPECT[slot]` for its frame; a registry thumbnail
 * has no such slot and no fixed aspect, so wiring one in would mean inventing a
 * crop slot for a picture nothing crops. The column exists (`imageCrop`) for the
 * day the guest-facing registry needs one.
 *
 * What is saved is an R2 key, never the third-party URL — see
 * `cire/api/src/services/registry-image.ts` for why. This field never renders a
 * saved image from a shop's origin: after the copy, the only URL it knows is ours.
 */

import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { haptic } from "../lib/haptics";
/** Mirrors `MAX_IMAGE_BYTES` in `cire/api/src/services/invite-assets.ts`. Checked
 *  here only to spare the organiser a five-megabyte upload that ends in a 413 —
 *  the cap that counts is the server's. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ACCEPT = "image/jpeg,image/png,image/webp";

/** What the API answers on a save. `imageUrl` is ours, and relative. */
interface SavedImage {
  imageKey: string;
  imageUrl: string;
}

interface Preview {
  title: string | null;
  siteName: string | null;
  images: string[];
}

/**
 * Is this a URL this field will put in an `<img src>`?
 *
 * `https:` only. The API emits nothing else — the SSRF guard rejects every other
 * scheme before a page is ever fetched — but a candidate list arrives over the
 * wire as plain JSON, and `javascript:` in an `src` or an `href` runs in the
 * organiser's own origin. Same render-site check, same reason, as `isHttpsUrl`
 * in `RegistryView.tsx`.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** The name a screen reader reads for one candidate. Real words, from the page
 *  the organiser is looking at — "image 3" tells them nothing about which
 *  picture they are about to put on their gift list. */
function candidateLabel(preview: Preview | null, index: number, total: number): string {
  const from = preview?.title ?? preview?.siteName;
  return from
    ? `Picture ${index + 1} of ${total} from ${from}`
    : `Picture ${index + 1} of ${total} from that page`;
}

export default function RegistryImageField(props: {
  weddingId: string;
  /** The saved R2 key, or null for an item with no picture. */
  imageKey: string | null;
  /** A new key (or null on remove). The caller owns the item row; this field
   *  only ever hands back what the server stored. */
  onChange: (imageKey: string | null) => void;
  /** Ids of the controls are namespaced with this, so the add form and an open
   *  inline editor can both be on screen without colliding. */
  idPrefix: string;
  disabled?: boolean;
}) {
  const { authFetch } = useAuth();

  // Which path the organiser is on. `null` is the chooser — two buttons and
  // nothing else, which is the whole of the field for an item with a picture.
  const [mode, setMode] = createSignal<"upload" | "link" | null>(null);
  const [busy, setBusy] = createSignal<null | "preview" | "save">(null);
  const [error, setError] = createSignal<string | null>(null);
  /** Set when a page yielded nothing usable. Not an error state — it is a normal
   *  answer for a shop that lazy-loads its photos — so it reads as a note and
   *  offers the upload path from where the organiser already is. */
  const [noImages, setNoImages] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [chosen, setChosen] = createSignal<string | null>(null);
  const [thumb, setThumb] = createSignal<string | null>(null);
  /** Candidate URL → its thumbnail's object URL, or `null` once it failed.
   *  Absent means still loading. */
  const [candidateThumbs, setCandidateThumbs] = createSignal<ReadonlyMap<string, string | null>>(
    new Map(),
  );
  /** Bumped on every reset, so a thumbnail that lands after its preview was
   *  replaced is revoked rather than shown. */
  let thumbGeneration = 0;

  const base = () => weddingPath(props.weddingId, "/registry");

  /** Only the https candidates are ever rendered — see `isHttpsUrl`. */
  const candidates = () => (preview()?.images ?? []).filter(isHttpsUrl);

  // ── The saved thumbnail ───────────────────────────────────────────────────
  // Read through `authFetch`, because the serve route is gated and private.
  createEffect(() => {
    const key = props.imageKey;
    let live = true;
    onCleanup(() => {
      live = false;
    });
    if (!key || typeof URL.createObjectURL !== "function") {
      swapThumb(null);
      return;
    }
    const name = key.slice(key.lastIndexOf("/") + 1);
    void (async () => {
      try {
        // `thumb` (320px), not the default `card` (800px): this paints into an
        // 80px box, so the card variant would spend several times the bytes and
        // the decode on detail no one can see.
        const res = await authFetch(
          apiUrl(`${base()}/image/${encodeURIComponent(name)}?variant=thumb`),
        );
        if (!res.ok) throw new Error(`image ${res.status}`);
        const blob = await res.blob();
        if (!live) return;
        swapThumb(URL.createObjectURL(blob));
      } catch {
        // A thumbnail that won't load is not worth an alert next to a form the
        // organiser is filling in: the item still has its picture, and the save
        // that produced the key already succeeded. The alt text carries it.
        if (live) swapThumb(null);
      }
    })();
  });

  /** One object URL alive at a time — the old one is revoked as it is replaced,
   *  and the last one when the field unmounts. */
  function swapThumb(next: string | null) {
    setThumb((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return next;
    });
  }
  onCleanup(() => swapThumb(null));

  // ── The candidates' thumbnails ────────────────────────────────────────────
  /** Revoke every candidate thumbnail and forget the set. */
  function clearCandidateThumbs() {
    thumbGeneration += 1;
    for (const url of candidateThumbs().values()) if (url) URL.revokeObjectURL(url);
    setCandidateThumbs(new Map());
  }
  onCleanup(clearCandidateThumbs);

  /**
   * Ask cire-api for each candidate's thumbnail, all at once. A failure is not
   * worth an alert — the radio still works and its name says which picture it
   * is — so that candidate shows a plain label instead. `Accept` names the
   * formats this browser decodes, which is what the API re-encodes to.
   */
  function loadCandidateThumbs(list: readonly string[]) {
    if (typeof URL.createObjectURL !== "function") return;
    const generation = thumbGeneration;
    for (const candidate of list) {
      void (async () => {
        let objectUrl: string | null = null;
        try {
          const res = await authFetch(apiUrl(`${base()}/link-preview/image`), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "image/avif,image/webp,image/*",
            },
            body: JSON.stringify({ url: candidate }),
          });
          if (res.ok) objectUrl = URL.createObjectURL(await res.blob());
        } catch {
          // An expired session, a network drop: the label stands in.
        }
        if (generation !== thumbGeneration) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }
        setCandidateThumbs((prev) => new Map(prev).set(candidate, objectUrl));
      })();
    }
  }

  // ── Shared response handling ──────────────────────────────────────────────
  /** Turn a failed save/preview into a message the organiser can act on. */
  const explain = async (res: Response, leg: "preview" | "upload" | "from-url") => {
    if (res.status === 401) {
      redirectToLogin();
      return null;
    }
    const code = await res
      .json()
      .then((body: unknown) => (body as { error?: string }).error ?? "")
      .catch(() => "");
    switch (res.status) {
      case 400:
        return code === "blocked_url"
          ? "That link can't be opened from here. Check the address, or upload a photo instead."
          : "A link must be a full https:// address.";
      case 402:
        return "The gift registry isn't part of this wedding's plan yet.";
      case 403:
        return "You have read-only access to this wedding.";
      case 413:
        return "That picture is over 5 MB. Try a smaller one.";
      case 415:
        return leg === "preview"
          ? "That link isn't a web page we can read."
          : "That file isn't a JPEG, PNG or WebP.";
      case 429:
        return "That's a lot of links at once. Wait a minute, then try again.";
      case 502:
        return leg === "preview"
          ? "We couldn't reach that page. Check the link, or upload a photo instead."
          : "We couldn't download that picture. Try another one, or upload a photo.";
      default:
        return leg === "preview" ? "Couldn't read that page." : "Couldn't save that picture.";
    }
  };

  const saved = (image: SavedImage) => {
    props.onChange(image.imageKey);
    haptic("commit");
    setMode(null);
    setPreview(null);
    clearCandidateThumbs();
    setChosen(null);
    setUrl("");
    setNoImages(false);
  };

  const failed = (message: string | null) => {
    if (message === null) return; // redirected to sign-in
    haptic("reject");
    setError(message);
  };

  // ── Upload ────────────────────────────────────────────────────────────────
  const upload = async (file: File) => {
    setError(null);
    setNoImages(false);
    if (file.size > MAX_IMAGE_BYTES) {
      failed("That picture is over 5 MB. Try a smaller one.");
      return;
    }
    setBusy("save");
    try {
      const res = await authFetch(apiUrl(`${base()}/image`), {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!res.ok) return failed(await explain(res, "upload"));
      saved((await res.json()) as SavedImage);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      failed("Couldn't save that picture.");
    } finally {
      setBusy(null);
    }
  };

  // ── Link: find the candidates ─────────────────────────────────────────────
  const findImages = async () => {
    const link = url().trim();
    if (!link) return;
    setError(null);
    setNoImages(false);
    setPreview(null);
    clearCandidateThumbs();
    setChosen(null);
    setBusy("preview");
    try {
      const res = await authFetch(apiUrl(`${base()}/link-preview`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link }),
      });
      if (res.status === 422) {
        setNoImages(true);
        return;
      }
      if (!res.ok) return failed(await explain(res, "preview"));
      const body = (await res.json()) as Preview;
      setPreview(body);
      // A page whose every candidate failed the scheme check is, to this field,
      // a page with no pictures — same message, same way out.
      const usable = (body.images ?? []).filter(isHttpsUrl);
      if (usable.length === 0) setNoImages(true);
      else loadCandidateThumbs(usable);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      failed("Couldn't read that page.");
    } finally {
      setBusy(null);
    }
  };

  // ── Link: copy the chosen one ─────────────────────────────────────────────
  const useChosen = async () => {
    const pick = chosen();
    if (!pick || !isHttpsUrl(pick)) return;
    setError(null);
    setBusy("save");
    try {
      const res = await authFetch(apiUrl(`${base()}/image/from-url`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pick }),
      });
      if (!res.ok) return failed(await explain(res, "from-url"));
      saved((await res.json()) as SavedImage);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      failed("Couldn't save that picture.");
    } finally {
      setBusy(null);
    }
  };

  // ── The radio group's keyboard ────────────────────────────────────────────
  // A radio group is one tab stop; the arrows move within it and selection
  // follows focus. Roving tabindex, so Tab leaves the group rather than walking
  // through six pictures.
  let refs: HTMLButtonElement[] = [];
  createEffect(() => {
    // Rebuild the ref list whenever the candidate set changes, so a stale
    // element from a previous page is never focused.
    candidates();
    refs = [];
  });
  const onKey = (e: KeyboardEvent, index: number) => {
    const list = candidates();
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    let next = -1;
    if (step !== 0) next = (index + step + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === " " || e.key === "Enter") next = index;
    else return;
    e.preventDefault();
    setChosen(list[next] ?? null);
    refs[next]?.focus();
  };

  return (
    <div class="flex flex-col gap-2">
      <span class="font-body text-text-muted text-ui-sm" id={`${props.idPrefix}-picture-label`}>
        Picture
      </span>

      <Show when={props.imageKey}>
        <div class="flex flex-wrap items-center gap-3">
          <Show
            when={thumb()}
            fallback={<span class="text-text-muted text-ui-sm italic">Picture saved.</span>}
          >
            {(src) => (
              // Decorative, as in `invite/ImageField.tsx`: the field's own label
              // says what this is and the button beside it says what can be done
              // about it, so alt text here would only repeat them.
              <img
                src={src()}
                alt=""
                class="border-border h-20 w-20 rounded-sm border object-cover"
              />
            )}
          </Show>
          <Button
            variant="danger"
            size="sm"
            disabled={props.disabled || busy() !== null}
            onClick={() => {
              props.onChange(null);
              setMode(null);
            }}
          >
            Remove picture
          </Button>
        </div>
      </Show>

      {/* The chooser. Two ways in, named plainly; `aria-pressed` says which one
          is open, because the panel below is the only other clue. */}
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant={mode() === "upload" ? "primary" : "outline"}
          size="sm"
          aria-pressed={mode() === "upload"}
          disabled={props.disabled}
          onClick={() => {
            setError(null);
            setNoImages(false);
            setMode(mode() === "upload" ? null : "upload");
          }}
        >
          Upload a photo
        </Button>
        <Button
          variant={mode() === "link" ? "primary" : "outline"}
          size="sm"
          aria-pressed={mode() === "link"}
          disabled={props.disabled}
          onClick={() => {
            setError(null);
            setMode(mode() === "link" ? null : "link");
          }}
        >
          Use a shop link
        </Button>
      </div>

      <Show when={mode() === "upload"}>
        <input
          type="file"
          accept={ACCEPT}
          aria-label="Photo to upload"
          disabled={props.disabled || busy() !== null}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file) void upload(file);
            e.currentTarget.value = "";
          }}
          class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-ui-sm file:text-ui-sm file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5"
        />
      </Show>

      <Show when={mode() === "link"}>
        <div class="flex flex-col gap-2">
          <div class="flex flex-wrap items-end gap-2">
            <label class="font-body text-text-muted text-ui-sm" for={`${props.idPrefix}-shop-link`}>
              Shop link
            </label>
            <Input
              id={`${props.idPrefix}-shop-link`}
              size="sm"
              type="url"
              class="min-w-64 flex-1"
              placeholder="https://…"
              value={url()}
              disabled={props.disabled || busy() !== null}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={props.disabled || busy() !== null || url().trim() === ""}
              onClick={() => void findImages()}
            >
              Find pictures
            </Button>
          </div>

          {/* Fetching a shop page takes seconds. Say so, and say it in a live
              region — a field that simply sits there reads as broken. */}
          <Show when={busy() === "preview"}>
            <p class="text-text-muted text-ui-sm" role="status">
              Looking for pictures on that page…
            </p>
          </Show>

          <Show when={noImages()}>
            <Notice tone="info">
              We couldn't find a picture on that page. Some shops load their photos after the page
              opens. Upload one instead, or paste a different link.
            </Notice>
          </Show>

          <Show when={candidates().length > 0}>
            <div class="flex flex-col gap-2">
              <p class="text-text-muted text-ui-sm" id={`${props.idPrefix}-candidates-label`}>
                Choose the picture for this gift.
              </p>
              <div
                role="radiogroup"
                aria-labelledby={`${props.idPrefix}-candidates-label`}
                class="flex flex-wrap gap-2"
              >
                <For each={candidates()}>
                  {(candidate, i) => (
                    <Button
                      variant="choice"
                      size="swatch"
                      ref={(el) => {
                        refs[i()] = el;
                      }}
                      type="button"
                      role="radio"
                      aria-checked={chosen() === candidate}
                      aria-label={candidateLabel(preview(), i(), candidates().length)}
                      tabindex={chosen() === candidate || (chosen() === null && i() === 0) ? 0 : -1}
                      disabled={props.disabled || busy() !== null}
                      onClick={() => setChosen(candidate)}
                      onKeyDown={(e) => onKey(e, i())}
                    >
                      {/* Decorative: the button carries the name. The picture
                          is cire-api's re-encoded 320px copy, never the shop's
                          own URL. Until it lands the box stays empty; if it
                          fails, the number stands in. */}
                      <Show
                        when={candidateThumbs().get(candidate)}
                        fallback={
                          <span
                            aria-hidden="true"
                            class="text-text-muted text-ui-xs flex h-20 w-20 items-center justify-center"
                          >
                            {candidateThumbs().has(candidate) ? `Picture ${i() + 1}` : ""}
                          </span>
                        }
                      >
                        {(src) => (
                          <img
                            src={src()}
                            alt=""
                            decoding="async"
                            width={80}
                            height={80}
                            class="h-20 w-20 object-cover"
                          />
                        )}
                      </Show>
                    </Button>
                  )}
                </For>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={props.disabled || busy() !== null || chosen() === null}
                  onClick={() => void useChosen()}
                >
                  {busy() === "save" ? "Saving…" : "Use this picture"}
                </Button>
                <span class="text-text-muted text-ui-xs">
                  We keep our own copy, so it stays on your list even if the shop changes the page.
                </span>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={busy() === "save" && mode() !== "link"}>
        <p class="text-text-muted text-ui-sm" role="status">
          Saving that picture…
        </p>
      </Show>

      <Show when={error()}>
        <Notice tone="danger" alert>
          {error()}
        </Notice>
      </Show>
    </div>
  );
}
