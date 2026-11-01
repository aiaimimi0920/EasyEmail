import { createMailAliasService } from "../alias/service.js";
import type { MailAccountRepository } from "../domain/account.js";
import type { ContactRepository } from "../domain/contact.js";
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
} from "../service/account-connectivity.js";
import { createMailAccountService } from "../service/accounts.js";
import {
  createBootstrappedEasyEmailService,
  type EasyEmailBootstrapOptions,
} from "../service/bootstrap.js";
import { mergeEasyEmailRegistrySeeds } from "../service/catalog.js";
import { createContactService } from "../service/contacts.js";
import type { EasyEmailService } from "../service/easy-email-service.js";
import { ImapFlowConnectionTester } from "../service/imapflow-connection-tester.js";
import { createMailTaxonomyService } from "../service/mail-taxonomy.js";
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
  mailCredentialResolver?: MailCredentialResolver;
  mailImapConnectionTester?: MailImapConnectionTester;
}

export interface StartedEasyEmailServiceRuntime {
  config: EasyEmailServiceRuntimeConfig;
  service: EasyEmailService;
  handler: EasyEmailHttpHandler;
  server: StartedEasyEmailHttpServer;
  maintenanceLoop?: MailMaintenanceLoop;
  persistenceLoop?: MailStatePersistenceLoop;
  queryRepository?: MailStateQueryRepository;
  contactRepository?: ContactRepository;
  mailTaxonomyRepository?: MailTaxonomyRepository;
  mailAccountRepository?: MailAccountRepository;
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
    !options.contactRepository || !options.mailTaxonomyRepository || !options.mailAccountRepository
  ) && config.persistence.enabled
    ? new SqliteRelationalDatabase({
        databasePath: resolveRelationalDatabasePath(config.persistence.databasePath),
      })
    : undefined;
  const contactRepository = options.contactRepository ?? relationalDatabase;
  const mailTaxonomyRepository = options.mailTaxonomyRepository ?? relationalDatabase;
  const mailAccountRepository = options.mailAccountRepository ?? relationalDatabase;
  let handler: EasyEmailHttpHandler | undefined;
  let server: StartedEasyEmailHttpServer | undefined;
  let maintenanceLoop: MailMaintenanceLoop | undefined;
  let persistenceLoop: MailStatePersistenceLoop | undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      // Stop ingress and scheduling before taking the last snapshot.
      const drains = await Promise.allSettled([server?.close(), maintenanceLoop?.stop()]);
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
    const mailImapConnectionTester = options.mailImapConnectionTester
      ?? new ImapFlowConnectionTester();
    handler = new EasyEmailHttpHandler(
      service,
      queryRepository,
      contactRepository ? createContactService(contactRepository) : undefined,
      mailTaxonomyRepository ? createMailTaxonomyService(mailTaxonomyRepository) : undefined,
      mailAccountRepository
        ? createMailAccountService(mailAccountRepository, undefined, {
            credentialResolver: mailCredentialResolver,
            imapTester: mailImapConnectionTester,
          })
        : undefined,
    );
    server = await createEasyEmailHttpServer(handler, {
      hostname: config.hostname,
      port: config.port,
      apiKey: config.apiKey,
      corsOrigins: config.corsOrigins,
    });

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
    queryRepository,
    contactRepository,
    mailTaxonomyRepository,
    mailAccountRepository,
    close,
  };
}
