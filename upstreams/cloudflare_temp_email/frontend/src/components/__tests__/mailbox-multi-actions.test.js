import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { useMailBoxMultiActions } from '../useMailBoxMultiActions'

function createActions(items) {
  const data = ref(items)
  const beginLoading = vi.fn()
  const endLoading = vi.fn()
  const deleteMail = vi.fn().mockResolvedValue(undefined)
  const message = {
    error: vi.fn(),
    success: vi.fn()
  }
  const refresh = vi.fn().mockResolvedValue(undefined)
  const actions = useMailBoxMultiActions({
    data,
    beginLoading,
    endLoading,
    deleteMail,
    message,
    refresh,
    t: (key) => key
  })

  return {
    actions,
    beginLoading,
    data,
    deleteMail,
    endLoading,
    message,
    refresh
  }
}

describe('mailbox multi-actions', () => {
  it('selects and clears all visible mail items', () => {
    const { actions, data } = createActions([
      { id: 1, checked: false },
      { id: 2, checked: false }
    ])

    actions.multiActionSelectAll(true)
    expect(data.value.map((item) => item.checked)).toEqual([true, true])

    actions.multiActionSelectAll(false)
    expect(data.value.map((item) => item.checked)).toEqual([false, false])
  })

  it('reports an empty selection without deleting or refreshing', async () => {
    const { actions, beginLoading, deleteMail, endLoading, message, refresh } = createActions([
      { id: 1, checked: false }
    ])

    await actions.multiActionDeleteMail()

    expect(beginLoading).toHaveBeenCalledOnce()
    expect(message.error).toHaveBeenCalledWith('pleaseSelectMail')
    expect(deleteMail).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(endLoading).toHaveBeenCalledOnce()
    expect(actions.showMultiActionDelete.value).toBe(true)
  })

  it('deletes selected mail sequentially and reports final progress', async () => {
    const { actions, deleteMail, endLoading, message, refresh } = createActions([
      { id: 4, checked: true },
      { id: 5, checked: false },
      { id: 6, checked: true }
    ])

    await actions.multiActionDeleteMail()

    expect(deleteMail).toHaveBeenNthCalledWith(1, 4)
    expect(deleteMail).toHaveBeenNthCalledWith(2, 6)
    expect(actions.multiActionDeleteProgress.value).toEqual({ percentage: 100, tip: '2/2' })
    expect(message.success).toHaveBeenCalledWith('success')
    expect(refresh).toHaveBeenCalledOnce()
    expect(endLoading).toHaveBeenCalledOnce()
  })
})
