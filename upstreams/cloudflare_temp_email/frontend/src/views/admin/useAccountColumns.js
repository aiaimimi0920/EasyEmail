import { computed, h } from 'vue'
import { NBadge, NButton, NMenu } from 'naive-ui'
import { MenuFilled } from '@vicons/material'

export function useAccountColumns({
  t,
  sortBy,
  sortOrder,
  adminTab,
  adminMailTabAddress,
  adminSendBoxTabAddress,
  openSettings,
  showCredential,
  curClearInboxAddressId,
  showClearInbox,
  curClearSentItemsAddressId,
  showClearSentItems,
  curResetPasswordAddressId,
  showResetPassword,
  curDeleteAddressId,
  showDeleteAccount
}) {
  return computed(() => [
    {
      type: 'selection'
    },
    {
      title: 'ID',
      key: 'id',
      sorter: true,
      sortOrder: sortBy.value === 'id' ? sortOrder.value : false
    },
    {
      title: t('name'),
      key: 'name',
      sorter: true,
      sortOrder: sortBy.value === 'name' ? sortOrder.value : false
    },
    {
      title: t('created_at'),
      key: 'created_at',
      sorter: true,
      sortOrder: sortBy.value === 'created_at' ? sortOrder.value : false
    },
    {
      title: t('updated_at'),
      key: 'updated_at',
      sorter: true,
      sortOrder: sortBy.value === 'updated_at' ? sortOrder.value : false
    },
    {
      title: t('source_meta'),
      key: 'source_meta',
      sorter: true,
      sortOrder: sortBy.value === 'source_meta' ? sortOrder.value : false,
      render(row) {
        const val = row.source_meta
        if (!val) return ''
        const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
        const ipv6Regex = /^[0-9a-fA-F:]+$/
        if (ipv4Regex.test(val) || (val.includes(':') && ipv6Regex.test(val) && !val.startsWith('tg:'))) {
          return h('a', {
            href: `https://ip.im/${val}`,
            target: '_blank',
            rel: 'noopener noreferrer'
          }, val)
        }
        return val
      }
    },
    {
      title: t('mail_count'),
      key: 'mail_count',
      sorter: true,
      sortOrder: sortBy.value === 'mail_count' ? sortOrder.value : false,
      render(row) {
        return h(NButton,
          {
            text: true,
            onClick: () => {
              if (row.mail_count > 0) {
                adminMailTabAddress.value = row.name
                adminTab.value = 'mails'
              }
            }
          },
          {
            icon: () => h(NBadge, {
              value: row.mail_count,
              'show-zero': true,
              max: 99,
              type: 'success'
            }),
            default: () => row.mail_count > 0 ? t('viewMails') : ''
          }
        )
      }
    },
    {
      title: t('send_count'),
      key: 'send_count',
      sorter: true,
      sortOrder: sortBy.value === 'send_count' ? sortOrder.value : false,
      render(row) {
        return h(NButton,
          {
            text: true,
            onClick: () => {
              if (row.send_count > 0) {
                adminSendBoxTabAddress.value = row.name
                adminTab.value = 'sendBox'
              }
            }
          },
          {
            icon: () => h(NBadge, {
              value: row.send_count,
              'show-zero': true,
              max: 99,
              type: 'success'
            }),
            default: () => row.send_count > 0 ? t('viewSendBox') : ''
          }
        )
      }
    },
    {
      title: t('actions'),
      key: 'actions',
      render(row) {
        return h('div', [
          h(NMenu, {
            mode: 'horizontal',
            options: [
              {
                label: t('actions'),
                icon: () => h(MenuFilled),
                key: 'action',
                children: [
                  {
                    label: () => h(NButton,
                      {
                        text: true,
                        onClick: () => showCredential(row.id)
                      },
                      { default: () => t('showCredential') }
                    )
                  },
                  {
                    label: () => h(NButton,
                      {
                        text: true,
                        onClick: () => {
                          adminMailTabAddress.value = row.name
                          adminTab.value = 'mails'
                        }
                      },
                      { default: () => t('viewMails') }
                    ),
                    show: row.mail_count > 0
                  },
                  {
                    label: () => h(NButton,
                      {
                        text: true,
                        onClick: () => {
                          adminSendBoxTabAddress.value = row.name
                          adminTab.value = 'sendBox'
                        }
                      },
                      { default: () => t('viewSendBox') }
                    ),
                    show: row.send_count > 0
                  },
                  {
                    label: () => h(NButton,
                      {
                        text: true,
                        onClick: () => {
                          curClearInboxAddressId.value = row.id
                          showClearInbox.value = true
                        }
                      },
                      { default: () => t('clearInbox') }
                    ),
                    show: row.mail_count > 0
                  },
                  {
                    label: () => h(NButton,
                      {
                        text: true,
                        onClick: () => {
                          curClearSentItemsAddressId.value = row.id
                          showClearSentItems.value = true
                        }
                      },
                      { default: () => t('clearSentItems') }
                    ),
                    show: row.send_count > 0
                  },
                  {
                    label: () => h(NButton,
                      {
                        text: true,
                        onClick: () => {
                          curResetPasswordAddressId.value = row.id
                          showResetPassword.value = true
                        }
                      },
                      { default: () => t('resetPassword') }
                    ),
                    show: openSettings.value?.enableAddressPassword
                  },
                  {
                    label: () => h(NButton,
                      {
                        text: true,
                        onClick: () => {
                          curDeleteAddressId.value = row.id
                          showDeleteAccount.value = true
                        }
                      },
                      { default: () => t('delete') }
                    )
                  }
                ]
              }
            ]
          })
        ])
      }
    }
  ])
}
