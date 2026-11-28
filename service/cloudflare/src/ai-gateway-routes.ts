import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { openVault, sealVault } from "./mailbox-vault";
import {
  analyzeMailWithPrivacyGuard,
  invokeChatModel,
  translateSegmentsWithGateway,
  type AiProviderKind,
  type ResolvedAiRuntimeConfig,
} from "./ai-gateway-client";
import { validateByokOrTranslationEndpoint } from "../../base/src/domain/mail-ai-privacy-guard";

interface UserAiConfigRow {
  user_id: string;
  enabled: number;
  provider: string;
  endpoint_url: string;
  model_name: string;
  credential_cipher: string | null;
  include_subject: number;
  require_consent: number;
  translation_enabled: number;
  translation_provider: string;
  translation_target_lang: string;
  revision: number;
  updated_at: number;
}

const VALID_PROVIDERS: readonly AiProviderKind[] = [
  "openai",
  "deepseek",
  "claude",
  "gemini",
  "ollama",
  "custom",
];

function vaultContext(userId: string) {
  return { id: userId, user_id: userId, provider_id: "ai-byok", purpose: "ee-ai-byok-v1" };
}

async function loadConfigRow(env: Env, userId: string): Promise<UserAiConfigRow | null> {
  try {
    return await env.DB.prepare("SELECT * FROM user_ai_configs WHERE user_id = ?")
      .bind(userId)
      .first<UserAiConfigRow>();
  } catch {
    throw new HttpError(503, "ai_schema_required");
  }
}

function toPublicDto(row: UserAiConfigRow | null, env: Env) {
  return {
    enabled: row ? row.enabled === 1 : false,
    provider: (row?.provider as AiProviderKind) ?? "openai",
    endpointUrl: row?.endpoint_url ?? "https://api.openai.com/v1",
    modelName: row?.model_name ?? "gpt-4o-mini",
    credentialConfigured: Boolean(row?.credential_cipher),
    includeSubject: row ? row.include_subject === 1 : true,
    requireConsent: row ? row.require_consent === 1 : true,
    translationEnabled: row ? row.translation_enabled === 1 : true,
    translationProvider: (row?.translation_provider === "free" ? "free" : "byok") as "byok" | "free",
    translationTargetLang: row?.translation_target_lang ?? "zh-CN",
    freeTranslateAvailable: Boolean(env.FREE_TRANSLATE_ENDPOINT?.trim()),
    revision: row?.revision ?? 0,
    updatedAt: row?.updated_at ?? null,
  };
}

async function resolveRuntimeConfig(env: Env, userId: string): Promise<ResolvedAiRuntimeConfig> {
  const row = await loadConfigRow(env, userId);
  let apiKey = "";
  if (row?.credential_cipher) {
    const opened = await openVault<{ apiKey?: string }>(env, vaultContext(userId), row.credential_cipher);
    apiKey = opened.apiKey ?? "";
  }
  return {
    enabled: row ? row.enabled === 1 : false,
    provider: VALID_PROVIDERS.includes(row?.provider as AiProviderKind)
      ? (row!.provider as AiProviderKind)
      : "openai",
    endpointUrl: row?.endpoint_url ?? "https://api.openai.com/v1",
    modelName: row?.model_name ?? "gpt-4o-mini",
    apiKey,
    includeSubject: row ? row.include_subject === 1 : true,
    requireConsent: row ? row.require_consent === 1 : true,
    translationEnabled: row ? row.translation_enabled === 1 : true,
    translationProvider: row?.translation_provider === "free" ? "free" : "byok",
    translationTargetLang: row?.translation_target_lang ?? "zh-CN",
    allowLoopback: false,
  };
}

export const isAiGatewayPath = (path: string) =>
  path === "/api/v1/ai/config" ||
  path === "/api/v1/ai/test" ||
  path === "/api/v1/ai/translate" ||
  path === "/api/v1/ai/analyze";

export async function aiGatewayRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/api/v1/ai/config" && request.method === "GET") {
    requireScope(identity, "ai:read");
    const row = await loadConfigRow(env, identity.userId);
    return json({ config: toPublicDto(row, env) });
  }

  if (path === "/api/v1/ai/config" && request.method === "PUT") {
    requireWriteScope(request, env, identity, "ai:write");
    const body = await readJson(request);
    const provider = String(body.provider ?? "openai") as AiProviderKind;
    if (!VALID_PROVIDERS.includes(provider)) throw new HttpError(400, "invalid_ai_request");
    const endpointUrl = String(body.endpointUrl ?? "").trim();
    const checked = validateByokOrTranslationEndpoint("openai_compatible", endpointUrl, false);
    if (!checked.ok || !checked.normalizedOriginAndPath) throw new HttpError(400, "invalid_ai_endpoint");
    const modelName = String(body.modelName ?? "").trim();
    if (!modelName || modelName.length > 120) throw new HttpError(400, "invalid_ai_request");
    const translationProvider = body.translationProvider === "free" ? "free" : "byok";
    const translationTargetLang = String(body.translationTargetLang ?? "zh-CN").trim() || "zh-CN";
    const current = await loadConfigRow(env, identity.userId);
    if (
      body.expectedRevision !== undefined &&
      Number(body.expectedRevision) !== (current?.revision ?? 0)
    ) {
      throw new HttpError(409, "ai_config_changed");
    }

    let cipher = current?.credential_cipher ?? null;
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      cipher = await sealVault(env, vaultContext(identity.userId), { apiKey: body.apiKey.trim() });
    } else if (body.clearApiKey === true) {
      cipher = null;
    }

    const now = unixNow();
    await env.DB.prepare(
      `INSERT INTO user_ai_configs (
        user_id, enabled, provider, endpoint_url, model_name, credential_cipher,
        include_subject, require_consent, translation_enabled, translation_provider,
        translation_target_lang, revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        enabled = excluded.enabled,
        provider = excluded.provider,
        endpoint_url = excluded.endpoint_url,
        model_name = excluded.model_name,
        credential_cipher = excluded.credential_cipher,
        include_subject = excluded.include_subject,
        require_consent = excluded.require_consent,
        translation_enabled = excluded.translation_enabled,
        translation_provider = excluded.translation_provider,
        translation_target_lang = excluded.translation_target_lang,
        revision = user_ai_configs.revision + 1,
        updated_at = excluded.updated_at`,
    )
      .bind(
        identity.userId,
        body.enabled ? 1 : 0,
        provider,
        checked.normalizedOriginAndPath,
        modelName,
        cipher,
        body.includeSubject === false ? 0 : 1,
        body.requireConsent === false ? 0 : 1,
        body.translationEnabled === false ? 0 : 1,
        translationProvider,
        translationTargetLang,
        now,
      )
      .run();

    const updated = await loadConfigRow(env, identity.userId);
    return json({ config: toPublicDto(updated, env) });
  }

  if (path === "/api/v1/ai/test" && request.method === "POST") {
    requireWriteScope(request, env, identity, "ai:execute");
    const cfg = await resolveRuntimeConfig(env, identity.userId);
    const start = Date.now();
    const out = await invokeChatModel(cfg, "You are a connectivity check.", "Reply with OK only.", 12000);
    return json({ ok: Boolean(out.trim()), latencyMs: Date.now() - start, sample: out.slice(0, 40) });
  }

  if (path === "/api/v1/ai/translate" && request.method === "POST") {
    requireWriteScope(request, env, identity, "ai:execute");
    const body = await readJson(request);
    if (!Array.isArray(body.segments) || !body.segments.every((s) => typeof s === "string")) {
      throw new HttpError(400, "invalid_translation_segments");
    }
    const cfg = await resolveRuntimeConfig(env, identity.userId);
    const result = await translateSegmentsWithGateway({
      config: cfg,
      freeEndpoint: env.FREE_TRANSLATE_ENDPOINT,
      sourceLang: typeof body.sourceLang === "string" ? body.sourceLang : "auto",
      targetLang: typeof body.targetLang === "string" ? body.targetLang : cfg.translationTargetLang,
      segments: body.segments as string[],
      folder: typeof body.folder === "string" ? body.folder : undefined,
      securityLevel:
        body.securityLevel === "danger" || body.securityLevel === "warning" ? body.securityLevel : "safe",
    });
    return json(result);
  }

  if (path === "/api/v1/ai/analyze" && request.method === "POST") {
    requireWriteScope(request, env, identity, "ai:execute");
    const body = await readJson(request);
    const task = body.task;
    if (task !== "preview" && task !== "summary" && task !== "draft" && task !== "polish") {
      throw new HttpError(400, "invalid_ai_request");
    }
    const cfg = await resolveRuntimeConfig(env, identity.userId);
    const result = await analyzeMailWithPrivacyGuard({
      config: cfg,
      task,
      subject: typeof body.subject === "string" ? body.subject : undefined,
      text: typeof body.text === "string" ? body.text : undefined,
      html: typeof body.html === "string" ? body.html : undefined,
      folder: typeof body.folder === "string" ? body.folder : undefined,
      securityLevel:
        body.securityLevel === "danger" || body.securityLevel === "warning" ? body.securityLevel : "safe",
      tone: body.tone === "friendly" ? "friendly" : "formal",
      targetLang: typeof body.targetLang === "string" ? body.targetLang : undefined,
      consentConfirmed: body.consentConfirmed === true,
    });
    return json({ result });
  }

  throw new HttpError(405, "method_not_allowed");
}
