import type { AccountDto } from "../api/mailAccountClient.ts";
import type { TemporaryMailboxRecord } from "../mail/temporaryMailboxAdapter.ts";
import type { CoreTemporaryState } from "./appTypes.ts";

type Dependencies = {
  openMailbox: () => Promise<TemporaryMailboxRecord>;
  loadCoreTemporaryState: () => Promise<CoreTemporaryState>;
  loadNormalAccounts: () => Promise<AccountDto[]>;
  onOpened: (mailbox: TemporaryMailboxRecord) => void;
  onCoreStateLoaded: (state: CoreTemporaryState, mailbox: TemporaryMailboxRecord) => void;
  onNormalAccountsLoaded: (accounts: AccountDto[]) => void;
};

export type TemporaryMailboxCreationResult =
  | {
      status: "created";
      mailbox: TemporaryMailboxRecord;
      refreshCompletion: Promise<{ failedRefreshCount: number }>;
    }
  | {
      status: "failed";
      error: unknown;
    };

function applyLoadedValue<T>(
  result: PromiseSettledResult<T>,
  apply: (value: T) => void,
): boolean {
  if (result.status === "rejected") return false;
  try {
    apply(result.value);
    return true;
  } catch {
    return false;
  }
}

async function completeSecondaryRefreshes(
  dependencies: Dependencies,
  mailbox: TemporaryMailboxRecord,
): Promise<{ failedRefreshCount: number }> {
  const [coreStateResult, accountsResult] = await Promise.allSettled([
    Promise.resolve().then(dependencies.loadCoreTemporaryState),
    Promise.resolve().then(dependencies.loadNormalAccounts),
  ]);
  const refreshResults = [
    applyLoadedValue(coreStateResult, (state) => dependencies.onCoreStateLoaded(state, mailbox)),
    applyLoadedValue(accountsResult, dependencies.onNormalAccountsLoaded),
  ];
  return {
    failedRefreshCount: refreshResults.filter((succeeded) => !succeeded).length,
  };
}

export async function runTemporaryMailboxCreation(
  dependencies: Dependencies,
): Promise<TemporaryMailboxCreationResult> {
  let mailbox: TemporaryMailboxRecord;
  try {
    mailbox = await dependencies.openMailbox();
    dependencies.onOpened(mailbox);
  } catch (error: unknown) {
    return { status: "failed", error };
  }

  return {
    status: "created",
    mailbox,
    refreshCompletion: completeSecondaryRefreshes(dependencies, mailbox),
  };
}
