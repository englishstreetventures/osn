import { describeAuthError, OrgClientError, type OrgMember } from "@osn/client";
import { toast } from "@shared/toast";
import { Avatar, AvatarFallback, AvatarImage } from "@shared/ui/ui/avatar";
import { Button } from "@shared/ui/ui/button";
import { Chip } from "@shared/ui/ui/chip";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@shared/ui/ui/dialog";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { Skeleton } from "@shared/ui/ui/skeleton";
import { Textarea } from "@shared/ui/ui/textarea";
import { useParams, useNavigate } from "@solidjs/router";
import { createSignal, For, Show } from "solid-js";

import { EmptyNote } from "../components/EmptyNote";
import { ResponsiveDialogContent } from "../components/ResponsiveDialogContent";
import { ResponsiveSkeleton } from "../components/ResponsiveSkeleton";
import { orgClient } from "../lib/api";
import { scopeMark } from "../lib/page-cache";
import {
  myOrganisations,
  organisationDetail,
  organisationMembers,
  suggestions,
} from "../lib/page-data";
import { usePageTitle } from "../lib/page-title";
import { createRowActions } from "../lib/row-actions";
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

/** The route's preload: the organisation and its roster. */
export function preloadOrganisation(handle: string): void {
  organisationDetail.preload(handle);
  organisationMembers.preload(handle);
}

export function OrgDetailPage() {
  const params = useParams<{ handle: string }>();
  const navigate = useNavigate();

  // Both through the page cache, by handle: an organisation shown again draws
  // at once and is read again behind it. The page stays mounted when only the
  // handle changes; each handle has its own entry, so a state or an error
  // never belongs to the organisation before.
  const handleArgs = (): [string] | undefined => (params.handle ? [params.handle] : undefined);
  const org = organisationDetail.use(handleArgs);
  const members = organisationMembers.use(handleArgs);

  // What shows is chosen by `state`: a failed read throws when read, so values
  // are read only once one has landed. A roster read by a non-member answers
  // 403: the organisation is public, its member list is not.
  const landed = (state: string) => state === "ready" || state === "refreshing";
  const orgReady = () => (landed(org.state) ? org() : undefined);
  const memberRows = () => (landed(members.state) ? members()?.members : undefined);
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
    if (saving()) return;
    setSaving(true);
    const handle = params.handle;
    try {
      const mark = scopeMark();
      const { organisation } = await orgClient.updateOrg(handle, {
        name: editName(),
        description: editDesc() || undefined,
      });
      toast.success("Organisation updated");
      setShowEdit(false);
      organisationDetail.update([handle], () => organisation, mark);
      // The list shows the new name at once and reads itself again when next shown.
      myOrganisations.update(
        [],
        (value) => ({
          ...value,
          organisations: value.organisations.map((o) => (o.handle === handle ? organisation : o)),
        }),
        mark,
      );
      myOrganisations.invalidate();
    } catch (err) {
      toast.error(`Couldn't save the organisation. ${describeAuthError(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this organisation? This cannot be undone.")) return;
    const handle = params.handle;
    try {
      const mark = scopeMark();
      await orgClient.deleteOrg(handle);
      toast.success("Organisation deleted");
      navigate("/organisations");
      // Gone from the list at once; a link back to it is a first load, which
      // answers that it is not found.
      organisationDetail.drop(handle);
      organisationMembers.drop(handle);
      myOrganisations.update(
        [],
        (value) => ({
          ...value,
          organisations: value.organisations.filter((o) => o.handle !== handle),
        }),
        mark,
      );
      myOrganisations.invalidate();
      suggestions.invalidate();
    } catch (err) {
      toast.error(`Couldn't delete the organisation. ${describeAuthError(err)}`);
    }
  }

  const actions = createRowActions();

  function removeMember(profileHandle: string) {
    const handle = params.handle;
    return actions.run(
      `remove:${profileHandle}`,
      members,
      (roster) => roster.members.some((member) => member.handle === profileHandle),
      async (mark) => {
        try {
          await orgClient.removeMember(handle, profileHandle);
          toast.success(`Removed @${profileHandle}`);
          organisationMembers.update(
            [handle],
            (roster) => ({
              ...roster,
              members: roster.members.filter((member) => member.handle !== profileHandle),
            }),
            mark,
          );
          suggestions.invalidate();
        } catch (err) {
          toast.error(`Couldn't remove @${profileHandle}. ${describeAuthError(err)}`);
        }
      },
    );
  }

  return (
    <main class="mx-auto w-full max-w-2xl px-4 py-6 md:px-8 md:py-8">
      <div aria-busy={org.busy || undefined}>
        <Show
          when={orgReady()}
          fallback={
            <Show
              when={org.state === "errored"}
              fallback={
                <div class="flex flex-col gap-3">
                  <Skeleton standsFor="line" width={48} height={8} />
                  <Skeleton standsFor="line" width={64} height={5} />
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
                  <Button
                    variant="ghostDanger"
                    size="sm"
                    class="max-md:h-10"
                    onClick={handleDelete}
                  >
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
                  <div aria-busy={members.busy || undefined}>
                    <Show
                      when={memberRows()}
                      fallback={
                        // As many rows as the last roster landed, one when
                        // nothing is known. A member row with Remove: 56px,
                        // and 60px below `md`, where the button takes the
                        // touch height. An admin's row has no Remove, and is
                        // 56px at both widths.
                        <div class="flex flex-col gap-1">
                          {Array.from({ length: members.rows }, () => (
                            <ResponsiveSkeleton height={14} phoneHeight={15} />
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
                                  variant="ghostDanger"
                                  size="sm"
                                  class="h-7 max-md:h-10"
                                  aria-label={`${actions.busy(`remove:${member.handle}`) ? "Removing" : "Remove"} @${member.handle}`}
                                  busy={actions.busy(`remove:${member.handle}`)}
                                  onClick={() => removeMember(member.handle)}
                                >
                                  {actions.busy(`remove:${member.handle}`) ? "Removing…" : "Remove"}
                                </Button>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </>
          )}
        </Show>
      </div>

      {/* Edit dialog */}
      <Dialog open={showEdit()} onOpenChange={setShowEdit}>
        <ResponsiveDialogContent>
          <DialogHeader>
            <DialogTitle>Edit organisation</DialogTitle>
          </DialogHeader>
          {/* The footer sits inside the form, so Enter in a field still submits. */}
          <form onSubmit={handleSave}>
            <div class="flex flex-col gap-4 p-4">
              <Field labelTreatment="plain" label="Name">
                {(field) => (
                  <Input
                    {...field}
                    value={editName()}
                    onInput={(e) => setEditName(e.currentTarget.value)}
                    required
                  />
                )}
              </Field>
              <Field labelTreatment="plain" label="Description">
                {(field) => (
                  <Textarea
                    {...field}
                    value={editDesc()}
                    onInput={(e) => setEditDesc(e.currentTarget.value)}
                    rows={2}
                  />
                )}
              </Field>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                class="max-md:h-10"
                onClick={() => setShowEdit(false)}
                disabled={saving()}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" class="max-md:h-10" busy={saving()}>
                {saving() ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </ResponsiveDialogContent>
      </Dialog>
    </main>
  );
}
