import type {
  MailAliasOutcome,
  MailAliasPlan,
  MailAliasProviderKey,
  VerificationMailboxRequest,
} from "../../domain/models.js";

export interface MailAliasProvider {
  readonly providerKey: MailAliasProviderKey;
  planAlias(request: VerificationMailboxRequest, now?: Date): MailAliasPlan;
  createAliasOutcome(request: VerificationMailboxRequest, now?: Date): Promise<MailAliasOutcome>;
}
