import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useAccountColumns } from '../useAccountColumns'

function createColumns() {
  const state = {
    sortBy: ref(''),
    sortOrder: ref(''),
    adminTab: ref(''),
    adminMailTabAddress: ref(''),
    adminSendBoxTabAddress: ref(''),
    openSettings: ref({ enableAddressPassword: true }),
    curClearInboxAddressId: ref(0),
    showClearInbox: ref(false),
    curClearSentItemsAddressId: ref(0),
    showClearSentItems: ref(false),
    curResetPasswordAddressId: ref(0),
    showResetPassword: ref(false),
    curDeleteAddressId: ref(0),
    showDeleteAccount: ref(false)
  }
  const columns = useAccountColumns({
    ...state,
    t: (key) => key,
    showCredential: vi.fn()
  })
  return { columns, state }
}

describe('account columns', () => {
  it('keeps the account table column order and reactive sort state', () => {
    const { columns, state } = createColumns()

    expect(columns.value.map((column) => column.key ?? column.type)).toEqual([
      'selection',
      'id',
      'name',
      'created_at',
      'updated_at',
      'source_meta',
      'mail_count',
      'send_count',
      'actions'
    ])

    state.sortBy.value = 'name'
    state.sortOrder.value = 'ascend'
    expect(columns.value.find((column) => column.key === 'name').sortOrder).toBe('ascend')
  })

  it('links IP source metadata and leaves other sources unchanged', () => {
    const { columns } = createColumns()
    const render = columns.value.find((column) => column.key === 'source_meta').render

    expect(render({ source_meta: '' })).toBe('')
    expect(render({ source_meta: 'telegram' })).toBe('telegram')
    expect(render({ source_meta: 'tg:1234' })).toBe('tg:1234')

    for (const address of ['127.0.0.1', '2001:db8::1']) {
      const link = render({ source_meta: address })
      expect(link.type).toBe('a')
      expect(link.props).toMatchObject({
        href: `https://ip.im/${address}`,
        target: '_blank',
        rel: 'noopener noreferrer'
      })
    }
  })

  it('opens mailbox tabs only when the account has matching mail', () => {
    const { columns, state } = createColumns()
    const mailColumn = columns.value.find((column) => column.key === 'mail_count')
    const sendColumn = columns.value.find((column) => column.key === 'send_count')

    mailColumn.render({ name: 'empty@example.com', mail_count: 0 }).props.onClick()
    sendColumn.render({ name: 'empty@example.com', send_count: 0 }).props.onClick()
    expect(state.adminTab.value).toBe('')

    mailColumn.render({ name: 'inbox@example.com', mail_count: 1 }).props.onClick()
    expect(state.adminTab.value).toBe('mails')
    expect(state.adminMailTabAddress.value).toBe('inbox@example.com')

    sendColumn.render({ name: 'sent@example.com', send_count: 2 }).props.onClick()
    expect(state.adminTab.value).toBe('sendBox')
    expect(state.adminSendBoxTabAddress.value).toBe('sent@example.com')
  })
})
