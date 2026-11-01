import type { Env, Identity } from "./contracts";
import { HttpError, json } from "./http";
import { requireScope } from "./identity";
import { createMailbox } from "./mailbox-create";
import { syncMailbox } from "./mailbox-sync";
import { getMessage, listMessages } from "./message-queries";
import { extractMessages } from "./extraction-query";
import { checkExtractions } from "./extraction-check";
import { availableDomains, configuredProvider, connectProvider } from "./providers/registry";
import { patchMessage } from "./organization";
import { aggregateInbox } from "./aggregate-inbox";
import { sendMessage } from "./send-message";
import { getOutgoing, listOutgoing } from "./outgoing-store";
import { downloadAttachment } from "./attachment-download";
import { mailboxLifecycle } from "./mailbox-lifecycle";
import { messageLifecycle } from "./message-lifecycle";
import { allocationState, allocationView } from "./allocation-state";
import { providerStates } from "./providers/settings";
import { providerAccessConfigured } from "./providers/secrets";
import { creationRoute, isCreationPath } from "./creation-history";
import { remoteDeletion } from "./remote-delete";
import { remoteMailboxDeletion } from "./mailbox-delete";
import { unifiedInbox } from "./unified-inbox";
import { mailboxRecovery } from './mailbox-recovery';

export function isMailPath(path: string): boolean {
  return isCreationPath(path) || path === "/api/v1/providers" || path === "/api/v1/messages" || /^\/api\/v1\/providers\/[a-z][a-z0-9-]{0,47}\/(?:domains|custom-prefix)$/.test(path)
    || /^\/api\/v1\/mailbox-access-recoveries(?:\/[a-zA-Z0-9_-]{16,128})?$/.test(path)
    || /^\/api\/v1\/outgoing(?:\/[0-9a-f-]{36})?$/.test(path)
    || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/lifecycle$/.test(path)
    || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/remote-delete(?:\/check)?$/.test(path)
    || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/(?:restore|purge)$/.test(path)
    || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/remote-delete(?:\/check)?$/.test(path)
    || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/attachments\/\d{1,3}$/.test(path)
    || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/extractions\/check$/.test(path)
    || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/(?:sync|messages|extractions|outgoing)(?:\/[0-9a-f-]{36})?$/.test(path);
}

export async function mailRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;
  const recovery = /^\/api\/v1\/mailbox-access-recoveries(?:\/([a-zA-Z0-9_-]{16,128}))?$/.exec(path);
  if (recovery) return mailboxRecovery(request, env, identity, recovery[1]);
  if (isCreationPath(path)) return creationRoute(request, env, identity);
  const mailboxDeletion = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/remote-delete(\/check)?$/.exec(path);
  if (mailboxDeletion && (request.method === "POST" || (request.method === "GET" && !mailboxDeletion[2]))) {
    return remoteMailboxDeletion(request, env, identity, mailboxDeletion[1], !!mailboxDeletion[2]);
  }
  const deletion = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/remote-delete(\/check)?$/.exec(path);
  if (deletion && (request.method === "POST" || (request.method === "GET" && !deletion[3]))) {
    return remoteDeletion(request, env, identity, deletion[1], deletion[2], !!deletion[3]);
  }
  const extraction = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/extractions\/check$/.exec(path);
  if (extraction && request.method === "POST") return checkExtractions(request, env, identity, extraction[1]);
  const mailboxLife = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/lifecycle$/.exec(path);
  if (mailboxLife && request.method === "POST") return mailboxLifecycle(request, env, identity, mailboxLife[1]);
  const messageLife = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/(restore|purge)$/.exec(path);
  if (messageLife && request.method === "POST") return messageLifecycle(request, env, identity, messageLife[1], messageLife[2], messageLife[3] as "restore" | "purge");
  const attachment = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/attachments\/(\d{1,3})$/.exec(path);
  if (attachment && request.method === "GET") return downloadAttachment(env, identity, attachment[1], attachment[2], Number(attachment[3]));
  const outgoing = /^\/api\/v1\/outgoing(?:\/([0-9a-f-]{36}))?$/.exec(path);
  if (outgoing && request.method === "GET") return outgoing[1] ? getOutgoing(env, identity, outgoing[1]) : listOutgoing(request, env, identity);
  if (path === "/api/v1/messages" && request.method === "GET") return new URL(request.url).searchParams.has("sources")
    ? unifiedInbox(request, env, identity) : aggregateInbox(request, env, identity);
  if (path === "/api/v1/mailboxes" && request.method === "POST") return createMailbox(request, env, identity);
  if (path === "/api/v1/providers" && request.method === "GET") {
    requireScope(identity, "mailboxes:read");
    return json({ allocationSelection: ["manual", "automatic"], items: await Promise.all((await providerStates(env))
      .filter((state) => state.config.enabled).map(async (state) => { const row = state.config; return { id: row.id, type: row.type,
      allocation: allocationView(await allocationState(env, row), providerAccessConfigured(env, state)),
      capabilities: { allocation: row.type === "guerrillamail" ? "session-select" : ["temporam", "gptmail"].includes(row.type) ? "random-address" : "remote-create", sync: true,
        customPrefix: row.type === 'cloudflare' ? 'preflight-required' : false, restoreByAddress: false,
        credentialRecovery: row.type === 'cloudflare' ? 'proof-required-v1' : false, send: !!row.sendTransport && row.sendRecipients.length > 0,
        replyHeaders: row.sendTransport === "binding", multipleRecipients: row.sendTransport === "binding" && row.sendRecipients.length > 0, attachmentDownload: row.type === "cloudflare",
        attachmentSend: !!env.OUTBOX && row.sendTransport === "binding" && row.sendRecipients.length > 0,
        platformLifecycle: true, remoteMailboxDelete: false, remoteMessageDelete: false,
        conditionalRemoteMailboxDelete: row.type === "cloudflare",
        conditionalRemoteMessageDelete: row.type === "cloudflare" } }; })) });
  }
  const custom = /^\/api\/v1\/providers\/([^/]+)\/custom-prefix$/.exec(path);
  if (custom && request.method === 'GET') {
    requireScope(identity, 'mailboxes:read');
    const provider = await connectProvider(env, await configuredProvider(env, custom[1]));
    if (!provider.customAddressCapability) throw new HttpError(409, 'custom_prefix_unavailable');
    return json({ customPrefix: await provider.customAddressCapability() });
  }
  const domains = /^\/api\/v1\/providers\/([^/]+)\/domains$/.exec(path);
  if (domains && request.method === "GET") {
    requireScope(identity, "mailboxes:read");
    return json({ domains: await availableDomains(env, await configuredProvider(env, domains[1])) });
  }
  const match = /^\/api\/v1\/mailboxes\/([^/]+)\/(sync|messages|extractions|outgoing)(?:\/([^/]+))?$/.exec(path);
  if (match && !match[3]) {
    if (match[2] === "sync" && request.method === "POST") return syncMailbox(request, env, identity, match[1]);
    if (match[2] === "outgoing" && request.method === "POST") return sendMessage(request, env, identity, match[1]);
    if (match[2] === "messages" && request.method === "GET") return listMessages(request, env, identity, match[1]);
    if (match[2] === "extractions" && request.method === "GET") return extractMessages(request, env, identity, match[1]);
  }
  if (match?.[2] === "messages" && match[3] && request.method === "GET") return getMessage(env, identity, match[1], match[3]);
  if (match?.[2] === "messages" && match[3] && request.method === "PATCH") return patchMessage(request, env, identity, match[1], match[3]);
  if (match?.[2] === "messages" && match[3] && request.method === "DELETE") return messageLifecycle(request, env, identity, match[1], match[3], "trash");
  throw new HttpError(405, "method_not_allowed");
}
