import type { Header } from "postal-mime";
import { rfcMessageId } from "./mail-address";
import { parseThreadHeaders } from "./message-thread-input";
import { parseSubscriptionHeaders } from "./subscription-input";

// Only semantic allowlisted headers leave the MIME parser. Raw headers are never API metadata.
export function normalMimeHeaders(headers: Header[]) {
  let threadLimited = false, listLimited = false;
  function field(name: string, kind: "thread" | "list") {
    const text = headers.filter(header => header.key.toLowerCase() === name)
      .map(header => header.value).join(" ").replace(/\r?\n[ \t]+/g, " ");
    if (text.length <= 8192 && !/[\r\n\x00]/.test(text)) return text;
    if (kind === "thread") threadLimited = true;
    else listLimited = true;
    return "";
  }
  const inReplyTo = field("in-reply-to", "thread"), references = field("references", "thread");
  const list = {
    listId: field("list-id", "list"), unsubscribe: field("list-unsubscribe", "list"),
    unsubscribePost: field("list-unsubscribe-post", "list"), precedence: field("precedence", "list"),
    listPost: field("list-post", "list"), listHelp: field("list-help", "list"), feedbackId: field("feedback-id", "list"),
  };
  const ownIds = headers.filter(header => header.key.toLowerCase() === "message-id");
  return {
    rfcMessageId: ownIds.length === 1 ? rfcMessageId(ownIds[0].value.trim()) : null,
    threadHeaders: parseThreadHeaders({ version: 1, inReplyTo, references, limited: threadLimited }),
    subscriptionHeaders: parseSubscriptionHeaders({ version: 1, ...list, limited: listLimited }),
  };
}
