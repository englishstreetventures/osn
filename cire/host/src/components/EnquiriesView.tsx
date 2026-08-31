import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createResource, createSignal, onMount, Show } from "solid-js";

import { isAuthExpired, redirectToLogin } from "../lib/api";
import {
  addEnquiryToBudget,
  enquiryErrorMessage,
  fetchEnquiries,
  fetchMessages,
  replyEnquiry,
} from "../lib/enquiries-api";
import {
  enquiriesAccessor,
  ensureEnquiriesLoaded,
  type EnquiryMessage,
  upsertCachedEnquiry,
} from "../lib/enquiries-store";
import EnquiryInbox from "./EnquiryInbox";
import EnquiryThread from "./EnquiryThread";

interface EnquiriesViewProps {
  weddingId: string;
  currency: string;
  canEdit: boolean;
}

export default function EnquiriesView(props: EnquiriesViewProps) {
  const { authFetch, activeProfileId } = useAuth();
  const [selectedId, setSelectedId] = createSignal<string | null>(null);

  onMount(() => {
    ensureEnquiriesLoaded(props.weddingId, () => fetchEnquiries(authFetch, props.weddingId)).catch(
      // Was a hand-inlined copy of this predicate, and a strictly narrower one:
      // it read `_tag` first and returned false for ANY other tag, never falling
      // through to the printout check that catches an Effect-wrapped failure. An
      // expiry here left the organiser on an empty inbox instead of sign-in.
      // Every other view already used the shared helper.
      (err) => {
        if (isAuthExpired(err)) redirectToLogin();
      },
    );
  });

  // Reactive accessor for the enquiry list.
  const enquiries = () => enquiriesAccessor(props.weddingId)() ?? [];

  // Find the selected enquiry by id from the cached list.
  const selectedEnquiry = () => {
    const id = selectedId();
    if (!id) return null;
    return enquiries().find((e) => e.id === id) ?? null;
  };

  // Fetch messages whenever the selected enquiry id changes. The resolved value
  // carries the id it belongs to, because reading a resource while it re-fetches
  // yields the PREVIOUS value — and since switching threads no longer unmounts
  // anything (see the keyed `Show` below), that value would render enquiry A's
  // messages under enquiry B's name and quote for the length of a round-trip.
  const [messages, { refetch }] = createResource(selectedId, async (id) => ({
    enquiryId: id,
    items: await fetchMessages(authFetch, props.weddingId, id),
  }));

  /** Messages, but only ever the named enquiry's. A load in flight for a newly
   *  selected enquiry shows an empty thread with its loading line, never the
   *  previous vendor's correspondence. A re-fetch of the SAME enquiry (after
   *  sending a reply) still matches, so the thread doesn't blank out. Takes the
   *  id explicitly so the mounted thread is pinned to the enquiry it was created
   *  for rather than to whatever is selected now. */
  const messagesFor = (enquiryId: string): EnquiryMessage[] => {
    const loaded = messages();
    return loaded && loaded.enquiryId === enquiryId ? loaded.items : [];
  };

  const handleSend = async (message: string) => {
    const id = selectedId();
    if (!id) return;
    await replyEnquiry(authFetch, props.weddingId, id, message);
    // Refresh the inbox row by writing through the LIVE signal, not by
    // invalidate-then-reload. `invalidateEnquiries` now notifies the same
    // signal the mounted inbox reads, so a reload WOULD reach it — but it
    // would still cost a whole-list round-trip to learn one row's new
    // timestamp, which is exactly the round-trip ENQ-P-I1 (below) paid down.
    //
    // ENQ-P-I1: refetching the WHOLE inbox to learn one row's new timestamp
    // was a list-sized round-trip per reply. The server's reply path sets only
    // `lastMessageAt` + `updatedAt` on this one row — never `status`, which
    // moves on quote, not on message — so the post-reply row is derivable
    // locally, and `upsertCachedEnquiry` re-sorts the list the same way the
    // server's `ORDER BY lastMessageAt DESC` does.
    //
    // No `else`: `selectedEnquiry()` is derived from this same cached list, so
    // a miss means the thread was never on screen and this handler could not
    // have run. There is no inbox row to refresh in that state.
    const current = selectedEnquiry();
    if (current) {
      const now = Date.now();
      upsertCachedEnquiry(props.weddingId, { ...current, lastMessageAt: now, updatedAt: now });
    }
    // Refetch the thread messages.
    await refetch();
  };

  const handleAddToBudget = async () => {
    const id = selectedId();
    if (!id) return;
    try {
      await addEnquiryToBudget(authFetch, props.weddingId, id);
      toast.success("Added to budget");
    } catch (err) {
      toast.error(enquiryErrorMessage(err));
    }
  };

  return (
    // Master-detail, switched on the width this view actually gets rather than
    // the viewport's: narrow shows the inbox OR the thread (the classic
    // drill-in), wide shows both, so replying to a vendor no longer hides the
    // rest of the enquiries. Its own container (`@container/enquiries`) so the
    // switch survives the view being dropped into a narrower slot.
    <div class="@container/enquiries flex flex-col gap-4">
      <div class="flex flex-col gap-4 @3xl/enquiries:grid @3xl/enquiries:grid-cols-[minmax(20rem,28rem)_minmax(0,1fr)] @3xl/enquiries:items-start">
        {/* The inbox stays mounted while a thread is open and is hidden by CSS
            only on narrow layouts — so widening the panel mid-conversation
            reveals the list without a refetch, and `display: none` keeps its
            buttons out of the tab order when it isn't visible. */}
        <div classList={{ "@max-3xl/enquiries:hidden": selectedId() !== null }}>
          <EnquiryInbox
            items={enquiries()}
            currency={props.currency}
            selectedId={selectedId()}
            onOpen={setSelectedId}
          />
        </div>

        {/* `keyed` on the open enquiry's id, which is what makes the thread a
            NEW component per enquiry. Side by side, clicking another row while a
            reply is half-typed keeps this `Show` truthy — an unkeyed one would
            reuse the same `EnquiryThread` instance, leaving vendor A's draft in
            vendor B's send box (and its `sending` flag mid-flight). The old
            inbox-or-thread pair got that unmount boundary for free; now it has
            to be asked for. Keyed on the id rather than the row object so a list
            re-fetch after sending updates the header in place instead of
            remounting mid-conversation.

            `?? null` also covers a selection that no longer resolves — a
            re-fetch that dropped the enquiry falls back to the placeholder
            rather than rendering a thread with no subject. */}
        <Show
          keyed
          when={selectedEnquiry()?.id ?? null}
          fallback={
            // Wide-only: the detail column needs to say what it's for when
            // nothing is picked. Narrow has no second column to fill.
            <p class="border-border bg-surface/10 text-text-muted hidden rounded-sm border border-dashed px-4 py-6 text-[0.85rem] italic @3xl/enquiries:block">
              Pick an enquiry to read the conversation and reply.
            </p>
          }
        >
          {/* The keyed id is consumed deliberately: Solid's `Show` only *calls* a
              children function whose arity is ≥ 1 (it checks `children.length`),
              so a zero-argument `() => …` would be returned as a plain child and
              `keyed` would silently do nothing. Passing the id on to
              `messagesFor` also pins this instance's messages to the enquiry it
              was created for. */}
          {(enquiryId) => (
            <EnquiryThread
              enquiry={selectedEnquiry()!}
              messages={messagesFor(enquiryId)}
              loading={messages.loading}
              error={messages.error ? enquiryErrorMessage(messages.error) : null}
              ownProfileId={activeProfileId() ?? ""}
              currency={props.currency}
              canEdit={props.canEdit}
              onBack={() => setSelectedId(null)}
              onSend={handleSend}
              onAddToBudget={handleAddToBudget}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
