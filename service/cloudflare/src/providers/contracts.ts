import type { CloudflareTempEmailSendTransport } from "../../../base/src/domain/cloudflare-send-policy";
import type { RecipientFields } from "../outgoing-recipients";

export interface ProviderConfig {
  id: string;
  type: "cloudflare" | "temporam" | "moemail" | "gptmail" | "duckmail" | "guerrillamail" | "im215";
  baseUrl: string;
  domains: string[];
  enabled: boolean;
  revision?: number;
  sendTransport?: CloudflareTempEmailSendTransport;
  sendRecipients: string[];
  authentication?: "api-key" | "anonymous";
}

export interface ProviderSecret { apiKey: string; sitePassword?: string }
export interface MailCredential { token?: string; moemailId?: string; duckmailId?: string; im215Id?: string }
export interface ProviderMailbox { remoteId: string; credential: MailCredential; expiresAt?: number | null }
export interface RandomProviderMailbox extends ProviderMailbox { address: string }
export interface CustomAddressCapability { enabled: boolean; minLength: number; maxLength: number; domains: string[] }
export interface MailAttachment { filename: string; mimeType: string; size: number; index?: number; sha256?: string }
export interface MailContent {
  remoteId: string;
  sender: string;
  recipient: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  attachments: MailAttachment[];
  receivedAt: number | null;
  rfcMessageId?: string | null;
  threadHeaders?: import("../message-thread-model").ThreadHeaders;
  subscriptionHeaders?: import("../subscription-model").SubscriptionHeaders;
  attachmentsTruncated?: boolean;
  resourceVersion?: string;
  remoteDeleteEnabled?: boolean;
}
export interface RemoteDeleteInput { requestId: string; mailId: string; expectedVersion: string }
export interface RemoteMailboxIdentity { addressId: string; address: string }
export interface RemoteMailboxDeleteInput extends RemoteMailboxIdentity { requestId: string }
export type RemoteDeleteState = "deleted" | "absent" | "changed";
export interface OutgoingAttachment { filename: string; type: string; disposition: "attachment"; content: string }
export interface OutgoingContent extends RecipientFields { from: string; subject: string; text: string; replyMessageId: string | null; attachments?: OutgoingAttachment[] }
export interface MailPage { items: MailContent[]; nextPage: number | null; missing: number; nextCursor?: string | null }
export interface MailReadContext { checkpointCredential(credential: MailCredential): Promise<void> }
export interface Provider {
  cursorPaging?: boolean;
  mailboxLifetimeSeconds?: number;
  domains(): Promise<string[]>;
  create?(address: string): Promise<ProviderMailbox>;
  createRandom?(domain: string): Promise<RandomProviderMailbox>;
  customAddressCapability?(): Promise<CustomAddressCapability>;
  createCustom?(address: string): Promise<ProviderMailbox>;
  recoverAccess?(address: string, token: string): Promise<ProviderMailbox>;
  read(address: string, credential: MailCredential, page: number, cursor?: string, context?: MailReadContext): Promise<MailPage>;
  send?(mail: OutgoingContent, credential: MailCredential): Promise<void>;
  attachment?(address: string, credential: MailCredential, remoteId: string, expected: MailAttachment): Promise<Uint8Array<ArrayBuffer>>;
  remoteDelete?(credential: MailCredential, input: RemoteDeleteInput, check: boolean): Promise<RemoteDeleteState>;
  mailboxDeleteCapability?(credential: MailCredential, account: RemoteMailboxIdentity): Promise<boolean>;
  remoteMailboxDelete?(credential: MailCredential, input: RemoteMailboxDeleteInput, check: boolean): Promise<RemoteDeleteState>;
}

export const MAIL_PAGE_SIZE = 10;
