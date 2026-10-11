// Read receipts for inbound chats (human request, 2026-10-10): after an inbound message is
// accepted and deduped, mark its DM chat read so the user sees "Read" under their text.
// Verified in installed @photon-ai/advanced-imessage 2.2.0 (dist/grpc.d.ts, ChatsResource):
//   markRead(chat: string): Promise<void>   "marks every unread message in the chat as read"
// The DM chat GUID is any;-;<E164> (dmChatGuid). @spectrum-ts/imessage 12.10.1 does the same
// internally (remote.chats.markRead(toChatGuid(spaceId))).
// Best effort: fire and forget, never awaited by the inbound path, never throws. Its own echo
// (a read event on an inbound message) is already dropped by spectrum-ts and by InboundLoop.
import type { E164 } from "../contracts.js";
import { describeError, last4 } from "./errors.js";
import { dmChatGuid } from "./imessageAdvanced.js";

export interface MarkReadApi {
  chats: { markRead(chat: string): Promise<void> };
}

export interface MarkReadLogger {
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export function markInboundRead(api: MarkReadApi | null | undefined, from: E164, log?: MarkReadLogger): void {
  if (!api) return;
  const fail = (err: unknown) => log?.warn({ from: last4(from), error: describeError(err) }, "markRead failed");
  try {
    void Promise.resolve(api.chats.markRead(dmChatGuid(from))).catch(fail);
  } catch (err) {
    fail(err);
  }
}
