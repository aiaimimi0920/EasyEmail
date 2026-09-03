import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const thisDir = dirname(fileURLToPath(import.meta.url));
const providersDir = resolve(thisDir, "../../../runtimes/userscript/src/providers");

function readProviderSource(fileName: string): string {
  return readFileSync(resolve(providersDir, fileName), "utf8");
}

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("userscript domain rotation", () => {
  it("does not pin DuckMail mailbox creation to the first provider domain", () => {
    const source = readProviderSource("duckmail.js");
    const duckmailOpenMailbox = sliceBetween(
      source,
      "async function duckmailOpenMailbox",
      "async function duckmailListMessages",
    );

    expect(duckmailOpenMailbox).not.toContain("domains[0]");
    expect(duckmailOpenMailbox).toContain("nextProviderDomain");
  });

  it("does not pin MoEmail mailbox creation to the first provider domain", () => {
    const source = readProviderSource("moemail.js");
    const moemailOpenMailbox = sliceBetween(
      source,
      "async function moemailOpenMailbox",
      "async function moemailResolveMailboxByEmail",
    );

    expect(moemailOpenMailbox).not.toContain("domains[0]");
    expect(moemailOpenMailbox).toContain("nextProviderDomain");
  });
});
