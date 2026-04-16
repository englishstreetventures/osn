import { useAuth } from "@osn/client/solid";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Button } from "@osn/ui/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@osn/ui/ui/dialog";
import { Input } from "@osn/ui/ui/input";
import { Label } from "@osn/ui/ui/label";
import { Textarea } from "@osn/ui/ui/textarea";
import { A } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { orgClient } from "../lib/api";
import { safeAvatarUrl } from "../lib/utils";

export function OrganisationsPage() {
  const { session } = useAuth();
  const token = () => session()?.accessToken ?? "";

  const [orgs, { refetch }] = createResource(
    () => token() || false,
    (t) => orgClient.listMyOrgs(t as string),
  );

  const [showCreate, setShowCreate] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [handle, setHandle] = createSignal("");
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");

  async function handleCreate(e: Event) {
    e.preventDefault();
    if (!handle() || !name()) return;
    setCreating(true);
    try {
      await orgClient.createOrg(token(), {
        handle: handle(),
        name: name(),
        description: description() || undefined,
      });
      toast.success(`Created ${name()}`);
      setShowCreate(false);
      setHandle("");
      setName("");
      setDescription("");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create organisation");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main class="mx-auto w-full max-w-2xl px-8 py-8">
      <div class="mb-6 flex items-center justify-between">
        <div>
          <h1 class="text-foreground text-xl font-semibold tracking-tight">Organisations</h1>
          <p class="text-muted-foreground mt-1 text-sm">Groups and teams you belong to.</p>
        </div>
        <Show when={session()}>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            Create
          </Button>
        </Show>
      </div>

      <Show
        when={session()}
        fallback={
          <div class="text-muted-foreground border-border rounded-lg border border-dashed py-16 text-center text-sm">
            Sign in to view your organisations.
          </div>
        }
      >
        <Show
          when={!orgs.loading}
          fallback={
            <div class="flex flex-col gap-2">
              {Array.from({ length: 2 }, () => (
                <div class="bg-muted/50 h-20 animate-pulse rounded-lg" />
              ))}
            </div>
          }
        >
          <Show
            when={(orgs()?.organisations.length ?? 0) > 0}
            fallback={
              <div class="text-muted-foreground border-border rounded-lg border border-dashed py-16 text-center text-sm">
                You're not part of any organisations yet.
              </div>
            }
          >
            <div class="flex flex-col gap-2">
              <For each={orgs()?.organisations}>
                {(org) => (
                  <A
                    href={`/organisations/${org.id}`}
                    class="border-border hover:bg-muted/30 flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors"
                  >
                    <Avatar class="h-10 w-10">
                      <Show when={safeAvatarUrl(org.avatarUrl)}>
                        {(url) => (
                          <AvatarImage
                            src={url()}
                            alt={org.name}
                            referrerpolicy="no-referrer"
                            loading="lazy"
                          />
                        )}
                      </Show>
                      <AvatarFallback class="text-xs">
                        {org.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div class="min-w-0 flex-1">
                      <p class="text-foreground text-sm font-medium">{org.name}</p>
                      <p class="text-muted-foreground text-xs">@{org.handle}</p>
                    </div>
                    <Show when={org.description}>
                      <p class="text-muted-foreground hidden max-w-48 truncate text-xs sm:block">
                        {org.description}
                      </p>
                    </Show>
                    <svg
                      class="text-muted-foreground h-4 w-4 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </A>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      {/* Create org dialog */}
      <Dialog open={showCreate()} onOpenChange={setShowCreate}>
        <DialogContent class="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create organisation</DialogTitle>
          </DialogHeader>
          <form class="flex flex-col gap-4 pt-2" onSubmit={handleCreate}>
            <div class="flex flex-col gap-1.5">
              <Label for="org-handle">Handle</Label>
              <Input
                id="org-handle"
                placeholder="my-org"
                value={handle()}
                onInput={(e) =>
                  setHandle(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
                }
                required
              />
              <p class="text-muted-foreground text-[11px]">
                Lowercase letters, numbers, and underscores only.
              </p>
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="org-name">Name</Label>
              <Input
                id="org-name"
                placeholder="My Organisation"
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                required
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label for="org-desc">Description</Label>
              <Textarea
                id="org-desc"
                placeholder="What's this organisation about?"
                value={description()}
                onInput={(e) => setDescription(e.currentTarget.value)}
                rows={2}
              />
            </div>
            <div class="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={creating() || !handle() || !name()}>
                {creating() ? "Creating..." : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
