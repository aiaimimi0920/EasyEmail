<script setup>
import '@wangeditor/editor/dist/css/style.css'
import { Editor, Toolbar } from '@wangeditor/editor-for-vue'
import { computed, onBeforeUnmount, shallowRef } from 'vue'

const props = defineProps({
    modelValue: {
        type: String,
        default: '',
    },
    tooLargeMessage: {
        type: String,
        required: true,
    },
})

const emit = defineEmits(['update:modelValue'])
const message = useMessage()
const editorRef = shallowRef()

const content = computed({
    get: () => props.modelValue,
    set: (value) => emit('update:modelValue', value),
})

const toolbarConfig = {
    excludeKeys: ['uploadVideo'],
}

const editorConfig = {
    MENU_CONF: {
        uploadImage: {
            async customUpload() {
                message.error(props.tooLargeMessage)
            },
            maxFileSize: 1 * 1024 * 1024,
            base64LimitSize: 1 * 1024 * 1024,
        },
    },
}

onBeforeUnmount(() => {
    const editor = editorRef.value
    if (editor == null) {
        return
    }

    editor.destroy()
})

const handleCreated = (editor) => {
    editorRef.value = editor
}
</script>

<template>
    <div class="rich-mail-editor">
        <Toolbar style="border-bottom: 1px solid #ccc" :defaultConfig="toolbarConfig" :editor="editorRef"
            mode="default" />
        <Editor style="height: 500px; overflow-y: hidden;" v-model="content" :defaultConfig="editorConfig"
            mode="default" @onCreated="handleCreated" />
    </div>
</template>

<style scoped>
.rich-mail-editor {
    border: 1px solid #ccc;
}
</style>
