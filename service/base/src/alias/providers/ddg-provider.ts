import { EasyEmailError } from "../../domain/errors.js";
import type {
  MailAliasOutcome,
  MailAliasPlan,
  VerificationMailboxRequest,
} from "../../domain/models.js";
import { DdgAliasClient } from "../ddg/client.js";
import { createDdgAliasKeyPool, type DdgAliasKeyPool } from "../ddg/key-pool.js";
import type { MailAliasProvider } from "./contracts.js";

export interface DdgMailAliasProviderOptions {
  enabled?: boolean;
  apiBaseUrl?: string;
  tokens?: string[];
  dailyLimit?: number;
  cooldownMs?: number;
  stateFilePath?: string;
  fetchImpl?: typeof fetch;
}

function createNotRequestedPlan(): MailAliasPlan {
  return {
    requested: false,
    status: "not_requested",
  };
}

function createSkippedDisabledPlan(): MailAliasPlan {
  return {
    requested: true,
    status: "skipped_disabled",
    providerKey: "ddg",
  };
}

function createMissingTokenPlan(): MailAliasPlan {
  return {
    requested: true,
    status: "failed",
    providerKey: "ddg",
    failureReason: "ddg_token_missing",
    failureMessage: "DDG alias provider is enabled but no token is configured in aliasEmail.providers.",
  };
}

function createUnavailableTokenPlan(message: string): MailAliasPlan {
  return {
    requested: true,
    status: "failed",
    providerKey: "ddg",
    failureReason: "ddg_no_available_token",
    failureMessage: message,
  };
}

function mapAliasFailureReason(error: unknown): string {
  if (error instanceof EasyEmailError && error.code === "DDG_ALIAS_INVALID_RESPONSE") {
    return "ddg_invalid_response";
  }

  if (error instanceof EasyEmailError && error.code === "DDG_ALIAS_REQUEST_FAILED") {
    return "ddg_request_failed";
  }

  return "ddg_request_failed";
}

export class DdgMailAliasProvider implements MailAliasProvider {
  public readonly providerKey = "ddg" as const;

  private readonly enabled: boolean;

  private readonly ddgApiBaseUrl: string;

  private readonly fetchImpl?: typeof fetch;

  private readonly keyPool: DdgAliasKeyPool;

  private operationQueue: Promise<void> = Promise.resolve();

  public constructor(options: DdgMailAliasProviderOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.ddgApiBaseUrl = options.apiBaseUrl?.trim() || "https://quack.duckduckgo.com";
    this.fetchImpl = options.fetchImpl;
    this.keyPool = createDdgAliasKeyPool({
      tokens: options.tokens ?? [],
      dailyLimit: options.dailyLimit,
      errorCooldownMs: options.cooldownMs,
      stateFilePath: options.stateFilePath,
    });
  }

  public planAlias(request: VerificationMailboxRequest, now: Date = new Date()): MailAliasPlan {
    if (request.includeAliasEmail !== true) {
      return createNotRequestedPlan();
    }

    if (!this.enabled) {
      return createSkippedDisabledPlan();
    }

    const availability = this.keyPool.getAvailability(now);
    if (!availability.hasConfiguredTokens) {
      return createMissingTokenPlan();
    }

    if (!availability.hasAvailableTokens) {
      return createUnavailableTokenPlan(availability.message || "No DDG alias token is currently available.");
    }

    return {
      requested: true,
      status: "will_create",
      providerKey: this.providerKey,
    };
  }

  public async createAliasOutcome(
    request: VerificationMailboxRequest,
    now: Date = new Date(),
  ): Promise<MailAliasOutcome> {
    return this.runSerialized(async () => {
      const plan = this.planAlias(request, now);

      if (plan.status === "not_requested") {
        return {
          requested: false,
          status: "not_requested",
        };
      }

      if (plan.status === "skipped_disabled") {
        return {
          requested: true,
          status: "skipped_disabled",
          providerKey: this.providerKey,
        };
      }

      if (plan.status === "failed") {
        return {
          requested: true,
          status: "failed",
          providerKey: this.providerKey,
          failureReason: plan.failureReason,
          failureMessage: plan.failureMessage,
        };
      }

      const attemptedTokenIds = new Set<string>();
      let lastFailure:
        | {
            failureReason: string;
            failureMessage: string;
          }
        | undefined;

      while (true) {
        const selection = this.keyPool.selectToken(now, attemptedTokenIds);
        if (!selection) {
          if (lastFailure) {
            return {
              requested: true,
              status: "failed",
              providerKey: this.providerKey,
              failureReason: lastFailure.failureReason,
              failureMessage: lastFailure.failureMessage,
            };
          }

          const availability = this.keyPool.getAvailability(now);
          return {
            requested: true,
            status: "failed",
            providerKey: this.providerKey,
            failureReason: "ddg_no_available_token",
            failureMessage: availability.message || "No DDG alias token is currently available.",
          };
        }

        try {
          const client = new DdgAliasClient({
            apiBaseUrl: this.ddgApiBaseUrl,
            token: selection.token,
            fetchImpl: this.fetchImpl,
          });
          const alias = await client.createAlias(now);
          await this.keyPool.recordSuccess(selection.tokenId, now);
          return {
            requested: true,
            status: "created",
            providerKey: this.providerKey,
            alias,
          };
        } catch (error) {
          const failureReason = mapAliasFailureReason(error);
          const failureMessage = error instanceof Error ? error.message : String(error);
          await this.keyPool.recordFailure(selection.tokenId, {
            reason: failureReason,
            message: failureMessage,
            now,
          });
          attemptedTokenIds.add(selection.tokenId);
          lastFailure = {
            failureReason,
            failureMessage,
          };
        }
      }
    });
  }

  private runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: () => void = () => {};
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    return previous.then(async () => {
      try {
        return await task();
      } finally {
        release();
      }
    });
  }
}

export function createDdgMailAliasProvider(options: DdgMailAliasProviderOptions = {}): DdgMailAliasProvider {
  return new DdgMailAliasProvider(options);
}
