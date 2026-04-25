import type {
  MailAliasOutcome,
  MailAliasPlan,
  VerificationMailboxRequest,
} from "../domain/models.js";
import type { MailAliasProvider } from "./providers/contracts.js";

export interface MailAliasService {
  planAlias(request: VerificationMailboxRequest): MailAliasPlan;
  createAliasOutcome(request: VerificationMailboxRequest, now?: Date): Promise<MailAliasOutcome>;
}

export interface MailAliasServiceOptions {
  providers?: MailAliasProvider[];
}

function createNotRequestedPlan(): MailAliasPlan {
  return {
    requested: false,
    status: "not_requested",
  };
}

function createDisabledPlan(): MailAliasPlan {
  return {
    requested: true,
    status: "skipped_disabled",
  };
}

function createUnexpectedPlan(provider: MailAliasProvider, error: unknown): MailAliasPlan {
  return {
    requested: true,
    status: "failed",
    providerKey: provider.providerKey,
    failureReason: "alias_provider_plan_unexpected_error",
    failureMessage: error instanceof Error ? error.message : String(error),
  };
}

function createUnexpectedOutcome(provider: MailAliasProvider, error: unknown): MailAliasOutcome {
  return {
    requested: true,
    status: "failed",
    providerKey: provider.providerKey,
    failureReason: "alias_provider_unexpected_error",
    failureMessage: error instanceof Error ? error.message : String(error),
  };
}

function normalizePlan(provider: MailAliasProvider, plan: MailAliasPlan): MailAliasPlan {
  if (plan.status === "not_requested") {
    return {
      requested: false,
      status: "not_requested",
    };
  }

  return {
    requested: true,
    ...plan,
    providerKey: plan.providerKey ?? provider.providerKey,
  };
}

function normalizeOutcome(provider: MailAliasProvider, outcome: MailAliasOutcome): MailAliasOutcome {
  if (outcome.status === "not_requested") {
    return {
      requested: false,
      status: "not_requested",
    };
  }

  return {
    requested: true,
    ...outcome,
    providerKey: outcome.providerKey ?? provider.providerKey,
  };
}

function createOutcomeFromPlan(plan: MailAliasPlan): MailAliasOutcome {
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
      providerKey: plan.providerKey,
    };
  }

  return {
    requested: true,
    status: "failed",
    providerKey: plan.providerKey,
    failureReason: plan.failureReason,
    failureMessage: plan.failureMessage,
  };
}

export class ConfiguredMailAliasService implements MailAliasService {
  public constructor(private readonly providers: MailAliasProvider[]) {}

  public planAlias(request: VerificationMailboxRequest): MailAliasPlan {
    const now = new Date();
    if (request.includeAliasEmail !== true) {
      return createNotRequestedPlan();
    }

    let firstFailed: MailAliasPlan | undefined;
    let firstSkipped: MailAliasPlan | undefined;

    for (const provider of this.providers) {
      const plan = this.planWithProviderSafely(provider, request, now);
      if (plan.status === "will_create") {
        return plan;
      }
      if (plan.status === "failed" && !firstFailed) {
        firstFailed = plan;
      }
      if (plan.status === "skipped_disabled" && !firstSkipped) {
        firstSkipped = plan;
      }
    }

    return firstFailed ?? firstSkipped ?? createDisabledPlan();
  }

  public async createAliasOutcome(
    request: VerificationMailboxRequest,
    now: Date = new Date(),
  ): Promise<MailAliasOutcome> {
    if (request.includeAliasEmail !== true) {
      return {
        requested: false,
        status: "not_requested",
      };
    }

    let firstSkipped: MailAliasOutcome | undefined;
    let lastFailure: MailAliasOutcome | undefined;

    for (const provider of this.providers) {
      const plan = this.planWithProviderSafely(provider, request, now);
      if (plan.status === "not_requested") {
        continue;
      }

      if (plan.status === "skipped_disabled") {
        if (!firstSkipped) {
          firstSkipped = createOutcomeFromPlan(plan);
        }
        continue;
      }

      if (plan.status === "failed") {
        lastFailure = createOutcomeFromPlan(plan);
        continue;
      }

      const outcome = await this.createWithProviderSafely(provider, request, now);
      if (outcome.status === "created") {
        return outcome;
      }

      if (outcome.status === "skipped_disabled") {
        if (!firstSkipped) {
          firstSkipped = outcome;
        }
        continue;
      }

      if (outcome.status === "failed") {
        lastFailure = outcome;
      }
    }

    return lastFailure ?? firstSkipped ?? {
      requested: true,
      status: "skipped_disabled",
    };
  }

  private planWithProviderSafely(
    provider: MailAliasProvider,
    request: VerificationMailboxRequest,
    now: Date,
  ): MailAliasPlan {
    try {
      return normalizePlan(provider, provider.planAlias(request, now));
    } catch (error) {
      return createUnexpectedPlan(provider, error);
    }
  }

  private async createWithProviderSafely(
    provider: MailAliasProvider,
    request: VerificationMailboxRequest,
    now: Date,
  ): Promise<MailAliasOutcome> {
    try {
      return normalizeOutcome(provider, await provider.createAliasOutcome(request, now));
    } catch (error) {
      return createUnexpectedOutcome(provider, error);
    }
  }
}

export function createMailAliasService(options: MailAliasServiceOptions = {}): MailAliasService {
  return new ConfiguredMailAliasService([...(options.providers ?? [])]);
}

export function createDisabledMailAliasService(): MailAliasService {
  return createMailAliasService({
    providers: [],
  });
}
