/**
 * Zap API domain metrics.
 *
 * Single source of truth — every counter/histogram for Zap lives here.
 * Services import the recording helpers (`metric*`) and call them at the
 * relevant points. Raw OTel instruments are never used.
 *
 * See `CLAUDE.md` "Observability" section for the full rules.
 */

import {
  BYTE_BUCKETS,
  createCounter,
  createHistogram,
  createUpDownCounter,
} from "@shared/observability/metrics";
import type { Result } from "@shared/observability/metrics";

/** Canonical metric name consts — grep-able, refactor-safe. */
export const ZAP_METRICS = {
  chatsCreated: "zap.chats.created",
  chatsMembersAdded: "zap.chats.members.added",
  chatsMembersRemoved: "zap.chats.members.removed",
  messagesSent: "zap.messages.sent",
  messagesSentSize: "zap.messages.sent.size",
  messagesListed: "zap.messages.listed",
  wsConnections: "zap.ws.connections",
  wsMessagesDelivered: "zap.ws.messages.delivered",
  accessDenied: "zap.access.denied",
} as const;

// ---------------------------------------------------------------------------
// Attribute shapes — bounded string-literal unions ONLY.
// ---------------------------------------------------------------------------

type ChatType = "dm" | "group" | "event";

type ChatsCreatedAttrs = {
  type: ChatType;
  result: Result;
};

type MemberAttrs = {
  result: Result;
};

type MessagesSentAttrs = {
  chat_type: ChatType;
  result: Result;
};

type MessagesSentSizeAttrs = {
  chat_type: ChatType;
};

type MessagesListedAttrs = {
  result_empty: "true" | "false";
};

type WsConnectionAttrs = {
  event: "open" | "close";
};

type WsDeliveredAttrs = {
  result: Result;
};

type AccessDeniedSurface = "chat" | "messages" | "members";
type AccessDeniedReason = "not_member" | "blocked" | "not_found";

type AccessDeniedAttrs = {
  surface: AccessDeniedSurface;
  reason: AccessDeniedReason;
};

// ---------------------------------------------------------------------------
// Counters / histograms
// ---------------------------------------------------------------------------

const chatsCreated = createCounter<ChatsCreatedAttrs>({
  name: ZAP_METRICS.chatsCreated,
  description: "Chats created by type and outcome",
  unit: "{chat}",
});

const chatsMembersAdded = createCounter<MemberAttrs>({
  name: ZAP_METRICS.chatsMembersAdded,
  description: "Members added to chats",
  unit: "{member}",
});

const chatsMembersRemoved = createCounter<MemberAttrs>({
  name: ZAP_METRICS.chatsMembersRemoved,
  description: "Members removed from chats",
  unit: "{member}",
});

const messagesSent = createCounter<MessagesSentAttrs>({
  name: ZAP_METRICS.messagesSent,
  description: "Messages sent by chat type and outcome",
  unit: "{message}",
});

const messagesSentSize = createHistogram<MessagesSentSizeAttrs>({
  name: ZAP_METRICS.messagesSentSize,
  description: "Ciphertext size distribution in bytes",
  unit: "By",
  boundaries: BYTE_BUCKETS,
});

const messagesListed = createCounter<MessagesListedAttrs>({
  name: ZAP_METRICS.messagesListed,
  description: "Message list queries",
  unit: "{query}",
});

const wsConnections = createUpDownCounter<WsConnectionAttrs>({
  name: ZAP_METRICS.wsConnections,
  description: "Active WebSocket connections gauge",
  unit: "{connection}",
});

const wsMessagesDelivered = createCounter<WsDeliveredAttrs>({
  name: ZAP_METRICS.wsMessagesDelivered,
  description: "WebSocket push deliveries",
  unit: "{delivery}",
});

const accessDenied = createCounter<AccessDeniedAttrs>({
  name: ZAP_METRICS.accessDenied,
  description: "Chat access denials — a spike signals probing",
  unit: "{denial}",
});

// ---------------------------------------------------------------------------
// Public recording helpers — the ONLY way Zap code should emit metrics.
// ---------------------------------------------------------------------------

export const metricChatCreated = (type: ChatType, result: Result): void =>
  chatsCreated.inc({ type, result });

export const metricMemberAdded = (result: Result): void => chatsMembersAdded.inc({ result });

export const metricMemberRemoved = (result: Result): void => chatsMembersRemoved.inc({ result });

export const metricMessageSent = (
  chatType: ChatType,
  ciphertextBytes: number,
  result: Result,
): void => {
  messagesSent.inc({ chat_type: chatType, result });
  if (result === "ok") messagesSentSize.record(ciphertextBytes, { chat_type: chatType });
};

export const metricMessagesListed = (resultCount: number): void =>
  messagesListed.inc({ result_empty: resultCount === 0 ? "true" : "false" });

export const metricWsConnection = (event: "open" | "close"): void => wsConnections.inc({ event });

export const metricWsMessageDelivered = (result: Result): void =>
  wsMessagesDelivered.inc({ result });

export const metricAccessDenied = (
  surface: AccessDeniedSurface,
  reason: AccessDeniedReason,
): void => accessDenied.inc({ surface, reason });
