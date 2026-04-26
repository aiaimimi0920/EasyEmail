<script setup>
import { useScopedI18n } from '@/i18n/app'
import { defineAsyncComponent, onMounted, ref } from 'vue'
import AdminContact from '../common/AdminContact.vue'

import { useGlobalState } from '../../store'
import { api } from '../../api'

const RichMailEditor = defineAsyncComponent(() => import('../../components/RichMailEditor.vue'))
const message = useMessage()
const isPreview = ref(false)
const sending = ref(false)


const { settings, sendMailModel, indexTab, userSettings } = useGlobalState()

const { t } = useScopedI18n('views.index.SendMail')

const contentTypes = [
    { label: t('text'), value: 'text' },
    { label: t('html'), value: 'html' },
    { label: t('rich text'), value: 'rich' },
]

const normalizeSendMailText = (content) => {
    return content
        .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

const hasSendMailContent = (content, contentType) => {
    if (typeof content !== 'string' || !content) {
        return false
    }

    if (contentType === 'text') {
        return normalizeSendMailText(content).length > 0
    }

    const container = document.createElement('div')
    container.innerHTML = content
    container.querySelectorAll('script, style, noscript, template').forEach((node) => node.remove())

    const plainContent = normalizeSendMailText(container.textContent ?? '')
    if (plainContent.length > 0) {
        return true
    }

    return Boolean(container.querySelector('img, audio, video, iframe, svg, canvas, table'))
}

const send = async () => {
    if (sending.value) {
        return
    }

    const subject = `${sendMailModel.value.subject ?? ''}`.trim()
    const toMail = `${sendMailModel.value.toMail ?? ''}`.trim()
    const content = `${sendMailModel.value.content ?? ''}`

    if (!subject) {
        message.error(t('subjectEmpty'))
        return
    }
    if (!toMail) {
        message.error(t('toMailEmpty'))
        return
    }
    if (!hasSendMailContent(content, sendMailModel.value.contentType)) {
        message.error(t('contentEmpty'))
        return
    }

    const payload = {
        from_name: sendMailModel.value.fromName,
        to_name: sendMailModel.value.toName,
        to_mail: toMail,
        subject,
        is_html: sendMailModel.value.contentType != 'text',
        content,
    }

    sending.value = true
    try {
        await api.fetch(`/api/send_mail`,
            {
                method: 'POST',
                body: JSON.stringify(payload)
            })
        sendMailModel.value = {
            fromName: "",
            toName: "",
            toMail: "",
            subject: "",
            contentType: 'text',
            content: "",
        }
        isPreview.value = false
        message.success(t("successSend"));
        indexTab.value = 'sendbox'
    } catch (error) {
        message.error(error.message || "error");
    } finally {
        sending.value = false
    }
}

const requestAccess = async () => {
    try {
        await api.fetch(`/api/request_send_mail_access`,
            {
                method: 'POST',
                body: JSON.stringify({})
            }
        )
        message.success(t("success"))
        await api.getSettings();
    } catch (error) {
        message.error(error.message || "error");
    }
}

onMounted(async () => {
    // make sure user_id is fetched
    if (!userSettings.value.user_id) await api.getUserSettings(message);
    await api.getSettings();
})
</script>

<template>
    <div class="center" v-if="settings.address">
        <n-card :bordered="false" embedded>
            <div v-if="!settings.send_balance || settings.send_balance <= 0">
                <n-alert type="warning" :show-icon="false" :bordered="false">
                    {{ t('requestAccessTip') }}
                    <n-button type="primary" tertiary @click="requestAccess" size="small">{{ t('requestAccess')
                        }}</n-button>
                </n-alert>
                <AdminContact />
            </div>
            <div v-else>
                <n-alert type="info" :show-icon="false" :bordered="false" closable>
                    {{ t('send_balance') }}: {{ settings.send_balance }}
                </n-alert>
                <n-flex justify="end">
                    <n-button type="primary" :loading="sending" :disabled="sending" @click="send">{{ t('send') }}</n-button>
                </n-flex>
                <div class="left">
                    <n-form :model="sendMailModel">
                        <n-form-item :label="t('fromName')" label-placement="top">
                            <n-input-group>
                                <n-input v-model:value="sendMailModel.fromName" />
                                <n-input :value="settings.address" disabled />
                            </n-input-group>
                        </n-form-item>
                        <n-form-item :label="t('toName')" label-placement="top">
                            <n-input-group>
                                <n-input v-model:value="sendMailModel.toName" />
                                <n-input v-model:value="sendMailModel.toMail" />
                            </n-input-group>
                        </n-form-item>
                        <n-form-item :label="t('subject')" label-placement="top">
                            <n-input v-model:value="sendMailModel.subject" />
                        </n-form-item>
                        <n-form-item :label="t('options')" label-placement="top">
                            <n-radio-group v-model:value="sendMailModel.contentType">
                                <n-radio-button v-for="option in contentTypes" :key="option.value" :value="option.value"
                                    :label="option.label" />
                            </n-radio-group>
                            <n-button v-if="sendMailModel.contentType != 'text'" @click="isPreview = !isPreview"
                                style="margin-left: 10px;">
                                {{ isPreview ? t('edit') : t('preview') }}
                            </n-button>
                        </n-form-item>
                        <n-form-item :label="t('content')" label-placement="top">
                            <n-card :bordered="false" embedded v-if="isPreview">
                                <div v-html="sendMailModel.content" />
                            </n-card>
                            <RichMailEditor v-else-if="sendMailModel.contentType == 'rich'"
                                v-model="sendMailModel.content" :too-large-message="t('tooLarge')" />
                            <n-input v-else type="textarea" v-model:value="sendMailModel.content" :autosize="{
                                minRows: 3
                            }" />
                        </n-form-item>
                    </n-form>
                </div>
            </div>
        </n-card>
    </div>
</template>

<style scoped>
.n-card {
    max-width: 800px;
}

.n-button {
    text-align: left;
    margin-right: 10px;
}

.center {
    display: flex;
    text-align: center;
    place-items: center;
    justify-content: center;
}

.left {
    text-align: left;
    place-items: left;
    justify-content: left;
}

.n-alert {
    margin-bottom: 10px;
}
</style>
