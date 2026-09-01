import { displayNameFromAddress, extractEmailAddress } from "./mailSelectors.ts";

export type SenderAvatarDto = {
  sender: string;
  cache_key: string;
  domain: string;
  display_name: string;
  source_kind: string;
  image_data_url: string | null;
  builtin_kind: string | null;
  fallback_text: string;
  remote_url: string | null;
  fetched_at: string | null;
  expires_at: string | null;
};

export type SenderAvatarKind =
  | "qq-mail"
  | "openai"
  | "railway-12306"
  | "github"
  | "google"
  | "generic";

type SenderAvatarContext = {
  email: string;
  domain: string;
  displayName: string;
};

export type SenderAvatarMeta = {
  kind: SenderAvatarKind;
  label: string;
  title: string;
  fallback: string;
};

type SenderAvatarRule = {
  kind: Exclude<SenderAvatarKind, "generic">;
  label: string;
  fallback: string;
  matches: (context: SenderAvatarContext) => boolean;
};

export const senderAvatarRules: SenderAvatarRule[] = [
  {
    kind: "qq-mail",
    label: "QQ Mail",
    fallback: "QQ",
    matches: ({ email, domain, displayName }) =>
      domain === "qq.com" || email === "10000@qq.com" || displayName.includes("qq邮箱"),
  },
  {
    kind: "openai",
    label: "OpenAI / ChatGPT",
    fallback: "AI",
    matches: ({ domain, displayName }) =>
      domain === "openai.com" ||
      domain.endsWith(".openai.com") ||
      displayName.includes("openai") ||
      displayName.includes("chatgpt"),
  },
  {
    kind: "railway-12306",
    label: "12306",
    fallback: "12306",
    matches: ({ email, domain, displayName }) =>
      email.startsWith("12306@") || domain === "rails.com.cn" || displayName.includes("12306"),
  },
  {
    kind: "github",
    label: "GitHub",
    fallback: "GH",
    matches: ({ domain, displayName }) =>
      domain.includes("github") || displayName.includes("github"),
  },
  {
    kind: "google",
    label: "Google Mail",
    fallback: "G",
    matches: ({ domain, displayName }) =>
      domain.includes("google") ||
      domain.includes("gmail") ||
      displayName.includes("google"),
  },
];

export function isSenderAvatarKind(
  value: string | null | undefined,
): value is SenderAvatarKind {
  return senderAvatarRules.some((rule) => rule.kind === value) || value === "generic";
}

export function resolveSenderAvatar(value: string): SenderAvatarMeta {
  const email = extractEmailAddress(value).toLowerCase();
  const domain = email.includes("@") ? email.split("@").pop() ?? "" : "";
  const displayName = displayNameFromAddress(value).toLowerCase();
  const provider = domain.split(".").filter(Boolean)[0] ?? "";
  const rule = senderAvatarRules.find((item) => item.matches({ email, domain, displayName }));

  if (rule) {
    return {
      kind: rule.kind,
      label: rule.label,
      title: email || rule.label,
      fallback: rule.fallback,
    };
  }

  return {
    kind: "generic",
    label: provider ? `${provider.toUpperCase()} mail` : "Mail",
    title: email || "Mail",
    fallback: provider.slice(0, 2).toUpperCase() || "MAIL",
  };
}

export function resolveSenderAvatarPresentation(
  value: string,
  remoteAvatar?: SenderAvatarDto | null,
): SenderAvatarMeta {
  const fallbackAvatar = resolveSenderAvatar(value);
  return {
    ...fallbackAvatar,
    kind: isSenderAvatarKind(remoteAvatar?.builtin_kind)
      ? remoteAvatar.builtin_kind
      : fallbackAvatar.kind,
    fallback: remoteAvatar?.fallback_text ?? fallbackAvatar.fallback,
    title: remoteAvatar?.remote_url ?? fallbackAvatar.title,
  };
}

export function senderAvatarMapKey(value: string): string {
  return extractEmailAddress(value).toLowerCase();
}
