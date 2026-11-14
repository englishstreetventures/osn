import { AuthHeader } from "@osn/auth-ui/AuthHeader";
import { DialogActions } from "@osn/auth-ui/DialogActions";
import type { PublicProfile } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { clsx } from "@shared/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Dialog } from "@shared/ui/ui/dialog";
import { createSignal, For, Show } from "solid-js";

import { profileInitials, safeAvatarUrl } from "../lib/utils";
import { ResponsiveDialogContent } from "./ResponsiveDialogContent";

/**
 * The profile-switcher dialog, mounted once through `ShellDialogSet` above
 * the desktop/phone shell switch. Owns the switch mutation; the caller only
 * controls visibility.
 */
export function ProfileSwitcherDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes as the dialog closes; see `ResponsiveDialogContent`. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { profiles, activeProfileId, switchProfile } = useAuth();
  const [switching, setSwitching] = createSignal(false);

  async function handleSwitch(profile: PublicProfile) {
    if (switching() || profile.id === activeProfileId()) return;
    setSwitching(true);
    try {
      const result = await switchProfile(profile.id);
      props.onOpenChange(false);
      toast.success(`Switched to @${result.profile.handle}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch profile");
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      // Escape and a press outside close it, as Cancel does — but never while
      // a switch runs, since Cancel is disabled then too.
      onOpenChange={(open) => {
        if (!open && switching()) return;
        props.onOpenChange(open);
      }}
    >
      <ResponsiveDialogContent width="xs" onCloseAutoFocus={props.onCloseAutoFocus}>
        <AuthHeader host="dialog" title="Switch profile" />
        <div class="flex flex-col gap-1 py-2">
          <For each={profiles() ?? []}>
            {(profile) => {
              const active = () => profile.id === activeProfileId();
              // The rows run to the dialog's edges, and below `md` the sheet
              // scrolls, which clips anything drawn outside a row: the focus
              // ring sits inside it. Their text sits 16px in, as the body's does.
              return (
                <button
                  type="button"
                  aria-current={active() ? "true" : undefined}
                  class={clsx(
                    "text-body active:bg-muted flex w-full items-center gap-2.5 rounded-lg px-4 py-2 text-left transition-ui-colors focus-visible:-outline-offset-2 max-md:min-h-11",
                    active() ? "bg-muted text-foreground" : "hover:bg-muted/60 text-foreground",
                  )}
                  disabled={switching()}
                  onClick={() => handleSwitch(profile)}
                >
                  <Avatar class="h-7 w-7">
                    <Show when={safeAvatarUrl(profile.avatarUrl)}>
                      {(url) => (
                        <AvatarImage
                          src={url()}
                          alt={profile.handle}
                          referrerpolicy="no-referrer"
                          loading="lazy"
                        />
                      )}
                    </Show>
                    <AvatarFallback>{profileInitials(profile)}</AvatarFallback>
                  </Avatar>
                  <span class="flex-1 truncate">
                    @{profile.handle}
                    <Show when={profile.displayName}>
                      <span class="text-muted-foreground text-meta ml-1">
                        ({profile.displayName})
                      </span>
                    </Show>
                  </span>
                  <Show when={active()}>
                    <span class="text-foreground text-meta" aria-hidden="true">
                      &#10003;
                    </span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
        {/* The rows are the choice, so the footer holds Cancel alone, after
            them: the first row keeps first focus. */}
        <DialogActions onCancel={() => props.onOpenChange(false)} cancelDisabled={switching()} />
      </ResponsiveDialogContent>
    </Dialog>
  );
}
