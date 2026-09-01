import { extractEmailAddress } from "../mail/mailSelectors.ts";

export type ComposeRecipientField = "to" | "cc" | "bcc";

export type ComposeFontOption = {
  label: string;
  css: string;
};

export type ComposeEmojiCategoryId =
  | "recent"
  | "smileys"
  | "animals"
  | "food"
  | "activity"
  | "travel"
  | "objects"
  | "symbols"
  | "flags";

export type ComposeEmojiEntry = {
  symbol: string;
  keywords: string[];
};

export type ComposeEmojiCategory = {
  id: ComposeEmojiCategoryId;
  label: string;
  icon: string;
  emojis: ComposeEmojiEntry[];
};

export type ComposeEmojiResultCategory = Omit<ComposeEmojiCategory, "id"> & {
  id: ComposeEmojiCategoryId | "search";
};

export const COMPOSE_FONT_OPTIONS: ComposeFontOption[] = [
  { label: "Sans Serif", css: "Inter, Arial, sans-serif" },
  { label: "Serif", css: "Georgia, 'Times New Roman', serif" },
  { label: "Georgia", css: "Georgia, serif" },
  { label: "Arial", css: "Arial, sans-serif" },
  { label: "Helvetica", css: "Helvetica, Arial, sans-serif" },
  { label: "Monospace", css: "Consolas, 'Courier New', monospace" },
  { label: "Tahoma", css: "Tahoma, sans-serif" },
  { label: "Verdana", css: "Verdana, sans-serif" },
  { label: "Times New Roman", css: "'Times New Roman', Times, serif" },
  { label: "Trebuchet MS", css: "'Trebuchet MS', sans-serif" },
];

export const COMPOSE_FONT_SIZE_OPTIONS = [
  "10px",
  "12px",
  "14px",
  "16px",
  "18px",
  "20px",
  "22px",
  "24px",
  "26px",
];

export const COMPOSE_COLOR_SWATCHES = [
  "#FFFFFF",
  "#DADADA",
  "#B5B5B5",
  "#909090",
  "#6B6B6B",
  "#464646",
  "#000000",
  "#F6CBCB",
  "#EC9798",
  "#E36667",
  "#ED4139",
  "#CF3932",
  "#9A2B25",
  "#681D19",
  "#CDE1F2",
  "#9CC3E5",
  "#6CA6D9",
  "#3B83C2",
  "#2A47F6",
  "#145390",
  "#0F3A62",
  "#D7EAD3",
  "#B3D6A9",
  "#8FC380",
  "#77F241",
  "#66A657",
  "#3A762B",
  "#29501F",
  "#FFF2CD",
  "#FEE59C",
  "#FCD86F",
  "#FDF84E",
  "#F2C246",
  "#BE8F35",
  "#7F6124",
];

// Persisted rich-text defaults are named here so the editor surface does not
// scatter content colors through the workflow component.
export const COMPOSE_DEFAULT_TEXT_COLOR = "#111821";
export const COMPOSE_DEFAULT_BACKGROUND_COLOR = "#fbfcf7";

const COMPOSE_EMOJI_KEYWORDS: Record<string, string[]> = {
  "😀": ["grinning", "happy", "smile", "face"],
  "😃": ["smiley", "happy", "smile", "face"],
  "😄": ["smile", "happy", "laugh", "face"],
  "😁": ["grin", "happy", "smile", "face"],
  "😆": ["laughing", "satisfied", "happy", "laugh", "face"],
  "😅": ["sweat_smile", "relief", "happy", "sweat", "face"],
  "🤣": ["rofl", "rolling", "happy", "laugh", "face"],
  "😂": ["joy", "tears", "happy", "laugh", "face"],
  "🙂": ["slightly_smiling", "happy", "smile", "face"],
  "😊": ["happy", "smile", "blush", "face"],
  "😇": ["happy", "angel", "smile", "face"],
  "🥰": ["happy", "love", "smile", "face"],
  "😍": ["happy", "love", "heart", "face"],
  "🤩": ["happy", "star", "smile", "face"],
  "🥳": ["party", "celebrate", "happy", "face"],
  "😘": ["kissing_heart", "kiss", "love", "happy", "face"],
  "😋": ["yum", "tasty", "happy", "smile", "face"],
  "😛": ["stuck_out_tongue", "playful", "happy", "tongue", "face"],
  "😜": ["wink", "playful", "happy", "tongue", "face"],
  "🤪": ["zany", "silly", "happy", "face"],
  "😺": ["happy", "cat", "smile"],
  "😸": ["happy", "cat", "smile"],
  "😹": ["happy", "cat", "laugh"],
  "😔": ["pensive", "sad", "down", "face"],
  "😞": ["disappointed", "sad", "face"],
  "😟": ["worried", "sad", "anxious", "face"],
  "🙁": ["slightly_frowning", "sad", "frown", "face"],
  "☹️": ["frowning", "sad", "frown", "face"],
  "😣": ["persevere", "sad", "struggle", "face"],
  "😖": ["confounded", "sad", "face"],
  "😫": ["tired", "sad", "face"],
  "😩": ["weary", "sad", "face"],
  "🥺": ["pleading", "sad", "please", "face"],
  "😢": ["cry", "sad", "tear", "face"],
  "😭": ["sob", "cry", "sad", "tears", "face"],
  "🥲": ["smiling_tear", "sad", "happy", "tear", "face"],
  "😿": ["cry", "sad", "cat", "tear"],
  "👍": ["thumbs up", "like", "approve", "good"],
  "🙏": ["pray", "thanks", "please"],
  "👌": ["ok", "approve", "good"],
  "👏": ["clap", "applause"],
  "🔥": ["fire", "hot"],
  "🌈": ["rainbow", "color", "happy"],
  "🐱": ["cat", "animal"],
  "🐶": ["dog", "animal"],
  "🍎": ["apple", "food"],
  "⚽": ["soccer", "football", "activity"],
  "🚗": ["car", "travel"],
  "💡": ["light", "idea", "object"],
  "❤️": ["heart", "love", "symbol"],
  "✅": ["check", "done", "success", "symbol"],
  "❌": ["cross", "cancel", "x", "symbol"],
  "⚠️": ["warning", "alert", "symbol"],
  "🇨🇳": ["china", "flag"],
};

function composeEmojiEntries(
  emojis: string[],
  categoryKeywords: string[] = [],
): ComposeEmojiEntry[] {
  return emojis.map((emoji) => ({
    symbol: emoji,
    keywords: [...categoryKeywords, ...(COMPOSE_EMOJI_KEYWORDS[emoji] ?? [])],
  }));
}

export const COMPOSE_EMOJI_CATEGORIES: ComposeEmojiCategory[] = [
  {
    id: "recent",
    label: "最近使用",
    icon: "◴",
    emojis: composeEmojiEntries(
      ["👍", "😀", "😂", "😊", "😍", "🥰", "🥳", "😢", "😭", "🙏", "👌", "👏", "🔥", "✅", "❤️", "✨"],
      ["recent"],
    ),
  },
  {
    id: "smileys",
    label: "表情与角色",
    icon: "☺",
    emojis: composeEmojiEntries(
      [
        "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😙", "😚", "😋", "😛", "😜", "🤪", "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "😳", "😌", "😏", "😒", "🙄", "😬", "😔", "😞", "😟", "🙁", "☹️", "😣", "😖", "😫", "😩", "🥺", "😢", "😭", "🥲", "😮‍💨", "🤥", "😴", "😷", "🤒", "🤕", "🤢", "🥳", "😺", "😸", "😹", "😿", "🙈", "🙉", "🙊",
      ],
      ["smileys", "people", "face"],
    ),
  },
  {
    id: "animals",
    label: "动物与自然",
    icon: "🐶",
    emojis: composeEmojiEntries(
      ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦆", "🦉", "🦄", "🐝", "🦋", "🐞", "🐢", "🐬", "🐳", "🌸", "🌹", "🌻", "🌲", "🌵", "🌙", "☀️", "⭐", "🌈"],
      ["animal", "nature"],
    ),
  },
  {
    id: "food",
    label: "食物与饮品",
    icon: "🍎",
    emojis: composeEmojiEntries(
      ["🍎", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🫐", "🍒", "🍑", "🥭", "🍍", "🥑", "🥕", "🌽", "🍞", "🥐", "🧀", "🍔", "🍟", "🍕", "🌮", "🌯", "🍜", "🍣", "🍱", "🍩", "🍪", "🎂", "🍫", "☕", "🍵", "🥤", "🍺"],
      ["food", "drink"],
    ),
  },
  {
    id: "activity",
    label: "活动",
    icon: "⚽",
    emojis: composeEmojiEntries(
      ["⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🎱", "🏓", "🏸", "🥅", "⛳", "🥊", "🚴", "🏆", "🎮", "🎲", "🎯", "🎧", "🎤", "🎸", "🎹", "🎬", "🎨", "🎭", "🎪", "🎟️"],
      ["activity", "sport", "game"],
    ),
  },
  {
    id: "travel",
    label: "旅行与地点",
    icon: "🚗",
    emojis: composeEmojiEntries(
      ["🚗", "🚕", "🚌", "🚎", "🏎️", "🚓", "🚑", "🚒", "🚚", "🚆", "🚇", "✈️", "🚀", "🚁", "🚲", "⛵", "🏠", "🏢", "🏦", "🏫", "🏥", "🏨", "🌋", "🏖️", "🏝️", "🏔️", "🌉", "🗽", "🌐", "🗺️"],
      ["travel", "place", "car"],
    ),
  },
  {
    id: "objects",
    label: "物品",
    icon: "💡",
    emojis: composeEmojiEntries(
      ["💡", "🔦", "🕯️", "💻", "⌨️", "🖱️", "📱", "📷", "🎥", "📺", "🎙️", "⏰", "⌚", "🔋", "🔌", "💾", "💿", "📎", "✏️", "📝", "📌", "📍", "✂️", "🔒", "🔓", "🔑", "🔨", "🧰", "🧲", "🧪"],
      ["object", "tool"],
    ),
  },
  {
    id: "symbols",
    label: "符号",
    icon: "₹&%",
    emojis: composeEmojiEntries(
      ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "🖤", "💔", "❣️", "💕", "💞", "✅", "☑️", "✔️", "❌", "✖️", "❓", "❗", "⚠️", "⭐", "✨", "⚡", "🔥", "💯", "🔔", "📣", "➕", "➖", "➡️", "⬅️", "⬆️", "⬇️", "🔁", "🔒"],
      ["symbol", "heart"],
    ),
  },
  {
    id: "flags",
    label: "旗帜",
    icon: "⚑",
    emojis: composeEmojiEntries(
      ["🇨🇳", "🇺🇸", "🇪🇺", "🇯🇵", "🇰🇷", "🇬🇧", "🇩🇪", "🇫🇷", "🇨🇦", "🇦🇺", "🇧🇷", "🇮🇳", "🇮🇹", "🇪🇸", "🇲🇽", "🏳️", "🏴", "🏁", "🚩"],
      ["flag"],
    ),
  },
];

export function parseComposeAddressList(value: string): string[] {
  return value
    .split(/[;,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function joinComposeAddressList(addresses: readonly string[]): string {
  return addresses.join(", ");
}

export function appendComposeRecipientValue(current: string, address: string): string {
  const normalizedAddress = extractEmailAddress(address).toLowerCase();
  if (normalizedAddress.length === 0) {
    return current.trim();
  }
  const existingAddresses = parseComposeAddressList(current).map((item) =>
    extractEmailAddress(item).toLowerCase(),
  );
  if (existingAddresses.includes(normalizedAddress)) {
    return current.trim();
  }
  const trimmed = current.trim();
  return trimmed.length > 0 ? `${trimmed}, ${normalizedAddress}` : normalizedAddress;
}

export function composeContactPickerAriaLabel(field: ComposeRecipientField): string {
  if (field === "to") {
    return "选择收件人联系人";
  }
  if (field === "cc") {
    return "选择抄送联系人";
  }
  return "选择密送联系人";
}

export function composeFontCss(label: string): string {
  return COMPOSE_FONT_OPTIONS.find((option) => option.label === label)?.css ?? "Arial, sans-serif";
}

function composeEmojiMatchesSearch(
  emoji: ComposeEmojiEntry,
  category: ComposeEmojiCategory,
  search: string,
): boolean {
  return (
    emoji.symbol.includes(search) ||
    category.id.includes(search) ||
    category.label.toLowerCase().includes(search) ||
    emoji.keywords.some((keyword) => keyword.toLowerCase().includes(search))
  );
}

export function filterComposeEmojiCategories(
  search: string,
  activeCategoryId: ComposeEmojiCategoryId,
): ComposeEmojiResultCategory[] {
  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) {
    return COMPOSE_EMOJI_CATEGORIES.filter((category) => category.id === activeCategoryId);
  }

  const seen = new Set<string>();
  const emojis = COMPOSE_EMOJI_CATEGORIES.flatMap((category) =>
    category.emojis.filter((emoji) => {
      if (
        seen.has(emoji.symbol) ||
        !composeEmojiMatchesSearch(emoji, category, normalizedSearch)
      ) {
        return false;
      }
      seen.add(emoji.symbol);
      return true;
    }),
  );

  return emojis.length > 0
    ? [
        {
          id: "search",
          label: "搜索结果",
          icon: "⌕",
          emojis,
        },
      ]
    : [];
}
