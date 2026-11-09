import { describeAuthError, OrgClientError, type OrgMember } from "@osn/client";
import { useAuth } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import { Chip } from "@shared/ui/ui/chip";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@shared/ui/ui/dialog";
import { Input } from "@shared/ui/ui/input";
import { Label } from "@shared/ui/ui/label";
import { Notice } from "@shared/ui/ui/notice";
import { Textarea } from "@shared/ui/ui/textarea";
import { useParams, useNavigate } from "@solidjs/router";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { EmptyNote } from "../components/EmptyNote";
import { ResponsiveDialogContent } from "../components/ResponsiveDialogContent";
import { orgClient } from "../lib/api";
import { usePageTitle } from "../lib/page-title";
import { safeAvatarUrl } from "../lib/utils";

/** A member's role as the roster shows it: a label set as written, so in sentence case. */
const ROLE_LABEL = {
  admin: "Admin",
  member: "Member",
} satisfies Record<OrgMember["role"], string>;

/** The HTTP status a failed request carried, when it got as far as a response. */
function statusOf(error: unknown): number | undefined {
  return error instanceof OrgClientError ? error.status : undefined;
}

/** A load that failed for a reason other than the ones the page names. */
function LoadFailure(props: { message: string }) {
  return (
    <Notice tone="danger" size="inline" alert>
      {props.message} Reload and try again.
    </Notice>
  );
}

export function OrgDetailPage() {
  const params = useParams<{ handle: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();

  // One memoised key for both resources, so they refetch together and only
  // when the session object or the handle changes. The memo holds its object
  // until one of the two does; a fresh object per read would refetch on every
  // tick. Keyed on the session, not its token: a silent token renewal does not
  // replace the session object, so it refetches nothing.
  const resourceKey = createMemo(() => {
    const current = session();
    const handle = params.handle;
    return current && handle ? { session: current, handle } : false;
  });

  const [org, { mutate: setOrg }] = createResource(
    resourceKey,
    async (key) => (await orgClient.getOrg(key.handle)).organisation,
  );

  const [members, { mutate: setMembers }] = createResource(resourceKey, (key) =>
    orgClient.listMembers(key.handle),
  );

  // What shows is chosen by `state`, never by `.error`: Solid keeps a failed
  // load's error until the next load finishes, and the page stays mounted when
  // only the handle changes, so `.error` can belong to the organisation before.
  // Solid also throws when a failed resource is read, so values are read only
  // in the `ready` state. A roster read by a non-member answers 403: the
  // organisation is public, its member list is not.
  const orgReady = () => (org.state === "ready" ? org() : undefined);
  const memberRows = () => (members.state === "ready" ? members()?.members : undefined);
  // The page's `h1`: the organisation's name, or the section's while it loads
  // or when it could not be loaded.
  usePageTitle(() => orgReady()?.name ?? "Organisations");

  const [showEdit, setShowEdit] = createSignal(false);
  const [editName, setEditName] = createSignal("");
  const [editDesc, setEditDesc] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  function openEdit() {
    const o = orgReady();
    if (o) {
      setEditName(o.name);
      setEditDesc(o.description ?? "");
      setShowEdit(true);
    }
  }

  async function handleSave(e: Event) {
    e.preventDefault();
    setSaving(true);
    try {
      const { organisation } = await orgClient.updateOrg(params.handle, {
        name: editName(),
        description: editDesc() || undefined,
      });
      toast.success("Organisation updated");
      setShowEdit(false);
      setOrg(organisation);
    } catch (err) {
      toast.error(`Couldn't save the organisation. ${describeAuthError(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this organisation? This cannot be undone.")) return;
    try {
      await orgClient.deleteOrg(params.handle);
      toast.success("Organisation deleted");
      navigate("/organisations");
    } catch (err) {
      toast.error(`Couldn't delete the organisation. ${describeAuthError(err)}`);
    }
  }

  async function removeMember(profileHandle: string) {
    try {
      await orgClient.removeMember(params.handle, profileHandle);
      toast.success(`Removed @${profileHandle}`);
      setMembers(
        (roster) =>
          roster && { members: roster.members.filter((member) => member.handle !== profileHandle) },
      );
    } catch (err) {
      toast.error(`Couldn't remove @${profileHandle}. ${describeAuthError(err)}`);
    }
  }

  return (
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <Show
        when={orgReady()}
        fallback={
          <Show
            when={org.state === "errored"}
            fallback={
              <div class="flex flex-col gap-3">
                <div class="bg-muted/50 h-8 w-48 animate-pulse rounded-lg" />
                <div class="bg-muted/50 h-5 w-64 animate-pulse rounded-lg" />
              </div>
            }
          >
            {/* No organisation to title the page: the section's own head. */}
            <h1 class="text-foreground text-display mb-6 font-medium">Organisations</h1>
            <Show
              when={statusOf(org.error) === 404}
              fallback={<LoadFailure message="This organisation could not be loaded." />}
            >
              <EmptyNote>Organisation not found.</EmptyNote>
            </Show>
          </Show>
        }
      >
        {(orgData) => (
          <>
            {/* Header */}
            <div class="mb-8 flex flex-wrap items-start justify-between gap-3">
              <div class="flex items-center gap-4">
                <Avatar class="h-14 w-14">
                  <Show when={safeAvatarUrl(orgData().avatarUrl)}>
                    {(url) => (
                      <AvatarImage
                        src={url()}
                        alt={orgData().name}
                        referrerpolicy="no-referrer"
                        loading="lazy"
                      />
                    )}
                  </Show>
                  <AvatarFallback>{orgData().name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div>
                  <h1 class="text-foreground text-display font-medium">{orgData().name}</h1>
                  <p class="text-muted-foreground text-body">@{orgData().handle}</p>
                  <Show when={orgData().description}>
                    <p class="text-muted-foreground text-body mt-1">{orgData().description}</p>
                  </Show>
                </div>
              </div>
              <div class="flex gap-1.5">
                <Button variant="secondary" size="sm" class="max-md:h-10" onClick={openEdit}>
                  Edit
                </Button>
                <Button variant="ghostDanger" size="sm" class="max-md:h-10" onClick={handleDelete}>
                  Delete
                </Button>
              </div>
            </div>

            {/* Members */}
            <div>
              <div class="mb-3 flex items-center justify-between">
                <h2 class="text-foreground text-title font-medium">Members</h2>
              </div>
              <Show
                when={members.state !== "errored"}
                fallback={
                  <Show
                    when={statusOf(members.error) === 403}
                    fallback={<LoadFailure message="Members could not be loaded." />}
                  >
                    <EmptyNote size="section">
                      Only members can see who belongs to this organisation.
                    </EmptyNote>
                  </Show>
                }
              >
                <Show
                  when={members.state === "ready"}
                  fallback={
                    <div class="flex flex-col gap-2">
                      {Array.from({ length: 2 }, () => (
                        <div class="bg-muted/50 h-12 animate-pulse rounded-lg" />
                      ))}
                    </div>
                  }
                >
                  <div class="flex flex-col gap-1">
                    <For each={memberRows()}>
                      {(member) => (
                        <div class="hover:bg-muted/50 active:bg-muted/50 transition-ui-colors flex items-center gap-3 rounded-lg px-3 py-2.5">
                          {/* Initials only: a roster row carries no avatar. */}
                          <Avatar class="h-8 w-8">
                            <AvatarFallback>
                              {member.handle.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div class="min-w-0 flex-1">
                            <p class="text-foreground text-title truncate font-medium">
                              {member.displayName || `@${member.handle}`}
                            </p>
                            <Show when={member.displayName}>
                              <p class="text-muted-foreground text-meta truncate">
                                @{member.handle}
                              </p>
                            </Show>
                          </div>
                          <Chip variant="outline" treatment="tag">
                            {ROLE_LABEL[member.role]}
                          </Chip>
                          <Show when={member.role !== "admin"}>
                            <Button
                              variant="ghost"
                              size="sm"
                              class="h-7 max-md:h-10"
                              aria-label={`Remove @${member.handle}`}
                              onClick={() => removeMember(member.handle)}
                            >
                              Remove
                            </Button>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </div>
          </>
        )}
      </Show>

      {/* Edit dialog */}
      <Dialog open={showEdit()} onOpenChange={setShowEdit}>
        <ResponsiveDialogContent>
          <DialogHeader>
            <DialogTitle>Edit organisation</DialogTitle>
          </DialogHeader>
          {/* The footer sits inside the form, so Enter in a field still submits. */}
          <form onSubmit={handleSave}>
            <div class="flex flex-col gap-4 p-4">
              <div class="flex flex-col gap-1.5">
                <Label for="edit-name">Name</Label>
                <Input
                  id="edit-name"
                  value={editName()}
                  onInput={(e) => setEditName(e.currentTarget.value)}
                  required
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label for="edit-desc">Description</Label>
                <Textarea
                  id="edit-desc"
                  value={editDesc()}
                  onInput={(e) => setEditDesc(e.currentTarget.value)}
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
                onClick={() => setShowEdit(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" class="max-md:h-10" disabled={saving()}>
                {saving() ? "Saving..." : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </ResponsiveDialogContent>
      </Dialog>
    </main>
  );
}
