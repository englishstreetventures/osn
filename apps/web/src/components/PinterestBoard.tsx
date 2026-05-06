import { Show } from "solid-js";
import { isValidPinterestUrl, toEmbedUrl } from "./pinterest";

interface PinterestBoardProps {
  url: string;
  eventName: string;
}

/**
 * Renders a Pinterest board as an iframe embed when the supplied URL passes
 * the allowlist (`isValidPinterestUrl`). On any invalid input we fall back to
 * a plain outbound link iff the URL itself is a safe Pinterest board URL —
 * otherwise we render nothing to avoid surfacing untrusted hrefs.
 */
export function PinterestBoard(props: PinterestBoardProps) {
  return (
    <Show
      when={toEmbedUrl(props.url)}
      fallback={
        <Show when={isValidPinterestUrl(props.url)}>
          <a
            href={props.url}
            target="_blank"
            rel="noopener noreferrer"
            class="font-body text-[0.85rem] italic text-gold underline"
          >
            View on Pinterest
          </a>
        </Show>
      }
    >
      {(embed) => (
        <div class="mt-2 flex flex-col items-center gap-3">
          <iframe
            src={embed()}
            loading="lazy"
            sandbox="allow-scripts allow-popups"
            referrerpolicy="strict-origin-when-cross-origin"
            title={`Pinterest board for ${props.eventName}`}
            width="100%"
            height="380"
            class="w-full rounded-sm border border-border bg-surface-raised"
          />
          <a
            href={props.url}
            target="_blank"
            rel="noopener noreferrer"
            class="font-body text-[0.78rem] uppercase tracking-[0.12em] text-gold hover:underline"
          >
            Open on Pinterest
          </a>
        </div>
      )}
    </Show>
  );
}
