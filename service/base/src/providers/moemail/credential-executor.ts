import {
  markCredentialCriticalFailure,
  markCredentialFailure,
  markCredentialSuccess,
  selectCredentialItem,
  type CredentialSelection,
} from "../../shared/index.js";
import { classifyThrownError } from "./failure.js";
import { MoemailClientError, type MoemailConfig, type MoemailMailboxCredentials } from "./types.js";

export type MoemailCredentialUseCase = "generate" | "poll";

export class MoemailCredentialExecutor {
  public constructor(private readonly config: MoemailConfig) {}

  public bindMailbox(
    mailbox: MoemailMailboxCredentials,
    selection: CredentialSelection,
  ): MoemailMailboxCredentials {
    return {
      ...mailbox,
      credentialSetId: selection.set.id,
      credentialItemId: selection.item.id,
    };
  }

  public resolveBound(
    mailbox: MoemailMailboxCredentials,
    useCase: MoemailCredentialUseCase,
  ): CredentialSelection | undefined {
    const credentialSetId = mailbox.credentialSetId?.trim();
    const credentialItemId = mailbox.credentialItemId?.trim();
    if (!credentialSetId || !credentialItemId) {
      return undefined;
    }

    const set = this.config.credentialSets.find((candidate) => (
      candidate.id === credentialSetId
      && candidate.useCases.includes(useCase)
    ));
    const item = set?.items.find((candidate) => candidate.id === credentialItemId);
    return set && item ? { set, item } : undefined;
  }

  public async run<T>(
    useCase: MoemailCredentialUseCase,
    stickyKey: string | undefined,
    callback: (selection: CredentialSelection, apiKey: string) => Promise<T>,
    options: { preferredSelection?: CredentialSelection } = {},
  ): Promise<T> {
    const attempts = Math.max(1, this.countCandidateItems(useCase));
    let lastError: Error | undefined;
    const attempted = new Set<string>();

    const attemptSelection = async (selection: CredentialSelection): Promise<
      { ok: true; value: T } | { ok: false }
    > => {
      attempted.add(`${selection.set.id}:${selection.item.id}`);

      const apiKey = selection.item.value?.trim();
      if (!apiKey) {
        lastError = this.handleFailure(
          selection,
          new MoemailClientError("Selected MoEmail credential is missing key value.", "auth"),
        );
        return { ok: false };
      }

      try {
        const result = await callback(selection, apiKey);
        markCredentialSuccess(this.config.namespace, selection.set, selection.item);
        return { ok: true, value: result };
      } catch (error) {
        lastError = this.handleFailure(selection, error);
        return { ok: false };
      }
    };

    if (options.preferredSelection) {
      const preferredResult = await attemptSelection(options.preferredSelection);
      if (preferredResult.ok) {
        return preferredResult.value;
      }
    }

    for (let index = 0; index < attempts; index += 1) {
      const selection = this.select(useCase, stickyKey);
      if (!selection) {
        break;
      }
      if (attempted.has(`${selection.set.id}:${selection.item.id}`)) {
        continue;
      }

      const result = await attemptSelection(selection);
      if (result.ok) {
        return result.value;
      }
    }

    throw lastError ?? new MoemailClientError(
      `No available MoEmail credentials for ${useCase}.`,
      useCase === "generate" ? "capacity" : "transient",
    );
  }

  private countCandidateItems(useCase: MoemailCredentialUseCase): number {
    return this.config.credentialSets
      .filter((set) => set.useCases.includes(useCase))
      .reduce((sum, set) => sum + set.items.length, 0);
  }

  private select(
    useCase: MoemailCredentialUseCase,
    stickyKey?: string,
  ): CredentialSelection | undefined {
    return selectCredentialItem({
      namespace: this.config.namespace,
      sets: this.config.credentialSets,
      useCase,
      stickyKey,
    });
  }

  private handleFailure(selection: CredentialSelection, error: unknown): MoemailClientError {
    const classified = classifyThrownError(error);
    if (classified.kind === "auth") {
      markCredentialCriticalFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        error: classified.message,
      });
      return classified;
    }
    if (classified.kind === "capacity") {
      markCredentialFailure(this.config.namespace, selection.set, selection.item, {
        status: "cooling",
        cooldownMs: 2_000,
        error: classified.message,
      });
      return classified;
    }

    markCredentialFailure(this.config.namespace, selection.set, selection.item, {
      status: "cooling",
      cooldownMs: 5_000,
      error: classified.message,
    });
    return classified;
  }
}
