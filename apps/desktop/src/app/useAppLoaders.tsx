import { invoke } from "@tauri-apps/api/core";
import { contactClient, mailAccountClient, mailMessageClient, sendQueueClient } from "./appRuntime";
import type { LegacyAccountDto, AgentServiceDto, AgentThreadDto } from "./appTypes";
import type { AppState } from "./useAppState";

export function useAppLoaders(appState: AppState) {
  const {
    setRecentCodes, setAnonymousMessages, canonicalNormalAccountIdsRef, setNormalAccounts, normalAccounts, setNormalAccountSyncByAccount, setSendQueue, setSendQueueWorkerStatus, setContacts, setAgentAccounts,
    setAgentServices, setAgentThreads,
  } = appState;
  async function loadRecentCodes(
      tempMailboxId: string | null = null,
      isCurrent: () => boolean = () => true,
    ) {
      const codes = await mailMessageClient.listRecentVerifications(tempMailboxId, 100);
      if (!isCurrent()) {
        return codes;
      }
      setRecentCodes(codes);
      return codes;
    }
  async function loadAnonymousMessages() {
      const messages = await mailMessageClient.listAnonymousMessages(true);
      setAnonymousMessages(messages);
      return messages;
    }
  async function loadNormalAccounts() {
      const accounts = await mailAccountClient.listNormalAccounts();
      canonicalNormalAccountIdsRef.current = new Set(accounts.map((account) => account.id));
      setNormalAccounts(accounts);
      return accounts;
    }
  function isCanonicalNormalAccountId(accountId: string): boolean {
      return canonicalNormalAccountIdsRef.current.has(accountId)
        || normalAccounts.some((account) => account.id === accountId);
    }
  async function loadNormalAccountSyncStatus(
      accountId: string,
      isCurrent: () => boolean = () => true,
    ) {
      const status = await mailAccountClient.getAccountSyncStatus(accountId);
      if (isCurrent()) {
        setNormalAccountSyncByAccount((current) => ({
          ...current,
          [accountId]: status,
        }));
      }
      return status;
    }
  async function loadSendQueue(isCurrent: () => boolean = () => true) {
      const response = await sendQueueClient.listSendQueueWithWorker({ limit: 25 });
      if (!isCurrent()) {
        return response.items;
      }
      setSendQueue(response.items);
      setSendQueueWorkerStatus(response.worker);
      return response.items;
    }
  async function loadContacts() {
      const rows = await contactClient.listContacts();
      setContacts(rows);
      return rows;
    }
  async function loadAgentAccounts() {
      const accounts = await invoke<LegacyAccountDto[]>("agent_list_accounts");
      setAgentAccounts(accounts);
      return accounts;
    }
  async function loadAgentServices() {
      const services = await invoke<AgentServiceDto[]>("agent_list_services");
      setAgentServices(services);
      return services;
    }
  async function loadAgentThreads() {
      const threads = await invoke<AgentThreadDto[]>("agent_list_threads");
      setAgentThreads(threads);
      return threads;
    }
  return {
    loadRecentCodes, loadAnonymousMessages, loadNormalAccounts, loadNormalAccountSyncStatus, isCanonicalNormalAccountId, loadSendQueue, loadContacts, loadAgentAccounts, loadAgentServices,
    loadAgentThreads,
  };
}

export type UseAppLoadersResult = ReturnType<typeof useAppLoaders>;
