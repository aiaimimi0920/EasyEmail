export interface M2uConfig {
  apiBase: string;
  userAgent: string;
  userAgents?: string[];
  acceptLanguage: string;
  acceptEncoding: string;
  preferredDomain?: string;
  upstreamProxyUrl?: string;
  useEasyProxyOnCapacity?: boolean;
  easyProxyBaseUrl?: string;
  easyProxyApiKey?: string;
  easyProxyRuntimeHost?: string;
  easyProxyHostId?: string;
  easyProxyRequireDedicatedNode?: boolean;
  easyProxyMaxAttempts?: number;
  pythonCommand?: string;
}

export interface M2uMailboxCredentials {
  email: string;
  token: string;
  viewToken: string;
  mailboxId?: string;
  expiresAt?: string;
}

export interface RequestJsonOptions {
  jsonBody?: Record<string, unknown>;
}

export interface M2uProxyHelperResult {
  status?: number;
  body?: unknown;
  proxyUrl?: string;
  proxyMetadata?: Record<string, unknown>;
  helperError?: string;
}
