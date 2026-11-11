import { describeAuthError, type PublicProfile } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { clsx } from "@shared/ui/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@shared/ui/ui/dialog";
import { Notice } from "@shared/ui/ui/notice";
import { Popover, PopoverContent, PopoverTrigger } from "@shared/ui/ui/popover";
import { createSignal, For, Show } from "solid-js";

import { CreateProfileForm } from "./CreateProfileForm";

export interface ProfileSwitcherProps {
  checkHandle?: (handle: string, signal?: AbortSignal) => Promise<{ available: boolean }>;
  onSwitch?: (profile: PublicProfile) => void;
  onCreate?: (profile: PublicProfile) => void;
}

function initials(profile: PublicProfile): string {
  const name = profile.displayName || profile.handle;
  return name.slice(0, 2).toUpperCase();
}

export function ProfileSwitcher(props: ProfileSwitcherProps) {
  const { profiles, activeProfileId, switchProfile, deleteProfile } = useAuth();

  const [open, setOpen] = createSignal(false);
  const [showCreate, setShowCreate] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal<PublicProfile | null>(null);
  const [busy, setBusy] = createSignal(false);
  // Each failure stays where its action is: a switch in the popover, a
  // delete in its dialog. Errors are lines, never toasts.
  const [switchError, setSwitchError] = createSignal<string | null>(null);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  const activeProfile = () => profiles()?.find((p) => p.id === activeProfileId()) ?? null;

  async function handleSwitch(profile: PublicProfile) {
    if (busy() || profile.id === activeProfileId()) return;
    setBusy(true);
    setSwitchError(null);
    try {
      const result = await switchProfile(profile.id);
      setOpen(false);
      toast.success(`Switched to @${result.profile.handle}`);
      props.onSwitch?.(result.profile);
    } catch (err) {
      setSwitchError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const profile = confirmDelete();
    if (!profile || busy()) return;
    setBusy(true);
    setDeleteError(null);
    try {
      await deleteProfile(profile.id);
      setConfirmDelete(null);
      toast.success(`Profile @${profile.handle} deleted`);
    } catch (err) {
      setDeleteError(describeAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  function handleCreateSuccess(profile: { id: string; handle: string }) {
    setShowCreate(false);
    props.onCreate?.(profile as PublicProfile);
  }

  return (
    <>
      <Popover
        open={open()}
        onOpenChange={(next) => {
          setSwitchError(null);
          setOpen(next);
        }}
      >
        <PopoverTrigger as={Button} variant="ghost" size="sm" class="flex items-center gap-1.5">
          <Avatar class="h-5 w-5">
            <Show when={activeProfile()?.avatarUrl}>
              {(url) => <AvatarImage src={url()} alt={activeProfile()!.handle} />}
            </Show>
            <AvatarFallback>{activeProfile() ? initials(activeProfile()!) : "?"}</AvatarFallback>
          </Avatar>
          <span class="text-xs">@{activeProfile()?.handle ?? "…"}</span>
        </PopoverTrigger>
        <PopoverContent padding="none" class="w-56">
          <div class="border-border border-b px-3 py-2">
            <p class="text-foreground text-xs font-semibold">Profiles</p>
          </div>
          <Show when={switchError()}>
            {(msg) => (
              <div class="px-3 pt-2">
                <Notice tone="danger" size="inline" alert>
                  {msg()}
                </Notice>
              </div>
            )}
          </Show>
          <div class="flex flex-col py-1">
            <For each={profiles() ?? []}>
              {(profile) => {
                const isActive = () => profile.id === activeProfileId();
                // The delete sits beside the row's button, never inside it:
                // a button inside a button has no reliable name or keyboard
                // path.
                return (
                  <div
                    class={clsx(
                      "flex items-center",
                      isActive() ? "bg-accent text-accent-foreground" : "text-foreground",
                    )}
                  >
                    {/* The wash is the row button's alone, so the delete's
                        own wash shows beside it. */}
                    <button
                      type="button"
                      class={clsx(
                        "transition-ui-colors flex min-w-0 flex-1 items-center gap-2 self-stretch px-3 py-1.5 text-left text-xs",
                        !isActive() && "hover:bg-muted",
                      )}
                      aria-current={isActive() ? "true" : undefined}
                      disabled={busy()}
                      onClick={() => !isActive() && handleSwitch(profile)}
                    >
                      <Avatar class="h-5 w-5">
                        <Show when={profile.avatarUrl}>
                          {(url) => <AvatarImage src={url()} alt={profile.handle} />}
                        </Show>
                        <AvatarFallback>{initials(profile)}</AvatarFallback>
                      </Avatar>
                      <span class="flex-1 truncate">
                        @{profile.handle}
                        <Show when={profile.displayName}>
                          <span class="text-muted-foreground ml-1">({profile.displayName})</span>
                        </Show>
                      </span>
                      <Show when={isActive()}>
                        <span class="text-primary text-ui-xs" aria-label="Active profile">
                          &#10003;
                        </span>
                      </Show>
                    </button>
                    <Show when={!isActive()}>
                      <Button
                        variant="ghostDanger"
                        size="icon"
                        class="mr-1 h-7 w-7 shrink-0 max-md:h-10 max-md:w-10"
                        aria-label={`Delete profile @${profile.handle}`}
                        disabled={busy()}
                        onClick={() => setConfirmDelete(profile)}
                      >
                        &#10005;
                      </Button>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
          <div class="border-border border-t px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              class="w-full"
              onClick={() => {
                setOpen(false);
                setShowCreate(true);
              }}
            >
              + Add profile
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Create profile dialog */}
      <Dialog open={showCreate()} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a new profile</DialogTitle>
          </DialogHeader>
          <div class="p-4">
            <CreateProfileForm
              checkHandle={props.checkHandle}
              onSuccess={handleCreateSuccess}
              onCancel={() => setShowCreate(false)}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={confirmDelete() !== null}
        onOpenChange={(v) => {
          if (v) return;
          setConfirmDelete(null);
          setDeleteError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete profile</DialogTitle>
          </DialogHeader>
          <div class="p-4">
            <p class="text-muted-foreground text-sm">
              Permanently delete <strong>@{confirmDelete()?.handle}</strong>? This cannot be undone.
            </p>
            <Show when={deleteError()}>
              {(msg) => (
                <Notice tone="danger" size="inline" alert class="mt-3">
                  {msg()}
                </Notice>
              )}
            </Show>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setConfirmDelete(null);
                setDeleteError(null);
              }}
              disabled={busy()}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} busy={busy()}>
              {busy() ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
