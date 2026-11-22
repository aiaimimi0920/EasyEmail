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
  ...filesUnder("src/app", ".ts"),
  ...filesUnder("src/app", ".tsx"),
  ...filesUnder("src/components", ".ts"),
  ...filesUnder("src/components", ".tsx"),
].map(readText);

const normalizeAggregatedAppImports = (source) => source.replaceAll('from "../', 'from "./');

export const senderAvatarIcon = readText("src/components/SenderAvatarIcon.tsx");
export const appView = [
  readText("src/components/AppView.tsx"),
  readText("src/components/app/AppOverlays.tsx"),
  readText("src/components/app/ComposeOverlays.tsx"),
  readText("src/components/app/MailWorkspace.tsx"),
].join("\n");
export const composeActionFooterSource = readText("src/components/app/ComposeActionFooter.tsx");
export const mailListPaneSource = readText("src/components/app/MailListPane.tsx");
export const mailListToolbarSource = readText("src/components/app/MailListToolbar.tsx");
export const mailReadingPaneSource = readText("src/components/app/MailReadingPane.tsx");
export const mailTaxonomySectionSource = readText(
  "src/components/app/MailTaxonomySection.tsx",
);
export const sideRailSource = readText("src/components/app/SideRail.tsx");
export const app = [readText("src/App.tsx"), ...appComponentSources]
  .map(normalizeAggregatedAppImports)
  .join("\n");
export const cssRaw = [
  readCssBundle("src/App.css"),
  readCssBundle("src/styles/loom-desktop-shell.css"),
].join("\n");
export const canonicalCssRaw = [
  "src/styles/neuro-canonical.css",
  "src/styles/neuro-canonical-mail.css",
  "src/styles/neuro-canonical-focus.css",
]
  .map((path) => readCssBundle(path))
  .join("\n");

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
export const agentMailClient = readText("src/api/agentMailClient.ts");
export const avatarSettingsClient = readText("src/api/avatarSettingsClient.ts");
export const contactAvatarImage = readText("src/avatar/contactAvatarImage.ts");
export const contactClient = readText("src/api/contactClient.ts");
export const desktopCredentialClient = readText("src/api/desktopCredentialClient.ts");
export const mailAccountClient = readText("src/api/mailAccountClient.ts");
export const mailMessageClient = readText("src/api/mailMessageClient.ts");
export const mailTaxonomyClient = readText("src/api/mailTaxonomyClient.ts");
export const newsletterClient = readText("src/api/newsletterClient.ts");
export const platformAccountClient = readText("src/api/platformAccountClient.ts");
export const bundledCoreClient = readText("src/api/bundledCoreClient.ts");
export const desktopCoreClient = readText("src/api/desktopCoreClient.ts");
export const easyEmailHttpClient = readText("src/api/easyEmailHttpClient.ts");
export const easyEmailHttpRoutes = readText("src/api/easyEmailRoutes.ts");
export const easyEmailHttpTransport = readText("src/api/easyEmailHttpTransport.ts");
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
export const mailProjectionSource = readText("src/app/mailProjection.ts");
export const commands = readText("src-tauri/src/commands.rs");
export const tauriAppState = readText("src-tauri/src/app_state.rs");
export const tauriCargoToml = readText("src-tauri/Cargo.toml");
export const tauriLib = readText("src-tauri/src/lib.rs");
export const tauriCapability = readText("src-tauri/capabilities/default.json");
export const tauriConfig = readText("src-tauri/tauri.conf.json");
export const avatarBackend = readText("../../service/base/src/service/avatar-identity-and-remote.ts");
export const serviceAccounts = readText("../../service/base/src/service/accounts.ts");
export const serviceExtensions = readText("../../service/base/src/service/mail-extensions.ts");
export const serviceImapSync = [
  readText("../../service/base/src/service/mail-imap-sync.ts"),
  readText("../../service/base/src/service/imap-mime-parser.ts"),
  readText("../../service/base/src/service/imap-transport.ts"),
].join("\n");
export const serviceMessages = [
  readText("../../service/base/src/service/mail-messages.ts"),
  readText("../../service/base/src/persistence/relational/mail-message-repository.ts"),
  readText("../../service/base/src/persistence/relational/mail-draft-persistence.ts"),
].join("\n");
export const serviceMigrations = [
  readText("../../service/base/src/persistence/relational/migrations.ts"),
  readText("../../service/base/src/persistence/relational/migrations-m7a.ts"),
].join("\n");
export const serviceSmtp = [
  readText("../../service/base/src/service/mail-send-queue.ts"),
  readText("../../service/base/src/service/smtp-transport.ts"),
  readText("../../service/base/src/service/smtp-mime-encoder.ts"),
].join("\n");
export const readme = readText("README.md");
export const designRules = readText("docs/design/easyemailam-design-rules.md");
export const platformAccountApi = readText("docs/design/nmail-platform-account-api.md");
export const indexHtml = readText("index.html");
export const packageJson = readText("package.json");
export const appIconSvg = readText("public/easyemailam-mail-icon.svg");
