export interface RetentionPolicy {
  enabled: boolean; mailboxDays: number; cacheDays: number; trashDays: number; outgoingDays: number; auditDays: number;
}
export interface RetentionRun {
  id: string; revision: number; trigger: string; startedAt: number; completedAt: number; batchLimit: number;
  counts: Record<string, number>; upstreamChanged: boolean;
}
export interface NormalObjectCleanup { available: boolean; pending: number; batchLimit: number }
export interface RetentionState { policy: RetentionPolicy; revision: number; updatedAt: number | null; lastRun: RetentionRun | null; normalObjects?: NormalObjectCleanup }
export interface RetentionPreview { counts: Record<string, number>; more: Record<string, boolean>; checkedAt: number; batchLimit: number }
export const retentionFields = {
  mailboxDays: "新邮箱平台期限（天）", cacheDays: "缓存保留（天）", trashDays: "回收站保留（天）",
  outgoingDays: "发送内容保留（天）", auditDays: "供应商审计保留（天）",
} as const;
export const retentionCounts: Record<string, string> = {
  expiredMailboxes: "到期邮箱凭据", purgedMessages: "邮件缓存", redactedOutgoing: "发送内容", prunedAudit: "供应商审计",
  purgedNormalMessages: "普通邮箱缓存", retiredNormalBatches: "普通收件遗留写入",
};
