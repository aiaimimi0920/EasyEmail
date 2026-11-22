import type { MailAliasService } from "../alias/service.js";
import { EasyEmailError } from "../domain/errors.js";
import type {
  EasyEmailSnapshot,
  MailboxPlanResult,
  MailProviderTypeKey,
  MailRoutingProfileDescriptor,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "../domain/models.js";
import type { MailRegistry } from "../domain/registry.js";
import type { MailboxBindingService, MailboxDispatcher } from "../dispatch/index.js";
import type { MailProviderAdapter } from "../providers/contracts.js";
import {
  openMailboxWithPlan,
  resolveMailboxOpenCandidateProviderTypeKeys,
  shouldFallbackMailboxOpen,
} from "./mailbox.js";
import {
  attachMailboxOpenErrorContext,
  createAliasOutcomeSafely,
  isUnresolvedProviderPlanError,
  persistAliasOutcomeOnSession,
  planAliasSafely,
} from "./mailbox-open-support.js";
import { normalizeMailboxRequest } from "./mailbox-request-normalization.js";
import {
  cleanupMoemailMailboxes,
  inferMailboxCapacityRecoveryProviderType,
  type MailboxCapacityRecoveryInput,
  type MoemailMailboxCleanupResult,
} from "./moemail-mailbox-maintenance.js";
import { recordMailboxOpenFailure } from "./outcomes.js";
import { releaseMailboxSession, type MailboxReleaseResult } from "./mailbox-release.js";

export interface MailboxCapacityRecoveryResult {
  ok: boolean;
  status: string;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  action?: string;
  detail?: string;
  recovery?: unknown;
}

interface EasyEmailMailboxOperationsOptions {
  registry: MailRegistry;
  bindings: MailboxBindingService;
  dispatcher: MailboxDispatcher;
  adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>;
  routingProfiles: MailRoutingProfileDescriptor[];
  aliasService: MailAliasService;
  getSnapshot: () => EasyEmailSnapshot;
  syncOperationalState: (now?: Date) => void;
}

export class EasyEmailMailboxOperations {
  public constructor(private readonly options: EasyEmailMailboxOperationsOptions) {}

  public planMailbox(request: VerificationMailboxRequest, now: Date): MailboxPlanResult {
    this.options.syncOperationalState(now);
    const normalizedRequest = normalizeMailboxRequest(request, this.options.routingProfiles);
    return {
      ...this.options.dispatcher.resolveMailboxPlan(normalizedRequest, now, false),
      aliasPlan: planAliasSafely(this.options.aliasService, normalizedRequest),
    };
  }

  public async openMailbox(
    request: VerificationMailboxRequest,
    now: Date,
  ): Promise<VerificationMailboxOpenResult> {
    this.options.syncOperationalState(now);
    const normalizedRequest = normalizeMailboxRequest(request, this.options.routingProfiles);
    const initialPlan = this.options.dispatcher.resolveMailboxPlan(normalizedRequest, now, true);
    const candidateProviderTypeKeys = resolveMailboxOpenCandidateProviderTypeKeys(initialPlan);
    let lastError: unknown;

    for (const providerTypeKey of candidateProviderTypeKeys) {
      let plan: MailboxPlanResult | undefined;

      try {
        plan = providerTypeKey === initialPlan.providerType.key
          ? initialPlan
          : this.options.dispatcher.resolveMailboxPlan(
            {
              ...normalizedRequest,
              providerTypeKey,
              strategyProfileId: normalizedRequest.strategyProfileId ?? initialPlan.strategyMode?.strategyProfileId,
            },
            now,
            true,
          );
        const opened = await openMailboxWithPlan({
          request: normalizedRequest,
          plan,
          now,
          registry: this.options.registry,
          bindings: this.options.bindings,
          adapterMap: this.options.adapterMap,
        });

        const aliasOutcome = await createAliasOutcomeSafely(this.options.aliasService, normalizedRequest, now);
        const session = persistAliasOutcomeOnSession(this.options.registry, opened.session, aliasOutcome);

        return {
          ...opened,
          session,
          aliasOutcome,
        };
      } catch (error) {
        const normalizedError = attachMailboxOpenErrorContext(error, plan, providerTypeKey);
        if (plan) {
          recordMailboxOpenFailure(this.options.registry, plan.instance, normalizedError, now);
        }
        this.options.syncOperationalState(now);
        if (
          !plan
          && lastError !== undefined
          && !normalizedRequest.providerTypeKey
          && isUnresolvedProviderPlanError(normalizedError)
        ) {
          continue;
        }
        lastError = normalizedError;
        if (!shouldFallbackMailboxOpen(request, initialPlan, providerTypeKey)) {
          throw normalizedError;
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new EasyEmailError(
      "PROVIDER_SELECTION_FAILED",
      "Unable to open a mailbox session for any eligible provider route.",
    );
  }

  public async releaseMailbox(
    sessionId: string,
    reason: string | undefined,
    now: Date,
  ): Promise<MailboxReleaseResult> {
    return await releaseMailboxSession({
      sessionId,
      reason,
      now,
      registry: this.options.registry,
      adapterMap: this.options.adapterMap,
      syncOperationalState: (at) => this.options.syncOperationalState(at),
    });
  }

  public async recoverMailboxCapacity(
    input: MailboxCapacityRecoveryInput,
    now: Date,
  ): Promise<MailboxCapacityRecoveryResult> {
    this.options.syncOperationalState(now);

    const detail = input.detail?.trim() || undefined;
    const failureCode = input.failureCode?.trim() || undefined;
    const providerTypeKey = inferMailboxCapacityRecoveryProviderType({
      providerTypeKey: input.providerTypeKey,
      failureCode,
      detail,
    });
    const providerInstanceId = input.providerInstanceId?.trim() || undefined;

    if (providerTypeKey === "moemail") {
      const recovery = await this.cleanupMoemailMailboxes(
        input.staleAfterSeconds,
        input.maxDeleteCount,
        input.force,
        providerInstanceId,
        now,
      );
      return {
        ok: true,
        status: "provider_capacity_recovery_finished",
        providerTypeKey,
        providerInstanceId: recovery.providerInstanceId,
        action: "cleanup_mailboxes",
        detail,
        recovery,
      };
    }

    return {
      ok: false,
      status: providerTypeKey
        ? "provider_capacity_recovery_not_supported"
        : "provider_capacity_recovery_not_needed",
      providerTypeKey,
      providerInstanceId,
      detail: detail || failureCode,
    };
  }

  public async cleanupMoemailMailboxes(
    staleAfterSeconds: number,
    maxDeleteCount: number,
    force: boolean,
    providerInstanceId: string | undefined,
    now: Date,
  ): Promise<MoemailMailboxCleanupResult> {
    this.options.syncOperationalState(now);
    return await cleanupMoemailMailboxes({
      registry: this.options.registry,
      getSnapshot: this.options.getSnapshot,
      staleAfterSeconds,
      maxDeleteCount,
      force,
      providerInstanceId,
      now,
    });
  }
}
