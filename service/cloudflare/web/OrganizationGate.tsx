import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

interface Gate { owner: string | null; revision: number; acquire: (owner: string) => boolean; release: (owner: string) => void; changed: () => void }
const Context = createContext<Gate | null>(null);
export function useOrganizationGate() {
  const value = useContext(Context); if (!value) throw new Error("OrganizationGateProvider is required"); return value;
}
export function OrganizationGateProvider({ children }: { children: ReactNode }) {
  const held = useRef<string | null>(null), [owner, setOwner] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const acquire = useCallback((next: string) => {
    if (held.current !== null && held.current !== next) return false;
    held.current = next; setOwner(next); return true;
  }, []);
  const release = useCallback((current: string) => {
    if (held.current === current) { held.current = null; setOwner(null); }
  }, []);
  const changed = useCallback(() => setRevision(value => value + 1), []);
  return <Context.Provider value={{ owner, revision, acquire, release, changed }}>{children}</Context.Provider>;
}
