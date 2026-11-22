export interface ThreadHeaders { inReplyTo: string[]; references: string[]; limited: boolean }
export interface ThreadPlan { tokens: string[]; fallback: string | null; version: number; limited: boolean }
