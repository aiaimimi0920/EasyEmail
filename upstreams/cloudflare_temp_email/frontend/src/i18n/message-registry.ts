import { ACCOUNT_APPEARANCE_MESSAGES } from "./messages/account-appearance-messages"
import { ACCOUNT_SHELL_MESSAGES } from "./messages/account-shell-messages"
import { ADMIN_MAIL_SECURITY_MESSAGES } from "./messages/admin-mail-security-messages"
import { ADMIN_OPERATIONS_MESSAGES } from "./messages/admin-operations-messages"
import { COMPONENT_MESSAGES } from "./messages/component-messages"
import { INDEX_WORKFLOW_MESSAGES } from "./messages/index-workflow-messages"
import { MAINTENANCE_ACCESS_MESSAGES } from "./messages/maintenance-access-messages"

export const MESSAGE_REGISTRY = {
  ...COMPONENT_MESSAGES,
  ...ACCOUNT_SHELL_MESSAGES,
  ...INDEX_WORKFLOW_MESSAGES,
  ...ADMIN_MAIL_SECURITY_MESSAGES,
  ...ADMIN_OPERATIONS_MESSAGES,
  ...ACCOUNT_APPEARANCE_MESSAGES,
  ...MAINTENANCE_ACCESS_MESSAGES,
} as const

type MessageRegistry = typeof MESSAGE_REGISTRY

export type MessageNamespace = keyof MessageRegistry
export type MessageKey<N extends MessageNamespace> = keyof MessageRegistry[N]

export const getMessageSource = <N extends MessageNamespace>(
  namespace: N,
  key: MessageKey<N>,
  locale: 'en' | 'zh',
) => {
  return MESSAGE_REGISTRY[namespace]?.[key]?.[locale]
}
