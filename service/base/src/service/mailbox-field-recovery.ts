import { createId } from "../shared/index.js";
import type { MailProviderTypeKey, MailboxSession, ProviderInstance } from "../domain/models.js";
import type { MailboxRecoveryStrategy } from "../providers/contracts.js";
import { encodeCloudflareTempMailboxRef } from "../providers/cloudflare_temp_email/connector/client.js";
import { encodeDuckMailMailboxRef } from "../providers/duckmail/client.js";
import { encodeEtempmailMailboxRef } from "../providers/etempmail/client.js";
import { encodeGuerrillaMailMailboxRef } from "../providers/guerrillamail/client.js";
import { encodeIm215MailboxRef } from "../providers/im215/client.js";
import { encodeM2uMailboxRef } from "../providers/m2u/client.js";
import { encodeMail2925MailboxRef } from "../providers/mail2925/client.js";
import { encodeMailTmMailboxRef } from "../providers/mailtm/client.js";
import { encodeMoemailMailboxRef } from "../providers/moemail/client.js";
import { encodeTempmailLolMailboxRef } from "../providers/tempmail_lol/client.js";
import { encodeTemporamMailboxRef } from "../providers/temporam/client.js";

export interface MailboxFieldRecoveryInput {
  emailAddress: string;
  hostId?: string;
  providerTypeKey: MailProviderTypeKey;
  instance: ProviderInstance;
  recoveryFields?: Record<string, string>;
  now: Date;
}

export interface MailboxFieldRecoveryResult {
  strategy: MailboxRecoveryStrategy;
  session: MailboxSession;
  detail: string;
}

function normalizeEmailAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return undefined;
  }
  const parts = normalized.split("@");
  return parts.length === 2 && parts[0] && parts[1] ? normalized : undefined;
}

function readField(fields: Record<string, string> | undefined, key: string): string | undefined {
  const value = fields?.[key]?.trim();
  return value || undefined;
}

function splitEmailAddress(emailAddress: string): { localPart: string; domain: string } | undefined {
  const parts = emailAddress.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return undefined;
  }
  return {
    localPart: parts[0],
    domain: parts[1],
  };
}

function createRecoveredSession(input: {
  emailAddress: string;
  hostId?: string;
  providerTypeKey: MailProviderTypeKey;
  instance: ProviderInstance;
  mailboxRef: string;
  now: Date;
  expiresAt?: string;
}): MailboxSession {
  return {
    id: createId("mailbox", input.now),
    hostId: input.hostId?.trim() || `recovery:${input.providerTypeKey}`,
    providerTypeKey: input.providerTypeKey,
    providerInstanceId: input.instance.id,
    emailAddress: input.emailAddress,
    mailboxRef: input.mailboxRef,
    status: "open",
    createdAt: input.now.toISOString(),
    expiresAt: input.expiresAt,
    metadata: {
      recoveredFromEmailAddress: input.emailAddress,
      recoveryStrategy: "session_restore",
      recoverySource: "caller_required_fields",
      notBeforeAt: input.now.toISOString(),
    },
  };
}

function buildMailboxRefFromFields(input: MailboxFieldRecoveryInput): { mailboxRef: string; expiresAt?: string } | undefined {
  const fields = input.recoveryFields;
  const emailAddress = normalizeEmailAddress(input.emailAddress);
  if (!emailAddress) {
    return undefined;
  }

  if (input.providerTypeKey === "cloudflare_temp_email") {
    const jwt = readField(fields, "jwt");
    if (!jwt) {
      return undefined;
    }
    return {
      mailboxRef: encodeCloudflareTempMailboxRef(input.instance.id, {
        address: emailAddress,
        jwt,
      }),
    };
  }

  if (input.providerTypeKey === "mailtm") {
    const token = readField(fields, "token");
    const password = readField(fields, "password");
    if (!token || !password) {
      return undefined;
    }
    return {
      mailboxRef: encodeMailTmMailboxRef(input.instance.id, {
        email: emailAddress,
        token,
        password,
      }),
    };
  }

  if (input.providerTypeKey === "m2u") {
    const token = readField(fields, "token");
    const viewToken = readField(fields, "viewToken");
    if (!token || !viewToken) {
      return undefined;
    }
    const expiresAt = readField(fields, "expiresAt");
    return {
      mailboxRef: encodeM2uMailboxRef(input.instance.id, {
        email: emailAddress,
        token,
        viewToken,
        mailboxId: readField(fields, "mailboxId"),
        expiresAt,
      }),
      expiresAt,
    };
  }

  if (input.providerTypeKey === "etempmail") {
    const recoverKey = readField(fields, "recoverKey");
    if (!recoverKey) {
      return undefined;
    }
    return {
      mailboxRef: encodeEtempmailMailboxRef(input.instance.id, {
        email: emailAddress,
        recoverKey,
        mailboxId: readField(fields, "mailboxId"),
        creationTime: readField(fields, "creationTime"),
        sessionCookieHeader: readField(fields, "sessionCookieHeader"),
      }),
    };
  }

  if (input.providerTypeKey === "duckmail") {
    const token = readField(fields, "token");
    const password = readField(fields, "password");
    const accountId = readField(fields, "accountId");
    if (!token || !password || !accountId) {
      return undefined;
    }
    return {
      mailboxRef: encodeDuckMailMailboxRef(input.instance.id, {
        email: emailAddress,
        token,
        password,
        accountId,
      }),
    };
  }

  if (input.providerTypeKey === "guerrillamail") {
    const sidToken = readField(fields, "sidToken");
    const emailUser = readField(fields, "emailUser") ?? splitEmailAddress(emailAddress)?.localPart;
    if (!sidToken || !emailUser) {
      return undefined;
    }
    return {
      mailboxRef: encodeGuerrillaMailMailboxRef(input.instance.id, {
        emailAddress,
        emailUser,
        sidToken,
      }),
    };
  }

  if (input.providerTypeKey === "tempmail-lol") {
    const token = readField(fields, "token");
    if (!token) {
      return undefined;
    }
    return {
      mailboxRef: encodeTempmailLolMailboxRef(input.instance.id, {
        email: emailAddress,
        token,
      }),
    };
  }

  if (input.providerTypeKey === "temporam") {
    const identity = splitEmailAddress(emailAddress);
    const localPart = readField(fields, "localPart") ?? identity?.localPart;
    const domain = readField(fields, "domain") ?? identity?.domain;
    if (!localPart || !domain) {
      return undefined;
    }
    return {
      mailboxRef: encodeTemporamMailboxRef(input.instance.id, {
        email: emailAddress,
        localPart,
        domain,
        openedAt: readField(fields, "openedAt") ?? input.now.toISOString(),
      }),
    };
  }

  if (input.providerTypeKey === "moemail") {
    const emailId = readField(fields, "emailId");
    if (!emailId) {
      return undefined;
    }
    return {
      mailboxRef: encodeMoemailMailboxRef(input.instance.id, {
        emailId,
        email: emailAddress,
        localPart: readField(fields, "localPart"),
        domain: readField(fields, "domain"),
        credentialSetId: readField(fields, "credentialSetId"),
        credentialItemId: readField(fields, "credentialItemId"),
      }),
    };
  }

  if (input.providerTypeKey === "mail2925") {
    const accountEmail = readField(fields, "accountEmail");
    if (!accountEmail) {
      return undefined;
    }
    return {
      mailboxRef: encodeMail2925MailboxRef(input.instance.id, {
        aliasAddress: emailAddress,
        accountEmail,
        credentialSetId: readField(fields, "credentialSetId"),
        credentialItemId: readField(fields, "credentialItemId"),
        createdAt: readField(fields, "createdAt") ?? input.now.toISOString(),
      }),
    };
  }

  if (input.providerTypeKey === "gptmail") {
    return {
      mailboxRef: `gptmail:${input.instance.id}:${encodeURIComponent(emailAddress)}`,
    };
  }

  if (input.providerTypeKey === "im215") {
    const mailboxId = readField(fields, "mailboxId");
    const tempToken = readField(fields, "tempToken");
    if (!mailboxId && !tempToken) {
      return undefined;
    }
    return {
      mailboxRef: encodeIm215MailboxRef(input.instance.id, {
        address: emailAddress,
        mailboxId,
        tempToken,
      }),
    };
  }

  return undefined;
}

export function createMailboxSessionFromRecoveryFields(
  input: MailboxFieldRecoveryInput,
): MailboxFieldRecoveryResult | undefined {
  const emailAddress = normalizeEmailAddress(input.emailAddress);
  if (!emailAddress) {
    return undefined;
  }

  const resolved = buildMailboxRefFromFields({
    ...input,
    emailAddress,
  });
  if (!resolved) {
    return undefined;
  }

  return {
    strategy: "session_restore",
    session: createRecoveredSession({
      emailAddress,
      hostId: input.hostId,
      providerTypeKey: input.providerTypeKey,
      instance: input.instance,
      mailboxRef: resolved.mailboxRef,
      now: input.now,
      expiresAt: resolved.expiresAt,
    }),
    detail: "recovered_from_required_fields",
  };
}
