import { useAuth } from "@osn/client/solid";
import { Avatar, AvatarFallback, AvatarImage } from "@osn/ui/ui/avatar";
import { Badge } from "@osn/ui/ui/badge";
import { Button } from "@osn/ui/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@osn/ui/ui/dialog";
import { Input } from "@osn/ui/ui/input";
import { Label } from "@osn/ui/ui/label";
import { Textarea } from "@osn/ui/ui/textarea";
import { useParams, useNavigate } from "@solidjs/router";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import { orgClient } from "../lib/api";
import { safeAvatarUrl } from "../lib/utils";

export function OrgDetailPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { session } = useAuth();
  const token = () => session()?.accessToken ?? "";

  // Stable memoised source key (P-W4). Returning a fresh object per read
  // makes Solid's === equality check always fail, triggering a refetch
  // on every signal tick. A string key is referentially stable per
  // (token, id) pair so the resource only refetches when one changes.
  const resourceKey = createMemo(() => {
    const t = token();
    const id = params.id;
    return t && id ? `${t}|${id}` : false;
  });

  const parseKey = (key: string): { token: string; id: string } => {
    const sep = key.indexOf("|");
    return { token: key.slice(0, sep), id: key.slice(sep + 1) };
  };

  const [org, { refetch: refetchOrg }] = createResource(resourceKey, (key) => {
    const { token, id } = parseKey(key as string);
    return orgClient.getOrg(token, id);
  });

  const [members, { refetch: refetchMembers }] = createResource(resourceKey, (key) => {
    const { token, id } = parseKey(key as string);
    return orgClient.listMembers(token, id);
  });

  const [showEdit, setShowEdit] = createSignal(false);
  const [editName, setEditName] = createSignal("");
  const [editDesc, setEditDesc] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  function openEdit() {
    const o = org();
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
      await orgClient.updateOrg(token(), params.id, {
        name: editName(),
        description: editDesc() || undefined,
      });
      toast.success("Organisation updated");
      setShowEdit(false);
      refetchOrg();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this organisation? This cannot be undone.")) return;
    try {
      await orgClient.deleteOrg(token(), params.id);
      toast.success("Organisation deleted");
      navigate("/organisations");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function removeMember(profileId: string, handle: string) {
    try {
      await orgClient.removeMember(token(), params.id, profileId);
      toast.success(`Removed @${handle}`);
      refetchMembers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  return (
    <main class="mx-auto w-full max-w-2xl px-8 py-8">
      <Show
        when={!org.loading && org()}
        fallback={
          <div class="flex flex-col gap-3">
            <div class="bg-muted/50 h-8 w-48 animate-pulse rounded" />
            <div class="bg-muted/50 h-5 w-64 animate-pulse rounded" />
          </div>
        }
      >
        {(orgData) => (
          <>
            {/* Header */}
            <div class="mb-8 flex items-start justify-between">
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
                  <h1 class="text-foreground text-xl font-semibold tracking-tight">
                    {orgData().name}
                  </h1>
                  <p class="text-muted-foreground text-sm">@{orgData().handle}</p>
                  <Show when={orgData().description}>
                    <p class="text-muted-foreground mt-1 text-sm">{orgData().description}</p>
                  </Show>
                </div>
              </div>
              <div class="flex gap-1.5">
                <Button variant="secondary" size="sm" onClick={openEdit}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" class="text-destructive" onClick={handleDelete}>
                  Delete
                </Button>
              </div>
            </div>

            {/* Members */}
            <div>
              <div class="mb-3 flex items-center justify-between">
                <h2 class="text-foreground text-sm font-semibold">Members</h2>
              </div>
              <Show
                when={!members.loading}
                fallback={
                  <div class="flex flex-col gap-2">
                    {Array.from({ length: 2 }, () => (
                      <div class="bg-muted/50 h-12 animate-pulse rounded-lg" />
                    ))}
                  </div>
                }
              >
                <div class="flex flex-col gap-1">
                  <For each={members()?.members}>
                    {(member) => (
                      <div class="hover:bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors">
                        <Avatar class="h-8 w-8">
                          <Show when={safeAvatarUrl(member.profile.avatarUrl)}>
                            {(url) => (
                              <AvatarImage
                                src={url()}
                                alt={member.profile.handle}
                                referrerpolicy="no-referrer"
                                loading="lazy"
                              />
                            )}
                          </Show>
                          <AvatarFallback class="text-[10px]">
                            {member.profile.handle.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div class="min-w-0 flex-1">
                          <p class="text-foreground text-sm font-medium">
                            {member.profile.displayName || `@${member.profile.handle}`}
                          </p>
                          <Show when={member.profile.displayName}>
                            <p class="text-muted-foreground text-xs">@{member.profile.handle}</p>
                          </Show>
                        </div>
                        <Badge variant="secondary" class="text-[11px]">
                          {member.role}
                        </Badge>
                        <Show when={member.role !== "admin"}>
                          <Button
                            variant="ghost"
                            size="sm"
                            class="text-muted-foreground h-7 text-xs"
                            onClick={() => removeMember(member.profile.id, member.profile.handle)}
                          >
                            Remove
                          </Button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>

      {/* Edit dialog */}
      <Dialog open={showEdit()} onOpenChange={setShowEdit}>
        <DialogContent class="max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit organisation</DialogTitle>
          </DialogHeader>
          <form class="flex flex-col gap-4 pt-2" onSubmit={handleSave}>
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
            <div class="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setShowEdit(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={saving()}>
                {saving() ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
