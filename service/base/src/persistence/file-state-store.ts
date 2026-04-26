import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { MailRegistrySeed } from "../domain/registry.js";
import type { EasyEmailSnapshot } from "../domain/models.js";
import type { MailStateStore } from "./contracts.js";

export interface FileMailStateStoreOptions {
  filePath: string;
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
    const temporaryPath = `${this.options.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(snapshot), { encoding: "utf-8" });
    await rename(temporaryPath, this.options.filePath);
  }
}

export function createFileMailStateStore(options: FileMailStateStoreOptions): FileMailStateStore {
  return new FileMailStateStore(options);
}
