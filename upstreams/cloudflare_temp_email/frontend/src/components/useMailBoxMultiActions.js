import { ref } from 'vue'

export function useMailBoxMultiActions({
  data,
  beginLoading,
  endLoading,
  deleteMail,
  message,
  refresh,
  t
}) {
  const multiActionMode = ref(false)
  const showMultiActionDownload = ref(false)
  const showMultiActionDelete = ref(false)
  const multiActionDownloadZip = ref({})
  const multiActionDeleteProgress = ref({ percentage: 0, tip: '0/0' })

  const multiActionModeClick = (enableMulti) => {
    if (enableMulti) {
      data.value.forEach((item) => {
        item.checked = false
      })
      multiActionMode.value = true
    } else {
      multiActionMode.value = false
      data.value.forEach((item) => {
        item.checked = false
      })
    }
  }

  const multiActionSelectAll = (checked) => {
    data.value.forEach((item) => {
      item.checked = checked
    })
  }

  const multiActionDeleteMail = async () => {
    try {
      beginLoading()
      const selectedMails = data.value.filter((item) => item.checked)
      if (selectedMails.length === 0) {
        message.error(t('pleaseSelectMail'))
        return
      }
      multiActionDeleteProgress.value = {
        percentage: 0,
        tip: `0/${selectedMails.length}`
      }
      for (const [index, mail] of selectedMails.entries()) {
        await deleteMail(mail.id)
        showMultiActionDelete.value = true
        multiActionDeleteProgress.value = {
          percentage: Math.floor((index + 1) / selectedMails.length * 100),
          tip: `${index + 1}/${selectedMails.length}`
        }
      }
      message.success(t('success'))
      await refresh()
    } catch (error) {
      message.error(error.message || 'error')
    } finally {
      endLoading()
      showMultiActionDelete.value = true
    }
  }

  const multiActionDownload = async () => {
    try {
      beginLoading()
      const selectedMails = data.value.filter((item) => item.checked)
      if (selectedMails.length === 0) {
        message.error(t('pleaseSelectMail'))
        return
      }
      const JSZipModule = await import('jszip')
      const JSZip = JSZipModule.default
      const zip = new JSZip()
      for (const mail of selectedMails) {
        zip.file(`${mail.id}.eml`, mail.raw)
      }
      multiActionDownloadZip.value = {
        url: URL.createObjectURL(await zip.generateAsync({ type: 'blob' })),
        filename: `mails-${new Date().toISOString().replace(/:/g, '-')}.zip`
      }
      showMultiActionDownload.value = true
    } catch (error) {
      message.error(error.message || 'error')
    } finally {
      endLoading()
    }
  }

  return {
    multiActionMode,
    showMultiActionDownload,
    showMultiActionDelete,
    multiActionDownloadZip,
    multiActionDeleteProgress,
    multiActionModeClick,
    multiActionSelectAll,
    multiActionDeleteMail,
    multiActionDownload
  }
}
