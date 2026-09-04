import { randomUUID } from "node:crypto";
import { EasyEmailError } from "../domain/errors.js";
import type {
  MailAccount,
  MailAccountCreateInput,
  MailAccountDeleteInput,
  MailAccountListQuery,
  MailAccountListResult,
  MailAccountRepository,
  MailAccountUpdateInput,
} from "../domain/account.js";
import type {
  MailAccountConnectivityDependencies,
  MailAccountImapTestRequest,
  MailImapConnectionTestResult,
} from "./account-connectivity.js";
import {
  ACCOUNT_CREATE_FIELDS,
  ACCOUNT_DELETE_FIELDS,
  ACCOUNT_UPDATE_FIELDS,
  DEFAULT_ACCOUNT_PAGE_SIZE,
  IMAP_TEST_FIELDS,
  MAX_ACCOUNT_PAGE_SIZE,
  assertNoRawSecretFields,
  assertOnlyKnownFields,
  decodeCursor,
  encodeCursor,
  initialState,
  normalizeCredentialRefs,
  normalizeDisplayName,
  normalizeEmail,
  normalizeExpectedVersion,
  normalizeImapProfile,
  normalizeKind,
  normalizeOptionalBoolean,
  normalizeOptionalLabel,
  normalizeScope,
  sqliteUniqueConstraint,
} from "./account-validation.js";

export class MailAccountService {
  public constructor(
    private readonly repository: MailAccountRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly connectivity: MailAccountConnectivityDependencies = {},
  ) {}

  public async listAccounts(query: MailAccountListQuery = {}): Promise<MailAccountListResult> {
    const scope = query.scope === undefined ? undefined : normalizeScope(query.scope);
    const limit = query.limit ?? DEFAULT_ACCOUNT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ACCOUNT_PAGE_SIZE) {
      throw new EasyEmailError("INVALID_QUERY", `Account limit must be an integer from 1 to ${MAX_ACCOUNT_PAGE_SIZE}.`);
    }
    const result = await this.repository.listMailAccounts({
      scope,
      limit,
      after: query.cursor ? decodeCursor(query.cursor, scope) : undefined,
    });
    const last = result.accounts.at(-1);
    return {
      accounts: result.accounts,
      nextCursor: result.hasMore && last ? encodeCursor(last, scope) : undefined,
    };
  }

  public async getAccount(id: string): Promise<MailAccount> {
    const normalizedId = id.trim();
    const account = normalizedId ? await this.repository.getMailAccount(normalizedId) : undefined;
    if (!account) {
      throw new EasyEmailError("ACCOUNT_NOT_FOUND", `Account ${id} was not found.`);
    }
    return account;
  }

  public async createAccount(input: MailAccountCreateInput): Promise<MailAccount> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_ACCOUNT", "Account request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as unknown as Record<string, unknown>, ACCOUNT_CREATE_FIELDS, "Account");
    const kind = normalizeKind(input.kind);
    const scope = input.scope === undefined
      ? (kind === "agent_owned" ? "agent" : "normal")
      : normalizeScope(input.scope);
    if (
      (kind === "agent_owned" && scope !== "agent")
      || (kind !== "agent_owned" && kind !== "anonymous_virtual" && scope !== "normal")
      || kind === "anonymous_virtual"
      || kind === "normal_upgraded_temp"
    ) {
      throw new EasyEmailError("ACCOUNT_KIND_UNSUPPORTED", "Account kind and scope combination is unsupported.");
    }
    const primaryAddress = normalizeEmail(input.primaryAddress);
    if (!primaryAddress) {
      throw new EasyEmailError("INVALID_ACCOUNT", "primaryAddress is required for a user account.");
    }
    const state = initialState(kind);
    const now = this.now().toISOString();
    try {
      return await this.repository.createMailAccount({
        id: `acct_v1_${randomUUID()}`,
        scope,
        kind,
        displayName: normalizeDisplayName(input.displayName),
        primaryAddress,
        providerLabel: normalizeOptionalLabel(input.providerLabel, "providerLabel"),
        imap: normalizeImapProfile(input.imap),
        status: state.status,
        authStatus: state.authStatus,
        receiveStatus: state.receiveStatus,
        sendStatus: state.sendStatus,
        listedInAllAccounts: normalizeOptionalBoolean(
          input.listedInAllAccounts,
          "listedInAllAccounts",
        ) ?? state.listedInAllAccounts,
        credentialRefs: normalizeCredentialRefs(input.credentialRefs),
        now,
      });
    } catch (error) {
      const uniqueConstraint = sqliteUniqueConstraint(error);
      if (uniqueConstraint === "address") {
        throw new EasyEmailError("ACCOUNT_ADDRESS_CONFLICT", "Another account already uses that address.");
      }
      if (uniqueConstraint === "credential-ref") {
        throw new EasyEmailError(
          "ACCOUNT_CREDENTIAL_REF_CONFLICT",
          "The credential reference is already owned by another account.",
        );
      }
      throw error;
    }
  }

  public async updateAccount(id: string, input: MailAccountUpdateInput): Promise<MailAccount> {
    const existing = await this.getAccount(id);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_ACCOUNT", "Account update request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as unknown as Record<string, unknown>, ACCOUNT_UPDATE_FIELDS, "Account update");
    if (existing.kind === "anonymous_virtual") {
      throw new EasyEmailError("ACCOUNT_SYSTEM_MANAGED", "The anonymous virtual account is system-managed.");
    }
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    if (
      input.displayName === undefined
      && input.providerLabel === undefined
      && input.imap === undefined
      && input.listedInAllAccounts === undefined
    ) {
      throw new EasyEmailError("INVALID_ACCOUNT", "At least one account field must be updated.");
    }
    const updated = await this.repository.updateMailAccount({
      id: existing.id,
      expectedVersion,
      displayName: input.displayName === undefined
        ? existing.displayName
        : normalizeDisplayName(input.displayName),
      providerLabel: input.providerLabel === undefined
        ? existing.providerLabel
        : normalizeOptionalLabel(input.providerLabel, "providerLabel"),
      imap: input.imap === undefined ? existing.imap : normalizeImapProfile(input.imap, true),
      listedInAllAccounts: normalizeOptionalBoolean(
        input.listedInAllAccounts,
        "listedInAllAccounts",
      ) ?? existing.listedInAllAccounts,
      now: this.now().toISOString(),
    });
    if (!updated) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    return updated;
  }

  public async disableAccount(id: string, expectedVersion: number): Promise<MailAccount> {
    const existing = await this.getAccount(id);
    if (existing.kind === "anonymous_virtual") {
      throw new EasyEmailError("ACCOUNT_SYSTEM_MANAGED", "The anonymous virtual account is system-managed.");
    }
    const normalizedVersion = normalizeExpectedVersion(expectedVersion);
    if (existing.version !== normalizedVersion) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    const updated = await this.repository.disableMailAccount(
      existing.id,
      normalizedVersion,
      this.now().toISOString(),
    );
    if (!updated) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    return updated;
  }

  public async deleteAccount(id: string, input: MailAccountDeleteInput): Promise<{ id: string }> {
    const existing = await this.getAccount(id);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_ACCOUNT", "Account delete request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as unknown as Record<string, unknown>, ACCOUNT_DELETE_FIELDS, "Account delete");
    if (existing.kind === "anonymous_virtual") {
      throw new EasyEmailError("ACCOUNT_SYSTEM_MANAGED", "The anonymous virtual account is system-managed.");
    }
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    if (existing.version !== expectedVersion) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    if (!await this.repository.deleteMailAccount(existing.id, expectedVersion, this.now().toISOString())) {
      throw new EasyEmailError("ACCOUNT_VERSION_CONFLICT", "Account was changed by another request.");
    }
    return { id: existing.id };
  }

  public async testImapConnection(
    input: MailAccountImapTestRequest,
  ): Promise<MailImapConnectionTestResult> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new EasyEmailError("INVALID_ACCOUNT", "IMAP test request must be an object.");
    }
    assertNoRawSecretFields(input);
    assertOnlyKnownFields(input as unknown as Record<string, unknown>, IMAP_TEST_FIELDS, "IMAP test");
    const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
    const credentialRefId = typeof input.credentialRefId === "string" ? input.credentialRefId.trim() : "";
    if (!accountId || accountId.length > 256 || !credentialRefId || credentialRefId.length > 256) {
      throw new EasyEmailError("INVALID_ACCOUNT", "accountId and credentialRefId must be non-empty strings.");
    }
    const account = await this.getAccount(accountId);
    if (account.kind === "anonymous_virtual" || account.status === "disabled") {
      throw new EasyEmailError("ACCOUNT_IMAP_TEST_UNSUPPORTED", "This account cannot test IMAP connectivity.");
    }
    if (!account.imap) {
      throw new EasyEmailError("ACCOUNT_IMAP_CONFIG_REQUIRED", "The account has no IMAP connection profile.");
    }
    const credentialRef = account.credentialRefs.find((item) => item.id === credentialRefId);
    if (
      !credentialRef
      || credentialRef.ownerAccountId !== account.id
      || credentialRef.credentialKind !== "imap_password"
      || credentialRef.authMethod !== "password"
      || credentialRef.status === "disabled"
      || credentialRef.status === "invalid"
    ) {
      throw new EasyEmailError(
        "ACCOUNT_REAUTHENTICATION_REQUIRED",
        "The account IMAP credential must be provided again.",
      );
    }
    const { credentialResolver, imapTester } = this.connectivity;
    if (!credentialResolver) {
      throw new EasyEmailError(
        "ACCOUNT_CREDENTIAL_UNAVAILABLE",
        "The credential resolver is unavailable in this runtime.",
      );
    }
    if (!imapTester) {
      throw new EasyEmailError("ACCOUNT_IMAP_TEST_UNAVAILABLE", "IMAP testing is unavailable in this runtime.");
    }
    let resolution;
    try {
      resolution = await credentialResolver.resolveCredential({
        account,
        credentialRef,
        useCase: "imap-test",
      });
    } catch {
      throw new EasyEmailError(
        "ACCOUNT_CREDENTIAL_UNAVAILABLE",
        "The credential resolver could not be reached.",
      );
    }
    if (resolution.status === "missing") {
      throw new EasyEmailError(
        "ACCOUNT_REAUTHENTICATION_REQUIRED",
        "The account IMAP credential must be provided again.",
      );
    }
    if (resolution.status !== "resolved" || typeof resolution.secret !== "string" || !resolution.secret) {
      throw new EasyEmailError("ACCOUNT_CREDENTIAL_UNAVAILABLE", "The account credential is unavailable.");
    }
    try {
      const result = await imapTester.testConnection(account.imap, resolution.secret);
      if (result.authenticated !== true || typeof result.capabilitySummary !== "string") {
        throw new Error("invalid IMAP test result");
      }
      const capabilitySummary = result.capabilitySummary
        .slice(0, 4096)
        .split(resolution.secret).join("[redacted]")
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .slice(0, 1024);
      return {
        authenticated: true,
        capabilitySummary,
      };
    } catch (error) {
      if (error instanceof EasyEmailError && error.code === "IMAP_AUTH_FAILED") {
        throw error;
      }
      throw new EasyEmailError("ACCOUNT_IMAP_UNAVAILABLE", "The IMAP server could not be reached.");
    }
  }
}

export function createMailAccountService(
  repository: MailAccountRepository,
  now?: () => Date,
  connectivity?: MailAccountConnectivityDependencies,
): MailAccountService {
  return new MailAccountService(repository, now, connectivity);
}
