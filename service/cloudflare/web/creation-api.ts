export interface Creation {
  id: string; mailboxId: string; requestKey: string; providerId: string | null; address: string | null; addressPending?: true; requestedDomain?: string;
  state: "pending" | "unknown" | "complete"; error: string | null;
  createdAt: number; expiresAt: number | null; acknowledgedAt: number | null; retrySafe: false;
  origin?: 'created' | 'imported';
}
export const creationStateText = (state: Creation["state"]) => ({ pending: "处理中，结果未确认", unknown: "结果未知", complete: "已创建" })[state];
