import { useAuth } from "@osn/client/solid";
import { createResource, createSignal, onMount, Show } from "solid-js";
import { toast } from "solid-toast";

import { redirectToLogin } from "../lib/api";
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
  invalidateEnquiries,
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
      (err) => {
        if (
          typeof err === "object" &&
          err !== null &&
          ("_tag" in err
            ? (err as { _tag: unknown })._tag === "AuthExpiredError"
            : String(err).includes("AuthExpiredError"))
        ) {
          redirectToLogin();
        }
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

  // Fetch messages whenever the selected enquiry id changes.
  const [messages, { refetch }] = createResource(selectedId, (id) => {
    if (!id) return Promise.resolve([]);
    return fetchMessages(authFetch, props.weddingId, id);
  });

  const handleSend = async (message: string) => {
    const id = selectedId();
    if (!id) return;
    await replyEnquiry(authFetch, props.weddingId, id, message);
    // Refresh the inbox list so status/lastMessageAt update.
    invalidateEnquiries(props.weddingId);
    await ensureEnquiriesLoaded(props.weddingId, () => fetchEnquiries(authFetch, props.weddingId));
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
    <div class="flex flex-col gap-4">
      <Show when={selectedId() === null}>
        <EnquiryInbox items={enquiries()} currency={props.currency} onOpen={setSelectedId} />
      </Show>

      <Show when={selectedId() !== null && selectedEnquiry() !== null}>
        <EnquiryThread
          enquiry={selectedEnquiry()!}
          messages={messages() ?? []}
          loading={messages.loading}
          error={messages.error ? enquiryErrorMessage(messages.error) : null}
          ownProfileId={activeProfileId() ?? ""}
          currency={props.currency}
          canEdit={props.canEdit}
          onBack={() => setSelectedId(null)}
          onSend={handleSend}
          onAddToBudget={handleAddToBudget}
        />
      </Show>
    </div>
  );
}
