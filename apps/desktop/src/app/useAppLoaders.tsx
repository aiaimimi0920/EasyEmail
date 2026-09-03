import { invoke } from "@tauri-apps/api/core";
import { type VerificationCodeDto } from "../mail/mailSearch";
import { contactClient, mailAccountClient, sendQueueClient } from "./appRuntime";
import type { LegacyAccountDto, AgentServiceDto, AgentThreadDto, AnonymousMessageDto } from "./appTypes";
import type { AppState } from "./useAppState";

export function useAppLoaders(appState: AppState) {
  const {
    setRecentCodes, setAnonymousMessages, canonicalNormalAccountIdsRef, setNormalAccounts, normalAccounts, setSendQueue, setContacts, setAgentAccounts,
    setAgentServices, setAgentThreads,
  } = appState;
  async function loadRecentCodes(
      tempMailboxId: string | null = null,
      isCurrent: () => boolean = () => true,
    ) {
      const codes = await invoke<VerificationCodeDto[]>("verification_list_recent", {
        request: { temp_mailbox_id: tempMailboxId, limit: 100 },
      });
      if (!isCurrent()) {
        return codes;
      }
      setRecentCodes(codes);
      return codes;
    }
  async function loadAnonymousMessages() {
      const messages = await invoke<AnonymousMessageDto[]>("message_list", {
        request: { scope: "anonymous", account_id: null, include_archived: true },
      });
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
  async function loadSendQueue(isCurrent: () => boolean = () => true) {
      const rows = await sendQueueClient.listSendQueue({ limit: 25 });
      if (!isCurrent()) {
        return rows;
      }
      setSendQueue(rows);
      return rows;
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
    loadRecentCodes, loadAnonymousMessages, loadNormalAccounts, isCanonicalNormalAccountId, loadSendQueue, loadContacts, loadAgentAccounts, loadAgentServices,
    loadAgentThreads,
  };
}

export type UseAppLoadersResult = ReturnType<typeof useAppLoaders>;
