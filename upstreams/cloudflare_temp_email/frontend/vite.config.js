import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'
import wasm from "vite-plugin-wasm";

function hasAnyMatch(id, patterns) {
  return patterns.some((pattern) => id.includes(pattern))
}

function getManualChunk(id) {
  const normalizedId = id.replace(/\\/g, '/')

  if (!normalizedId.includes('/node_modules/')) {
    return undefined
  }

  if (normalizedId.includes('/naive-ui/es/locales/')) {
    return undefined
  }

  if (hasAnyMatch(normalizedId, [
    '/@wangeditor/',
    '/slate/',
    '/snabbdom/',
    '/prismjs/',
  ])) {
    return 'vendor-editor'
  }

  if (hasAnyMatch(normalizedId, [
    '/naive-ui/',
    '/@css-render/',
    '/css-render/',
    '/@emotion/',
    '/@vicons/',
    '/vooks/',
    '/vdirs/',
    '/vueuc/',
    '/seemly/',
    '/treemate/',
  ])) {
    return 'vendor-ui'
  }

  if (hasAnyMatch(normalizedId, [
    '/vue-router/',
    '/vue-i18n/',
    '/@intlify/',
    '/@vueuse/',
    '/@unhead/',
    '/unhead/',
    '/hookable/',
    '/vue/',
  ])) {
    return 'vendor-vue'
  }

  if (hasAnyMatch(normalizedId, [
    '/@uppy/',
    '/jszip/',
    '/mail-parser-wasm/',
    '/postal-mime/',
    '/dompurify/',
    '/@simplewebauthn/',
    '/@fingerprintjs/',
  ])) {
    return 'vendor-mail'
  }

  return 'vendor-misc'
}

// https://vitejs.dev/config/
export default defineConfig({
  build: {
    chunkSizeWarningLimit: 900,
    outDir: './dist',
    rollupOptions: {
      output: {
        manualChunks: getManualChunk,
      },
    },
  },
  plugins: [
    vue(),
    wasm(),
    AutoImport({
      imports: [
        'vue',
        {
          'naive-ui': [
            'useMessage',
            'useNotification',
            'NButton',
            'NPopconfirm',
            'NIcon',
          ]
        }
      ]
    }),
    Components({
      resolvers: [NaiveUiResolver()]
    }),
    VitePWA({
      registerType: null,
      devOptions: {
        enabled: false
      },
      workbox: {
        disableDevLogs: true,
        globPatterns: [],
        runtimeCaching: [],
        navigateFallback: null,
        cleanupOutdatedCaches: true,
      },
      manifest: {
        name: 'Temp Email',
        short_name: 'Temp Email',
        description: 'Temp Email - Temporary Email',
        theme_color: '#ffffff',
        icons: [
          {
            src: '/logo.png',
            sizes: '192x192',
            type: 'image/png'
          }
        ]
      }
    })
  ],
  resolve: {
    alias: [
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url))
      }
    ]
  },
  define: {
    'import.meta.env.PACKAGE_VERSION': JSON.stringify(process.env.npm_package_version),
  }
})
