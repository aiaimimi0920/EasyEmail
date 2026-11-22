import { constants, existsSync, mkdirSync, type Stats } from "node:fs";
import { copyFile, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { MailRegistrySeed } from "../domain/registry.js";
import type { EasyEmailSnapshot } from "../domain/models.js";
import type { MailStateStore } from "./contracts.js";
import { encodeFileSnapshot } from "./file-snapshot-codec.js";
import { getFileSnapshotChangedRanges } from "./file-snapshot-diff.js";
import { captureFileSnapshotState } from "./file-snapshot-comparison.js";

export interface FileMailStateStoreOptions {
  filePath: string;
  maxCachedSnapshotBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && Array.isArray(value) === false;
}

function ensureArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? value as T[] : undefined;
}

function toSeed(value: unknown): MailRegistrySeed | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    providerTypes: ensureArray(value.providerTypes),
    runtimeTemplates: ensureArray(value.runtimeTemplates),
    instances: ensureArray(value.instances),
    bindings: ensureArray(value.bindings),
    strategies: ensureArray(value.strategies),
    credentialSets: ensureArray(value.credentialSets),
    credentialBindings: ensureArray(value.credentialBindings),
    sessions: ensureArray(value.sessions),
    messages: ensureArray(value.messages),
  };
}

function getParentDirectory(path: string): string | undefined {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex > 0 ? path.slice(0, separatorIndex) : undefined;
}

function ensureParentDirectory(path: string): void {
  const parentDirectory = getParentDirectory(path);
  if (parentDirectory && existsSync(parentDirectory) === false) {
    mkdirSync(parentDirectory, { recursive: true });
  }
}

export class FileMailStateStore implements MailStateStore {
  private cachedSnapshot?: Buffer;
  private cachedSnapshotState?: EasyEmailSnapshot;
  private persistedStat?: Stats;
  private cloneUnsupported = false;

  public constructor(private readonly options: FileMailStateStoreOptions) {}

  public async loadSeed(): Promise<MailRegistrySeed | undefined> {
    if (existsSync(this.options.filePath) === false) {
      return undefined;
    }

    const text = await readFile(this.options.filePath, { encoding: "utf-8" });
    return toSeed(text ? JSON.parse(text) : undefined);
  }

  public async saveSnapshot(snapshot: EasyEmailSnapshot): Promise<void> {
    ensureParentDirectory(this.options.filePath);
    // Capture before the first await, including nested in-place changes.
    const limit = this.options.maxCachedSnapshotBytes ?? 64 * 1024 * 1024;
    const state = limit > 0 ? captureFileSnapshotState(snapshot, this.cachedSnapshotState) : undefined;
    const content = state && this.cachedSnapshot && this.cachedSnapshotState
      && state === this.cachedSnapshotState ? this.cachedSnapshot : encodeFileSnapshot(state ?? snapshot);
    const destinationKnown = this.cachedSnapshot !== undefined && await this.destinationUnchanged();
    if (destinationKnown && this.cachedSnapshot?.equals(content)) return;
    const temporaryPath = `${this.options.filePath}.tmp`;
    if (!destinationKnown || !await this.writeClonedSnapshot(temporaryPath, content)) {
      await writeFile(temporaryPath, content);
    }
    await rename(temporaryPath, this.options.filePath);
    const persistedStat = await stat(this.options.filePath);
    this.cachedSnapshot = content.byteLength <= limit ? content : undefined;
    this.cachedSnapshotState = this.cachedSnapshot ? state : undefined;
    this.persistedStat = persistedStat;
  }

  private async writeClonedSnapshot(temporaryPath: string, content: Buffer): Promise<boolean> {
    if (this.cloneUnsupported || this.cachedSnapshot?.byteLength !== content.byteLength) return false;
    const ranges = getFileSnapshotChangedRanges(this.cachedSnapshot, content);
    if (!ranges) return false;
    try {
      await copyFile(this.options.filePath, temporaryPath, constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EXDEV", "ENOTTY"].includes(code ?? "")) {
        this.cloneUnsupported = true;
        return false;
      }
      if (code === "ENOENT") return false;
      throw error;
    }
    // Never patch an externally replaced source, including replacement during cloning.
    if (!await this.destinationUnchanged()) return false;
    const file = await open(temporaryPath, "r+");
    try {
      for (const { start, end } of ranges) {
        let offset = start;
        while (offset < end) {
          const { bytesWritten } = await file.write(content, offset, end - offset, offset);
          if (bytesWritten === 0) throw new Error("FILE_SNAPSHOT_CLONE_WRITE_FAILED");
          offset += bytesWritten;
        }
      }
    } finally {
      await file.close();
    }
    return true;
  }

  private async destinationUnchanged(): Promise<boolean> {
    try {
      const current = await stat(this.options.filePath);
      const previous = this.persistedStat;
      return previous !== undefined && current.dev === previous.dev && current.ino === previous.ino
        && current.size === previous.size && current.mtimeMs === previous.mtimeMs && current.ctimeMs === previous.ctimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

export function createFileMailStateStore(options: FileMailStateStoreOptions): FileMailStateStore {
  return new FileMailStateStore(options);
}
