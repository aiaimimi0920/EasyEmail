import { readFileSync } from "node:fs";
import type {
  CredentialItemDefinition,
  CredentialSelectionStrategy,
  CredentialSetDefinition,
  CredentialUseCase,
} from "./credential-models.js";

export function maskCredentialSecret(secret: string | undefined, visible = 4): string {
  const value = (secret || "").trim();
  if (!value) {
    return "";
  }
  if (value.length <= visible * 2) {
    return value;
  }
  return `${value.slice(0, visible)}...${value.slice(-visible)}`;
}

function parseValueLine(line: string, index: number): CredentialItemDefinition | undefined {
  const parts = line.split("|").map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }

  const value = parts.length === 1 ? parts[0] : parts[parts.length - 1];
  const label = parts.length === 1 ? maskCredentialSecret(value) || `item-${index + 1}` : parts[0];
  return {
    id: `item-${index + 1}`,
    label,
    value,
    metadata: {},
  };
}

function parseBasicAuthLine(line: string, index: number): CredentialItemDefinition | undefined {
  const parts = line.split("|").map((item) => item.trim()).filter(Boolean);
  if (parts.length < 2) {
    return undefined;
  }

  let label = `cred-${index + 1}`;
  let username = "";
  let password = "";

  if (parts.length >= 3) {
    [label, username, password] = [parts[0], parts[1], parts.slice(2).join("|")];
  } else {
    [username, password] = [parts[0], parts[1]];
    label = maskCredentialSecret(username) || label;
  }

  if (!username || !password) {
    return undefined;
  }

  return {
    id: `item-${index + 1}`,
    label,
    username,
    password,
    metadata: {},
  };
}

function parseProxyUrlLine(line: string, index: number): CredentialItemDefinition | undefined {
  const parts = line.split("|").map((item) => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }

  const rawUrl = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
  const explicitLabel = parts.length >= 2 ? parts[0] : undefined;

  const parsed = parseFlexibleProxyUrl(rawUrl);
  if (!parsed) {
    return undefined;
  }

  const label = explicitLabel || parsed.username || `${parsed.host}:${parsed.port}`;

  return {
    id: `item-${index + 1}`,
    label,
    username: parsed.username,
    password: parsed.password,
    metadata: {
      endpointUrl: parsed.endpointUrl,
      proxyProtocol: parsed.protocol,
      proxyHost: parsed.host,
      proxyPort: String(parsed.port),
    },
  };
}

function parseFlexibleProxyUrl(raw: string): {
  endpointUrl: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
} | undefined {
  const normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }

  const direct = tryParseProxyUrl(normalized);
  if (direct) {
    return direct;
  }

  const implicitHttp = tryParseProxyUrl(`http://${normalized}`);
  if (implicitHttp) {
    return implicitHttp;
  }

  const colonAuthMatch = normalized.match(/^([^:@\s]+):([^:@\s]+):([^:\s]+):(\d+)$/);
  if (colonAuthMatch) {
    const [, username, password, host, port] = colonAuthMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  const atPrefixMatch = normalized.match(/^([^:@\s]+):([^@\s]+)@([^:\s]+):(\d+)$/);
  if (atPrefixMatch) {
    const [, username, password, host, port] = atPrefixMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  const hostAtAuthMatch = normalized.match(/^([^:\s]+):(\d+)@([^:@\s]+):([^@\s]+)$/);
  if (hostAtAuthMatch) {
    const [, host, port, username, password] = hostAtAuthMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  const hostColonAuthMatch = normalized.match(/^([^:\s]+):(\d+):([^:@\s]+):([^@\s]+)$/);
  if (hostColonAuthMatch) {
    const [, host, port, username, password] = hostColonAuthMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  const hostDoubleHashAuthMatch = normalized.match(/^([^:\s]+):(\d+)##([^#\s]+)##(.+)$/);
  if (hostDoubleHashAuthMatch) {
    const [, host, port, username, password] = hostDoubleHashAuthMatch;
    return {
      endpointUrl: `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`,
      protocol: "http",
      host,
      port: Number(port),
      username,
      password,
    };
  }

  return undefined;
}

function tryParseProxyUrl(rawUrl: string): {
  endpointUrl: string;
  protocol: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
} | undefined {
  try {
    const url = new URL(rawUrl);
    const protocol = url.protocol.replace(/:$/, "").toLowerCase();
    if (!url.hostname || !url.port) {
      return undefined;
    }

    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    return {
      endpointUrl: rawUrl,
      protocol,
      host: url.hostname,
      port: Number(url.port),
      username,
      password,
    };
  } catch {
    return undefined;
  }
}

function parseCredentialLines(
  raw: string,
  parser: (line: string, index: number) => CredentialItemDefinition | undefined,
): CredentialItemDefinition[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parser(line, index))
    .filter((item): item is CredentialItemDefinition => item !== undefined);
}

export function createValueCredentialSetFromLines(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const items = parseCredentialLines(raw, parseValueLine);
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: options.id,
    displayName: options.displayName,
    useCases: options.useCases,
    strategy: options.strategy ?? "round-robin",
    priority: options.priority ?? 0,
    items,
    metadata: {},
  };
}

export function createBasicAuthCredentialSetFromLines(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const items = parseCredentialLines(raw, parseBasicAuthLine);
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: options.id,
    displayName: options.displayName,
    useCases: options.useCases,
    strategy: options.strategy ?? "round-robin",
    priority: options.priority ?? 0,
    items,
    metadata: {},
  };
}

export function createBasicAuthCredentialSetFromFile(
  path: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  if (!path?.trim()) {
    return undefined;
  }

  try {
    const text = readFileSync(path, { encoding: "utf-8" });
    const items = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith("#") === false)
      .map((line) => (line.includes("#") ? line.split("#", 1)[0]!.trim() : line))
      .filter(Boolean)
      .map((line, index) => parseBasicAuthLine(line, index))
      .filter((item): item is CredentialItemDefinition => item !== undefined);

    if (items.length === 0) {
      return undefined;
    }

    return {
      id: options.id,
      displayName: options.displayName,
      useCases: options.useCases,
      strategy: options.strategy ?? "round-robin",
      priority: options.priority ?? 0,
      items,
      metadata: {},
    };
  } catch {
    return undefined;
  }
}

export function createProxyUrlCredentialSetFromLines(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  const items = parseCredentialLines(raw, parseProxyUrlLine);
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: options.id,
    displayName: options.displayName,
    useCases: options.useCases,
    strategy: options.strategy ?? "round-robin",
    priority: options.priority ?? 0,
    items,
    metadata: {},
  };
}

export function loadValueCredentialItemsFromFile(path: string | undefined): CredentialItemDefinition[] {
  if (!path?.trim()) {
    return [];
  }

  try {
    const text = readFileSync(path, { encoding: "utf-8" });
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.startsWith("#") === false)
      .filter((line) => line.toUpperCase().includes("[EXHAUSTED]") === false)
      .map((line) => (line.includes("#") ? line.split("#", 1)[0]!.trim() : line))
      .filter(Boolean)
      .map((line, index) => parseValueLine(line, index))
      .filter((item): item is CredentialItemDefinition => item !== undefined);
  } catch {
    return [];
  }
}

export function createValueCredentialSetFromFile(
  path: string | undefined,
  options: {
    id: string;
    displayName: string;
    useCases: CredentialUseCase[];
    strategy?: CredentialSelectionStrategy;
    priority?: number;
  },
): CredentialSetDefinition | undefined {
  const items = loadValueCredentialItemsFromFile(path);
  if (items.length === 0) {
    return undefined;
  }

  return {
    id: options.id,
    displayName: options.displayName,
    useCases: options.useCases,
    strategy: options.strategy ?? "round-robin",
    priority: options.priority ?? 0,
    items,
    metadata: {},
  };
}
