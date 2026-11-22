import { createMailAliasService } from "../alias/service.js";
import type { MailAccountRepository } from "../domain/account.js";
import type { ContactRepository } from "../domain/contact.js";
import type { MailAgentRepository } from "../domain/mail-agent.js";
import type { MailExtensionsRepository } from "../domain/mail-extensions.js";
import type {
  MailImapRepository,
  MailImapTransport,
} from "../domain/mail-imap-sync.js";
import type {
  MailMessageRepository,
  MailVerificationRepository,
} from "../domain/mail-message.js";
import type { MailSendQueueRepository } from "../domain/mail-send-queue.js";
import type { MailTaxonomyRepository } from "../domain/mail-taxonomy.js";
import { EasyEmailHttpHandler } from "../http/handler.js";
import { createEasyEmailHttpServer, type StartedEasyEmailHttpServer } from "../http/server.js";
import type { MailStateDatabase, MailStateQueryRepository, MailStateStore } from "../persistence/contracts.js";
import {
  createMailStateQueryRepositoryFromRuntimeConfig,
  createMailStateStoreFromRuntimeConfig,
} from "../persistence/factory.js";
import {
  resolveRelationalDatabasePath,
  SqliteRelationalDatabase,
} from "../persistence/relational/database.js";
import type {
  MailCredentialResolver,
  MailImapConnectionTester,
  MailSmtpTransport,
} from "../service/account-connectivity.js";
import { createMailAccountService } from "../service/accounts.js";
import {
  createBootstrappedEasyEmailService,
  type EasyEmailBootstrapOptions,
} from "../service/bootstrap.js";
import { mergeEasyEmailRegistrySeeds } from "../service/catalog.js";
import { createContactService } from "../service/contacts.js";
import type { EasyEmailService } from "../service/easy-email-service.js";
import { ImapFlowTransport } from "../service/imap-transport.js";
import { createMailAgentService } from "../service/mail-agent.js";
import { createMailExtensionsService } from "../service/mail-extensions.js";
import { createMailImapService } from "../service/mail-imap-sync.js";
import { createMailMessageService } from "../service/mail-messages.js";
import { createMailPromotionService } from "../service/mail-promotion.js";
import { createMailSendQueueService } from "../service/mail-send-queue.js";
import { createMailTaxonomyService } from "../service/mail-taxonomy.js";
import { createMailVerificationService } from "../service/mail-verifications.js";
import { NodeSmtpTransport } from "../service/smtp-transport.js";
import { createAliasProvidersFromRuntimeConfig } from "./alias-provider-config.js";
import { configureCloudflareTempEmailProviderInstance } from "./cloudflare-temp-email-config.js";
import {
  loadEasyEmailServiceRuntimeConfigFromEnvironment,
  type EasyEmailServiceRuntimeConfig,
} from "./config.js";
import { createDesktopCredentialBrokerResolverFromEnvironment } from "./desktop-credential-broker.js";
import {
  configureIm215ProviderInstance,
  configureM2uProviderInstance,
  configureMail2925ProviderInstance,
  configureMoemailProviderInstance,
  configureTempmailLolProviderInstance,
  configureTemporamProviderInstance,
} from "./external-provider-config.js";
import { configureGptMailProviderInstance } from "./gptmail-provider-config.js";
import { startMailMaintenanceLoop, type MailMaintenanceLoop } from "./maintenance-loop.js";
import { startMailStatePersistenceLoop, type MailStatePersistenceLoop } from "./persistence-loop.js";
import { startMailSendQueueLoop, type MailSendQueueLoop } from "./send-queue-loop.js";
import {
  configureDefaultStrategyProfile,
  configureProviderAvailability,
  ensureDefaultProviderCatalog,
} from "./provider-catalog-config.js";

export interface EasyEmailServiceRuntimeOptions extends EasyEmailBootstrapOptions {
  config?: EasyEmailServiceRuntimeConfig;
  stateStore?: MailStateStore;
  queryRepository?: MailStateQueryRepository;
  databaseState?: MailStateDatabase;
  contactRepository?: ContactRepository;
  mailTaxonomyRepository?: MailTaxonomyRepository;
  mailAccountRepository?: MailAccountRepository;
  mailMessageRepository?: MailMessageRepository;
  mailVerificationRepository?: MailVerificationRepository;
  mailSendQueueRepository?: MailSendQueueRepository;
  mailImapRepository?: MailImapRepository;
  mailExtensionsRepository?: MailExtensionsRepository;
  mailAgentRepository?: MailAgentRepository;
  mailCredentialResolver?: MailCredentialResolver;
  mailImapConnectionTester?: MailImapConnectionTester;
  mailImapTransport?: MailImapTransport;
  mailSmtpTransport?: MailSmtpTransport;
  sendQueueWorkerEnabled?: boolean;
  sendQueueWorkerIntervalMs?: number;
}

export interface StartedEasyEmailServiceRuntime {
  config: EasyEmailServiceRuntimeConfig;
  service: EasyEmailService;
  handler: EasyEmailHttpHandler;
  server: StartedEasyEmailHttpServer;
  maintenanceLoop?: MailMaintenanceLoop;
  persistenceLoop?: MailStatePersistenceLoop;
  sendQueueLoop?: MailSendQueueLoop;
  queryRepository?: MailStateQueryRepository;
  contactRepository?: ContactRepository;
  mailTaxonomyRepository?: MailTaxonomyRepository;
  mailAccountRepository?: MailAccountRepository;
  mailMessageRepository?: MailMessageRepository;
  mailVerificationRepository?: MailVerificationRepository;
  mailSendQueueRepository?: MailSendQueueRepository;
  mailImapRepository?: MailImapRepository;
  mailExtensionsRepository?: MailExtensionsRepository;
  mailAgentRepository?: MailAgentRepository;
  close(): Promise<void>;
}

function isQueryRepository(value: unknown): value is MailStateQueryRepository {
  if (!value || typeof value !== "object") {
    return false;
  }

  return [
    "listProviderInstances",
    "listHostBindings",
    "listMailboxSessions",
    "listObservedMessages",
    "getStats",
  ].every((key) => typeof (value as Record<string, unknown>)[key] === "function");
}

export async function startEasyEmailServiceRuntime(
  options: EasyEmailServiceRuntimeOptions = {},
): Promise<StartedEasyEmailServiceRuntime> {
  const config = options.config ?? await loadEasyEmailServiceRuntimeConfigFromEnvironment(process.env);
  const stateStore = options.stateStore ?? createMailStateStoreFromRuntimeConfig({
    config: config.persistence,
    database: options.databaseState,
  });
  const queryRepository = options.queryRepository
    ?? (isQueryRepository(stateStore) ? stateStore : undefined)
    ?? createMailStateQueryRepositoryFromRuntimeConfig({
      config: config.persistence,
      database: options.databaseState,
    });
  const persistedSeed = stateStore ? await stateStore.loadSeed() : undefined;
  const service = createBootstrappedEasyEmailService({
    ...options,
    strictProviderMode: config.strictProviderMode,
    defaultStrategyMode: config.defaultStrategyMode,
    routingProfiles: config.routingProfiles,
    aliasService: options.aliasService ?? createMailAliasService({
      providers: createAliasProvidersFromRuntimeConfig(config),
    }),
    registrySeed: mergeEasyEmailRegistrySeeds(persistedSeed, options.registrySeed),
  });
  ensureDefaultProviderCatalog(service, new Date());
  configureDefaultStrategyProfile(service, config);
  configureProviderAvailability(service, config);
  configureGptMailProviderInstance(service, config);
  configureTempmailLolProviderInstance(service, config);
  configureTemporamProviderInstance(service, config);
  configureM2uProviderInstance(service, config);
  configureMoemailProviderInstance(service, config);
  configureIm215ProviderInstance(service, config);
  configureMail2925ProviderInstance(service, config);
  await configureCloudflareTempEmailProviderInstance(service, config);
  service.resetOperationalState(new Date());

  const relationalDatabase = (
    !options.contactRepository
    || !options.mailTaxonomyRepository
    || !options.mailAccountRepository
    || !options.mailMessageRepository
    || !options.mailVerificationRepository
    || !options.mailSendQueueRepository
    || !options.mailImapRepository
    || !options.mailExtensionsRepository
    || !options.mailAgentRepository
  ) && config.persistence.enabled
    ? new SqliteRelationalDatabase({
        databasePath: resolveRelationalDatabasePath(config.persistence.databasePath),
      })
    : undefined;
  const contactRepository = options.contactRepository ?? relationalDatabase;
  const mailTaxonomyRepository = options.mailTaxonomyRepository ?? relationalDatabase;
  const mailAccountRepository = options.mailAccountRepository ?? relationalDatabase;
  const mailMessageRepository = options.mailMessageRepository ?? relationalDatabase;
  const mailVerificationRepository = options.mailVerificationRepository ?? relationalDatabase;
  const mailSendQueueRepository = options.mailSendQueueRepository ?? relationalDatabase;
  const mailImapRepository = options.mailImapRepository ?? relationalDatabase;
  const mailExtensionsRepository = options.mailExtensionsRepository ?? relationalDatabase;
  const mailAgentRepository = options.mailAgentRepository ?? relationalDatabase;
  let handler: EasyEmailHttpHandler | undefined;
  let server: StartedEasyEmailHttpServer | undefined;
  let maintenanceLoop: MailMaintenanceLoop | undefined;
  let persistenceLoop: MailStatePersistenceLoop | undefined;
  let sendQueueLoop: MailSendQueueLoop | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      // Stop ingress and scheduling before taking the last snapshot.
      const drains = await Promise.allSettled([
        server?.close(),
        maintenanceLoop?.stop(),
        sendQueueLoop?.stop(),
      ]);
      const errors: unknown[] = drains.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      try {
        await persistenceLoop?.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        relationalDatabase?.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) throw new AggregateError(errors, "EASY_EMAIL_SHUTDOWN_FAILED");
    })();
    return closePromise;
  };
  try {
    const mailCredentialResolver = options.mailCredentialResolver
      ?? createDesktopCredentialBrokerResolverFromEnvironment(process.env);
    const defaultImapTransport = new ImapFlowTransport();
    const mailImapTransport = options.mailImapTransport ?? defaultImapTransport;
    const mailImapConnectionTester = options.mailImapConnectionTester
      ?? defaultImapTransport;
    const mailSmtpTransport = options.mailSmtpTransport
      ?? new NodeSmtpTransport();
    const verificationService = mailMessageRepository && mailVerificationRepository
      ? createMailVerificationService(mailMessageRepository, mailVerificationRepository, undefined, {
          easyEmailService: service,
        })
      : undefined;
    const messageService = mailMessageRepository
      ? createMailMessageService(mailMessageRepository, undefined, {
          accountRepository: mailAccountRepository,
          imapRepository: mailImapRepository,
          credentialResolver: mailCredentialResolver,
          imapTransport: mailImapTransport,
          easyEmailService: service,
          verificationService,
        })
      : undefined;
    if (verificationService && messageService) {
      verificationService.setBeforeQueryHook(async () => {
        await messageService.ingestObservedMessages();
      });
    }
    const sendQueueService = mailSendQueueRepository
      ? createMailSendQueueService(mailSendQueueRepository, undefined, {
          accountRepository: mailAccountRepository,
          credentialResolver: mailCredentialResolver,
          smtpTransport: mailSmtpTransport,
          workerIntervalMs: options.sendQueueWorkerIntervalMs,
        })
      : undefined;
    const accountService = mailAccountRepository
      ? createMailAccountService(mailAccountRepository, undefined, {
          credentialResolver: mailCredentialResolver,
          imapTester: mailImapConnectionTester,
          smtpTransport: mailSmtpTransport,
        })
      : undefined;
    const mailAgentService = mailAgentRepository && accountService
      ? createMailAgentService(mailAgentRepository, accountService)
      : undefined;
    const imapService = mailImapRepository && mailAccountRepository
      ? createMailImapService(mailImapRepository, mailAccountRepository, undefined, {
          credentialResolver: mailCredentialResolver,
          imapTransport: mailImapTransport,
          verificationService,
          agentReplyAssociator: mailAgentService,
        })
      : undefined;
    const mailPromotionService = mailAccountRepository && messageService
      ? createMailPromotionService(service, mailAccountRepository, messageService, undefined, {
          flushPersistedState: async () => {
            if (persistenceLoop) {
              await persistenceLoop.flush();
            } else if (stateStore) {
              await stateStore.saveSnapshot(service.getSnapshot());
            }
          },
        })
      : undefined;
    const mailExtensionsService = mailExtensionsRepository
      ? createMailExtensionsService(mailExtensionsRepository, undefined, {
          accountRepository: mailAccountRepository,
          easyEmailService: service,
          runtimeHasApiKey: Boolean(config.apiKey),
        })
      : undefined;
    handler = new EasyEmailHttpHandler(
      service,
      queryRepository,
      contactRepository ? createContactService(contactRepository) : undefined,
      mailTaxonomyRepository ? createMailTaxonomyService(mailTaxonomyRepository) : undefined,
      accountService,
      messageService,
      verificationService,
      sendQueueService,
      imapService,
      mailPromotionService,
      mailExtensionsService,
      mailAgentService,
    );
    server = await createEasyEmailHttpServer(handler, {
      hostname: config.hostname,
      port: config.port,
      apiKey: config.apiKey,
      corsOrigins: config.corsOrigins,
    });

    sendQueueLoop = sendQueueService && options.sendQueueWorkerEnabled !== false
      ? startMailSendQueueLoop(sendQueueService, {
          intervalMs: options.sendQueueWorkerIntervalMs,
        })
      : undefined;

    maintenanceLoop = config.maintenance.enabled
      ? startMailMaintenanceLoop(service, {
          intervalMs: config.maintenance.intervalMs,
          keepRecentCount: config.maintenance.keepRecentCount,
          keepRecentSessionCount: config.maintenance.keepRecentSessionCount,
          activeProbeEnabled: config.maintenance.activeProbeEnabled,
          activeProbeIntervalMs: config.maintenance.activeProbeIntervalMs,
        })
      : undefined;

    persistenceLoop = stateStore
      ? startMailStatePersistenceLoop(service, stateStore, {
          intervalMs: config.persistence.intervalMs,
        })
      : undefined;

    if (persistenceLoop) {
      await persistenceLoop.flush();
    }
  } catch (error) {
    try {
      await close();
    } catch {
      // Preserve the startup failure after draining writers and releasing resources.
    }
    throw error;
  }

  if (!handler || !server) {
    relationalDatabase?.close();
    throw new Error("EasyEmail runtime startup completed without an HTTP handler or server.");
  }

  return {
    config,
    service,
    handler,
    server,
    maintenanceLoop,
    persistenceLoop,
    sendQueueLoop,
    queryRepository,
    contactRepository,
    mailTaxonomyRepository,
    mailAccountRepository,
    mailMessageRepository,
    mailVerificationRepository,
    mailSendQueueRepository,
    mailImapRepository,
    mailExtensionsRepository,
    mailAgentRepository,
    close,
  };
}
