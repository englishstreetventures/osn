import { Show } from "solid-js";

interface HeroCropLayerProps {
  /** One layer of `heroCropLayers`: the backdrop as a cover focal-point background. */
  readonly layer: Record<string, string>;
  /** The backdrop's URL, the same one the layer's `background-image` names. */
  readonly src: string;
  /** Faded in with the plain backdrop `<img>` once it has loaded. */
  readonly shown: boolean;
  /** The breakpoint classes that pick which layer shows. */
  readonly breakpoint: "hidden md:block" | "md:hidden";
  /** `anonymous` on a page that opens from an envelope (the hero's `imageCrossOrigin`). */
  readonly crossOrigin: "anonymous" | undefined;
}

/** The fade every crop layer runs, the plain backdrop `<img>`'s own. */
// oxlint-disable-next-line house/no-literal-motion -- a hero fade, choreography longer than --dur-slow (cire/host/DESIGN.md §Motion)
const HERO_FADE = "transition-opacity duration-700";

/**
 * One of the hero backdrop's crop layers, shared by every design pack.
 *
 * As a rule it is a `<div>` with the crop as a cover `background-image`. On a
 * page that opens from an envelope it is an anonymous-CORS `<img>` instead:
 * a CSS background is always fetched without CORS, so beside the backdrop's
 * anonymous `<img>` it would fetch the same picture a second time and push
 * the other's copy out of the browser's cache (cire-api varies images on
 * `Origin`). `object-fit: cover` with `object-position` at the layer's
 * `background-position` places the picture exactly as `background-size:
 * cover` does at that position.
 */
export function HeroCropLayer(props: HeroCropLayerProps) {
  const opacity = () => (props.shown ? "1" : "0");
  return (
    <Show
      when={props.crossOrigin}
      fallback={
        <div
          aria-hidden="true"
          class={
            props.breakpoint === "md:hidden"
              ? `absolute inset-0 h-full w-full bg-cover ${HERO_FADE} md:hidden`
              : `absolute inset-0 hidden h-full w-full bg-cover ${HERO_FADE} md:block`
          }
          style={{ ...props.layer, opacity: opacity() }}
        />
      }
    >
      {(crossOrigin) => (
        <img
          src={props.src}
          crossorigin={crossOrigin()}
          alt=""
          aria-hidden="true"
          class={
            props.breakpoint === "md:hidden"
              ? `absolute inset-0 h-full w-full object-cover ${HERO_FADE} md:hidden`
              : `absolute inset-0 hidden h-full w-full object-cover ${HERO_FADE} md:block`
          }
          style={{ "object-position": props.layer["background-position"], opacity: opacity() }}
        />
      )}
    </Show>
  );
}
