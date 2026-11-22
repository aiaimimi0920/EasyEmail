import { afterEach, describe, expect, it, vi } from "vitest";

import { Mail2925Session } from "../../src/providers/mail2925/session.js";
import type { CredentialSetDefinition } from "../../src/shared/index.js";
import type {
  Mail2925AccountCredential,
  Mail2925Config,
} from "../../src/providers/mail2925/types.js";

const CACHE_ENTRY_LIMIT = 128;

function createSessionFixture(index: number): {
  account: Mail2925AccountCredential;
  session: Mail2925Session;
} {
  const item = {
    id: "account",
    label: "Account",
    username: `account-${index}@2925.com`,
    password: "password",
  };
  const set: CredentialSetDefinition = {
    id: "accounts",
    displayName: "Accounts",
    useCases: ["generate", "poll"],
    items: [item],
  };
  const config: Mail2925Config = {
    instanceId: `mail2925-${index}`,
    namespace: `test:mail2925:bounded-cache:${index}`,
    apiBase: "https://mail.2925.com",
    credentialSets: [set],
    domain: "2925.com",
    folderName: "Inbox",
    aliasSeparator: "_",
    aliasSuffixLength: 10,
    timeoutSeconds: 20,
  };
  return {
    session: new Mail2925Session(config),
    account: {
      selection: { set, item },
      username: item.username,
      password: item.password,
      accountEmail: item.username,
      localPart: `account-${index}`,
      domain: "2925.com",
    },
  };
}

describe("mail2925 login token cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts the oldest token after reaching the bounded cache size", async () => {
    const fetchMock = vi.fn(async () => (
      new Response('{"code":200,"result":{"secLogin":false,"token":"token"}}', { status: 200 })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const fixtures = Array.from(
      { length: CACHE_ENTRY_LIMIT + 1 },
      (_, index) => createSessionFixture(index),
    );

    for (const fixture of fixtures) {
      await fixture.session.login(fixture.account);
    }
    const newestFixture = fixtures.at(-1)!;
    await newestFixture.session.login(newestFixture.account);
    expect(fetchMock).toHaveBeenCalledTimes(CACHE_ENTRY_LIMIT + 1);

    await fixtures[0].session.login(fixtures[0].account);
    expect(fetchMock).toHaveBeenCalledTimes(CACHE_ENTRY_LIMIT + 2);
  });

  it("coalesces concurrent login requests for the same credential", async () => {
    let releaseRequest!: () => void;
    const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
    const fetchMock = vi.fn(async () => {
      await requestGate;
      return new Response(
        '{"code":200,"result":{"secLogin":false,"token":"shared-token"}}',
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const fixture = createSessionFixture(10_000);

    const firstLogin = fixture.session.login(fixture.account);
    const secondLogin = fixture.session.login(fixture.account);
    const requestCount = fetchMock.mock.calls.length;
    releaseRequest();

    await expect(Promise.all([firstLogin, secondLogin])).resolves.toEqual([
      "shared-token",
      "shared-token",
    ]);
    expect(requestCount).toBe(1);
  });
});
