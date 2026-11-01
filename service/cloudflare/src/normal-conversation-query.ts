import type { Env, Identity } from "./contracts";
import type { inboxQuery } from "./inbox-query";
import type { NormalSearchContext } from "./normal-search-index";
import { normalMessageSelection } from "./normal-message-selection";

export async function normalConversationSelection(env: Env, identity: Identity, contexts: NormalSearchContext[], filters: Awaited<ReturnType<typeof inboxQuery>>["filters"]) {
  return normalMessageSelection(env, identity, contexts, filters);
}
