export const MAX_PROVIDERS = 20;
export const MAILBOX_QUOTAS = { allocationsPerUser: 100, allocationRequestsPerMinute: 5, syncRequestsPerMinute: 20 } as const;
export const SEND_QUOTAS = { sendUserMinute: 3, sendUserUtcDay: 20, sendPlatformMinute: 10, sendPlatformUtcDay: 200 } as const;
