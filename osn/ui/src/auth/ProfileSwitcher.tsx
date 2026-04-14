import type { PublicProfile } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { Avatar, AvatarFallback, AvatarImage } from "../components/ui/avatar";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { clsx } from "../lib/utils";
import { CreateProfileForm } from "./CreateProfileForm";

export interface ProfileSwitcherProps {
  checkHandle?: (handle: string) => Promise<{ available: boolean }>;
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

  const activeProfile = () => profiles()?.find((p) => p.id === activeProfileId()) ?? null;

  async function handleSwitch(profile: PublicProfile) {
    if (busy() || profile.id === activeProfileId()) return;
    setBusy(true);
    try {
      const result = await switchProfile(profile.id);
      setOpen(false);
      toast.success(`Switched to @${result.profile.handle}`);
      props.onSwitch?.(result.profile);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch profile");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const profile = confirmDelete();
    if (!profile || busy()) return;
    setBusy(true);
    try {
      await deleteProfile(profile.id);
      setConfirmDelete(null);
      toast.success(`Profile @${profile.handle} deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete profile");
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
      <Popover open={open()} onOpenChange={setOpen}>
        <PopoverTrigger as={Button} variant="ghost" size="sm" class="flex items-center gap-1.5">
          <Avatar class="h-5 w-5">
            <Show when={activeProfile()?.avatarUrl}>
              {(url) => <AvatarImage src={url()} alt={activeProfile()!.handle} />}
            </Show>
            <AvatarFallback>{activeProfile() ? initials(activeProfile()!) : "?"}</AvatarFallback>
          </Avatar>
          <span class="text-xs">@{activeProfile()?.handle ?? "..."}</span>
        </PopoverTrigger>
        <PopoverContent class="w-56 p-0">
          <div class="border-border border-b px-3 py-2">
            <p class="text-foreground text-xs font-semibold">Profiles</p>
          </div>
          <div class="flex flex-col py-1">
            <For each={profiles() ?? []}>
              {(profile) => {
                const isActive = () => profile.id === activeProfileId();
                return (
                  <button
                    type="button"
                    class={clsx(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                      isActive()
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted text-foreground",
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
                      <span class="text-primary text-[10px]" aria-label="Active profile">
                        &#10003;
                      </span>
                    </Show>
                    <Show when={!isActive()}>
                      <button
                        type="button"
                        class="text-muted-foreground hover:text-destructive ml-auto text-[10px]"
                        aria-label={`Delete profile @${profile.handle}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(profile);
                        }}
                      >
                        &#10005;
                      </button>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
          <div class="border-border border-t px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              class="w-full text-xs"
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
      <Dialog open={confirmDelete() !== null} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete profile</DialogTitle>
          </DialogHeader>
          <div class="p-4">
            <p class="text-muted-foreground text-sm">
              Permanently delete <strong>@{confirmDelete()?.handle}</strong>? This cannot be undone.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDelete(null)}
              disabled={busy()}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={busy()}>
              {busy() ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
