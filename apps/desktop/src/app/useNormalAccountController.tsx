import { type AccountDto } from "../api/mailAccountClient";
import { asErrorDto, isQqMailAddress } from "./appDomain";
import { mailAccountClient } from "./appRuntime";
import { validateNormalImapAccount } from "./normalImapAccountValidation";
import type { AppState } from "./useAppState";

type Dependencies = {
  loadNormalAccounts: () => Promise<import("../api/mailAccountClient").AccountDto[]>;
};

export function useNormalAccountController(appState: AppState, dependencies: Dependencies) {
  const {
    normalDisplayName, normalEmailAddress, normalImapHost, normalImapPort, normalImapSecurity, normalImapUsername, normalImapPassword, setNormalImapPassword,
    setNormalEmailAddress, setNormalImapUsername, setNormalDisplayName, setNormalImapHost, setNormalImapPort, setNormalImapSecurity, setStatusMessage, setBusy,
    setSelectedNormalAccountId, setNormalImapTest, setError, setMailSourceId, setMailAccountPanelOpen, canonicalNormalAccountIdsRef, setNormalAccounts, selectedNormalAccountId,
  } = appState;
  const {
    loadNormalAccounts,
  } = dependencies;
  function mailboxLoginUsername() {
      return normalEmailAddress.trim().toLowerCase();
    }
  function updateMailboxAuthorizationCode(value: string) {
      setNormalImapPassword(value);
    }
  function updateNormalEmailAddress(value: string) {
      const normalizedAddress = value.trim().toLowerCase();
      setNormalEmailAddress(value);
      if (
        normalizedAddress.length > 0 &&
        (normalImapUsername.trim().length === 0 ||
          normalImapUsername === normalEmailAddress ||
          normalImapHost === "imap.qq.com")
      ) {
        setNormalImapUsername(normalizedAddress);
      }
      applyMailboxProviderDefaults(normalizedAddress);
    }
  function applyMailboxProviderDefaults(address: string, force = false) {
      if (!force && !isQqMailAddress(address)) {
        return;
      }

      setNormalDisplayName((value) =>
        value.trim().length === 0 || value.trim() === "Work" ? "QQ Mail" : value,
      );
      setNormalImapHost("imap.qq.com");
      setNormalImapPort("993");
      setNormalImapSecurity("tls");
      if (address.length > 0) {
        setNormalEmailAddress(address);
        setNormalImapUsername(address);
      }
    }
  function applyQqMailPreset() {
      const address = normalEmailAddress.trim().toLowerCase();
      applyMailboxProviderDefaults(address, true);
      setStatusMessage("已应用 QQ 邮箱预设。请使用 QQ 邮箱授权码，而不是 QQ 登录密码。");
    }
  async function testNormalImap(account: AccountDto) {
      setBusy(true);
      try {
        const result = await mailAccountClient.testImap(account);
        setSelectedNormalAccountId(account.id);
        setNormalImapTest(result);
        setStatusMessage(`IMAP connection test: ${result.capability_summary}.`);
        setError(null);
      } catch (caught: unknown) {
        setNormalImapTest(null);
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function addManualImapAccount() {
      const validation = validateNormalImapAccount({
        displayName: normalDisplayName,
        emailAddress: normalEmailAddress,
        imapHost: normalImapHost,
        imapPort: normalImapPort,
        imapSecurity: normalImapSecurity,
        imapUsername: normalImapUsername,
        imapPassword: normalImapPassword,
      });
      if (!validation.ok) {
        setNormalImapTest(null);
        setError(validation.error);
        return;
      }
      setBusy(true);
      try {
        const result = await mailAccountClient.addManualImapAccount(validation.request);
        await loadNormalAccounts();
        setSelectedNormalAccountId(result.account.id);
        setMailSourceId(`account:${result.account.id}`);
        setMailAccountPanelOpen(false);
        try {
          const testResult = await mailAccountClient.testImap(result.account);
          setNormalImapTest(testResult);
          setStatusMessage(
            `Added ${result.account.display_name}; IMAP authenticated (${testResult.capability_summary}).`,
          );
          setError(null);
        } catch (testError: unknown) {
          setNormalImapTest(null);
          setStatusMessage(
            `Added ${result.account.display_name}, but its IMAP connection test failed. The account remains available for review or deletion.`,
          );
          setError(asErrorDto(testError));
        }
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setNormalImapPassword("");
        setBusy(false);
      }
    }
  async function disableNormalAccount(account: AccountDto) {
      setBusy(true);
      try {
        const updated = await mailAccountClient.disableAccount(account);
        canonicalNormalAccountIdsRef.current.add(updated.id);
        setNormalAccounts((current) => current.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ));
        setNormalImapTest(null);
        setStatusMessage(`${updated.display_name} is disabled.`);
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  async function deleteNormalAccount(account: AccountDto) {
      if (!window.confirm(`Delete ${account.display_name}? Existing messages remain history-only.`)) {
        return;
      }
      setBusy(true);
      try {
        const result = await mailAccountClient.deleteAccount(account);
        const accounts = await loadNormalAccounts();
        if (selectedNormalAccountId === account.id) {
          const nextAccount = accounts.find((candidate) => candidate.kind === "normal_long_lived") ?? null;
          setSelectedNormalAccountId(nextAccount?.id ?? null);
          setMailSourceId(nextAccount ? `account:${nextAccount.id}` : "all");
          setNormalImapTest(null);
        }
        setStatusMessage(
          result.credential_cleanup_complete
            ? `${account.display_name} was deleted and its desktop credential was removed.`
            : `${account.display_name} was deleted, but one desktop credential could not be removed.`,
        );
        setError(null);
      } catch (caught: unknown) {
        setError(asErrorDto(caught));
      } finally {
        setBusy(false);
      }
    }
  return {
    mailboxLoginUsername, updateMailboxAuthorizationCode, updateNormalEmailAddress, applyQqMailPreset, testNormalImap, addManualImapAccount, disableNormalAccount, deleteNormalAccount,
  };
}

export type UseNormalAccountControllerResult = ReturnType<typeof useNormalAccountController>;
