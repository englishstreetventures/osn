import { createSignal, Show } from "solid-js";

/**
 * An invisible copy of a CSS background image's request, there to report a
 * failed load, which a background cannot. A cropped image is drawn as a
 * background, so without this a key with no stored object behind it leaves
 * an empty frame on the guest's page.
 *
 * - **The same fetch, not a second one.** `src` and `srcset` name what the
 *   background names — for an `image-set()`, the same URLs with the same
 *   `1x`/`2x` descriptors, which pick the same candidate — so the browser
 *   answers both from one request.
 * - **No earlier than the background.** Lazy, and inside the layer it
 *   reports for, so a layer hidden at this width (`display: none`) fetches
 *   neither its background nor its probe.
 * - **Gone once it has answered.** A load removes it; an error calls
 *   `onError`, and the caller drops the frame and this with it.
 *
 * The caller's layer must be positioned: the probe covers it, at no opacity.
 */
export function BackgroundProbe(props: { src: string; srcset?: string; onError: () => void }) {
  const [loaded, setLoaded] = createSignal<string | null>(null);
  return (
    <Show when={loaded() !== props.src}>
      <img
        data-image-probe=""
        src={props.src}
        srcset={props.srcset}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        class="pointer-events-none absolute inset-0 size-full opacity-0"
        onLoad={() => setLoaded(props.src)}
        onError={() => props.onError()}
      />
    </Show>
  );
}
