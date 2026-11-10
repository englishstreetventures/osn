import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@shared/ui/ui/dialog";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Textarea } from "@shared/ui/ui/textarea";
import { A } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";

import { EmptyNote } from "../components/EmptyNote";
import { ResponsiveDialogContent } from "../components/ResponsiveDialogContent";
import { SignedOutNote } from "../components/SignedOutNote";
import { orgClient } from "../lib/api";
import { usePageTitle } from "../lib/page-title";
import { safeAvatarUrl } from "../lib/utils";

export function OrganisationsPage() {
  const { session } = useAuth();
  usePageTitle(() => "Organisations");

  // Keyed on the session object: a new session refetches, a token renewal does not.
  const [orgs, { refetch }] = createResource(
    () => session() ?? false,
    () => orgClient.listMyOrgs(),
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
      await orgClient.createOrg({
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
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <div class="mb-6 flex items-center justify-between">
        <div>
          <h1 class="text-foreground text-display font-medium">Organisations</h1>
          <p class="text-muted-foreground text-body mt-1">Groups and teams you belong to.</p>
        </div>
        <Show when={session()}>
          <Button size="sm" class="max-md:h-10" onClick={() => setShowCreate(true)}>
            Create
          </Button>
        </Show>
      </div>

      <Show
        when={session()}
        fallback={<SignedOutNote>Sign in to view your organisations.</SignedOutNote>}
      >
        <Show
          when={!orgs.loading}
          fallback={
            <div class="flex flex-col gap-2">
              {Array.from({ length: 2 }, () => (
                <div class="bg-muted/50 rounded-card h-18.5 animate-pulse" />
              ))}
            </div>
          }
        >
          <Show
            when={(orgs()?.organisations.length ?? 0) > 0}
            fallback={<EmptyNote>You're not part of any organisations yet.</EmptyNote>}
          >
            <div class="flex flex-col gap-2">
              <For each={orgs()?.organisations}>
                {(org) => (
                  <A
                    // Handle, not id: the public `orgProjection` never returns
                    // an id, so this interpolated `undefined` and every row
                    // linked to a 404. `GET /organisations/:handle` is what the
                    // detail route actually resolves.
                    href={`/organisations/${org.handle}`}
                    class="group rounded-card block"
                  >
                    {/* A card that is a link. `Card` owns its fill, so the row
                        takes no wash: its chevron turns to full ink on hover
                        and press instead. */}
                    <Card padding="sm" class="flex items-center gap-3">
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
                        <AvatarFallback>{org.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div class="min-w-0 flex-1">
                        <p class="text-foreground text-title truncate font-medium">{org.name}</p>
                        <p class="text-muted-foreground text-meta truncate">@{org.handle}</p>
                      </div>
                      <Show when={org.description}>
                        <p class="text-muted-foreground text-meta hidden max-w-48 truncate md:block">
                          {org.description}
                        </p>
                      </Show>
                      <svg
                        class="text-subtle group-hover:text-foreground group-active:text-foreground transition-ui-colors h-5 w-5 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </Card>
                  </A>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>

      {/* Create org dialog */}
      <Dialog open={showCreate()} onOpenChange={setShowCreate}>
        <ResponsiveDialogContent>
          <DialogHeader>
            <DialogTitle>Create organisation</DialogTitle>
          </DialogHeader>
          {/* The footer sits inside the form, so Enter in a field still submits. */}
          <form onSubmit={handleCreate}>
            <div class="flex flex-col gap-4 p-4">
              <div class="flex flex-col gap-1.5">
                <Label for="org-handle">Handle</Label>
                <Input
                  id="org-handle"
                  aria-describedby="org-handle-hint"
                  placeholder="my_org"
                  value={handle()}
                  onInput={(e) =>
                    setHandle(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))
                  }
                  required
                />
                <p id="org-handle-hint" class="text-muted-foreground text-meta">
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
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                class="max-md:h-10"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                class="max-md:h-10"
                disabled={creating() || !handle() || !name()}
              >
                {creating() ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </ResponsiveDialogContent>
      </Dialog>
    </main>
  );
}
