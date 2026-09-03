import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";


const normalizeLines = (value) => value.replace(/\r\n/g, "\n");
const readText = (path) => normalizeLines(readFileSync(path, "utf8"));

const filesUnder = (directory, extension) => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return filesUnder(path, extension);
      return entry.isFile() && path.endsWith(extension) ? [path] : [];
    });
};

const readSourceWithModules = (entryPath) => {
  const extension = extname(entryPath);
  const moduleDirectory = entryPath.slice(0, -extension.length);
  const moduleSources = filesUnder(moduleDirectory, extension).map(readText);
  return [readText(entryPath), ...moduleSources].join("\n");
};

const CSS_IMPORT = /^@import\s+["']([^"']+)["'];\s*$/gm;

const readCssBundle = (entryPath, ancestors = new Set()) => {
  const absolutePath = resolve(entryPath);
  if (ancestors.has(absolutePath)) {
    throw new Error(`Circular CSS import in UI verification: ${absolutePath}`);
  }
  const source = readText(absolutePath);
  const imports = [...source.matchAll(CSS_IMPORT)];
  if (!imports.length) return source;
  if (source.replace(CSS_IMPORT, "").trim()) {
    throw new Error(`CSS facade mixes imports and declarations: ${absolutePath}`);
  }
  const nextAncestors = new Set(ancestors).add(absolutePath);
  return imports
    .map((match) => readCssBundle(resolve(dirname(absolutePath), match[1]), nextAncestors))
    .join("");
};

const appComponentSources = [
  ...filesUnder("src/app", ".tsx"),
  ...filesUnder("src/components", ".tsx"),
].map(readText);

export const senderAvatarIcon = readText("src/components/SenderAvatarIcon.tsx");
export const app = [readText("src/App.tsx"), ...appComponentSources].join("\n");
export const cssRaw = readCssBundle("src/App.css");
export const canonicalCssRaw = readCssBundle("src/styles/neuro-canonical.css");

const collapseWhitespace = (value) => value.replace(/\s+/g, " ");

export const whitespaceTolerantCss = (raw) => {
  const collapsed = collapseWhitespace(raw);
  return {
    includes: (needle) => collapsed.includes(collapseWhitespace(needle)),
    indexOf: (needle, from) => raw.indexOf(needle, from),
    slice: (start, end) => raw.slice(start, end),
  };
};

export const css = whitespaceTolerantCss(cssRaw);
export const canonicalCss = whitespaceTolerantCss(canonicalCssRaw);
export const invokeCommand = readText("src/api/invokeCommand.ts");
export const avatarSettingsClient = readText("src/api/avatarSettingsClient.ts");
export const contactAvatarImage = readText("src/avatar/contactAvatarImage.ts");
export const contactClient = readText("src/api/contactClient.ts");
export const desktopCredentialClient = readText("src/api/desktopCredentialClient.ts");
export const mailAccountClient = readText("src/api/mailAccountClient.ts");
export const mailTaxonomyClient = readText("src/api/mailTaxonomyClient.ts");
export const newsletterClient = readText("src/api/newsletterClient.ts");
export const platformAccountClient = readText("src/api/platformAccountClient.ts");
export const bundledCoreClient = readText("src/api/bundledCoreClient.ts");
export const desktopCoreClient = readText("src/api/desktopCoreClient.ts");
export const easyEmailHttpClient = readText("src/api/easyEmailHttpClient.ts");
export const settingsClient = readText("src/api/settingsClient.ts");
export const sendQueueClient = readText("src/api/sendQueueClient.ts");
export const composeData = readText("src/compose/composeData.ts");
export const composeDateUtils = readText("src/compose/composeDateUtils.ts");
export const composeImage = readText("src/compose/composeImage.ts");
export const composeHtmlSanitizer = readText("src/compose/composeHtmlSanitizer.ts");
export const composeLink = readText("src/compose/composeLink.ts");
export const layerAccessibility = readText("src/hooks/useLayerAccessibility.ts");
export const mailDateUtils = readText("src/mail/mailDateUtils.ts");
export const messageLinkRenderer = readText("src/mail/messageLinkRenderer.ts");
export const senderAvatar = readText("src/mail/senderAvatar.ts");
export const mailSelectors = readText("src/mail/mailSelectors.ts");
export const mailSearch = readText("src/mail/mailSearch.ts");
export const mailTaxonomy = readText("src/mail/mailTaxonomy.ts");
export const imapModels = readText("src-tauri/src/imap/models.rs");
export const imapNative = readText("src-tauri/src/imap/native.rs");
export const smtpNative = readText("src-tauri/src/smtp/native.rs");
export const normalAccountService = readSourceWithModules("src-tauri/src/services/normal_account_service.rs");
export const verificationDomain = readText("src-tauri/src/domain/verification.rs");
export const platformAccountService = readText("src-tauri/src/services/platform_account_service.rs");
export const commands = readSourceWithModules("src-tauri/src/commands.rs");
export const sendService = readText("src-tauri/src/services/send_service.rs");
export const sendQueueRepository = readSourceWithModules("src-tauri/src/storage/send_queue_repository.rs");
export const messageRepository = readSourceWithModules("src-tauri/src/storage/message_repository.rs");
export const contactRepository = readText("src-tauri/src/storage/contact_repository.rs");
export const migrations = readText("src-tauri/src/storage/migrations.rs");
export const smtpModels = readText("src-tauri/src/smtp/models.rs");
export const tauriLib = readText("src-tauri/src/lib.rs");
export const tauriCapability = readText("src-tauri/capabilities/default.json");
export const avatarBackend = readSourceWithModules("src-tauri/src/avatar.rs");
export const tauriConfig = readText("src-tauri/tauri.conf.json");
export const readme = readText("README.md");
export const designRules = readText("docs/design/easyemailam-design-rules.md");
export const platformAccountApi = readText("docs/design/nmail-platform-account-api.md");
export const indexHtml = readText("index.html");
export const packageJson = readText("package.json");
export const appIconSvg = readText("public/easyemailam-mail-icon.svg");
