export interface Contact {
  id: string; displayName: string; emailAddress: string; note?: string; version: number; createdAt: string; updatedAt: string;
}
export interface ContactOperation { key: string; kind: string; contactId: string; version: number; deleted: boolean; completedAt: number }
export interface ContactAttempt { key: string; path: string; method: "POST" | "PATCH" | "DELETE"; body: Record<string, unknown> }
