import { createSignal, Show } from "solid-js";

/**
 * A person's OSN photo, if it is an absolute https URL. The API already drops
 * anything else; the sink checks again, as `ProfileMenu` does, because an
 * `<img src>` is where a bad scheme would do its harm.
 */
function httpsOnly(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * A person's face: their photo, or the empty avatar — a person's outline cut out
 * of a muted disc, the default Facebook and Instagram show — when they have no
 * photo or it will not load. Never initials: on a stack of faces a pair of
 * letters reads as a label, and a stack of labels as a list of codes.
 *
 * A photo that will not load — a dead link, a response that is not an image,
 * or a host the portal's CSP `img-src` does not list, which today is every
 * avatar host (englishstreetventures/osn#1207) — falls back to the empty avatar.
 * The failure is kept per URL, so a new photo gets its own try.
 *
 * Decorative: the caller names the person in text. The circle's size comes in
 * through `class`.
 */
export default function PersonAvatar(props: { url?: string; class?: string }) {
  const [failedUrl, setFailedUrl] = createSignal<string | null>(null);
  const photo = () => {
    const url = httpsOnly(props.url);
    return url !== failedUrl() ? url : null;
  };
  return (
    <span
      aria-hidden="true"
      class={`relative flex shrink-0 overflow-hidden rounded-full ${props.class ?? ""}`}
    >
      <Show when={photo()} keyed fallback={<BlankAvatar />}>
        {(url) => (
          <img
            src={url}
            alt=""
            onError={() => setFailedUrl(url)}
            class="h-full w-full object-cover"
          />
        )}
      </Show>
    </span>
  );
}

/** The empty avatar: the page's own colour, in a person's outline, on a disc
 *  of faint ink — so it reads as nobody's photo in either ramp. */
function BlankAvatar() {
  return (
    <svg data-blank-avatar viewBox="0 0 32 32" class="blank-avatar h-full w-full">
      <circle cx="16" cy="12.25" r="5.75" fill="currentColor" />
      <path d="M4.5 31.5c0-7.2 5.15-11.75 11.5-11.75s11.5 4.55 11.5 11.75z" fill="currentColor" />
    </svg>
  );
}
