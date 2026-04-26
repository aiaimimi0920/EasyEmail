import { dateZhCN, zhCN } from 'naive-ui'
import type { NDateLocale, NLocale } from 'naive-ui'

import type { SupportedLocale } from './locale-registry'
import { DEFAULT_LOCALE } from './utils'

export type NaiveLocaleConfig = {
  locale: NLocale
  dateLocale: NDateLocale
}

type NaiveLocaleLoader = () => Promise<NaiveLocaleConfig>

export const DEFAULT_NAIVE_LOCALE_CONFIG: NaiveLocaleConfig = {
  locale: zhCN,
  dateLocale: dateZhCN,
}

const naiveLocaleLoaders: Record<SupportedLocale, NaiveLocaleLoader> = {
  zh: async () => DEFAULT_NAIVE_LOCALE_CONFIG,
  en: async () => {
    const [{ default: locale }, { default: dateLocale }] = await Promise.all([
      import('naive-ui/es/locales/common/enUS'),
      import('naive-ui/es/locales/date/enUS'),
    ])
    return { locale, dateLocale }
  },
  es: async () => {
    const [{ default: locale }, { default: dateLocale }] = await Promise.all([
      import('naive-ui/es/locales/common/esAR'),
      import('naive-ui/es/locales/date/esAR'),
    ])
    return { locale, dateLocale }
  },
  'pt-BR': async () => {
    const [{ default: locale }, { default: dateLocale }] = await Promise.all([
      import('naive-ui/es/locales/common/ptBR'),
      import('naive-ui/es/locales/date/ptBR'),
    ])
    return { locale, dateLocale }
  },
  ja: async () => {
    const [{ default: locale }, { default: dateLocale }] = await Promise.all([
      import('naive-ui/es/locales/common/jaJP'),
      import('naive-ui/es/locales/date/jaJP'),
    ])
    return { locale, dateLocale }
  },
  de: async () => {
    const [{ default: locale }, { default: dateLocale }] = await Promise.all([
      import('naive-ui/es/locales/common/deDE'),
      import('naive-ui/es/locales/date/deDE'),
    ])
    return { locale, dateLocale }
  },
}

const naiveLocaleConfigCache = new Map<SupportedLocale, NaiveLocaleConfig>([
  [DEFAULT_LOCALE, DEFAULT_NAIVE_LOCALE_CONFIG],
])

export const loadNaiveLocaleConfig = async (locale: SupportedLocale): Promise<NaiveLocaleConfig> => {
  const cachedLocaleConfig = naiveLocaleConfigCache.get(locale)
  if (cachedLocaleConfig) {
    return cachedLocaleConfig
  }

  const localeConfig = await naiveLocaleLoaders[locale]()
  naiveLocaleConfigCache.set(locale, localeConfig)
  return localeConfig
}
