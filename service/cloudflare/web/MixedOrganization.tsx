import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "./api";
import type { OrganizationPatch } from "./labels-api";
import { useOrganizationGate } from "./OrganizationGate";
import { createOrganizationPlan, unfinishedGroups, type OrganizationGroup, type OrganizationTarget } from "./mixed-organization-plan";
import { executeOrganizationGroup, executeReadyGroups } from "./mixed-organization-execution";
import { MixedOrganizationStatus } from "./MixedOrganizationStatus";

interface Controller { locked: boolean; pending: boolean; submit: (targets: OrganizationTarget[], patch: OrganizationPatch) => Promise<void> }
const Context = createContext<Controller | null>(null);
export function useMixedOrganization() {
  const value = useContext(Context); if (!value) throw new Error("MixedOrganizationProvider is required"); return value;
}
export function MixedOrganizationProvider({ children }: { children: ReactNode }) {
  const gate = useOrganizationGate(), owner = useId(), held = useRef<OrganizationGroup[]>([]), busy = useRef(false), active = useRef(false);
  const [groups, setGroups] = useState<OrganizationGroup[]>([]), [pending, setPending] = useState(false), [error, setError] = useState("");
  useEffect(() => { active.current = true; return () => { active.current = false; gate.release(owner); }; }, [gate.release, owner]);
  function update(next: OrganizationGroup[]) { held.current = next; if (active.current) setGroups(next); }
  function settle(next: OrganizationGroup[]) {
    update(next); gate.changed(); if (!unfinishedGroups(next)) gate.release(owner);
  }
  async function run(kind: "ready" | "read" | "retry", id?: string, initial = held.current) {
    const group = initial.find(row => row.id === id && row.state === "unknown");
    if (kind !== "ready" && !group) return;
    if (busy.current || !gate.acquire(owner)) return;
    busy.current = true; setPending(true); setError(""); update(initial);
    try {
      let next;
      if (kind === "ready") next = await executeReadyGroups(initial, update, () => active.current);
      else {
        update(initial.map(row => row.id === id ? { ...row, state: "pending" } : row));
        const result = await executeOrganizationGroup(group!, kind === "read");
        next = initial.map(row => row.id === id ? result : row);
      }
      if (active.current) settle(next);
    } finally { busy.current = false; if (active.current) setPending(false); }
  }
  async function submit(targets: OrganizationTarget[], patch: OrganizationPatch) {
    if (busy.current || unfinishedGroups(held.current)) return;
    try { await run("ready", undefined, createOrganizationPlan(targets, patch)); }
    catch (failure) { if (active.current) setError(errorMessage(failure)); }
  }
  function skipReady() {
    if (busy.current) return;
    settle(held.current.map(group => group.state === "ready" ? { ...group, state: "skipped" } : group));
  }
  return <Context.Provider value={{ locked: unfinishedGroups(groups) || (gate.owner !== null && gate.owner !== owner), pending, submit }}>
    <MixedOrganizationStatus groups={groups} pending={pending} error={error} reconcile={id => void run("read", id)} retry={id => void run("retry", id)}
      resume={() => { if (!held.current.some(group => group.state === "unknown")) void run("ready"); }} skipReady={skipReady} />
    {children}
  </Context.Provider>;
}
