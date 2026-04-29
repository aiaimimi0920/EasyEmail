/* eslint-disable no-useless-escape */
declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

import {
  createValueCredentialSetFromFile,
  markCredentialCriticalFailure,
  markCredentialFailure,
  markCredentialSuccess,
  parseCredentialSetsJson,
  selectCredentialItem,
  type CredentialItemDefinition,
  type CredentialSelection,
  type CredentialSetDefinition,
} from "../../shared/index.js";
import { extractOtpFromContent } from "../../domain/otp.js";
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";

export interface GptMailConfig {
  instanceId: string;
  namespace: string;
  baseUrl: string;
  credentialSets: CredentialSetDefinition[];
  prefix?: string;
  domain?: string;
  timeoutSeconds: number;
}

interface GptMailEnvelope {
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface GptMailEmailSummary {
  id?: string | number;
  from_address?: string;
  from?: string;
  subject?: string;
  content?: string;
  html_content?: string;
  raw_content?: string;
  received_at?: string;
  created_at?: string;
}

class GptMailClientError extends Error {
  public constructor(
    message: string,
    public readonly kind: "invalid" | "rate-limited" | "network" | "other",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GptMailClientError";
  }
}

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractCodeFromPayload(payload: Record<string, unknown>) {
  return extractOtpFromContent({
    subject: typeof payload.subject === "string" ? payload.subject : undefined,
    htmlBody: typeof payload.html_content === "string"
      ? payload.html_content
      : (typeof payload.raw_content === "string" ? payload.raw_content : undefined),
    textBody: typeof payload.content === "string" ? payload.content : undefined,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

function asSummaryList(value: unknown): GptMailEmailSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item) => item && typeof item === "object") as GptMailEmailSummary[];
}

function classifyEnvelopeFailure(status: number, errorText: string): GptMailClientError {
  const message = (errorText || `GPTMail request failed with status ${status}`).trim();
  const normalized = message.toLowerCase();
  if (status === 401 || normalized.includes("invalid api key")) {
    return new GptMailClientError(message, "invalid", status);
  }
  if (status === 403 && (normalized.includes("access denied") || normalized.includes("error 1010") || normalized.includes("cloudflare"))) {
    return new GptMailClientError(message, "network", status);
  }
  if (status === 429 || normalized.includes("quota")) {
    return new GptMailClientError(message, "rate-limited", status);
  }
  return new GptMailClientError(message, "other", status);
}

function classifyThrownError(error: unknown): GptMailClientError {
  if (error instanceof GptMailClientError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("invalid api key")) {
    return new GptMailClientError(message, "invalid");
  }
  if (normalized.includes("quota")) {
    return new GptMailClientError(message, "rate-limited");
  }
  if (
    normalized.includes("network")
    || normalized.includes("fetch failed")
    || normalized.includes("timeout")
    || normalized.includes("econnrefused")
    || normalized.includes("enotfound")
    || normalized.includes("access denied")
    || normalized.includes("error 1010")
    || normalized.includes("cloudflare")
  ) {
    return new GptMailClientError(message, "network");
  }
  return new GptMailClientError(message, "other");
}

async function requestEnvelope(
  config: GptMailConfig,
  apiKey: string,
  method: string,
  path: string,
  query?: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<GptMailEnvelope> {
  const url = new URL(path, config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        accept: "application/json, text/plain, */*",
        "X-API-Key": apiKey,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    const envelope = JSON.parse(text || "{}") as GptMailEnvelope;
    if (envelope?.success !== true) {
      throw classifyEnvelopeFailure(response.status, envelope?.error || `GPTMail request failed with status ${response.status}`);
    }

    return envelope;
  } catch (error) {
    throw classifyThrownError(error);
  }
}

function createInlineCredentialSet(apiKey: string | undefined): CredentialSetDefinition | undefined {
  if (!apiKey?.trim()) {
    return undefined;
  }

  return {
    id: "inline-default",
    displayName: "Inline GPTMail Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    items: [{ id: "inline-key", label: "Inline Key", value: apiKey.trim(), metadata: {} }],
    metadata: {},
  };
}

export function resolveGptMailCredentialSets(instance: ProviderInstance): CredentialSetDefinition[] {
  const configured = parseCredentialSetsJson(readMetadata(instance, "credentialSetsJson"));
  if (configured.length > 0) {
    return configured;
  }

  const inlineSet = createInlineCredentialSet(readMetadata(instance, "apiKey"));
  const fileSet = createValueCredentialSetFromFile(readMetadata(instance, "keysFile"), {
    id: "keys-file",
    displayName: "Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  return [inlineSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);
}

export function resolveGptMailConfig(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): GptMailConfig {
  return {
    instanceId: instance.id,
    namespace: `mail:gptmail:${instance.id}`,
    baseUrl: readMetadata(instance, "baseUrl") ?? "https://mail.chatgpt.org.uk",
    credentialSets: credentialSets && credentialSets.length > 0
      ? credentialSets
      : resolveGptMailCredentialSets(instance),
    prefix: readMetadata(instance, "prefix"),
    domain: readMetadata(instance, "domain"),
    timeoutSeconds: parseOptionalInteger(readMetadata(instance, "timeoutSeconds")) ?? 30,
  };
}

export class GptMailClient {
  public constructor(private readonly config: GptMailConfig) {}

  public static fromInstance(
    instance: ProviderInstance,
    credentialSets?: CredentialSetDefinition[],
  ): GptMailClient | undefined {
    const config = resolveGptMailConfig(instance, credentialSets);
    if (config.credentialSets.length === 0) {
      return undefined;
    }

    return new GptMailClient(config);
  }

  private countCandidateItems(useCase: "generate" | "poll"): number {
    return this.config.credentialSets
      .filter((set) => set.useCases.includes(useCase))
      .reduce((sum, set) => sum + set.items.length, 0);
  }

  private select(useCase: "generate" | "poll", stickyKey?: string): CredentialSelection | undefined {
    return selectCredentialItem({
      namespace: this.config.namespace,
      sets: this.config.credentialSets,
      useCase,
      stickyKey,
    });
  }

  private handleCredentialFailure(selection: CredentialSelection, error: unknown): GptMailClientError {
    const classified = classifyThrownError(error);
    if (classified.kind === "invalid") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        error: classified.message,
      });
      return classified;
    }
    if (classified.kind === "rate-limited") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "rate-limited",
        error: classified.message,
      });
      return classified;
    }

    if (classified.kind === "other") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        error: classified.message,
      });
      return classified;
    }

    markCredentialFailure(this.config.namespace, selection.set, selection.item, {
      status: "cooling",
      cooldownMs: classified.kind === "network" ? 30_000 : 60_000,
      error: classified.message,
    });
    return classified;
  }

  private async withCredential<T>(
    useCase: "generate" | "poll",
    stickyKey: string | undefined,
    callback: (selection: CredentialSelection, apiKey: string) => Promise<T>,
  ): Promise<T> {
    const attempts = Math.max(1, this.countCandidateItems(useCase));
    let lastError: Error | undefined;

    for (let index = 0; index < attempts; index += 1) {
      const selection = this.select(useCase, stickyKey);
      if (!selection) {
        break;
      }

      const apiKey = selection.item.value?.trim();
      if (!apiKey) {
        lastError = this.handleCredentialFailure(
          selection,
          new GptMailClientError("Selected GPTMail credential is missing key value.", "invalid"),
        );
        continue;
      }

      try {
        const result = await callback(selection, apiKey);
        markCredentialSuccess(this.config.namespace, selection.set, selection.item);
        return result;
      } catch (error) {
        lastError = this.handleCredentialFailure(selection, error);
      }
    }

    throw lastError ?? new Error(`No available GPTMail credentials for ${useCase}.`);
  }

  public async generateEmail(hostId?: string): Promise<string> {
    return this.withCredential("generate", hostId, async (_selection, apiKey) => {
      const payload: Record<string, unknown> = {};
      if (this.config.prefix) {
        payload.prefix = this.config.prefix;
      }
      if (this.config.domain) {
        payload.domain = this.config.domain;
      }

      const envelope = await requestEnvelope(this.config, apiKey, "POST", "/api/generate-email", undefined, payload);
      const data = asRecord(envelope.data);
      const email = typeof data.email === "string" ? data.email.trim() : "";

      if (!email) {
        throw new GptMailClientError("GPTMail generate-email returned an empty address.", "other");
      }

      return email;
    });
  }

  public async tryReadLatestCode(
    sessionId: string,
    email: string,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    return this.withCredential("poll", sessionId, async (_selection, apiKey) => {
      const envelope = await requestEnvelope(this.config, apiKey, "GET", "/api/emails", { email });
      const data = asRecord(envelope.data);
      const items = asSummaryList(data.emails).sort((left, right) => {
        const leftId = Number.parseInt(String(left.id ?? "0"), 10);
        const rightId = Number.parseInt(String(right.id ?? "0"), 10);
        return Number.isFinite(rightId - leftId) ? rightId - leftId : 0;
      });

      for (const item of items) {
        const sender = String(item.from_address ?? item.from ?? "").trim();
        if (fromContains && sender.toLowerCase().includes(fromContains.toLowerCase()) === false) {
          continue;
        }

        const summaryPayload = item as unknown as Record<string, unknown>;
        const summaryCode = extractCodeFromPayload(summaryPayload);
        if (summaryCode) {
          return {
            id: `gptmail:${String(item.id ?? `${sessionId}:summary`)}`,
            sessionId,
            providerInstanceId,
            observedAt: typeof item.received_at === "string"
              ? item.received_at
              : (typeof item.created_at === "string" ? item.created_at : ""),
            sender,
            subject: typeof item.subject === "string" ? item.subject : undefined,
            htmlBody: typeof item.html_content === "string" ? item.html_content : undefined,
            textBody: typeof item.content === "string" ? item.content : undefined,
            extractedCode: summaryCode.code,
            codeSource: summaryCode.source,
          };
        }

        const mailId = String(item.id ?? "").trim();
        if (!mailId) {
          continue;
        }

        const detailEnvelope = await requestEnvelope(this.config, apiKey, "GET", `/api/email/${encodeURIComponent(mailId)}`);
        const detail = asRecord(detailEnvelope.data);
        const detailCode = extractCodeFromPayload(detail);
        return {
          id: `gptmail:${mailId}`,
          sessionId,
          providerInstanceId,
          observedAt: typeof detail.received_at === "string"
            ? detail.received_at
            : (typeof detail.created_at === "string" ? detail.created_at : ""),
          sender: typeof detail.from_address === "string"
            ? detail.from_address
            : (typeof detail.from === "string" ? detail.from : sender || undefined),
          subject: typeof detail.subject === "string" ? detail.subject : undefined,
          htmlBody: typeof detail.html_content === "string"
            ? detail.html_content
            : (typeof detail.raw_content === "string" ? detail.raw_content : undefined),
          textBody: typeof detail.content === "string" ? detail.content : undefined,
          extractedCode: detailCode?.code,
          codeSource: detailCode?.source,
        };
      }

      return undefined;
    });
  }

  public async probe(): Promise<void> {
    await this.generateEmail("probe");
  }
}

export async function probeGptMailInstance(
  instance: ProviderInstance,
  credentialSets?: CredentialSetDefinition[],
): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
}> {
  const client = GptMailClient.fromInstance(instance, credentialSets);
  if (!client) {
    return {
      ok: false,
      detail: "GPTMail instance is missing credentialSets/apiKey/keysFile configuration.",
      averageLatencyMs: instance.averageLatencyMs,
    };
  }

  const startedAt = Date.now();
  try {
    await client.probe();
    return {
      ok: true,
      detail: "GPTMail provider responded successfully.",
      averageLatencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      averageLatencyMs: Date.now() - startedAt,
    };
  }
}
