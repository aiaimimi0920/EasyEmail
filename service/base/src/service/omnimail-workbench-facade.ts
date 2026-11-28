import type { MailAccount } from "../domain/account.js";
import type { ContactRepository } from "../domain/contact.js";
import type {
  InboxRuleActions,
  InboxRuleCandidateMessage,
} from "../domain/mail-inbox-rules.js";
import type { MailFourStageProbeReport } from "../domain/mail-provider-presets.js";
import {
  LocalMailAiGatewayService,
  type OmnimailAiPersistencePort,
} from "./mail-ai-gateway.js";
import {
  detectLocalMailProviderPreset,
  listLocalMailProviderPresets,
  runMailAccountFourStageProbe,
  type FourStageProbeDependencies,
} from "./mail-provider-diagnostics.js";
import {
  LocalWorkbenchEnhancementsService,
  type OmnimailEnhancementsPersistencePort,
} from "./mail-workbench-enhancements.js";
import { LocalMuseReadOnlyService } from "./muse-mail/muse-readonly-service.js";
import {
  LocalWorkBuddyAgentService,
  type OmnimailWorkBuddyPersistencePort,
} from "./workbuddy-agent-service.js";

export type OmnimailWorkbenchPersistencePort = OmnimailAiPersistencePort &
  OmnimailWorkBuddyPersistencePort &
  OmnimailEnhancementsPersistencePort;

export interface AdHocAccountDiagnoseInput {
  accountId?: string;
  emailAddress?: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: "tls" | "starttls";
  imapUsername?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: "tls" | "starttls";
}

export class OmnimailWorkbenchFacade {
  public readonly ai: LocalMailAiGatewayService;
  public readonly workbuddy: LocalWorkBuddyAgentService;
  public readonly muse: LocalMuseReadOnlyService;
  public readonly enhancements: LocalWorkbenchEnhancementsService;

  public constructor(
    private readonly options: {
      persistence?: OmnimailWorkbenchPersistencePort;
      getContactRepo?: () => ContactRepository | undefined;
      listRecentMessages?: () => Promise<InboxRuleCandidateMessage[]>;
      applyMessageRuleAction?: (messageId: string, actions: InboxRuleActions) => Promise<boolean>;
      getAccount?: (id: string) => Promise<MailAccount>;
      probeDeps?: FourStageProbeDependencies;
      allowWorkBuddyLoopback?: boolean;
      freeTranslateEndpoint?: string;
    } = {},
  ) {
    this.ai = new LocalMailAiGatewayService(options.freeTranslateEndpoint, options.persistence);
    this.workbuddy = new LocalWorkBuddyAgentService(
      Boolean(options.allowWorkBuddyLoopback),
      options.persistence,
    );
    this.muse = new LocalMuseReadOnlyService();
    this.enhancements = new LocalWorkbenchEnhancementsService(
      options.getContactRepo,
      options.listRecentMessages,
      options.persistence,
      options.applyMessageRuleAction,
    );
  }

  public listPresets() {
    return listLocalMailProviderPresets();
  }

  public detectPreset(email: string, probeMx = false) {
    return detectLocalMailProviderPreset(email, probeMx ? undefined : async () => []);
  }

  public async diagnoseAccount(input: AdHocAccountDiagnoseInput): Promise<MailFourStageProbeReport> {
    if (input.accountId && this.options.getAccount) {
      const saved = await this.options.getAccount(input.accountId);
      return runMailAccountFourStageProbe(saved, this.options.probeDeps ?? {});
    }
    const transient: MailAccount = {
      id: "transient-probe",
      scope: "normal",
      kind: "normal_long_lived",
      displayName: input.emailAddress || input.imapHost,
      primaryAddress: input.emailAddress || `probe@${input.imapHost}`,
      status: "configuring",
      authStatus: "missing",
      receiveStatus: "disabled",
      sendStatus: "disabled",
      listedInAllAccounts: false,
      imap: {
        protocol: "imap",
        host: input.imapHost,
        port: Number(input.imapPort || 993),
        security: input.imapSecurity === "starttls" ? "starttls" : "tls",
        username: input.imapUsername || input.emailAddress || "probe",
      },
      ...(input.smtpHost
        ? {
            smtp: {
              protocol: "smtp",
              host: input.smtpHost,
              port: Number(input.smtpPort || 465),
              security: input.smtpSecurity === "starttls" ? "starttls" : "tls",
              username: input.imapUsername || input.emailAddress || "probe",
            },
          }
        : {}),
      credentialRefs: [],
      version: 1,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    return runMailAccountFourStageProbe(transient, this.options.probeDeps ?? {});
  }

  public closeMemorySessions(): void {
    this.muse.disconnectAndWipe();
  }
}
