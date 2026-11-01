import { useEffect, useId, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";
import type { OrganizationPatch, OrganizationResult } from "./labels-api";
import { useOrganizationGate } from "./OrganizationGate";

interface Attempt { key: string; body: OrganizationPatch & { messageIds: string[] } }

export function useOrganization(onSuccess: () => void) {
  const gate = useOrganizationGate(), owner = useId();
  const [attempt, setAttempt] = useState<Attempt | null>(null), [pending, setPending] = useState(false);
  const [error, setError] = useState(""), [status, setStatus] = useState("");
  const held = useRef<Attempt | null>(null), uncertain = useRef(false), busy = useRef(false), active = useRef(false);
  const done = useRef(onSuccess); done.current = onSuccess;
  useEffect(() => { active.current = true; return () => { active.current = false; gate.release(owner); }; }, [gate.release, owner]);

  async function submit(messageIds?: string[], patch?: OrganizationPatch) {
    if (busy.current) return;
    const current = held.current ?? (messageIds?.length && patch ? { key: crypto.randomUUID(), body: { ...patch, messageIds: [...messageIds],
      ...(patch.addLabelIds ? { addLabelIds: [...patch.addLabelIds] } : {}), ...(patch.removeLabelIds ? { removeLabelIds: [...patch.removeLabelIds] } : {}) } } : null);
    if (!current) return;
    if (!gate.acquire(owner)) return;
    held.current = current; setAttempt(current); busy.current = true; setPending(true); setError(""); setStatus("");
    try {
      const result = await api<OrganizationResult>("/messages/organize", "POST", current.body, { "idempotency-key": current.key });
      if (active.current) {
        held.current = null; uncertain.current = false; setAttempt(null); gate.release(owner); setStatus(`已整理 ${result.operation.messageCount} 封邮件${result.replayed ? "（已核对原操作）" : ""}`); done.current();
      }
    } catch (failure) {
      if (active.current) {
        setError(errorMessage(failure));
        if (!uncertain.current && failure instanceof ApiError && failure.status < 500 && failure.status !== 429) {
          held.current = null; setAttempt(null); gate.release(owner);
        } else uncertain.current = true;
      }
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  return { submit, locked: attempt !== null || (gate.owner !== null && gate.owner !== owner), pending, error, status, key: attempt?.key };
}

export type OrganizationController = ReturnType<typeof useOrganization>;
