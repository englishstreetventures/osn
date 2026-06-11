import { Button } from "@osn/ui/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogClose } from "@osn/ui/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@osn/ui/ui/popover";
import { createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { recordShareInvoked } from "../lib/rsvps";
import { withShareSource, type ShareSource } from "../lib/shareSource";
import { createIsMobile } from "../lib/useIsMobile";

interface Destination {
  id: ShareSource;
  label: string;
  /**
   * Async because some destinations need to await `navigator.clipboard`
   * or `navigator.share`. Returns true if the user-visible action
   * succeeded — false suppresses the success toast.
   */
  handle: (url: string, title: string) => Promise<boolean>;
}

const openIntent = (intentUrl: string) => {
  if (typeof window !== "undefined") {
    window.open(intentUrl, "_blank", "noopener,noreferrer");
  }
};

const copyToClipboard = async (text: string): Promise<boolean> => {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
};

const DESTINATIONS: Destination[] = [
  {
    id: "whatsapp",
    label: "WhatsApp",
    handle: async (url, title) => {
      openIntent(`https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`);
      return true;
    },
  },
  {
    id: "x",
    label: "X / Twitter",
    handle: async (url, title) => {
      openIntent(
        `https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}`,
      );
      return true;
    },
  },
  {
    id: "facebook",
    label: "Facebook",
    handle: async (url) => {
      openIntent(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`);
      return true;
    },
  },
  {
    id: "instagram",
    label: "Instagram",
    // Instagram has no public web share intent. Best we can do is copy
    // the link so the user can paste it into a DM / story sticker.
    handle: async (url) => {
      const ok = await copyToClipboard(url);
      if (ok) toast.success("Link copied — paste into Instagram");
      return ok;
    },
  },
  {
    id: "tiktok",
    label: "TikTok",
    // Same story as Instagram — no web share intent.
    handle: async (url) => {
      const ok = await copyToClipboard(url);
      if (ok) toast.success("Link copied — paste into TikTok");
      return ok;
    },
  },
  {
    id: "copy_link",
    label: "Copy link",
    handle: async (url) => {
      const ok = await copyToClipboard(url);
      if (ok) toast.success("Link copied");
      return ok;
    },
  },
  {
    id: "other",
    label: "More…",
    handle: async (url, title) => {
      // Use the OS share sheet when available (iOS / Android web).
      const nav = typeof navigator !== "undefined" ? navigator : null;
      if (nav?.share) {
        try {
          await nav.share({ url, title });
          return true;
        } catch {
          // User-cancelled or unsupported — fall through to copy.
        }
      }
      const ok = await copyToClipboard(url);
      if (ok) toast.success("Link copied");
      return ok;
    },
  },
];

interface ShareEventButtonProps {
  eventId: string;
  eventTitle: string;
  /**
   * Caller's access token, forwarded to the share telemetry ping so the
   * server's visibility gate can recognise an organiser sharing their
   * own private event. Optional — anonymous sharers pass null.
   */
  accessToken?: string | null;
}

/**
 * Share button for the event detail surface. On desktop renders a
 * Popover anchored to the trigger; on mobile renders a Dialog that
 * mimics the OS share sheet. The two layouts share a single grid of
 * destination buttons.
 *
 * URL handling: builds the canonical event URL from
 * `window.location.origin + /events/<id>` (NOT `window.location.href`)
 * so any `?source=` already on the inbound URL is dropped — re-shares
 * always carry the new sharer's chosen source, never the previous
 * sharer's. Each destination injects the source via `withShareSource`
 * before handing the URL to the platform intent.
 */
export function ShareEventButton(props: ShareEventButtonProps) {
  const isMobile = createIsMobile();
  const [open, setOpen] = createSignal(false);

  const baseUrl = () => {
    // `encodeURIComponent` guards against a future event-id schema (or a
    // mis-populated prop) injecting `?`, `#`, or `..` into the path and
    // shifting attribution onto a different event.
    const path = `/events/${encodeURIComponent(props.eventId)}`;
    if (typeof window === "undefined") return path;
    return `${window.location.origin}${path}`;
  };

  async function pick(dest: Destination) {
    const sourcedUrl = withShareSource(baseUrl(), dest.id);
    const ok = await dest.handle(sourcedUrl, props.eventTitle);
    if (ok) {
      // Telemetry is fire-and-forget — don't block the close on it.
      void recordShareInvoked(props.eventId, dest.id, props.accessToken ?? null);
    }
    setOpen(false);
  }

  const grid = (
    <div class="grid grid-cols-2 gap-2 p-2">
      <For each={DESTINATIONS}>
        {(dest) => (
          <button
            type="button"
            onClick={() => {
              void pick(dest);
            }}
            class="border-border/60 bg-card hover:bg-accent text-foreground rounded-md border px-3 py-2 text-left text-sm transition-colors"
          >
            {dest.label}
          </button>
        )}
      </For>
    </div>
  );

  return (
    <>
      <Show
        when={isMobile()}
        fallback={
          <Popover open={open()} onOpenChange={setOpen}>
            <PopoverTrigger
              aria-label="Share event"
              class="base:bg-secondary base:text-secondary-foreground base:hover:bg-secondary/80 base:inline-flex base:h-8 base:cursor-pointer base:items-center base:justify-center base:rounded-md base:px-3 base:text-xs base:font-medium"
            >
              Share
            </PopoverTrigger>
            <PopoverContent class="base:w-72 base:p-0">{grid}</PopoverContent>
          </Popover>
        }
      >
        <Button
          variant="secondary"
          size="sm"
          aria-label="Share event"
          onClick={() => setOpen(true)}
        >
          Share
        </Button>
        <Dialog
          open={open()}
          onOpenChange={(o) => {
            if (!o) setOpen(false);
          }}
        >
          <DialogContent class="base:w-full base:max-w-md base:rounded-t-xl base:rounded-b-none base:top-auto base:bottom-0 base:translate-y-0 base:left-1/2 base:-translate-x-1/2">
            <DialogHeader>
              <DialogTitle>Share event</DialogTitle>
              <DialogClose
                aria-label="Close"
                class="text-muted-foreground hover:text-foreground text-xl leading-none"
              >
                ×
              </DialogClose>
            </DialogHeader>
            {grid}
          </DialogContent>
        </Dialog>
      </Show>
    </>
  );
}
