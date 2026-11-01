import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function readDesktopFile(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("desktop shell exposes Loom-style native chrome and a page heading row", () => {
  const chromeUrl = new URL("../src/components/app/DesktopChrome.tsx", import.meta.url);
  assert.equal(existsSync(chromeUrl), true, "DesktopChrome.tsx must own native window chrome");

  const appView = readDesktopFile("src/components/AppView.tsx");
  const chrome = readFileSync(chromeUrl, "utf8");
  assert.match(appView, /<DesktopChrome \/>/);
  assert.match(appView, /<WorkspacePageHeader controller=\{controller\} \/>/);
  assert.match(chrome, /data-tauri-drag-region/);
  assert.match(chrome, /getCurrentWindow\(\)/);
  assert.match(chrome, /currentWindow\.minimize\(\)/);
  assert.match(chrome, /currentWindow\.toggleMaximize\(\)/);
  assert.match(chrome, /currentWindow\.close\(\)/);
  for (const label of ["最小化", "最大化或还原", "关闭"]) {
    assert.match(chrome, new RegExp(`aria-label=[{]?\"${label}`));
  }
  assert.match(chrome, /activeView === "mail"[\s\S]*selectedMailboxLabel/);
  assert.match(chrome, /className="nt-workspace-page-header"/);
  assert.doesNotMatch(chrome, /contextLabel|NMAIL \/|pageMeta|nt-workspace-page-header__meta/);
});

test("rail header and footer preserve the requested information hierarchy", () => {
  const rail = readDesktopFile("src/components/app/SideRail.tsx");
  const appState = readDesktopFile("src/app/useAppState.ts");
  const brandStart = rail.indexOf('className="nt-brand"');
  const brandEnd = rail.indexOf("</div>", brandStart);
  const brand = rail.slice(brandStart, brandEnd);
  assert.ok(brandStart >= 0, "rail brand must exist");
  assert.ok(brand.indexOf("nt-shell-rail-toggle") < brand.indexOf("EasyEmailAppIcon"));
  assert.ok(brand.indexOf("EasyEmailAppIcon") < brand.indexOf("NMail"));
  assert.match(brand, /railCollapsed \? "展开侧栏" : "收起侧栏"/);

  const footer = rail.slice(rail.indexOf('className="nt-rail-footer"'));
  assert.ok(footer.indexOf("设置") < footer.indexOf("账号"));
  assert.match(footer, /nt-rail-account-action/);
  assert.doesNotMatch(footer, /<small>/);
  assert.doesNotMatch(footer, /nt-platform-account-collapse-toggle/);
  assert.match(appState, /\[railCollapsed, setRailCollapsed\] = useState\(false\)/);
});

test("desktop chrome is backed by scoped Tauri permissions and canonical hover states", () => {
  const app = readDesktopFile("src/App.tsx");
  const styleUrl = new URL("../src/styles/loom-desktop-shell.css", import.meta.url);
  assert.equal(existsSync(styleUrl), true, "Loom shell overrides must stay in a focused stylesheet");
  const styles = readFileSync(styleUrl, "utf8");
  assert.match(app, /import "\.\/styles\/loom-desktop-shell\.css";/);
  assert.match(styles, /--nt-shell-rail-width:\s*186px/);
  assert.match(styles, /--nt-shell-titlebar-height:\s*50px/);
  assert.match(styles, /--nt-shell-page-header-height:\s*86px/);
  assert.match(styles, /\.nt-app-shell--edge-rail \.nt-workspace-board\s*\{[^}]*padding:\s*0;/s);
  assert.match(styles, /\.nt-workspace-page-header\s*\{[^}]*padding:\s*17px 28px 15px/s);
  assert.match(styles, /\.nt-workspace-board\.nt-workspace-board--settings > \.nt-settings-page\s*\{[^}]*grid-row:\s*1;/s);
  assert.match(styles, /\.nt-app-shell--edge-rail \.nt-workspace-board--settings\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/s);
  assert.match(styles, /\.nt-app-shell--rail-collapsed\s*\{[^}]*--nt-shell-rail-width:\s*52px/s);
  assert.match(styles, /\.nt-app-shell--edge-rail \.nt-brand\s*\{[^}]*display:\s*flex;/s);
  assert.match(styles, /\.nt-window-control:hover\s*\{[^}]*background:\s*var\(--nt-surface-control-hover\)/s);
  assert.match(styles, /\.nt-window-control--close:hover\s*\{[^}]*background:\s*var\(--nt-action-destructive\)/s);
  assert.match(styles, /\.nt-shell-rail-toggle:focus-visible[\s\S]*outline:\s*2px solid var\(--nt-border-focus\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);

  const config = JSON.parse(readDesktopFile("src-tauri/tauri.conf.json"));
  assert.equal(config.app.windows[0].width, 1120);
  assert.equal(config.app.windows[0].height, 760);
  assert.equal("minWidth" in config.app.windows[0], false);
  assert.equal("minHeight" in config.app.windows[0], false);
  assert.equal(config.app.windows[0].decorations, false);
  assert.equal(config.app.windows[0].center, true);
  const capability = JSON.parse(readDesktopFile("src-tauri/capabilities/default.json"));
  for (const permission of [
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-start-dragging",
    "core:window:allow-toggle-maximize",
  ]) {
    assert.ok(capability.permissions.includes(permission), `missing ${permission}`);
  }
});

test("workspace pages keep one title owner and remove redundant secondary headings", () => {
  const appView = readDesktopFile("src/components/AppView.tsx");
  const chrome = readDesktopFile("src/components/app/DesktopChrome.tsx");
  const toolbar = readDesktopFile("src/components/app/MailListToolbar.tsx");
  const sourceActions = readDesktopFile("src/components/app/MailTopbarActions.tsx");
  const agent = readDesktopFile("src/components/app/AgentWorkspace.tsx");
  const queue = readDesktopFile("src/components/app/QueueWorkspace.tsx");

  assert.doesNotMatch(toolbar, /nt-mail-list-toolbar__mailbox-title|selectedMailboxLabel|onlyCodes/);
  assert.match(toolbar, /nt-mail-list-toolbar__mailbox-count/);
  assert.match(toolbar, /if \(!toolbarHasContent\) return null/);
  assert.doesNotMatch(sourceActions, /nt-mail-source-selector__kicker|当前邮箱账号<\/span>/);
  assert.doesNotMatch(appView, /Provider and mailbox ignition|Configure EasyEmail/);
  assert.match(appView, /nt-settings-page__heading[\s\S]*<h1>设置<\/h1>/);
  assert.doesNotMatch(agent, /Task thread control|Agent accounts are scope=agent/);
  assert.doesNotMatch(queue, /SMTP dispatch board|Outgoing mail is queued/);
  assert.doesNotMatch(queue, /M5\/M6|setStatusMessage/);
  assert.doesNotMatch(agent, /nt-board-head|nt-board-actions/);
  assert.doesNotMatch(queue, /nt-board-head|nt-board-actions/);
  assert.match(chrome, /loadAgentThreads[\s\S]*setAgentWorkspace\("compose"\)/);
  assert.match(chrome, /loadSendQueue[\s\S]*runSendQueueWorkerOnce/);
});

test("mail workspace keeps list and reading columns visible in the empty state", () => {
  const workspace = readDesktopFile("src/components/app/MailWorkspace.tsx");
  const styles = readDesktopFile("src/styles/loom-desktop-shell.css");
  const listIndex = workspace.indexOf("<MailListPane controller={controller} />");
  const readerIndex = workspace.indexOf("<MailReadingPane controller={controller} />");
  assert.ok(listIndex >= 0 && readerIndex > listIndex);
  assert.doesNotMatch(workspace, /visibleMailMessages\.length > 0 \? \(/);
  assert.doesNotMatch(workspace, /nt-mail-adaptive--empty/);
  assert.match(styles, /\.nt-mail-adaptive > \.nt-list-pane\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*2;/s);
  assert.match(styles, /\.nt-mail-adaptive > \.nt-reading-pane\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*2;/s);
});
