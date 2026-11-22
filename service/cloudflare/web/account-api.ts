export interface Account {
  id: string;
  username: string;
  status: "active" | "disabled";
  createdAt: number;
  revision: number;
  updatedAt: number | null;
  isAdmin: boolean;
  activeSessions: number;
  activeKeys: number;
  mailboxes: number;
}

export interface AccountAudit {
  id: string;
  actorId: string;
  userId: string;
  action: string;
  revision: number;
  createdAt: number;
}

export const accountActions: Record<string, string> = {
  disable: "停用账号",
  enable: "启用账号",
  "revoke-credentials": "撤销全部凭据",
  "password-change": "修改密码",
};
